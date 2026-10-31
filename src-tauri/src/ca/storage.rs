//! Persistence for CA state, generation directories and the audit event log.
//!
//! Everything written here is wrapped by the ACL layer: the CA root directory
//! is made private first, then descendants are created inside it. Private keys
//! are only exposed through [`read_active_root_key`] / [`read_active_intermediate_key`],
//! which return [`Zeroizing`] buffers; `status` never calls them.
//!
//! No function in this module logs, formats or otherwise leaks key material,
//! passphrases or the CA path.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::acl::{
    ensure_private_dir, force_remove_dir_all, verify_private_dir, verify_private_file,
    verify_private_key_file, write_private_file,
};
use super::crypto::{key_matches_cert, parse_cert_der, validate_ca_extensions, CaRole, CertInfo};
use super::error::{CaError, CaResult};
use super::paths::{CaPaths, CA_SCHEMA};

/// Maximum accepted `state.json` size. The real file is a few hundred bytes;
/// anything larger is treated as corrupt instead of being parsed.
const MAX_STATE_BYTES: usize = 64 * 1024;
/// Rotate the event log at 256 KiB, keeping exactly two files (`.jsonl` and
/// `.jsonl.1`).
const EVENT_ROTATE_BYTES: u64 = 256 * 1024;

/// Test-only queue of CA roots whose next state commit must fail before the
/// state file is touched. Keyed by root path so parallel tests cannot consume
/// each other's injected failure.
#[cfg(test)]
static FAIL_NEXT_STATE_COMMIT: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Arm a one-shot state-commit failure for `paths`. Test-only; lets the
/// rotation/import rollback paths be exercised deterministically.
#[cfg(test)]
pub(crate) fn fail_next_state_commit(paths: &CaPaths) {
    FAIL_NEXT_STATE_COMMIT
        .lock()
        .expect("state commit failure queue")
        .push(paths.root_dir().to_path_buf());
}

#[cfg(test)]
fn take_injected_state_commit_failure(paths: &CaPaths) -> bool {
    let root_dir = paths.root_dir();
    let mut queue = FAIL_NEXT_STATE_COMMIT
        .lock()
        .expect("state commit failure queue");
    match queue.iter().position(|candidate| *candidate == root_dir) {
        Some(index) => {
            queue.remove(index);
            true
        }
        None => false,
    }
}

/// Authoritative pointer to the active generations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CaState {
    pub schema: u32,
    pub active_root: u32,
    pub active_intermediate: u32,
    pub next_root: u32,
    pub next_intermediate: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Public metadata stored next to each generation. It contains no secrets:
/// only the certificate fingerprint, subject and validity window.
///
/// The schema is strict: backup import deserializes this through
/// [`super::backup::BackupPayload`], so an unexpected nested field must fail
/// closed instead of being silently ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GenerationMeta {
    pub schema: u32,
    pub generation: u32,
    pub fingerprint_sha256: String,
    pub subject: String,
    pub not_before: i64,
    pub not_after: i64,
    pub created_at: i64,
    pub issuer_root_generation: Option<u32>,
}

/// Public half of the active generation, plus the key path for callers that
/// explicitly need the private key (leaf issuance / root rotation).
pub(crate) struct ActiveGeneration {
    pub generation: u32,
    pub cert_der: Vec<u8>,
    /// Used when signing leaves and intermediates.
    pub cert_pem: String,
    pub info: CertInfo,
    pub meta: GenerationMeta,
    /// Read only by the explicit key readers below.
    pub key_path: PathBuf,
}

impl std::fmt::Debug for ActiveGeneration {
    /// `key_path` is load-bearing but path-like, so it must never appear in
    /// logs or diagnostics; only its redaction marker is printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActiveGeneration")
            .field("generation", &self.generation)
            .field("cert_der_len", &self.cert_der.len())
            .field("cert_pem_len", &self.cert_pem.len())
            .field("info", &self.info)
            .field("meta", &self.meta)
            .field("key_path", &"<redacted>")
            .finish()
    }
}

/// Audit event. Only fingerprints, operation names and results are allowed;
/// paths, key material and passphrases must never reach this struct.
///
/// `fingerprint` is the current/new certificate for the operation;
/// `previous_fingerprint` is only set by rotation events so the old identity
/// remains auditable after the state pointer moves.
#[derive(Serialize)]
pub(crate) struct CaEvent<'a> {
    pub ts: i64,
    pub event: &'a str,
    pub result: &'a str,
    pub root_generation: u32,
    pub intermediate_generation: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_fingerprint: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationKind {
    Root,
    Intermediate,
}

impl GenerationKind {
    fn role(self) -> CaRole {
        match self {
            Self::Root => CaRole::Root,
            Self::Intermediate => CaRole::Intermediate,
        }
    }

    fn key_name(self) -> &'static str {
        match self {
            Self::Root => "root.key",
            Self::Intermediate => "intermediate.key",
        }
    }

    fn cert_name(self) -> &'static str {
        match self {
            Self::Root => "root.crt",
            Self::Intermediate => "intermediate.crt",
        }
    }

    fn parent_dir(self, paths: &CaPaths) -> PathBuf {
        match self {
            Self::Root => paths.root_dir().join("roots"),
            Self::Intermediate => paths.root_dir().join("intermediates"),
        }
    }

    fn generation_dir(self, paths: &CaPaths, generation: u32) -> PathBuf {
        match self {
            Self::Root => paths.root_generation_dir(generation),
            Self::Intermediate => paths.intermediate_generation_dir(generation),
        }
    }
}

fn validate_state(state: &CaState) -> CaResult<()> {
    if state.schema != CA_SCHEMA {
        return Err(CaError::CorruptState("state schema"));
    }
    if state.active_root == 0 || state.active_intermediate == 0 {
        return Err(CaError::CorruptState("state active generation"));
    }
    if state.next_root <= state.active_root || state.next_intermediate <= state.active_intermediate
    {
        return Err(CaError::CorruptState("state next generation"));
    }
    // Timestamps are informational. A backward system clock can make
    // `updated_at` earlier than `created_at`; writers clamp it to
    // `created_at`, and the loader must not reject such a state.
    if state.created_at < 0 || state.updated_at < 0 {
        return Err(CaError::CorruptState("state timestamps"));
    }
    Ok(())
}

/// Load and validate `state.json`. A missing file is [`CaError::NotInitialized`];
/// any present-but-unreadable state is [`CaError::CorruptState`] and must never
/// trigger automatic regeneration.
pub(crate) fn load_state(paths: &CaPaths) -> CaResult<CaState> {
    let path = paths.state_file();
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(CaError::CorruptState("state is not a file")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(CaError::NotInitialized)
        }
        Err(err) => return Err(CaError::Io(err)),
    }
    verify_private_file(&path)?;
    let bytes = std::fs::read(&path).map_err(CaError::Io)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(CaError::CorruptState("state too large"));
    }
    let state: CaState =
        serde_json::from_slice(&bytes).map_err(|_| CaError::CorruptState("state json"))?;
    validate_state(&state)?;
    Ok(state)
}

/// Classify a state pointer **without** its ACL check.
///
/// This exists only for post-commit failure handling: `store_state_atomic`
/// replaces the state file before it re-verifies the destination ACL. If that
/// verification fails, the new pointer may already be live, and deleting the
/// generations it references would destroy a committed CA. The raw state is
/// parsed and range-checked here, but the ACL is intentionally not enforced.
///
/// Never use this for authorization or as a substitute for [`load_state`];
/// every operation that acts on the CA must still go through the verified
/// reader. A missing, oversized, unparsable or invalid state reports `false`,
/// which is the safe answer for cleanup (only a demonstrably committed pointer
/// suppresses cleanup).
pub(crate) fn state_points_at(
    paths: &CaPaths,
    root_generation: u32,
    intermediate_generation: u32,
) -> bool {
    let path = paths.state_file();
    let Ok(metadata) = std::fs::metadata(&path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES as u64 {
        return false;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let Ok(state) = serde_json::from_slice::<CaState>(&bytes) else {
        return false;
    };
    validate_state(&state).is_ok()
        && state.active_root == root_generation
        && state.active_intermediate == intermediate_generation
}

/// Replace `state.json` atomically. The temporary file lives in the private CA
/// root and is removed if the replacement fails, so a half-written JSON file is
/// never observable under the final name.
pub(crate) fn store_state_atomic(paths: &CaPaths, state: &CaState) -> CaResult<()> {
    #[cfg(test)]
    if take_injected_state_commit_failure(paths) {
        return Err(CaError::Io(std::io::Error::other(
            "injected state commit failure",
        )));
    }
    validate_state(state)?;
    ensure_private_dir(paths.root_dir())?;
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|_| CaError::CorruptState("state serialize"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = paths
        .root_dir()
        .join(format!(".state-{}-{nanos}.tmp", std::process::id()));
    if let Err(err) = write_private_file(&tmp, &bytes, false) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = replace_file(&tmp, &paths.state_file()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    verify_private_file(&paths.state_file())?;
    Ok(())
}

/// Atomically replace `dst` with `src`.
///
/// On Windows a plain rename refuses an existing destination, so
/// `ReplaceFileW` is used once the destination exists. Both files must live on
/// the same volume; callers stage next to the destination.
#[cfg(not(windows))]
pub(crate) fn replace_file(src: &Path, dst: &Path) -> CaResult<()> {
    std::fs::rename(src, dst).map_err(CaError::Io)
}

#[cfg(windows)]
pub(crate) fn replace_file(src: &Path, dst: &Path) -> CaResult<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};

    if !dst.exists() {
        return std::fs::rename(src, dst).map_err(CaError::Io);
    }
    let wide = |path: &Path| {
        OsStr::new(path.as_os_str())
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let src_w = wide(src);
    let dst_w = wide(dst);
    // SAFETY: both buffers are NUL-terminated and outlive the call; no backup
    // file is requested and no exclude/preserve handles are supplied.
    unsafe {
        ReplaceFileW(
            PCWSTR(dst_w.as_ptr()),
            PCWSTR(src_w.as_ptr()),
            PCWSTR::null(),
            REPLACEFILE_IGNORE_MERGE_ERRORS,
            None,
            None,
        )
        .map_err(|err| CaError::Acl(err.into()))?;
    }
    Ok(())
}

fn parse_generation_target(
    paths: &CaPaths,
    generation_dir: &Path,
) -> CaResult<(GenerationKind, u32)> {
    let name = generation_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(CaError::CorruptState("generation name"))?;
    let generation: u32 = name
        .parse()
        .map_err(|_| CaError::CorruptState("generation name"))?;
    if generation == 0 {
        return Err(CaError::CorruptState("generation number"));
    }
    let parent = generation_dir
        .parent()
        .ok_or(CaError::CorruptState("generation path"))?;
    let kind = if parent == GenerationKind::Root.parent_dir(paths) {
        GenerationKind::Root
    } else if parent == GenerationKind::Intermediate.parent_dir(paths) {
        GenerationKind::Intermediate
    } else {
        return Err(CaError::CorruptState("generation path"));
    };
    // Only the canonical zero-padded location is accepted, so `roots/1` cannot
    // alias `roots/0001` and bypass the exact generation path the readers use.
    if generation_dir != kind.generation_dir(paths, generation) {
        return Err(CaError::CorruptState("generation path"));
    }
    Ok((kind, generation))
}

fn validate_generation_meta(
    meta: &GenerationMeta,
    kind: GenerationKind,
    generation: u32,
) -> CaResult<()> {
    if meta.schema != CA_SCHEMA {
        return Err(CaError::CorruptState("generation meta schema"));
    }
    if meta.generation != generation {
        return Err(CaError::CorruptState("generation meta number"));
    }
    if meta.created_at < 0 || meta.not_before > meta.not_after {
        return Err(CaError::CorruptState("generation meta timestamps"));
    }
    match kind {
        GenerationKind::Root if meta.issuer_root_generation.is_some() => {
            return Err(CaError::CorruptState("root meta issuer"));
        }
        GenerationKind::Intermediate if meta.issuer_root_generation.is_none() => {
            return Err(CaError::CorruptState("intermediate meta issuer"));
        }
        _ => {}
    }
    Ok(())
}

/// Strict PEM parser shared with backup import. Rejects trailing data, a
/// non-`CERTIFICATE` label and any DER that does not parse as exactly one
/// certificate.
pub(crate) fn parse_cert_pem(cert_pem: &str) -> CaResult<(Vec<u8>, CertInfo)> {
    let (rem, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes())
        .map_err(|err| CaError::CertParse(err.to_string()))?;
    if !rem.iter().all(u8::is_ascii_whitespace) {
        return Err(CaError::CertParse(
            "trailing data after certificate PEM".to_string(),
        ));
    }
    if pem.label != "CERTIFICATE" {
        return Err(CaError::CertParse("unexpected PEM label".to_string()));
    }
    let der = pem.contents;
    let info = parse_cert_der(&der)?;
    Ok((der, info))
}

fn verify_readonly_public_file(path: &Path) -> CaResult<()> {
    verify_private_file(path)?;
    let readonly = std::fs::metadata(path)
        .map_err(CaError::Io)?
        .permissions()
        .readonly();
    if !readonly {
        return Err(CaError::AclVerification("certificate is not read-only"));
    }
    Ok(())
}

fn verify_generation_acl(kind: GenerationKind, dir: &Path) -> CaResult<()> {
    verify_private_dir(dir)?;
    verify_private_key_file(&dir.join(kind.key_name()))?;
    verify_readonly_public_file(&dir.join(kind.cert_name()))?;
    verify_private_file(&dir.join("meta.json"))?;
    Ok(())
}

/// Best-effort removal of a staging tree, including a key that was already
/// written. Keys are read-only and carry a DACL that denies deletion, so a
/// plain recursive removal fails on Windows; the force destroy primitive
/// re-grants a writable DACL first. Errors are ignored here because the tree
/// remains under the private CA root; the production destroy path (Task 7) is
/// the one that must report failures.
fn remove_tree(path: &Path) {
    let _ = force_remove_dir_all(path);
}

/// Write a complete generation under `generation_dir` and publish it with a
/// single directory rename. The target must not exist; on any failure the
/// staging directory is removed and the target is left untouched.
pub(crate) fn write_generation(
    paths: &CaPaths,
    generation_dir: &Path,
    key_pem: &str,
    cert_pem: &str,
    meta: &GenerationMeta,
) -> CaResult<()> {
    let (kind, generation) = parse_generation_target(paths, generation_dir)?;
    validate_generation_meta(meta, kind, generation)?;
    let (cert_der, info) = parse_cert_pem(cert_pem)?;
    if meta.fingerprint_sha256 != info.fingerprint_sha256
        || meta.subject != info.subject
        || meta.not_before != info.not_before
        || meta.not_after != info.not_after
    {
        return Err(CaError::CorruptState("generation meta mismatch"));
    }
    validate_ca_extensions(&info, kind.role())?;
    if !key_matches_cert(key_pem, &cert_der)? {
        return Err(CaError::KeyMismatch);
    }
    if generation_dir.exists() {
        return Err(CaError::CorruptState("generation already exists"));
    }

    // Root-down: the CA root gets its explicit DACL before any descendant is
    // created. On Windows only the leaf passed to `ensure_private_dir` gets the
    // DACL, so every level is established explicitly.
    ensure_private_dir(paths.root_dir())?;
    ensure_private_dir(&kind.parent_dir(paths))?;
    let staging_root = paths.root_dir().join("staging");
    ensure_private_dir(&staging_root)?;
    let staging = paths.staging_dir("generation");
    ensure_private_dir(&staging)?;

    let write_result = (|| -> CaResult<()> {
        write_private_file(&staging.join(kind.cert_name()), cert_pem.as_bytes(), true)?;
        let meta_bytes = serde_json::to_vec_pretty(meta)
            .map_err(|_| CaError::CorruptState("generation meta serialize"))?;
        write_private_file(&staging.join("meta.json"), &meta_bytes, false)?;
        // The key is written last: everything before it is removable on any
        // failure, and a partial key is removed by `write_private_file` itself.
        write_private_file(&staging.join(kind.key_name()), key_pem.as_bytes(), true)?;
        Ok(())
    })();
    if let Err(err) = write_result {
        remove_tree(&staging);
        return Err(err);
    }

    // Re-check right before publishing so a concurrent writer cannot make us
    // silently replace a generation directory.
    if generation_dir.exists() {
        remove_tree(&staging);
        return Err(CaError::CorruptState("generation already exists"));
    }
    if let Err(err) = std::fs::rename(&staging, generation_dir) {
        remove_tree(&staging);
        return Err(CaError::Io(err));
    }

    if let Err(err) = verify_generation_acl(kind, generation_dir) {
        // The directory was ours and did not exist before; do not leave an
        // unverified generation behind.
        remove_tree(generation_dir);
        return Err(err);
    }
    Ok(())
}

fn require_generation_dir(kind: GenerationKind, dir: &Path) -> CaResult<()> {
    if !dir.is_dir() {
        return Err(CaError::CorruptState("generation directory missing"));
    }
    for name in [kind.key_name(), kind.cert_name(), "meta.json"] {
        if !dir.join(name).is_file() {
            return Err(CaError::CorruptState("generation incomplete"));
        }
    }
    Ok(())
}

fn read_generation_public(
    paths: &CaPaths,
    kind: GenerationKind,
    generation: u32,
) -> CaResult<ActiveGeneration> {
    if generation == 0 {
        return Err(CaError::CorruptState("generation number"));
    }
    let dir = kind.generation_dir(paths, generation);
    require_generation_dir(kind, &dir)?;
    verify_private_dir(&dir)?;

    let key_path = dir.join(kind.key_name());
    let cert_path = dir.join(kind.cert_name());
    let meta_path = dir.join("meta.json");
    // Key files are checked through metadata only: no key material is read on
    // the status path.
    verify_private_key_file(&key_path)?;
    verify_readonly_public_file(&cert_path)?;
    verify_private_file(&meta_path)?;

    let meta_bytes = std::fs::read(&meta_path).map_err(CaError::Io)?;
    if meta_bytes.len() > MAX_STATE_BYTES {
        return Err(CaError::CorruptState("generation meta too large"));
    }
    let meta: GenerationMeta = serde_json::from_slice(&meta_bytes)
        .map_err(|_| CaError::CorruptState("generation meta json"))?;
    validate_generation_meta(&meta, kind, generation)?;

    let cert_bytes = std::fs::read(&cert_path).map_err(CaError::Io)?;
    let cert_pem =
        String::from_utf8(cert_bytes).map_err(|_| CaError::CorruptState("certificate encoding"))?;
    let (cert_der, info) =
        parse_cert_pem(&cert_pem).map_err(|_| CaError::CorruptState("certificate parse"))?;
    if meta.fingerprint_sha256 != info.fingerprint_sha256
        || meta.subject != info.subject
        || meta.not_before != info.not_before
        || meta.not_after != info.not_after
    {
        return Err(CaError::CorruptState("generation meta mismatch"));
    }
    validate_ca_extensions(&info, kind.role())?;
    Ok(ActiveGeneration {
        generation,
        cert_der,
        cert_pem,
        info,
        meta,
        key_path,
    })
}

/// Read a specific root generation without its key. Root rotation reads the
/// pending and retired generations through this reader, so generation numbers
/// are not limited to the active state.
pub(crate) fn read_root_public(paths: &CaPaths, generation: u32) -> CaResult<ActiveGeneration> {
    read_generation_public(paths, GenerationKind::Root, generation)
}

/// Read the active root certificate and metadata. The private key is not read;
/// only its existence, ACL and read-only state are checked.
pub(crate) fn read_active_root_public(paths: &CaPaths) -> CaResult<ActiveGeneration> {
    let state = load_state(paths)?;
    read_root_public(paths, state.active_root)
}

/// Read a specific intermediate generation without its key. Used by
/// [`super::CaManager::retire_intermediate`] so an inactive generation is
/// identified through the same ACL, metadata and certificate checks as the
/// active readers before it is deleted.
pub(crate) fn read_intermediate_public(
    paths: &CaPaths,
    generation: u32,
) -> CaResult<ActiveGeneration> {
    read_generation_public(paths, GenerationKind::Intermediate, generation)
}

/// Read the active intermediate certificate and metadata without its key.
pub(crate) fn read_active_intermediate_public(paths: &CaPaths) -> CaResult<ActiveGeneration> {
    let state = load_state(paths)?;
    read_intermediate_public(paths, state.active_intermediate)
}

fn read_generation_key(active: &ActiveGeneration) -> CaResult<Zeroizing<String>> {
    // Wrap the raw bytes immediately so both the byte buffer and the decoded
    // string are zeroized on every path, including mismatch errors.
    let raw = Zeroizing::new(std::fs::read(&active.key_path).map_err(CaError::Io)?);
    let key_pem = Zeroizing::new(
        std::str::from_utf8(&raw)
            .map_err(|_| CaError::CorruptState("key encoding"))?
            .to_string(),
    );
    if !key_matches_cert(&key_pem, &active.cert_der)? {
        return Err(CaError::KeyMismatch);
    }
    Ok(key_pem)
}

/// Read the active root private key. Used by intermediate rotation (Task 5)
/// and root rotation (Task 6) only; never by `status` or leaf issuance.
pub(crate) fn read_active_root_key(paths: &CaPaths) -> CaResult<Zeroizing<String>> {
    let active = read_active_root_public(paths)?;
    read_generation_key(&active)
}

/// Read the private key of a specific root generation. Used by root rotation
/// when it re-validates an already pending pair; never by `status`.
pub(crate) fn read_root_generation_key(
    paths: &CaPaths,
    generation: u32,
) -> CaResult<Zeroizing<String>> {
    let root = read_root_public(paths, generation)?;
    read_generation_key(&root)
}

/// Read the active intermediate private key. Used by leaf issuance only.
pub(crate) fn read_active_intermediate_key(paths: &CaPaths) -> CaResult<Zeroizing<String>> {
    let active = read_active_intermediate_public(paths)?;
    read_generation_key(&active)
}

/// Read the private key of a specific intermediate generation. Used by root
/// rotation when it re-validates an already pending pair.
pub(crate) fn read_intermediate_generation_key(
    paths: &CaPaths,
    generation: u32,
) -> CaResult<Zeroizing<String>> {
    let intermediate = read_intermediate_public(paths, generation)?;
    read_generation_key(&intermediate)
}

/// Path of the single rotated audit log (`ca-events.jsonl.1`). The full ACL
/// audit uses it so the retained log is held to the same private policy as the
/// live one.
pub(crate) fn rotated_event_path(paths: &CaPaths) -> PathBuf {
    let mut name = paths
        .events_file()
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "ca-events.jsonl".into());
    name.push(".1");
    paths.root_dir().join("events").join(name)
}

/// Append one JSON line to the audit log. The log rotates at 256 KiB and keeps
/// two files. Event contents are restricted to timestamps, operation/result
/// names, generation numbers and certificate fingerprints.
pub(crate) fn append_event(paths: &CaPaths, event: &CaEvent<'_>) -> CaResult<()> {
    ensure_private_dir(paths.root_dir())?;
    let events_dir = paths.root_dir().join("events");
    ensure_private_dir(&events_dir)?;
    let file = paths.events_file();
    if !file.is_file() {
        write_private_file(&file, b"", false)?;
    }
    // Reject a swapped-in symlink/reparse point before appending to it.
    verify_private_file(&file)?;

    let size = std::fs::metadata(&file).map_err(CaError::Io)?.len();
    if size >= EVENT_ROTATE_BYTES {
        let rotated = rotated_event_path(paths);
        match std::fs::remove_file(&rotated) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(CaError::Io(err)),
        }
        std::fs::rename(&file, &rotated).map_err(CaError::Io)?;
        write_private_file(&file, b"", false)?;
    }

    let mut line =
        serde_json::to_vec(event).map_err(|_| CaError::CorruptState("event serialize"))?;
    line.push(b'\n');
    let mut handle = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .map_err(CaError::Io)?;
    handle.write_all(&line).map_err(CaError::Io)?;
    handle.sync_data().map_err(CaError::Io)?;
    drop(handle);
    verify_private_file(&file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use time::OffsetDateTime;

    fn paths() -> CaPaths {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        CaPaths::new(
            std::env::temp_dir().join(format!("mr-ca-store-{}-{nanos}", std::process::id())),
        )
    }

    fn now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap()
    }

    fn state() -> CaState {
        CaState {
            schema: CA_SCHEMA,
            active_root: 1,
            active_intermediate: 1,
            next_root: 2,
            next_intermediate: 2,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn root_meta(root: &super::super::crypto::GeneratedCa, generation: u32) -> GenerationMeta {
        let info = parse_cert_der(&root.cert_der).unwrap();
        GenerationMeta {
            schema: CA_SCHEMA,
            generation,
            fingerprint_sha256: info.fingerprint_sha256,
            subject: info.subject,
            not_before: info.not_before,
            not_after: info.not_after,
            created_at: 1,
            issuer_root_generation: None,
        }
    }

    fn cleanup(paths: &CaPaths) {
        // Keys are read-only with a DACL that denies deletion, so the force
        // destroy primitive must re-grant a writable DACL before removal.
        force_remove_dir_all(paths.root_dir()).unwrap();
        assert!(!paths.root_dir().exists(), "CA test root must be removed");
    }

    #[test]
    fn state_roundtrip_and_missing_state() {
        let p = paths();
        assert_eq!(load_state(&p).unwrap_err().code(), "ca-not-initialized");
        store_state_atomic(&p, &state()).unwrap();
        assert_eq!(load_state(&p).unwrap().active_root, 1);

        // Replacing an existing state exercises the Windows ReplaceFileW path.
        let mut updated = state();
        updated.active_root = 2;
        updated.next_root = 3;
        updated.updated_at = 2;
        store_state_atomic(&p, &updated).unwrap();
        assert_eq!(load_state(&p).unwrap().active_root, 2);
        assert_eq!(load_state(&p).unwrap().updated_at, 2);
        let leftovers = std::fs::read_dir(p.root_dir())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".state-"))
            .count();
        assert_eq!(leftovers, 0, "temporary state files must be cleaned up");
        cleanup(&p);
    }

    #[test]
    fn state_is_replaced_atomically_without_partial_json() {
        let p = paths();
        std::fs::create_dir_all(p.root_dir()).unwrap();
        store_state_atomic(&p, &state()).unwrap();
        let raw = std::fs::read_to_string(p.state_file()).unwrap();
        assert!(serde_json::from_str::<CaState>(&raw).is_ok());
        assert!(!raw.contains("PRIVATE KEY"));
        cleanup(&p);
    }

    #[test]
    fn state_schema_and_ranges_are_rejected() {
        let p = paths();
        ensure_private_dir(p.root_dir()).unwrap();
        write_private_file(
            &p.state_file(),
            br#"{"schema":99,"active_root":1,"active_intermediate":1,"next_root":2,"next_intermediate":2,"created_at":1,"updated_at":1}"#,
            false,
        )
        .unwrap();
        assert_eq!(load_state(&p).unwrap_err().code(), "ca-state-corrupt");

        let mut invalid = state();
        invalid.next_root = 1;
        assert_eq!(
            store_state_atomic(&p, &invalid).unwrap_err().code(),
            "ca-state-corrupt"
        );
        cleanup(&p);
    }

    #[test]
    fn backward_clock_timestamps_are_informational() {
        let p = paths();
        // A state written before a clock rollback can legitimately carry
        // `updated_at < created_at`; only negative values are invalid.
        let mut backward = state();
        backward.created_at = 100;
        backward.updated_at = 50;
        store_state_atomic(&p, &backward).unwrap();
        let loaded = load_state(&p).unwrap();
        assert_eq!(loaded.created_at, 100);
        assert_eq!(loaded.updated_at, 50);
        cleanup(&p);
    }

    #[test]
    fn generation_roundtrip_reads_public_and_key() {
        let p = paths();
        let root = super::super::crypto::generate_root(now()).unwrap();
        let meta = root_meta(&root, 1);
        let dir = p.root_generation_dir(1);
        write_generation(&p, &dir, &root.key_pem, &root.cert_pem, &meta).unwrap();
        store_state_atomic(&p, &state()).unwrap();

        let active = read_active_root_public(&p).unwrap();
        assert_eq!(active.generation, 1);
        assert_eq!(active.info.fingerprint_sha256, meta.fingerprint_sha256);
        assert_eq!(active.info.subject, meta.subject);
        // Debug output must not leak the private key path.
        let debug = format!("{active:?}");
        assert!(!debug.contains("root.key"));
        assert!(!debug.contains(&p.root_dir().display().to_string()));

        let key = read_active_root_key(&p).unwrap();
        assert!(key.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(std::fs::metadata(dir.join("root.key"))
            .unwrap()
            .permissions()
            .readonly());
        assert!(std::fs::metadata(dir.join("root.crt"))
            .unwrap()
            .permissions()
            .readonly());
        assert!(!std::fs::metadata(dir.join("meta.json"))
            .unwrap()
            .permissions()
            .readonly());
        let meta_raw = std::fs::read_to_string(dir.join("meta.json")).unwrap();
        assert!(!meta_raw.contains("PRIVATE KEY"));
        cleanup(&p);
    }

    #[test]
    fn write_generation_rejects_meta_mismatch_and_existing_target() {
        let p = paths();
        let root = super::super::crypto::generate_root(now()).unwrap();
        let meta = root_meta(&root, 1);
        let mut bad = meta.clone();
        bad.fingerprint_sha256 = "00:00".into();
        let dir = p.root_generation_dir(1);
        let err = write_generation(&p, &dir, &root.key_pem, &root.cert_pem, &bad).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        assert!(!dir.exists());

        write_generation(&p, &dir, &root.key_pem, &root.cert_pem, &meta).unwrap();
        let err = write_generation(&p, &dir, &root.key_pem, &root.cert_pem, &meta).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        // The existing generation is untouched.
        assert!(dir.join("root.crt").is_file());
        cleanup(&p);
    }

    #[test]
    fn write_generation_rejects_non_canonical_generation_path() {
        let p = paths();
        let root = super::super::crypto::generate_root(now()).unwrap();
        let meta = root_meta(&root, 1);
        // `roots/1` must not alias the canonical `roots/0001`.
        let unpadded = p.root_dir().join("roots").join("1");
        let err =
            write_generation(&p, &unpadded, &root.key_pem, &root.cert_pem, &meta).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        assert!(!unpadded.exists());
        assert!(!p.root_generation_dir(1).exists());

        // Padded but non-canonical widths are rejected the same way.
        let overpadded = p.root_dir().join("roots").join("00001");
        let err =
            write_generation(&p, &overpadded, &root.key_pem, &root.cert_pem, &meta).unwrap_err();
        assert_eq!(err.code(), "ca-state-corrupt");
        assert!(!overpadded.exists());
        cleanup(&p);
    }

    #[test]
    fn generation_io_supports_arbitrary_generation_numbers() {
        let p = paths();
        let root = super::super::crypto::generate_root(now()).unwrap();
        let root_info = parse_cert_der(&root.cert_der).unwrap();
        let root_meta = GenerationMeta {
            schema: CA_SCHEMA,
            generation: 7,
            fingerprint_sha256: root_info.fingerprint_sha256.clone(),
            subject: root_info.subject.clone(),
            not_before: root_info.not_before,
            not_after: root_info.not_after,
            created_at: 1,
            issuer_root_generation: None,
        };
        write_generation(
            &p,
            &p.root_generation_dir(7),
            &root.key_pem,
            &root.cert_pem,
            &root_meta,
        )
        .unwrap();

        let mid = super::super::crypto::generate_intermediate(&root.key_pem, &root.cert_pem, now())
            .unwrap();
        let mid_info = parse_cert_der(&mid.cert_der).unwrap();
        let mid_meta = GenerationMeta {
            schema: CA_SCHEMA,
            generation: 12,
            fingerprint_sha256: mid_info.fingerprint_sha256.clone(),
            subject: mid_info.subject.clone(),
            not_before: mid_info.not_before,
            not_after: mid_info.not_after,
            created_at: 1,
            issuer_root_generation: Some(7),
        };
        write_generation(
            &p,
            &p.intermediate_generation_dir(12),
            &mid.key_pem,
            &mid.cert_pem,
            &mid_meta,
        )
        .unwrap();

        let read_root = read_root_public(&p, 7).unwrap();
        assert_eq!(read_root.generation, 7);
        assert_eq!(
            read_root.info.fingerprint_sha256,
            root_meta.fingerprint_sha256
        );
        let read_mid = read_intermediate_public(&p, 12).unwrap();
        assert_eq!(read_mid.generation, 12);
        assert_eq!(read_mid.meta.issuer_root_generation, Some(7));
        assert!(read_root_generation_key(&p, 7)
            .unwrap()
            .starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(read_intermediate_generation_key(&p, 12)
            .unwrap()
            .starts_with("-----BEGIN PRIVATE KEY-----"));
        cleanup(&p);
    }

    #[test]
    fn events_are_private_and_contain_no_secrets() {
        let p = paths();
        let event = CaEvent {
            ts: 1,
            event: "ca.test",
            result: "ok",
            root_generation: 1,
            intermediate_generation: 1,
            fingerprint: Some("AA:BB"),
            previous_fingerprint: None,
        };
        append_event(&p, &event).unwrap();
        let raw = std::fs::read_to_string(p.events_file()).unwrap();
        assert!(raw.contains("\"event\":\"ca.test\""));
        assert!(raw.contains("\"fingerprint\":\"AA:BB\""));
        assert!(!raw.contains("PRIVATE KEY"));
        assert!(!raw.contains("root.key"));
        assert!(!raw.contains(&p.root_dir().display().to_string()));
        crate::ca::acl::verify_private_dir(&p.root_dir().join("events")).unwrap();
        cleanup(&p);
    }

    #[test]
    fn event_log_rotates_and_keeps_two_files() {
        let p = paths();
        let event = CaEvent {
            ts: 1,
            event: "ca.test",
            result: "ok",
            root_generation: 1,
            intermediate_generation: 1,
            fingerprint: None,
            previous_fingerprint: None,
        };
        append_event(&p, &event).unwrap();
        let file = p.events_file();
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        handle
            .write_all(&vec![b'x'; EVENT_ROTATE_BYTES as usize + 1])
            .unwrap();
        drop(handle);

        append_event(&p, &event).unwrap();
        let rotated = rotated_event_path(&p);
        assert!(rotated.is_file());
        assert!(std::fs::metadata(&file).unwrap().len() < EVENT_ROTATE_BYTES);
        let current = std::fs::read_to_string(&file).unwrap();
        assert!(current.contains("\"event\":\"ca.test\""));
        assert!(!current.contains("PRIVATE KEY"));

        // Fill again and rotate once more: the older `.1` is replaced, and no
        // `.2` file appears.
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        handle
            .write_all(&vec![b'y'; EVENT_ROTATE_BYTES as usize + 1])
            .unwrap();
        drop(handle);
        append_event(&p, &event).unwrap();
        assert!(rotated.is_file());
        let events_dir = p.root_dir().join("events");
        let names = std::fs::read_dir(&events_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 2);
        cleanup(&p);
    }
}
