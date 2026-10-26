//! Cross-version local compatibility.
//!
//! `last_run_version` is stored inside the SQLite library database. A version
//! change never deletes books, reading progress, locale state or theme. Only
//! derived caches are invalidated, and only MAJOR/downgrade/unknown changes
//! clear the persistent render cache.

use rusqlite::Connection;

use crate::db;
use crate::source::BackendError;
use crate::Settings;

pub const LAST_RUN_VERSION_KEY: &str = "last_run_version";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl SemVer {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let value = raw.trim();
        let mut parts = value.split('.');
        let major = parts.next().unwrap_or_default();
        let minor = parts.next().unwrap_or_default();
        let patch = parts.next().unwrap_or_default();
        if parts.next().is_some()
            || [major, minor, patch]
                .iter()
                .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()))
        {
            return Err(format!("版本号不是 MAJOR.MINOR.PATCH：{value}"));
        }
        Ok(Self {
            major: major.parse().map_err(|_| "主版本溢出".to_string())?,
            minor: minor.parse().map_err(|_| "次版本溢出".to_string())?,
            patch: patch.parse().map_err(|_| "修订号溢出".to_string())?,
        })
    }

    pub fn compare(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionChange {
    FirstRun,
    Unchanged,
    Patch,
    Minor,
    Major,
    Downgrade,
    Unknown,
}

impl VersionChange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstRun => "first-run",
            Self::Unchanged => "unchanged",
            Self::Patch => "patch",
            Self::Minor => "minor",
            Self::Major => "major",
            Self::Downgrade => "downgrade",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPlan {
    pub previous: Option<String>,
    pub current: String,
    pub change: VersionChange,
    pub clear_memory_cache: bool,
    pub clear_disk_cache: bool,
}

pub fn plan(previous: Option<&str>, current: &str) -> MigrationPlan {
    let current_parsed = SemVer::parse(current);
    let Some(previous_raw) = previous.map(str::trim).filter(|value| !value.is_empty()) else {
        return MigrationPlan {
            previous: None,
            current: current.to_string(),
            change: VersionChange::FirstRun,
            clear_memory_cache: false,
            clear_disk_cache: false,
        };
    };
    if previous_raw == current {
        return MigrationPlan {
            previous: Some(previous_raw.to_string()),
            current: current.to_string(),
            change: VersionChange::Unchanged,
            clear_memory_cache: false,
            clear_disk_cache: false,
        };
    }
    let Some(previous_parsed) = SemVer::parse(previous_raw).ok() else {
        return MigrationPlan {
            previous: Some(previous_raw.to_string()),
            current: current.to_string(),
            change: VersionChange::Unknown,
            clear_memory_cache: true,
            clear_disk_cache: true,
        };
    };
    let Ok(current_parsed) = current_parsed else {
        return MigrationPlan {
            previous: Some(previous_raw.to_string()),
            current: current.to_string(),
            change: VersionChange::Unknown,
            clear_memory_cache: true,
            clear_disk_cache: true,
        };
    };
    let change = match current_parsed.compare(&previous_parsed) {
        std::cmp::Ordering::Equal => VersionChange::Unchanged,
        std::cmp::Ordering::Less => VersionChange::Downgrade,
        std::cmp::Ordering::Greater if current_parsed.major != previous_parsed.major => {
            VersionChange::Major
        }
        std::cmp::Ordering::Greater if current_parsed.minor != previous_parsed.minor => {
            VersionChange::Minor
        }
        std::cmp::Ordering::Greater => VersionChange::Patch,
    };
    let clear_disk_cache = matches!(
        change,
        VersionChange::Major | VersionChange::Downgrade | VersionChange::Unknown
    );
    MigrationPlan {
        previous: Some(previous_raw.to_string()),
        current: current.to_string(),
        change,
        clear_memory_cache: change != VersionChange::Unchanged,
        clear_disk_cache,
    }
}

pub fn read_last_run_version(conn: &Connection) -> Result<Option<String>, BackendError> {
    db::get_meta(conn, LAST_RUN_VERSION_KEY)
}

pub fn record_run_version(conn: &Connection, current: &str) -> Result<(), BackendError> {
    db::set_meta(conn, LAST_RUN_VERSION_KEY, current)
}

/// Validate only settings that could make the shell unusable. Valid user
/// preferences are never replaced. Returns a list of repaired keys for logs.
pub fn normalize_settings(
    conn: &Connection,
    settings: &mut Settings,
) -> Result<Vec<String>, BackendError> {
    let mut repaired = Vec::new();
    let theme = settings.theme.trim().to_ascii_lowercase();
    if !matches!(theme.as_str(), "system" | "light" | "dark") {
        settings.theme = "system".to_string();
        db::set_setting(conn, "theme", "system")?;
        repaired.push("theme".to_string());
    } else if theme != settings.theme {
        settings.theme = theme;
        db::set_setting(conn, "theme", &settings.theme)?;
        repaired.push("theme".to_string());
    }
    let budget = settings.cache_budget_mb.clamp(16, 2048);
    if budget != settings.cache_budget_mb {
        settings.cache_budget_mb = budget;
        db::set_setting(conn, "cache_budget_mb", &budget.to_string())?;
        repaired.push("cache_budget_mb".to_string());
    }
    let disk_budget = crate::disk_cache::clamp_budget_mb(settings.disk_cache_budget_mb);
    if disk_budget != settings.disk_cache_budget_mb {
        settings.disk_cache_budget_mb = disk_budget;
        db::set_setting(conn, "disk_cache_budget_mb", &disk_budget.to_string())?;
        repaired.push("disk_cache_budget_mb".to_string());
    }
    let concurrency = settings.online_concurrency.clamp(1, 8);
    if concurrency != settings.online_concurrency {
        settings.online_concurrency = concurrency;
        db::set_setting(conn, "online_concurrency", &concurrency.to_string())?;
        repaired.push("online_concurrency".to_string());
    }
    Ok(repaired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_schema;

    #[test]
    fn semver_parsing_is_strict() {
        assert_eq!(
            SemVer::parse("1.2.3").unwrap(),
            SemVer {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
        for invalid in ["", "1", "1.2", "1.2.3.4", "1.x.3", "1.2.3-beta"] {
            assert!(SemVer::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn migration_plan_maps_patch_minor_major_and_downgrade() {
        assert_eq!(plan(None, "1.0.0").change, VersionChange::FirstRun);
        assert_eq!(
            plan(Some("1.0.0"), "1.0.0").change,
            VersionChange::Unchanged
        );
        assert_eq!(plan(Some("1.0.0"), "1.0.1").change, VersionChange::Patch);
        assert_eq!(plan(Some("1.0.0"), "1.1.0").change, VersionChange::Minor);
        assert_eq!(plan(Some("1.0.0"), "2.0.0").change, VersionChange::Major);
        assert_eq!(
            plan(Some("2.0.0"), "1.9.9").change,
            VersionChange::Downgrade
        );
        assert_eq!(
            plan(Some("not-a-version"), "1.0.0").change,
            VersionChange::Unknown
        );
        assert_eq!(
            plan(Some("1.0.0"), "not-a-version").change,
            VersionChange::Unknown
        );
    }

    #[test]
    fn cache_cleanup_is_conservative_for_patch_and_minor() {
        let patch = plan(Some("1.0.0"), "1.0.1");
        assert!(patch.clear_memory_cache);
        assert!(!patch.clear_disk_cache);
        let minor = plan(Some("1.0.0"), "1.5.0");
        assert!(minor.clear_memory_cache);
        assert!(!minor.clear_disk_cache);
        let major = plan(Some("1.5.0"), "2.0.0");
        assert!(major.clear_memory_cache);
        assert!(major.clear_disk_cache);
        let same = plan(Some("1.0.0"), "1.0.0");
        assert!(!same.clear_memory_cache);
        assert!(!same.clear_disk_cache);
    }

    #[test]
    fn last_run_version_roundtrips_in_app_meta() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(read_last_run_version(&conn).unwrap(), None);
        record_run_version(&conn, "0.10.1").unwrap();
        assert_eq!(
            read_last_run_version(&conn).unwrap().as_deref(),
            Some("0.10.1")
        );
        record_run_version(&conn, "0.10.2").unwrap();
        assert_eq!(
            read_last_run_version(&conn).unwrap().as_deref(),
            Some("0.10.2")
        );
    }

    #[test]
    fn invalid_settings_are_repaired_without_touching_user_library() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut settings = Settings {
            theme: "BROKEN".to_string(),
            cache_budget_mb: 4,
            online_concurrency: 99,
            ..Settings::default()
        };
        let repaired = normalize_settings(&conn, &mut settings).unwrap();
        assert!(repaired.contains(&"theme".to_string()));
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.cache_budget_mb, 16);
        assert_eq!(settings.online_concurrency, 8);
        assert_eq!(
            db::get_setting(&conn, "theme").unwrap().as_deref(),
            Some("system")
        );
    }
}
