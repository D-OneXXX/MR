//! MangaReader 后端：书库、阅读、在线直读、更新、隐私与韧性。
//! 前端契约见 `src/lib/tauri.ts`。

mod browser;
pub mod cache;
mod commands;
pub mod db;
pub mod diagnostics;
pub mod logging;
mod online;
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
use std::path::PathBuf;
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
    pub cache_budget_mb: u32,
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

fn resolve_data_dir(
    mr_data_dir: Option<String>,
    fallback: Option<PathBuf>,
) -> Result<PathBuf, String> {
    mr_data_dir
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or(fallback)
        .ok_or_else(|| "无法定位本地数据目录".to_string())
}

pub(crate) fn data_dir() -> Result<PathBuf, String> {
    resolve_data_dir(
        std::env::var("MR_DATA_DIR").ok(),
        dirs::data_local_dir().map(|d| d.join("com.local.manga-reader")),
    )
}

fn init_app<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), String> {
    // Windows 优先：`dirs::data_local_dir` → …\AppData\Local\com.local.manga-reader。
    // MR_DATA_DIR 用于测试/冒烟隔离；生产环境未设置时仍使用本地数据目录。
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("library.db");
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    db::init_schema(&conn).map_err(|e| e.to_string())?;
    logging::init(dir.join("logs"));
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
        // artifacts. Removing the derived directory never touches the library.
        state.render.clear_all();
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
    let state = Arc::new(AppState::new());
    let resilience_state = resilience::new_state();
    let app = tauri::Builder::default()
        .manage(state)
        .manage(resilience_state.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            diagnostics::install_panic_hook();
            if let Err(e) = init_app(app) {
                eprintln!("[backend] 初始化失败: {e}");
            }
            if let Err(e) = resilience::initialize(app.handle(), &resilience_state) {
                logging::log_error("startup", &format!("韧性守卫初始化失败：{e}"));
            }
            // 启动时后台 trim 磁盘渲染缓存（≤2GB，按 mtime 删最旧）。
            let st2 = app.state::<Arc<AppState>>().inner().clone();
            std::thread::spawn(move || {
                st2.render.trim(crate::render_cache::RENDER_DISK_BUDGET);
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
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app_handle.state::<Arc<AppState>>().cancel_handoff();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn data_dir_override_wins_and_blank_falls_back() {
        let fallback = PathBuf::from("fallback-data");
        assert_eq!(
            resolve_data_dir(Some("override-data".into()), Some(fallback.clone())).unwrap(),
            PathBuf::from("override-data")
        );
        assert_eq!(
            resolve_data_dir(Some("   ".into()), Some(fallback.clone())).unwrap(),
            fallback
        );
        assert!(resolve_data_dir(None, None).is_err());
    }
}
