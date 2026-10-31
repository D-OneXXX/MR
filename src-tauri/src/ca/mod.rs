//! Local certificate authority lifecycle.
//!
//! This slice provides generation storage, an atomic state pointer, the audit
//! event log, the initialize/status facade, in-memory leaf issuance,
//! intermediate rotation/retirement, two-phase root rotation with explicit
//! retirement, pending-pair discard, AEAD root backup/restore and destroy. One
//! CA root per process; mutating operations are serialized by a process-wide
//! operation lock and `status` stays lock-free. It intentionally contains no
//! Tauri command, TLS listener, client enrollment, session, data route, or
//! device trust-store installation.

mod acl;
pub mod backup;
mod crypto;
mod error;
mod paths;
mod storage;

use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rustls_pki_types::ServerName;
use time::OffsetDateTime;
use zeroize::Zeroizing;

use crypto::CaRole;

/// The only DNS name a production leaf may cover.
const LEAF_DNS: &str = "moyu.local";
/// Private IPv4 SAN carried by the throwaway issuance-probe leaf. It must fall
/// inside the intermediate's permitted IP subtrees.
const PROBE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 10);
/// Upper bound on IPv4 SANs per leaf.
const MAX_LEAF_IPS: usize = 8;
/// A leaf (30 days) must never outlive either issuer. Issuance is refused when
/// the active root or intermediate has less than this much validity left.
const MIN_LEAF_ISSUER_DAYS: i64 = 30;
/// A fresh intermediate (180 days) must never outlive the root that signs it.
/// Intermediate rotation is refused below this remaining root validity.
const MIN_ROOT_ROTATION_DAYS: i64 = 180;
const SECONDS_PER_DAY: i64 = 86_400;

/// Process-wide serialization for every CA mutation.
///
/// **One CA root per process; operations serialize globally.** All managers
/// (including two instances pointed at the same directory) share this single
/// lock, so state commits, generation writes, rotations, pending-pair discard
/// and destroy can never interleave. `status` / `verify_acl` are read-only and
/// deliberately do not acquire it, which is why locked methods may call
/// `status`. Locked methods must never call another locked method.
///
/// The future backup export is read-only but must also acquire this lock so a
/// snapshot cannot race a rotation. A poisoned lock means a previous mutating
/// operation panicked mid-commit; it is reported as `ca-state-corrupt` rather
/// than panicking on `.unwrap()`.
static CA_OPERATION_LOCK: Mutex<()> = Mutex::new(());

pub use error::{CaError, CaResult};
pub use paths::{resolve_ca_root, CaPaths, CA_SCHEMA};

// Response surface consumed by the CA lifecycle and rotation/backup tasks.
#[allow(unused_imports)] // Tasks 6–7: root rotation, full chain verification, backup import.
pub(crate) use crypto::{
    fingerprint_sha256, generate_leaf, verify_chain, verify_chain_many, CertInfo, GeneratedCa,
    IssuedLeaf,
};

/// Snapshot of the active CA chain for settings/diagnostics.
#[derive(Debug, Clone)]
pub struct CaStatus {
    pub root_generation: u32,
    pub intermediate_generation: u32,
    pub root_fingerprint_sha256: String,
    pub intermediate_fingerprint_sha256: String,
    pub root_not_after: i64,
    pub intermediate_not_after: i64,
    pub root_days_remaining: i64,
    pub intermediate_days_remaining: i64,
    pub needs_root_rotation: bool,
    pub needs_intermediate_rotation: bool,
}

/// In-memory leaf certificate material.
///
/// The private key is wrapped in [`Zeroizing`] and is never persisted, logged
/// or written to the audit event log. `cert_der` is public certificate data and
/// exists so callers (and tests) can verify the chain without re-parsing PEM.
/// The manual `Debug` implementation redacts the key.
pub struct LeafMaterial {
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    pub key_pem: Zeroizing<String>,
    /// Leaf first, then the issuing intermediate. The root is a local trust
    /// anchor and is never part of the served chain.
    pub chain_pem: String,
    pub fingerprint_sha256: String,
    pub not_before: i64,
    pub not_after: i64,
}

impl std::fmt::Debug for LeafMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeafMaterial")
            .field("cert_pem_len", &self.cert_pem.len())
            .field("cert_der_len", &self.cert_der.len())
            .field("key_pem", &"<redacted>")
            .field("chain_pem_len", &self.chain_pem.len())
            .field("fingerprint_sha256", &self.fingerprint_sha256)
            .field("not_before", &self.not_before)
            .field("not_after", &self.not_after)
            .finish()
    }
}

/// Result of [`CaManager::rotate_intermediate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationResult {
    pub old_generation: u32,
    pub new_generation: u32,
    pub old_fingerprint_sha256: String,
    pub new_fingerprint_sha256: String,
}

/// Two-phase root rotation handle.
///
/// [`CaManager::prepare_root_rotation`] writes a fresh root/intermediate pair
/// under `roots/{next_root}` and `intermediates/{next_intermediate}` and returns
/// this plan without moving the state pointer. [`CaManager::activate_root_rotation`]
/// validates the plan against the on-disk generations and then switches the
/// active chain. Both old generations are always retained for rollback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRotationPlan {
    pub old_root_generation: u32,
    pub new_root_generation: u32,
    pub new_intermediate_generation: u32,
    pub old_root_fingerprint_sha256: String,
    pub new_root_fingerprint_sha256: String,
    pub new_intermediate_fingerprint_sha256: String,
}

/// Facade over the on-disk CA. The clock is injectable so validity and
/// rotation-threshold behavior is testable without sleeping.
///
/// One CA root per process: every mutating method acquires the process-wide
/// operation lock (`CA_OPERATION_LOCK`), so operations serialize globally even
/// across manager instances. This type holds no operation mutex of its own.
pub struct CaManager {
    paths: CaPaths,
    clock: Arc<dyn Fn() -> OffsetDateTime + Send + Sync>,
}

impl CaManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            paths: CaPaths::new(root),
            clock: Arc::new(OffsetDateTime::now_utc),
        }
    }

    pub fn with_clock(root: PathBuf, clock: Arc<dyn Fn() -> OffsetDateTime + Send + Sync>) -> Self {
        Self {
            paths: CaPaths::new(root),
            clock,
        }
    }

    /// Acquire the process-wide operation lock. Poisoning means a previous
    /// mutating operation panicked while mid-commit; the CA must not be driven
    /// further without explicit recovery, so it is reported with the
    /// state-corrupt code instead of a panic. The guard covers the whole method
    /// body, including state commit and the post-commit audit append.
    fn lock_operations() -> CaResult<MutexGuard<'static, ()>> {
        CA_OPERATION_LOCK
            .lock()
            .map_err(|_| CaError::CorruptState("CA operation lock poisoned"))
    }

    /// Create root generation 1, intermediate generation 1 and the state
    /// pointer. Existing state is never regenerated; leftover generation
    /// directories without state are reported as partial initialization and
    /// must be repaired explicitly (out of scope for this slice).
    ///
    /// # Post-commit audit failures
    ///
    /// The state pointer is committed before the `ca.initialize` audit event is
    /// appended. If the append fails, the error is returned (never swallowed),
    /// but the CA is already fully initialized: [`Self::status`] is
    /// authoritative and succeeds. Callers must treat the returned error as an
    /// audit/observability failure, record it, and keep using the CA. Retrying
    /// [`Self::initialize`] reports `ca-already-initialized` by design.
    pub fn initialize(&self) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        match storage::load_state(&self.paths) {
            Ok(_) => return Err(CaError::AlreadyInitialized),
            Err(CaError::NotInitialized) => {}
            Err(err) => return Err(err),
        }
        if self.paths.root_dir().join("roots").exists()
            || self.paths.root_dir().join("intermediates").exists()
        {
            return Err(CaError::PartialInitialization);
        }

        let now = (self.clock)();
        let now_unix = now.unix_timestamp();
        // Root-down: establish the CA root ACL before creating any descendant.
        acl::ensure_private_dir(self.paths.root_dir())?;

        let root = crypto::generate_root(now)?;
        crypto::verify_ca_signature(&root.cert_der, &root.cert_der)
            .map_err(|_| CaError::CorruptState("generated root self-signature"))?;
        let root_meta = generation_meta(CaRole::Root, 1, &root.cert_der, now_unix, None)?;
        storage::write_generation(
            &self.paths,
            &self.paths.root_generation_dir(1),
            &root.key_pem,
            &root.cert_pem,
            &root_meta,
        )?;

        // The root is on disk from here on. Any later failure leaves a
        // recoverable partial state and must not delete the root generation.
        let result = (|| -> CaResult<()> {
            let intermediate = crypto::generate_intermediate(&root.key_pem, &root.cert_pem, now)?;
            let intermediate_meta = generation_meta(
                CaRole::Intermediate,
                1,
                &intermediate.cert_der,
                now_unix,
                Some(1),
            )?;
            storage::write_generation(
                &self.paths,
                &self.paths.intermediate_generation_dir(1),
                &intermediate.key_pem,
                &intermediate.cert_pem,
                &intermediate_meta,
            )?;
            crypto::verify_ca_signature(&root.cert_der, &intermediate.cert_der)
                .map_err(|_| CaError::CorruptState("root/intermediate signature"))?;
            storage::store_state_atomic(
                &self.paths,
                &storage::CaState {
                    schema: CA_SCHEMA,
                    active_root: 1,
                    active_intermediate: 1,
                    next_root: 2,
                    next_intermediate: 2,
                    created_at: now_unix,
                    updated_at: now_unix,
                },
            )?;
            Ok(())
        })();
        if result.is_err() {
            return Err(CaError::PartialInitialization);
        }

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: now_unix,
                event: "ca.initialize",
                result: "ok",
                root_generation: 1,
                intermediate_generation: 1,
                fingerprint: Some(root_meta.fingerprint_sha256.as_str()),
                previous_fingerprint: None,
            },
        )?;
        Ok(())
    }

    /// Read public certificates and metadata, verify the chain and the CA
    /// extension policy, and report remaining validity. The complete ACL audit
    /// ([`Self::verify_acl`]) runs first, so the CA root and its `roots/` and
    /// `intermediates/` parents are covered, not only the active generation.
    /// Private key material is never read here; only the key file ACL and
    /// read-only state are checked.
    pub fn status(&self) -> CaResult<CaStatus> {
        self.verify_acl()?;
        let root = storage::read_active_root_public(&self.paths)?;
        let intermediate = storage::read_active_intermediate_public(&self.paths)?;

        // webpki treats the trust anchor as trusted, so these checks cannot be
        // delegated to chain verification and are asserted explicitly.
        crypto::validate_ca_extensions(&root.info, CaRole::Root)?;
        crypto::validate_ca_extensions(&intermediate.info, CaRole::Intermediate)?;
        if root.info.subject != root.info.issuer {
            return Err(CaError::CorruptState("root is not self-signed"));
        }
        if intermediate.info.issuer != root.info.subject {
            return Err(CaError::CorruptState("intermediate issuer"));
        }
        if intermediate.meta.issuer_root_generation != Some(root.generation) {
            return Err(CaError::CorruptState("intermediate issuer generation"));
        }
        crypto::verify_ca_signature(&root.cert_der, &root.cert_der)
            .map_err(|_| CaError::CorruptState("root self-signature"))?;
        crypto::verify_ca_signature(&root.cert_der, &intermediate.cert_der)
            .map_err(|_| CaError::CorruptState("root/intermediate signature"))?;

        let now_unix = (self.clock)().unix_timestamp();
        let root_days_remaining = (root.info.not_after - now_unix).div_euclid(86_400);
        let intermediate_days_remaining =
            (intermediate.info.not_after - now_unix).div_euclid(86_400);
        Ok(CaStatus {
            root_generation: root.generation,
            intermediate_generation: intermediate.generation,
            root_fingerprint_sha256: root.info.fingerprint_sha256.clone(),
            intermediate_fingerprint_sha256: intermediate.info.fingerprint_sha256.clone(),
            root_not_after: root.info.not_after,
            intermediate_not_after: intermediate.info.not_after,
            root_days_remaining,
            intermediate_days_remaining,
            needs_root_rotation: root_days_remaining < 365,
            needs_intermediate_rotation: intermediate_days_remaining < 30,
        })
    }

    /// Issue an in-memory leaf for `moyu.local` plus 1–8 RFC1918 IPv4 SANs.
    ///
    /// The leaf must chain to the **currently valid** active root and
    /// intermediate. Refusing an expired or not-yet-valid chain here prevents
    /// handing a TLS listener material that every client would reject.
    ///
    /// Both issuers must also have at least 30 days of validity left. A
    /// 30-day leaf signed by an issuer about to expire would outlive its
    /// chain; rotate the intermediate or root first instead.
    ///
    /// All mutating operations are serialized by the process-wide CA
    /// operation lock (one CA root per process; operations serialize globally).
    ///
    /// Only the active intermediate private key is loaded, and only for the
    /// signing call; it is zeroized before chain verification. The leaf private
    /// key is never written to disk: no `leaves/` directory, state or database
    /// entry is created. The audit event carries only the leaf fingerprint and
    /// the active generation numbers; if that append fails, the error is
    /// returned before the leaf material is handed to the caller.
    pub fn issue_leaf(&self, dns: &str, ips: &[Ipv4Addr]) -> CaResult<LeafMaterial> {
        let _guard = Self::lock_operations()?;
        if dns != LEAF_DNS {
            return Err(CaError::InvalidLeafName);
        }
        validate_leaf_ips(ips)?;

        // Full active-chain and ACL validation, the same checks `status`
        // exposes; issuance must not trust a silently loosened CA. `status`
        // never takes the operation lock, so calling it here cannot deadlock.
        self.status()?;
        let root = storage::read_active_root_public(&self.paths)?;
        let intermediate = storage::read_active_intermediate_public(&self.paths)?;

        let now = (self.clock)();
        let now_unix = now.unix_timestamp();
        // Expiry first (stable `ca-expired`), then the minimum-validity gate.
        require_current_validity(&root.info, now_unix)?;
        require_current_validity(&intermediate.info, now_unix)?;
        require_days_remaining(root.info.not_after, now_unix, MIN_LEAF_ISSUER_DAYS)?;
        require_days_remaining(intermediate.info.not_after, now_unix, MIN_LEAF_ISSUER_DAYS)?;

        let intermediate_key = storage::read_active_intermediate_key(&self.paths)?;
        let leaf = crypto::generate_leaf(&intermediate_key, &intermediate.cert_pem, dns, ips, now)?;
        drop(intermediate_key);

        // Verify every SAN against the complete active chain. A leaf that
        // clients would reject is never returned, and the intermediate itself
        // is authenticated by the root during this check.
        let server_name = ServerName::try_from(dns).map_err(|_| CaError::InvalidLeafName)?;
        crypto::verify_chain(
            &root.cert_der,
            &intermediate.cert_der,
            &leaf.cert_der,
            &server_name,
            now_unix,
        )?;
        for ip in ips {
            let ip_name = ServerName::IpAddress(IpAddr::V4(*ip).into());
            crypto::verify_chain(
                &root.cert_der,
                &intermediate.cert_der,
                &leaf.cert_der,
                &ip_name,
                now_unix,
            )?;
        }
        if !crypto::key_matches_cert(&leaf.key_pem, &leaf.cert_der)? {
            return Err(CaError::KeyMismatch);
        }

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: now_unix,
                event: "ca.issue.leaf",
                result: "ok",
                root_generation: root.generation,
                intermediate_generation: intermediate.generation,
                fingerprint: Some(leaf.fingerprint_sha256.as_str()),
                previous_fingerprint: None,
            },
        )?;

        Ok(LeafMaterial {
            cert_pem: leaf.cert_pem,
            cert_der: leaf.cert_der,
            key_pem: leaf.key_pem,
            chain_pem: leaf.chain_pem,
            fingerprint_sha256: leaf.fingerprint_sha256,
            not_before: leaf.not_before,
            not_after: leaf.not_after,
        })
    }

    /// Rotate the issuing intermediate under the active root.
    ///
    /// Only the **active root** must be currently valid. The active
    /// intermediate may be expired or not yet valid: rotation is the recovery
    /// path for an expired issuing CA whose root is still trusted. The root
    /// must also have at least 180 days left, because the replacement
    /// intermediate lives 180 days and must not outlive its issuer; rotate the
    /// root first when this gate fires (`ca-insufficient-validity`). The
    /// replacement is validated for current validity after issuance, before it
    /// is published.
    ///
    /// The active root private key is loaded only for this operation. The new
    /// intermediate is written as `intermediates/{next_intermediate:04}`,
    /// verified (CA extensions, root signature, key/cert match, and a generated
    /// leaf probe for both DNS and a private IPv4 SAN), and published with an
    /// atomic state update. If the state commit fails and the pointer is not
    /// demonstrably committed to the new generation, this call's new
    /// intermediate directory is removed (cleanup errors are propagated); a
    /// committed-but-unhealthy pointer keeps it. The old generation is retained
    /// untouched until [`Self::retire_intermediate`] is called explicitly; the
    /// 7-day rollback window is an operational policy and is not timed here.
    ///
    /// No leaf is issued as part of rotation. Mutating operations are
    /// serialized by the process-wide CA operation lock (one CA root per
    /// process; operations serialize globally).
    ///
    /// # Post-commit audit failures
    ///
    /// The state pointer is committed before the `ca.rotate.intermediate`
    /// event is appended. If the append fails, the error is returned (never
    /// swallowed) but the rotation is already active: [`Self::status`] reports
    /// the new generation. Callers must record the audit failure and keep using
    /// the CA.
    pub fn rotate_intermediate(&self) -> CaResult<RotationResult> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        // Verify the full active chain and ACLs before signing anything.
        self.status()?;
        let root = storage::read_active_root_public(&self.paths)?;
        let intermediate = storage::read_active_intermediate_public(&self.paths)?;
        if root.generation != state.active_root
            || intermediate.generation != state.active_intermediate
        {
            return Err(CaError::CorruptState("active generation changed"));
        }

        let now = (self.clock)();
        let now_unix = now.unix_timestamp();
        // Recovery path: only the root must be current. An expired or
        // not-yet-valid active intermediate is exactly the state rotation
        // repairs, so it is deliberately not gated here. The replacement is
        // checked for current validity below before it is published.
        require_current_validity(&root.info, now_unix)?;
        // A 180-day replacement must not outlive the root that signs it. The
        // expired gate runs first so an expired root stays `ca-expired`.
        require_days_remaining(root.info.not_after, now_unix, MIN_ROOT_ROTATION_DAYS)?;

        let new_generation = state.next_intermediate;
        let next_generation = new_generation
            .checked_add(1)
            .ok_or(CaError::CorruptState("state next generation"))?;
        let new_dir = self.paths.intermediate_generation_dir(new_generation);

        let root_key = storage::read_active_root_key(&self.paths)?;
        let generated = crypto::generate_intermediate(&root_key, &root.cert_pem, now)?;
        drop(root_key);

        crypto::verify_ca_signature(&root.cert_der, &generated.cert_der)
            .map_err(|_| CaError::CorruptState("root/new intermediate signature"))?;
        if !crypto::key_matches_cert(&generated.key_pem, &generated.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        let meta = generation_meta(
            CaRole::Intermediate,
            new_generation,
            &generated.cert_der,
            now_unix,
            Some(root.generation),
        )?;
        // The replaced intermediate may have been expired; the replacement
        // must itself be current at this instant before it can go live.
        require_current_validity_range(meta.not_before, meta.not_after, now_unix)?;
        // Generated issuance probe before anything is written: the fresh
        // intermediate must chain from the active root for both the DNS name
        // and a private IPv4 SAN (name constraints, path length, EKU).
        verify_issuance_probe(
            &self.paths,
            &root.cert_der,
            &generated.cert_der,
            &generated.key_pem,
            &generated.cert_pem,
            now,
        )?;
        storage::write_generation(
            &self.paths,
            &new_dir,
            &generated.key_pem,
            &generated.cert_pem,
            &meta,
        )?;

        let mut next_state = state;
        next_state.active_intermediate = new_generation;
        next_state.next_intermediate = next_generation;
        // Timestamps are informational: a backward system clock must not
        // produce a state the validator refuses to load.
        next_state.updated_at = now_unix.max(next_state.created_at);
        if let Err(err) = storage::store_state_atomic(&self.paths, &next_state) {
            // `store_state_atomic` replaces the state file before re-verifying
            // the destination ACL. If the pointer is not demonstrably committed
            // to the new generation, this call's orphan must not block a later
            // rotation; cleanup failures take precedence over the original
            // error. A committed-but-unhealthy pointer keeps the generation.
            if storage::state_points_at(&self.paths, root.generation, new_generation) {
                return Err(err);
            }
            return Err(match acl::force_remove_dir_all(&new_dir) {
                Ok(()) => err,
                Err(cleanup_err) => cleanup_err,
            });
        }

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: now_unix,
                event: "ca.rotate.intermediate",
                result: "ok",
                root_generation: root.generation,
                intermediate_generation: new_generation,
                fingerprint: Some(meta.fingerprint_sha256.as_str()),
                previous_fingerprint: Some(intermediate.info.fingerprint_sha256.as_str()),
            },
        )?;

        Ok(RotationResult {
            old_generation: intermediate.generation,
            new_generation,
            old_fingerprint_sha256: intermediate.info.fingerprint_sha256,
            new_fingerprint_sha256: meta.fingerprint_sha256,
        })
    }

    /// Remove an inactive intermediate generation.
    ///
    /// `confirm_fingerprint` must exactly match the generation's `meta.json`
    /// fingerprint, and the generation must not be the active intermediate.
    /// Deletion uses [`acl::force_remove_dir_all`], which re-grants a writable
    /// ACL/clears read-only before removing private keys, and errors are
    /// propagated. Active and root generations are never touched.
    ///
    /// The 7-day rollback window is an operational rule; this method adds no
    /// timer and does not decide when retirement is safe. Mutating operations
    /// are serialized by the process-wide CA operation lock (one CA root per
    /// process; operations serialize globally).
    ///
    /// The audit event records the **retired generation's** issuer root
    /// generation (from its `meta.json`), not the latest active root, so the
    /// event stays correct after a root rotation.
    ///
    /// # Post-commit audit failures
    ///
    /// The directory is removed before the `ca.retire.intermediate` event is
    /// appended. If the append fails, the error is returned but the generation
    /// is already gone. Retrying the same call reports the missing generation;
    /// callers must record the audit failure instead of treating retirement as
    /// rolled back.
    pub fn retire_intermediate(&self, generation: u32, confirm_fingerprint: &str) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        if generation == 0 {
            return Err(CaError::CorruptState("intermediate generation number"));
        }
        // Read the exact generation through the ACL/meta/certificate checks
        // used by the active readers; never delete a directory based on a path
        // alone.
        let retired = storage::read_intermediate_public(&self.paths, generation)?;
        if confirm_fingerprint != retired.info.fingerprint_sha256.as_str() {
            return Err(CaError::FingerprintMismatch);
        }
        if generation == state.active_intermediate {
            return Err(CaError::NotActive);
        }
        // Re-read the pointer right before deletion so a concurrent rotation
        // cannot turn the confirmed inactive generation into the active one.
        let latest = storage::load_state(&self.paths)?;
        if generation == latest.active_intermediate {
            return Err(CaError::NotActive);
        }
        // The issuer root is a historical fact stored with the generation; the
        // active root may already be a newer generation after a root rotation.
        let issuer_root = retired
            .meta
            .issuer_root_generation
            .ok_or(CaError::CorruptState("intermediate issuer generation"))?;

        acl::force_remove_dir_all(&self.paths.intermediate_generation_dir(generation))?;

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: (self.clock)().unix_timestamp(),
                event: "ca.retire.intermediate",
                result: "ok",
                root_generation: issuer_root,
                intermediate_generation: generation,
                fingerprint: Some(retired.info.fingerprint_sha256.as_str()),
                previous_fingerprint: None,
            },
        )?;
        Ok(())
    }

    /// Stage a fresh root/intermediate pair for a two-phase root rotation.
    ///
    /// The old root does **not** need to be currently valid: root rotation is
    /// the recovery path after root expiry. The new pair is generated and
    /// validated (CA extensions, self-signature, root→intermediate signature,
    /// key/cert match, and a throwaway name-constraint probe chain), written to
    /// `roots/{next_root}` and `intermediates/{next_intermediate}`, and left
    /// pending. `state.json` is not modified, so the active chain and both next
    /// generation numbers stay put until [`Self::activate_root_rotation`].
    ///
    /// Calling prepare again while the pending directories exist is
    /// idempotent: it re-validates the stored pair (including key/cert match)
    /// and returns the same plan without generating a second pair. A partial
    /// pending pair is reported as `ca-state-corrupt`.
    ///
    /// The event records generations and fingerprints only. If the event
    /// append fails after the pair was written, the error is returned but the
    /// pending pair remains; a retry is idempotent.
    pub fn prepare_root_rotation(&self) -> CaResult<RootRotationPlan> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        // Full active-chain and ACL audit. `status` never checks validity, so
        // an expired old root does not block the recovery path.
        self.status()?;
        let old_root = storage::read_active_root_public(&self.paths)?;
        if old_root.generation != state.active_root {
            return Err(CaError::CorruptState("active root generation"));
        }
        let new_root_generation = state.next_root;
        let new_intermediate_generation = state.next_intermediate;
        let root_dir = self.paths.root_generation_dir(new_root_generation);
        let intermediate_dir = self
            .paths
            .intermediate_generation_dir(new_intermediate_generation);

        match (root_dir.exists(), intermediate_dir.exists()) {
            (true, true) => {
                // Idempotent retry: reuse the pending pair instead of creating
                // a second one. Validate it exactly as activation would.
                let new_root = storage::read_root_public(&self.paths, new_root_generation)?;
                let new_intermediate =
                    storage::read_intermediate_public(&self.paths, new_intermediate_generation)?;
                verify_root_rotation_pair(&new_root, &new_intermediate)?;
                let root_key = storage::read_root_generation_key(&self.paths, new_root_generation)?;
                if !crypto::key_matches_cert(&root_key, &new_root.cert_der)? {
                    return Err(CaError::KeyMismatch);
                }
                drop(root_key);
                let intermediate_key = storage::read_intermediate_generation_key(
                    &self.paths,
                    new_intermediate_generation,
                )?;
                if !crypto::key_matches_cert(&intermediate_key, &new_intermediate.cert_der)? {
                    return Err(CaError::KeyMismatch);
                }
                drop(intermediate_key);
                Ok(RootRotationPlan {
                    old_root_generation: old_root.generation,
                    new_root_generation,
                    new_intermediate_generation,
                    old_root_fingerprint_sha256: old_root.info.fingerprint_sha256,
                    new_root_fingerprint_sha256: new_root.info.fingerprint_sha256,
                    new_intermediate_fingerprint_sha256: new_intermediate.info.fingerprint_sha256,
                })
            }
            (false, false) => self.generate_root_rotation_plan(
                &old_root,
                new_root_generation,
                new_intermediate_generation,
            ),
            _ => Err(CaError::CorruptState("pending root rotation is incomplete")),
        }
    }

    /// Generate, validate and write a fresh pending root/intermediate pair.
    /// Never touches `state.json`; the caller holds the operation lock.
    fn generate_root_rotation_plan(
        &self,
        old_root: &storage::ActiveGeneration,
        new_root_generation: u32,
        new_intermediate_generation: u32,
    ) -> CaResult<RootRotationPlan> {
        let now = (self.clock)();
        let now_unix = now.unix_timestamp();

        let new_root = crypto::generate_root(now)?;
        crypto::verify_ca_signature(&new_root.cert_der, &new_root.cert_der)
            .map_err(|_| CaError::CorruptState("generated root self-signature"))?;
        if !crypto::key_matches_cert(&new_root.key_pem, &new_root.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        let root_meta = generation_meta(
            CaRole::Root,
            new_root_generation,
            &new_root.cert_der,
            now_unix,
            None,
        )?;

        let new_intermediate =
            crypto::generate_intermediate(&new_root.key_pem, &new_root.cert_pem, now)?;
        crypto::verify_ca_signature(&new_root.cert_der, &new_intermediate.cert_der)
            .map_err(|_| CaError::CorruptState("new root/intermediate signature"))?;
        if !crypto::key_matches_cert(&new_intermediate.key_pem, &new_intermediate.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        let root_info = crypto::parse_cert_der(&new_root.cert_der)?;
        let intermediate_info = crypto::parse_cert_der(&new_intermediate.cert_der)?;
        if intermediate_info.issuer != root_info.subject {
            return Err(CaError::CorruptState("new intermediate issuer"));
        }
        let intermediate_meta = generation_meta(
            CaRole::Intermediate,
            new_intermediate_generation,
            &new_intermediate.cert_der,
            now_unix,
            Some(new_root_generation),
        )?;

        // Generated name-constraint probe: before the pair is published, a
        // throwaway leaf must chain from the new root through the new
        // intermediate for both the DNS name and a private IPv4 SAN.
        verify_issuance_probe(
            &self.paths,
            &new_root.cert_der,
            &new_intermediate.cert_der,
            &new_intermediate.key_pem,
            &new_intermediate.cert_pem,
            now,
        )?;

        let root_dir = self.paths.root_generation_dir(new_root_generation);
        storage::write_generation(
            &self.paths,
            &root_dir,
            &new_root.key_pem,
            &new_root.cert_pem,
            &root_meta,
        )?;
        let intermediate_dir = self
            .paths
            .intermediate_generation_dir(new_intermediate_generation);
        if let Err(err) = storage::write_generation(
            &self.paths,
            &intermediate_dir,
            &new_intermediate.key_pem,
            &new_intermediate.cert_pem,
            &intermediate_meta,
        ) {
            // The new root was created by this call and is not referenced by
            // any state; remove it so a failed prepare leaves no partial
            // pending pair. A removal failure is secondary to the original
            // error.
            let _ = acl::force_remove_dir_all(&root_dir);
            return Err(err);
        }

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: now_unix,
                event: "ca.prepare.root_rotation",
                result: "ok",
                root_generation: new_root_generation,
                intermediate_generation: new_intermediate_generation,
                fingerprint: Some(root_meta.fingerprint_sha256.as_str()),
                previous_fingerprint: Some(old_root.info.fingerprint_sha256.as_str()),
            },
        )?;

        Ok(RootRotationPlan {
            old_root_generation: old_root.generation,
            new_root_generation,
            new_intermediate_generation,
            old_root_fingerprint_sha256: old_root.info.fingerprint_sha256.clone(),
            new_root_fingerprint_sha256: root_meta.fingerprint_sha256,
            new_intermediate_fingerprint_sha256: intermediate_meta.fingerprint_sha256,
        })
    }

    /// Activate a plan produced by [`Self::prepare_root_rotation`].
    ///
    /// The plan must still describe the pending pair: `state.active_root` must
    /// equal the plan's old root, and the plan's new generation numbers must
    /// match `next_root`/`next_intermediate`. The on-disk generations are
    /// re-read and their fingerprints must match the plan. A plan applied once
    /// (or superseded) is refused with `ca-state-corrupt` and no state change.
    ///
    /// Before the pointer moves, the pending root must be self-signed
    /// (`subject == issuer` and a verifiable self-signature), both pending
    /// private keys must match their certificates, and the generated DNS/IP
    /// leaf probe must chain from the pending pair. The state pointer is
    /// switched atomically only after those checks. The old root and
    /// intermediate directories are **never** deleted here; retire them
    /// explicitly after the rollback window. The new pair must still be current
    /// at activation.
    ///
    /// # Post-commit audit failures
    ///
    /// The state pointer is committed before the `ca.activate.root_rotation`
    /// event is appended. If the append fails, the error is returned but the
    /// new chain is already active; callers must record the audit failure and
    /// keep using the CA.
    pub fn activate_root_rotation(&self, plan: &RootRotationPlan) -> CaResult<CaStatus> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        // A stale plan (typically a second activation) no longer matches the
        // state pointer or the pending generation numbers.
        if state.active_root != plan.old_root_generation
            || state.next_root != plan.new_root_generation
            || state.next_intermediate != plan.new_intermediate_generation
        {
            return Err(CaError::CorruptState("root rotation plan is stale"));
        }
        let old_root = storage::read_active_root_public(&self.paths)?;
        if old_root.info.fingerprint_sha256 != plan.old_root_fingerprint_sha256 {
            return Err(CaError::CorruptState(
                "root rotation plan old root fingerprint",
            ));
        }
        let new_root = storage::read_root_public(&self.paths, plan.new_root_generation)?;
        let new_intermediate =
            storage::read_intermediate_public(&self.paths, plan.new_intermediate_generation)?;
        if new_root.info.fingerprint_sha256 != plan.new_root_fingerprint_sha256
            || new_intermediate.info.fingerprint_sha256 != plan.new_intermediate_fingerprint_sha256
        {
            return Err(CaError::CorruptState("root rotation plan fingerprints"));
        }
        // The pending root must be a genuine self-signed trust anchor, and both
        // pending private keys must match their certificates, before the pair
        // can become active. This is checked before any state write.
        verify_pending_root_self_signed(&new_root)?;
        let root_key = storage::read_root_generation_key(&self.paths, plan.new_root_generation)?;
        if !crypto::key_matches_cert(&root_key, &new_root.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        drop(root_key);
        let intermediate_key = storage::read_intermediate_generation_key(
            &self.paths,
            plan.new_intermediate_generation,
        )?;
        if !crypto::key_matches_cert(&intermediate_key, &new_intermediate.cert_der)? {
            return Err(CaError::KeyMismatch);
        }
        verify_root_rotation_pair(&new_root, &new_intermediate)?;

        let now = (self.clock)();
        let now_unix = now.unix_timestamp();
        // The staged pair must still be current; activating an expired pending
        // intermediate would publish an unusable chain.
        require_current_validity(&new_root.info, now_unix)?;
        require_current_validity(&new_intermediate.info, now_unix)?;
        // Re-run the generated leaf probe against the pair that is about to go
        // live. The pending key is already loaded for the key/cert check.
        verify_issuance_probe(
            &self.paths,
            &new_root.cert_der,
            &new_intermediate.cert_der,
            &intermediate_key,
            &new_intermediate.cert_pem,
            now,
        )?;
        drop(intermediate_key);

        let next_root = state.next_root.max(
            plan.new_root_generation
                .checked_add(1)
                .ok_or(CaError::CorruptState("root generation number"))?,
        );
        let next_intermediate = state.next_intermediate.max(
            plan.new_intermediate_generation
                .checked_add(1)
                .ok_or(CaError::CorruptState("intermediate generation number"))?,
        );

        let mut next_state = state;
        next_state.active_root = plan.new_root_generation;
        next_state.active_intermediate = plan.new_intermediate_generation;
        next_state.next_root = next_root;
        next_state.next_intermediate = next_intermediate;
        next_state.updated_at = now_unix.max(next_state.created_at);
        storage::store_state_atomic(&self.paths, &next_state)?;

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: now_unix,
                event: "ca.activate.root_rotation",
                result: "ok",
                root_generation: plan.new_root_generation,
                intermediate_generation: plan.new_intermediate_generation,
                fingerprint: Some(new_root.info.fingerprint_sha256.as_str()),
                previous_fingerprint: Some(old_root.info.fingerprint_sha256.as_str()),
            },
        )?;

        // `status` is lock-free, so it is safe to call while this operation
        // still holds the operation lock.
        self.status()
    }

    /// Remove an inactive root generation.
    ///
    /// `confirm_fingerprint` must exactly match the generation's `meta.json`
    /// fingerprint, and the generation must not be the active root. Deletion
    /// uses [`acl::force_remove_dir_all`], which re-grants a writable
    /// ACL/clears read-only before removing the private key, and errors are
    /// propagated.
    ///
    /// Intermediate generations signed by the retired root are **not** deleted
    /// automatically: retire each one explicitly after its leaves expire.
    /// Distributing trust anchors to client devices (and removing a retired
    /// root from their trust stores) is outside this module.
    ///
    /// The `ca.retire.root` event carries `intermediate_generation: 0`, which
    /// means "not applicable" for this operation.
    ///
    /// # Post-commit audit failures
    ///
    /// The directory is removed before the event is appended. If the append
    /// fails, the error is returned but the generation is already gone;
    /// callers must record the audit failure.
    pub fn retire_root(&self, generation: u32, confirm_fingerprint: &str) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        if generation == 0 {
            return Err(CaError::CorruptState("root generation number"));
        }
        let retired = storage::read_root_public(&self.paths, generation)?;
        if confirm_fingerprint != retired.info.fingerprint_sha256.as_str() {
            return Err(CaError::FingerprintMismatch);
        }
        if generation == state.active_root {
            return Err(CaError::NotActive);
        }
        // Re-read the pointer right before deletion so a concurrent activation
        // cannot turn the confirmed inactive root into the active one.
        let latest = storage::load_state(&self.paths)?;
        if generation == latest.active_root {
            return Err(CaError::NotActive);
        }

        acl::force_remove_dir_all(&self.paths.root_generation_dir(generation))?;

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: (self.clock)().unix_timestamp(),
                event: "ca.retire.root",
                result: "ok",
                root_generation: generation,
                intermediate_generation: 0,
                fingerprint: Some(retired.info.fingerprint_sha256.as_str()),
                previous_fingerprint: None,
            },
        )?;
        Ok(())
    }

    /// Discard a pending root-rotation pair produced by
    /// [`Self::prepare_root_rotation`] without activating it.
    ///
    /// This is the recovery path for a stale pending pair (for example, one
    /// that sat past the staged intermediate's validity). Under the
    /// process-wide operation lock, the state pointer is loaded and the call is
    /// refused if the pending root or pending intermediate is currently active.
    /// The plan must still describe the current pending pair
    /// (`active_root == old_root_generation`, `next_root == new_root_generation`,
    /// `next_intermediate == new_intermediate_generation`); a superseded plan is
    /// never allowed to delete generations that later became active and are now
    /// retained. Both plan fingerprints must also match the on-disk generation
    /// metadata before anything is removed, so a forged plan cannot delete a
    /// different pair.
    ///
    /// Remaining generations are validated first, then the pending
    /// intermediate is force-removed before the pending root. If one side is
    /// already gone (an interrupted earlier discard), the remaining side is
    /// still removed; a retry after full success is a no-op. `state.json` is
    /// never modified, so the active chain and both next generation numbers
    /// stay put.
    ///
    /// The `ca.discard.root_rotation` event records the discarded generations
    /// and both fingerprints (new root as `fingerprint`, new intermediate as
    /// `previous_fingerprint`) and nothing else. It is appended after removal;
    /// if the append fails, the pair is already gone and the error is returned
    /// (callers must record the audit failure).
    pub fn discard_pending_root_rotation(&self, plan: &RootRotationPlan) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        if plan.new_root_generation == state.active_root
            || plan.new_intermediate_generation == state.active_intermediate
        {
            return Err(CaError::CorruptState("pending root rotation is active"));
        }
        // Only the current pending pair may be discarded. Without this check a
        // superseded plan could delete generations that were activated and are
        // now retained trust history for rollback.
        if state.active_root != plan.old_root_generation
            || state.next_root != plan.new_root_generation
            || state.next_intermediate != plan.new_intermediate_generation
        {
            return Err(CaError::CorruptState("root rotation plan is stale"));
        }

        let root_dir = self.paths.root_generation_dir(plan.new_root_generation);
        let intermediate_dir = self
            .paths
            .intermediate_generation_dir(plan.new_intermediate_generation);
        let root_exists = root_dir.exists();
        let intermediate_exists = intermediate_dir.exists();
        if !root_exists && !intermediate_exists {
            // Already discarded (or never staged): idempotent no-op.
            return Ok(());
        }

        // Validate every remaining generation before deleting anything, so a
        // fingerprint mismatch can never leave a half-removed pair.
        if root_exists {
            let root = storage::read_root_public(&self.paths, plan.new_root_generation)?;
            if root.info.fingerprint_sha256 != plan.new_root_fingerprint_sha256 {
                return Err(CaError::FingerprintMismatch);
            }
        }
        if intermediate_exists {
            let intermediate =
                storage::read_intermediate_public(&self.paths, plan.new_intermediate_generation)?;
            if intermediate.info.fingerprint_sha256 != plan.new_intermediate_fingerprint_sha256 {
                return Err(CaError::FingerprintMismatch);
            }
        }

        if intermediate_exists {
            acl::force_remove_dir_all(&intermediate_dir)?;
        }
        if root_exists {
            acl::force_remove_dir_all(&root_dir)?;
        }

        storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: (self.clock)().unix_timestamp(),
                event: "ca.discard.root_rotation",
                result: "ok",
                root_generation: plan.new_root_generation,
                intermediate_generation: plan.new_intermediate_generation,
                fingerprint: Some(plan.new_root_fingerprint_sha256.as_str()),
                previous_fingerprint: Some(plan.new_intermediate_fingerprint_sha256.as_str()),
            },
        )?;
        Ok(())
    }

    /// Destroy the entire CA root after fingerprint confirmation.
    ///
    /// The active root fingerprint must match `confirm_root_fingerprint`
    /// exactly. A mismatch returns `ca-destroy-confirmation-mismatch` and
    /// leaves every file intact. After confirmation the complete CA root
    /// directory is removed with [`acl::force_remove_dir_all`] (re-grants a
    /// writable ACL / clears read-only attributes, never follows reparse
    /// points), and errors are propagated.
    ///
    /// This removes all active, retained and pending generations,
    /// `state.json`, the audit log and transient staging. User-exported backup
    /// files live outside the CA root and are deliberately not touched; the
    /// user must destroy them separately. A best-effort `ca.destroy` event is
    /// appended before deletion and never blocks the destroy.
    ///
    /// After success [`Self::status`] returns `ca-not-initialized`.
    pub fn destroy(&self, confirm_root_fingerprint: &str) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        let state = storage::load_state(&self.paths)?;
        let root = storage::read_root_public(&self.paths, state.active_root)?;
        if confirm_root_fingerprint != root.info.fingerprint_sha256.as_str() {
            return Err(CaError::DestroyConfirmationMismatch);
        }

        // Audit intent before removal. This must not fail the destroy: after
        // deletion there is no CA left whose audit log could be repaired.
        let _ = storage::append_event(
            &self.paths,
            &storage::CaEvent {
                ts: (self.clock)().unix_timestamp(),
                event: "ca.destroy",
                result: "ok",
                root_generation: state.active_root,
                intermediate_generation: state.active_intermediate,
                fingerprint: Some(root.info.fingerprint_sha256.as_str()),
                previous_fingerprint: None,
            },
        );
        acl::force_remove_dir_all(self.paths.root_dir())?;
        Ok(())
    }

    /// Export the active root key, certificate and metadata as an
    /// Argon2id + XChaCha20-Poly1305 container.
    ///
    /// Only the active root generation is exported; no intermediate private
    /// key ever enters the container. The destination must be outside the CA
    /// root (destroy removes that whole tree), and the private key, passphrase
    /// and path are never logged. Existing files are refused unless
    /// `overwrite` is set; overwrite stages a temp file next to the destination,
    /// fsyncs it and atomically replaces the target.
    ///
    /// This is read-only for the CA (apart from a non-sensitive
    /// `ca.export.backup` audit event) and acquires the process-wide operation
    /// lock, so the snapshot cannot race a root rotation (one CA root per
    /// process; operations serialize globally).
    ///
    /// No minimum passphrase length is enforced so existing containers can
    /// always be restored; callers should require a long, unique passphrase.
    pub fn export_backup(&self, path: &Path, passphrase: &str, overwrite: bool) -> CaResult<()> {
        let _guard = Self::lock_operations()?;
        backup::export_backup(&self.paths, path, passphrase, overwrite, (self.clock)())
    }

    /// Restore a root backup and generate a fresh intermediate under it.
    ///
    /// The container is decrypted and the imported root is validated (key/cert
    /// match, self-signature, current validity, **at least 180 days of
    /// remaining validity**, `CA:TRUE`, `pathLen=1`, `keyCertSign`+`cRLSign`,
    /// critical `basicConstraints`/`keyUsage`) before anything is written. A
    /// leaf, `pathLen=0` or near-expiry root is rejected and no intermediate
    /// private key is imported: the intermediate is always generated locally
    /// (180 days) from the imported root, so the remaining-validity floor
    /// guarantees it cannot outlive that root.
    ///
    /// Recovery semantics:
    ///
    /// - Valid state with `replace_existing=false` reports
    ///   `ca-already-initialized` before any file is read or written.
    /// - Valid state with `replace_existing=true` runs the full [`Self::status`]
    ///   audit (active chain **and every retained/pending generation ACL**)
    ///   before writing. A failing preflight aborts with the state
    ///   byte-identical; it is never downgraded to corrupt-state recovery.
    /// - Corrupt state, or missing state over leftover CA artifacts, requires
    ///   `replace_existing=true`. The entire existing CA root is atomically
    ///   renamed to a sibling `<ca-root>.quarantine-<nanos>` directory and a
    ///   clean generation pair 1/1 is imported. The old tree is preserved
    ///   outside the active root (and outside the ACL audit) for manual
    ///   inspection/removal; its exact path is not logged or returned. If the
    ///   rename fails, nothing changes.
    /// - A pristine CA root accepts a first restore at generations 1/1 without
    ///   `replace_existing`.
    ///
    /// The active state pointer is committed last. A failure before that
    /// removes the artifacts created by this call, restores a quarantined root
    /// and leaves a previous valid state byte-identical. If the state pointer
    /// is already visible when the commit reports an error, the referenced
    /// generations are deliberately left in place: the error is returned and
    /// the CA is "committed but unhealthy" (inspect [`Self::status`]/ACL).
    ///
    /// No minimum passphrase length is enforced so existing containers can
    /// always be restored; callers should require a long, unique passphrase.
    ///
    /// # Post-commit audit failures
    ///
    /// The state pointer is committed before the `ca.import.backup` event is
    /// appended. If the append fails, the error is returned (never swallowed)
    /// but the imported chain is already active; callers must record the audit
    /// failure and keep using the CA.
    pub fn import_backup(
        &self,
        path: &Path,
        passphrase: &str,
        replace_existing: bool,
    ) -> CaResult<CaStatus> {
        let _guard = Self::lock_operations()?;
        match storage::load_state(&self.paths) {
            Ok(_) if !replace_existing => return Err(CaError::AlreadyInitialized),
            Ok(_) => {
                // Full chain and retained-generation ACL preflight before any
                // write. A valid state with a broken retained tree is not
                // corrupt-state recovery material; importing over it would
                // otherwise commit and then fail the post-commit `status()`.
                self.status()?;
            }
            // Corrupt/missing state makes the preflight impossible; the
            // recovery path either quarantines with consent or returns the
            // original state error.
            Err(_) => {}
        }
        backup::import_backup(
            &self.paths,
            (self.clock)(),
            path,
            passphrase,
            replace_existing,
        )?;
        // `status` is lock-free, so it is safe to call while this operation
        // still holds the operation lock.
        self.status()
    }

    /// Audit every CA directory and file used by the active state **and every
    /// retained or pending generation**. Each object is inspected first (the
    /// observed report is consumed) and then verified by the platform policy,
    /// so a backend that silently stops checking a field cannot pass unnoticed.
    ///
    /// Rotation retains old roots/intermediates and `prepare_root_rotation`
    /// writes a pending pair; those directories still hold private keys, so
    /// auditing only the active pair would leave them unchecked. The rotated
    /// event log (`ca-events.jsonl.1`) is audited when present as well.
    pub fn verify_acl(&self) -> CaResult<()> {
        let state = storage::load_state(&self.paths)?;
        let root_dir = self.paths.root_dir();
        audit_dir(root_dir)?;
        let roots_dir = root_dir.join("roots");
        audit_dir(&roots_dir)?;
        let intermediates_dir = root_dir.join("intermediates");
        audit_dir(&intermediates_dir)?;
        audit_generation(&self.paths.root_generation_dir(state.active_root), "root")?;
        audit_generation(
            &self
                .paths
                .intermediate_generation_dir(state.active_intermediate),
            "intermediate",
        )?;
        audit_generation_set(&roots_dir, "root")?;
        audit_generation_set(&intermediates_dir, "intermediate")?;
        audit_file(&self.paths.state_file())?;
        let events_dir = root_dir.join("events");
        if events_dir.exists() {
            audit_dir(&events_dir)?;
        }
        let events_file = self.paths.events_file();
        if events_file.exists() {
            audit_file(&events_file)?;
        }
        let rotated_events = storage::rotated_event_path(&self.paths);
        if rotated_events.exists() {
            audit_file(&rotated_events)?;
        }
        let staging_root = root_dir.join("staging");
        if staging_root.exists() {
            audit_dir(&staging_root)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn paths_for_test(&self) -> &CaPaths {
        &self.paths
    }
}

/// Build the public metadata record for a newly generated certificate.
/// Reused by intermediate/root rotation in Tasks 5–6.
pub(crate) fn generation_meta(
    role: CaRole,
    generation: u32,
    cert_der: &[u8],
    created_at: i64,
    issuer_root_generation: Option<u32>,
) -> CaResult<storage::GenerationMeta> {
    if generation == 0 {
        return Err(CaError::CorruptState("generation number"));
    }
    let info = crypto::parse_cert_der(cert_der)?;
    crypto::validate_ca_extensions(&info, role)?;
    Ok(storage::GenerationMeta {
        schema: CA_SCHEMA,
        generation,
        fingerprint_sha256: info.fingerprint_sha256,
        subject: info.subject,
        not_before: info.not_before,
        not_after: info.not_after,
        created_at,
        issuer_root_generation,
    })
}

/// Leaf SANs cover LAN clients only. `Ipv4Addr::is_private()` admits exactly
/// 10/8, 172.16/12 and 192.168/16; the explicit exclusions reject the remaining
/// non-routable special-purpose ranges (and 255.255.255.255) with a stable
/// error instead of relying on that predicate alone. CGNAT, documentation and
/// other public/reserved ranges fail `is_private()`.
fn validate_leaf_ips(ips: &[Ipv4Addr]) -> CaResult<()> {
    if ips.is_empty() || ips.len() > MAX_LEAF_IPS {
        return Err(CaError::InvalidLeafIp);
    }
    for ip in ips {
        if ip.is_unspecified()
            || ip.is_loopback()
            || ip.is_link_local()
            || ip.is_multicast()
            || *ip == Ipv4Addr::BROADCAST
            || !ip.is_private()
        {
            return Err(CaError::InvalidLeafIp);
        }
    }
    Ok(())
}

/// Test-only queue of CA roots whose next issuance probe must fail. Keyed by
/// root path so parallel tests cannot consume each other's injected failure.
#[cfg(test)]
static FAIL_NEXT_PROBE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Arm a one-shot probe failure for `paths`. Test-only.
#[cfg(test)]
pub(crate) fn fail_next_probe(paths: &CaPaths) {
    FAIL_NEXT_PROBE
        .lock()
        .expect("probe failure queue")
        .push(paths.root_dir().to_path_buf());
}

#[cfg(test)]
fn take_injected_probe_failure(paths: &CaPaths) -> bool {
    let root_dir = paths.root_dir();
    let mut queue = FAIL_NEXT_PROBE.lock().expect("probe failure queue");
    match queue.iter().position(|candidate| *candidate == root_dir) {
        Some(index) => {
            queue.remove(index);
            true
        }
        None => false,
    }
}

#[cfg(not(test))]
fn take_injected_probe_failure(_paths: &CaPaths) -> bool {
    false
}

/// Generated issuance probe: a throwaway leaf must chain from `root` through
/// `intermediate` and be valid for both `moyu.local` and a private IPv4 SAN.
/// This exercises CA extensions, path length, name constraints and server-auth
/// EKU together without touching disk or the active chain.
///
/// `rotate_intermediate`, root-rotation prepare/activate and backup import all
/// run this after generating an intermediate and before publishing it.
fn verify_issuance_probe(
    paths: &CaPaths,
    root_der: &[u8],
    intermediate_der: &[u8],
    intermediate_key_pem: &str,
    intermediate_cert_pem: &str,
    now: OffsetDateTime,
) -> CaResult<()> {
    if take_injected_probe_failure(paths) {
        return Err(CaError::ChainVerification);
    }
    let probe = crypto::generate_leaf(
        intermediate_key_pem,
        intermediate_cert_pem,
        LEAF_DNS,
        &[PROBE_IP],
        now,
    )?;
    let now_unix = now.unix_timestamp();
    let dns_name = ServerName::try_from(LEAF_DNS).map_err(|_| CaError::InvalidLeafName)?;
    crypto::verify_chain(
        root_der,
        intermediate_der,
        &probe.cert_der,
        &dns_name,
        now_unix,
    )?;
    // Also verify the private IPv4 SAN, so the intermediate's IP name
    // constraints are exercised rather than only the DNS subtree.
    let ip_name = ServerName::IpAddress(IpAddr::V4(PROBE_IP).into());
    crypto::verify_chain(
        root_der,
        intermediate_der,
        &probe.cert_der,
        &ip_name,
        now_unix,
    )?;
    drop(probe);
    Ok(())
}

/// A pending root must be a self-signed CA (subject == issuer and a signature
/// that verifies under its own key) before activation can trust it.
fn verify_pending_root_self_signed(root: &storage::ActiveGeneration) -> CaResult<()> {
    if root.info.subject != root.info.issuer {
        return Err(CaError::CorruptState("pending root is not self-signed"));
    }
    crypto::verify_ca_signature(&root.cert_der, &root.cert_der)
        .map_err(|_| CaError::CorruptState("pending root self-signature"))?;
    Ok(())
}

/// Verify that `intermediate` is the CA directly signed by `root`. Used by
/// root rotation for freshly generated and already pending pairs.
fn verify_root_rotation_pair(
    root: &storage::ActiveGeneration,
    intermediate: &storage::ActiveGeneration,
) -> CaResult<()> {
    if intermediate.meta.issuer_root_generation != Some(root.generation) {
        return Err(CaError::CorruptState("new intermediate issuer generation"));
    }
    if intermediate.info.issuer != root.info.subject {
        return Err(CaError::CorruptState("new intermediate issuer"));
    }
    crypto::verify_ca_signature(&root.cert_der, &intermediate.cert_der)
        .map_err(|_| CaError::CorruptState("new root/intermediate signature"))?;
    Ok(())
}

/// Expiry gate for a single certificate at `now` (inclusive bounds).
///
/// Leaf issuance applies it to both the active root and intermediate: a chain
/// clients would reject must not sign a leaf. Rotation applies it only to the
/// root, because an expired intermediate is what rotation repairs. Failures use
/// the stable `ca-expired` code.
fn require_current_validity(info: &CertInfo, now_unix: i64) -> CaResult<()> {
    require_current_validity_range(info.not_before, info.not_after, now_unix)
}

/// Minimum-remaining-validity gate, applied after [`require_current_validity`].
///
/// A certificate with exactly `min_days` left passes; anything less yields
/// `ca-insufficient-validity`. The check uses whole seconds, so the 29/30 and
/// 179/180 day boundaries are exact.
fn require_days_remaining(not_after: i64, now_unix: i64, min_days: i64) -> CaResult<()> {
    let remaining = not_after.saturating_sub(now_unix);
    if remaining < min_days.saturating_mul(SECONDS_PER_DAY) {
        return Err(CaError::InsufficientValidity);
    }
    Ok(())
}

/// Inclusive validity check for freshly issued certificates whose metadata has
/// already been parsed.
fn require_current_validity_range(not_before: i64, not_after: i64, now_unix: i64) -> CaResult<()> {
    if now_unix < not_before || now_unix > not_after {
        return Err(CaError::Expired);
    }
    Ok(())
}

fn audit_observed(report: &acl::AclReport, expect_writable: bool) -> CaResult<()> {
    if !report.owner_is_current_user
        || !report.dacl_protected
        || report.allowed_sids.is_empty()
        || !report.untrusted_allow.is_empty()
    {
        return Err(CaError::AclVerification("CA path ACL audit failed"));
    }
    if expect_writable && !report.user_writable {
        return Err(CaError::AclVerification(
            "CA directory is not owner-writable",
        ));
    }
    // `mode` only exists on Unix; read it so the report is fully consumed on
    // every platform and future backends cannot drop a field silently.
    let _ = report.mode;
    Ok(())
}

fn audit_dir(path: &Path) -> CaResult<()> {
    let report = acl::inspect_private_dir(path)?;
    audit_observed(&report, true)?;
    acl::verify_private_dir(path)?;
    Ok(())
}

fn audit_file(path: &Path) -> CaResult<()> {
    let report = acl::inspect_private_file(path)?;
    audit_observed(&report, false)?;
    acl::verify_private_file(path)?;
    Ok(())
}

fn audit_generation(dir: &Path, stem: &str) -> CaResult<()> {
    audit_dir(dir)?;
    let key = dir.join(format!("{stem}.key"));
    let report = acl::inspect_private_file(&key)?;
    audit_observed(&report, false)?;
    if report.user_writable {
        return Err(CaError::AclVerification("private key is writable"));
    }
    acl::verify_private_key_file(&key)?;
    audit_file(&dir.join(format!("{stem}.crt")))?;
    audit_file(&dir.join("meta.json"))?;
    Ok(())
}

/// Audit every canonical generation directory under `parent`, including
/// non-active retained and pending generations.
///
/// The generation namespace is owned exclusively by this module, so an
/// unexpected entry is treated as corruption instead of being silently
/// skipped. Canonical zero-padded names are required, matching
/// `storage::parse_generation_target`, so `roots/1` can never alias
/// `roots/0001` here either.
fn audit_generation_set(parent: &Path, stem: &str) -> CaResult<()> {
    let mut generations = Vec::new();
    for entry in std::fs::read_dir(parent).map_err(CaError::Io)? {
        let entry = entry.map_err(CaError::Io)?;
        let name = entry
            .file_name()
            .to_str()
            .ok_or(CaError::CorruptState("generation name"))?
            .to_string();
        let generation: u32 = name
            .parse()
            .map_err(|_| CaError::CorruptState("generation name"))?;
        if generation == 0 || format!("{generation:04}") != name {
            return Err(CaError::CorruptState("generation name"));
        }
        if !entry.file_type().map_err(CaError::Io)?.is_dir() {
            return Err(CaError::CorruptState("generation is not a directory"));
        }
        generations.push((generation, entry.path()));
    }
    generations.sort_by_key(|(generation, _)| *generation);
    for (_, dir) in generations {
        audit_generation(&dir, stem)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use time::OffsetDateTime;

    pub(crate) fn fixed_now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap()
    }
    pub(crate) fn now_unix() -> i64 {
        1_800_000_000
    }
    pub(crate) fn temp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mr-ca-{tag}-{}-{nanos}", std::process::id()))
    }
    pub(crate) fn test_manager() -> CaManager {
        CaManager::with_clock(temp_path("manager").join("ca"), Arc::new(fixed_now))
    }
    #[allow(dead_code)] // Tasks 6–7 tests that need a custom CA root.
    pub(crate) fn test_manager_at(root: PathBuf) -> CaManager {
        CaManager::with_clock(root, Arc::new(fixed_now))
    }
    /// Manager whose clock can be moved forward or backward without sleeping,
    /// so tests can cross the intermediate (180-day) and root (10-year)
    /// validity boundaries. Test-only; production uses the system clock.
    pub(crate) fn test_manager_with_mutable_clock(
        root: PathBuf,
    ) -> (CaManager, Arc<Mutex<OffsetDateTime>>) {
        let clock = Arc::new(Mutex::new(fixed_now()));
        let reader = Arc::clone(&clock);
        let mgr = CaManager::with_clock(root, Arc::new(move || *reader.lock().unwrap()));
        (mgr, clock)
    }
    pub(crate) fn read_cert_der(path: &Path) -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap();
        let (_, pem) = x509_parser::pem::parse_x509_pem(&bytes).unwrap();
        pem.contents
    }
    pub(crate) fn read_root_der(mgr: &CaManager) -> Vec<u8> {
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        read_cert_der(
            &mgr.paths_for_test()
                .root_generation_dir(state.active_root)
                .join("root.crt"),
        )
    }
    pub(crate) fn read_active_mid_der(mgr: &CaManager) -> Vec<u8> {
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        read_cert_der(
            &mgr.paths_for_test()
                .intermediate_generation_dir(state.active_intermediate)
                .join("intermediate.crt"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::backup::{self, BackupPayload};
    use super::test_helpers::*;
    use super::*;
    use rustls_pki_types::ServerName;
    use std::net::Ipv4Addr;
    use std::sync::Arc;
    use time::Duration;
    use zeroize::Zeroizing;

    fn top_level_names(mgr: &CaManager) -> Vec<String> {
        let mut names = std::fs::read_dir(mgr.paths_for_test().root_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn cert_info(not_before: i64, not_after: i64) -> CertInfo {
        CertInfo {
            subject: "CN=test".into(),
            issuer: "CN=test".into(),
            serial: "01".into(),
            fingerprint_sha256: "AA".into(),
            not_before,
            not_after,
            spki_raw: Vec::new(),
            is_ca: true,
            path_len: Some(0),
            key_cert_sign: true,
            crl_sign: true,
            basic_constraints_critical: true,
            key_usage_critical: true,
        }
    }

    fn cleanup(mgr: &CaManager) {
        // Keys are read-only with a DACL that denies deletion, so a plain
        // recursive removal fails on Windows; force destroy re-grants a
        // writable DACL before clearing the read-only attribute.
        let root = mgr.paths_for_test().root_dir();
        acl::force_remove_dir_all(root).unwrap();
        assert!(!root.exists(), "CA test root must be removed");
        // `test_manager` puts the CA below a per-test wrapper directory; remove
        // that too so the suite leaves no `mr-ca-*` entries under %TEMP%.
        let wrapper = root.parent().filter(|parent| {
            parent
                .file_name()
                .map(|name| name.to_string_lossy().starts_with("mr-ca-"))
                .unwrap_or(false)
        });
        if let Some(wrapper) = wrapper {
            acl::force_remove_dir_all(wrapper).unwrap();
            assert!(!wrapper.exists(), "CA test wrapper must be removed");
        }
    }

    /// Replace `dir` with a freshly created directory that does not carry the
    /// CA private ACL (it inherits from its parent instead), preserving the
    /// existing children. Used to prove `status` audits parent directories.
    fn loosen_dir_acl(dir: &Path) {
        let aside = dir.with_file_name(format!(
            "{}-aside",
            dir.file_name().unwrap().to_string_lossy()
        ));
        std::fs::rename(dir, &aside).unwrap();
        std::fs::create_dir(dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        for entry in std::fs::read_dir(&aside).unwrap() {
            let entry = entry.unwrap();
            std::fs::rename(entry.path(), dir.join(entry.file_name())).unwrap();
        }
        std::fs::remove_dir(&aside).unwrap();
    }

    fn replace_file_with(path: &Path, bytes: &[u8]) {
        let aside = path.with_extension("orig");
        std::fs::rename(path, &aside).unwrap();
        acl::write_private_file(path, bytes, true).unwrap();
    }

    /// Replace a private file with a plain writable one that carries the
    /// default (non-CA) ACL, while preserving it in place under the same name.
    fn loosen_file_acl(path: &Path) {
        let aside = path.with_extension("orig");
        std::fs::rename(path, &aside).unwrap();
        std::fs::write(path, b"not private CA material").unwrap();
    }

    #[test]
    fn initialize_creates_generation_one_and_status_reports_it() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_root, 1);
        assert_eq!(state.active_intermediate, 1);
        assert_eq!(state.next_root, 2);
        assert_eq!(state.next_intermediate, 2);
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(1)
            .join("root.crt")
            .is_file());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(1)
            .join("intermediate.crt")
            .is_file());

        let status = mgr.status().unwrap();
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        assert_eq!(status.root_days_remaining, 3650);
        assert_eq!(status.intermediate_days_remaining, 180);
        assert!(!status.needs_root_rotation);
        assert!(!status.needs_intermediate_rotation);
        assert!(status.root_fingerprint_sha256.contains(':'));
        assert_ne!(
            status.root_fingerprint_sha256,
            status.intermediate_fingerprint_sha256
        );
        assert!(!status.root_fingerprint_sha256.contains("PRIVATE"));
        assert!(!status.intermediate_fingerprint_sha256.contains("PRIVATE"));

        let root_info = crypto::parse_cert_der(&read_root_der(&mgr)).unwrap();
        assert!(root_info.is_ca);
        assert_eq!(root_info.path_len, Some(1));
        assert!(root_info.key_cert_sign && root_info.crl_sign);
        let mid_info = crypto::parse_cert_der(&read_active_mid_der(&mgr)).unwrap();
        assert!(mid_info.is_ca);
        assert_eq!(mid_info.path_len, Some(0));
        assert!(mid_info.key_cert_sign && mid_info.crl_sign);

        mgr.verify_acl().unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn status_audits_parent_directories_not_just_the_active_generation() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        mgr.status().unwrap();
        // Loosen `roots/` while leaving the active generation untouched: its
        // own directory and file ACLs still pass, so only a parent audit can
        // catch this. `status` must be the complete health API.
        loosen_dir_acl(&mgr.paths_for_test().root_dir().join("roots"));
        let err = mgr.status().unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        cleanup(&mgr);
    }

    #[test]
    fn status_audits_retained_intermediate_generation_acl() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let rotated = mgr.rotate_intermediate().unwrap();
        let retained = mgr
            .paths_for_test()
            .intermediate_generation_dir(rotated.old_generation);
        assert!(retained.join("intermediate.key").is_file());
        assert!(retained.join("intermediate.crt").is_file());
        assert!(retained.join("meta.json").is_file());

        // Generation 1 is retained but no longer active. Loosening its
        // directory ACL must fail the complete CA health check even though the
        // active generation 2 still passes on its own.
        loosen_dir_acl(&retained);
        assert_eq!(mgr.status().unwrap_err().code(), "ca-acl-verification");
        cleanup(&mgr);
    }

    #[test]
    fn status_audits_retained_root_generation_acl() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&plan).unwrap();
        let retained = mgr
            .paths_for_test()
            .root_generation_dir(plan.old_root_generation);
        assert!(retained.join("root.key").is_file());
        assert!(retained.join("root.crt").is_file());
        assert!(retained.join("meta.json").is_file());

        loosen_dir_acl(&retained);
        assert_eq!(mgr.status().unwrap_err().code(), "ca-acl-verification");
        cleanup(&mgr);
    }

    #[test]
    fn status_audits_retained_generation_key_acl() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let rotated = mgr.rotate_intermediate().unwrap();
        // The retained generation's directory stays private; only the key's
        // own ACL is loosened. The per-generation key audit must catch it.
        loosen_file_acl(
            &mgr.paths_for_test()
                .intermediate_generation_dir(rotated.old_generation)
                .join("intermediate.key"),
        );
        assert_eq!(mgr.status().unwrap_err().code(), "ca-acl-verification");
        cleanup(&mgr);
    }

    #[test]
    fn status_audits_rotated_event_log_acl() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let rotated = mgr
            .paths_for_test()
            .root_dir()
            .join("events")
            .join("ca-events.jsonl.1");
        std::fs::write(&rotated, b"{}\n").unwrap();
        assert_eq!(mgr.status().unwrap_err().code(), "ca-acl-verification");
        cleanup(&mgr);
    }

    #[test]
    fn force_destroy_removes_an_initialized_ca() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let root = mgr.paths_for_test().root_dir().to_path_buf();
        assert!(root.join("roots").join("0001").join("root.key").is_file());
        // Regression: a plain `remove_dir_all` leaves this read-only key tree
        // behind on Windows because the key DACL denies deletion.
        acl::force_remove_dir_all(&root).unwrap();
        assert!(!root.exists());
        cleanup(&mgr);
    }

    #[test]
    fn post_commit_event_failure_leaves_ca_initialized() {
        let mgr = test_manager();
        let paths = mgr.paths_for_test();
        // A read-only private event file cannot be appended to, so the audit
        // write after the state commit fails deterministically.
        acl::ensure_private_dir(paths.root_dir()).unwrap();
        acl::ensure_private_dir(&paths.root_dir().join("events")).unwrap();
        acl::write_private_file(&paths.events_file(), b"", true).unwrap();

        let err = mgr.initialize().unwrap_err();
        // Contract: the audit failure is surfaced, never swallowed...
        assert_eq!(err.code(), "ca-io");
        // ...while status() stays authoritative because state was committed.
        assert!(mgr.status().is_ok());
        assert_eq!(
            mgr.initialize().unwrap_err().code(),
            "ca-already-initialized"
        );
        cleanup(&mgr);
    }

    #[test]
    fn second_initialize_is_rejected_without_touching_state() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let before = std::fs::read(mgr.paths_for_test().state_file()).unwrap();
        assert_eq!(
            mgr.initialize().unwrap_err().code(),
            "ca-already-initialized"
        );
        assert_eq!(
            std::fs::read(mgr.paths_for_test().state_file()).unwrap(),
            before
        );
        cleanup(&mgr);
    }

    #[test]
    fn partial_directories_block_initialize_without_repair() {
        let mgr = test_manager();
        std::fs::create_dir_all(mgr.paths_for_test().root_dir().join("roots")).unwrap();
        assert_eq!(
            mgr.initialize().unwrap_err().code(),
            "ca-partial-initialization"
        );
        assert!(!mgr.paths_for_test().state_file().exists());
        cleanup(&mgr);
    }

    #[test]
    fn corrupt_state_is_reported_and_not_regenerated() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        std::fs::write(mgr.paths_for_test().state_file(), b"{not json").unwrap();
        assert_eq!(mgr.status().unwrap_err().code(), "ca-state-corrupt");
        assert_eq!(mgr.initialize().unwrap_err().code(), "ca-state-corrupt");
        cleanup(&mgr);
    }

    #[test]
    fn tampered_intermediate_certificate_is_detected() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let cert_path = mgr
            .paths_for_test()
            .intermediate_generation_dir(1)
            .join("intermediate.crt");
        let replacement = crypto::generate_root(fixed_now()).unwrap();
        replace_file_with(&cert_path, replacement.cert_pem.as_bytes());
        assert_eq!(mgr.status().unwrap_err().code(), "ca-state-corrupt");
        assert_eq!(
            storage::read_active_intermediate_public(mgr.paths_for_test())
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
        cleanup(&mgr);
    }

    #[test]
    fn status_does_not_read_private_key_material() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let key_path = mgr.paths_for_test().root_generation_dir(1).join("root.key");
        replace_file_with(&key_path, b"not a private key");

        // The key ACL and read-only flag are valid, so status must succeed
        // without parsing the file contents.
        let status = mgr.status().unwrap();
        assert!(status.root_fingerprint_sha256.contains(':'));
        // Only the explicit key reader touches the material and rejects it.
        let err = storage::read_active_root_key(mgr.paths_for_test()).unwrap_err();
        assert_eq!(err.code(), "ca-crypto");
        cleanup(&mgr);
    }

    #[test]
    fn event_log_contains_no_key_material_or_paths() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let raw = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(raw.contains("\"event\":\"ca.initialize\""));
        assert!(!raw.contains("PRIVATE KEY"));
        assert!(!raw.contains("root.key"));
        assert!(!raw.contains(&mgr.paths_for_test().root_dir().display().to_string()));
        cleanup(&mgr);
    }

    #[test]
    fn ca_extension_policy_rejects_non_ca_certificates() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let mid_key = storage::read_active_intermediate_key(mgr.paths_for_test()).unwrap();
        let mid = storage::read_active_intermediate_public(mgr.paths_for_test()).unwrap();
        let leaf = crypto::generate_leaf(
            &mid_key,
            &mid.cert_pem,
            "moyu.local",
            &[Ipv4Addr::new(192, 168, 1, 10)],
            fixed_now(),
        )
        .unwrap();
        let leaf_info = crypto::parse_cert_der(&leaf.cert_der).unwrap();
        assert!(!leaf_info.is_ca);
        assert_eq!(
            crypto::validate_ca_extensions(&leaf_info, CaRole::Root)
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
        assert!(crypto::validate_ca_extensions(&leaf_info, CaRole::Intermediate).is_err());
        cleanup(&mgr);
    }

    #[test]
    fn rotation_thresholds_follow_the_injected_clock() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let root = mgr.paths_for_test().root_dir().to_path_buf();

        let near =
            CaManager::with_clock(root.clone(), Arc::new(|| fixed_now() + Duration::days(170)));
        let status = near.status().unwrap();
        assert_eq!(status.intermediate_days_remaining, 10);
        assert_eq!(status.root_days_remaining, 3480);
        assert!(status.needs_intermediate_rotation);
        assert!(!status.needs_root_rotation);

        let far = CaManager::with_clock(root, Arc::new(|| fixed_now() + Duration::days(3400)));
        let status = far.status().unwrap();
        assert!(status.needs_intermediate_rotation);
        assert!(status.needs_root_rotation);
        cleanup(&mgr);
    }

    #[test]
    fn leaf_chain_validates_against_active_intermediate() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let leaf = mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let status = mgr.status().unwrap();
        assert_eq!(status.intermediate_generation, 1);
        let root = read_root_der(&mgr);
        let mid = read_active_mid_der(&mgr);
        crypto::verify_chain(
            &root,
            &mid,
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now_unix(),
        )
        .unwrap();
        crypto::verify_chain(
            &root,
            &mid,
            &leaf.cert_der,
            &ServerName::IpAddress(std::net::IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
            now_unix(),
        )
        .unwrap();
        assert!(leaf.chain_pem.contains("BEGIN CERTIFICATE"));
        assert_eq!(leaf.chain_pem.matches("BEGIN CERTIFICATE").count(), 2);
        assert!(leaf.key_pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(!leaf.key_pem.is_empty());
        let info = crypto::parse_cert_der(&leaf.cert_der).unwrap();
        assert_eq!(leaf.fingerprint_sha256, info.fingerprint_sha256);
        assert_eq!(leaf.not_before, info.not_before);
        assert_eq!(leaf.not_after, info.not_after);
        cleanup(&mgr);
    }

    #[test]
    fn leaf_issuance_validates_dns_and_lan_only() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let lan = [Ipv4Addr::new(192, 168, 1, 10)];
        let name_err = mgr.issue_leaf("evil.example", &lan).unwrap_err();
        assert_eq!(name_err.code(), "ca-invalid-leaf-name");
        assert_eq!(
            mgr.issue_leaf("Moyu.Local", &lan).unwrap_err().code(),
            "ca-invalid-leaf-name"
        );
        assert_eq!(
            mgr.issue_leaf("moyu.local", &[]).unwrap_err().code(),
            "ca-invalid-leaf-ip"
        );
        let too_many = vec![Ipv4Addr::new(192, 168, 1, 10); 9];
        assert_eq!(
            mgr.issue_leaf("moyu.local", &too_many).unwrap_err().code(),
            "ca-invalid-leaf-ip"
        );
        for bad in [
            Ipv4Addr::new(127, 0, 0, 1),       // loopback
            Ipv4Addr::new(169, 254, 1, 1),     // link-local
            Ipv4Addr::new(0, 0, 0, 0),         // unspecified
            Ipv4Addr::new(224, 0, 0, 1),       // multicast
            Ipv4Addr::new(255, 255, 255, 255), // broadcast
            Ipv4Addr::new(8, 8, 8, 8),         // public
            Ipv4Addr::new(100, 64, 0, 1),      // CGNAT, not RFC1918
        ] {
            assert_eq!(
                mgr.issue_leaf("moyu.local", &[bad]).unwrap_err().code(),
                "ca-invalid-leaf-ip",
                "{bad}"
            );
        }
        assert!(!mgr.paths_for_test().root_dir().join("leaves").exists());

        // All RFC1918 ranges accepted together.
        let leaf = mgr
            .issue_leaf(
                "moyu.local",
                &[
                    Ipv4Addr::new(10, 0, 0, 5),
                    Ipv4Addr::new(172, 16, 4, 4),
                    Ipv4Addr::new(192, 168, 1, 10),
                ],
            )
            .unwrap();
        assert!(leaf.chain_pem.contains("BEGIN CERTIFICATE"));
        cleanup(&mgr);
    }

    #[test]
    fn leaf_issuance_is_memory_only() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let before = top_level_names(&mgr);
        let state_before = std::fs::read(mgr.paths_for_test().state_file()).unwrap();
        let leaf = mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();

        assert_eq!(top_level_names(&mgr), before);
        assert!(!mgr.paths_for_test().root_dir().join("leaves").exists());
        assert_eq!(
            std::fs::read(mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );
        let events = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(events.contains("\"event\":\"ca.issue.leaf\""));
        assert!(events.contains(&leaf.fingerprint_sha256));
        assert!(!events.contains("PRIVATE KEY"));
        assert!(!events.contains(&mgr.paths_for_test().root_dir().display().to_string()));
        // Debug output must be safe to log too.
        let debug = format!("{leaf:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("PRIVATE KEY"));
        assert!(!debug.contains(leaf.key_pem.as_str()));
        cleanup(&mgr);
    }

    #[test]
    fn issue_requires_a_current_intermediate_and_rotation_requires_a_current_root() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let root = temp_path("expiry").join("ca");
        let mgr = CaManager::with_clock(root.clone(), Arc::new(fixed_now));
        mgr.initialize().unwrap();

        // 181 days: the 180-day intermediate is expired but the 10-year root
        // is still valid. Issuance must fail; rotation is the recovery path
        // and is covered by `expired_intermediate_is_recoverable_by_rotation`.
        let expired_mid =
            CaManager::with_clock(root.clone(), Arc::new(|| fixed_now() + Duration::days(181)));
        assert_eq!(
            expired_mid
                .issue_leaf("moyu.local", &ip)
                .unwrap_err()
                .code(),
            "ca-expired"
        );
        assert!(expired_mid.status().is_ok());
        assert!(!expired_mid
            .paths_for_test()
            .intermediate_generation_dir(2)
            .exists());

        let expired_root = CaManager::with_clock(
            root.clone(),
            Arc::new(|| fixed_now() + Duration::days(3651)),
        );
        assert_eq!(
            expired_root
                .issue_leaf("moyu.local", &ip)
                .unwrap_err()
                .code(),
            "ca-expired"
        );
        assert_eq!(
            expired_root.rotate_intermediate().unwrap_err().code(),
            "ca-expired"
        );

        let not_yet = CaManager::with_clock(root, Arc::new(|| fixed_now() - Duration::days(2)));
        assert_eq!(
            not_yet.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-expired"
        );
        assert_eq!(
            not_yet.rotate_intermediate().unwrap_err().code(),
            "ca-expired"
        );

        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_intermediate, 1);
        assert_eq!(state.next_intermediate, 2);
        assert!(mgr.status().is_ok());
        mgr.issue_leaf("moyu.local", &ip).unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn expired_intermediate_is_recoverable_by_rotation() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let (mgr, clock) = test_manager_with_mutable_clock(temp_path("recovery").join("ca"));
        mgr.initialize().unwrap();
        let initial = mgr.status().unwrap();
        assert_eq!(initial.intermediate_generation, 1);
        let old_leaf = mgr.issue_leaf("moyu.local", &ip).unwrap();

        // Move past the intermediate's 180-day window while the 10-year root
        // stays valid: the classic expired-issuing-CA state.
        let rotation_time = fixed_now() + Duration::days(181);
        *clock.lock().unwrap() = rotation_time;
        let rotation_unix = rotation_time.unix_timestamp();
        let expired = mgr.status().unwrap();
        assert_eq!(expired.intermediate_generation, 1);
        assert!(expired.intermediate_days_remaining < 0);
        assert!(expired.root_days_remaining > 0);
        assert!(!expired.needs_root_rotation);
        assert!(expired.needs_intermediate_rotation);
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-expired"
        );

        // Recovery: the valid root signs a replacement intermediate.
        let rotated = mgr.rotate_intermediate().unwrap();
        assert_eq!(rotated.old_generation, 1);
        assert_eq!(rotated.new_generation, 2);
        assert_eq!(
            rotated.old_fingerprint_sha256,
            initial.intermediate_fingerprint_sha256
        );
        assert_ne!(
            rotated.new_fingerprint_sha256,
            rotated.old_fingerprint_sha256
        );

        let recovered = mgr.status().unwrap();
        assert_eq!(recovered.intermediate_generation, 2);
        assert_eq!(
            recovered.intermediate_fingerprint_sha256,
            rotated.new_fingerprint_sha256
        );
        assert_eq!(
            recovered.root_fingerprint_sha256,
            initial.root_fingerprint_sha256
        );
        assert_eq!(recovered.intermediate_days_remaining, 180);
        assert_eq!(
            recovered.intermediate_not_after,
            rotation_unix + Duration::days(180).whole_seconds()
        );
        let new_mid = crypto::parse_cert_der(&read_active_mid_der(&mgr)).unwrap();
        assert_eq!(
            new_mid.not_before,
            rotation_unix - Duration::days(1).whole_seconds()
        );
        assert_eq!(
            new_mid.not_after,
            rotation_unix + Duration::days(180).whole_seconds()
        );

        // The recovery is real: leaves chain under the fresh intermediate.
        let new_leaf = mgr.issue_leaf("moyu.local", &ip).unwrap();
        crypto::verify_chain(
            &read_root_der(&mgr),
            &read_active_mid_der(&mgr),
            &new_leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            rotation_unix,
        )
        .unwrap();

        // The expired generation is retained until explicit retirement.
        let old_dir = mgr.paths_for_test().intermediate_generation_dir(1);
        assert!(old_dir.join("intermediate.key").is_file());
        assert!(old_dir.join("intermediate.crt").is_file());
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_intermediate, 2);
        assert_eq!(state.next_intermediate, 3);
        assert!(!old_leaf.cert_der.is_empty());
        cleanup(&mgr);
    }

    #[test]
    fn expired_root_blocks_issuance_and_rotation() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let (mgr, clock) = test_manager_with_mutable_clock(temp_path("root-expiry").join("ca"));
        mgr.initialize().unwrap();
        assert!(mgr.issue_leaf("moyu.local", &ip).is_ok());

        // One day past the root's 3650-day not_after.
        *clock.lock().unwrap() = fixed_now() + Duration::days(3651);
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-expired"
        );
        assert_eq!(mgr.rotate_intermediate().unwrap_err().code(), "ca-expired");
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_intermediate, 1);
        assert_eq!(state.next_intermediate, 2);
        // `status` stays a reporting API; the hard gate lives on the operations.
        assert!(mgr.status().is_ok());
        cleanup(&mgr);
    }

    #[test]
    fn intermediate_rotation_changes_generation_and_keeps_old() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let first = mgr.status().unwrap();
        let leaf1 = mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let rot = mgr.rotate_intermediate().unwrap();
        assert_eq!(rot.old_generation, 1);
        assert_eq!(rot.new_generation, 2);
        assert_eq!(
            rot.old_fingerprint_sha256,
            first.intermediate_fingerprint_sha256
        );
        assert_ne!(rot.old_fingerprint_sha256, rot.new_fingerprint_sha256);

        let second = mgr.status().unwrap();
        assert_eq!(second.root_generation, first.root_generation);
        assert_eq!(
            second.root_fingerprint_sha256,
            first.root_fingerprint_sha256
        );
        assert_eq!(second.intermediate_generation, 2);
        assert_eq!(
            second.intermediate_fingerprint_sha256,
            rot.new_fingerprint_sha256
        );
        assert_ne!(
            second.intermediate_fingerprint_sha256,
            first.intermediate_fingerprint_sha256
        );
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_intermediate, 2);
        assert_eq!(state.next_intermediate, 3);
        let old_dir = mgr.paths_for_test().intermediate_generation_dir(1);
        assert!(old_dir.exists());
        assert!(old_dir.join("intermediate.key").is_file());
        assert!(old_dir.join("intermediate.crt").is_file());
        let events = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(events.contains(&format!(
            "\"previous_fingerprint\":\"{}\"",
            rot.old_fingerprint_sha256
        )));
        assert!(events.contains(&format!(
            "\"fingerprint\":\"{}\"",
            rot.new_fingerprint_sha256
        )));

        let new_mid = crypto::parse_cert_der(&read_active_mid_der(&mgr)).unwrap();
        assert!(new_mid.is_ca);
        assert_eq!(new_mid.path_len, Some(0));
        assert!(new_mid.key_cert_sign && new_mid.crl_sign);
        assert_eq!(new_mid.issuer, "CN=Moyu Local Root CA");
        let leaf2 = mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        crypto::verify_chain(
            &read_root_der(&mgr),
            &read_active_mid_der(&mgr),
            &leaf2.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now_unix(),
        )
        .unwrap();

        // The old leaf remains structurally valid under the retained old
        // intermediate; retirement is explicit and does not revoke it.
        let old_mid = read_cert_der(
            &mgr.paths_for_test()
                .intermediate_generation_dir(1)
                .join("intermediate.crt"),
        );
        crypto::verify_chain(
            &read_root_der(&mgr),
            &old_mid,
            &leaf1.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now_unix(),
        )
        .unwrap();
        assert!(!leaf1.cert_der.is_empty());
        assert!(!mgr.paths_for_test().root_dir().join("leaves").exists());
        cleanup(&mgr);
    }

    #[test]
    fn signing_keys_are_loaded_only_by_the_operation_that_needs_them() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];

        // A corrupt root key must not block leaf issuance (signed by the
        // intermediate), but rotation must fail closed before writing anything.
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let root_key = mgr.paths_for_test().root_generation_dir(1).join("root.key");
        replace_file_with(&root_key, b"not a private key");
        mgr.issue_leaf("moyu.local", &ip).unwrap();
        assert_eq!(mgr.rotate_intermediate().unwrap_err().code(), "ca-crypto");
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        cleanup(&mgr);

        // A corrupt intermediate key blocks leaf issuance, while rotation only
        // needs the root key and still succeeds.
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let mid_key = mgr
            .paths_for_test()
            .intermediate_generation_dir(1)
            .join("intermediate.key");
        replace_file_with(&mid_key, b"not a private key");
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-crypto"
        );
        let rot = mgr.rotate_intermediate().unwrap();
        assert_eq!(rot.new_generation, 2);
        mgr.issue_leaf("moyu.local", &ip).unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn intermediate_rotation_state_commit_failure_removes_the_orphan() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let state_before = storage::load_state(mgr.paths_for_test()).unwrap();
        storage::fail_next_state_commit(mgr.paths_for_test());
        let err = mgr.rotate_intermediate().unwrap_err();
        assert_eq!(err.code(), "ca-io");
        // The pointer never moved, so this call's generation must be gone.
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        assert_eq!(
            storage::load_state(mgr.paths_for_test()).unwrap(),
            state_before
        );
        // No orphan blocks a retry, and generation 2 is reused.
        let rot = mgr.rotate_intermediate().unwrap();
        assert_eq!(rot.new_generation, 2);
        assert_eq!(mgr.status().unwrap().intermediate_generation, 2);
        cleanup(&mgr);
    }

    #[test]
    fn intermediate_rotation_probe_failure_leaves_no_generation() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        fail_next_probe(mgr.paths_for_test());
        assert_eq!(
            mgr.rotate_intermediate().unwrap_err().code(),
            "ca-chain-verification"
        );
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        assert_eq!(mgr.status().unwrap().intermediate_generation, 1);
        // The probe consumed no state; the retry publishes generation 2.
        let rot = mgr.rotate_intermediate().unwrap();
        assert_eq!(rot.new_generation, 2);
        cleanup(&mgr);
    }

    #[test]
    fn backward_clock_clamps_updated_at_and_rotation_still_commits() {
        let wrapper = test_wrapper("backward-clock");
        let (mgr, clock) = test_manager_with_mutable_clock(wrapper.join("ca"));
        mgr.initialize().unwrap();
        let created_at = storage::load_state(mgr.paths_for_test())
            .unwrap()
            .created_at;
        // One hour back stays inside the one-day backdating of the active
        // chain, while making the observed time older than `created_at`.
        *clock.lock().unwrap() = fixed_now() - Duration::hours(1);
        let rot = mgr.rotate_intermediate().unwrap();
        assert_eq!(rot.new_generation, 2);
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.created_at, created_at);
        assert_eq!(state.updated_at, created_at);
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_prepare_probe_failure_writes_no_pending_pair() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        fail_next_probe(mgr.paths_for_test());
        assert_eq!(
            mgr.prepare_root_rotation().unwrap_err().code(),
            "ca-chain-verification"
        );
        assert!(!mgr.paths_for_test().root_generation_dir(2).exists());
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        let plan = mgr.prepare_root_rotation().unwrap();
        assert_eq!(plan.new_root_generation, 2);
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_activation_probe_failure_leaves_state_untouched() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        let state_before = storage::load_state(mgr.paths_for_test()).unwrap();
        fail_next_probe(mgr.paths_for_test());
        assert_eq!(
            mgr.activate_root_rotation(&plan).unwrap_err().code(),
            "ca-chain-verification"
        );
        assert_eq!(
            storage::load_state(mgr.paths_for_test()).unwrap(),
            state_before
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        // The pending pair stays activatable after the probe failure.
        let status = mgr.activate_root_rotation(&plan).unwrap();
        assert_eq!(status.root_generation, plan.new_root_generation);
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_activation_rejects_a_non_self_signed_pending_root() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let mut plan = mgr.prepare_root_rotation().unwrap();
        let root_dir = mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation);
        let cert_pem = root_with_invalid_self_signature_fixture(fixed_now());
        let (_, info) = storage::parse_cert_pem(&cert_pem).unwrap();
        crypto::validate_ca_extensions(&info, CaRole::Root).unwrap();
        // The fixture has identical subject and issuer DNs, so the subject
        // equality check passes and the activation must reach the signature
        // check. Updating the plan fingerprint avoids the earlier fingerprint
        // short-circuit this test used to hit.
        assert_eq!(info.subject, info.issuer);
        plan.new_root_fingerprint_sha256 = info.fingerprint_sha256.clone();
        let meta_path = root_dir.join("meta.json");
        let mut meta: storage::GenerationMeta =
            serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
        meta.fingerprint_sha256 = info.fingerprint_sha256;
        meta.subject = info.subject;
        meta.not_before = info.not_before;
        meta.not_after = info.not_after;
        replace_file_with(&root_dir.join("root.crt"), cert_pem.as_bytes());
        acl::force_remove_dir_all(&meta_path).unwrap();
        acl::write_private_file(
            &meta_path,
            &serde_json::to_vec_pretty(&meta).unwrap(),
            false,
        )
        .unwrap();

        let state_file = mgr.paths_for_test().state_file();
        let state_before = std::fs::read(&state_file).unwrap();
        let state_before_parsed = storage::load_state(mgr.paths_for_test()).unwrap();
        let err = mgr.activate_root_rotation(&plan).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        assert!(
            err.to_string().contains("pending root self-signature"),
            "activation must reject the invalid self-signature, got: {err}"
        );
        // A failed activation must not rewrite or delete anything: compare the
        // raw state bytes (not only the parsed value) and keep both pending
        // generations available for inspection or retry after repair.
        assert_eq!(std::fs::read(&state_file).unwrap(), state_before);
        assert_eq!(
            storage::load_state(mgr.paths_for_test()).unwrap(),
            state_before_parsed
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.new_intermediate_generation)
            .exists());
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_activation_rejects_a_pending_key_mismatch() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        let root_dir = mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation);
        let other = crypto::generate_root(fixed_now()).unwrap();
        replace_file_with(&root_dir.join("root.key"), other.key_pem.as_bytes());

        let state_before = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(
            mgr.activate_root_rotation(&plan).unwrap_err().code(),
            "ca-key-mismatch"
        );
        assert_eq!(
            storage::load_state(mgr.paths_for_test()).unwrap(),
            state_before
        );
        cleanup(&mgr);
    }

    #[test]
    fn backup_import_probe_failure_leaves_state_untouched() {
        let source = test_wrapper("backup-probe-source");
        let source_mgr = test_manager_at(source.join("ca"));
        source_mgr.initialize().unwrap();
        let out = source.join("root.mrca");
        source_mgr.export_backup(&out, "pass", false).unwrap();

        let target = test_wrapper("backup-probe-target");
        let target_mgr = test_manager_at(target.join("ca"));
        target_mgr.initialize().unwrap();
        let state_before = std::fs::read(target_mgr.paths_for_test().state_file()).unwrap();
        fail_next_probe(target_mgr.paths_for_test());
        assert_eq!(
            target_mgr
                .import_backup(&out, "pass", true)
                .unwrap_err()
                .code(),
            "ca-chain-verification"
        );
        assert_eq!(
            std::fs::read(target_mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );
        assert!(!target_mgr.paths_for_test().root_generation_dir(2).exists());
        assert!(!target_mgr
            .paths_for_test()
            .intermediate_generation_dir(2)
            .exists());
        // The failed probe cleaned this call's artifacts; the retry commits.
        let status = target_mgr.import_backup(&out, "pass", true).unwrap();
        assert_eq!(status.root_generation, 2);
        assert_eq!(status.intermediate_generation, 2);
        cleanup(&target_mgr);
        cleanup(&source_mgr);
    }

    #[test]
    fn retire_intermediate_requires_matching_fingerprint_and_non_active() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let first = mgr.status().unwrap();
        assert_eq!(first.intermediate_generation, 1);
        let err = mgr.retire_intermediate(1, "wrong").unwrap_err();
        assert_eq!(err.code(), "ca-fingerprint-mismatch");
        assert!(mgr.paths_for_test().intermediate_generation_dir(1).exists());

        let rot = mgr.rotate_intermediate().unwrap();
        // Exact fingerprint is required even for an inactive generation.
        let err = mgr
            .retire_intermediate(rot.old_generation, &rot.new_fingerprint_sha256)
            .unwrap_err();
        assert_eq!(err.code(), "ca-fingerprint-mismatch");
        assert!(mgr.paths_for_test().intermediate_generation_dir(1).exists());

        mgr.retire_intermediate(rot.old_generation, &rot.old_fingerprint_sha256)
            .unwrap();
        assert!(!mgr.paths_for_test().intermediate_generation_dir(1).exists());
        let err = mgr
            .retire_intermediate(rot.new_generation, &rot.new_fingerprint_sha256)
            .unwrap_err();
        assert_eq!(err.code(), "ca-generation-not-active");
        assert!(mgr.paths_for_test().intermediate_generation_dir(2).exists());

        // Root and active intermediate survive; the CA remains usable.
        assert!(mgr.paths_for_test().root_generation_dir(1).exists());
        assert!(mgr.status().is_ok());
        mgr.issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let events = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(events.contains("\"event\":\"ca.issue.leaf\""));
        assert!(events.contains("\"event\":\"ca.rotate.intermediate\""));
        assert!(events.contains("\"event\":\"ca.retire.intermediate\""));
        assert!(!events.contains("PRIVATE KEY"));
        assert!(!events.contains("intermediate.key"));
        assert!(!events.contains(&mgr.paths_for_test().root_dir().display().to_string()));
        cleanup(&mgr);
    }

    #[test]
    fn retire_intermediate_rejects_unknown_generation() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        assert_eq!(
            mgr.retire_intermediate(9, "AA").unwrap_err().code(),
            "ca-state-corrupt"
        );
        assert_eq!(
            mgr.retire_intermediate(0, "AA").unwrap_err().code(),
            "ca-state-corrupt"
        );
        assert!(mgr.paths_for_test().intermediate_generation_dir(1).exists());
        assert!(mgr.paths_for_test().root_generation_dir(1).exists());
        cleanup(&mgr);
    }

    fn generation_events(mgr: &CaManager, event: &str) -> Vec<serde_json::Value> {
        let raw = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        raw.lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|value| value["event"] == event)
            .collect()
    }

    #[test]
    fn root_rotation_prepare_does_not_change_active_chain() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let before = mgr.status().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        let after_prepare = mgr.status().unwrap();
        assert_eq!(
            before.root_fingerprint_sha256,
            after_prepare.root_fingerprint_sha256
        );
        assert_eq!(
            before.intermediate_fingerprint_sha256,
            after_prepare.intermediate_fingerprint_sha256
        );
        assert_eq!(plan.old_root_generation, before.root_generation);
        assert_eq!(plan.new_root_generation, before.root_generation + 1);
        assert_eq!(
            plan.new_intermediate_generation,
            before.intermediate_generation + 1
        );
        assert_ne!(
            plan.old_root_fingerprint_sha256,
            plan.new_root_fingerprint_sha256
        );
        assert_ne!(
            plan.old_root_fingerprint_sha256,
            plan.new_intermediate_fingerprint_sha256
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.new_intermediate_generation)
            .exists());

        // Prepare is plan-only: the state pointer and active chain do not move.
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_root, before.root_generation);
        assert_eq!(state.active_intermediate, before.intermediate_generation);
        assert_eq!(state.next_root, plan.new_root_generation);
        assert_eq!(state.next_intermediate, plan.new_intermediate_generation);

        let events = generation_events(&mgr, "ca.prepare.root_rotation");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["root_generation"].as_u64(),
            Some(u64::from(plan.new_root_generation))
        );
        let raw = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(!raw.contains("PRIVATE KEY"));
        assert!(!raw.contains(&mgr.paths_for_test().root_dir().display().to_string()));
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_prepare_is_idempotent() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let first = mgr.prepare_root_rotation().unwrap();
        let state_before = std::fs::read(mgr.paths_for_test().state_file()).unwrap();
        let second = mgr.prepare_root_rotation().unwrap();
        assert_eq!(first, second);
        assert_eq!(
            std::fs::read(mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );
        assert_eq!(generation_events(&mgr, "ca.prepare.root_rotation").len(), 1);
        // Exactly one pending pair exists; no second root/intermediate was
        // generated under another generation number.
        let names = |dir: &Path| {
            let mut names = std::fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        let roots = names(&mgr.paths_for_test().root_dir().join("roots"));
        let intermediates = names(&mgr.paths_for_test().root_dir().join("intermediates"));
        assert_eq!(roots.len(), 2, "{roots:?}");
        assert_eq!(intermediates.len(), 2, "{intermediates:?}");
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_activate_changes_trust_anchor_and_retains_old() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        let status = mgr.activate_root_rotation(&plan).unwrap();
        assert_eq!(
            status.root_fingerprint_sha256,
            plan.new_root_fingerprint_sha256
        );
        assert_eq!(
            status.intermediate_fingerprint_sha256,
            plan.new_intermediate_fingerprint_sha256
        );
        assert_eq!(status.root_generation, plan.new_root_generation);
        assert_eq!(
            status.intermediate_generation,
            plan.new_intermediate_generation
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.old_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.old_root_generation)
            .exists());

        let leaf = mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        crypto::verify_chain(
            &read_root_der(&mgr),
            &read_active_mid_der(&mgr),
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            now_unix(),
        )
        .unwrap();

        // Wrong confirmation is refused and the old root is untouched.
        assert_eq!(
            mgr.retire_root(plan.old_root_generation, &plan.new_root_fingerprint_sha256)
                .unwrap_err()
                .code(),
            "ca-fingerprint-mismatch"
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.old_root_generation)
            .exists());

        mgr.retire_root(plan.old_root_generation, &plan.old_root_fingerprint_sha256)
            .unwrap();
        assert!(!mgr
            .paths_for_test()
            .root_generation_dir(plan.old_root_generation)
            .exists());
        // Root retirement never deletes intermediate generations implicitly.
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.old_root_generation)
            .exists());

        // The active root generation can never be retired.
        let current = mgr.status().unwrap();
        assert_eq!(
            mgr.retire_root(current.root_generation, &current.root_fingerprint_sha256)
                .unwrap_err()
                .code(),
            "ca-generation-not-active"
        );
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(current.root_generation)
            .exists());

        let events = generation_events(&mgr, "ca.activate.root_rotation");
        assert_eq!(events.len(), 1);
        let retired = generation_events(&mgr, "ca.retire.root");
        assert_eq!(retired.len(), 1);
        assert_eq!(
            retired[0]["root_generation"].as_u64(),
            Some(u64::from(plan.old_root_generation))
        );
        let raw = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(!raw.contains("PRIVATE KEY"));
        assert!(!raw.contains(&mgr.paths_for_test().root_dir().display().to_string()));
        assert!(!raw.contains("root.key"));
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_activation_rejects_stale_plan() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&plan).unwrap();
        let err = mgr.activate_root_rotation(&plan).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        // A refused activation keeps every generation: the old root stays for
        // rollback and the now-active root is untouched.
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.old_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        let status = mgr.status().unwrap();
        assert_eq!(status.root_generation, plan.new_root_generation);
        assert_eq!(
            status.root_fingerprint_sha256,
            plan.new_root_fingerprint_sha256
        );
        cleanup(&mgr);
    }

    #[test]
    fn root_rotation_recovers_after_old_root_expiry() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let (mgr, clock) = test_manager_with_mutable_clock(temp_path("root-rotation").join("ca"));
        mgr.initialize().unwrap();

        let recovery_time = fixed_now() + Duration::days(3651);
        *clock.lock().unwrap() = recovery_time;
        let expired = mgr.status().unwrap();
        assert_eq!(expired.root_days_remaining, -1);
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-expired"
        );
        assert_eq!(mgr.rotate_intermediate().unwrap_err().code(), "ca-expired");

        // Root rotation is the recovery path: the old root's validity is not
        // a precondition for preparing a fresh pair.
        let plan = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&plan).unwrap();
        let recovered = mgr.status().unwrap();
        assert_eq!(recovered.root_generation, plan.new_root_generation);
        assert_eq!(recovered.root_days_remaining, 3650);
        assert_eq!(recovered.intermediate_days_remaining, 180);
        let leaf = mgr.issue_leaf("moyu.local", &ip).unwrap();
        crypto::verify_chain(
            &read_root_der(&mgr),
            &read_active_mid_der(&mgr),
            &leaf.cert_der,
            &ServerName::try_from("moyu.local").unwrap(),
            recovery_time.unix_timestamp(),
        )
        .unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn leaf_issuance_requires_thirty_days_on_issuers() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let (mgr, clock) = test_manager_with_mutable_clock(temp_path("leaf-window").join("ca"));
        mgr.initialize().unwrap();

        // Exactly 30 days left on the intermediate: still allowed.
        *clock.lock().unwrap() = fixed_now() + Duration::days(150);
        let exactly = mgr.status().unwrap();
        assert_eq!(exactly.intermediate_days_remaining, 30);
        assert_eq!(exactly.root_days_remaining, 3500);
        mgr.issue_leaf("moyu.local", &ip).unwrap();

        // 29 days left: issuance is refused before a leaf can outlive it.
        *clock.lock().unwrap() = fixed_now() + Duration::days(151);
        let short = mgr.status().unwrap();
        assert_eq!(short.intermediate_days_remaining, 29);
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-insufficient-validity"
        );

        // The recovery path is rotation, after which issuance works again.
        let rotation = mgr.rotate_intermediate().unwrap();
        assert_eq!(rotation.new_generation, short.intermediate_generation + 1);
        mgr.issue_leaf("moyu.local", &ip).unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn intermediate_rotation_requires_180_days_on_the_root() {
        let ip = [Ipv4Addr::new(192, 168, 1, 10)];
        let (mgr, clock) = test_manager_with_mutable_clock(temp_path("rotation-window").join("ca"));
        mgr.initialize().unwrap();

        // 179 days on the root: a fresh 180-day intermediate would outlive it.
        *clock.lock().unwrap() = fixed_now() + Duration::days(3471);
        let too_late = mgr.status().unwrap();
        assert_eq!(too_late.root_days_remaining, 179);
        assert_eq!(
            mgr.rotate_intermediate().unwrap_err().code(),
            "ca-insufficient-validity"
        );
        assert!(!mgr.paths_for_test().intermediate_generation_dir(2).exists());
        let state = storage::load_state(mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_intermediate, 1);
        assert_eq!(state.next_intermediate, 2);

        // Exactly 180 days on the root: allowed.
        *clock.lock().unwrap() = fixed_now() + Duration::days(3470);
        assert_eq!(mgr.status().unwrap().root_days_remaining, 180);
        let rotation = mgr.rotate_intermediate().unwrap();
        assert_eq!(rotation.new_generation, 2);

        // 29 days on the root (and its 180-day intermediate) also refuses
        // issuance, so leaf signatures cannot outlive the anchor either.
        *clock.lock().unwrap() = fixed_now() + Duration::days(3621);
        let nearly_done = mgr.status().unwrap();
        assert_eq!(nearly_done.root_days_remaining, 29);
        assert_eq!(
            mgr.issue_leaf("moyu.local", &ip).unwrap_err().code(),
            "ca-insufficient-validity"
        );
        cleanup(&mgr);
    }

    #[test]
    fn retire_root_requires_fingerprint_and_non_active_generation() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let status = mgr.status().unwrap();
        assert_eq!(
            mgr.retire_root(status.root_generation, &status.root_fingerprint_sha256)
                .unwrap_err()
                .code(),
            "ca-generation-not-active"
        );
        assert_eq!(
            mgr.retire_root(status.root_generation, "wrong")
                .unwrap_err()
                .code(),
            "ca-fingerprint-mismatch"
        );
        assert_eq!(
            mgr.retire_root(0, "AA").unwrap_err().code(),
            "ca-state-corrupt"
        );
        assert_eq!(
            mgr.retire_root(9, "AA").unwrap_err().code(),
            "ca-state-corrupt"
        );
        assert!(mgr.paths_for_test().root_generation_dir(1).exists());
        assert!(mgr.paths_for_test().intermediate_generation_dir(1).exists());
        cleanup(&mgr);
    }

    #[test]
    fn retire_intermediate_records_issuer_root_after_root_rotation() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let initial = mgr.status().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&plan).unwrap();
        let rotated = mgr.status().unwrap();
        assert_eq!(rotated.root_generation, plan.new_root_generation);
        assert_ne!(rotated.root_generation, initial.root_generation);

        // Generation 1 was signed by the old root generation 1, not by the now
        // active root generation 2. The audit event must say 1.
        mgr.retire_intermediate(
            initial.intermediate_generation,
            &initial.intermediate_fingerprint_sha256,
        )
        .unwrap();

        let events = generation_events(&mgr, "ca.retire.intermediate");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["root_generation"].as_u64(),
            Some(u64::from(initial.root_generation))
        );
        assert_eq!(
            events[0]["intermediate_generation"].as_u64(),
            Some(u64::from(initial.intermediate_generation))
        );
        assert_eq!(
            events[0]["fingerprint"].as_str(),
            Some(initial.intermediate_fingerprint_sha256.as_str())
        );
        assert!(!mgr
            .paths_for_test()
            .intermediate_generation_dir(initial.intermediate_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(initial.root_generation)
            .exists());
        cleanup(&mgr);
    }

    #[test]
    fn discard_pending_root_rotation_removes_the_pending_pair_and_keeps_state() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        let state_before = std::fs::read(mgr.paths_for_test().state_file()).unwrap();
        let active_before = mgr.status().unwrap();

        mgr.discard_pending_root_rotation(&plan).unwrap();
        assert!(!mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(!mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.new_intermediate_generation)
            .exists());
        // Only the pending pair is removed; the state pointer and active chain
        // are untouched.
        assert_eq!(
            std::fs::read(mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );
        let active_after = mgr.status().unwrap();
        assert_eq!(
            active_after.root_fingerprint_sha256,
            active_before.root_fingerprint_sha256
        );
        assert_eq!(
            active_after.intermediate_fingerprint_sha256,
            active_before.intermediate_fingerprint_sha256
        );

        let events = generation_events(&mgr, "ca.discard.root_rotation");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["root_generation"].as_u64(),
            Some(u64::from(plan.new_root_generation))
        );
        assert_eq!(
            events[0]["intermediate_generation"].as_u64(),
            Some(u64::from(plan.new_intermediate_generation))
        );
        assert_eq!(
            events[0]["fingerprint"].as_str(),
            Some(plan.new_root_fingerprint_sha256.as_str())
        );
        assert_eq!(
            events[0]["previous_fingerprint"].as_str(),
            Some(plan.new_intermediate_fingerprint_sha256.as_str())
        );
        let raw = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(!raw.contains("PRIVATE KEY"));
        assert!(!raw.contains("root.key"));
        assert!(!raw.contains(&mgr.paths_for_test().root_dir().display().to_string()));

        // Idempotent retry: nothing left to delete, no duplicate audit event.
        mgr.discard_pending_root_rotation(&plan).unwrap();
        assert_eq!(generation_events(&mgr, "ca.discard.root_rotation").len(), 1);
        cleanup(&mgr);
    }

    #[test]
    fn discard_pending_root_rotation_refuses_the_active_pair() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&plan).unwrap();

        assert_eq!(
            mgr.discard_pending_root_rotation(&plan).unwrap_err().code(),
            "ca-state-corrupt"
        );
        // The (now active) pair is untouched and the active chain still works.
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.new_intermediate_generation)
            .exists());
        assert_eq!(
            mgr.status().unwrap().root_generation,
            plan.new_root_generation
        );
        assert_eq!(generation_events(&mgr, "ca.discard.root_rotation").len(), 0);
        cleanup(&mgr);
    }

    #[test]
    fn discard_pending_root_rotation_rejects_a_superseded_plan() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let first = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&first).unwrap();
        // A later rotation supersedes `first`; its generations are now
        // retained trust history, not a pending pair.
        let second = mgr.prepare_root_rotation().unwrap();
        mgr.activate_root_rotation(&second).unwrap();
        let active = mgr.status().unwrap();
        assert_eq!(active.root_generation, second.new_root_generation);

        assert_eq!(
            mgr.discard_pending_root_rotation(&first)
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
        // The retired pair is never deleted through a stale plan.
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(first.new_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(first.new_intermediate_generation)
            .exists());
        assert_eq!(
            mgr.status().unwrap().root_generation,
            active.root_generation
        );
        assert_eq!(generation_events(&mgr, "ca.discard.root_rotation").len(), 0);
        cleanup(&mgr);
    }

    #[test]
    fn discard_pending_root_rotation_requires_matching_fingerprints() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();

        let mut wrong_root = plan.clone();
        wrong_root.new_root_fingerprint_sha256 = plan.old_root_fingerprint_sha256.clone();
        assert_eq!(
            mgr.discard_pending_root_rotation(&wrong_root)
                .unwrap_err()
                .code(),
            "ca-fingerprint-mismatch"
        );
        let mut wrong_intermediate = plan.clone();
        wrong_intermediate.new_intermediate_fingerprint_sha256 =
            plan.new_root_fingerprint_sha256.clone();
        assert_eq!(
            mgr.discard_pending_root_rotation(&wrong_intermediate)
                .unwrap_err()
                .code(),
            "ca-fingerprint-mismatch"
        );
        // Both generations were validated before either removal, so a refused
        // discard never leaves a half-removed pair.
        assert!(mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(mgr
            .paths_for_test()
            .intermediate_generation_dir(plan.new_intermediate_generation)
            .exists());

        mgr.discard_pending_root_rotation(&plan).unwrap();
        assert!(!mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        cleanup(&mgr);
    }

    #[test]
    fn discard_pending_root_rotation_is_idempotent_and_cleans_partial_pairs() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        let plan = mgr.prepare_root_rotation().unwrap();
        // Simulate an interrupted cleanup: the pending intermediate is gone,
        // the pending root remains. Discard must finish the job.
        acl::force_remove_dir_all(
            &mgr.paths_for_test()
                .intermediate_generation_dir(plan.new_intermediate_generation),
        )
        .unwrap();
        mgr.discard_pending_root_rotation(&plan).unwrap();
        assert!(!mgr
            .paths_for_test()
            .root_generation_dir(plan.new_root_generation)
            .exists());
        assert!(mgr.status().is_ok());
        cleanup(&mgr);
    }

    #[test]
    fn destroy_requires_fingerprint_and_removes_the_ca_but_keeps_user_backups() {
        let mgr = test_manager();
        mgr.initialize().unwrap();
        // Leave a pending rotation pair behind: destroy removes every CA
        // generation, pending or active.
        let _plan = mgr.prepare_root_rotation().unwrap();
        let status = mgr.status().unwrap();
        let root = mgr.paths_for_test().root_dir().to_path_buf();
        let wrapper = root.parent().unwrap().to_path_buf();
        let backup = wrapper.join("user-export.mrca");
        std::fs::write(&backup, b"user backup bytes").unwrap();

        // Wrong confirmation fails closed: keys, state and events are intact.
        assert_eq!(
            mgr.destroy("wrong-fingerprint").unwrap_err().code(),
            "ca-destroy-confirmation-mismatch"
        );
        assert!(root.join("state.json").is_file());
        assert!(root.join("roots").join("0001").join("root.key").is_file());
        assert!(mgr.status().is_ok());

        mgr.destroy(&status.root_fingerprint_sha256).unwrap();
        assert!(!root.exists());
        // User-exported backups live outside the CA root and are never deleted.
        assert!(backup.is_file());
        assert_eq!(std::fs::read(&backup).unwrap(), b"user backup bytes");
        assert_eq!(mgr.status().unwrap_err().code(), "ca-not-initialized");
        assert_eq!(
            mgr.destroy(&status.root_fingerprint_sha256)
                .unwrap_err()
                .code(),
            "ca-not-initialized"
        );

        std::fs::remove_file(backup).unwrap();
        cleanup(&mgr);
    }

    #[test]
    fn ca_extension_policy_requires_critical_extensions() {
        let mut info = cert_info(100, 1_000);
        info.path_len = Some(1);
        crypto::validate_ca_extensions(&info, CaRole::Root).unwrap();
        info.basic_constraints_critical = false;
        assert_eq!(
            crypto::validate_ca_extensions(&info, CaRole::Root)
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
        info.basic_constraints_critical = true;
        info.key_usage_critical = false;
        assert_eq!(
            crypto::validate_ca_extensions(&info, CaRole::Root)
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
    }

    #[test]
    fn validity_gate_is_inclusive_and_rejects_both_directions() {
        let info = cert_info(100, 200);
        assert_eq!(
            require_current_validity(&info, 99).unwrap_err().code(),
            "ca-expired"
        );
        require_current_validity(&info, 100).unwrap();
        require_current_validity(&info, 200).unwrap();
        assert_eq!(
            require_current_validity(&info, 201).unwrap_err().code(),
            "ca-expired"
        );
    }

    // ---- Task 7b: AEAD root backup export/import ------------------------

    fn test_wrapper(tag: &str) -> PathBuf {
        let dir = temp_path(tag);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup_wrapper(dir: &Path) {
        // Backup fixture files are ordinary files; force removal also handles
        // the private CA tree in successful cases.
        acl::force_remove_dir_all(dir).unwrap();
        assert!(!dir.exists(), "test wrapper must be removed");
    }

    /// Sibling quarantine directories created by a corrupt/missing-state
    /// import. The active CA root must never contain them.
    fn quarantine_siblings(mgr: &CaManager) -> Vec<PathBuf> {
        let root = mgr.paths_for_test().root_dir();
        let parent = root.parent().unwrap();
        let prefix = format!(
            "{}.quarantine-",
            root.file_name().unwrap().to_string_lossy()
        );
        let mut found = std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(prefix.as_str())
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        found.sort();
        found
    }

    /// Build a self-signed root fixture. `is_ca=false` yields a leaf, and
    /// `path_len=0` yields a pathLen:0 CA; both must be rejected by import.
    fn self_signed_root_fixture(
        now: OffsetDateTime,
        is_ca: bool,
        path_len: u8,
        not_before_days: i64,
        not_after_days: i64,
    ) -> (String, String) {
        use rcgen::{
            BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
            PKCS_ECDSA_P256_SHA256,
        };
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, "Imported Test Root");
        params.is_ca = if is_ca {
            IsCa::Ca(BasicConstraints::Constrained(path_len))
        } else {
            IsCa::ExplicitNoCa
        };
        params.key_usages = if is_ca {
            vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign]
        } else {
            vec![KeyUsagePurpose::DigitalSignature]
        };
        params.not_before = now + Duration::days(not_before_days);
        params.not_after = now + Duration::days(not_after_days);
        let cert = params.self_signed(&key).unwrap();
        (key.serialize_pem(), cert.pem())
    }

    /// Build a CA certificate whose subject and issuer DNs are identical but
    /// whose signature was made by a different key. Every other root property
    /// (`CA:TRUE`, `pathLen=1`, key usage, validity) is valid, so the
    /// self-signature check is the only reason activation can reject it.
    fn root_with_invalid_self_signature_fixture(now: OffsetDateTime) -> String {
        use rcgen::{
            BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
            PKCS_ECDSA_P256_SHA256,
        };
        const CN: &str = "Moyu Local Root CA";
        let issuer_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let mut issuer_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        issuer_params
            .distinguished_name
            .push(DnType::CommonName, CN);
        issuer_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(1));
        issuer_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let issuer_cert = issuer_params.self_signed(&issuer_key).unwrap();

        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.distinguished_name.push(DnType::CommonName, CN);
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(1));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = now - Duration::days(1);
        params.not_after = now + Duration::days(3650);
        let issuer = rcgen::Issuer::from_ca_cert_pem(&issuer_cert.pem(), &issuer_key).unwrap();
        params.signed_by(&key, &issuer).unwrap().pem()
    }

    fn backup_fixture_bytes(key_pem: &str, cert_pem: &str, passphrase: &str) -> Vec<u8> {
        let (_, info) = storage::parse_cert_pem(cert_pem).unwrap();
        let payload = BackupPayload {
            schema: CA_SCHEMA,
            root_generation: 1,
            root_key_pem: key_pem.to_string(),
            root_cert_pem: cert_pem.to_string(),
            root_meta: storage::GenerationMeta {
                schema: CA_SCHEMA,
                generation: 1,
                fingerprint_sha256: info.fingerprint_sha256.clone(),
                subject: info.subject.clone(),
                not_before: info.not_before,
                not_after: info.not_after,
                created_at: info.not_before,
                issuer_root_generation: None,
            },
        };
        let json = serde_json::to_vec(&payload).unwrap();
        backup::encrypt_backup(&json, passphrase).unwrap()
    }

    #[test]
    fn backup_roundtrip_and_no_plaintext_key() {
        let source = test_wrapper("backup-roundtrip-source");
        let target = test_wrapper("backup-roundtrip-target");
        let mgr = test_manager_at(source.join("ca"));
        mgr.initialize().unwrap();
        let original = mgr.status().unwrap();
        let out = source.join("root.mrca");
        mgr.export_backup(&out, "correct horse battery staple", false)
            .unwrap();

        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.starts_with(backup::BACKUP_MAGIC));
        assert_eq!(bytes[8], 1);
        assert_eq!(u32::from_le_bytes(bytes[9..13].try_into().unwrap()), 65_536);
        assert_eq!(u32::from_le_bytes(bytes[13..17].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(bytes[17..21].try_into().unwrap()), 1);
        let needle = b"PRIVATE KEY";
        assert!(!bytes.windows(needle.len()).any(|window| window == needle));
        let source_root_path = mgr.paths_for_test().root_dir().display().to_string();
        assert!(!bytes
            .windows(source_root_path.len())
            .any(|window| window == source_root_path.as_bytes()));

        // Export is audited with generation/fingerprint only.
        let events = std::fs::read_to_string(mgr.paths_for_test().events_file()).unwrap();
        assert!(events.contains("\"event\":\"ca.export.backup\""));
        assert!(events.contains(&format!("\"root_generation\":{}", original.root_generation)));
        assert!(events.contains(&original.root_fingerprint_sha256));
        assert!(!events.contains("PRIVATE KEY"));
        assert!(!events.contains(&source_root_path));

        let plaintext =
            Zeroizing::new(backup::decrypt_backup(&bytes, "correct horse battery staple").unwrap());
        let payload: BackupPayload = serde_json::from_slice(plaintext.as_slice()).unwrap();
        assert_eq!(payload.schema, CA_SCHEMA);
        assert_eq!(payload.root_generation, original.root_generation);
        assert_eq!(
            payload.root_meta.fingerprint_sha256,
            original.root_fingerprint_sha256
        );
        assert!(payload
            .root_key_pem
            .starts_with("-----BEGIN PRIVATE KEY-----"));
        assert_eq!(payload.root_key_pem.matches("BEGIN PRIVATE KEY").count(), 1);
        let value: serde_json::Value = serde_json::from_slice(plaintext.as_slice()).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 5, "only the root material is exported");
        assert!(object.contains_key("root_key_pem"));
        assert!(object.contains_key("root_cert_pem"));
        assert!(object.contains_key("root_meta"));
        assert!(!object.contains_key("intermediate_key_pem"));

        let restored = test_manager_at(target.join("ca"));
        let status = restored
            .import_backup(&out, "correct horse battery staple", false)
            .unwrap();
        assert_eq!(
            status.root_fingerprint_sha256,
            original.root_fingerprint_sha256
        );
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        // A fresh intermediate is generated locally; the backup carries no
        // intermediate private key.
        assert_ne!(
            status.intermediate_fingerprint_sha256,
            original.intermediate_fingerprint_sha256
        );
        assert_eq!(
            std::fs::read(
                restored
                    .paths_for_test()
                    .root_generation_dir(1)
                    .join("root.crt")
            )
            .unwrap(),
            std::fs::read(mgr.paths_for_test().root_generation_dir(1).join("root.crt")).unwrap()
        );
        restored
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let events = std::fs::read_to_string(restored.paths_for_test().events_file()).unwrap();
        assert!(events.contains("\"event\":\"ca.import.backup\""));
        assert!(!events.contains("PRIVATE KEY"));
        assert!(!events.contains(&source_root_path));

        cleanup(&mgr);
        cleanup(&restored);
    }

    #[test]
    fn backup_wrong_passphrase_and_tamper_are_rejected_without_touching_active_ca() {
        let source = test_wrapper("backup-bad-source");
        let mgr = test_manager_at(source.join("ca"));
        mgr.initialize().unwrap();
        let state_before = std::fs::read(mgr.paths_for_test().state_file()).unwrap();
        let out = source.join("root.mrca");
        mgr.export_backup(&out, "pass", false).unwrap();
        let original = std::fs::read(&out).unwrap();

        let mut tampered = original.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        std::fs::write(&out, &tampered).unwrap();
        let t1 = test_wrapper("backup-bad-target-1");
        assert_eq!(
            test_manager_at(t1.join("ca"))
                .import_backup(&out, "pass", false)
                .unwrap_err()
                .code(),
            "ca-backup-decrypt"
        );
        assert!(!t1.join("ca").exists());

        std::fs::write(&out, &original).unwrap();
        let t2 = test_wrapper("backup-bad-target-2");
        assert_eq!(
            test_manager_at(t2.join("ca"))
                .import_backup(&out, "wrong", false)
                .unwrap_err()
                .code(),
            "ca-backup-decrypt"
        );
        assert!(!t2.join("ca").exists());

        // Truncated container and a tampered header (AAD) are rejected too.
        let t3 = test_wrapper("backup-bad-target-3");
        std::fs::write(&out, &original[..40]).unwrap();
        assert_eq!(
            test_manager_at(t3.join("ca"))
                .import_backup(&out, "pass", true)
                .unwrap_err()
                .code(),
            "ca-backup-decrypt"
        );
        let t4 = test_wrapper("backup-bad-target-4");
        let mut bad_header = original.clone();
        bad_header[0] ^= 0xFF;
        std::fs::write(&out, &bad_header).unwrap();
        assert_eq!(
            test_manager_at(t4.join("ca"))
                .import_backup(&out, "pass", true)
                .unwrap_err()
                .code(),
            "ca-backup-decrypt"
        );

        // A correct container still restores, proving the failures were caused
        // by the tamper/passphrase only.
        std::fs::write(&out, &original).unwrap();
        let t5 = test_wrapper("backup-bad-target-5");
        let t5_mgr = test_manager_at(t5.join("ca"));
        t5_mgr.import_backup(&out, "pass", false).unwrap();
        assert!(mgr.status().is_ok());
        assert_eq!(
            std::fs::read(mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );

        cleanup(&mgr);
        cleanup(&t5_mgr);
        for wrapper in [t1, t2, t3, t4] {
            cleanup_wrapper(&wrapper);
        }
    }

    #[test]
    fn backup_export_rejects_destinations_inside_the_ca_root() {
        let wrapper = test_wrapper("backup-dest");
        let mgr = test_manager_at(wrapper.join("ca"));
        mgr.initialize().unwrap();
        let root = mgr.paths_for_test().root_dir().to_path_buf();
        let inside = [
            root.join("root.mrca"),
            root.join("roots").join("..").join("escaped.mrca"),
            root.join("staging").join("pending.mrca"),
        ];
        for path in &inside {
            let err = mgr.export_backup(path, "pass", false).unwrap_err();
            assert_eq!(err.code(), "ca-io", "{path:?}");
            assert!(!path.exists(), "{path:?}");
        }
        // The CA root itself is never a file destination.
        assert_eq!(
            mgr.export_backup(&root, "pass", false).unwrap_err().code(),
            "ca-io"
        );
        assert!(mgr.status().is_ok());

        // A sibling of the CA root is valid. `create_new` refuses to replace an
        // existing file unless overwrite is requested.
        let out = wrapper.join("user.mrca");
        mgr.export_backup(&out, "pass", false).unwrap();
        let first = std::fs::read(&out).unwrap();
        assert_eq!(
            mgr.export_backup(&out, "pass", false).unwrap_err().code(),
            "ca-io"
        );
        assert_eq!(std::fs::read(&out).unwrap(), first);
        mgr.export_backup(&out, "pass", true).unwrap();
        let second = std::fs::read(&out).unwrap();
        assert_ne!(first, second);
        assert!(second.starts_with(backup::BACKUP_MAGIC));
        backup::decrypt_backup(&second, "pass").unwrap();
        // No staging file is left next to the destination.
        let names: Vec<String> = std::fs::read_dir(&wrapper)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !names
                .iter()
                .any(|name| name.contains(".tmp") || name.starts_with(".mr-ca-backup")),
            "{names:?}"
        );

        cleanup(&mgr);
    }

    #[test]
    fn backup_import_requires_replace_and_retains_old_generations() {
        let source = test_wrapper("backup-replace-source");
        let target = test_wrapper("backup-replace-target");
        let source_mgr = test_manager_at(source.join("ca"));
        source_mgr.initialize().unwrap();
        let source_status = source_mgr.status().unwrap();
        let out = source.join("root.mrca");
        source_mgr.export_backup(&out, "pass", false).unwrap();

        let target_mgr = test_manager_at(target.join("ca"));
        target_mgr.initialize().unwrap();
        let target_before = target_mgr.status().unwrap();
        let target_state_before = storage::load_state(target_mgr.paths_for_test()).unwrap();
        let state_bytes_before = std::fs::read(target_mgr.paths_for_test().state_file()).unwrap();
        assert_eq!(
            target_mgr
                .import_backup(&out, "pass", false)
                .unwrap_err()
                .code(),
            "ca-already-initialized"
        );
        assert_eq!(
            target_mgr.status().unwrap().root_fingerprint_sha256,
            target_before.root_fingerprint_sha256
        );
        assert_eq!(
            std::fs::read(target_mgr.paths_for_test().state_file()).unwrap(),
            state_bytes_before
        );

        let status = target_mgr.import_backup(&out, "pass", true).unwrap();
        assert_eq!(
            status.root_fingerprint_sha256,
            source_status.root_fingerprint_sha256
        );
        assert_eq!(status.root_generation, 2);
        assert_eq!(status.intermediate_generation, 2);
        assert_ne!(
            status.intermediate_fingerprint_sha256,
            source_status.intermediate_fingerprint_sha256
        );
        // The replaced CA generations are retained for rollback.
        assert!(target_mgr
            .paths_for_test()
            .root_generation_dir(1)
            .join("root.key")
            .is_file());
        assert!(target_mgr
            .paths_for_test()
            .intermediate_generation_dir(1)
            .join("intermediate.key")
            .is_file());

        let state = storage::load_state(target_mgr.paths_for_test()).unwrap();
        assert_eq!(state.active_root, 2);
        assert_eq!(state.active_intermediate, 2);
        assert_eq!(state.next_root, 3);
        assert_eq!(state.next_intermediate, 3);
        assert_eq!(state.created_at, target_state_before.created_at);

        target_mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let events = std::fs::read_to_string(target_mgr.paths_for_test().events_file()).unwrap();
        assert!(events.contains("\"event\":\"ca.import.backup\""));
        assert!(events.contains(&format!(
            "\"previous_fingerprint\":\"{}\"",
            target_before.root_fingerprint_sha256
        )));
        assert!(!events.contains("PRIVATE KEY"));
        assert!(!events.contains(&source.display().to_string()));

        cleanup(&source_mgr);
        cleanup(&target_mgr);
    }

    #[test]
    fn backup_import_recovers_missing_or_corrupt_state_with_replace() {
        let source = test_wrapper("backup-recover-source");
        let source_mgr = test_manager_at(source.join("ca"));
        source_mgr.initialize().unwrap();
        let out = source.join("root.mrca");
        source_mgr.export_backup(&out, "pass", false).unwrap();

        // A pristine CA root has nothing to replace: a first restore works
        // without `replace_existing`.
        let missing = test_wrapper("backup-recover-missing");
        let missing_mgr = test_manager_at(missing.join("ca"));
        let status = missing_mgr.import_backup(&out, "pass", false).unwrap();
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        cleanup(&missing_mgr);

        // Corrupt state with a non-canonical partial orphan: consent is
        // required, and recovery quarantines the whole old tree before writing
        // a fresh 1/1 pair. Nothing from the old tree remains under the active
        // root, so the post-commit `status()` audit cannot fail on it.
        let corrupt = test_wrapper("backup-recover-corrupt");
        let corrupt_mgr = test_manager_at(corrupt.join("ca"));
        corrupt_mgr.initialize().unwrap();
        let old_key = std::fs::read(
            corrupt_mgr
                .paths_for_test()
                .root_generation_dir(1)
                .join("root.key"),
        )
        .unwrap();
        let state_file = corrupt_mgr.paths_for_test().state_file();
        std::fs::write(&state_file, b"{not json").unwrap();
        let orphan = corrupt_mgr
            .paths_for_test()
            .root_dir()
            .join("roots")
            .join("orphan");
        std::fs::create_dir_all(&orphan).unwrap();
        assert_eq!(corrupt_mgr.status().unwrap_err().code(), "ca-state-corrupt");
        assert_eq!(
            corrupt_mgr
                .import_backup(&out, "pass", false)
                .unwrap_err()
                .code(),
            "ca-state-corrupt"
        );
        // Refusal leaves everything byte-identical and creates no quarantine.
        assert_eq!(std::fs::read(&state_file).unwrap(), b"{not json");
        assert!(orphan.is_dir());
        assert!(quarantine_siblings(&corrupt_mgr).is_empty());

        let status = corrupt_mgr.import_backup(&out, "pass", true).unwrap();
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        assert!(!orphan.exists(), "orphan must leave the active root");
        assert!(corrupt_mgr
            .paths_for_test()
            .root_generation_dir(1)
            .join("root.key")
            .is_file());
        corrupt_mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let quarantines = quarantine_siblings(&corrupt_mgr);
        assert_eq!(quarantines.len(), 1, "{quarantines:?}");
        let quarantine = &quarantines[0];
        assert!(quarantine.join("roots").join("orphan").is_dir());
        assert_eq!(
            std::fs::read(quarantine.join("roots").join("0001").join("root.key")).unwrap(),
            old_key
        );
        assert_eq!(
            std::fs::read(quarantine.join("state.json")).unwrap(),
            b"{not json"
        );
        cleanup(&corrupt_mgr);

        // Missing state but existing valid generations: also quarantined, and
        // the fresh pair starts at generation 1 rather than reusing an orphan.
        let orphan_wrapper = test_wrapper("backup-recover-orphan");
        let orphan_mgr = test_manager_at(orphan_wrapper.join("ca"));
        orphan_mgr.initialize().unwrap();
        std::fs::remove_file(orphan_mgr.paths_for_test().state_file()).unwrap();
        assert_eq!(
            orphan_mgr
                .import_backup(&out, "pass", false)
                .unwrap_err()
                .code(),
            "ca-not-initialized"
        );
        assert!(quarantine_siblings(&orphan_mgr).is_empty());
        let status = orphan_mgr.import_backup(&out, "pass", true).unwrap();
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        assert_eq!(quarantine_siblings(&orphan_mgr).len(), 1);
        cleanup(&orphan_mgr);

        cleanup(&source_mgr);
    }

    #[test]
    fn backup_import_quarantines_a_state_file_with_a_broken_acl() {
        let source = test_wrapper("backup-state-acl-source");
        let source_mgr = test_manager_at(source.join("ca"));
        source_mgr.initialize().unwrap();
        let out = source.join("root.mrca");
        source_mgr.export_backup(&out, "pass", false).unwrap();

        let target = test_wrapper("backup-state-acl-target");
        let target_mgr = test_manager_at(target.join("ca"));
        target_mgr.initialize().unwrap();
        let state_file = target_mgr.paths_for_test().state_file();
        // Keep the exact same JSON but strip the private ACL. This is the
        // finding-2 case: a naive import would replace the state file, inherit
        // this DACL, fail the post-replace verification and then delete the
        // generations the committed state points at.
        let state_bytes = std::fs::read(&state_file).unwrap();
        let aside = state_file.with_extension("orig");
        std::fs::rename(&state_file, &aside).unwrap();
        std::fs::write(&state_file, &state_bytes).unwrap();
        assert_eq!(
            target_mgr.status().unwrap_err().code(),
            "ca-acl-verification"
        );
        assert_eq!(
            target_mgr
                .import_backup(&out, "pass", false)
                .unwrap_err()
                .code(),
            "ca-acl-verification"
        );

        let status = target_mgr.import_backup(&out, "pass", true).unwrap();
        assert_eq!(status.root_generation, 1);
        assert_eq!(status.intermediate_generation, 1);
        target_mgr
            .issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        let quarantines = quarantine_siblings(&target_mgr);
        assert_eq!(quarantines.len(), 1, "{quarantines:?}");
        let quarantine = &quarantines[0];
        assert!(quarantine.join("state.json").is_file());
        assert!(quarantine.join("state.orig").is_file());
        assert!(quarantine
            .join("roots")
            .join("0001")
            .join("root.key")
            .is_file());
        cleanup(&target_mgr);
        cleanup(&source_mgr);
    }

    #[test]
    fn backup_import_preflight_failure_leaves_a_valid_state_untouched() {
        let source = test_wrapper("backup-preflight-source");
        let source_mgr = test_manager_at(source.join("ca"));
        source_mgr.initialize().unwrap();
        let out = source.join("root.mrca");
        source_mgr.export_backup(&out, "pass", false).unwrap();

        let target = test_wrapper("backup-preflight-target");
        let target_mgr = test_manager_at(target.join("ca"));
        target_mgr.initialize().unwrap();
        let state_before = std::fs::read(target_mgr.paths_for_test().state_file()).unwrap();
        // `state.json` stays valid, but the retained-generation audit fails.
        // Import must abort before writing instead of treating this as corrupt
        // state and committing over it.
        loosen_dir_acl(&target_mgr.paths_for_test().root_dir().join("roots"));
        assert_eq!(
            target_mgr.status().unwrap_err().code(),
            "ca-acl-verification"
        );
        assert_eq!(
            target_mgr
                .import_backup(&out, "pass", true)
                .unwrap_err()
                .code(),
            "ca-acl-verification"
        );
        assert_eq!(
            std::fs::read(target_mgr.paths_for_test().state_file()).unwrap(),
            state_before
        );
        assert!(target_mgr
            .paths_for_test()
            .root_generation_dir(1)
            .join("root.key")
            .is_file());
        assert!(!target_mgr.paths_for_test().root_generation_dir(2).exists());
        assert!(!target_mgr
            .paths_for_test()
            .intermediate_generation_dir(2)
            .exists());
        assert!(quarantine_siblings(&target_mgr).is_empty());
        cleanup(&target_mgr);
        cleanup(&source_mgr);
    }

    #[test]
    fn backup_import_requires_180_days_of_root_validity() {
        let wrapper = test_wrapper("backup-root-validity");
        let now = fixed_now();

        // Exactly 180 days left passes; the generated intermediate does not
        // outlive the imported root (equal not_after is allowed).
        let (key, cert) = self_signed_root_fixture(now, true, 1, -1, 180);
        let file = wrapper.join("180.mrca");
        std::fs::write(&file, backup_fixture_bytes(&key, &cert, "pass")).unwrap();
        let mgr = test_manager_at(wrapper.join("accept").join("ca"));
        let status = mgr.import_backup(&file, "pass", false).unwrap();
        assert_eq!(status.root_days_remaining, 180);
        assert_eq!(status.intermediate_generation, 1);
        assert!(status.intermediate_not_after <= status.root_not_after);
        cleanup(&mgr);

        // 179 days is rejected before any write.
        let (short_key, short_cert) = self_signed_root_fixture(now, true, 1, -1, 179);
        let short_file = wrapper.join("179.mrca");
        std::fs::write(
            &short_file,
            backup_fixture_bytes(&short_key, &short_cert, "pass"),
        )
        .unwrap();
        let short_mgr = test_manager_at(wrapper.join("reject").join("ca"));
        assert_eq!(
            short_mgr
                .import_backup(&short_file, "pass", false)
                .unwrap_err()
                .code(),
            "ca-insufficient-validity"
        );
        assert!(!short_mgr.paths_for_test().root_dir().exists());
        cleanup_wrapper(&wrapper);
    }

    #[test]
    fn backup_payload_rejects_nested_unknown_fields() {
        let wrapper = test_wrapper("backup-nested-unknown");
        let now = fixed_now();
        let (key, cert) = self_signed_root_fixture(now, true, 1, -1, 3650);
        let (_, info) = storage::parse_cert_pem(&cert).unwrap();
        let payload = serde_json::json!({
            "schema": CA_SCHEMA,
            "root_generation": 1,
            "root_key_pem": key,
            "root_cert_pem": cert,
            "root_meta": {
                "schema": CA_SCHEMA,
                "generation": 1,
                "fingerprint_sha256": info.fingerprint_sha256,
                "subject": info.subject,
                "not_before": info.not_before,
                "not_after": info.not_after,
                "created_at": info.not_before,
                "issuer_root_generation": null,
                "unexpected": true
            }
        });
        let bytes =
            backup::encrypt_backup(serde_json::to_vec(&payload).unwrap().as_slice(), "pass")
                .unwrap();
        let file = wrapper.join("nested.mrca");
        std::fs::write(&file, bytes).unwrap();
        let mgr = test_manager_at(wrapper.join("ca"));
        assert_eq!(
            mgr.import_backup(&file, "pass", true).unwrap_err().code(),
            "ca-state-corrupt"
        );
        assert!(!mgr.paths_for_test().root_dir().exists());
        cleanup_wrapper(&wrapper);
    }

    #[test]
    fn state_commit_classifier_reads_the_pointer_without_acl_trust() {
        let wrapper = test_wrapper("backup-commit-classifier");
        let mgr = test_manager_at(wrapper.join("ca"));
        mgr.initialize().unwrap();
        let paths = mgr.paths_for_test();
        assert!(storage::state_points_at(paths, 1, 1));
        assert!(!storage::state_points_at(paths, 2, 2));

        // Same JSON pointer, but the file no longer passes ACL verification.
        // The post-commit cleanup decision must still see generations 1/1 as
        // committed and leave them in place.
        let state_file = paths.state_file();
        let state_bytes = std::fs::read(&state_file).unwrap();
        let aside = state_file.with_extension("orig");
        std::fs::rename(&state_file, &aside).unwrap();
        std::fs::write(&state_file, &state_bytes).unwrap();
        assert_eq!(
            storage::load_state(paths).unwrap_err().code(),
            "ca-acl-verification"
        );
        assert!(storage::state_points_at(paths, 1, 1));
        assert!(!storage::state_points_at(paths, 2, 2));
        cleanup(&mgr);
    }

    #[test]
    fn backup_import_rejects_invalid_root_certificates() {
        let wrapper = test_wrapper("backup-invalid-root");
        let now = fixed_now();
        let (leaf_key, leaf_cert) = self_signed_root_fixture(now, false, 0, -1, 3650);
        let (pathlen0_key, pathlen0_cert) = self_signed_root_fixture(now, true, 0, -1, 3650);
        let (valid_key, valid_cert) = self_signed_root_fixture(now, true, 1, -1, 3650);
        let (other_key, _) = self_signed_root_fixture(now, true, 1, -1, 3650);
        let (expired_key, expired_cert) = self_signed_root_fixture(now, true, 1, -3651, -1);

        let cases = [
            (
                "leaf",
                backup_fixture_bytes(&leaf_key, &leaf_cert, "pass"),
                "ca-state-corrupt",
            ),
            (
                "pathlen0",
                backup_fixture_bytes(&pathlen0_key, &pathlen0_cert, "pass"),
                "ca-state-corrupt",
            ),
            (
                "mismatch",
                backup_fixture_bytes(&other_key, &valid_cert, "pass"),
                "ca-key-mismatch",
            ),
            (
                "expired",
                backup_fixture_bytes(&expired_key, &expired_cert, "pass"),
                "ca-expired",
            ),
        ];
        for (name, bytes, code) in cases {
            let file = wrapper.join(format!("{name}.mrca"));
            std::fs::write(&file, bytes).unwrap();
            let mgr = test_manager_at(wrapper.join(name).join("ca"));
            let err = mgr.import_backup(&file, "pass", true).unwrap_err();
            assert_eq!(err.code(), code, "{name}");
            // Validation happens before any write; a refused import never
            // leaves a CA root behind.
            assert!(!mgr.paths_for_test().root_dir().exists(), "{name}");
        }

        // A third-party pathlen:1 self-signed root is accepted, and a fresh
        // intermediate is signed under it.
        let file = wrapper.join("valid.mrca");
        std::fs::write(&file, backup_fixture_bytes(&valid_key, &valid_cert, "pass")).unwrap();
        let mgr = test_manager_at(wrapper.join("valid").join("ca"));
        let status = mgr.import_backup(&file, "pass", true).unwrap();
        let (_, valid_info) = storage::parse_cert_pem(&valid_cert).unwrap();
        assert_eq!(
            status.root_fingerprint_sha256,
            valid_info.fingerprint_sha256
        );
        assert_eq!(status.intermediate_generation, 1);
        mgr.issue_leaf("moyu.local", &[Ipv4Addr::new(192, 168, 1, 10)])
            .unwrap();
        cleanup(&mgr);
        cleanup_wrapper(&wrapper);
    }
}
