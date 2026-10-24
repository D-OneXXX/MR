//! 生产路径锚点：数据根 = Tauri `app_data_dir()`，缓存根 = Tauri `app_cache_dir()`。
//!
//! - 解析顺序：`MR_DATA_DIR`（测试/冒烟隔离）> Tauri `app_data_dir` > 旧版
//!   `dirs::data_local_dir()/com.local.manga-reader`；
//! - 绝不以 CWD 或 exe 同级目录作为数据根；
//! - 解析结果仅进程内保存（`OnceLock`），不写注册表、不写配置文件；
//! - 旧库迁移只做 best-effort 复制（库/安全模式/启动守卫），不删源文件、不复制缓存。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 旧数据目录里需要接续的文件；缓存目录不迁移（可重建）。
const LEGACY_FILES: [&str; 3] = ["library.db", "safe-mode.json", "crash-guard.json"];

/// 进程启动时登记一次（setup 中调用）。重复调用保留首次结果。
pub(crate) fn install(data: PathBuf, cache: PathBuf) {
    let _ = DATA_DIR.set(data);
    let _ = CACHE_DIR.set(cache);
}

pub(crate) fn data_dir() -> Option<&'static Path> {
    DATA_DIR.get().map(PathBuf::as_path)
}

pub(crate) fn cache_dir() -> Option<&'static Path> {
    CACHE_DIR.get().map(PathBuf::as_path)
}

/// Unix：数据/缓存目录只允许当前用户进入（0700），Windows 无操作。
pub(crate) fn harden_private_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut permissions = meta.permissions();
            if permissions.mode() & 0o777 != 0o700 {
                permissions.set_mode(0o700);
                let _ = std::fs::set_permissions(path, permissions);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Unix：书库/临时数据库只允许当前用户读写（0600），Windows 无操作。
pub(crate) fn harden_private_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut permissions = meta.permissions();
            if permissions.mode() & 0o777 != 0o600 {
                permissions.set_mode(0o600);
                let _ = std::fs::set_permissions(path, permissions);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 纯函数：决定数据根。空/纯空白的环境变量视为未设置。
pub(crate) fn resolve_data_root(
    mr_data_dir: Option<&str>,
    tauri_data: Option<PathBuf>,
    legacy: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(raw) = mr_data_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            // 绝不把 CWD 当作数据根：相对路径一律拒绝，由调用方回落到
            // Tauri app_data_dir / 旧目录（不能静默写到当前目录）。
            if !path.is_absolute() {
                return Err("MR_DATA_DIR 必须是绝对路径".to_string());
            }
            return Ok(path);
        }
    }
    tauri_data
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| legacy.filter(|p| !p.as_os_str().is_empty()))
        .ok_or_else(|| "无法定位本地数据目录".to_string())
}

/// 旧目录 → 新目录 best-effort 迁移。
///
/// 仅当目标缺失时复制；源文件保留（回滚安全）。返回值是给调用方写日志的
/// 人类可读条目（成功/失败各一条），本函数自身不落盘、不打印。
pub(crate) fn migrate_legacy_state(target: &Path, legacy: &Path) -> Vec<String> {
    let mut notes = Vec::new();
    if target == legacy {
        return notes;
    }
    for name in LEGACY_FILES {
        let src = legacy.join(name);
        let dst = target.join(name);
        if !src.is_file() || dst.exists() {
            continue;
        }
        // library.db 的 WAL 边车先到位，保证随后的 quick_check 能看到未
        // checkpoint 的已提交页；-shm 是可重建索引，不复制。
        if name == "library.db" {
            let side_src = legacy.join("library.db-wal");
            let side_dst = target.join("library.db-wal");
            if side_src.is_file() && !side_dst.exists() {
                let _ = copy_atomic(&side_src, &side_dst);
            }
        }
        match copy_atomic(&src, &dst) {
            Ok(bytes) => {
                notes.push(format!("{name}（{bytes} 字节）"));
                if name == "library.db" && !sqlite_quick_check_ok(&dst) {
                    // 只删掉本次复制出来的坏副本；源库保留，下次启动可重试。
                    let _ = std::fs::remove_file(&dst);
                    let _ = std::fs::remove_file(target.join("library.db-wal"));
                    notes.push("library.db 校验失败，已丢弃副本（源库保留）".to_string());
                }
            }
            Err(err) => notes.push(format!("{name} 复制失败：{err}")),
        }
    }
    notes
}

/// 复制到同目录临时文件再原子改名：进程中断最多留下 `.mr-migrating`，
/// 绝不会让目标出现“半截 library.db”并被 `dst.exists()` 永久跳过。
fn copy_atomic(src: &Path, dst: &Path) -> std::io::Result<u64> {
    let file_name = dst
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("migrating");
    let tmp = dst.with_file_name(format!(".{file_name}.mr-migrating"));
    let _ = std::fs::remove_file(&tmp);
    let bytes = std::fs::copy(src, &tmp)?;
    if let Err(err) = std::fs::rename(&tmp, dst) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(bytes)
}

/// 只对真正的 SQLite 文件执行 quick_check；测试用的占位字节不算数据库，
/// 也不应该让迁移失败。
fn sqlite_quick_check_ok(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 16];
    let is_sqlite = std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map(|_| &header == b"SQLite format 3\0")
        .unwrap_or(false);
    if !is_sqlite {
        return true;
    }
    rusqlite::Connection::open(path)
        .and_then(|conn| conn.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)))
        .map(|result| result == "ok")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("mr-paths-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn resolve_prefers_env_then_tauri_then_legacy() {
        let env = std::env::temp_dir().join("mr-env-data");
        let tauri = std::env::temp_dir().join("mr-tauri-data");
        let legacy = std::env::temp_dir().join("mr-legacy-data");

        assert_eq!(
            resolve_data_root(
                Some(env.to_str().unwrap()),
                Some(tauri.clone()),
                Some(legacy.clone())
            )
            .unwrap(),
            env
        );
        // 环境变量空白 → 视为未设置，落到 Tauri 目录。
        assert_eq!(
            resolve_data_root(Some("   "), Some(tauri.clone()), Some(legacy.clone())).unwrap(),
            tauri
        );
        // 相对环境变量必须拒绝，不能退回 CWD。
        assert!(resolve_data_root(Some("relative/cache"), Some(tauri.clone()), None).is_err());
        // Tauri 不可用 → 旧目录。
        assert_eq!(
            resolve_data_root(None, None, Some(legacy.clone())).unwrap(),
            legacy
        );
        // 全部缺失 → 明确报错，调用方不得退回 CWD。
        assert!(resolve_data_root(None, None, None).is_err());
        // 环境变量两端空白被 trim。
        let padded = format!("  {}  ", env.display());
        assert_eq!(
            resolve_data_root(Some(&padded), None, None).unwrap(),
            env
        );
    }

    #[test]
    fn migrate_only_fills_missing_files_and_keeps_sources() {
        let root = unique_temp_dir("migrate");
        let target = root.join("target");
        let legacy = root.join("legacy");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("library.db"), b"legacy-db").unwrap();
        std::fs::write(legacy.join("safe-mode.json"), b"{}").unwrap();

        let notes = migrate_legacy_state(&target, &legacy);
        assert_eq!(
            notes.len(),
            2,
            "应复制 library.db 与 safe-mode.json：{notes:?}"
        );
        assert_eq!(
            std::fs::read(target.join("library.db")).unwrap(),
            b"legacy-db"
        );
        assert_eq!(std::fs::read(target.join("safe-mode.json")).unwrap(), b"{}");
        assert!(legacy.join("library.db").exists(), "源文件不得删除");

        // 目标已存在 → 不覆盖（用户在新目录的数据优先）。
        std::fs::write(target.join("library.db"), b"new-db").unwrap();
        std::fs::write(legacy.join("crash-guard.json"), b"{\"count\":1}").unwrap();
        let notes = migrate_legacy_state(&target, &legacy);
        assert_eq!(notes.len(), 1, "只补缺失的 crash-guard.json：{notes:?}");
        assert_eq!(std::fs::read(target.join("library.db")).unwrap(), b"new-db");
        assert!(target.join("crash-guard.json").exists());

        // 同一路径不做任何事。
        assert!(migrate_legacy_state(&legacy, &legacy).is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_valid_sqlite_is_atomic_and_quick_checked() {
        let root = unique_temp_dir("migrate-sqlite");
        let target = root.join("target");
        let legacy = root.join("legacy");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        let src = legacy.join("library.db");
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(1);")
                .unwrap();
        }

        let notes = migrate_legacy_state(&target, &legacy);
        assert!(
            notes.iter().any(|note| note.starts_with("library.db（")),
            "应复制 library.db：{notes:?}"
        );
        let dst = target.join("library.db");
        let conn = rusqlite::Connection::open(&dst).unwrap();
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(check, "ok");
        assert!(
            !target
                .join(".library.db.mr-migrating")
                .exists(),
            "原子迁移不得留下临时文件"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn unix_private_paths_are_hardened() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_temp_dir("perms");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        harden_private_dir(&dir);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let file = dir.join("library.db");
        std::fs::write(&file, b"x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        harden_private_file(&file);
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
