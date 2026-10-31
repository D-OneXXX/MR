//! AEAD root backup container.
//!
//! A backup contains **only** the active root private key, root certificate
//! and public metadata. It never contains an intermediate private key, and the
//! root key is unreadable without the passphrase.
//!
//! Container layout (all integers little-endian):
//!
//! ```text
//! magic       8 bytes  "MOYUCA01"
//! version     1 byte   = 1
//! m_cost      4 bytes  Argon2id memory cost in KiB (65536)
//! t_cost      4 bytes  Argon2id iterations (3)
//! p_cost      4 bytes  Argon2id parallelism (1)
//! salt        16 bytes
//! nonce       24 bytes
//! ciphertext  remaining bytes (XChaCha20-Poly1305 ciphertext + 16-byte tag)
//! ```
//!
//! The whole 61-byte header is the AEAD associated data, so tampering with the
//! magic, version, KDF parameters, salt or nonce is authenticated. The derived
//! 32-byte key is Argon2id (`Version::V0x13`) and is zeroized after use. The
//! plaintext is a JSON payload holding only the active root material.
//!
//! Nothing in this module logs, formats or otherwise exposes the passphrase,
//! key material or the CA/backup path. Export is read-only with respect to the
//! CA (apart from reading the active root key and appending a non-sensitive
//! `ca.export.backup` audit event), but it still takes the process-wide
//! operation lock through [`super::CaManager`] so a snapshot can never race a
//! rotation.
//!
//! Import applies the same 180-day remaining-validity floor as intermediate
//! rotation, because a fresh intermediate (180 days) must never outlive the
//! imported root. Corrupt/missing-state recovery never writes into an
//! unverifiable tree: the whole existing CA root is renamed atomically to a
//! sibling `<root>.quarantine-<nanos>` directory, which is outside the active
//! root and therefore outside the ACL audit, and a clean generation pair 1/1
//! is created in its place. The quarantine location is deliberately not
//! logged or returned.
//!
//! Passphrase strength is the caller's responsibility: the container format
//! does not impose a minimum length, so restores of existing containers are
//! never blocked. Callers should require a long, unique passphrase; Argon2id
//! only makes guessing expensive, it does not make a weak passphrase safe.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use zeroize::{Zeroize, Zeroizing};

use super::crypto::{self, CaRole, CertInfo};
use super::error::{CaError, CaResult};
use super::paths::{CaPaths, CA_SCHEMA};
use super::{
    acl, generation_meta, require_current_validity, require_days_remaining, storage,
    MIN_ROOT_ROTATION_DAYS,
};

/// Container magic. Changing it is a format-breaking change.
pub const BACKUP_MAGIC: &[u8; 8] = b"MOYUCA01";
/// Container version understood by this module.
const BACKUP_VERSION: u8 = 1;
/// Argon2id memory cost in KiB.
const ARGON2_M_COST_KIB: u32 = 64 * 1024;
/// Argon2id iteration count.
const ARGON2_T_COST: u32 = 3;
/// Argon2id parallelism.
const ARGON2_P_COST: u32 = 1;
/// Derived AEAD key length.
const DERIVED_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// magic + version + three KDF parameters + salt + nonce.
const HEADER_LEN: usize = 8 + 1 + 4 + 4 + 4 + SALT_LEN + NONCE_LEN;
/// Upper bound on a backup file. A real container is a few kilobytes; the cap
/// prevents an attacker-supplied file from forcing an unbounded allocation.
const MAX_BACKUP_BYTES: u64 = 1024 * 1024;

/// Authenticated plaintext of a backup container.
///
/// Only the active root is exported. `root_meta` is public certificate
/// metadata (no secrets) and is rewritten with the local generation number on
/// import.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BackupPayload {
    pub schema: u32,
    pub root_generation: u32,
    pub root_key_pem: String,
    pub root_cert_pem: String,
    pub root_meta: storage::GenerationMeta,
}

impl Drop for BackupPayload {
    fn drop(&mut self) {
        self.root_key_pem.zeroize();
    }
}

impl std::fmt::Debug for BackupPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupPayload")
            .field("schema", &self.schema)
            .field("root_generation", &self.root_generation)
            .field("root_key_pem", &"<redacted>")
            .field("root_cert_pem_len", &self.root_cert_pem.len())
            .field("root_meta", &self.root_meta)
            .finish()
    }
}

/// Encrypt a serialized [`BackupPayload`] into a complete container.
pub(crate) fn encrypt_backup(payload: &[u8], passphrase: &str) -> CaResult<Vec<u8>> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    let mut rng = rand::rngs::OsRng;
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce);

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(BACKUP_MAGIC);
    header.push(BACKUP_VERSION);
    header.extend_from_slice(&ARGON2_M_COST_KIB.to_le_bytes());
    header.extend_from_slice(&ARGON2_T_COST.to_le_bytes());
    header.extend_from_slice(&ARGON2_P_COST.to_le_bytes());
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    debug_assert_eq!(header.len(), HEADER_LEN);

    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: payload,
                aad: &header,
            },
        )
        .map_err(|_| CaError::BackupDecrypt)?;

    let mut container = header;
    container.extend_from_slice(&ciphertext);
    Ok(container)
}

/// Decrypt a complete container. Any malformed header, unsupported parameter
/// set, wrong passphrase or tampered byte is reported as `ca-backup-decrypt`.
pub(crate) fn decrypt_backup(bytes: &[u8], passphrase: &str) -> CaResult<Vec<u8>> {
    if bytes.len() < HEADER_LEN + TAG_LEN {
        return Err(CaError::BackupDecrypt);
    }
    if &bytes[..BACKUP_MAGIC.len()] != BACKUP_MAGIC.as_slice() {
        return Err(CaError::BackupDecrypt);
    }
    if bytes[BACKUP_MAGIC.len()] != BACKUP_VERSION {
        return Err(CaError::BackupDecrypt);
    }
    let m_cost = u32::from_le_bytes(
        bytes[9..13]
            .try_into()
            .map_err(|_| CaError::BackupDecrypt)?,
    );
    let t_cost = u32::from_le_bytes(
        bytes[13..17]
            .try_into()
            .map_err(|_| CaError::BackupDecrypt)?,
    );
    let p_cost = u32::from_le_bytes(
        bytes[17..21]
            .try_into()
            .map_err(|_| CaError::BackupDecrypt)?,
    );
    // Version 1 fixes the KDF parameters. Rejecting anything else also caps
    // the memory an attacker-controlled header can request before Argon2 runs.
    if m_cost != ARGON2_M_COST_KIB || t_cost != ARGON2_T_COST || p_cost != ARGON2_P_COST {
        return Err(CaError::BackupDecrypt);
    }

    let salt = &bytes[21..21 + SALT_LEN];
    let nonce = &bytes[21 + SALT_LEN..HEADER_LEN];
    let header = &bytes[..HEADER_LEN];
    let ciphertext = &bytes[HEADER_LEN..];
    let key = derive_key(passphrase, salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| CaError::BackupDecrypt)
}

fn derive_key(passphrase: &str, salt: &[u8]) -> CaResult<Zeroizing<[u8; DERIVED_KEY_LEN]>> {
    let params = Params::new(
        ARGON2_M_COST_KIB,
        ARGON2_T_COST,
        ARGON2_P_COST,
        Some(DERIVED_KEY_LEN),
    )
    .map_err(|_| CaError::BackupDecrypt)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; DERIVED_KEY_LEN]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| CaError::BackupDecrypt)?;
    Ok(key)
}

/// Export the active root generation to `path`.
///
/// The destination must live outside the CA root: destroy removes that whole
/// tree, so a backup stored inside it would be lost (and would also place an
/// exported private key under the CA's private ACL). Both the lexical and the
/// canonical path are checked, including `.`/`..` components and a symlinked
/// parent directory. Existing destinations are refused with `create_new`
/// unless `overwrite` is set, in which case the container is staged in the same
/// directory, fsynced and atomically replaced.
///
/// Appends a non-sensitive `ca.export.backup` audit event (generation numbers
/// and root fingerprint only, never the path or key). If that append fails the
/// error is returned even though the container was already written, matching
/// the other post-commit audit contracts in this module.
///
/// No minimum passphrase length is enforced; callers should require a long,
/// unique passphrase (see the module docs).
pub(crate) fn export_backup(
    paths: &CaPaths,
    path: &Path,
    passphrase: &str,
    overwrite: bool,
    now: OffsetDateTime,
) -> CaResult<()> {
    ensure_destination_outside_ca_root(paths, path)?;

    // Export is the only read path that loads the root private key. Read the
    // key from the exact generation whose certificate/metadata were captured,
    // so an external swap between the two reads cannot produce a mismatched
    // container. The key is zeroized by `Zeroizing`; the payload copy is
    // zeroized by its `Drop`.
    let state = storage::load_state(paths)?;
    let root = storage::read_root_public(paths, state.active_root)?;
    let root_key = storage::read_root_generation_key(paths, root.generation)?;
    let payload = BackupPayload {
        schema: CA_SCHEMA,
        root_generation: root.generation,
        root_key_pem: root_key.as_str().to_owned(),
        root_cert_pem: root.cert_pem,
        root_meta: root.meta,
    };
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&payload)
            .map_err(|_| CaError::CorruptState("backup payload serialize"))?,
    );
    let container = encrypt_backup(plaintext.as_slice(), passphrase)?;
    write_container(path, &container, overwrite)?;
    // Audit only after the file is durable. The event carries no path and no
    // key material; a failure is returned but cannot unwrite the container.
    storage::append_event(
        paths,
        &storage::CaEvent {
            ts: now.unix_timestamp(),
            event: "ca.export.backup",
            result: "ok",
            root_generation: root.generation,
            intermediate_generation: state.active_intermediate,
            fingerprint: Some(root.info.fingerprint_sha256.as_str()),
            previous_fingerprint: None,
        },
    )?;
    Ok(())
}

/// Import a root backup, generating a fresh intermediate under the imported
/// root.
///
/// The payload is validated before anything is written: key/cert match, root
/// self-signature, current validity, at least 180 days of remaining validity
/// (a fresh 180-day intermediate must never outlive its root), `CA:TRUE`,
/// `pathLen=1`, `keyCertSign`+`cRLSign`, critical
/// `basicConstraints`/`keyUsage`, and metadata/certificate agreement. A leaf,
/// a `pathLen=0` root or a near-expiry root is rejected. The freshly generated
/// intermediate must also pass a generated leaf probe for both `moyu.local`
/// and a private IPv4 SAN before it is published.
///
/// - A valid existing CA requires `replace_existing`. The caller first runs
///   the full `status()` audit; replacement writes the imported root at
///   `state.next_root` and a freshly signed intermediate at
///   `state.next_intermediate`, and every old generation is retained.
/// - A pristine CA root (no state, no files) accepts a first restore at
///   generations 1/1.
/// - Corrupt state, or missing state over leftover CA artifacts, requires
///   `replace_existing`. The whole existing CA root is renamed atomically to a
///   sibling `<root>.quarantine-<nanos>` directory (same parent, outside the
///   active root and therefore outside the ACL audit) and a fresh 1/1 pair is
///   created. The old tree is preserved for manual inspection/removal; its
///   exact path is not logged or returned. If the rename fails, the operation
///   aborts with no state change.
///
/// The active state pointer is only moved after both new generations are
/// written and validated. A failure before the commit removes the artifacts
/// created by this call and, for a quarantined recovery, renames the old CA
/// root back into place; cleanup errors take precedence over the original
/// failure. If the state pointer is already visible when the commit reports an
/// error (for example a post-replace ACL verification error), the referenced
/// generations are **not** deleted: the error is returned and the CA is
/// "committed but unhealthy" (inspect `status`/ACL). The `ca.import.backup`
/// event is appended after the commit; a post-commit audit failure is returned
/// but the imported chain is already active.
///
/// No minimum passphrase length is enforced; callers should require a long,
/// unique passphrase (see the module docs).
pub(crate) fn import_backup(
    paths: &CaPaths,
    now: OffsetDateTime,
    path: &Path,
    passphrase: &str,
    replace_existing: bool,
) -> CaResult<()> {
    let bytes = read_container(path)?;
    let plaintext = Zeroizing::new(decrypt_backup(&bytes, passphrase)?);
    let payload: BackupPayload = serde_json::from_slice(plaintext.as_slice())
        .map_err(|_| CaError::CorruptState("backup payload json"))?;
    if payload.schema != CA_SCHEMA {
        return Err(CaError::CorruptState("backup payload schema"));
    }

    let (root_der, root_info) = storage::parse_cert_pem(&payload.root_cert_pem)
        .map_err(|_| CaError::CorruptState("backup root certificate"))?;
    if root_info.subject != root_info.issuer {
        return Err(CaError::CorruptState("backup root is not self-signed"));
    }
    // Reuse the exact extension policy `status` applies to stored roots
    // (including the criticality bits added for import).
    crypto::validate_ca_extensions(&root_info, CaRole::Root)?;
    crypto::verify_ca_signature(&root_der, &root_der)
        .map_err(|_| CaError::CorruptState("backup root self-signature"))?;
    require_current_validity(&root_info, now.unix_timestamp())?;
    // A fresh intermediate is always 180 days. Importing a root with less
    // remaining validity would publish a chain whose intermediate outlives its
    // root, so the same floor as root rotation is applied before any write.
    require_days_remaining(
        root_info.not_after,
        now.unix_timestamp(),
        MIN_ROOT_ROTATION_DAYS,
    )?;
    if !crypto::key_matches_cert(&payload.root_key_pem, &root_der)? {
        return Err(CaError::KeyMismatch);
    }
    validate_import_meta(&payload, &root_info)?;

    let base = import_base(paths, replace_existing)?;

    let (new_root_generation, new_intermediate_generation) = match &base {
        ImportBase::Replace { state, .. } => {
            let new_root = state.next_root;
            let new_intermediate = state.next_intermediate;
            if new_root == 0
                || new_intermediate == 0
                || paths.root_generation_dir(new_root).exists()
                || paths.intermediate_generation_dir(new_intermediate).exists()
            {
                return Err(CaError::CorruptState("backup import target generation"));
            }
            (new_root, new_intermediate)
        }
        ImportBase::Fresh { .. } => (1, 1),
    };
    let next_root_generation = new_root_generation
        .checked_add(1)
        .ok_or(CaError::CorruptState("root generation number"))?;
    let next_intermediate_generation = new_intermediate_generation
        .checked_add(1)
        .ok_or(CaError::CorruptState("intermediate generation number"))?;

    let now_unix = now.unix_timestamp();
    let mut root_meta = payload.root_meta.clone();
    // The backup carries the source installation's generation number; the
    // imported root is published under a locally unique one.
    root_meta.generation = new_root_generation;
    let root_dir = paths.root_generation_dir(new_root_generation);
    let intermediate_dir = paths.intermediate_generation_dir(new_intermediate_generation);

    // A failure before the state commit must leave no new artifacts behind
    // and, for a quarantined recovery, put the old CA root back.
    let fail_before_commit = |err: CaError| -> CaError {
        match cleanup_after_failed_import(
            paths,
            &base,
            new_root_generation,
            new_intermediate_generation,
        ) {
            Ok(()) => err,
            Err(cleanup_err) => cleanup_err,
        }
    };

    // `write_generation` validates the certificate, metadata, key match and CA
    // extensions again, publishes the directory with one rename, and removes
    // its staging tree on failure.
    if let Err(err) = storage::write_generation(
        paths,
        &root_dir,
        &payload.root_key_pem,
        &payload.root_cert_pem,
        &root_meta,
    ) {
        return Err(fail_before_commit(err));
    }

    let intermediate_result = (|| -> CaResult<()> {
        let generated =
            crypto::generate_intermediate(&payload.root_key_pem, &payload.root_cert_pem, now)?;
        let info = crypto::parse_cert_der(&generated.cert_der)?;
        crypto::validate_ca_extensions(&info, CaRole::Intermediate)?;
        crypto::verify_ca_signature(&root_der, &generated.cert_der)
            .map_err(|_| CaError::CorruptState("backup root/intermediate signature"))?;
        if !crypto::key_matches_cert(&generated.key_pem, &generated.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        let intermediate_meta = generation_meta(
            CaRole::Intermediate,
            new_intermediate_generation,
            &generated.cert_der,
            now_unix,
            Some(new_root_generation),
        )?;
        // Generated issuance probe before the new intermediate is published:
        // the imported root must chain for both DNS and a private IPv4 SAN.
        super::verify_issuance_probe(
            paths,
            &root_der,
            &generated.cert_der,
            &generated.key_pem,
            &generated.cert_pem,
            now,
        )?;
        storage::write_generation(
            paths,
            &intermediate_dir,
            &generated.key_pem,
            &generated.cert_pem,
            &intermediate_meta,
        )
    })();
    if let Err(err) = intermediate_result {
        return Err(fail_before_commit(err));
    }

    let next_state = match &base {
        ImportBase::Replace { state, .. } => {
            let mut next = state.clone();
            next.active_root = new_root_generation;
            next.active_intermediate = new_intermediate_generation;
            next.next_root = next_root_generation;
            next.next_intermediate = next_intermediate_generation;
            // Informational timestamp; clamp so a backward clock cannot make
            // the new state fail validation.
            next.updated_at = now_unix.max(next.created_at);
            next
        }
        ImportBase::Fresh { .. } => storage::CaState {
            schema: CA_SCHEMA,
            active_root: new_root_generation,
            active_intermediate: new_intermediate_generation,
            next_root: next_root_generation,
            next_intermediate: next_intermediate_generation,
            created_at: now_unix,
            updated_at: now_unix,
        },
    };
    if let Err(err) = storage::store_state_atomic(paths, &next_state) {
        // `store_state_atomic` replaces the file before re-verifying the
        // destination ACL. If the new pointer is already visible, deleting the
        // generations it references would leave state pointing at missing
        // directories, so classify with the unverified reader and leave the
        // committed pair in place.
        if storage::state_points_at(paths, new_root_generation, new_intermediate_generation) {
            return Err(err);
        }
        return Err(fail_before_commit(err));
    }

    let previous_root_fingerprint = match &base {
        ImportBase::Replace {
            previous_root_fingerprint,
            ..
        } => Some(previous_root_fingerprint.as_str()),
        ImportBase::Fresh { .. } => None,
    };
    storage::append_event(
        paths,
        &storage::CaEvent {
            ts: now_unix,
            event: "ca.import.backup",
            result: "ok",
            root_generation: new_root_generation,
            intermediate_generation: new_intermediate_generation,
            fingerprint: Some(root_info.fingerprint_sha256.as_str()),
            previous_fingerprint: previous_root_fingerprint,
        },
    )?;
    Ok(())
}

enum ImportBase {
    /// No usable state: the active root is either pristine or was moved aside
    /// as a quarantine. A failed import restores the quarantine when set.
    Fresh { quarantine: Option<PathBuf> },
    /// A readable active CA: replace it at the state's next generation numbers
    /// and keep every old generation.
    Replace {
        state: storage::CaState,
        previous_root_fingerprint: String,
    },
}

fn import_base(paths: &CaPaths, replace_existing: bool) -> CaResult<ImportBase> {
    match storage::load_state(paths) {
        Ok(state) => {
            if !replace_existing {
                return Err(CaError::AlreadyInitialized);
            }
            // The manager runs the full `status()` audit before this point.
            // Reading the active root again keeps the module safe for any
            // direct caller and proves the old fingerprint before a write.
            let old_root = storage::read_active_root_public(paths)?;
            Ok(ImportBase::Replace {
                state,
                previous_root_fingerprint: old_root.info.fingerprint_sha256,
            })
        }
        Err(CaError::NotInitialized) if !ca_root_has_content(paths) => {
            // A pristine CA root has nothing to quarantine, so a first restore
            // is allowed without explicit consent (the restore roundtrip in
            // the task brief depends on this).
            Ok(ImportBase::Fresh { quarantine: None })
        }
        Err(CaError::NotInitialized) => {
            // Missing state over leftover artifacts is a partial/corrupt
            // installation and needs explicit consent.
            if !replace_existing {
                return Err(CaError::NotInitialized);
            }
            quarantine_for_fresh_import(paths)
        }
        Err(err @ (CaError::CorruptState(_) | CaError::AclVerification(_))) => {
            // Corrupt state, or a state file whose ACL no longer verifies, is
            // never repaired in place: with consent the whole tree is moved
            // aside so the new state cannot inherit a broken destination ACL.
            if !replace_existing {
                return Err(err);
            }
            quarantine_for_fresh_import(paths)
        }
        Err(err) => Err(err),
    }
}

fn quarantine_for_fresh_import(paths: &CaPaths) -> CaResult<ImportBase> {
    let quarantine = quarantine_root(paths)?;
    Ok(ImportBase::Fresh {
        quarantine: Some(quarantine),
    })
}

/// Any file or directory under the CA root means this is not a pristine
/// restore destination. An empty root directory is treated as pristine.
fn ca_root_has_content(paths: &CaPaths) -> bool {
    match std::fs::read_dir(paths.root_dir()) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => paths.state_file().exists(),
    }
}

/// Atomically rename the entire existing CA root to a sibling directory.
///
/// A same-parent rename is atomic on both supported platforms, so a failure
/// leaves the old root and state exactly as they were. The quarantine lives
/// outside the active root, which keeps its possibly broken ACL out of
/// `verify_acl` while preserving every byte for manual inspection. Its path is
/// intentionally neither logged nor returned.
fn quarantine_root(paths: &CaPaths) -> CaResult<PathBuf> {
    let root = paths.root_dir();
    let metadata = std::fs::symlink_metadata(root).map_err(CaError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CaError::CorruptState("CA root is not a plain directory"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(CaError::CorruptState("CA root is a reparse point"));
        }
    }
    let parent = root
        .parent()
        .ok_or(CaError::CorruptState("CA root has no parent"))?;
    let name = root
        .file_name()
        .ok_or(CaError::CorruptState("CA root has no name"))?
        .to_string_lossy();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let quarantine = parent.join(format!("{name}.quarantine-{nanos}"));
    if quarantine.exists() {
        return Err(CaError::CorruptState("CA quarantine path already exists"));
    }
    std::fs::rename(root, &quarantine).map_err(CaError::Io)?;
    Ok(quarantine)
}

/// Undo an import that failed before the state commit.
///
/// A fresh recovery removes the entire new CA root (it did not exist before
/// this call once the old root was quarantined) and renames the quarantine
/// back. A replacement removes only the two generation directories created
/// here; every old generation and the previous state are untouched. Errors
/// are propagated so a dirty tree is never reported as clean.
fn cleanup_after_failed_import(
    paths: &CaPaths,
    base: &ImportBase,
    root_generation: u32,
    intermediate_generation: u32,
) -> CaResult<()> {
    match base {
        ImportBase::Fresh { quarantine } => {
            acl::force_remove_dir_all(paths.root_dir())?;
            if let Some(quarantine) = quarantine {
                std::fs::rename(quarantine, paths.root_dir()).map_err(CaError::Io)?;
            }
            Ok(())
        }
        ImportBase::Replace { .. } => {
            acl::force_remove_dir_all(&paths.root_generation_dir(root_generation))?;
            acl::force_remove_dir_all(&paths.intermediate_generation_dir(intermediate_generation))?;
            Ok(())
        }
    }
}

fn validate_import_meta(payload: &BackupPayload, info: &CertInfo) -> CaResult<()> {
    let meta = &payload.root_meta;
    if payload.root_generation == 0
        || meta.schema != CA_SCHEMA
        || meta.generation != payload.root_generation
        || meta.issuer_root_generation.is_some()
        || meta.created_at < 0
        || meta.not_before > meta.not_after
        || meta.fingerprint_sha256 != info.fingerprint_sha256
        || meta.subject != info.subject
        || meta.not_before != info.not_before
        || meta.not_after != info.not_after
    {
        return Err(CaError::CorruptState("backup root metadata"));
    }
    Ok(())
}

fn read_container(path: &Path) -> CaResult<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path).map_err(CaError::Io)?;
    if !metadata.is_file() {
        return Err(CaError::Io(std::io::Error::new(
            ErrorKind::InvalidInput,
            "backup path is not a regular file",
        )));
    }
    if metadata.len() < (HEADER_LEN + TAG_LEN) as u64 || metadata.len() > MAX_BACKUP_BYTES {
        return Err(CaError::BackupDecrypt);
    }
    let bytes = std::fs::read(path).map_err(CaError::Io)?;
    if bytes.len() < HEADER_LEN + TAG_LEN || bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err(CaError::BackupDecrypt);
    }
    Ok(bytes)
}

fn write_container(path: &Path, bytes: &[u8], overwrite: bool) -> CaResult<()> {
    // A bare file name is relative to the current directory; stage there too.
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    if !overwrite {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(CaError::Io)?;
        if let Err(err) = restrict_permissions(&file) {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err(err);
        }
        let result = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        if let Err(err) = result {
            let _ = std::fs::remove_file(path);
            return Err(CaError::Io(err));
        }
        return Ok(());
    }

    // Stage next to the destination so the replacement stays on one volume.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".mr-ca-backup-{}-{nanos}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(CaError::Io)?;
    if let Err(err) = restrict_permissions(&file) {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(err) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(CaError::Io(err));
    }
    if let Err(err) = storage::replace_file(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    // Directory fsync makes the rename durable on Unix. Windows has no
    // equivalent for directories through std; ReplaceFileW already flushed the
    // staged file before the atomic metadata swap.
    #[cfg(unix)]
    {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

/// The container is encrypted, but it is still a private-key export: keep it
/// owner-readable only on Unix. Windows inherits the destination directory's
/// ACL, which is the same policy as any other user-chosen file.
#[cfg(unix)]
fn restrict_permissions(file: &File) -> CaResult<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(CaError::Io)
}

#[cfg(not(unix))]
fn restrict_permissions(_file: &File) -> CaResult<()> {
    Ok(())
}

fn ensure_destination_outside_ca_root(paths: &CaPaths, path: &Path) -> CaResult<()> {
    let root = paths.root_dir();
    let destination = absolute_lexical(path)?;
    let root_lexical = absolute_lexical(root)?;
    if path_is_within(&destination, &root_lexical) {
        return Err(destination_inside_root_error());
    }
    // Resolve symlinks in the destination (or its parent when the file does
    // not exist yet) and compare against the canonical CA root as well.
    let root_canonical =
        std::fs::canonicalize(&root_lexical).unwrap_or_else(|_| root_lexical.clone());
    if let Some(destination_canonical) = canonical_for_compare(&destination) {
        if path_is_within(&destination_canonical, &root_canonical) {
            return Err(destination_inside_root_error());
        }
    }
    Ok(())
}

fn destination_inside_root_error() -> CaError {
    CaError::Io(std::io::Error::new(
        ErrorKind::InvalidInput,
        "backup destination is inside the CA root",
    ))
}

/// Make `path` absolute and resolve `.`/`..` components without touching the
/// filesystem. `Path::pop` never climbs above the root.
fn absolute_lexical(path: &Path) -> CaResult<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(CaError::Io)?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
        }
    }
    Ok(normalized)
}

/// Canonicalize an existing path, or an existing parent plus the final name.
/// Returns `None` when no ancestor exists yet; the caller still has the
/// lexical check in that case.
fn canonical_for_compare(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Some(canonical);
    }
    let parent = path.parent()?;
    let name = path.file_name()?;
    std::fs::canonicalize(parent)
        .ok()
        .map(|parent| parent.join(name))
}

fn path_is_within(child: &Path, parent: &Path) -> bool {
    let mut child_components = child.components();
    for parent_component in parent.components() {
        match child_components.next() {
            Some(child_component) if component_eq(child_component, parent_component) => {}
            _ => return false,
        }
    }
    true
}

#[cfg(windows)]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    // Windows path comparison is case-insensitive. Lowercasing the lossy
    // string is stricter than ASCII-only folding for non-ASCII names.
    left.as_os_str().to_string_lossy().to_lowercase()
        == right.as_os_str().to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    left == right
}
