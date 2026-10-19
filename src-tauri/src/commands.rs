//! 全部 tokio 异步的 Tauri command 实现（真实后端）。
//!
//! - 阻塞工作（文件扫描 / zip 解包 / 图片解码 / SQLite）一律走
//!   `tokio::task::spawn_blocking`，绝不阻塞 async 运行时；
//! - `scan_library` 支持“书籍目录”（含 .zip/.cbz 文件的目录）与单书路径；
//! - `get_page` 降采样参数由前端视口传入；阅读页走 ±2 页窗口缓存；
//! - `get_thumbnail` 首图缩略图走字节预算 LRU；
//! - `settings` 内存 + SQLite 双写（`cacheBudgetMb` 即时调整 LRU 预算）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::State;
use crate::db::{self};
use crate::ocr;
use crate::pipeline;
use crate::pipeline::RenderedPage;
use crate::source::{self, BackendError, ImageSource};
use crate::state::AppState;
use crate::translate;
use crate::{
    BookDayPoint, BookInfo, Dashboard, HeatDay, ImportItemResult, ImportResult, MemoryStats,
    OcrResult, PageDim, PageEntry, PageImage, RegionRect, RemoveResult, ScanResult, SeriesProgress,
    Settings, TransStats, TranslateResult,
};

pub(crate) fn err(e: impl ToString) -> String {
    e.to_string()
}

fn to_book_info(r: db::BookRow) -> BookInfo {
    BookInfo {
        id: r.id,
        title: r.title,
        path: r.path,
        page_count: r.page_count,
        current_page: r.current_page,
        updated_at: r.updated_at,
        scroll_pct: r.scroll_pct,
    }
}

/// 从文件/目录名推导书名（去扩展名）。
fn title_for(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未命名");
    if path.is_dir() {
        return name.to_string();
    }
    match name.rsplit_once('.') {
        Some((stem, ext))
            if ["zip", "cbz"].contains(&ext.to_ascii_lowercase().as_str()) =>
        {
            stem.to_string()
        }
        _ => name.to_string(),
    }
}

/// 扫描一本书：打开源 → 取页数 → upsert。
fn scan_single_book(conn: &rusqlite::Connection, path: &Path) -> Result<BookInfo, BackendError> {
    let path_str = path.to_string_lossy().to_string();
    let src = source::open_source(path)?;
    let count = src.page_count()? as u32;
    if count == 0 {
        return Err(BackendError::Msg("书中没有可读图片，跳过".into()));
    }
    let id = db::book_id_for_path(&path_str);
    let title = title_for(path);
    db::upsert_book(conn, &id, &path_str, &title, count)?;
    let row = db::get_book(conn, &id)?.ok_or_else(|| BackendError::Msg("入库后回读失败".into()))?;
    Ok(to_book_info(row))
}

/// 扫描目录：其直接子目录（图片书）与直接 .zip/.cbz 文件均为一本书；单书路径直接入库。
fn blocking_scan(db_path: PathBuf, root: &str) -> Result<Vec<BookInfo>, BackendError> {
    let path = PathBuf::from(root);
    let conn = rusqlite::Connection::open(db_path)?;
    db::init_schema(&conn)?;

    let mut books = Vec::new();
    if path.is_dir() {
        let mut kids: Vec<PathBuf> = std::fs::read_dir(&path)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        kids.sort();
        for kid in kids {
            if kid.is_dir() {
                // 目录书：含图片才算书。
                if let Ok(src) = source::open_source(&kid) {
                    if src.page_count().unwrap_or(0) > 0 {
                        match scan_single_book(&conn, &kid) {
                            Ok(b) => books.push(b),
                            Err(e) => eprintln!("[scan] 跳过 {}：{e}", kid.display()),
                        }
                    }
                }
            } else if source::is_archive_path(&kid) {
                match scan_single_book(&conn, &kid) {
                    Ok(b) => books.push(b),
                    Err(e) => eprintln!("[scan] 跳过 {}：{e}", kid.display()),
                }
            }
        }
    } else if path.is_file() && source::is_archive_path(&path) {
        books.push(scan_single_book(&conn, &path)?);
    } else {
        return Err(BackendError::Msg(format!(
            "扫描路径无效（需要目录或 .zip/.cbz）：{root}"
        )));
    }
    Ok(books)
}

pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, BackendError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("后台任务失败：{e}"))?
        .map_err(err)
}

#[tauri::command]
pub async fn scan_library(state: State<'_, Arc<AppState>>, path: String) -> Result<ScanResult, String> {
    let db_path = state.db_path();
    let books = blocking(move || blocking_scan(db_path, &path)).await?;
    // 刷新后全量回读。
    let list = state.db.with(|conn| {
        db::list_books(conn, None)
            .map(|rows| rows.into_iter().map(to_book_info).collect::<Vec<_>>())
            .map_err(err)
    })?;
    Ok(ScanResult {
        added: books.len(),
        books: list,
    })
}

/// 单个路径的导入结果（status: added/restored/skipped/failed）。
fn import_outcome(path: &str, status: &str, message: String, book: Option<BookInfo>) -> ImportItemResult {
    ImportItemResult {
        path: path.to_string(),
        status: status.to_string(),
        message,
        book,
    }
}

/// 单本书路径的去重导入：已入库 → skipped；软删过 → 恢复；新路径 → 入库。
fn import_one(conn: &rusqlite::Connection, p: &Path) -> ImportItemResult {
    let path = p.to_string_lossy().to_string();
    let id = db::book_id_for_path(&path);
    match db::get_book(conn, &id) {
        Ok(Some(_)) => {
            // 已在书库（含软删）。软删的书走恢复（upsert 会置 removed=0 并刷新页数）。
            match db::book_is_removed(conn, &id) {
                Ok(true) => match scan_single_book(conn, p) {
                    Ok(b) => import_outcome(&path, "restored", "已恢复，阅读进度保留".into(), Some(b)),
                    Err(e) => import_outcome(&path, "failed", e.to_string(), None),
                },
                Ok(false) => import_outcome(&path, "skipped", "已在书库中".into(), None),
                Err(e) => import_outcome(&path, "failed", e.to_string(), None),
            }
        }
        Ok(None) => match scan_single_book(conn, p) {
            Ok(b) => import_outcome(&path, "added", "已入库".into(), Some(b)),
            Err(e) => import_outcome(&path, "failed", e.to_string(), None),
        },
        Err(e) => import_outcome(&path, "failed", e.to_string(), None),
    }
}

/// 目录直下是否有可直接成书的图片。
fn dir_has_direct_images(p: &Path) -> bool {
    source::open_source(p)
        .map(|s| s.page_count().unwrap_or(0) > 0)
        .unwrap_or(false)
}

/// 目录语义（兼容两代行为，2026-10-06 事故修复）：
/// - 直下有图片 → 按**单本书**导入；
/// - 直下没有图片 → 按**书库根**扫描：含图片的子文件夹与 zip/cbz 逐个入库
///   （旧 scan_library 行为；此前误把它当单本书导致"文件夹装多本书"全失效）。
/// - 子项导入走同一套去重/恢复逻辑；子项里既无图片也非压缩包的静默跳过。
fn import_blocking(
    db_path: PathBuf,
    paths: Vec<String>,
) -> Result<Vec<ImportItemResult>, BackendError> {
    let conn = rusqlite::Connection::open(db_path)?;
    db::init_schema(&conn)?;
    let mut out = Vec::new();
    for raw in paths {
        let path = raw.trim().to_string();
        if path.is_empty() {
            out.push(import_outcome(&raw, "failed", "空路径".into(), None));
            continue;
        }
        let p = PathBuf::from(&path);
        if !p.exists() {
            out.push(import_outcome(&path, "failed", format!("路径不存在：{path}"), None));
            continue;
        }
        if p.is_file() {
            if !source::is_archive_path(&p) {
                out.push(import_outcome(
                    &path,
                    "failed",
                    "不支持的文件（需要 .zip/.cbz；图片文件夹请拖文件夹）".into(),
                    None,
                ));
            } else {
                out.push(import_one(&conn, &p));
            }
        } else if p.is_dir() {
            if dir_has_direct_images(&p) {
                out.push(import_one(&conn, &p));
            } else {
                let mut kids: Vec<PathBuf> = std::fs::read_dir(&p)?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .collect();
                kids.sort();
                let mut found = 0usize;
                for kid in kids {
                    let kid_is_book = if kid.is_dir() {
                        dir_has_direct_images(&kid)
                    } else {
                        source::is_archive_path(&kid)
                    };
                    if !kid_is_book {
                        continue;
                    }
                    found += 1;
                    out.push(import_one(&conn, &kid));
                }
                if found == 0 {
                    out.push(import_outcome(
                        &path,
                        "failed",
                        "目录中没有可识别的书籍（需要：直下图片 / 含图片的子文件夹 / zip/cbz）".into(),
                        None,
                    ));
                }
            }
        } else {
            out.push(import_outcome(
                &path,
                "failed",
                "不支持的路径（需要文件夹或 .zip/.cbz）".into(),
                None,
            ));
        }
    }
    Ok(out)
}

/// 导入书籍（文件/文件夹路径数组；同路径去重，重复导入不入库）。
#[tauri::command]
pub async fn import_books(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<ImportResult, String> {
    let db_path = state.db_path();
    let items = blocking(move || import_blocking(db_path, paths)).await?;
    let (mut added, mut restored, mut skipped, mut failed) = (0usize, 0, 0, 0);
    for it in &items {
        match it.status.as_str() {
            "added" => added += 1,
            "restored" => restored += 1,
            "skipped" => skipped += 1,
            _ => failed += 1,
        }
    }
    Ok(ImportResult {
        items,
        added,
        restored,
        skipped,
        failed,
    })
}

/// 移除/删除书籍（两个独立动作，文案不混用）：
/// - delete_source_files=false：移除（软删）——书库不再显示，源文件原封不动，
///   进度保留，重新导入可续读；
/// - delete_source_files=true：删除源文件（不可逆）——逐个删文件/文件夹，
///   成功才级联清理该书全部记录；失败项保留记录并回报错误。
#[tauri::command]
pub async fn remove_books(
    state: State<'_, Arc<AppState>>,
    ids: Vec<String>,
    delete_source_files: bool,
) -> Result<RemoveResult, String> {
    let db_path = state.db_path();
    let ids_for_db = ids.clone();
    let (removed, deleted_files, errors) = blocking(move || {
        let ids = ids_for_db;
        let conn = rusqlite::Connection::open(db_path)?;
        db::init_schema(&conn)?;
        let mut errors: Vec<String> = Vec::new();
        let mut deleted_files = 0usize;
        if delete_source_files {
            let mut hard: Vec<String> = Vec::new();
            for id in &ids {
                let path = match db::get_book(&conn, id)? {
                    Some(b) => b.path,
                    None => continue,
                };
                let p = PathBuf::from(&path);
                let res = if p.is_dir() {
                    std::fs::remove_dir_all(&p)
                } else if p.is_file() {
                    std::fs::remove_file(&p)
                } else {
                    Ok(())
                };
                match res {
                    Ok(()) => {
                        deleted_files += 1;
                        hard.push(id.clone());
                    }
                    Err(e) => errors.push(format!("{path}：{e}")),
                }
            }
            let n = db::hard_delete_books(&conn, &hard)?;
            Ok::<_, BackendError>((n, deleted_files, errors))
        } else {
            let n = db::soft_remove_books(&conn, &ids)?;
            Ok::<_, BackendError>((n, 0usize, errors))
        }
    })
    .await?;
    // 内存缓存 + 磁盘渲染缓存 + 条漫布局缓存级联清理。
    for id in &ids {
        state.cache.remove_book(id);
        state.render.remove_book(id);
        state.webtoon_layouts.lock().remove(id);
    }
    Ok(RemoveResult {
        removed,
        deleted_files,
        errors,
    })
}

#[tauri::command]
pub async fn list_books(
    state: State<'_, Arc<AppState>>,
    query: Option<String>,
) -> Result<Vec<BookInfo>, String> {
    state.db.with(|conn| {
        db::list_books(conn, query.as_deref())
            .map(|rows| rows.into_iter().map(to_book_info).collect())
            .map_err(err)
    })
}

/// 单书查询（阅读器打开直达上次页，避免全量 `list_books`）。
#[tauri::command]
pub async fn get_book(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<BookInfo, String> {
    state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(to_book_info)
            .ok_or_else(|| "书籍不存在".to_string())
    })
}

#[tauri::command]
pub async fn list_entries(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<PageEntry>, String> {
    let path: String = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| b.path)
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
    blocking(move || {
        let src = source::open_source(Path::new(&path))?;
        Ok(src
            .entry_names()?
            .into_iter()
            .enumerate()
            .map(|(i, name)| PageEntry {
                index: i as u32,
                name,
            })
            .collect())
    })
    .await
}

fn to_page_image(index: u32, rendered: pipeline::RenderedPage) -> PageImage {
    PageImage {
        index,
        width: rendered.width,
        height: rendered.height,
        orig_width: rendered.orig_width,
        orig_height: rendered.orig_height,
        mime: rendered.mime,
        data_url: rendered.data_url,
    }
}

/// 从成品 JPEG 字节读尺寸（只解析头部，不解码）。
fn jpeg_dims(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()?
        .into_dimensions()?;
    Ok((w, h))
}

fn assembled_page(bytes: Vec<u8>) -> Result<RenderedPage, BackendError> {
    let (width, height) = jpeg_dims(&bytes)?;
    Ok(RenderedPage {
        width,
        height,
        // L2 命中时源尺寸不可得；等比缩放保持纵横比，条漫建议只看比例，安全。
        orig_width: width,
        orig_height: height,
        mime: "image/jpeg".to_string(),
        data_url: format!("data:image/jpeg;base64,{}", B64.encode(&bytes)),
        bytes,
    })
}

/// 三级缓存取页（v3 毫秒级路径）：
/// L1 内存 LRU（命中 ~0.1ms）→ L2 磁盘成品 JPEG（~1ms）→ 全管线
/// （常开句柄单页读 → Triangle 降采样 → JPEG 编码，典型 30-60ms），
/// 结果写回 L2 + L1，并后台预取邻页（±1/±2），翻页零等待。
/// 请求尺寸进缓存键：同一页不同视口尺寸互不混淆。
#[tauri::command]
pub async fn get_page(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<PageImage, String> {
    let w = max_width.unwrap_or(0);
    let h = max_height.unwrap_or(0);
    // 1) L1 内存。
    if let Some(hit) = state.cache.get_page(&book_id, index, w, h) {
        return Ok(to_page_image(index, hit));
    }
    let (path, title) = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| (b.path, b.title))
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let task_path = path.clone();
    let rendered = match blocking(move || {
        // 2) L2 磁盘成品缓存。
        if let Some(bytes) = st.render.get(&book, index, w, h) {
            return assembled_page(bytes);
        }
        // 3) 全管线（常开句柄，不再每页重开 zip/重读目录）。
        let handle = st.source_handle(&book, &task_path)?;
        let raw = handle.read_raw(index as usize)?;
        let page = pipeline::render_raw(&raw, max_width, max_height)?;
        st.render.put(&book, index, w, h, &page.bytes);
        st.render.maybe_trim(crate::render_cache::RENDER_DISK_BUDGET);
        Ok(page)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // 失败链路：含书名/页码/原因落盘留痕（P0 缩略图失败链路）。
            crate::logging::log_error(
                "get_page",
                &format!("《{title}》 第 {} 页：{e}", index + 1),
            );
            return Err(e);
        }
    };
    state.cache.put_page(&book_id, index, w, h, rendered.clone());
    prefetch_neighbors(&state, &book_id, &path, index, w, h);
    Ok(to_page_image(index, rendered))
}

/// 服务端邻页预取：主请求落地后，后台把 ±1/±2 页灌进 L1/L2，
/// 翻页不依赖前端 idle 回调时机（P0 手感：命中翻页零等待）。
fn prefetch_neighbors(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
    path: &str,
    index: u32,
    w: u32,
    h: u32,
) {
    let st = state.inner().clone();
    let book = book_id.to_string();
    let path = path.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let page_count = match st.source_handle(&book, &path) {
            Ok(hd) => hd.page_count().unwrap_or(0) as i64,
            Err(_) => return,
        };
        let (mw, mh) = (
            Some(w).filter(|v| *v > 0),
            Some(h).filter(|v| *v > 0),
        );
        for d in [1i64, -1, 2, -2] {
            let target = index as i64 + d;
            if target < 0 || target >= page_count {
                continue;
            }
            let t = target as u32;
            if st.cache.get_page(&book, t, w, h).is_some() {
                continue;
            }
            let key = (book.clone(), t, w, h);
            if st.prefetching.lock().contains(&key) {
                continue;
            }
            st.prefetching.lock().insert(key.clone());
            // L2 命中只做读盘灌 L1；否则全管线渲染后 L2+L1 双写。
            let page = st
                .render
                .get(&book, t, w, h)
                .map(assembled_page)
                .unwrap_or_else(|| {
                    st.source_handle(&book, &path).and_then(|hd| {
                        let raw = hd.read_raw(t as usize)?;
                        let p = pipeline::render_raw(&raw, mw, mh)?;
                        st.render.put(&book, t, w, h, &p.bytes);
                        Ok(p)
                    })
                });
            if let Ok(p) = page {
                st.cache.put_page(&book, t, w, h, p);
            }
            st.prefetching.lock().remove(&key);
        }
    });
}

#[tauri::command]
pub async fn get_thumbnail(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    max_size: Option<u32>,
) -> Result<PageImage, String> {
    if let Some(hit) = state.cache.get_thumb(&book_id) {
        return Ok(to_page_image(0, hit));
    }
    let edge = max_size.unwrap_or(240).clamp(64, 1024);
    let (path, title) = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| (b.path, b.title))
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // L2 磁盘复用同一套渲染缓存（键 = 首页 + edge 桶）。
        if let Some(bytes) = st.render.get(&book, 0, edge, edge) {
            return assembled_page(bytes);
        }
        let handle = st.source_handle(&book, &path)?;
        let raw = handle.read_raw(0)?;
        let page = pipeline::render_raw(&raw, Some(edge), Some(edge))?;
        st.render.put(&book, 0, edge, edge, &page.bytes);
        Ok(page)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::logging::log_error(
                "get_thumbnail",
                &format!("《{title}》 封面（第 1 页）：{e}"),
            );
            return Err(e);
        }
    };
    state.cache.put_thumb(&book_id, rendered.clone());
    Ok(to_page_image(0, rendered))
}

/// 清空缩略图缓存（内存 LRU + 磁盘首页成品），重新进入书库自动重建。
/// 设置页「重新生成缩略图」按钮的数据面。
#[tauri::command]
pub async fn clear_thumbnail_cache(state: State<'_, Arc<AppState>>) -> Result<u32, String> {
    state.cache.clear_thumbs();
    let n = state.render.clear_thumb_files();
    crate::logging::log_error("clear_thumbnail_cache", &format!("已清除 {n} 个封面缓存文件"));
    Ok(n)
}

/// `sysinfo` 只刷新本进程内存（不扫全进程表，低开销）。
fn blocking_memory(cache: (u64, u64, usize, usize, u64, usize)) -> MemoryStats {
    use sysinfo::{get_current_pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    let pid = get_current_pid().unwrap_or_else(|_| sysinfo::Pid::from(0));
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]));
    let process_mb = sys
        .process(pid)
        .map(|p| p.memory() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);
    MemoryStats {
        process_mb,
        cache_bytes: cache.0,
        cache_limit_bytes: cache.1,
        cached_pages: cache.2,
        cached_thumbs: cache.3,
        webtoon_bytes: cache.4,
        webtoon_tiles: cache.5,
    }
}

#[tauri::command]
pub async fn get_memory_stats(state: State<'_, Arc<AppState>>) -> Result<MemoryStats, String> {
    let snap = state.cache.stats();
    // sysinfo 刷新很快但仍放 blocking，避免偶发阻塞运行时。
    blocking(move || Ok(blocking_memory(snap))).await
}

#[tauri::command]
pub async fn get_dashboard(state: State<'_, Arc<AppState>>) -> Result<Dashboard, String> {
    state.db.with(|conn| {
        let rows = db::list_books(conn, None).map_err(err)?;
        let total_books = rows.len() as u32;
        let reading = rows
            .iter()
            .filter(|b| b.current_page > 0 && b.current_page + 1 < b.page_count)
            .count() as u32;
        let today_pages = db::today_pages(conn).map_err(err)?;
        // 182 天：覆盖前端热力图的 26 周视图（此前 90 天，左半边永远空白）。
        let heat = db::heatmap(conn, 182).map_err(err)?;
        let heatmap = heat
            .into_iter()
            .map(|(date, count)| HeatDay { date, count })
            .collect();
        let series = rows
            .into_iter()
            .filter(|b| b.current_page > 0)
            .take(20)
            .map(|b| SeriesProgress {
                book_id: b.id,
                title: b.title,
                current_page: b.current_page,
                page_count: b.page_count,
            })
            .collect();
        Ok(Dashboard {
            total_books,
            reading,
            today_pages,
            heatmap,
            series,
        })
    })
}

/// 逐日阅读页数：`bookId=null` 全局，`Some(id)` 只看该书（书库右栏明细表）。
#[tauri::command]
pub async fn get_reading_log(
    state: State<'_, Arc<AppState>>,
    book_id: Option<String>,
    days: Option<u32>,
) -> Result<Vec<HeatDay>, String> {
    let d = days.unwrap_or(30).clamp(1, 365) as i64;
    state.db.with(|conn| {
        db::reading_log_days(conn, book_id.as_deref(), d)
            .map(|rows| {
                rows.into_iter()
                    .map(|(date, count)| HeatDay { date, count })
                    .collect()
            })
            .map_err(err)
    })
}

/// 逐日逐书阅读页数（书库趋势堆叠图）。
#[tauri::command]
pub async fn get_reading_by_book(
    state: State<'_, Arc<AppState>>,
    days: Option<u32>,
) -> Result<Vec<BookDayPoint>, String> {
    let d = days.unwrap_or(14).clamp(1, 365) as i64;
    state.db.with(|conn| {
        db::reading_by_book(conn, d)
            .map(|rows| {
                rows.into_iter()
                    .map(|(date, book_id, pages)| BookDayPoint {
                        book_id,
                        date,
                        pages,
                    })
                    .collect()
            })
            .map_err(err)
    })
}

#[tauri::command]
pub async fn set_progress(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    page: u32,
    scroll_pct: Option<f64>,
) -> Result<(), String> {
    // 页码钳制到 0..page_count-1，防脏数据刷坏看板。
    let clamped: u32 = state.db.with(|conn| {
        let row = db::get_book(conn, &book_id)
            .map_err(err)?
            .ok_or_else(|| "书籍不存在".to_string())?;
        let max = row.page_count.saturating_sub(1);
        Ok::<u32, String>(page.min(max))
    })?;
    let pct = scroll_pct.map(|p| p.clamp(0.0, 1.0));
    state
        .db
        .with(|conn| db::set_progress(conn, &book_id, clamped, pct).map_err(err))
}

/// 显式清空阅读页窗口（阅读器卸载/切书时可调；换书首个 get_page 也会自动清）。
#[tauri::command]
pub async fn clear_pages(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.cache.clear_pages();
    Ok(())
}

/// 条漫布局：逐页源图尺寸（header 解析，不解码全图）。
/// 结果按书缓存（切换条漫免重新读全部页头）；删除书籍时级联清缓存。
#[tauri::command]
pub async fn get_webtoon_layout(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<PageDim>, String> {
    // 1) 命中缓存：直接返回（第二次切换条漫瞬时）。
    if let Some(cached) = state.webtoon_layouts.lock().get(&book_id) {
        return Ok(cached
            .iter()
            .enumerate()
            .map(|(i, (w, h))| PageDim {
                index: i as u32,
                width: *w,
                height: *h,
            })
            .collect());
    }
    let path: String = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| b.path)
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let dims = blocking(move || {
        let handle = st.source_handle(&book, &path)?;
        let count = handle.page_count()?;
        let mut out: Vec<(u32, u32)> = Vec::with_capacity(count);
        for i in 0..count {
            // 先读 header（256KB 内通常含 SOF）；失败回退全读。
            let dims: Option<(u32, u32)> = handle
                .read_partial(i as usize, 256 * 1024)
                .ok()
                .and_then(|partial| {
                    image::ImageReader::new(std::io::Cursor::new(&partial.bytes))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok())
                        .filter(|d| d.0 > 0 && d.1 > 0)
                });
            let (w, h) = match dims {
                Some(d) => d,
                None => {
                    let raw = handle.read_raw(i as usize)?;
                    image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
                        .with_guessed_format()?
                        .into_dimensions()?
                }
            };
            out.push((w, h));
        }
        Ok(out)
    })
    .await?;
    state
        .webtoon_layouts
        .lock()
        .insert(book_id.clone(), Arc::new(dims.clone()));
    Ok(dims
        .iter()
        .enumerate()
        .map(|(i, (w, h))| PageDim {
            index: i as u32,
            width: *w,
            height: *h,
        })
        .collect())
}

/// 条漫切片：第 index 页的第 tile 片（0 起）。
/// - L1 切片 LRU → L2 磁盘切片 → 整页物化（全局锁串行，峰值 = 单张显示宽栅格）；
/// - 物化 = 按显示宽度缩放解码（长图 JPEG 走 IDCT 缩放）→ 按 2048px 均分切片
///   → 全部落盘 → 丢栅格。浏览器永不接收整张长图。
#[tauri::command]
pub async fn get_webtoon_tile(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    tile: u32,
    max_width: u32,
) -> Result<PageImage, String> {
    let w = max_width.clamp(320, 2160);
    // 1) L1。
    if let Some(hit) = state.cache.get_tile(&book_id, index, tile, w) {
        return Ok(to_page_image(index, hit));
    }
    let (path, title) = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| (b.path, b.title))
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // 2) L2 磁盘切片。
        if let Some(bytes) = st.render.get_tile(&book, index, tile, w) {
            return assembled_page(bytes);
        }
        // 3) 整页物化（串行；一次解码直接切全部片，无中间编解码往返）。
        let _guard = st.tile_lock.lock();
        // 双检：等锁期间可能已被别的请求物化。
        if let Some(bytes) = st.render.get_tile(&book, index, tile, w) {
            return assembled_page(bytes);
        }
        let handle = st.source_handle(&book, &path)?;
        let raw = handle.read_raw(index as usize)?;
        let (tiles, pages) = pipeline::render_webtoon_tiles(&raw, w)?;
        if tile >= tiles {
            return Err(BackendError::Msg(format!(
                "切片 {tile} 越界（共 {tiles} 片）"
            )));
        }
        // 全部落盘（后续滚动的切片都是磁盘命中），随后丢栅格。
        for (t, p) in pages.iter().enumerate() {
            st.render.put_tile(&book, index, t as u32, w, &p.bytes);
        }
        Ok(pages.into_iter().nth(tile as usize).expect("切片在界内"))
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::logging::log_error(
                "get_webtoon_tile",
                &format!("《{title}》 第 {} 页 切片 {tile}：{e}", index + 1),
            );
            return Err(e);
        }
    };
    state.cache.put_tile(&book_id, index, tile, w, rendered.clone());
    Ok(to_page_image(index, rendered))
}

/// 阶段三:框选区域 OCR。裁剪原图(非展示缩放图)→ 本地 WinRT / HTTP OCR。
#[tauri::command]
pub async fn ocr_region(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    rect: RegionRect,
) -> Result<OcrResult, String> {
    let t0 = Instant::now();
    let (path, endpoint, lang, timeout_s) = {
        let s = state.settings.lock().clone();
        let row = state
            .db
            .with(|conn| db::get_book(conn, &book_id).map_err(err))?
            .ok_or_else(|| "书籍不存在".to_string())?;
        (row.path, s.ocr_endpoint, s.src_lang, s.ocr_timeout_s)
    };
    let png = blocking(move || -> Result<Vec<u8>, BackendError> {
        let src = source::open_source(Path::new(&path))?;
        let count = src.page_count()?;
        if index >= count as u32 {
            return Err(BackendError::Msg(format!(
                "页码 {index} 超出范围(共 {count} 页)"
            )));
        }
        let raw = src.read_raw(index as usize)?;
        ocr::encode_png(&ocr::crop_dyn(&raw, &rect)?)
    })
    .await?;

    let client = state.http.clone();
    let res: Result<String, String> = if endpoint.trim().is_empty() {
        blocking(move || ocr::ocr_local(&png, &lang).map_err(BackendError::Msg)).await
    } else {
        ocr::ocr_http(&client, endpoint.trim(), &png, timeout_s)
            .await
            .map_err(err)
    };

    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = state
        .db
        .with(|conn| db::log_trans(conn, "ocr", res.is_ok(), elapsed_ms).map_err(err));
    match res {
        Ok(text) => Ok(OcrResult { text, elapsed_ms }),
        Err(e) => Err(e),
    }
}

/// 阶段三:翻译一段文本(OpenAI 兼容 /chat/completions)。
#[tauri::command]
pub async fn translate_region(
    state: State<'_, Arc<AppState>>,
    text: String,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可翻译的文本".into());
    }
    let t0 = Instant::now();
    let s = state.settings.lock().clone();
    let res = translate::translate(&state.http, &s, &text).await;
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = state
        .db
        .with(|conn| db::log_trans(conn, "trans", res.is_ok(), elapsed_ms).map_err(err));
    let (translated, model, _) = res?;
    Ok(TranslateResult {
        translated,
        model,
        elapsed_ms,
    })
}

/// 阶段三:OCR/翻译调用统计(设置页展示)。
#[tauri::command]
pub async fn get_trans_stats(state: State<'_, Arc<AppState>>) -> Result<TransStats, String> {
    state.db.with(|conn| db::trans_stats(conn).map_err(err))
}

/// 阶段三:sidecar 健康检查(模型加载状态/设备),工作台四下拉框的状态来源。
#[tauri::command]
pub async fn sidecar_health(state: State<'_, Arc<AppState>>) -> Result<crate::sidecar::SidecarHealth, String> {
    let (endpoint, timeout) = {
        let s = state.settings.lock().clone();
        (s.sidecar_endpoint, s.sidecar_timeout_s)
    };
    let client = state.http.clone();
    crate::sidecar::health(&client, endpoint.trim(), timeout).await
}

/// 阶段三:术语表(按系列)读取。
#[tauri::command]
pub async fn glossary_list(
    state: State<'_, Arc<AppState>>,
    series_id: String,
) -> Result<Vec<(String, String)>, String> {
    state
        .db
        .with(|conn| db::glossary_list(conn, &series_id).map_err(err))
}

/// 阶段三:术语表新增/修改一条。
#[tauri::command]
pub async fn glossary_set(
    state: State<'_, Arc<AppState>>,
    series_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let (series_id, src, dst) = (series_id.trim().to_string(), src.trim().to_string(), dst.trim().to_string());
    if series_id.is_empty() || src.is_empty() || dst.is_empty() {
        return Err("系列 ID、原文、译文都不能为空".into());
    }
    state
        .db
        .with(|conn| db::glossary_upsert(conn, &series_id, &src, &dst).map_err(err))
}

/// 阶段三:术语表删除一条。
#[tauri::command]
pub async fn glossary_remove(
    state: State<'_, Arc<AppState>>,
    series_id: String,
    src: String,
) -> Result<(), String> {
    state
        .db
        .with(|conn| db::glossary_remove(conn, series_id.trim(), src.trim()).map_err(err))
}

#[tauri::command]
pub async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<Settings, String> {
    Ok(state.settings.lock().clone())
}

/// set_settings 持久化到 settings 表的字段对(其余只透传内存)。
/// 注意:hydrate_settings(lib.rs 侧)按同一批 key 回读,两处必须同步维护。
fn settings_persist_pairs(s: &Settings) -> Vec<(&'static str, String)> {
    vec![
        ("theme", s.theme.clone()),
        ("cache_budget_mb", s.cache_budget_mb.to_string()),
        ("library_dir", s.library_dir.clone()),
        ("trans_endpoint", s.trans_endpoint.clone()),
        ("trans_model", s.trans_model.clone()),
        ("trans_api_key", s.trans_api_key.clone()),
        ("trans_temp", s.trans_temp.to_string()),
        ("trans_timeout_s", s.trans_timeout_s.to_string()),
        ("ocr_endpoint", s.ocr_endpoint.clone()),
        ("ocr_timeout_s", s.ocr_timeout_s.to_string()),
        ("src_lang", s.src_lang.clone()),
        ("dst_lang", s.dst_lang.clone()),
        ("experimental_trans", if s.experimental_trans { "true" } else { "false" }.to_string()),
        ("experimental_webtoon", if s.experimental_webtoon { "true" } else { "false" }.to_string()),
        ("sidecar_endpoint", s.sidecar_endpoint.clone()),
        ("sidecar_timeout_s", s.sidecar_timeout_s.to_string()),
        ("wb_detector", s.wb_detector.clone()),
        ("wb_ocr", s.wb_ocr.clone()),
        ("wb_inpaint", s.wb_inpaint.clone()),
        ("experimental_online", if s.experimental_online { "true" } else { "false" }.to_string()),
        ("online_proxy", s.online_proxy.clone()),
        ("online_concurrency", s.online_concurrency.to_string()),
        ("online_headers", s.online_headers.clone()),
    ]
}

#[tauri::command]
pub async fn set_settings(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> Result<(), String> {
    // 缩略图与页缓存预算即时生效（MB→字节；至少 16MB；同一滑杆管两级）。
    let budget = (settings.cache_budget_mb.max(16) as u64) * 1024 * 1024;
    state.cache.set_budgets(budget);
    let persist = settings_persist_pairs(&settings);
    let res = state.db.with(|conn| {
        for (k, v) in persist {
            db::set_setting(conn, k, &v).map_err(err)?;
        }
        Ok(())
    });
    *state.settings.lock() = settings;
    // 无库文件时（如首次启动内存态）仍接受设置，仅跳过持久化。
    match res {
        Ok(()) => Ok(()),
        Err(e) if e == "数据库尚未初始化" => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归守卫:hydrate_settings 会回读 trans_api_key,
    /// 持久化清单必须包含它(阶段二曾漏掉该键导致 key 永远存不下来)。
    #[test]
    fn persist_pairs_cover_every_hydrated_key() {
        let s = Settings::default();
        let keys: Vec<&str> = settings_persist_pairs(&s).into_iter().map(|(k, _)| k).collect();
        for k in [
            "theme",
            "cache_budget_mb",
            "library_dir",
            "trans_endpoint",
            "trans_model",
            "trans_api_key",
            "trans_temp",
            "trans_timeout_s",
            "ocr_endpoint",
            "ocr_timeout_s",
            "src_lang",
            "dst_lang",
            "experimental_trans",
            "experimental_webtoon",
            "sidecar_endpoint",
            "sidecar_timeout_s",
            "wb_detector",
            "wb_ocr",
            "wb_inpaint",
            "experimental_online",
            "online_proxy",
            "online_concurrency",
            "online_headers",
        ] {
            assert!(keys.contains(&k), "persist 清单缺少 {k}");
        }
    }

    fn tiny_png(path: &Path) {
        use image::ImageEncoder as _;
        let img = image::RgbImage::new(8, 8);
        image::codecs::png::PngEncoder::new(std::fs::File::create(path).unwrap())
            .write_image(img.as_raw(), 8, 8, image::ExtendedColorType::Rgb8)
            .unwrap();
    }

    fn build_zip(path: &Path) {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        z.start_file("p0.png", SimpleFileOptions::default()).unwrap();
        z.write_all(b"not-a-real-png").unwrap(); // 导入只数条目名，不解码
        z.finish().unwrap();
    }

    /// 2026-10-06 事故回归：拖入"装了多本书的文件夹"必须像旧 scan_library
    /// 一样逐子项入库，而不是当单本书报"没有可读图片"。
    #[test]
    fn import_folder_semantics() {
        let dir = std::env::temp_dir().join(format!("mr-imp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 书库根：子文件夹书(2 张 png) + zip 书。
        let root = dir.join("library");
        let book_dir = root.join("第一话");
        std::fs::create_dir_all(&book_dir).unwrap();
        tiny_png(&book_dir.join("p1.png"));
        tiny_png(&book_dir.join("p2.png"));
        build_zip(&root.join("第二话.zip"));

        // 单本书：直下就是图片。
        let single = dir.join("单行本");
        std::fs::create_dir_all(&single).unwrap();
        tiny_png(&single.join("p1.png"));

        let db = dir.join("lib.db");

        // 书库根 → 逐子项入库 2 本。
        let items = import_blocking(db.clone(), vec![root.to_string_lossy().into()]).unwrap();
        assert_eq!(items.iter().filter(|i| i.status == "added").count(), 2);

        // 直下图片的目录 → 单本书。
        let items = import_blocking(db.clone(), vec![single.to_string_lossy().into()]).unwrap();
        assert_eq!(items.iter().filter(|i| i.status == "added").count(), 1);

        // 重复导入 → 全部 skipped（已在书库中），不重复入库。
        let items = import_blocking(
            db,
            vec![root.to_string_lossy().into(), single.to_string_lossy().into()],
        )
        .unwrap();
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| i.status == "skipped"), "{items:?}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
