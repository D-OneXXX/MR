//! MangaReader 后端：书库、阅读、在线直读、更新、隐私与韧性。
//! 前端契约见 `src/lib/tauri.ts`。

mod browser;
pub mod cache;
mod commands;
pub mod disk_cache;
pub mod db;
pub mod diagnostics;
pub mod logging;
mod online;
mod paths;
mod resilience;
pub mod pipeline;
pub mod render_cache;
mod security;
pub mod source;
mod state;
mod system_proxy;
pub mod update;
mod versioning;
pub use state::AppState;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

// ---------- Data contract (camelCase JSON，与冻结契约一致) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub id: String,
    pub title: String,
    pub path: String,
    pub page_count: u32,
    pub current_page: u32,
    pub updated_at: String,
    /// 条漫滚动偏移百分比（0.0..1.0）；-1 = 无条漫阅读记录。
    pub scroll_pct: f64,
    /// local | generic_manga | anime（预留）。
    pub source_type: String,
    /// 条漫是否可用：本地 true；在线取决于清单尺寸。
    pub webtoon_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapter_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageEntry {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImage {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    /// 源图原始尺寸（条漫建议/布局用）。
    pub orig_width: u32,
    pub orig_height: u32,
    pub mime: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub process_mb: f64,
    pub cache_bytes: u64,
    pub cache_limit_bytes: u64,
    pub cached_pages: usize,
    pub cached_thumbs: usize,
    /// 条漫切片缓存（字节/片数）。
    pub webtoon_bytes: u64,
    pub webtoon_tiles: usize,
    /// 统一磁盘缓存：渲染成品 + 在线原图，二者共用同一软上限。
    pub disk_cache_bytes: u64,
    pub disk_cache_limit_bytes: u64,
    pub render_cache_bytes: u64,
    pub online_cache_bytes: u64,
}

/// 条漫布局数据：单页源图尺寸（header 解析，不解码）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDim {
    pub index: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatDay {
    pub date: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesProgress {
    pub book_id: String,
    pub title: String,
    pub current_page: u32,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub total_books: u32,
    pub reading: u32,
    pub today_pages: u32,
    pub heatmap: Vec<HeatDay>,
    pub series: Vec<SeriesProgress>,
}

/// 逐日逐书阅读页数（趋势堆叠图数据点）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDayPoint {
    pub book_id: String,
    pub date: String,
    pub pages: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub added: usize,
    pub books: Vec<BookInfo>,
    /// 无法读取/损坏的条目；不再只写 stderr。
    #[serde(default)]
    pub errors: Vec<String>,
}

/// 单路径导入结果（status: added=已入库 / restored=恢复(进度保留) / skipped=已在书库中 / failed）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemResult {
    pub path: String,
    pub status: String,
    pub message: String,
    pub book: Option<BookInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub items: Vec<ImportItemResult>,
    pub added: usize,
    pub restored: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: usize,
    pub deleted_files: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    /// 内存页/缩略图 LRU 预算（MB）。
    pub cache_budget_mb: u32,
    /// 磁盘缓存软上限（MB）：渲染成品 + 在线原图共用。
    pub disk_cache_budget_mb: u32,
    pub library_dir: String,
    /// 实验性功能：条漫模式。默认关闭；关闭时版式只在单页/双页间切换。
    pub experimental_webtoon: bool,
    /// 实验性功能：URL 在线直读（JSON 清单 / HTML 图集 / Telegram）。
    pub experimental_online: bool,
    /// 在线源 HTTP 代理（空=直连；http/https/socks5）。
    pub online_proxy: String,
    /// 单本在线书页面下载并发（1-8）。
    pub online_concurrency: u32,
    /// 手动请求头：JSON 对象或单行 Cookie；仅用于自建/授权源。
    pub online_headers: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            cache_budget_mb: 128,
            disk_cache_budget_mb: disk_cache::DEFAULT_DISK_CACHE_MB,
            library_dir: String::new(),
            experimental_webtoon: false,
            experimental_online: false,
            online_proxy: String::new(),
            online_concurrency: 3,
            online_headers: String::new(),
        }
    }
}

/// 在线源连通性探测结果（只解析清单，不写库）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineProbe {
    pub ok: bool,
    pub title: String,
    pub page_count: u32,
    pub elapsed_ms: u64,
    pub message: String,
}

/// 从 SQLite `settings` 表恢复持久化设置（无值则保留默认）。
fn hydrate_settings(conn: &rusqlite::Connection, s: &mut Settings) {
    let get = |k: &str| db::get_setting(conn, k).unwrap_or(None);
    if let Some(v) = get("theme") {
        s.theme = v;
    }
    if let Some(v) = get("cache_budget_mb").and_then(|v| v.parse::<u32>().ok()) {
        s.cache_budget_mb = v.clamp(16, 2048);
    }
    if let Some(v) = get("disk_cache_budget_mb").and_then(|v| v.parse::<u32>().ok()) {
        s.disk_cache_budget_mb = disk_cache::clamp_budget_mb(v);
    }
    if let Some(v) = get("library_dir") {
        s.library_dir = v;
    }
    if let Some(v) = get("experimental_webtoon") {
        s.experimental_webtoon = v == "true" || v == "1";
    }
    if let Some(v) = get("experimental_online") {
        s.experimental_online = v == "true" || v == "1";
    }
    if let Some(v) = get("online_proxy") {
        s.online_proxy = v;
    }
    if let Some(v) = get("online_concurrency").and_then(|v| v.parse::<u32>().ok()) {
        s.online_concurrency = v.clamp(1, 8);
    }
    if let Some(v) = get("online_headers") {
        s.online_headers = v;
    }
}

/// 旧版数据根：`%LOCALAPPDATA%\com.local.manga-reader`（仅用于迁移与最终回落）。
fn legacy_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("com.local.manga-reader"))
}

/// 统一数据目录解析：`MR_DATA_DIR`（测试隔离）> 已安装的 Tauri 数据根 >
/// 旧版本地目录。绝不使用 CWD / exe 同级目录。
pub(crate) fn data_dir() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("MR_DATA_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Some(dir) = paths::data_dir() {
        return Ok(dir.to_path_buf());
    }
    legacy_data_dir().ok_or_else(|| "无法定位本地数据目录".to_string())
}

/// setup 第一步：解析并落地数据/缓存根。
///
/// - 数据根：`MR_DATA_DIR` > Tauri `app_data_dir` > 旧 Local AppData；
/// - 缓存根：`MR_DATA_DIR` 隔离模式下取 `<数据根>/cache`，否则 Tauri
///   `app_cache_dir`；两者都 `create_dir_all`。
/// 返回 `(data, cache, 是否 MR_DATA_DIR 隔离)`。
fn install_app_paths<R: tauri::Runtime>(app: &tauri::App<R>) -> (PathBuf, PathBuf, bool) {
    let env_override = std::env::var("MR_DATA_DIR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .filter(|v| {
            if std::path::Path::new(v).is_absolute() {
                true
            } else {
                logging::log_error(
                    "paths",
                    "MR_DATA_DIR 不是绝对路径，已忽略并回落到 app_data_dir",
                );
                false
            }
        });
    let legacy = legacy_data_dir();
    let data = paths::resolve_data_root(
        env_override.as_deref(),
        app.path().app_data_dir().ok(),
        legacy,
    )
    .unwrap_or_else(|err| {
        logging::log_error("paths", &format!("{err}；回落到系统临时目录"));
        std::env::temp_dir().join("com.local.manga-reader")
    });
    let cache = if env_override.is_some() {
        // 隔离模式不触碰真实用户缓存目录。
        data.join("cache")
    } else {
        app.path()
            .app_cache_dir()
            .ok()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| data.join("cache"))
    };
    if let Err(err) = std::fs::create_dir_all(&data) {
        logging::log_error("paths", &format!("创建数据目录失败：{err}"));
    }
    if let Err(err) = std::fs::create_dir_all(&cache) {
        logging::log_error("paths", &format!("创建缓存目录失败：{err}"));
    }
    paths::install(data.clone(), cache.clone());
    (data, cache, env_override.is_some())
}

/// 旧本地目录 → 新数据根一次性接续（仅补缺失文件，不删源、不复制缓存）。
/// 日志只写文件名与字节数，不落任何本地绝对路径。
fn migrate_legacy_into(data: &Path, isolated: bool) {
    if isolated {
        logging::log_error("paths", "MR_DATA_DIR 隔离模式：跳过旧数据目录迁移");
        return;
    }
    let Some(legacy) = legacy_data_dir() else {
        return;
    };
    let notes = paths::migrate_legacy_state(data, &legacy);
    if !notes.is_empty() {
        logging::log_error(
            "paths",
            &format!("旧数据目录迁移（仅补缺失文件）：{}", notes.join("；")),
        );
    }
}

fn init_app<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("library.db");
    let conn = db::open(&db_path).map_err(|e| e.to_string())?;
    db::init_schema(&conn).map_err(|e| e.to_string())?;
    let current_version = env!("CARGO_PKG_VERSION");
    let previous_version = versioning::read_last_run_version(&conn).unwrap_or_else(|err| {
        logging::log_error("version", &format!("读取 last_run_version 失败：{err}"));
        None
    });
    let migration = versioning::plan(previous_version.as_deref(), current_version);
    let state = app.state::<Arc<AppState>>();
    state.set_db_path(db_path);
    let repaired_settings;
    {
        let mut s = state.settings.lock().clone();
        hydrate_settings(&conn, &mut s);
        repaired_settings = versioning::normalize_settings(&conn, &mut s).unwrap_or_else(|err| {
            logging::log_error("version", &format!("修复旧版配置失败：{err}"));
            Vec::new()
        });
        state
            .cache
            .set_budgets((s.cache_budget_mb.max(16) as u64) * 1024 * 1024);
        *state.settings.lock() = s;
    }
    state.db.set(conn);
    if migration.clear_memory_cache {
        state.cache.clear_pages();
        state.cache.clear_thumbs();
        state.webtoon_layouts.lock().clear();
        state.invalidate_sources();
    }
    if migration.clear_disk_cache {
        // MAJOR/downgrade/unknown metadata may point at incompatible render
        // artifacts. Removing the derived directories never touches the library.
        state.render.clear_all();
        state.online_cache.clear_all();
    }
    if let Err(err) = state.db.with(|conn| {
        versioning::record_run_version(conn, current_version).map_err(|err| err.to_string())
    }) {
        logging::log_error("version", &format!("写入 last_run_version 失败：{err}"));
    }
    if migration.change != versioning::VersionChange::Unchanged {
        logging::log_error(
            "version",
            &format!(
                "本地版本 {} → {}（{}）；清理内存缓存={}，清理磁盘缓存={}，修复配置={}",
                migration.previous.as_deref().unwrap_or("first-run"),
                current_version,
                migration.change.as_str(),
                migration.clear_memory_cache,
                migration.clear_disk_cache,
                if repaired_settings.is_empty() {
                    "none".to_string()
                } else {
                    repaired_settings.join(",")
                }
            ),
        );
    } else if !repaired_settings.is_empty() {
        logging::log_error(
            "version",
            &format!("版本未变化，但修复了异常配置：{}", repaired_settings.join(",")),
        );
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let resilience_state = resilience::new_state();
    let app = tauri::Builder::default()
        .manage(resilience_state.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            diagnostics::install_panic_hook();
            // 1) 先锚定数据/缓存根（app_data_dir / app_cache_dir），再初始化日志。
            let (data_dir, _cache_dir, isolated) = install_app_paths(app);
            logging::init(data_dir.join("logs"));
            // 2) 旧 Local AppData 数据一次性接续（仅补缺失文件；隔离模式跳过）。
            migrate_legacy_into(&data_dir, isolated);
            // 3) AppState 的渲染/在线缓存根依赖已安装的 cache_dir，必须最后创建。
            app.manage(Arc::new(AppState::new()));
            if let Err(e) = init_app(app) {
                eprintln!("[backend] 初始化失败: {e}");
            }
            if let Err(e) = resilience::initialize(app.handle(), &resilience_state) {
                logging::log_error("startup", &format!("韧性守卫初始化失败：{e}"));
            }
            // 启动时后台 trim 统一磁盘缓存（render + online，共用软上限）。
            let st2 = app.state::<Arc<AppState>>().inner().clone();
            std::thread::spawn(move || {
                st2.trim_disk_cache();
            });
            // 空闲兜底：每 5 分钟复查一次，避免长时间阅读只写不淘汰。
            let st3 = app.state::<Arc<AppState>>().inner().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(300));
                st3.trim_disk_cache();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_library,
            commands::import_books,
            commands::remove_books,
            commands::list_books,
            commands::get_book,
            commands::get_next_book,
            commands::get_series_books,
            commands::list_entries,
            commands::get_page,
            commands::get_thumbnail,
            commands::clear_thumbnail_cache,
            commands::clear_temp_cache,
            commands::get_webtoon_layout,
            commands::get_webtoon_tile,
            commands::get_memory_stats,
            commands::get_dashboard,
            commands::get_reading_log,
            commands::get_reading_by_book,
            commands::set_progress,
            commands::clear_pages,
            commands::get_settings,
            commands::set_settings,
            commands::resolve_online_url,
            commands::test_online_connection,
            commands::import_resolved_pages,
            commands::resolve_online_batch,
            commands::resolve_telegram_channel,
            commands::download_telegram_document,
            commands::get_online_filter_status,
            commands::list_online_filter_rules,
            commands::export_online_filter_rules,
            commands::import_online_filter_rules,
            commands::reset_online_filter_rules,
            commands::get_filtered_pages,
            commands::get_filtered_preview,
            commands::mark_online_page_non_content,
            commands::restore_online_filtered_page,
            commands::set_session_online_headers,
            commands::clear_session_online_headers,
            commands::get_session_online_headers,
            online::handoff::start_browser_handoff,
            online::handoff::stop_browser_handoff,
            online::handoff::get_browser_handoff_status,
            system_proxy::detect_system_proxy,
            browser::open_browser_window,
            browser::navigate_browser,
            browser::list_browser_downloads,
            browser::import_browser_download,
            update::get_app_info,
            update::check_update,
            update::download_update,
            update::install_update,
            update::cancel_update,
            update::get_update_snapshot,
            security::security_audit,
            security::clear_online_traces,
            diagnostics::diagnostics_record_frontend_error,
            diagnostics::diagnostics_record_breadcrumb,
            diagnostics::diagnostics_update_context,
            diagnostics::diagnostics_collect,
            diagnostics::diagnostics_sanitize_description,
            diagnostics::diagnostics_export,
            resilience::heartbeat_ping,
            resilience::resilience_report_rage_click,
            resilience::get_recovery_context,
            resilience::resilience_reload_main,
            resilience::resilience_close_recovery,
            resilience::get_safe_mode_state,
            resilience::resilience_enable_safe_mode,
            resilience::resilience_disable_safe_mode,
            resilience::resilience_mark_ready
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<Arc<AppState>>();
            state.cancel_handoff();
            // 退出前做最后一次统一淘汰；只动派生缓存，不碰 SQLite。
            state.trim_disk_cache();
        }
    });
}
