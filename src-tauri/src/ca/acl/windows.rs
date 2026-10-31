//! Windows DACL backend: a protected DACL with explicit allow ACEs for the
//! current user and LOCAL SYSTEM only.
//!
//! Setting a security descriptor is not treated as success: every mutating
//! helper re-opens the object by name and verifies owner, protection flag and
//! the complete set of allow ACEs before returning.

use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_TYPE, TRUSTEE_W,
};
use windows::Win32::Security::{
    AclSizeInformation, CopySid, CreateWellKnownSid, GetAce, GetAclInformation, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation, TokenUser,
    WinLocalSystemSid, ACL, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    NO_INHERITANCE, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
    SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::AclReport;
use crate::ca::{CaError, CaResult};

/// `FILE_ALL_ACCESS`, used for the owner on directories.
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
/// `FILE_GENERIC_READ`, used for read-only key material and for LOCAL SYSTEM
/// on every private object.
const FILE_GENERIC_READ: u32 = 0x0012_0089;
/// `FILE_GENERIC_READ | FILE_GENERIC_WRITE`, used for writable data files.
const FILE_GENERIC_READ_WRITE: u32 = 0x0012_019F;
/// `FILE_GENERIC_EXECUTE` (`FILE_TRAVERSE` on directories), combined with
/// `FILE_GENERIC_READ` for LOCAL SYSTEM on directories so it can read but never
/// modify the CA tree.
const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
/// Specific rights that let the owner modify the object, its data or its ACL:
/// FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
/// DELETE | WRITE_DAC | WRITE_OWNER. Notably it excludes READ_CONTROL and
/// SYNCHRONIZE so that a read-only mask is not misclassified as writable.
const WRITE_ACCESS: u32 = 0x0001_0116 | 0x0004_0000 | 0x0008_0000;
/// `FILE_ATTRIBUTE_REPARSE_POINT`, defined locally so no additional crate
/// feature is required.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
/// `ACCESS_ALLOWED_ACE_TYPE`; the value lives in `Win32_System_SystemServices`
/// in this crate version, which is not an enabled feature, so it is defined
/// here as a byte constant matching `ACE_HEADER::AceType`.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

struct SidBuf(Vec<u8>);

impl SidBuf {
    fn as_psid(&self) -> PSID {
        PSID(self.0.as_ptr() as *mut _)
    }
}

struct AclFacts {
    report: AclReport,
    user_allow: bool,
    system_allow: bool,
    /// LOCAL SYSTEM must never hold write rights on a private CA object.
    system_write: bool,
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn current_user_sid() -> CaResult<SidBuf> {
    // SAFETY: the token handle is closed on every path and the returned buffer
    // is sized for TOKEN_USER plus the largest possible SID. The buffer is
    // allocated as `u64` words so its base is 8-byte aligned, which satisfies
    // TOKEN_USER's pointer alignment before the cast.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| CaError::Acl(e.into()))?;
        let bytes = std::mem::size_of::<TOKEN_USER>() + SECURITY_MAX_SID_SIZE as usize;
        let words = bytes.div_ceil(std::mem::size_of::<u64>());
        let mut buf = vec![0u64; words];
        let mut len = (words * std::mem::size_of::<u64>()) as u32;
        let result = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut _),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        result.map_err(|e| CaError::Acl(e.into()))?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid_len = GetLengthSid(user.User.Sid);
        if sid_len == 0 {
            return Err(CaError::AclVerification("token user unavailable"));
        }
        let mut sid = vec![0u8; sid_len as usize];
        CopySid(sid_len, PSID(sid.as_mut_ptr() as *mut _), user.User.Sid)
            .map_err(|e| CaError::Acl(e.into()))?;
        Ok(SidBuf(sid))
    }
}

fn system_sid() -> CaResult<SidBuf> {
    let mut buf = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut len = buf.len() as u32;
    // SAFETY: `buf` is SECURITY_MAX_SID_SIZE bytes, the documented maximum.
    unsafe {
        CreateWellKnownSid(
            WinLocalSystemSid,
            None,
            Some(PSID(buf.as_mut_ptr() as *mut _)),
            &mut len,
        )
        .map_err(|e| CaError::Acl(e.into()))?;
    }
    buf.truncate(len as usize);
    Ok(SidBuf(buf))
}

fn trustee(sid: &SidBuf, kind: TRUSTEE_TYPE) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: kind,
        ptstrName: PWSTR(sid.0.as_ptr() as *mut u16),
    }
}

fn sid_to_string(sid: PSID) -> Option<String> {
    // SAFETY: `sid` points into a security descriptor that outlives this call;
    // the returned string is copied and then released with LocalFree.
    unsafe {
        let mut raw = PWSTR::null();
        ConvertSidToStringSidW(sid, &mut raw).ok()?;
        if raw.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *raw.0.add(len) != 0 {
            len += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(raw.0, len));
        let _ = LocalFree(Some(HLOCAL(raw.0 as *mut _)));
        Some(value)
    }
}

fn reject_reparse_ancestors(path: &Path) -> CaResult<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(CaError::Acl)?.join(path)
    };
    let mut current: Option<PathBuf> = Some(absolute);
    while let Some(candidate) = current {
        match std::fs::symlink_metadata(&candidate) {
            Ok(meta) => {
                if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
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

fn owner_is_current_user(path: &Path, user: &SidBuf) -> CaResult<bool> {
    let mut owner = PSID(std::ptr::null_mut());
    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let path_w = wide(path);
    // SAFETY: `owner` and `sd` are valid out-parameters and the returned
    // descriptor is released on both the success and failure paths.
    let call = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(path_w.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut sd,
        )
    };
    let read = call.ok();
    let equal = if let Err(err) = read {
        Err(CaError::Acl(err.into()))
    } else if owner.is_invalid() {
        Ok(false)
    } else {
        // SAFETY: `owner` points into `sd`, which is still alive here.
        Ok(unsafe { windows::Win32::Security::EqualSid(owner, user.as_psid()) }.is_ok())
    };
    if !sd.0.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
    }
    equal
}

fn set_private_dacl(path: &Path, is_dir: bool, writable: bool) -> CaResult<()> {
    let user = current_user_sid()?;
    let system = system_sid()?;
    // Least privilege for LOCAL SYSTEM: read/execute on directories, read-only
    // on files. Only the current user may write, delete or change the ACL.
    let (user_mask, system_mask) = if is_dir {
        (FILE_ALL_ACCESS, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)
    } else if writable {
        (FILE_GENERIC_READ_WRITE, FILE_GENERIC_READ)
    } else {
        (FILE_GENERIC_READ, FILE_GENERIC_READ)
    };
    let inheritance = if is_dir {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        NO_INHERITANCE
    };
    let entries = [
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: user_mask,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: inheritance,
            Trustee: trustee(&user, TRUSTEE_IS_USER),
        },
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: system_mask,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: inheritance,
            Trustee: trustee(&system, TRUSTEE_IS_WELL_KNOWN_GROUP),
        },
    ];
    // Setting the owner requires WRITE_OWNER, which the owner does not hold
    // implicitly; a locked-down key would otherwise be impossible to re-ACL.
    // Skip the owner write when it is already correct and let the read-back
    // verification below remain authoritative either way.
    let set_owner = !owner_is_current_user(path, &user)?;
    let mut security_info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    if set_owner {
        security_info |= OWNER_SECURITY_INFORMATION;
    }
    let owner_arg = if set_owner {
        Some(user.as_psid())
    } else {
        None
    };
    let path_w = wide(path);
    // SAFETY: both SID buffers outlive the call; the ACL allocated by
    // SetEntriesInAclW is released on every path after SetNamedSecurityInfoW.
    unsafe {
        let mut acl: *mut ACL = std::ptr::null_mut();
        SetEntriesInAclW(Some(&entries), None, &mut acl)
            .ok()
            .map_err(|e| CaError::Acl(e.into()))?;
        let result = SetNamedSecurityInfoW(
            PCWSTR(path_w.as_ptr()),
            SE_FILE_OBJECT,
            security_info,
            owner_arg,
            None,
            Some(acl as *const ACL),
            None,
        );
        if !acl.is_null() {
            let _ = LocalFree(Some(HLOCAL(acl as *mut _)));
        }
        result.ok().map_err(|e| CaError::Acl(e.into()))?;
    }
    Ok(())
}

pub(crate) fn ensure_private_dir(path: &Path) -> CaResult<()> {
    reject_reparse_ancestors(path)?;
    std::fs::create_dir_all(path).map_err(CaError::Acl)?;
    // Re-check after creation so a component that appeared as a reparse point
    // in the meantime cannot be adopted.
    reject_reparse_ancestors(path)?;
    set_private_dacl(path, true, true)?;
    verify_private_dir(path).map(|_| ())
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8], readonly: bool) -> CaResult<()> {
    use std::io::Write;
    reject_reparse_ancestors(path)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(CaError::Acl)?;
    if let Err(err) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(CaError::Acl(err));
    }
    drop(file);
    // The read-only attribute must be set while the inherited DACL still
    // grants FILE_WRITE_ATTRIBUTES; the private key ACL below deliberately
    // drops that right so the owner can no longer flip the attribute.
    if readonly {
        let mut perms = std::fs::metadata(path).map_err(CaError::Acl)?.permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(path, perms).map_err(CaError::Acl)?;
    }
    set_private_dacl(path, false, !readonly)?;
    if readonly {
        verify_private_key_file(path).map(|_| ())
    } else {
        verify_private_file(path).map(|_| ())
    }
}

pub(crate) fn inspect_private_dir(path: &Path) -> CaResult<AclReport> {
    inspect(path).map(|facts| facts.report)
}

pub(crate) fn inspect_private_file(path: &Path) -> CaResult<AclReport> {
    inspect(path).map(|facts| facts.report)
}

pub(crate) fn verify_private_dir(path: &Path) -> CaResult<AclReport> {
    verify(inspect(path)?)
}

pub(crate) fn verify_private_file(path: &Path) -> CaResult<AclReport> {
    verify(inspect(path)?)
}

pub(crate) fn verify_private_key_file(path: &Path) -> CaResult<AclReport> {
    let report = verify_private_file(path)?;
    let readonly = std::fs::metadata(path)
        .map_err(CaError::Acl)?
        .permissions()
        .readonly();
    if report.user_writable || !readonly {
        return Err(CaError::AclVerification("private key is writable"));
    }
    Ok(report)
}

/// Re-grant a writable DACL, then clear the read-only attribute.
///
/// Key files carry the private key DACL, which deliberately omits
/// `FILE_WRITE_ATTRIBUTES` and `DELETE`; the attribute therefore cannot be
/// cleared before the ACL is widened. The owner always keeps implicit
/// `WRITE_DAC`, so this also works on an already locked-down key.
// Windows-only module. Clippy's `permissions_set_readonly_false` lint warns
// about world-writable modes on Unix; here the DACL was just re-granted to the
// current user and LOCAL SYSTEM only, so clearing the read-only attribute does
// not widen access on any platform this code compiles for.
#[allow(clippy::permissions_set_readonly_false)]
fn make_removable(path: &Path, is_dir: bool) -> CaResult<()> {
    set_private_dacl(path, is_dir, true)?;
    let mut permissions = std::fs::symlink_metadata(path)
        .map_err(CaError::Io)?
        .permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions).map_err(CaError::Io)?;
    }
    Ok(())
}

/// Remove a reparse point without ever traversing into its target. Junctions
/// are directory reparse points, file symlinks are not, so try both removal
/// calls rather than trusting `Metadata::is_dir` for every reparse kind.
fn remove_reparse_point(path: &Path) -> CaResult<()> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(dir_err) => std::fs::remove_file(path).map_err(|_| CaError::Io(dir_err)),
    }
}

/// Forcibly remove a directory tree, including read-only CA key files.
///
/// A plain recursive removal fails on private keys: the key DACL denies
/// `FILE_WRITE_ATTRIBUTES`/`DELETE` and the file is read-only. Every object is
/// re-granted a writable DACL (owner-only, still protected), its read-only
/// attribute is cleared, and only then is it removed. Reparse points are
/// deleted as links and never followed. Shared by test cleanup, staging
/// cleanup after a key write, and the Task 7 production destroy path.
pub(crate) fn force_remove_dir_all(path: &Path) -> CaResult<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(CaError::Io(err)),
    };
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return remove_reparse_point(path);
    }
    let is_dir = meta.is_dir();
    make_removable(path, is_dir)?;
    if is_dir {
        for entry in std::fs::read_dir(path).map_err(CaError::Io)? {
            let entry = entry.map_err(CaError::Io)?;
            force_remove_dir_all(&entry.path())?;
        }
        std::fs::remove_dir(path).map_err(CaError::Io)
    } else {
        std::fs::remove_file(path).map_err(CaError::Io)
    }
}

fn verify(facts: AclFacts) -> CaResult<AclReport> {
    let report = facts.report;
    if !report.owner_is_current_user {
        return Err(CaError::AclVerification("owner is not the current user"));
    }
    if !report.dacl_protected {
        return Err(CaError::AclVerification("DACL is not protected"));
    }
    if !facts.user_allow {
        return Err(CaError::AclVerification(
            "current user allow ACE is missing",
        ));
    }
    if !facts.system_allow {
        return Err(CaError::AclVerification("SYSTEM allow ACE is missing"));
    }
    if facts.system_write {
        return Err(CaError::AclVerification("SYSTEM has write access"));
    }
    if !report.untrusted_allow.is_empty() {
        return Err(CaError::AclVerification("untrusted allow ACE present"));
    }
    Ok(report)
}

fn inspect(path: &Path) -> CaResult<AclFacts> {
    reject_reparse_ancestors(path)?;
    let user = current_user_sid()?;
    let system = system_sid()?;
    let mut owner = PSID(std::ptr::null_mut());
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let path_w = wide(path);
    // SAFETY: pointers are valid out-parameters; the returned descriptor is
    // released below on both the success and failure paths.
    let call = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(path_w.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut dacl),
            None,
            &mut sd,
        )
    };
    if let Err(err) = call.ok() {
        if !sd.0.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(sd.0)));
            }
        }
        return Err(CaError::Acl(err.into()));
    }
    let result = parse_security_descriptor(sd, owner, &user, &system);
    if !sd.0.is_null() {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
    }
    result
}

fn parse_security_descriptor(
    sd: PSECURITY_DESCRIPTOR,
    owner: PSID,
    user: &SidBuf,
    system: &SidBuf,
) -> CaResult<AclFacts> {
    if sd.is_invalid() || owner.is_invalid() {
        return Err(CaError::AclVerification("security descriptor unavailable"));
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: `sd` is a valid descriptor returned by GetNamedSecurityInfoW.
    unsafe {
        GetSecurityDescriptorControl(sd, &mut control, &mut revision)
            .map_err(|e| CaError::Acl(e.into()))?;
    }
    let mut present = windows::core::BOOL(0);
    let mut defaulted = windows::core::BOOL(0);
    let mut acl_ptr: *mut ACL = std::ptr::null_mut();
    // SAFETY: out-parameters point to stack storage owned by this function.
    unsafe {
        GetSecurityDescriptorDacl(sd, &mut present, &mut acl_ptr, &mut defaulted)
            .map_err(|e| CaError::Acl(e.into()))?;
    }
    if !present.as_bool() || acl_ptr.is_null() {
        return Err(CaError::AclVerification("DACL is missing"));
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    // SAFETY: ACL_SIZE_INFORMATION is exactly the structure requested by
    // AclSizeInformation, and `acl_ptr` belongs to `sd`.
    unsafe {
        GetAclInformation(
            acl_ptr,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
        .map_err(|e| CaError::Acl(e.into()))?;
    }
    let mut allowed_sids = Vec::new();
    let mut untrusted_allow = Vec::new();
    let mut user_allow = false;
    let mut system_allow = false;
    let mut system_write = false;
    let mut user_write = false;
    for index in 0..info.AceCount {
        let mut ace_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        // SAFETY: the index is bounded by AceCount and `acl_ptr` is valid.
        if unsafe { GetAce(acl_ptr, index, &mut ace_ptr) }.is_err() || ace_ptr.is_null() {
            return Err(CaError::AclVerification("ACE unreadable"));
        }
        // SAFETY: an allow ACE always contains Mask and SidStart, and the
        // pointer was returned by GetAce for the live descriptor.
        let ace = unsafe { &*(ace_ptr as *const windows::Win32::Security::ACCESS_ALLOWED_ACE) };
        let ace_type = ace.Header.AceType;
        if ace_type != ACCESS_ALLOWED_ACE_TYPE {
            // Object, callback and compound ACEs (4, 5, 9, 11) can also grant
            // access but have a different layout. Fail closed instead of
            // silently ignoring a grant we cannot parse.
            if matches!(ace_type, 4 | 5 | 9 | 11) {
                untrusted_allow.push(format!("unsupported-allow-ace-type-{ace_type}"));
            }
            continue;
        }
        // SAFETY: SidStart is the first byte of the SID embedded in the ACE.
        let sid = PSID(&ace.SidStart as *const _ as *mut _);
        let display = sid_to_string(sid).unwrap_or_else(|| "unknown-sid".to_string());
        // SAFETY: both SIDs are valid; EqualSid only compares them.
        let is_user = unsafe { windows::Win32::Security::EqualSid(sid, user.as_psid()) }.is_ok();
        let is_system =
            unsafe { windows::Win32::Security::EqualSid(sid, system.as_psid()) }.is_ok();
        if is_user {
            user_allow = true;
            user_write |= ace.Mask & WRITE_ACCESS != 0;
        }
        if is_system {
            system_allow = true;
            system_write |= ace.Mask & WRITE_ACCESS != 0;
        }
        if is_user || is_system {
            allowed_sids.push(display);
        } else {
            untrusted_allow.push(display);
        }
    }
    // SAFETY: `owner` points into `sd`, which is still alive.
    let owner_is_current_user =
        unsafe { windows::Win32::Security::EqualSid(owner, user.as_psid()) }.is_ok();
    let dacl_protected = control & SE_DACL_PROTECTED.0 != 0;
    Ok(AclFacts {
        report: AclReport {
            owner_is_current_user,
            dacl_protected,
            allowed_sids,
            untrusted_allow,
            user_writable: user_write,
            mode: None,
        },
        user_allow,
        system_allow,
        system_write,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mr-ca-acl-win-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn private_dir_dacl_is_protected_and_owner_is_current_user() {
        let dir = temp_dir("dir");
        let ca = dir.join("ca");
        ensure_private_dir(&ca).unwrap();
        let report = verify_private_dir(&ca).unwrap();
        assert!(report.owner_is_current_user);
        assert!(report.dacl_protected);
        assert!(report.untrusted_allow.is_empty());
        assert_eq!(report.allowed_sids.len(), 2);
        assert!(report.user_writable);
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn private_key_is_readonly_and_verifiable() {
        let dir = temp_dir("key");
        // A private parent is what grants FILE_DELETE_CHILD for cleanup.
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("root.key");
        write_private_file(&file, b"secret", true).unwrap();
        let report = verify_private_key_file(&file).unwrap();
        assert!(!report.user_writable);
        assert!(std::fs::metadata(&file).unwrap().permissions().readonly());
        // The key ACL lacks FILE_WRITE_ATTRIBUTES and DELETE; the force destroy
        // primitive re-grants a writable DACL before clearing read-only.
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn force_remove_deletes_readonly_private_key_tree() {
        let dir = temp_dir("force");
        ensure_private_dir(&dir).unwrap();
        let nested = dir.join("roots").join("0001");
        ensure_private_dir(&nested).unwrap();
        write_private_file(&nested.join("root.key"), b"secret", true).unwrap();
        // A plain `remove_dir_all` cannot delete this key (read-only attribute
        // plus a DACL without FILE_WRITE_ATTRIBUTES/DELETE).
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn data_file_is_read_write_and_verifiable() {
        let dir = temp_dir("data");
        let file = dir.join("state.json");
        write_private_file(&file, b"{}", false).unwrap();
        let report = verify_private_file(&file).unwrap();
        assert!(report.user_writable);
        assert!(!std::fs::metadata(&file).unwrap().permissions().readonly());
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn inherited_dacl_is_rejected() {
        let dir = temp_dir("loose");
        let file = dir.join("plain.txt");
        std::fs::write(&file, b"plain").unwrap();
        let err = verify_private_file(&file).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn missing_readonly_attribute_is_rejected() {
        let dir = temp_dir("attr");
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("root.key");
        std::fs::write(&file, b"secret").unwrap();
        // Apply the private key ACL without the read-only attribute: the ACL
        // alone passes verify_private_file, but the key verifier must reject
        // the missing attribute.
        set_private_dacl(&file, false, false).unwrap();
        verify_private_file(&file).unwrap();
        let err = verify_private_key_file(&file).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn writable_key_acl_is_rejected() {
        let dir = temp_dir("writable-key");
        ensure_private_dir(&dir).unwrap();
        let file = dir.join("root.key");
        // Data-file ACL still grants FILE_WRITE_DATA; the read-only attribute
        // alone must not make it acceptable as key material.
        write_private_file(&file, b"secret", false).unwrap();
        let mut perms = std::fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).unwrap();
        verify_private_file(&file).unwrap();
        let err = verify_private_key_file(&file).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn junction_ancestor_is_rejected() {
        let dir = temp_dir("junction");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .status();
        let created = status.map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("junction creation unavailable; manual check required");
            force_remove_dir_all(&dir).unwrap();
            return;
        }
        let err = ensure_private_dir(&link.join("ca")).unwrap_err();
        assert_eq!(err.code(), "ca-acl-verification");
        // The force destroy removes the junction itself, never `real` through it.
        force_remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());
    }
}
