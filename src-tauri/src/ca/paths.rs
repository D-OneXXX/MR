use super::error::{CaError, CaResult};
use std::path::{Path, PathBuf};

pub const CA_SCHEMA: u32 = 1;

pub fn resolve_ca_root(env_override: Option<&str>, app_local: Option<&Path>) -> CaResult<PathBuf> {
    if let Some(raw) = env_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if !path.is_absolute() {
                return Err(CaError::RelativeCaRoot);
            }
            return Ok(path);
        }
    }
    let base = app_local.ok_or(CaError::DataDirUnavailable)?;
    Ok(base.join("security").join("ca"))
}

#[derive(Debug, Clone)]
pub struct CaPaths {
    root: PathBuf,
}

impl CaPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn root_dir(&self) -> &Path {
        &self.root
    }
    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
    pub fn events_file(&self) -> PathBuf {
        self.root.join("events").join("ca-events.jsonl")
    }
    pub fn root_generation_dir(&self, generation: u32) -> PathBuf {
        self.root.join("roots").join(format!("{generation:04}"))
    }
    pub fn intermediate_generation_dir(&self, generation: u32) -> PathBuf {
        self.root
            .join("intermediates")
            .join(format!("{generation:04}"))
    }
    pub fn staging_dir(&self, purpose: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.root
            .join("staging")
            .join(format!("{purpose}-{}-{nanos}", std::process::id()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Platform-neutral fixtures: `std::env::temp_dir()` is absolute on both
    // Windows (`C:\...\Temp`) and Unix (`/tmp`), unlike `C:/...` literals which
    // are not absolute on Unix.
    fn app_local_fixture() -> PathBuf {
        std::env::temp_dir().join("mr-ca-path-test-app-local")
    }

    fn override_fixture() -> PathBuf {
        std::env::temp_dir()
            .join("mr-ca-path-test-override")
            .join("ca")
    }

    #[test]
    fn relative_override_is_rejected() {
        let app_local = app_local_fixture();
        let err = resolve_ca_root(Some("relative/ca"), Some(app_local.as_path())).unwrap_err();
        assert_eq!(err.code(), "ca-root-relative");
    }

    #[test]
    fn absolute_override_wins() {
        let app_local = app_local_fixture();
        let override_root = override_fixture();
        let override_arg = override_root.to_string_lossy().into_owned();
        let got = resolve_ca_root(Some(&override_arg), Some(app_local.as_path())).unwrap();
        assert_eq!(got, override_root);
    }

    #[test]
    fn empty_override_is_ignored() {
        let app_local = app_local_fixture();
        let got = resolve_ca_root(Some("   "), Some(app_local.as_path())).unwrap();
        assert_eq!(got, app_local.as_path().join("security").join("ca"));
    }

    #[test]
    fn missing_app_local_fails_closed() {
        let err = resolve_ca_root(None, None).unwrap_err();
        assert_eq!(err.code(), "ca-data-dir-unavailable");
    }
}
