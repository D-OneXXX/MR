//! ECDSA P-256 certificate generation, parsing and chain verification.
//!
//! Private keys returned from this module are wrapped in [`Zeroizing`] so they
//! are wiped when dropped. Nothing here logs or persists key material.

use std::net::{IpAddr, Ipv4Addr};

use ::time::{Duration, OffsetDateTime};
use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DnType, ExtendedKeyUsagePurpose,
    GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose, NameConstraints, SanType,
    PKCS_ECDSA_P256_SHA256,
};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use sha2::{Digest, Sha256};
use x509_parser::prelude::*;
use zeroize::Zeroizing;

use super::error::{CaError, CaResult};

const ROOT_CN: &str = "Moyu Local Root CA";
const INTERMEDIATE_CN: &str = "Moyu Local Issuing CA";
const LEAF_CN: &str = "moyu.local";
const ROOT_DAYS: i64 = 3650;
const INTERMEDIATE_DAYS: i64 = 180;
const LEAF_DAYS: i64 = 30;

pub(crate) struct GeneratedCa {
    pub key_pem: Zeroizing<String>,
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
}

/// Leaf material returned by [`generate_leaf`] and mapped into the public
/// `LeafMaterial` by the CA manager.
pub(crate) struct IssuedLeaf {
    /// Handed to the TLS listener task; never logged or persisted.
    pub key_pem: Zeroizing<String>,
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    pub chain_pem: String,
    pub fingerprint_sha256: String,
    pub not_before: i64,
    pub not_after: i64,
}

#[derive(Debug)]
pub(crate) struct CertInfo {
    pub subject: String,
    pub issuer: String,
    /// Exposed for diagnostics; certificates are not secret.
    #[allow(dead_code)] // Reserved for Task 7 backup audit metadata.
    pub serial: String,
    pub fingerprint_sha256: String,
    pub not_before: i64,
    pub not_after: i64,
    pub spki_raw: Vec<u8>,
    /// `basicConstraints.CA`. `false` also covers an absent extension.
    pub is_ca: bool,
    /// `basicConstraints.pathLenConstraint`.
    pub path_len: Option<u32>,
    /// `keyUsage.keyCertSign`.
    pub key_cert_sign: bool,
    /// `keyUsage.cRLSign`.
    pub crl_sign: bool,
    /// `basicConstraints` critical bit. `false` also covers an absent
    /// extension. CA certificates must mark this extension critical.
    pub basic_constraints_critical: bool,
    /// `keyUsage` critical bit. `false` also covers an absent extension.
    pub key_usage_critical: bool,
}

/// Role of a CA certificate in this hierarchy. webpki treats the supplied
/// trust anchor as trusted without validating its extensions, so the CA
/// extension policy is asserted here for generated and imported roots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CaRole {
    Root,
    Intermediate,
}

/// Enforce the CA extension policy:
/// - root: `CA:TRUE`, `pathLen=1`, `keyCertSign` + `cRLSign`, both extensions
///   critical
/// - intermediate: `CA:TRUE`, `pathLen=0`, `keyCertSign` + `cRLSign`, both
///   extensions critical
///
/// Absent `basicConstraints`/`keyUsage` extensions fail closed (`is_ca` and
/// the key-usage flags default to `false`). Imported roots are held to the same
/// policy as locally generated ones; RFC 5280 requires `basicConstraints` to be
/// critical in a CA certificate, and a non-critical `keyUsage` is rejected too
/// so the two-bool extension policy is identical on every path.
pub(crate) fn validate_ca_extensions(info: &CertInfo, role: CaRole) -> CaResult<()> {
    let expected_path_len = match role {
        CaRole::Root => Some(1),
        CaRole::Intermediate => Some(0),
    };
    if !info.is_ca
        || info.path_len != expected_path_len
        || !info.key_cert_sign
        || !info.crl_sign
        || !info.basic_constraints_critical
        || !info.key_usage_critical
    {
        return Err(CaError::CorruptState(match role {
            CaRole::Root => "root CA extensions invalid",
            CaRole::Intermediate => "intermediate CA extensions invalid",
        }));
    }
    Ok(())
}

fn new_key() -> CaResult<KeyPair> {
    KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(CaError::Crypto)
}

fn cert_params(cn: &str, now: OffsetDateTime, days: i64, ca: IsCa) -> CaResult<CertificateParams> {
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(CaError::Crypto)?;
    params.distinguished_name.push(DnType::CommonName, cn);
    params.is_ca = ca;
    // Backdate by one day to tolerate small clock skew between machines.
    params.not_before = now - Duration::days(1);
    params.not_after = now + Duration::days(days);
    Ok(params)
}

fn ip_subtree(addr: [u8; 4], prefix: u8) -> GeneralSubtree {
    GeneralSubtree::IpAddress(CidrSubnet::from_addr_prefix(
        IpAddr::V4(Ipv4Addr::from(addr)),
        prefix,
    ))
}

pub(crate) fn generate_root(now: OffsetDateTime) -> CaResult<GeneratedCa> {
    let key = new_key()?;
    let mut params = cert_params(
        ROOT_CN,
        now,
        ROOT_DAYS,
        IsCa::Ca(BasicConstraints::Constrained(1)),
    )?;
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    // No Name Constraints on the root: the constrained intermediate is the
    // only certificate allowed to issue leaves (pathlen: 1).
    let cert = params.self_signed(&key).map_err(CaError::Crypto)?;
    let der = cert.der().as_ref().to_vec();
    Ok(GeneratedCa {
        key_pem: Zeroizing::new(key.serialize_pem()),
        cert_pem: cert.pem(),
        cert_der: der,
    })
}

pub(crate) fn generate_intermediate(
    root_key_pem: &str,
    root_cert_pem: &str,
    now: OffsetDateTime,
) -> CaResult<GeneratedCa> {
    let root_key = KeyPair::from_pem(root_key_pem).map_err(CaError::Crypto)?;
    let key = new_key()?;
    let mut params = cert_params(
        INTERMEDIATE_CN,
        now,
        INTERMEDIATE_DAYS,
        IsCa::Ca(BasicConstraints::Constrained(0)),
    )?;
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: vec![
            GeneralSubtree::DnsName("moyu.local".into()),
            ip_subtree([10, 0, 0, 0], 8),
            ip_subtree([172, 16, 0, 0], 12),
            ip_subtree([192, 168, 0, 0], 16),
            ip_subtree([127, 0, 0, 0], 8),
            ip_subtree([169, 254, 0, 0], 16),
        ],
        excluded_subtrees: Vec::new(),
    });
    let issuer = Issuer::from_ca_cert_pem(root_cert_pem, &root_key).map_err(CaError::Crypto)?;
    let cert = params.signed_by(&key, &issuer).map_err(CaError::Crypto)?;
    let der = cert.der().as_ref().to_vec();
    Ok(GeneratedCa {
        key_pem: Zeroizing::new(key.serialize_pem()),
        cert_pem: cert.pem(),
        cert_der: der,
    })
}

fn generate_leaf_impl(
    intermediate_key_pem: &str,
    intermediate_cert_pem: &str,
    dns: &str,
    ips: &[Ipv4Addr],
    now: OffsetDateTime,
) -> CaResult<IssuedLeaf> {
    let mid_key = KeyPair::from_pem(intermediate_key_pem).map_err(CaError::Crypto)?;
    let key = new_key()?;
    // `ExplicitNoCa` emits `basicConstraints: CA:FALSE` (critical). The brief's
    // `NoCa` would omit the extension entirely; an explicit CA:FALSE is stricter.
    let mut params = cert_params(LEAF_CN, now, LEAF_DAYS, IsCa::ExplicitNoCa)?;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.subject_alt_names = vec![SanType::DnsName(
        dns.try_into()
            .map_err(|_| CaError::CertParse("dns".into()))?,
    )];
    for ip in ips {
        params
            .subject_alt_names
            .push(SanType::IpAddress(IpAddr::V4(*ip)));
    }
    let issuer =
        Issuer::from_ca_cert_pem(intermediate_cert_pem, &mid_key).map_err(CaError::Crypto)?;
    let cert = params.signed_by(&key, &issuer).map_err(CaError::Crypto)?;
    let der = cert.der().as_ref().to_vec();
    let info = parse_cert_der(&der)?;
    Ok(IssuedLeaf {
        key_pem: Zeroizing::new(key.serialize_pem()),
        cert_pem: cert.pem(),
        // Server chain: leaf first, then the issuing intermediate. The root is
        // a local trust anchor and is never sent.
        chain_pem: format!("{}{}", cert.pem(), intermediate_cert_pem),
        cert_der: der,
        fingerprint_sha256: info.fingerprint_sha256,
        not_before: info.not_before,
        not_after: info.not_after,
    })
}

pub(crate) fn generate_leaf(
    intermediate_key_pem: &str,
    intermediate_cert_pem: &str,
    dns: &str,
    ips: &[Ipv4Addr],
    now: OffsetDateTime,
) -> CaResult<IssuedLeaf> {
    if dns != LEAF_CN {
        return Err(CaError::InvalidLeafName);
    }
    if ips.is_empty() {
        return Err(CaError::InvalidLeafIp);
    }
    generate_leaf_impl(intermediate_key_pem, intermediate_cert_pem, dns, ips, now)
}

pub(crate) fn parse_cert_der(der: &[u8]) -> CaResult<CertInfo> {
    let (rem, cert) =
        X509Certificate::from_der(der).map_err(|e| CaError::CertParse(e.to_string()))?;
    if !rem.is_empty() {
        return Err(CaError::CertParse(
            "trailing bytes after certificate".to_string(),
        ));
    }
    let not_before = cert.validity().not_before.timestamp();
    let not_after = cert.validity().not_after.timestamp();
    let basic_constraints = cert
        .basic_constraints()
        .map_err(|err| CaError::CertParse(err.to_string()))?;
    let (is_ca, path_len, basic_constraints_critical) = match basic_constraints {
        Some(extension) => (
            extension.value.ca,
            extension.value.path_len_constraint,
            extension.critical,
        ),
        None => (false, None, false),
    };
    let key_usage = cert
        .key_usage()
        .map_err(|err| CaError::CertParse(err.to_string()))?;
    let (key_cert_sign, crl_sign, key_usage_critical) = match key_usage {
        Some(extension) => (
            extension.value.key_cert_sign(),
            extension.value.crl_sign(),
            extension.critical,
        ),
        None => (false, false, false),
    };
    Ok(CertInfo {
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        serial: hex::encode(cert.raw_serial()),
        // Hash the certificate that was actually parsed, not the input slice,
        // so the fingerprint can never cover trailing/foreign bytes.
        fingerprint_sha256: fingerprint_sha256(cert.as_raw()),
        not_before,
        not_after,
        spki_raw: cert.public_key().subject_public_key.data.to_vec(),
        is_ca,
        path_len,
        key_cert_sign,
        crl_sign,
        basic_constraints_critical,
        key_usage_critical,
    })
}

pub(crate) fn verify_ca_signature(issuer_der: &[u8], subject_der: &[u8]) -> CaResult<()> {
    let (issuer_rem, issuer) =
        X509Certificate::from_der(issuer_der).map_err(|e| CaError::CertParse(e.to_string()))?;
    if !issuer_rem.is_empty() {
        return Err(CaError::CertParse(
            "trailing bytes after issuer certificate".to_string(),
        ));
    }
    let (subject_rem, subject) =
        X509Certificate::from_der(subject_der).map_err(|e| CaError::CertParse(e.to_string()))?;
    if !subject_rem.is_empty() {
        return Err(CaError::CertParse(
            "trailing bytes after subject certificate".to_string(),
        ));
    }
    if subject.issuer() != issuer.subject() {
        return Err(CaError::ChainVerification);
    }
    subject
        .verify_signature(Some(issuer.public_key()))
        .map_err(|_| CaError::ChainVerification)
}

pub(crate) fn verify_chain(
    root_der: &[u8],
    intermediate_der: &[u8],
    leaf_der: &[u8],
    server_name: &ServerName<'_>,
    now_unix: i64,
) -> CaResult<()> {
    verify_chain_many(
        root_der,
        &[intermediate_der],
        leaf_der,
        server_name,
        now_unix,
    )
}

pub(crate) fn verify_chain_many(
    root_der: &[u8],
    intermediates: &[&[u8]],
    leaf_der: &[u8],
    server_name: &ServerName<'_>,
    now_unix: i64,
) -> CaResult<()> {
    // `KeyUsage::server_auth()` below is "required if present", so an explicit
    // check is needed to reject a leaf with no EKU extension at all. Do not use
    // `KeyUsage::required` here: webpki applies that policy to every
    // certificate in the path, and our CAs intentionally omit EKU. The strict
    // parse also rejects a leaf buffer with trailing bytes.
    let (leaf_rem, leaf_cert) =
        X509Certificate::from_der(leaf_der).map_err(|_| CaError::ChainVerification)?;
    if !leaf_rem.is_empty()
        || !matches!(leaf_cert.extended_key_usage(), Ok(Some(eku)) if eku.value.server_auth)
    {
        return Err(CaError::ChainVerification);
    }
    let root = CertificateDer::from(root_der.to_vec());
    let anchor = webpki::anchor_from_trusted_cert(&root).map_err(|_| CaError::ChainVerification)?;
    let leaf = CertificateDer::from(leaf_der.to_vec());
    let ee = webpki::EndEntityCert::try_from(&leaf).map_err(|_| CaError::ChainVerification)?;
    let intermediates = intermediates
        .iter()
        .map(|der| CertificateDer::from(der.to_vec()))
        .collect::<Vec<_>>();
    ee.verify_for_usage(
        webpki::ALL_VERIFICATION_ALGS,
        &[anchor],
        &intermediates,
        UnixTime::since_unix_epoch(std::time::Duration::from_secs(now_unix.max(0) as u64)),
        // Also rejects an EKU that is present but lacks serverAuth.
        webpki::KeyUsage::server_auth(),
        None,
        None,
    )
    .map_err(|_| CaError::ChainVerification)?;
    ee.verify_is_valid_for_subject_name(server_name)
        .map_err(|_| CaError::ChainVerification)
}

pub(crate) fn key_matches_cert(key_pem: &str, cert_der: &[u8]) -> CaResult<bool> {
    let key = KeyPair::from_pem(key_pem).map_err(CaError::Crypto)?;
    let info = parse_cert_der(cert_der)?;
    Ok(key.public_key_raw() == info.spki_raw.as_slice())
}

pub(crate) fn fingerprint_sha256(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    let hex = hex::encode_upper(digest);
    hex.as_bytes()
        .chunks(2)
        .map(|pair| std::str::from_utf8(pair).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Test-only helper used to construct leaves that violate the CA's name
/// constraints. Never call this from production code.
#[cfg(test)]
fn generate_leaf_unchecked(
    intermediate_key_pem: &str,
    intermediate_cert_pem: &str,
    dns: &str,
    ips: &[Ipv4Addr],
    now: OffsetDateTime,
) -> CaResult<IssuedLeaf> {
    generate_leaf_impl(intermediate_key_pem, intermediate_cert_pem, dns, ips, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::time::Duration;
    use std::net::IpAddr;

    fn now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap()
    }

    fn chain() -> (GeneratedCa, GeneratedCa, IssuedLeaf) {
        let root = generate_root(now()).unwrap();
        let mid = generate_intermediate(&root.key_pem, &root.cert_pem, now()).unwrap();
        let leaf = generate_leaf(
            &mid.key_pem,
            &mid.cert_pem,
            "moyu.local",
            &[Ipv4Addr::new(192, 168, 1, 10)],
            now(),
        )
        .unwrap();
        (root, mid, leaf)
    }

    fn parse(der: &[u8]) -> X509Certificate<'_> {
        X509Certificate::from_der(der)
            .expect("generated certificate parses")
            .1
    }

    /// Builds a sub-CA with a distinct CN, signed by the supplied issuer.
    /// Test-only: production intermediates always use `INTERMEDIATE_CN`.
    fn generate_sub_ca(
        issuer_key_pem: &str,
        issuer_cert_pem: &str,
        cn: &str,
        now: OffsetDateTime,
    ) -> GeneratedCa {
        let issuer_key = KeyPair::from_pem(issuer_key_pem).unwrap();
        let key = new_key().unwrap();
        let mut params = cert_params(
            cn,
            now,
            INTERMEDIATE_DAYS,
            IsCa::Ca(BasicConstraints::Constrained(0)),
        )
        .unwrap();
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let issuer = Issuer::from_ca_cert_pem(issuer_cert_pem, &issuer_key).unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        let der = cert.der().as_ref().to_vec();
        GeneratedCa {
            key_pem: Zeroizing::new(key.serialize_pem()),
            cert_pem: cert.pem(),
            cert_der: der,
        }
    }

    #[test]
    fn generated_chain_validates_for_dns_and_ip() {
        let (root, mid, leaf) = chain();
        let now_unix = now().unix_timestamp();
        verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now_unix,
        )
        .unwrap();
        verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
            now_unix,
        )
        .unwrap();
    }

    #[test]
    fn out_of_constraint_dns_is_rejected() {
        // Leaf SAN: evil.example (outside the permitted DNS subtree) plus
        // 192.168.1.10 (inside the permitted IP subtrees). The certificate is
        // requested under its own DNS SAN, so a hostname mismatch cannot be the
        // cause: only the DNS name constraint can reject this chain.
        let root = generate_root(now()).unwrap();
        let mid = generate_intermediate(&root.key_pem, &root.cert_pem, now()).unwrap();
        let leaf = generate_leaf_unchecked(
            &mid.key_pem,
            &mid.cert_pem,
            "evil.example",
            &[Ipv4Addr::new(192, 168, 1, 10)],
            now(),
        )
        .unwrap();
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::try_from("evil.example").unwrap(),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn subject_name_outside_san_is_rejected() {
        // Production leaf only carries SAN moyu.local; asking for another name
        // fails the subject-name check, not the name constraints.
        let (root, mid, leaf) = chain();
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::try_from("evil.example").unwrap(),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn expired_leaf_is_rejected() {
        let (root, mid, leaf) = chain();
        let later = now() + Duration::days(31);
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            later.unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn key_must_match_cert() {
        let (root, _, _) = chain();
        let other = generate_root(now()).unwrap();
        assert!(!key_matches_cert(&other.key_pem, &root.cert_der).unwrap());
        assert!(key_matches_cert(&root.key_pem, &root.cert_der).unwrap());
    }

    #[test]
    fn out_of_constraint_ip_is_rejected_by_webpki() {
        // Leaf SAN: moyu.local (inside the permitted DNS subtree) plus
        // 203.0.113.9 (outside every permitted IP subtree). The certificate is
        // requested under its own IP SAN, so only the IP name constraint can
        // reject this chain.
        let root = generate_root(now()).unwrap();
        let mid = generate_intermediate(&root.key_pem, &root.cert_pem, now()).unwrap();
        let leaf = generate_leaf_unchecked(
            &mid.key_pem,
            &mid.cert_pem,
            "moyu.local",
            &[Ipv4Addr::new(203, 0, 113, 9)],
            now(),
        )
        .unwrap();
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &leaf.cert_der,
            &ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9)).into()),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn pathlen_zero_blocks_sub_ca() {
        let root = generate_root(now()).unwrap();
        let mid = generate_intermediate(&root.key_pem, &root.cert_pem, now()).unwrap();
        // A sub-CA with a distinct CN, signed by the pathlen:0 intermediate.
        // The distinct subject isolates the path-length violation from any
        // issuer/subject name collision with the real intermediate.
        let sub = generate_sub_ca(
            &mid.key_pem,
            &mid.cert_pem,
            "Test Sub CA (pathlen probe)",
            now(),
        );
        assert_eq!(
            parse_cert_der(&sub.cert_der).unwrap().subject,
            "CN=Test Sub CA (pathlen probe)"
        );
        let leaf = generate_leaf_unchecked(
            &sub.key_pem,
            &sub.cert_pem,
            "moyu.local",
            &[Ipv4Addr::new(192, 168, 1, 10)],
            now(),
        )
        .unwrap();
        let err = verify_chain_many(
            &root.cert_der,
            &[mid.cert_der.as_slice(), sub.cert_der.as_slice()],
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn production_leaf_validates_dns_and_ip() {
        let root = generate_root(now()).unwrap();
        let mid = generate_intermediate(&root.key_pem, &root.cert_pem, now()).unwrap();
        let bad_dns = generate_leaf(
            &mid.key_pem,
            &mid.cert_pem,
            "evil.example",
            &[Ipv4Addr::new(192, 168, 1, 10)],
            now(),
        )
        .err()
        .expect("dns outside moyu.local must be rejected");
        assert_eq!(bad_dns.code(), "ca-invalid-leaf-name");
        let no_ip = generate_leaf(&mid.key_pem, &mid.cert_pem, "moyu.local", &[], now())
            .err()
            .expect("leaf without an IP must be rejected");
        assert_eq!(no_ip.code(), "ca-invalid-leaf-ip");
    }

    #[test]
    fn certificate_extensions_read_back_as_required() {
        let (root, mid, leaf) = chain();

        let root_cert = parse(&root.cert_der);
        let root_bc = root_cert
            .basic_constraints()
            .unwrap()
            .expect("root basicConstraints");
        assert!(root_bc.critical);
        assert!(root_bc.value.ca);
        assert_eq!(root_bc.value.path_len_constraint, Some(1));
        let root_ku = root_cert.key_usage().unwrap().expect("root keyUsage");
        assert!(root_ku.value.key_cert_sign());
        assert!(root_ku.value.crl_sign());
        assert!(!root_ku.value.digital_signature());
        assert!(root_cert.name_constraints().unwrap().is_none());
        assert!(root_cert.extended_key_usage().unwrap().is_none());
        let root_info = parse_cert_der(&root.cert_der).unwrap();
        assert_eq!(root_info.subject, "CN=Moyu Local Root CA");
        assert_eq!(root_info.issuer, "CN=Moyu Local Root CA");
        assert_eq!(root_info.not_after - root_info.not_before, 3651 * 86_400);
        assert_eq!(
            root_info.fingerprint_sha256,
            fingerprint_sha256(&root.cert_der)
        );

        let mid_cert = parse(&mid.cert_der);
        let mid_bc = mid_cert
            .basic_constraints()
            .unwrap()
            .expect("intermediate basicConstraints");
        assert!(mid_bc.critical);
        assert!(mid_bc.value.ca);
        assert_eq!(mid_bc.value.path_len_constraint, Some(0));
        let mid_ku = mid_cert
            .key_usage()
            .unwrap()
            .expect("intermediate keyUsage");
        assert!(mid_ku.value.key_cert_sign());
        assert!(mid_ku.value.crl_sign());
        let mid_nc = mid_cert
            .name_constraints()
            .unwrap()
            .expect("intermediate nameConstraints");
        assert!(mid_nc.critical);
        let permitted = mid_nc.value.permitted_subtrees.as_ref().unwrap();
        assert_eq!(permitted.len(), 6);
        let mut dns_names = Vec::new();
        let mut subnets = Vec::new();
        for subtree in permitted {
            match &subtree.base {
                GeneralName::DNSName(name) => dns_names.push((*name).to_string()),
                GeneralName::IPAddress(bytes) => {
                    assert_eq!(bytes.len(), 8, "IPv4 name constraint");
                    subnets.push(bytes.to_vec());
                }
                other => panic!("unexpected name constraint: {other:?}"),
            }
        }
        assert_eq!(dns_names, vec!["moyu.local".to_string()]);
        assert_eq!(
            subnets,
            vec![
                vec![10, 0, 0, 0, 255, 0, 0, 0],
                vec![172, 16, 0, 0, 255, 240, 0, 0],
                vec![192, 168, 0, 0, 255, 255, 0, 0],
                vec![127, 0, 0, 0, 255, 0, 0, 0],
                vec![169, 254, 0, 0, 255, 255, 0, 0],
            ]
        );
        assert!(mid_nc.value.excluded_subtrees.is_none());
        let mid_info = parse_cert_der(&mid.cert_der).unwrap();
        assert_eq!(mid_info.subject, "CN=Moyu Local Issuing CA");
        assert_eq!(mid_info.issuer, "CN=Moyu Local Root CA");
        assert_eq!(mid_info.not_after - mid_info.not_before, 181 * 86_400);

        let leaf_cert = parse(&leaf.cert_der);
        let leaf_bc = leaf_cert
            .basic_constraints()
            .unwrap()
            .expect("leaf basicConstraints");
        assert!(leaf_bc.critical);
        assert!(!leaf_bc.value.ca);
        assert_eq!(leaf_bc.value.path_len_constraint, None);
        let leaf_ku = leaf_cert.key_usage().unwrap().expect("leaf keyUsage");
        assert!(leaf_ku.value.digital_signature());
        assert!(!leaf_ku.value.key_encipherment());
        assert!(!leaf_ku.value.key_agreement());
        let leaf_eku = leaf_cert.extended_key_usage().unwrap().expect("leaf eku");
        assert!(!leaf_eku.critical);
        assert!(leaf_eku.value.server_auth);
        assert!(!leaf_eku.value.client_auth);
        let leaf_san = leaf_cert
            .subject_alternative_name()
            .unwrap()
            .expect("leaf san");
        let mut has_dns = false;
        let mut has_ip = false;
        for name in &leaf_san.value.general_names {
            match name {
                GeneralName::DNSName("moyu.local") => has_dns = true,
                GeneralName::IPAddress(bytes)
                    if bytes.len() == 4
                        && bytes[0] == 192
                        && bytes[1] == 168
                        && bytes[2] == 1
                        && bytes[3] == 10 =>
                {
                    has_ip = true
                }
                _ => {}
            }
        }
        assert!(has_dns && has_ip);
        assert!(leaf_cert.name_constraints().unwrap().is_none());
        let leaf_info = parse_cert_der(&leaf.cert_der).unwrap();
        assert_eq!(leaf_info.subject, "CN=moyu.local");
        assert_eq!(leaf_info.issuer, "CN=Moyu Local Issuing CA");
        assert_eq!(leaf.not_before, leaf_info.not_before);
        assert_eq!(leaf.not_after, leaf_info.not_after);
        assert_eq!(leaf.fingerprint_sha256, leaf_info.fingerprint_sha256);
        assert_eq!(leaf.chain_pem, format!("{}{}", leaf.cert_pem, mid.cert_pem));
        assert_eq!(leaf.chain_pem.matches("BEGIN CERTIFICATE").count(), 2);
        assert!(!leaf.chain_pem.contains(&root.cert_pem));
    }

    #[test]
    fn leaf_without_server_auth_eku_is_rejected() {
        let (root, mid, _) = chain();
        let mid_key = KeyPair::from_pem(&mid.key_pem).unwrap();
        let key = new_key().unwrap();
        let mut params = cert_params(LEAF_CN, now(), LEAF_DAYS, IsCa::ExplicitNoCa).unwrap();
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.subject_alt_names = vec![SanType::DnsName("moyu.local".try_into().unwrap())];
        let issuer = Issuer::from_ca_cert_pem(&mid.cert_pem, &mid_key).unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        let der = cert.der().as_ref().to_vec();
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &der,
            &ServerName::try_from("moyu.local").unwrap(),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn leaf_without_any_eku_is_rejected() {
        let (root, mid, _) = chain();
        let mid_key = KeyPair::from_pem(&mid.key_pem).unwrap();
        let key = new_key().unwrap();
        let mut params = cert_params(LEAF_CN, now(), LEAF_DAYS, IsCa::ExplicitNoCa).unwrap();
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        // No EKU extension at all: `KeyUsage::server_auth()` would accept this,
        // `KeyUsage::required(serverAuth)` must reject it.
        assert!(params.extended_key_usages.is_empty());
        params.subject_alt_names = vec![SanType::DnsName("moyu.local".try_into().unwrap())];
        let issuer = Issuer::from_ca_cert_pem(&mid.cert_pem, &mid_key).unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        let der = cert.der().as_ref().to_vec();
        assert!(parse(&der).extended_key_usage().unwrap().is_none());
        let err = verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &der,
            &ServerName::try_from("moyu.local").unwrap(),
            now().unix_timestamp(),
        )
        .unwrap_err();
        assert_eq!(err.code(), "ca-chain-verification");
    }

    #[test]
    fn parse_cert_der_rejects_trailing_bytes() {
        let (root, mid, _) = chain();
        // A second DER certificate appended to the first must not be ignored.
        let mut two_certs = root.cert_der.clone();
        two_certs.extend_from_slice(&mid.cert_der);
        assert_eq!(
            parse_cert_der(&two_certs)
                .expect_err("two certificates must be rejected")
                .code(),
            "ca-cert-parse"
        );
        // A single trailing byte must be rejected too.
        let mut trailing_byte = root.cert_der.clone();
        trailing_byte.push(0);
        assert_eq!(
            parse_cert_der(&trailing_byte)
                .expect_err("trailing byte must be rejected")
                .code(),
            "ca-cert-parse"
        );
        // The fingerprint covers exactly the parsed certificate DER.
        let parsed = parse(&root.cert_der);
        assert_eq!(parsed.as_raw(), root.cert_der.as_slice());
        assert_eq!(
            parse_cert_der(&root.cert_der).unwrap().fingerprint_sha256,
            fingerprint_sha256(parsed.as_raw())
        );
    }

    #[test]
    fn verify_ca_signature_rejects_trailing_bytes() {
        let (root, mid, _) = chain();
        verify_ca_signature(&root.cert_der, &mid.cert_der).unwrap();
        let mut issuer_with_trailing_byte = root.cert_der.clone();
        issuer_with_trailing_byte.push(0);
        assert_eq!(
            verify_ca_signature(&issuer_with_trailing_byte, &mid.cert_der)
                .unwrap_err()
                .code(),
            "ca-cert-parse"
        );
        let mut subject_with_second_cert = mid.cert_der.clone();
        subject_with_second_cert.extend_from_slice(&root.cert_der);
        assert_eq!(
            verify_ca_signature(&root.cert_der, &subject_with_second_cert)
                .unwrap_err()
                .code(),
            "ca-cert-parse"
        );
    }

    #[test]
    fn ca_signatures_and_subject_alternatives_are_enforced() {
        let (root, mid, leaf) = chain();
        verify_ca_signature(&root.cert_der, &mid.cert_der).unwrap();
        verify_ca_signature(&mid.cert_der, &leaf.cert_der).unwrap();
        // A root that did not sign the intermediate must fail.
        let other_root = generate_root(now()).unwrap();
        assert_eq!(
            verify_ca_signature(&other_root.cert_der, &mid.cert_der)
                .unwrap_err()
                .code(),
            "ca-chain-verification"
        );
        // Chain with a leaf/key mismatch is rejected as a chain error.
        let other_leaf = generate_leaf(
            &mid.key_pem,
            &mid.cert_pem,
            "moyu.local",
            &[Ipv4Addr::new(10, 1, 2, 3)],
            now(),
        )
        .unwrap();
        assert!(verify_chain(
            &root.cert_der,
            &mid.cert_der,
            &other_leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now().unix_timestamp(),
        )
        .is_ok());
        assert_eq!(
            verify_chain(
                &root.cert_der,
                &mid.cert_der,
                &leaf.cert_der,
                &ServerName::try_from("other.moyu.local").unwrap(),
                now().unix_timestamp(),
            )
            .unwrap_err()
            .code(),
            "ca-chain-verification"
        );
    }
}
