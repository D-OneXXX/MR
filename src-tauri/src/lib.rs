//! MangaReader 后端 — 阶段一真实实现（backend-pipeline）。
//! 契约冻结：命令名与 JSON 形状与骨架一致，前端 `src/lib/tauri.ts` 无需改动。

mod browser;
pub mod cache;
mod commands;
pub mod db;
pub mod logging;
mod ocr;
mod online;
pub mod pipeline;
pub mod render_cache;
mod sidecar;
pub mod source;
mod state;
mod system_proxy;
mod translate;
mod workbench;

pub mod batch;
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
    // Stage-3 translation service config (real, no mock)
    pub trans_endpoint: String,
    pub trans_api_key: String,
    pub trans_model: String,
    pub trans_temp: f32,
    pub trans_timeout_s: u64,
    pub ocr_endpoint: String,
    pub ocr_timeout_s: u64,
    pub src_lang: String,
    pub dst_lang: String,
    /// 实验性功能：翻译（工作台/选区翻译/批量预翻译/术语表）。默认关闭，
    /// 关闭时相关 UI 全部隐藏。
    pub experimental_trans: bool,
    /// 实验性功能：条漫模式（韩漫长条纵向滚动）。默认关闭，
    /// 关闭时版式只在单页/双页间切换，自动建议与相关 UI 全部隐藏。
    pub experimental_webtoon: bool,
    // Stage-3 sidecar(ctd/mit48px/lama 本地服务),契约见 docs/sidecar-api.md。
    pub sidecar_endpoint: String,
    pub sidecar_timeout_s: u64,
    // 工作台四个 provider 下拉框的当前选择(翻译槽位固定为 OpenAI 兼容服务)。
    pub wb_detector: String,
    pub wb_ocr: String,
    pub wb_inpaint: String,
    /// 实验性功能：URL 在线直读（JSON 清单 / 单页 HTML 图集）。
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
            trans_endpoint: "http://localhost:8080/v1".into(),
            trans_api_key: String::new(),
            trans_model: String::new(),
            trans_temp: 0.0,
            trans_timeout_s: 30,
            ocr_endpoint: String::new(),
            ocr_timeout_s: 30,
            src_lang: "ja".into(),
            dst_lang: "zh".into(),
            experimental_trans: false,
            experimental_webtoon: false,
            sidecar_endpoint: "http://127.0.0.1:8500".into(),
            sidecar_timeout_s: 120,
            wb_detector: "ctd".into(),
            wb_ocr: "mit48pxctc".into(),
            wb_inpaint: "lama_large_512px".into(),
            experimental_online: false,
            online_proxy: String::new(),
            online_concurrency: 3,
            online_headers: String::new(),
        }
    }
}

/// 框选相对坐标（0.0..1.0，相对原图尺寸）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub translated: String,
    pub model: String,
    pub elapsed_ms: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransLogEntry {
    pub kind: String,
    pub ok: bool,
    pub elapsed_ms: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransStats {
    pub ocr_calls: u64,
    pub ocr_fail: u64,
    pub ocr_avg_ms: f64,
    pub trans_calls: u64,
    pub trans_fail: u64,
    pub trans_avg_ms: f64,
    pub recent: Vec<TransLogEntry>,
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
    if let Some(v) = get("trans_endpoint") {
        s.trans_endpoint = v;
    }
    if let Some(v) = get("trans_model") {
        s.trans_model = v;
    }
    if let Some(v) = get("trans_api_key") {
        s.trans_api_key = v;
    }
    if let Some(v) = get("trans_temp").and_then(|v| v.parse::<f32>().ok()) {
        s.trans_temp = v;
    }
    if let Some(v) = get("trans_timeout_s").and_then(|v| v.parse::<u64>().ok()) {
        s.trans_timeout_s = v;
    }
    if let Some(v) = get("ocr_endpoint") {
        s.ocr_endpoint = v;
    }
    if let Some(v) = get("ocr_timeout_s").and_then(|v| v.parse::<u64>().ok()) {
        s.ocr_timeout_s = v;
    }
    if let Some(v) = get("src_lang") {
        s.src_lang = v;
    }
    if let Some(v) = get("dst_lang") {
        s.dst_lang = v;
    }
    if let Some(v) = get("experimental_trans") {
        s.experimental_trans = v == "true" || v == "1";
    }
    if let Some(v) = get("experimental_webtoon") {
        s.experimental_webtoon = v == "true" || v == "1";
    }
    if let Some(v) = get("sidecar_endpoint") {
        s.sidecar_endpoint = v;
    }
    if let Some(v) = get("sidecar_timeout_s").and_then(|v| v.parse::<u64>().ok()) {
        s.sidecar_timeout_s = v;
    }
    if let Some(v) = get("wb_detector") {
        s.wb_detector = v;
    }
    if let Some(v) = get("wb_ocr") {
        s.wb_ocr = v;
    }
    if let Some(v) = get("wb_inpaint") {
        s.wb_inpaint = v;
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
    let state = app.state::<Arc<AppState>>();
    state.set_db_path(db_path);
    {
        let mut s = state.settings.lock().clone();
        hydrate_settings(&conn, &mut s);
        state
            .cache
            .set_budgets((s.cache_budget_mb.max(16) as u64) * 1024 * 1024);
        *state.settings.lock() = s;
    }
    state.db.set(conn);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState::new());
    let app = tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(e) = init_app(app) {
                eprintln!("[backend] 初始化失败: {e}");
            }
            // 批量预翻译队列的常驻 worker(FIFO 取 queued 任务)。
            let st = app.state::<Arc<AppState>>().inner().clone();
            batch::spawn_worker(st);
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
            commands::ocr_region,
            commands::translate_region,
            commands::get_trans_stats,
            commands::sidecar_health,
            commands::glossary_list,
            commands::glossary_set,
            commands::glossary_remove,
            workbench::wb_detect,
            workbench::wb_ocr,
            workbench::wb_inpaint,
            workbench::wb_translate,
            workbench::wb_save_ocr,
            workbench::wb_get_ocr,
            batch::batch_enqueue,
            batch::batch_pause,
            batch::batch_resume,
            batch::batch_cancel,
            batch::batch_list,
            commands::resolve_online_url,
            commands::test_online_connection,
            commands::import_resolved_pages,
            commands::import_online_batch,
            commands::set_session_online_headers,
            commands::clear_session_online_headers,
            commands::get_session_online_headers,
            online::handoff::start_browser_handoff,
            online::handoff::stop_browser_handoff,
            online::handoff::cancel_browser_handoff,
            system_proxy::detect_system_proxy,
            browser::open_browser_window,
            browser::navigate_browser,
            browser::list_browser_downloads,
            browser::import_browser_download
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
