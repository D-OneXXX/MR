//! Private ACL enforcement for CA material.
//!
//! Windows uses a protected DACL with explicit allow ACEs for the current user
//! and LOCAL SYSTEM only; Unix uses 0700/0400/0600 modes. Both backends read
//! the result back instead of trusting the set operation.
//!
//! Both backends also provide `force_remove_dir_all`, which re-grants a
//! writable ACL/mode before deleting, so read-only private keys do not make a
//! tree undeletable (test cleanup, staging cleanup, Task 7 destroy).

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(crate) use unix::{
    ensure_private_dir, force_remove_dir_all, inspect_private_dir, inspect_private_file,
    verify_private_dir, verify_private_file, verify_private_key_file, write_private_file,
};
#[cfg(windows)]
pub(crate) use windows::{
    ensure_private_dir, force_remove_dir_all, inspect_private_dir, inspect_private_file,
    verify_private_dir, verify_private_file, verify_private_key_file, write_private_file,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclReport {
    pub owner_is_current_user: bool,
    pub dacl_protected: bool,
    pub allowed_sids: Vec<String>,
    pub untrusted_allow: Vec<String>,
    pub user_writable: bool,
    pub mode: Option<u32>,
}
