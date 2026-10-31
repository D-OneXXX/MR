//! Unix backend: owner-only modes (0700 directories, 0400 keys, 0600 data)
//! with read-back verification of owner, mode and symlink-free ancestry.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::AclReport;
use crate::ca::{CaError, CaResult};

fn reject_symlink_ancestors(path: &Path) -> CaResult<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(CaError::Acl)?.join(path)
    };
    let mut current: Option<PathBuf> = Some(absolute);
    while let Some(candidate) = current {
        match fs::symlink_metadata(&candidate) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(CaError::AclVerification("reparse point in CA path"));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(CaError::Acl(err)),
        }
        current = candidate.parent().map(Path::to_path_buf);
    }
    Ok(())
}

/// Effective UID of the current process.
///
/// `libc` is only a dependency for the Linux target in this crate, so any
/// other Unix target fails closed instead of pretending the owner matches.
fn effective_uid() -> CaResult<u32> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        Ok(unsafe { libc::geteuid() })
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(CaError::AclVerification(
            "effective uid unavailable on this unix target",
        ))
    }
}

fn inspect(path: &Path) -> CaResult<AclReport> {
    reject_symlink_ancestors(path)?;
    let meta = fs::symlink_metadata(path).map_err(CaError::Acl)?;
    if meta.file_type().is_symlink() {
        return Err(CaError::AclVerification("reparse point in CA path"));
    }
    let euid = effective_uid()?;
    let mode = meta.permissions().mode() & 0o777;
    Ok(AclReport {
        owner_is_current_user: meta.uid() == euid,
        dacl_protected: true,
        allowed_sids: vec!["owner".into()],
        untrusted_allow: Vec::new(),
        user_writable: mode & 0o200 != 0,
        mode: Some(mode),
    })
}

pub(crate) fn ensure_private_dir(path: &Path) -> CaResult<()> {
    reject_symlink_ancestors(path)?;
    if path.exists() {
        if !path.is_dir() {
            return Err(CaError::AclVerification("ca path is not a directory"));
        }
    } else {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path).map_err(CaError::Acl)?;
    }
    reject_symlink_ancestors(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(CaError::Acl)?;
    verify_private_dir(path).map(|_| ())
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8], readonly: bool) -> CaResult<()> {
    reject_symlink_ancestors(path)?;
    let mode = if readonly { 0o400 } else { 0o600 };
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true).mode(mode);
    #[cfg(target_os = "linux")]
    {
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(path).map_err(CaError::Acl)?;
    if let Err(err) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CaError::Acl(err));
    }
    drop(file);
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(CaError::Acl)?;
    if readonly {
        verify_private_key_file(path).map(|_| ())
    } else {
        verify_private_file(path).map(|_| ())
    }
}

pub(crate) fn inspect_private_dir(path: &Path) -> CaResult<AclReport> {
    inspect(path)
}

/// Forcibly remove a directory tree, including read-only CA key files.
///
/// Every directory is widened to 0700 and every file to 0600 (owner access
/// only) before removal, so a 0400 key never blocks its parent's cleanup.
/// Symlinks are removed as links and never followed. Shared by test cleanup,
/// staging cleanup after a key write, and the Task 7 production destroy path.
pub(crate) fn force_remove_dir_all(path: &Path) -> CaResult<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(CaError::Io(err)),
    };
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return fs::remove_file(path).map_err(CaError::Io);
    }
    if file_type.is_dir() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(CaError::Io)?;
        for entry in fs::read_dir(path).map_err(CaError::Io)? {
            let entry = entry.map_err(CaError::Io)?;
            force_remove_dir_all(&entry.path())?;
        }
        fs::remove_dir(path).map_err(CaError::Io)
    } else {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(CaError::Io)?;
        fs::remove_file(path).map_err(CaError::Io)
    }
}

pub(crate) fn inspect_private_file(path: &Path) -> CaResult<AclReport> {
    inspect(path)
}

pub(crate) fn verify_private_dir(path: &Path) -> CaResult<AclReport> {
    let report = inspect(path)?;
    let mode = report.mode.unwrap_or(0);
    if !report.owner_is_current_user || mode & 0o077 != 0 {
        return Err(CaError::AclVerification("directory is not owner-private"));
    }
    Ok(report)
}

pub(crate) fn verify_private_file(path: &Path) -> CaResult<AclReport> {
    let report = inspect(path)?;
    let mode = report.mode.unwrap_or(0);
    if !report.owner_is_current_user || mode & 0o077 != 0 {
        return Err(CaError::AclVerification("file is not owner-private"));
    }
    Ok(report)
}

pub(crate) fn verify_private_key_file(path: &Path) -> CaResult<AclReport> {
    let report = verify_private_file(path)?;
    if report.user_writable {
        return Err(CaError::AclVerification("private key is owner-writable"));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mr-ca-acl-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn private_dir_is_0700() {
        let dir = temp_dir("dir");
        let ca = dir.join("ca");
        ensure_private_dir(&ca).unwrap();
        let mode = std::fs::metadata(&ca).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let report = verify_private_dir(&ca).unwrap();
        assert_eq!(report.mode, Some(0o700));
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn private_key_is_0400_and_verifiable() {
        let dir = temp_dir("key");
        let file = dir.join("root.key");
        write_private_file(&file, b"secret", true).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o400);
        let report = verify_private_key_file(&file).unwrap();
        assert!(!report.user_writable);
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn force_remove_deletes_readonly_private_tree() {
        let dir = temp_dir("force");
        ensure_private_dir(&dir).unwrap();
        let nested = dir.join("roots").join("0001");
        std::fs::create_dir_all(&nested).unwrap();
        write_private_file(&nested.join("root.key"), b"secret", true).unwrap();
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn force_remove_does_not_follow_symlinks() {
        let dir = temp_dir("force-link");
        let outside = temp_dir("force-outside");
        let keep = outside.join("keep.txt");
        std::fs::write(&keep, b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
        assert!(keep.is_file(), "symlink targets must not be traversed");
        force_remove_dir_all(&outside).unwrap();
        assert!(!outside.exists());
    }

    #[test]
    fn loose_permissions_are_rejected() {
        let dir = temp_dir("loose");
        let file = dir.join("root.key");
        write_private_file(&file, b"secret", true).unwrap();
        let mut perms = std::fs::metadata(&file).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&file, perms).unwrap();
        let err = verify_private_key_file(&file).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn writable_key_mode_is_rejected() {
        let dir = temp_dir("writable-key");
        let file = dir.join("root.key");
        write_private_file(&file, b"secret", false).unwrap();
        assert!(verify_private_file(&file).is_ok());
        let err = verify_private_key_file(&file).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn symlinked_ancestor_is_rejected() {
        let dir = temp_dir("symlink");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let err = ensure_private_dir(&link.join("ca")).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }
}
