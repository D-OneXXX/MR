//! 本地备份 / 恢复（`.mrbackup` = zip 容器）。
//!
//! 备份只包含轻量核心资产，绝不包含图片缓存：
//! - `manifest.json`：格式、schema、应用版本、创建时间、计数与排除项；
//! - `library.db`：**净化后**的 SQLite 一致性快照（不含 `online_headers`、
//!   `online_filter_events`、`app_meta`，并 `VACUUM` 抹除空闲页残留）；
//! - `preferences.json`（可选）：前端白名单偏好（主题/语言/阅读器偏好），
//!   后端只校验「JSON 对象 + ≤64 KiB」并透传，不读取也不理解 localStorage。
//!
//! 安全红线：
//! - 会话请求头只驻留内存；导出时先删除 `settings.online_headers`，恢复时也绝不
//!   用备份里的值覆盖当前凭据；
//! - 浏览痕迹（`online_filter_events`，含脱敏 URL）与内部版本标记（`app_meta`）不迁移；
//! - 错误消息只允许出现固定文案 / 压缩包条目名，不输出任何 URL、凭据或偏好内容。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db;
use crate::state::AppState;

const BACKUP_FORMAT: &str = "mangareader-backup";
const BACKUP_SCHEMA: u32 = 1;
/// 压缩包条目数上限（正常备份只有 2~3 个条目，宽松留给未来扩展）。
const MAX_ZIP_ENTRIES: usize = 16;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
/// 导出时前端偏好上限（白名单偏好通常 <2 KiB）。
const MAX_PREFERENCES_BYTES: usize = 64 * 1024;
/// 导入时允许的偏好上限（宽松一档，避免旧版本导出被误拒）。
const MAX_RESTORE_PREFERENCES_BYTES: usize = 256 * 1024;
const MAX_DB_BYTES: u64 = 1024 * 1024 * 1024;

const EXCLUDED_ASSETS: &[&str] = &[
    "caches",
    "online_headers",
    "online_filter_events",
    "app_meta",
];

/// 恢复时必须存在且会被复制的表。
const REQUIRED_TABLES: &[&str] = &[
    "books",
    "reading_log",
    "settings",
    "online_filter_profiles",
    "online_filter_rules",
];

/// 显式列复制：顺序即 INSERT 列顺序，避免依赖 `SELECT *`。
const BOOK_COLUMNS: &[&str] = &[
    "id",
    "path",
    "title",
    "page_count",
    "current_page",
    "updated_at",
    "removed",
    "scroll_pct",
    "source_type",
    "meta_json",
];
const READING_LOG_COLUMNS: &[&str] = &["date", "book_id", "pages"];
const PROFILE_COLUMNS: &[&str] = &[
    "host",
    "main_selector",
    "cdn_pattern",
    "width_min",
    "width_max",
    "aspect_max",
    "uses",
    "updated_at",
];
const RULE_COLUMNS: &[&str] = &[
    "id",
    "host",
    "action",
    "source",
    "pattern_json",
    "reason",
    "created_at",
    "hits",
];

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
    pub books: u32,
    pub reading_days: u32,
    pub rules: u32,
    pub profiles: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    pub path: String,
    pub bytes: u64,
    pub books: u32,
    pub reading_days: u32,
    pub rules: u32,
    pub profiles: u32,
    pub preferences_included: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResult {
    pub books: u32,
    pub reading_days: u32,
    pub rules: u32,
    pub profiles: u32,
    pub preferences_json: Option<String>,
    pub created_at: Option<String>,
    pub app_version: Option<String>,
}

/// `manifest.json`（格式固定，schema=1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    schema: u32,
    app_version: String,
    created_at: String,
    counts: BackupCounts,
    #[serde(default)]
    excludes: Vec<String>,
}

// ---------- Tauri 命令（只负责 spawn_blocking + 状态刷新） ----------

#[tauri::command]
pub async fn export_backup(
    state: State<'_, Arc<AppState>>,
    dest_path: String,
    preferences_json: Option<String>,
) -> Result<BackupExportResult, String> {
    let db_path = state.db_path();
    let dest = PathBuf::from(dest_path);
    tokio::task::spawn_blocking(move || {
        export_backup_blocking(
            &db_path,
            &dest,
            preferences_json.as_deref(),
            env!("CARGO_PKG_VERSION"),
        )
    })
    .await
    .map_err(|e| format!("后台任务失败：{e}"))?
}

#[tauri::command]
pub async fn import_backup(
    state: State<'_, Arc<AppState>>,
    source_path: String,
) -> Result<BackupRestoreResult, String> {
    let db_path = state.db_path();
    let source = PathBuf::from(source_path);
    let result = tokio::task::spawn_blocking(move || restore_backup_blocking(&db_path, &source))
        .await
        .map_err(|e| format!("后台任务失败：{e}"))??;
    // 事务提交且阻塞连接已释放后再回读设置，避免在持锁状态下刷新缓存。
    refresh_after_restore(state.inner())?;
    Ok(result)
}

/// 恢复成功后刷新内存态：回读设置 → 修复越界 → 写回 → 清空派生缓存与源句柄。
fn refresh_after_restore(state: &AppState) -> Result<(), String> {
    let mut settings = crate::Settings::default();
    state.db.with(|conn| {
        crate::hydrate_settings(conn, &mut settings);
        crate::versioning::normalize_settings(conn, &mut settings).map_err(|e| e.to_string())?;
        Ok(())
    })?;
    state
        .cache
        .set_budgets((settings.cache_budget_mb.max(16) as u64) * 1024 * 1024);
    *state.settings.lock() = settings;
    state.cache.clear_pages();
    state.cache.clear_thumbs();
    state.webtoon_layouts.lock().clear();
    state.render.clear_all();
    state.online_cache.clear_all();
    state.invalidate_sources();
    Ok(())
}

// ---------- 导出（阻塞、可单测） ----------

fn export_backup_blocking(
    db_path: &Path,
    dest: &Path,
    preferences: Option<&str>,
    app_version: &str,
) -> Result<BackupExportResult, String> {
    validate_dest(dest)?;
    if dest == db_path {
        return Err("备份目标不能是书库数据库".into());
    }
    if !db_path.is_file() {
        return Err("书库数据库不存在".into());
    }
    let preferences = normalize_preferences(preferences)?;

    // 1) 一致性快照：VACUUM INTO 唯一临时文件（系统临时目录，用户私有）。
    let snapshot = TempFileGuard::new(unique_temp_path("snapshot"));
    let snapshot_str = snapshot
        .path()
        .to_str()
        .ok_or_else(|| "临时目录路径不是 UTF-8".to_string())?;
    {
        let conn = db::open(db_path).map_err(|e| format!("打开书库失败：{e}"))?;
        conn.execute("VACUUM INTO ?1", params![snapshot_str])
            .map_err(|e| format!("创建书库快照失败：{e}"))?;
    }

    // 2) 净化快照：删除凭据 / 浏览痕迹 / 内部标记，VACUUM 抹除空闲页，切独立日志模式。
    let counts = {
        let conn =
            Connection::open(snapshot.path()).map_err(|e| format!("打开书库快照失败：{e}"))?;
        sanitize_snapshot(&conn)?;
        count_core_rows(&conn)?
    };

    let db_bytes = fs::metadata(snapshot.path())
        .map_err(|e| format!("读取书库快照大小失败：{e}"))?
        .len();
    if db_bytes > MAX_DB_BYTES {
        return Err("书库数据库超过 1 GiB 备份上限".into());
    }

    let created_at = db::now_str();
    let manifest = BackupManifest {
        format: BACKUP_FORMAT.to_string(),
        schema: BACKUP_SCHEMA,
        app_version: app_version.to_string(),
        created_at: created_at.clone(),
        counts: counts.clone(),
        excludes: EXCLUDED_ASSETS.iter().map(|v| (*v).to_string()).collect(),
    };

    // 3) 同目录唯一 .tmp → 完整写入后替换目标，任何错误由 guard 清理半成品。
    let temp = TempFileGuard::new(temp_dest_path(dest)?);
    write_backup_zip(
        temp.path(),
        &manifest,
        snapshot.path(),
        preferences.as_deref(),
    )?;
    if dest.exists() {
        fs::remove_file(dest).map_err(|e| format!("替换旧备份失败：{e}"))?;
    }
    fs::rename(temp.path(), dest).map_err(|e| format!("写入备份文件失败：{e}"))?;

    let bytes = fs::metadata(dest)
        .map_err(|e| format!("读取备份文件大小失败：{e}"))?
        .len();
    crate::logging::log_error(
        "backup",
        &format!(
            "本地备份已导出：books={} readingDays={} rules={} profiles={} preferences={}",
            counts.books,
            counts.reading_days,
            counts.rules,
            counts.profiles,
            preferences.is_some()
        ),
    );
    Ok(BackupExportResult {
        path: dest.display().to_string(),
        bytes,
        books: counts.books,
        reading_days: counts.reading_days,
        rules: counts.rules,
        profiles: counts.profiles,
        preferences_included: preferences.is_some(),
        created_at,
    })
}

fn validate_dest(dest: &Path) -> Result<(), String> {
    if !dest.is_absolute() {
        return Err("备份目标必须是绝对路径".into());
    }
    if dest.is_dir() {
        return Err("备份目标不能是目录".into());
    }
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "备份目标缺少父目录".to_string())?;
    if !parent.is_dir() {
        return Err("备份目标目录不存在".into());
    }
    Ok(())
}

/// 只接受 JSON 对象且 ≤64 KiB；重新序列化为 pretty 后写入备份（不改变语义）。
fn normalize_preferences(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_PREFERENCES_BYTES {
        return Err("偏好数据过大（上限 64 KiB）".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("偏好数据不是有效 JSON：{e}"))?;
    if !value.is_object() {
        return Err("偏好数据必须是 JSON 对象".into());
    }
    let pretty =
        serde_json::to_string_pretty(&value).map_err(|e| format!("偏好数据序列化失败：{e}"))?;
    Ok(Some(pretty))
}

fn sanitize_snapshot(conn: &Connection) -> Result<(), String> {
    if table_exists(conn, "settings")? {
        conn.execute("DELETE FROM settings WHERE k='online_headers'", [])
            .map_err(|e| format!("净化备份设置失败：{e}"))?;
    }
    if table_exists(conn, "online_filter_events")? {
        conn.execute("DELETE FROM online_filter_events", [])
            .map_err(|e| format!("净化备份浏览痕迹失败：{e}"))?;
    }
    if table_exists(conn, "app_meta")? {
        conn.execute("DELETE FROM app_meta", [])
            .map_err(|e| format!("净化备份内部标记失败：{e}"))?;
    }
    // VACUUM 重写整库，删除页里的残留内容不会随空闲页一起泄露。
    conn.execute_batch("VACUUM;")
        .map_err(|e| format!("压缩备份快照失败：{e}"))?;
    let mode: String = conn
        .query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))
        .map_err(|e| format!("切换备份快照日志模式失败：{e}"))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err("备份快照无法切换到独立日志模式".into());
    }
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("备份快照完整性校验失败：{e}"))?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err("备份快照完整性校验失败".into());
    }
    Ok(())
}

fn write_backup_zip(
    path: &Path,
    manifest: &BackupManifest,
    db_snapshot: &Path,
    preferences: Option<&str>,
) -> Result<(), String> {
    let file = File::create(path).map_err(|e| format!("创建备份文件失败：{e}"))?;
    let mut zip = ZipWriter::new(file);
    let json_options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let manifest_json =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("备份清单序列化失败：{e}"))?;
    zip.start_file("manifest.json", json_options)
        .map_err(|e| format!("写入备份清单失败：{e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("写入备份清单失败：{e}"))?;

    if let Some(preferences) = preferences {
        zip.start_file("preferences.json", json_options)
            .map_err(|e| format!("写入备份偏好失败：{e}"))?;
        zip.write_all(preferences.as_bytes())
            .map_err(|e| format!("写入备份偏好失败：{e}"))?;
    }

    // SQLite 快照本身已紧凑，直接 Stored，避免为省几 MB 付出明显 CPU。
    zip.start_file(
        "library.db",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|e| format!("写入备份数据库失败：{e}"))?;
    let mut db = File::open(db_snapshot).map_err(|e| format!("读取书库快照失败：{e}"))?;
    std::io::copy(&mut db, &mut zip).map_err(|e| format!("写入备份数据库失败：{e}"))?;

    let mut file = zip
        .finish()
        .map_err(|e| format!("完成备份压缩包失败：{e}"))?;
    file.flush().map_err(|e| format!("落盘备份文件失败：{e}"))?;
    file.sync_all()
        .map_err(|e| format!("落盘备份文件失败：{e}"))?;
    Ok(())
}

// ---------- 恢复（阻塞、可单测） ----------

fn restore_backup_blocking(db_path: &Path, source: &Path) -> Result<BackupRestoreResult, String> {
    if !source.is_file() {
        return Err("备份文件不存在或不是文件".into());
    }
    if !db_path.is_file() {
        return Err("书库数据库不存在".into());
    }
    let file = File::open(source).map_err(|e| format!("打开备份文件失败：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("备份压缩包无效：{e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!("备份压缩包条目过多（上限 {MAX_ZIP_ENTRIES}）"));
    }

    // 第一遍：只读取条目名与未压缩大小，不解压；任何路径穿越/重复条目直接拒绝。
    let mut manifest_index: Option<usize> = None;
    let mut db_index: Option<usize> = None;
    let mut prefs_index: Option<usize> = None;
    for index in 0..archive.len() {
        let name = {
            let entry = archive
                .by_index_raw(index)
                .map_err(|e| format!("读取备份条目失败：{e}"))?;
            entry.name().to_string()
        };
        if name.is_empty()
            || name.contains('\0')
            || name.contains('/')
            || name.contains('\\')
            || name.contains("..")
        {
            return Err(format!("备份包含非法条目名：{name}"));
        }
        let slot = match name.as_str() {
            "manifest.json" => &mut manifest_index,
            "library.db" => &mut db_index,
            "preferences.json" => &mut prefs_index,
            _ => continue,
        };
        if slot.replace(index).is_some() {
            return Err(format!("备份包含重复条目：{name}"));
        }
    }

    let manifest_index = manifest_index.ok_or_else(|| "备份缺少 manifest.json".to_string())?;
    let db_index = db_index.ok_or_else(|| "备份缺少 library.db".to_string())?;

    let manifest_bytes = read_entry_limited(
        &mut archive,
        manifest_index,
        MAX_MANIFEST_BYTES,
        "manifest.json",
    )?;
    let manifest: BackupManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("备份清单损坏：{e}"))?;
    if manifest.format != BACKUP_FORMAT {
        return Err("不是 MangaReader 备份文件".into());
    }
    if manifest.schema != BACKUP_SCHEMA {
        return Err(format!("不支持的备份格式版本：{}", manifest.schema));
    }

    let preferences_json = match prefs_index {
        Some(index) => {
            let bytes = read_entry_limited(
                &mut archive,
                index,
                MAX_RESTORE_PREFERENCES_BYTES,
                "preferences.json",
            )?;
            let text = String::from_utf8(bytes)
                .map_err(|_| "preferences.json 不是 UTF-8 文本".to_string())?;
            serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|_| "preferences.json 不是有效 JSON".to_string())?;
            Some(text)
        }
        None => None,
    };

    // 只把 library.db 解压到系统临时目录的唯一文件（create_new），未知条目不落盘。
    let extracted = TempFileGuard::new(unique_temp_path("restore"));
    extract_db_entry(&mut archive, db_index, extracted.path())?;
    drop(archive);

    // 校验全部通过之前绝不触碰活库。
    let counts = validate_restored_db(extracted.path(), &manifest)?;
    apply_restore(db_path, extracted.path())?;

    let created_at = (!manifest.created_at.trim().is_empty()).then_some(manifest.created_at);
    let app_version = (!manifest.app_version.trim().is_empty()).then_some(manifest.app_version);
    crate::logging::log_error(
        "backup",
        &format!(
            "本地备份已恢复：books={} readingDays={} rules={} profiles={} preferences={}",
            counts.books,
            counts.reading_days,
            counts.rules,
            counts.profiles,
            preferences_json.is_some()
        ),
    );
    Ok(BackupRestoreResult {
        books: counts.books,
        reading_days: counts.reading_days,
        rules: counts.rules,
        profiles: counts.profiles,
        preferences_json,
        created_at,
        app_version,
    })
}

fn read_entry_limited(
    archive: &mut ZipArchive<File>,
    index: usize,
    cap: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let declared = {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("读取 {label} 失败：{e}"))?;
        entry.size()
    };
    if declared > cap as u64 {
        return Err(format!("{label} 超过大小上限（{cap} 字节）"));
    }
    // take(cap+1)：即使 zip 头声明的 size 被伪造，也不会无限读入内存。
    let mut reader = archive
        .by_index(index)
        .map_err(|e| format!("读取 {label} 失败：{e}"))?
        .take(cap as u64 + 1);
    let mut data = Vec::new();
    reader
        .read_to_end(&mut data)
        .map_err(|e| format!("读取 {label} 失败：{e}"))?;
    if data.len() > cap {
        return Err(format!("{label} 超过大小上限（{cap} 字节）"));
    }
    Ok(data)
}

fn extract_db_entry(
    archive: &mut ZipArchive<File>,
    index: usize,
    dest: &Path,
) -> Result<(), String> {
    let declared = {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("读取 library.db 失败：{e}"))?;
        entry.size()
    };
    if declared > MAX_DB_BYTES {
        return Err("library.db 超过大小上限（1 GiB）".into());
    }
    let mut reader = archive
        .by_index(index)
        .map_err(|e| format!("读取 library.db 失败：{e}"))?
        .take(MAX_DB_BYTES + 1);
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|e| format!("创建备份临时库失败：{e}"))?;
    let copied =
        std::io::copy(&mut reader, &mut out).map_err(|e| format!("解压备份数据库失败：{e}"))?;
    out.sync_all()
        .map_err(|e| format!("落盘备份临时库失败：{e}"))?;
    if copied > MAX_DB_BYTES {
        return Err("library.db 超过大小上限（1 GiB）".into());
    }
    Ok(())
}

fn validate_restored_db(path: &Path, manifest: &BackupManifest) -> Result<BackupCounts, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开备份数据库失败：{e}"))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| format!("备份数据库完整性校验失败：{e}"))?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err("备份数据库完整性校验失败".into());
    }
    for table in REQUIRED_TABLES {
        if !table_exists(&conn, table)? {
            return Err(format!("备份数据库缺少表：{table}"));
        }
    }
    require_columns(&conn, "books", BOOK_COLUMNS)?;
    require_columns(&conn, "reading_log", READING_LOG_COLUMNS)?;
    require_columns(&conn, "online_filter_profiles", PROFILE_COLUMNS)?;
    require_columns(&conn, "online_filter_rules", RULE_COLUMNS)?;
    require_columns(&conn, "settings", &["k", "v"])?;

    let counts = count_core_rows(&conn)?;
    if counts != manifest.counts {
        return Err("备份清单计数与数据库不一致".into());
    }
    Ok(counts)
}

fn apply_restore(db_path: &Path, backup_db: &Path) -> Result<(), String> {
    let backup = backup_db
        .to_str()
        .ok_or_else(|| "备份临时路径不是 UTF-8".to_string())?;
    // 活库连接仍走唯一入口 db::open（WAL + busy_timeout + foreign_keys）。
    let conn = db::open(db_path).map_err(|e| format!("打开书库失败：{e}"))?;
    conn.execute("ATTACH DATABASE ?1 AS backup_db", params![backup])
        .map_err(|e| format!("挂载备份数据库失败：{e}"))?;
    let applied = copy_from_backup(&conn);
    let detached = conn
        .execute("DETACH DATABASE backup_db", [])
        .map_err(|e| format!("卸载备份数据库失败：{e}"));
    match (applied, detached) {
        (Ok(()), Ok(_)) => Ok(()),
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
    }
}

fn copy_from_backup(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("开始恢复事务失败：{e}"))?;
    match copy_all_tables(conn) {
        Ok(()) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("提交恢复事务失败：{error}"))
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn copy_all_tables(conn: &Connection) -> Result<(), String> {
    let mut sql = String::from(
        "DELETE FROM online_filter_events;
         DELETE FROM online_filter_rules;
         DELETE FROM online_filter_profiles;
         DELETE FROM reading_log;
         DELETE FROM books;
         DELETE FROM settings WHERE k <> 'online_headers';
         INSERT INTO settings(k, v)
            SELECT k, v FROM backup_db.settings WHERE k <> 'online_headers';",
    );
    sql.push_str(&copy_sql("books", BOOK_COLUMNS));
    sql.push_str(&copy_sql("reading_log", READING_LOG_COLUMNS));
    sql.push_str(&copy_sql("online_filter_profiles", PROFILE_COLUMNS));
    sql.push_str(&copy_sql("online_filter_rules", RULE_COLUMNS));
    conn.execute_batch(&sql)
        .map_err(|e| format!("写入恢复数据失败：{e}"))?;
    Ok(())
}

/// 表名/列名全部来自本文件常量，不拼接外部输入。
fn copy_sql(table: &str, columns: &[&str]) -> String {
    let cols = columns.join(", ");
    format!("INSERT INTO {table}({cols}) SELECT {cols} FROM backup_db.{table};\n")
}

// ---------- 通用小工具 ----------

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![table],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取数据库结构失败：{e}"))?;
    Ok(count > 0)
}

fn count_rows(conn: &Connection, table: &str) -> Result<u32, String> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| format!("读取备份计数失败：{e}"))?;
    Ok(count.clamp(0, u32::MAX as i64) as u32)
}

fn count_core_rows(conn: &Connection) -> Result<BackupCounts, String> {
    Ok(BackupCounts {
        books: count_rows(conn, "books")?,
        reading_days: count_rows(conn, "reading_log")?,
        rules: count_rows(conn, "online_filter_rules")?,
        profiles: count_rows(conn, "online_filter_profiles")?,
    })
}

fn require_columns(conn: &Connection, table: &str, columns: &[&str]) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("读取备份表结构失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取备份表结构失败：{e}"))?;
    let mut existing = Vec::new();
    for row in rows {
        existing.push(row.map_err(|e| format!("读取备份表结构失败：{e}"))?);
    }
    for column in columns {
        if !existing.iter().any(|name| name == column) {
            return Err(format!("备份数据库表 {table} 缺少列：{column}"));
        }
    }
    Ok(())
}

fn unique_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{nanos}-{seq}", std::process::id())
}

fn unique_temp_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("mr-backup-{tag}-{}.db", unique_token()))
}

fn temp_dest_path(dest: &Path) -> Result<PathBuf, String> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "备份目标缺少父目录".to_string())?;
    Ok(parent.join(format!(".mr-backup-{}.tmp", unique_token())))
}

/// 删除唯一临时文件及其日志旁文件（`-wal` / `-shm` / `-journal`）。
struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut raw = self.path.as_os_str().to_os_string();
            raw.push(suffix);
            let _ = fs::remove_file(PathBuf::from(raw));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::filter::{FilterAction, FilterRule, RulePattern, RuleSource, SiteProfile};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mr-backup-test-{tag}-{}", unique_token()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(host: &str) -> SiteProfile {
        SiteProfile {
            host: host.into(),
            main_selector: Some(".reader".into()),
            cdn_pattern: Some(format!("https://{host}/ch/#/#.jpg")),
            width_min: Some(700),
            width_max: Some(1000),
            aspect_max: Some(2.8),
            uses: 3,
            updated_at: "2026-10-23 10:00:00".into(),
        }
    }

    fn rule(id: &str, host: &str) -> FilterRule {
        FilterRule {
            id: id.into(),
            host: host.into(),
            action: FilterAction::Block,
            source: RuleSource::User,
            pattern: RulePattern::UrlTemplate {
                template: format!("https://{host}/extras/#.png"),
            },
            reason: "user".into(),
            created_at: "2026-10-23 10:00:00".into(),
            hits: 2,
        }
    }

    fn seed(conn: &Connection) {
        db::upsert_book(conn, "b1", "p/b1", "第一卷", 30).unwrap();
        db::upsert_book(conn, "b2", "p/b2", "第二卷", 10).unwrap();
        db::set_progress(conn, "b1", 12, Some(0.5)).unwrap();
        db::set_setting(conn, "theme", "dark").unwrap();
        db::set_setting(conn, "online_headers", "Cookie: secret=1").unwrap();
        db::set_meta(conn, "last_run_version", "0.15.0").unwrap();
        db::upsert_filter_profile(conn, &profile("example.com")).unwrap();
        db::upsert_filter_rule(conn, &rule("r1", "example.com")).unwrap();
        db::record_filter_event(
            conn,
            "example.com",
            "b1",
            "https://example.com/x.png",
            "blocked",
            "user",
            Some(800),
            Some(1200),
            None,
        )
        .unwrap();
    }

    fn seeded_db(dir: &Path) -> PathBuf {
        let path = dir.join("library.db");
        let conn = db::open(&path).unwrap();
        db::init_schema(&conn).unwrap();
        seed(&conn);
        path
    }

    fn zip_entry_bytes(path: &Path, name: &str) -> Vec<u8> {
        let file = File::open(path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        bytes
    }

    fn write_raw_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_test_zip(
        path: &Path,
        manifest: Option<&[u8]>,
        db_path: Option<&Path>,
        preferences: Option<&[u8]>,
    ) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        if let Some(manifest) = manifest {
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(manifest).unwrap();
        }
        if let Some(preferences) = preferences {
            zip.start_file("preferences.json", options).unwrap();
            zip.write_all(preferences).unwrap();
        }
        if let Some(db_path) = db_path {
            zip.start_file("library.db", options).unwrap();
            let mut db = File::open(db_path).unwrap();
            std::io::copy(&mut db, &mut zip).unwrap();
        }
        zip.finish().unwrap();
    }

    fn manifest_json(counts: &BackupCounts) -> String {
        serde_json::to_string(&BackupManifest {
            format: BACKUP_FORMAT.into(),
            schema: BACKUP_SCHEMA,
            app_version: "0.15.0".into(),
            created_at: db::now_str(),
            counts: counts.clone(),
            excludes: EXCLUDED_ASSETS.iter().map(|v| (*v).to_string()).collect(),
        })
        .unwrap()
    }

    /// 从备份里取出 library.db 并落成独立文件，返回只读结果。
    fn exported_db(backup: &Path, dir: &Path) -> PathBuf {
        let bytes = zip_entry_bytes(backup, "library.db");
        let path = dir.join("exported.db");
        fs::write(&path, bytes).unwrap();
        path
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn export_then_restore_recovers_core_assets_and_keeps_live_headers() {
        let dir = temp_dir("roundtrip");
        let db_path = seeded_db(&dir);
        let backup = dir.join("snapshot.mrbackup");

        let export = export_backup_blocking(
            &db_path,
            &backup,
            Some(r#"{"theme":"light","locale":"ja"}"#),
            "9.9.9",
        )
        .unwrap();
        assert_eq!(export.books, 2);
        assert_eq!(export.reading_days, 1);
        assert_eq!(export.rules, 1);
        assert_eq!(export.profiles, 1);
        assert!(export.preferences_included);
        assert!(backup.is_file());
        assert_eq!(export.bytes, fs::metadata(&backup).unwrap().len());

        // 篡改活库：换主题、删书、加规则/阅读记录/凭据/事件/内部版本。
        {
            let conn = db::open(&db_path).unwrap();
            db::set_setting(&conn, "theme", "light").unwrap();
            db::set_setting(&conn, "online_headers", "Cookie: live=9").unwrap();
            conn.execute("DELETE FROM books", []).unwrap();
            conn.execute("DELETE FROM reading_log", []).unwrap();
            conn.execute(
                "INSERT INTO reading_log(date, book_id, pages) VALUES ('2020-01-01','ghost',7)",
                [],
            )
            .unwrap();
            db::upsert_filter_rule(&conn, &rule("r2", "other.com")).unwrap();
            db::upsert_filter_profile(&conn, &profile("other.com")).unwrap();
            db::record_filter_event(
                &conn,
                "other.com",
                "b1",
                "https://other.com/a.png",
                "blocked",
                "user",
                None,
                None,
                None,
            )
            .unwrap();
            db::set_meta(&conn, "last_run_version", "9.9.9").unwrap();
        }

        let result = restore_backup_blocking(&db_path, &backup).unwrap();
        assert_eq!(result.books, 2);
        assert_eq!(result.reading_days, 1);
        assert_eq!(result.rules, 1);
        assert_eq!(result.profiles, 1);
        assert_eq!(
            result.created_at.as_deref(),
            Some(export.created_at.as_str())
        );
        assert_eq!(result.app_version.as_deref(), Some("9.9.9"));

        let conn = db::open(&db_path).unwrap();
        let books = db::list_books(&conn, None).unwrap();
        assert_eq!(books.len(), 2);
        let b1 = db::get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(b1.current_page, 12);
        assert_eq!(b1.scroll_pct, 0.5);
        assert_eq!(db::today_pages(&conn).unwrap(), 12);
        assert_eq!(
            db::get_setting(&conn, "theme").unwrap().as_deref(),
            Some("dark")
        );
        // 凭据以当前活库为准，绝不被备份覆盖。
        assert_eq!(
            db::get_setting(&conn, "online_headers").unwrap().as_deref(),
            Some("Cookie: live=9")
        );
        let rules = db::list_filter_rules(&conn).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "r1");
        let profiles = db::list_filter_profiles(&conn).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].host, "example.com");
        // 事件不恢复，app_meta 不迁移。
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM online_filter_events"), 0);
        assert_eq!(
            db::get_meta(&conn, "last_run_version").unwrap().as_deref(),
            Some("9.9.9")
        );

        let prefs = result.preferences_json.expect("应带回偏好 JSON");
        let parsed: serde_json::Value = serde_json::from_str(&prefs).unwrap();
        assert_eq!(parsed["theme"], "light");
        assert_eq!(parsed["locale"], "ja");

        drop(conn);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn exported_database_excludes_credentials_events_and_internal_meta() {
        let dir = temp_dir("purge");
        let db_path = seeded_db(&dir);
        let backup = dir.join("purge.mrbackup");
        export_backup_blocking(&db_path, &backup, None, "0.15.0").unwrap();

        let manifest_bytes = zip_entry_bytes(&backup, "manifest.json");
        let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest.format, BACKUP_FORMAT);
        assert_eq!(manifest.schema, BACKUP_SCHEMA);
        assert_eq!(manifest.counts.books, 2);
        assert!(manifest.excludes.iter().any(|v| v == "online_headers"));
        assert!(manifest.excludes.iter().any(|v| v == "caches"));

        let exported = exported_db(&backup, &dir);
        let conn = Connection::open(&exported).unwrap();
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM settings WHERE k='online_headers'"
            ),
            0,
            "凭据绝不进入备份"
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM online_filter_events"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM app_meta"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM online_filter_rules"), 1);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM online_filter_profiles"),
            1
        );
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_ascii_lowercase(), "delete");
        drop(conn);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preferences_are_validated_and_roundtripped() {
        let dir = temp_dir("prefs");
        let db_path = seeded_db(&dir);
        let backup = dir.join("prefs.mrbackup");
        let raw = r#"{"theme":"dark","reader":{"mode":"single","dir":"rtl"}}"#;
        let export = export_backup_blocking(&db_path, &backup, Some(raw), "0.15.0").unwrap();
        assert!(export.preferences_included);

        let stored = String::from_utf8(zip_entry_bytes(&backup, "preferences.json")).unwrap();
        let stored_json: serde_json::Value = serde_json::from_str(&stored).unwrap();
        let raw_json: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(stored_json, raw_json, "偏好内容原样透传（仅 pretty 重排）");

        let result = restore_backup_blocking(&db_path, &backup).unwrap();
        let returned: serde_json::Value =
            serde_json::from_str(result.preferences_json.as_deref().unwrap()).unwrap();
        assert_eq!(returned, raw_json);

        // 非对象 / 超限一律拒绝。
        let err =
            export_backup_blocking(&db_path, &dir.join("bad.mrbackup"), Some("[1,2]"), "0.15.0")
                .unwrap_err();
        assert!(err.contains("JSON 对象"), "{err}");
        let huge = format!("{{\"blob\":\"{}\"}}", "a".repeat(MAX_PREFERENCES_BYTES));
        let err =
            export_backup_blocking(&db_path, &dir.join("huge.mrbackup"), Some(&huge), "0.15.0")
                .unwrap_err();
        assert!(err.contains("64 KiB"), "{err}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_rejects_invalid_destination() {
        let dir = temp_dir("dest");
        let db_path = seeded_db(&dir);

        let err = export_backup_blocking(&db_path, Path::new("relative.mrbackup"), None, "0.15.0")
            .unwrap_err();
        assert!(err.contains("绝对路径"), "{err}");

        let err = export_backup_blocking(&db_path, &dir, None, "0.15.0").unwrap_err();
        assert!(err.contains("目录"), "{err}");

        let err = export_backup_blocking(
            &db_path,
            &dir.join("missing").join("out.mrbackup"),
            None,
            "0.15.0",
        )
        .unwrap_err();
        assert!(err.contains("目录不存在"), "{err}");

        let err = export_backup_blocking(&db_path, &db_path, None, "0.15.0").unwrap_err();
        assert!(err.contains("书库数据库"), "{err}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_rejects_invalid_archives_without_touching_live_db() {
        let dir = temp_dir("reject");
        let db_path = seeded_db(&dir);

        // 1) 不是 zip。
        let junk = dir.join("junk.mrbackup");
        fs::write(&junk, b"this is not a zip file").unwrap();
        let err = restore_backup_blocking(&db_path, &junk).unwrap_err();
        assert!(err.contains("压缩包"), "{err}");

        // 2) 缺 manifest。
        let no_manifest = dir.join("no-manifest.mrbackup");
        write_test_zip(&no_manifest, None, Some(&db_path), None);
        let err = restore_backup_blocking(&db_path, &no_manifest).unwrap_err();
        assert!(err.contains("manifest"), "{err}");

        // 3) 路径穿越条目名直接拒绝。
        let nested = dir.join("nested.mrbackup");
        write_raw_zip(&nested, &[("../library.db", &b"x"[..])]);
        let err = restore_backup_blocking(&db_path, &nested).unwrap_err();
        assert!(err.contains("非法条目名"), "{err}");

        // 4) 必需表缺失。
        let broken_db = dir.join("broken.db");
        {
            let conn = Connection::open(&broken_db).unwrap();
            conn.execute_batch("CREATE TABLE books(id TEXT);").unwrap();
        }
        let missing_table = dir.join("missing-table.mrbackup");
        let manifest = manifest_json(&BackupCounts::default());
        write_test_zip(
            &missing_table,
            Some(manifest.as_bytes()),
            Some(&broken_db),
            None,
        );
        let err = restore_backup_blocking(&db_path, &missing_table).unwrap_err();
        assert!(err.contains("缺少表"), "{err}");

        // 5) 清单计数不一致（用净化快照构造，避免依赖 WAL 状态）。
        let base = dir.join("base.mrbackup");
        export_backup_blocking(&db_path, &base, None, "0.15.0").unwrap();
        let snapshot = exported_db(&base, &dir);
        let mismatch = dir.join("mismatch.mrbackup");
        let manifest = manifest_json(&BackupCounts {
            books: 99,
            reading_days: 0,
            rules: 0,
            profiles: 0,
        });
        write_test_zip(&mismatch, Some(manifest.as_bytes()), Some(&snapshot), None);
        let err = restore_backup_blocking(&db_path, &mismatch).unwrap_err();
        assert!(err.contains("计数"), "{err}");

        // 全部失败路径都不得修改活库。
        let conn = db::open(&db_path).unwrap();
        assert_eq!(db::list_books(&conn, None).unwrap().len(), 2);
        assert_eq!(
            db::get_setting(&conn, "online_headers").unwrap().as_deref(),
            Some("Cookie: secret=1")
        );
        drop(conn);
        fs::remove_dir_all(&dir).ok();
    }
}
