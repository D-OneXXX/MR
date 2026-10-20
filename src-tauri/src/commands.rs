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

use crate::db::{self};
use crate::ocr;
use crate::pipeline;
use crate::pipeline::RenderedPage;
use crate::source::{self, BackendError, ImageSource};
use crate::state::AppState;
use crate::translate;
use crate::{
    BookDayPoint, BookInfo, Dashboard, HeatDay, ImportItemResult, ImportResult, MemoryStats,
    OcrResult, OnlineProbe, PageDim, PageEntry, PageImage, RegionRect, RemoveResult, ScanResult,
    SeriesProgress, Settings, TransStats, TranslateResult,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::State;

pub(crate) fn err(e: impl ToString) -> String {
    e.to_string()
}

fn webtoon_ready(r: &db::BookRow) -> bool {
    if r.source_type == "local" {
        return true;
    }
    match serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json) {
        Ok(meta) => {
            !meta.pages.is_empty()
                && meta
                    .pages
                    .iter()
                    .all(|p| p.width.unwrap_or(0) > 0 && p.height.unwrap_or(0) > 0)
        }
        Err(e) => {
            crate::logging::log_error("online_meta", &format!("书籍 {} 元数据损坏：{e}", r.id));
            false
        }
    }
}

fn to_book_info(r: db::BookRow) -> BookInfo {
    let webtoon_ready = webtoon_ready(&r);
    let stored = serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json).ok();
    BookInfo {
        id: r.id,
        title: r.title,
        path: r.path,
        page_count: r.page_count,
        current_page: r.current_page,
        updated_at: r.updated_at,
        scroll_pct: r.scroll_pct,
        source_type: r.source_type,
        webtoon_ready,
        series_id: stored.as_ref().and_then(|m| m.series_id.clone()),
        next_url: stored.and_then(|m| m.next_url),
    }
}

fn natural_segments(s: &str) -> Vec<(bool, &str)> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut previous_digit = None;
    for (index, ch) in s.char_indices() {
        let digit = ch.is_ascii_digit();
        if let Some(previous) = previous_digit {
            if previous != digit {
                segments.push((previous, &s[start..index]));
                start = index;
            }
        }
        previous_digit = Some(digit);
    }
    if start < s.len() {
        segments.push((previous_digit.unwrap_or(false), &s[start..]));
    }
    segments
}

fn numeric_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let a = a.trim_start_matches('0');
    let b = b.trim_start_matches('0');
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// 数字段按数值比较；非数字结构不同则退回字典序，避免“第10话/第2卷”误排。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let a_parts = natural_segments(a);
    let b_parts = natural_segments(b);
    let a_text: Vec<&str> = a_parts
        .iter()
        .filter(|(digit, _)| !digit)
        .map(|(_, text)| *text)
        .collect();
    let b_text: Vec<&str> = b_parts
        .iter()
        .filter(|(digit, _)| !digit)
        .map(|(_, text)| *text)
        .collect();
    if a_parts.len() != b_parts.len() || a_text != b_text {
        return a.cmp(b);
    }
    for ((a_digit, a_text), (b_digit, b_text)) in a_parts.iter().zip(&b_parts) {
        if *a_digit && *b_digit {
            let ordering = numeric_cmp(a_text, b_text);
            if ordering != std::cmp::Ordering::Equal {
                return ordering;
            }
        }
    }
    a.cmp(b)
}

fn is_title_separator(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            ':' | '：' | '-' | '—' | '_' | '·' | '.' | '、' | ',' | '，' | ';' | '；' | '#' | '＃'
        )
}

fn title_prefix(title: &str) -> String {
    let trimmed = title.trim_end_matches(is_title_separator);
    let Some(last_digit) = trimmed.rfind(|c: char| c.is_ascii_digit()) else {
        return trimmed.to_string();
    };
    let bytes = trimmed.as_bytes();
    let mut start = last_digit;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    trimmed[..start]
        .trim_end_matches(is_title_separator)
        .to_string()
}

fn pick_next(current: &db::BookRow, candidates: Vec<db::BookRow>) -> Option<db::BookRow> {
    candidates
        .into_iter()
        .filter(|candidate| {
            let ordering = natural_cmp(&candidate.title, &current.title);
            ordering == std::cmp::Ordering::Greater
                || (ordering == std::cmp::Ordering::Equal
                    && candidate.updated_at > current.updated_at)
        })
        .min_by(|a, b| {
            natural_cmp(&a.title, &b.title)
                .then_with(|| a.updated_at.cmp(&b.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        })
}

fn get_next_book_impl(
    conn: &rusqlite::Connection,
    book_id: &str,
) -> Result<Option<BookInfo>, BackendError> {
    let Some(current) = db::get_book(conn, book_id)? else {
        return Ok(None);
    };
    let stored = serde_json::from_str::<crate::online::StoredMeta>(&current.meta_json).ok();

    if let Some(next) = stored.as_ref().and_then(|meta| meta.next_url.as_deref()) {
        if let Ok(next) = crate::online::normalize_url(next) {
            let next_id = db::book_id_for_path(next.as_str());
            if next_id != current.id {
                if let Some(row) = db::get_book(conn, &next_id)? {
                    return Ok(Some(to_book_info(row)));
                }
            }
        }
    }

    let books = db::list_books(conn, None)?;
    let mut series_candidates = Vec::new();
    if let Some(series_id) = stored.as_ref().and_then(|meta| meta.series_id.as_deref()) {
        for book in &books {
            if book.id == current.id {
                continue;
            }
            let Ok(meta) = serde_json::from_str::<crate::online::StoredMeta>(&book.meta_json)
            else {
                continue;
            };
            if meta.series_id.as_deref() == Some(series_id) {
                series_candidates.push(book.clone());
            }
        }
    }

    let next = if !series_candidates.is_empty() {
        pick_next(&current, series_candidates)
    } else {
        let prefix = title_prefix(&current.title);
        if prefix.is_empty() {
            None
        } else {
            let candidates = books
                .into_iter()
                .filter(|book| {
                    book.id != current.id
                        && book.title != current.title
                        && book.title.starts_with(&prefix)
                })
                .collect();
            pick_next(&current, candidates)
        }
    };
    Ok(next.map(to_book_info))
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
        Some((stem, ext)) if ["zip", "cbz"].contains(&ext.to_ascii_lowercase().as_str()) => {
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

/// 下载文件复用现有单本扫描/入库逻辑；非 zip/cbz 返回 None。
pub(crate) fn import_local_archive(
    db_path: PathBuf,
    path: &Path,
) -> Result<Option<String>, BackendError> {
    if !source::is_archive_path(path) {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open(db_path)?;
    db::init_schema(&conn)?;
    let book = scan_single_book(&conn, path)?;
    Ok(Some(book.id))
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
pub async fn scan_library(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<ScanResult, String> {
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
fn import_outcome(
    path: &str,
    status: &str,
    message: String,
    book: Option<BookInfo>,
) -> ImportItemResult {
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
                    Ok(b) => {
                        import_outcome(&path, "restored", "已恢复，阅读进度保留".into(), Some(b))
                    }
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
            out.push(import_outcome(
                &path,
                "failed",
                format!("路径不存在：{path}"),
                None,
            ));
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
                        "目录中没有可识别的书籍（需要：直下图片 / 含图片的子文件夹 / zip/cbz）"
                            .into(),
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
                let Some(b) = db::get_book(&conn, id)? else {
                    continue;
                };
                match delete_source_if_local(&b.path, &b.source_type) {
                    Ok(deleted) => {
                        if deleted {
                            // 路径本就不存在时辅助函数返回 false：记录仍硬删，
                            // 但没有实际删除动作，故不计入 deleted_files。
                            deleted_files += 1;
                        }
                        hard.push(id.clone());
                    }
                    Err(e) => errors.push(format!("{}：{e}", b.path)),
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
    // 内存缓存 + 磁盘渲染缓存 + 条漫布局缓存 + 常开源句柄级联清理。
    // 注意：在途预取/后台渲染无法撤回，旧页可能在此之后又写回 L1/L2；
    // 本次不引入 generation key，接受该残留竞态（重新进入阅读会按新源重建）。
    for id in &ids {
        state.cache.remove_book(id);
        state.render.remove_book(id);
        state.webtoon_layouts.lock().remove(id);
    }
    // 句柄池按代际整体失效：避免删除与在途打开竞态时旧句柄重新插回。
    state.invalidate_sources();
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
pub async fn get_next_book(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Option<BookInfo>, String> {
    state
        .db
        .with(|conn| get_next_book_impl(conn, &book_id).map_err(err))
}

#[tauri::command]
pub async fn list_entries(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<PageEntry>, String> {
    let st = state.inner().clone();
    let bid = book_id.clone();
    blocking(move || {
        let handle = st.source_handle_for_book(&bid)?;
        Ok(handle
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
    let (title, is_online) = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|b| (b.title, b.source_type != "local"))
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // 2) L2 磁盘成品缓存。
        if let Some(bytes) = st.render.get(&book, index, w, h) {
            return assembled_page(bytes);
        }
        // 3) 全管线（常开句柄，不再每页重开 zip/重读目录）。
        let handle = st.source_handle_for_book(&book)?;
        let raw = handle.read_raw(index as usize)?;
        let page = pipeline::render_raw(&raw, max_width, max_height)?;
        st.render.put(&book, index, w, h, &page.bytes);
        st.render
            .maybe_trim(crate::render_cache::RENDER_DISK_BUDGET);
        Ok(page)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // 失败链路：含书名/页码/原因落盘留痕（P0 缩略图失败链路）。
            crate::logging::log_error("get_page", &format!("《{title}》 第 {} 页：{e}", index + 1));
            return Err(e);
        }
    };
    state
        .cache
        .put_page(&book_id, index, w, h, rendered.clone());
    prefetch_neighbors(&state, &book_id, is_online, index, w, h);
    Ok(to_page_image(index, rendered))
}

/// 服务端邻页预取：主请求落地后，后台把邻页灌进 L1/L2，
/// 翻页不依赖前端 idle 回调时机（P0 手感：命中翻页零等待）。
/// 本地读盘廉价，预取 ±1/±2；在线走网络，只预取 +1/+2（不向前回读）。
fn prefetch_neighbors(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
    is_online: bool,
    index: u32,
    w: u32,
    h: u32,
) {
    let st = state.inner().clone();
    let book = book_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let handle = match st.source_handle_for_book(&book) {
            Ok(h) => h,
            Err(_) => return,
        };
        let page_count = handle.page_count().unwrap_or(0) as i64;
        let (mw, mh) = (Some(w).filter(|v| *v > 0), Some(h).filter(|v| *v > 0));
        let dirs: &[i64] = if is_online { &[1, 2] } else { &[1, -1, 2, -2] };
        for d in dirs {
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
                    handle.read_raw(t as usize).and_then(|raw| {
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
    let title = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|b| b.title)
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // L2 磁盘复用同一套渲染缓存（键 = 首页 + edge 桶）。
        if let Some(bytes) = st.render.get(&book, 0, edge, edge) {
            return assembled_page(bytes);
        }
        let handle = st.source_handle_for_book(&book)?;
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
    crate::logging::log_error(
        "clear_thumbnail_cache",
        &format!("已清除 {n} 个封面缓存文件"),
    );
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

/// 条漫布局：逐页源图尺寸（本地 header 解析，不解码全图；在线直接读清单尺寸）。
/// 结果按书缓存（切换条漫免重新读全部页头）；删除书籍时级联清缓存。
#[tauri::command]
pub async fn get_webtoon_layout(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<PageDim>, String> {
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
    let row = state
        .db
        .with(|conn| db::get_book(conn, &book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    if row.source_type != "local" {
        let meta: crate::online::StoredMeta =
            serde_json::from_str(&row.meta_json).map_err(|e| format!("在线书元数据损坏：{e}"))?;
        if meta.pages.is_empty()
            || meta
                .pages
                .iter()
                .any(|p| p.width.unwrap_or(0) == 0 || p.height.unwrap_or(0) == 0)
        {
            return Err("该在线书籍缺少页面尺寸，无法使用条漫模式".into());
        }
        let dims: Vec<(u32, u32)> = meta
            .pages
            .iter()
            .map(|p| (p.width.unwrap(), p.height.unwrap()))
            .collect();
        // 与本地分支一致写入布局缓存；清单变化/删书时由命令层失效。
        state
            .webtoon_layouts
            .lock()
            .insert(book_id.clone(), Arc::new(dims.clone()));
        return Ok(dims
            .iter()
            .enumerate()
            .map(|(i, (w, h))| PageDim {
                index: i as u32,
                width: *w,
                height: *h,
            })
            .collect());
    }
    // 句柄打开（SQLite 查询 / zip 或目录打开）必须在 blocking 内，避免占住 async worker。
    let st = state.inner().clone();
    let bid = book_id.clone();
    let dims = blocking(move || {
        let handle = st.source_handle_for_book(&bid)?;
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
    let title = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|b| b.title)
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
        // 先读原页再抢切片锁：在线源 read_raw 可能下载 30s+，持全局锁会阻塞
        // 其它书/页的切片请求；锁内只做“双检 + 解码切片 + 落盘”。
        let handle = st.source_handle_for_book(&book)?;
        let raw = handle.read_raw(index as usize)?;
        let _guard = st.tile_lock.lock();
        // 双检：等锁期间可能已被别的请求物化。
        if let Some(bytes) = st.render.get_tile(&book, index, tile, w) {
            return assembled_page(bytes);
        }
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
    state
        .cache
        .put_tile(&book_id, index, tile, w, rendered.clone());
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
    let (endpoint, lang, timeout_s) = {
        let s = state.settings.lock().clone();
        (s.ocr_endpoint, s.src_lang, s.ocr_timeout_s)
    };
    let st = state.inner().clone();
    let bid = book_id.clone();
    let png = blocking(move || -> Result<Vec<u8>, BackendError> {
        let handle = st.source_handle_for_book(&bid)?;
        let count = handle.page_count()?;
        if index >= count as u32 {
            return Err(BackendError::Msg(format!(
                "页码 {index} 超出范围(共 {count} 页)"
            )));
        }
        let raw = handle.read_raw(index as usize)?;
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
pub async fn sidecar_health(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::sidecar::SidecarHealth, String> {
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
    let (series_id, src, dst) = (
        series_id.trim().to_string(),
        src.trim().to_string(),
        dst.trim().to_string(),
    );
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
        (
            "experimental_trans",
            if s.experimental_trans {
                "true"
            } else {
                "false"
            }
            .to_string(),
        ),
        (
            "experimental_webtoon",
            if s.experimental_webtoon {
                "true"
            } else {
                "false"
            }
            .to_string(),
        ),
        ("sidecar_endpoint", s.sidecar_endpoint.clone()),
        ("sidecar_timeout_s", s.sidecar_timeout_s.to_string()),
        ("wb_detector", s.wb_detector.clone()),
        ("wb_ocr", s.wb_ocr.clone()),
        ("wb_inpaint", s.wb_inpaint.clone()),
        (
            "experimental_online",
            if s.experimental_online {
                "true"
            } else {
                "false"
            }
            .to_string(),
        ),
        ("online_proxy", s.online_proxy.clone()),
        ("online_concurrency", s.online_concurrency.to_string()),
        ("online_headers", s.online_headers.clone()),
    ]
}

/// 前端已解析出的页面列表入库前整理：规范化 URL、去重、页数上限。
fn resolved_pages_meta(
    url: &str,
    title: &str,
    page_urls: &[String],
) -> Result<crate::online::direct::OnlineBookMeta, BackendError> {
    let canonical = crate::online::normalize_url(url)?;
    let pages = crate::online::normalize_page_urls(page_urls)?;
    let title = if title.trim().is_empty() {
        crate::online::title_from_url(&canonical)
    } else {
        title.to_string()
    };
    crate::online::direct::make_meta(&canonical, &title, pages)
}

/// 单本 upsert（必须由调用方提供事务/连接）：变化检测、活动任务拒绝、派生清理。
fn upsert_resolved_meta(
    conn: &rusqlite::Connection,
    meta: &crate::online::direct::OnlineBookMeta,
) -> Result<(db::BookRow, bool), BackendError> {
    // 兜底：0 页时 upsert 的页数钳制（page_count-1）会写出负进度。
    if meta.page_count == 0 {
        return Err(BackendError::Msg("在线书清单没有可读页面，无法入库".into()));
    }
    let id = db::book_id_for_path(&meta.canonical_url);
    let new_hash = serde_json::from_str::<crate::online::StoredMeta>(&meta.meta_json)
        .map_err(|e| BackendError::Msg(format!("内部元数据错误：{e}")))?
        .manifest_hash;
    let old = db::get_book(conn, &id)?;
    // 旧 meta_json 损坏按“已变化”处理，避免脏行挡住清单更新。
    let old_hash = old.as_ref().and_then(|b| {
        serde_json::from_str::<crate::online::StoredMeta>(&b.meta_json)
            .ok()
            .map(|m| m.manifest_hash)
    });
    let changed = old_hash.as_deref() != Some(new_hash.as_str());
    if changed && old.is_some() && db::has_active_batch(conn, &id)? {
        return Err(BackendError::Msg(
            "清单已变化，请先取消该书的批量任务再更新".into(),
        ));
    }
    db::upsert_online_book(
        conn,
        &id,
        &meta.canonical_url,
        &meta.title,
        meta.page_count as u32,
        &meta.source_type,
        &meta.meta_json,
    )?;
    if changed && old.is_some() {
        db::clear_book_derived(conn, &id)?;
    }
    let row =
        db::get_book(conn, &id)?.ok_or_else(|| BackendError::Msg("在线书入库后回读失败".into()))?;
    Ok((row, changed))
}

/// 把解析结果落库/恢复：单本事务；返回整行与“是否变化”。
fn apply_resolved_meta(
    st: &Arc<AppState>,
    meta: &crate::online::direct::OnlineBookMeta,
) -> Result<(db::BookRow, bool), BackendError> {
    st.db
        .with(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let result = upsert_resolved_meta(&tx, meta).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(result)
        })
        .map_err(BackendError::Msg)
}

/// 批量入库：所有书共用同一事务；任一失败全部回滚。
pub(crate) fn ingest_resolved_batch(
    st: &Arc<AppState>,
    metas: Vec<crate::online::direct::OnlineBookMeta>,
) -> Result<Vec<BookInfo>, BackendError> {
    let (books, changed_ids) = st
        .db
        .with(|conn| {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let mut books = Vec::with_capacity(metas.len());
            let mut changed_ids = Vec::new();
            for meta in &metas {
                let (row, changed) = upsert_resolved_meta(&tx, meta).map_err(|e| e.to_string())?;
                if changed {
                    changed_ids.push(row.id.clone());
                }
                let mut info = to_book_info(row);
                info.series_id = meta.series_id.clone();
                info.next_url = meta.next_url.clone();
                books.push(info);
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok((books, changed_ids))
        })
        .map_err(BackendError::Msg)?;

    for id in &changed_ids {
        st.cache.remove_book(id);
        st.render.remove_book(id);
        st.webtoon_layouts.lock().remove(id);
    }
    if !changed_ids.is_empty() {
        st.invalidate_sources();
    }
    Ok(books)
}

/// 共享入库路径：页面 URL 规范化/去重/上限 + 在线书 upsert + 缓存失效。
pub(crate) fn ingest_resolved_pages(
    st: &Arc<AppState>,
    url: &str,
    title: &str,
    page_urls: &[String],
) -> Result<BookInfo, BackendError> {
    let meta = resolved_pages_meta(url, title, page_urls)?;
    let (row, changed) = apply_resolved_meta(st, &meta)?;
    if changed {
        st.cache.remove_book(&row.id);
        st.render.remove_book(&row.id);
        st.webtoon_layouts.lock().remove(&row.id);
        st.invalidate_sources();
    }
    Ok(to_book_info(row))
}

/// 解析 JSON 清单或单页 HTML 图集并入库/恢复；不改变已存在书的阅读进度。
#[tauri::command]
pub async fn resolve_online_url(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<BookInfo, String> {
    let st = state.inner().clone();
    let (row, changed) = blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new(&s.online_proxy, &headers)?;
        let meta = crate::online::resolve(&http, &url)?;
        apply_resolved_meta(&st, &meta)
    })
    .await?;

    if changed {
        state.cache.remove_book(&row.id);
        state.render.remove_book(&row.id);
        state.webtoon_layouts.lock().remove(&row.id);
        state.invalidate_sources();
        // 在途预取/后台渲染无法撤回，旧页可能在此之后又写回 L1/L2；
        // 本次不引入 generation key，接受该残留竞态（重新阅读会按新清单重建）。
    }
    Ok(to_book_info(row))
}

/// 接收前端已解析的页面 URL 列表并直接入库（不采集会话凭据）。
#[tauri::command]
pub async fn import_resolved_pages(
    state: State<'_, Arc<AppState>>,
    url: String,
    title: String,
    page_urls: Vec<String>,
) -> Result<BookInfo, String> {
    if !state.settings.lock().experimental_online {
        return Err("在线直读未开启".into());
    }
    let st = state.inner().clone();
    blocking(move || ingest_resolved_pages(&st, &url, &title, &page_urls)).await
}

#[tauri::command]
pub async fn import_online_batch(
    state: State<'_, Arc<AppState>>,
    payload_json: String,
) -> Result<Vec<BookInfo>, String> {
    if !state.settings.lock().experimental_online {
        return Err("在线直读未开启".into());
    }
    let st = state.inner().clone();
    blocking(move || {
        let metas = crate::online::direct::parse_batch_payload(payload_json.as_bytes())?;
        ingest_resolved_batch(&st, metas)
    })
    .await
}

/// 只测试 JSON 清单或单页 HTML 图集 + 代理连通性，不写库。
#[tauri::command]
pub async fn test_online_connection(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<OnlineProbe, String> {
    let st = state.inner().clone();
    blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new(&s.online_proxy, &headers)?;
        let t0 = Instant::now();
        let meta = crate::online::resolve(&http, &url)?;
        // 与 resolve 相同的 0 页门禁：可连通但不可入库，ok 反映最终可用性。
        let ok = meta.page_count > 0;
        let page_count = meta.page_count as u32;
        Ok(OnlineProbe {
            ok,
            title: meta.title,
            page_count,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            message: if ok {
                "可解析".into()
            } else {
                "在线书清单没有可读页面，无法入库".into()
            },
        })
    })
    .await
}

fn set_readonly_flag(path: &Path, readonly: bool) -> Result<(), std::io::Error> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    if permissions.readonly() != readonly {
        permissions.set_readonly(readonly);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

/// 浏览器下载导入成功后标记只读，防止误改。
pub(crate) fn set_file_readonly(path: &Path) -> Result<(), BackendError> {
    set_readonly_flag(path, true)?;
    Ok(())
}

fn clear_readonly(path: &Path) -> Result<(), std::io::Error> {
    set_readonly_flag(path, false)
}

/// 本地书删除源文件；在线书返回 false（不触碰远程源）。
/// 本地路径已不存在也返回 false：记录仍会硬删，但 `deleted_files` 不计数
/// （brief 的辅助语义：没有实际删除动作就不虚报）。
fn delete_source_if_local(path: &str, source_type: &str) -> Result<bool, std::io::Error> {
    if source_type != "local" {
        return Ok(false);
    }
    let p = PathBuf::from(path);
    if p.is_dir() {
        clear_readonly(&p)?;
        std::fs::remove_dir_all(&p)?;
        Ok(true)
    } else if p.is_file() {
        clear_readonly(&p)?;
        std::fs::remove_file(&p)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub(crate) fn apply_session_online_headers(
    state: &AppState,
    headers: Option<String>,
) -> Result<(), String> {
    let headers = match headers {
        Some(raw) => {
            crate::online::validate_headers(&raw)?;
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                None
            } else {
                Some(raw)
            }
        }
        None => None,
    };
    *state.session_online_headers.lock() = headers;
    state.invalidate_sources();
    Ok(())
}

#[tauri::command]
pub fn set_session_online_headers(
    state: State<'_, Arc<AppState>>,
    headers: Option<String>,
) -> Result<(), String> {
    apply_session_online_headers(state.inner(), headers)
}

#[tauri::command]
pub fn clear_session_online_headers(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    apply_session_online_headers(state.inner(), None)
}

#[tauri::command]
pub fn get_session_online_headers(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.session_online_headers.lock().clone()
}

#[tauri::command]
pub async fn set_settings(
    state: State<'_, Arc<AppState>>,
    mut settings: Settings,
) -> Result<(), String> {
    // 在线源连接参数与请求头先校验；非法输入不落库、不改内存态。
    crate::online::validate_proxy(&settings.online_proxy)?;
    crate::online::validate_headers(&settings.online_headers)?;
    settings.online_concurrency = settings.online_concurrency.clamp(1, 8);

    // 缩略图与页缓存预算即时生效（MB→字节；至少 16MB；同一滑杆管两级）。
    let budget = (settings.cache_budget_mb.max(16) as u64) * 1024 * 1024;
    state.cache.set_budgets(budget);

    let old = state.settings.lock().clone();
    // 代理/并发/请求头变化后，旧源句柄（含已解析 URL 与 Cookie 上下文）全部作废。
    let online_conn_changed = old.online_proxy != settings.online_proxy
        || old.online_concurrency != settings.online_concurrency
        || old.online_headers != settings.online_headers;

    let persist = settings_persist_pairs(&settings);
    let res = state.db.with(|conn| {
        for (k, v) in persist {
            db::set_setting(conn, k, &v).map_err(err)?;
        }
        Ok(())
    });
    *state.settings.lock() = settings;
    if online_conn_changed {
        state.invalidate_sources();
    }
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
        let keys: Vec<&str> = settings_persist_pairs(&s)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
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

    fn test_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mr-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn import_local_archive_routes_zip_cbz_and_other() {
        let dir = test_temp_dir("import-archive");
        let db = dir.join("lib.db");
        let zip = dir.join("book.zip");
        let cbz = dir.join("book.cbz");
        build_zip(&zip);
        build_zip(&cbz);

        let id = import_local_archive(db.clone(), &zip)
            .unwrap()
            .expect("zip 应导入");
        assert_eq!(id, db::book_id_for_path(&zip.to_string_lossy()));
        let conn = rusqlite::Connection::open(&db).unwrap();
        let row = db::get_book(&conn, &id).unwrap().expect("zip 应入库");
        assert_eq!(row.path, zip.to_string_lossy().to_string());
        assert_eq!(row.source_type, "local");

        assert!(
            import_local_archive(db.clone(), &cbz).unwrap().is_some(),
            "cbz 应导入"
        );

        let png = dir.join("cover.png");
        std::fs::write(&png, b"png").unwrap();
        assert!(
            import_local_archive(db, &png).unwrap().is_none(),
            "非 zip/cbz 不应导入"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn readonly_file_is_cleared_before_delete() {
        let dir = test_temp_dir("readonly");
        let file = dir.join("book.zip");
        std::fs::write(&file, b"zip").unwrap();

        set_file_readonly(&file).unwrap();
        assert!(std::fs::metadata(&file).unwrap().permissions().readonly());
        clear_readonly(&file).unwrap();
        assert!(!std::fs::metadata(&file).unwrap().permissions().readonly());

        set_file_readonly(&file).unwrap();
        assert!(delete_source_if_local(&file.to_string_lossy(), "local").unwrap());
        assert!(!file.exists());

        std::fs::remove_dir_all(&dir).ok();
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
        z.start_file("p0.png", SimpleFileOptions::default())
            .unwrap();
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
            vec![
                root.to_string_lossy().into(),
                single.to_string_lossy().into(),
            ],
        )
        .unwrap();
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|i| i.status == "skipped"), "{items:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn book_info_webtoon_ready_depends_on_dims() {
        let local = db::BookRow {
            id: "l".into(),
            path: "p".into(),
            title: "L".into(),
            page_count: 1,
            current_page: 0,
            updated_at: String::new(),
            scroll_pct: -1.0,
            source_type: "local".into(),
            meta_json: "{}".into(),
        };
        assert!(to_book_info(local).webtoon_ready);

        let online = db::BookRow {
            id: "o".into(), path: "http://x/a".into(), title: "O".into(),
            page_count: 2, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200},{"url":"http://x/2.jpg"}]}"#.into(),
        };
        assert!(!to_book_info(online).webtoon_ready);

        let online_ok = db::BookRow {
            id: "o2".into(), path: "http://x/b".into(), title: "O2".into(),
            page_count: 1, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200}]}"#.into(),
        };
        assert!(to_book_info(online_ok).webtoon_ready);

        // 元数据损坏：只降级为不可条漫，不阻断列表。
        let corrupt = db::BookRow {
            id: "o3".into(),
            path: "http://x/c".into(),
            title: "O3".into(),
            page_count: 1,
            current_page: 0,
            updated_at: String::new(),
            scroll_pct: -1.0,
            source_type: "generic_manga".into(),
            meta_json: "{not-json".into(),
        };
        assert!(!to_book_info(corrupt).webtoon_ready);
    }

    #[test]
    fn online_source_path_is_never_deleted() {
        let url = "https://example.com/gallery/1";
        assert_eq!(delete_source_if_local(url, "generic_manga").unwrap(), false);
    }

    // ---------- 清单入库/变化编排（离线：内存 SQLite，不发网络请求） ----------

    use rusqlite::Connection;

    /// 独立内存库的 `AppState`，与真实数据目录/网络隔离。
    fn online_state() -> Arc<AppState> {
        let st = AppState::new();
        let conn = Connection::open_in_memory().expect("打开内存数据库");
        db::init_schema(&conn).expect("初始化表结构");
        st.db.set(conn);
        Arc::new(st)
    }

    fn page_ref(index: u32) -> crate::online::PageRef {
        crate::online::PageRef {
            url: format!("https://example.com/pages/{index}.jpg"),
            width: Some(800),
            height: Some(1200),
        }
    }

    fn pages(n: u32) -> Vec<crate::online::PageRef> {
        (1..=n).map(page_ref).collect()
    }

    /// 构造与 `online::resolve` 同形状的解析结果（StoredMeta 落盘 JSON）。
    fn online_meta(
        canonical_url: &str,
        title: &str,
        hash: &str,
        pages: Vec<crate::online::PageRef>,
    ) -> crate::online::direct::OnlineBookMeta {
        let stored = crate::online::StoredMeta {
            schema: 1,
            manifest_hash: hash.to_string(),
            fetched_at: "2026-10-19 00:00:00".to_string(),
            pages,
            series_id: None,
            next_url: None,
        };
        crate::online::direct::OnlineBookMeta {
            canonical_url: canonical_url.to_string(),
            source_type: "generic_manga".to_string(),
            title: title.to_string(),
            page_count: stored.pages.len(),
            meta_json: serde_json::to_string(&stored).expect("序列化 StoredMeta"),
            series_id: None,
            next_url: None,
        }
    }

    #[test]
    fn apply_resolved_meta_inserts_new_online_book() {
        let st = online_state();
        let meta = online_meta("https://example.com/gallery/1", "新书", "h1", pages(2));

        let (row, changed) = apply_resolved_meta(&st, &meta).expect("新书应入库");

        assert!(changed, "首次入库应视为清单变化");
        assert_eq!(row.id, db::book_id_for_path(&meta.canonical_url));
        assert_eq!(row.title, "新书");
        assert_eq!(row.page_count, 2);
        assert_eq!(row.current_page, 0);
        assert_eq!(row.source_type, "generic_manga");
    }

    #[test]
    fn apply_resolved_meta_keeps_derived_caches_when_hash_unchanged() {
        let st = online_state();
        let meta = online_meta("https://example.com/gallery/2", "不变", "h1", pages(2));
        let (row, _) = apply_resolved_meta(&st, &meta).expect("首次入库");
        let id = row.id;

        st.db
            .with(|conn| {
                db::save_page_ocr(conn, &id, 0, 800, 1200, "[]", r#"["原文"]"#)
                    .map_err(|e| e.to_string())?;
                db::cache_put(conn, "t1", "译文", &id).map_err(|e| e.to_string())
            })
            .expect("写入派生缓存");

        let (row, changed) = apply_resolved_meta(&st, &meta).expect("同清单应可重复解析");

        assert!(!changed, "hash 未变不应标记变化");
        assert_eq!(row.id, id);
        st.db
            .with(|conn| {
                assert!(db::get_page_ocr(conn, &id, 0).unwrap().is_some());
                assert_eq!(db::cache_get(conn, "t1").unwrap().as_deref(), Some("译文"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn apply_resolved_meta_rejects_hash_change_with_active_batch() {
        let st = online_state();
        let original = online_meta("https://example.com/gallery/3", "旧标题", "h1", pages(2));
        let (row, _) = apply_resolved_meta(&st, &original).expect("首次入库");
        let id = row.id;
        let changed_meta = online_meta("https://example.com/gallery/3", "新标题", "h2", pages(1));

        for batch_state in ["queued", "paused"] {
            st.db
                .with(|conn| {
                    conn.execute("DELETE FROM batch_jobs", [])
                        .map_err(|e| e.to_string())?;
                    let job =
                        db::batch_create(conn, &id, "旧标题", 2).map_err(|e| e.to_string())?;
                    db::batch_set_state(conn, job, batch_state, "").map_err(|e| e.to_string())
                })
                .expect("准备活动批量任务");

            let err = apply_resolved_meta(&st, &changed_meta).expect_err("应拒绝更新");
            assert!(
                err.to_string().contains("请先取消该书的批量任务"),
                "{batch_state}: {err}"
            );

            st.db
                .with(|conn| {
                    let row = db::get_book(conn, &id)
                        .map_err(|e| e.to_string())?
                        .expect("旧书仍在库");
                    assert_eq!(row.title, "旧标题", "{batch_state}: 不应更新标题");
                    assert_eq!(row.page_count, 2, "{batch_state}: 不应更新页数");
                    Ok(())
                })
                .unwrap();
        }
    }

    #[test]
    fn apply_resolved_meta_clears_derived_and_clamps_progress_on_hash_change() {
        let st = online_state();
        let old = online_meta("https://example.com/gallery/4", "旧", "h1", pages(5));
        let (row, _) = apply_resolved_meta(&st, &old).expect("首次入库");
        let id = row.id;

        st.db
            .with(|conn| {
                db::set_progress(conn, &id, 4, None).map_err(|e| e.to_string())?;
                db::save_page_ocr(conn, &id, 0, 800, 1200, "[]", r#"["旧"]"#)
                    .map_err(|e| e.to_string())?;
                db::cache_put(conn, "t1", "旧译文", &id).map_err(|e| e.to_string())
            })
            .expect("写入进度与派生缓存");

        // 页数不变的变化：进度保留，派生缓存清空。
        let same_len = online_meta("https://example.com/gallery/4", "新", "h2", pages(5));
        let (row, changed) = apply_resolved_meta(&st, &same_len).expect("清单变化应更新");
        assert!(changed);
        assert_eq!(row.title, "新");
        assert_eq!(row.current_page, 4, "页数未缩小时进度应保留");
        st.db
            .with(|conn| {
                assert!(
                    db::get_page_ocr(conn, &id, 0).unwrap().is_none(),
                    "page_ocr 应清空"
                );
                assert!(
                    db::cache_get(conn, "t1").unwrap().is_none(),
                    "trans_cache 应清空"
                );
                Ok(())
            })
            .unwrap();

        // 页数缩小的变化：进度钳制到新末页。
        let shorter = online_meta("https://example.com/gallery/4", "新", "h3", pages(2));
        let (row, changed) = apply_resolved_meta(&st, &shorter).expect("再次变化应更新");
        assert!(changed);
        assert_eq!(row.page_count, 2);
        assert_eq!(row.current_page, 1, "进度应钳制到新末页");
    }

    #[test]
    fn apply_resolved_meta_rejects_empty_manifest() {
        let st = online_state();
        let meta = online_meta("https://example.com/gallery/5", "空", "h0", Vec::new());

        let err = apply_resolved_meta(&st, &meta).expect_err("0 页应拒绝");
        assert!(err.to_string().contains("没有可读页面"), "{err}");
        st.db
            .with(|conn| {
                let id = db::book_id_for_path(&meta.canonical_url);
                assert!(db::get_book(conn, &id).unwrap().is_none(), "不应入库");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn session_headers_are_memory_only_and_clearable() {
        let st = online_state();
        let settings_count = |st: &AppState| {
            st.db
                .with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM settings", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(|e| e.to_string())
                })
                .unwrap()
        };
        let before = settings_count(&st);

        apply_session_online_headers(&st, Some("Cookie: sid=abc".into())).unwrap();
        assert_eq!(
            st.session_online_headers.lock().as_deref(),
            Some("Cookie: sid=abc")
        );
        assert_eq!(settings_count(&st), before, "会话头不得写入 settings");

        assert!(apply_session_online_headers(&st, Some("Host: example.com".into())).is_err());
        assert_eq!(
            st.session_online_headers.lock().as_deref(),
            Some("Cookie: sid=abc"),
            "非法头不得覆盖当前会话头"
        );

        apply_session_online_headers(&st, None).unwrap();
        assert!(st.session_online_headers.lock().is_none());
        assert_eq!(settings_count(&st), before);
    }

    fn linked_meta(
        canonical: &str,
        title: &str,
        series_id: Option<&str>,
        next_url: Option<&str>,
    ) -> crate::online::direct::OnlineBookMeta {
        crate::online::direct::make_meta_with_links(
            &url::Url::parse(canonical).unwrap(),
            title,
            pages(1),
            series_id.map(str::to_string),
            next_url.map(str::to_string),
        )
        .unwrap()
    }

    fn insert_linked(
        st: &AppState,
        canonical: &str,
        title: &str,
        series_id: Option<&str>,
        next_url: Option<&str>,
    ) -> String {
        let meta = linked_meta(canonical, title, series_id, next_url);
        let id = db::book_id_for_path(canonical);
        st.db
            .with(|conn| {
                db::upsert_online_book(
                    conn,
                    &id,
                    canonical,
                    title,
                    meta.page_count as u32,
                    "generic_manga",
                    &meta.meta_json,
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        id
    }

    #[test]
    fn natural_cmp_and_title_prefix_follow_contract() {
        assert_eq!(natural_cmp("第2话", "第10话"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("第10话", "第2卷"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("Vol.2", "Vol.10"), std::cmp::Ordering::Less);
        assert_eq!(title_prefix("漫画 第12话"), "漫画 第");
        assert_eq!(title_prefix("第2卷"), "第");
        assert_eq!(title_prefix("Vol.2"), "Vol");
    }

    #[test]
    fn next_book_prefers_direct_link_then_series_then_title() {
        let st = online_state();
        let a = insert_linked(&st, "http://e/a", "第1话", Some("S"), Some("http://e/c"));
        let b = insert_linked(&st, "http://e/b", "第2话", Some("S"), None);
        let c = insert_linked(&st, "http://e/c", "第10话", Some("S"), None);

        st.db
            .with(|conn| {
                let next = get_next_book_impl(conn, &a).unwrap().unwrap();
                assert_eq!(next.id, c, "next_url 直链应优先于自然排序");
                let next = get_next_book_impl(conn, &b).unwrap().unwrap();
                assert_eq!(next.id, c);
                assert!(get_next_book_impl(conn, &c).unwrap().is_none());
                Ok(())
            })
            .unwrap();

        let d = insert_linked(&st, "http://e/d", "漫画 第2话", None, None);
        insert_linked(&st, "http://e/e", "漫画 第10话", None, None);
        let f = insert_linked(&st, "http://e/f", "漫画 第3话", None, None);
        st.db
            .with(|conn| {
                let next = get_next_book_impl(conn, &d).unwrap().unwrap();
                assert_eq!(next.id, f);
                Ok(())
            })
            .unwrap();
        let _ = b;
    }

    #[test]
    fn next_book_same_title_uses_updated_at() {
        let st = online_state();
        let older = insert_linked(&st, "http://e/same-a", "Same", Some("S"), None);
        let newer = insert_linked(&st, "http://e/same-b", "Same", Some("S"), None);
        st.db
            .with(|conn| {
                conn.execute(
                    "UPDATE books SET updated_at='2026-01-01 00:00:00' WHERE id=?1",
                    rusqlite::params![older],
                )
                .unwrap();
                conn.execute(
                    "UPDATE books SET updated_at='2026-01-02 00:00:00' WHERE id=?1",
                    rusqlite::params![newer],
                )
                .unwrap();
                let next = get_next_book_impl(conn, &older).unwrap().unwrap();
                assert_eq!(next.id, newer);
                assert!(get_next_book_impl(conn, &newer).unwrap().is_none());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn batch_ingest_imports_all_and_persists_links() {
        let st = online_state();
        let payload = r#"{"seriesTitle":"S","chapters":[
            {"title":"第1话","url":"http://e/1","pages":["http://x/1.jpg"]},
            {"title":"第2话","url":"http://e/2","pages":["http://x/2.jpg"]}
        ]}"#;
        let metas = crate::online::direct::parse_batch_payload(payload.as_bytes()).unwrap();
        let books = ingest_resolved_batch(&st, metas).unwrap();
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].series_id.as_deref(), Some("S"));
        assert_eq!(books[0].next_url.as_deref(), Some("http://e/2"));
        assert_eq!(books[1].next_url, None);
        let second = st
            .db
            .with(|conn| db::get_book(conn, &books[1].id).map_err(|e| e.to_string()))
            .unwrap()
            .unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&second.meta_json).unwrap();
        assert_eq!(stored.series_id.as_deref(), Some("S"));
        assert!(stored.next_url.is_none());
    }

    #[test]
    fn batch_ingest_rolls_back_on_active_batch() {
        let st = online_state();
        let existing = insert_linked(&st, "http://e/old", "旧", None, None);
        st.db
            .with(|conn| {
                db::batch_create(conn, &existing, "旧", 1).unwrap();
                Ok(())
            })
            .unwrap();
        let payload = r#"{"chapters":[
            {"title":"新","url":"http://e/new","pages":["http://x/1.jpg"]},
            {"title":"改名","url":"http://e/old","pages":["http://x/9.jpg","http://x/10.jpg"]}
        ]}"#;
        let metas = crate::online::direct::parse_batch_payload(payload.as_bytes()).unwrap();
        let err = ingest_resolved_batch(&st, metas).unwrap_err().to_string();
        assert!(err.contains("批量任务"), "{err}");
        st.db
            .with(|conn| {
                let new_id = db::book_id_for_path("http://e/new");
                assert!(db::get_book(conn, &new_id).unwrap().is_none());
                let old = db::get_book(conn, &existing).unwrap().unwrap();
                assert_eq!(old.title, "旧");
                assert_eq!(old.page_count, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn resolved_pages_meta_normalizes_and_dedupes() {
        let meta = resolved_pages_meta(
            " HTTP://Example.COM/list?x=1#frag ",
            " Test ",
            &[
                "HTTP://X/1.jpg#a".into(),
                "http://x/1.jpg#b".into(),
                "http://x/2.jpg".into(),
            ],
        )
        .unwrap();

        assert_eq!(meta.canonical_url, "http://example.com/list?x=1");
        assert_eq!(meta.title, "Test");
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://x/1.jpg");
        assert_eq!(stored.pages[1].url, "http://x/2.jpg");
    }

    #[test]
    fn resolved_pages_meta_falls_back_to_url_title() {
        let meta = resolved_pages_meta(
            "http://example.com/gallery/abc",
            "   ",
            &["http://x/1.jpg".into()],
        )
        .unwrap();
        assert_eq!(meta.title, "abc");
    }

    #[test]
    fn resolved_pages_meta_rejects_empty_invalid_and_oversized() {
        assert!(resolved_pages_meta("http://example.com/g", "T", &[]).is_err());
        assert!(resolved_pages_meta("file:///x", "T", &["http://x/1.jpg".into()]).is_err());

        let err = resolved_pages_meta("http://example.com/g", "T", &["file:///x".into()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("第 1 页"), "{err}");

        let too_many: Vec<String> = (0..=crate::online::MAX_PAGES)
            .map(|i| format!("http://x/{i}.jpg"))
            .collect();
        let err = resolved_pages_meta("http://example.com/g", "T", &too_many)
            .unwrap_err()
            .to_string();
        assert!(err.contains("5000"), "{err}");

        let duplicate_heavy = vec!["http://x/1.jpg".to_string(); crate::online::MAX_PAGES + 1];
        assert_eq!(
            resolved_pages_meta("http://example.com/g", "T", &duplicate_heavy)
                .unwrap()
                .page_count,
            1,
            "应先去重再校验页数"
        );
    }

    #[test]
    fn resolved_pages_meta_ingests_book_info() {
        let st = online_state();
        let info = ingest_resolved_pages(
            &st,
            "http://example.com/gallery/9",
            "导入",
            &["http://x/1.jpg".into(), "http://x/2.jpg".into()],
        )
        .unwrap();
        let id = db::book_id_for_path("http://example.com/gallery/9");
        assert_eq!(info.id, id);
        assert_eq!(info.title, "导入");
        assert_eq!(info.page_count, 2);
        assert_eq!(info.source_type, "generic_manga");
        assert!(!info.webtoon_ready);
        let book = st
            .db
            .with(|conn| db::get_book(conn, &id).map_err(|e| e.to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(book.page_count, 2);
    }
}
