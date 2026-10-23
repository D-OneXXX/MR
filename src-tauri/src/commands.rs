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
use crate::pipeline;
use crate::pipeline::RenderedPage;
use crate::source::{self, BackendError, ImageSource};
use crate::state::AppState;
use crate::{
    BookDayPoint, BookInfo, Dashboard, HeatDay, ImportItemResult, ImportResult, MemoryStats,
    OnlineProbe, PageDim, PageEntry, PageImage, RemoveResult, ScanResult, SeriesProgress, Settings,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::GenericImageView as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::online::filter::{
    FilterAction, FilterMemory, FilterRule, FilterStats, FilterThresholds, FilteredPage, RulePattern,
    RuleSource, SiteProfile,
};
use crate::online::http::HttpTransport;

pub(crate) fn err(e: impl ToString) -> String {
    e.to_string()
}

fn webtoon_ready(r: &db::BookRow) -> bool {
    if r.source_type == "local" {
        return true;
    }
    match serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json) {
        // 在线清单可能缺少 width/height（典型：Telegram 相册只给 CDN URL）。
        // 条漫布局会在用户显式进入条漫时按页探测并回写尺寸，因此这里只要求
        // 有页面；绝不因为缺尺寸就把整本书的条漫能力永久关死。
        Ok(meta) => !meta.pages.is_empty(),
        Err(e) => {
            crate::logging::log_error("online_meta", &format!("书籍 {} 元数据损坏：{e}", r.id));
            false
        }
    }
}

/// 本地源路径是否“确实不存在”。
///
/// 只有 `NotFound` 才标记为缺失；权限不足、网络盘暂时不可达等错误不误判，
/// 避免把可恢复的访问失败伪装成“用户移动了文件”。在线书恒为 false。
fn local_source_missing(r: &db::BookRow) -> bool {
    if r.source_type != "local" {
        return false;
    }
    match std::fs::symlink_metadata(&r.path) {
        Ok(_) => false,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

fn to_book_info(r: db::BookRow) -> BookInfo {
    let webtoon_ready = webtoon_ready(&r);
    let stored = serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json).ok();
    let missing = local_source_missing(&r);
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
        series_title: stored.as_ref().and_then(|m| m.series_title.clone()),
        chapter_index: stored.as_ref().and_then(|m| m.chapter_index),
        next_url: stored.and_then(|m| m.next_url),
        missing,
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
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
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

/// 文件/目录名中的自然序 token：连续数字按数值，其余按大小写不敏感文本。
/// 分隔符（`_`、`-`、`.`、空白）不参与比较，因此 `page_2 < page_10`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathToken<'a> {
    Num(&'a str),
    Text(&'a str),
}

fn path_is_separator(byte: u8) -> bool {
    matches!(byte, b'_' | b'-' | b'.' | b' ' | b'\t')
}

fn path_tokens(s: &str) -> Vec<PathToken<'_>> {
    let bytes = s.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if path_is_separator(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        if bytes[index].is_ascii_digit() {
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            tokens.push(PathToken::Num(&s[start..index]));
        } else {
            while index < bytes.len()
                && !bytes[index].is_ascii_digit()
                && !path_is_separator(bytes[index])
            {
                index += 1;
            }
            tokens.push(PathToken::Text(&s[start..index]));
        }
    }
    tokens
}

fn path_component_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let a_tokens = path_tokens(a);
    let b_tokens = path_tokens(b);
    for (left, right) in a_tokens.iter().zip(&b_tokens) {
        let ordering = match (left, right) {
            (PathToken::Num(a), PathToken::Num(b)) => numeric_cmp(a, b),
            (PathToken::Text(a), PathToken::Text(b)) => a
                .to_ascii_lowercase()
                .cmp(&b.to_ascii_lowercase())
                .then_with(|| a.cmp(b)),
            // 数字段优先于文本段，确保 `1.jpg` 排在 `a.jpg` 前。
            (PathToken::Num(_), PathToken::Text(_)) => std::cmp::Ordering::Less,
            (PathToken::Text(_), PathToken::Num(_)) => std::cmp::Ordering::Greater,
        };
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    a_tokens
        .len()
        .cmp(&b_tokens.len())
        .then_with(|| a.cmp(b))
}

/// 路径自然序：逐级目录比较，最后一级再比较文件 token。
///
/// 与 [`natural_cmp`] 分开是刻意的：卷/话标题仍保留“结构不同退回字典序”
/// 的既有契约，而文件名必须让 `page_2.png` 严格排在 `page10.png` 前，
/// 并让 `1.jpg / 2.png / 10.jpg` 这类混合扩展名也按页号排列。
pub(crate) fn natural_cmp_path(a: &str, b: &str) -> std::cmp::Ordering {
    let a_parts: Vec<&str> = a
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    let b_parts: Vec<&str> = b
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    for (left, right) in a_parts.iter().zip(&b_parts) {
        let ordering = path_component_cmp(left, right);
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    a_parts.len().cmp(&b_parts.len()).then_with(|| a.cmp(b))
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

fn get_series_books_impl(
    conn: &rusqlite::Connection,
    series_id: &str,
) -> Result<Vec<BookInfo>, BackendError> {
    if series_id.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for book in db::list_books(conn, None)? {
        let Ok(meta) = serde_json::from_str::<crate::online::StoredMeta>(&book.meta_json) else {
            continue;
        };
        if meta.series_id.as_deref() == Some(series_id) {
            rows.push((meta.chapter_index, book));
        }
    }
    rows.sort_by(|(a_index, a), (b_index, b)| {
        a_index
            .unwrap_or(u32::MAX)
            .cmp(&b_index.unwrap_or(u32::MAX))
            .then_with(|| natural_cmp(&a.title, &b.title))
            .then_with(|| a.updated_at.cmp(&b.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rows.into_iter().map(|(_, row)| to_book_info(row)).collect())
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
    let conn = db::open(db_path)?;
    db::init_schema(&conn)?;
    let book = scan_single_book(&conn, path)?;
    Ok(Some(book.id))
}

/// 递归收集书籍路径：直下有图片的目录视为一本书；否则继续向下找章节目录
/// 与 zip/cbz。限制深度并跳过 symlink，避免链接环。
fn collect_book_paths(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    const MAX_DEPTH: usize = 8;
    if depth > MAX_DEPTH || !root.is_dir() {
        return;
    }
    if dir_has_direct_images(root) {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut kids: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    kids.sort_by(|a, b| {
        crate::commands::natural_cmp_path(&a.to_string_lossy(), &b.to_string_lossy())
    });
    for kid in kids {
        let Ok(meta) = std::fs::symlink_metadata(&kid) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if kid.is_dir() {
            collect_book_paths(&kid, depth + 1, out);
        } else if source::is_archive_path(&kid) {
            out.push(kid);
        }
    }
}

/// 扫描目录：直接子目录/嵌套章节目录（含图片）与 zip/cbz 均入库；单书路径直接入库。
fn blocking_scan(
    db_path: PathBuf,
    root: &str,
) -> Result<(Vec<BookInfo>, Vec<String>), BackendError> {
    let path = PathBuf::from(root);
    let conn = db::open(db_path)?;
    db::init_schema(&conn)?;

    let mut books = Vec::new();
    let mut errors = Vec::new();
    let mut candidates = Vec::new();
    if path.is_dir() {
        collect_book_paths(&path, 0, &mut candidates);
    } else if path.is_file() && source::is_archive_path(&path) {
        candidates.push(path.clone());
    } else {
        return Err(BackendError::Msg(format!(
            "扫描路径无效（需要目录或 .zip/.cbz）：{root}"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        match scan_single_book(&conn, &candidate) {
            Ok(book) => books.push(book),
            Err(error) => errors.push(format!("{}：{error}", candidate.display())),
        }
    }
    Ok((books, errors))
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
    let (books, errors) = blocking(move || blocking_scan(db_path, &path)).await?;
    // 刷新后全量回读。
    let list = state.db.with(|conn| {
        db::list_books(conn, None)
            .map(|rows| rows.into_iter().map(to_book_info).collect::<Vec<_>>())
            .map_err(err)
    })?;
    Ok(ScanResult {
        added: books.len(),
        books: list,
        errors,
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

/// 单本书路径导入：已入库也重新扫描并 upsert，刷新页数/元数据，保留进度；
/// 软删的书同样恢复。读取失败进入 failed，而不是静默 skipped。
fn import_one(conn: &rusqlite::Connection, p: &Path) -> ImportItemResult {
    let path = p.to_string_lossy().to_string();
    let id = db::book_id_for_path(&path);
    let existed = matches!(db::get_book(conn, &id), Ok(Some(_)));
    match scan_single_book(conn, p) {
        Ok(book) => {
            let (status, message) = if existed {
                ("restored", "已刷新页数与元数据，阅读进度保留")
            } else {
                ("added", "已入库")
            };
            import_outcome(&path, status, message.into(), Some(book))
        }
        Err(error) => import_outcome(&path, "failed", error.to_string(), None),
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
pub(crate) fn import_blocking(
    db_path: PathBuf,
    paths: Vec<String>,
) -> Result<Vec<ImportItemResult>, BackendError> {
    let conn = db::open(db_path)?;
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
                let mut candidates = Vec::new();
                collect_book_paths(&p, 0, &mut candidates);
                let mut seen = std::collections::HashSet::new();
                let mut found = 0usize;
                for candidate in candidates {
                    if !seen.insert(candidate.clone()) {
                        continue;
                    }
                    found += 1;
                    out.push(import_one(&conn, &candidate));
                }
                if found == 0 {
                    out.push(import_outcome(
                        &path,
                        "failed",
                        "目录中没有可识别的书籍（需要：直下图片 / 含图片的嵌套目录 / zip/cbz）"
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
        let conn = db::open(db_path)?;
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
        state.remove_book_caches(id);
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

/// 重定位核心（同步、可单测）：校验新源 → 迁移 id/path/进度/历史。
fn relocate_book_impl(
    conn: &rusqlite::Connection,
    old_id: &str,
    new_path: &str,
) -> Result<db::BookRow, BackendError> {
    let dest = new_path.trim().to_string();
    if dest.is_empty() {
        return Err(BackendError::Msg("请选择新的文件或文件夹位置".to_string()));
    }
    let path = PathBuf::from(&dest);
    if !path.exists() {
        return Err(BackendError::Msg("目标路径不存在，请重新选择".to_string()));
    }
    if path.is_file() && !source::is_archive_path(&path) {
        return Err(BackendError::Msg(
            "只支持 .zip/.cbz 压缩包或图片文件夹".to_string(),
        ));
    }
    let source_handle = source::open_source(&path)?;
    let page_count = source_handle.page_count()? as u32;
    if page_count == 0 {
        return Err(BackendError::Msg(
            "新位置没有可读图片，无法重定位".to_string(),
        ));
    }

    let old = db::get_book(conn, old_id)?
        .ok_or_else(|| BackendError::Msg("书籍不存在".to_string()))?;
    if old.source_type != "local" {
        return Err(BackendError::Msg("只能重定位本地书籍".to_string()));
    }
    let new_id = db::book_id_for_path(&dest);
    if old.id == new_id && old.path == dest {
        return Ok(old);
    }
    if db::get_book(conn, &new_id)?.is_some() {
        return Err(BackendError::Msg("目标路径已在书库中".to_string()));
    }
    db::relocate_book(conn, old_id, &new_id, &dest, &title_for(&path), page_count)
}

/// 失效路径无损重定位：
/// - 只允许本地书；新位置必须是可读的 .zip/.cbz 或含直下图片的目录；
/// - 新 id 仍保持 `sha256(newPath)` 不变量；
/// - 事务内迁移阅读进度、条漫偏移、reading_log 与过滤事件归属；
/// - 源句柄/渲染缓存按新旧 id 双双失效。
#[tauri::command]
pub async fn relocate_book(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    new_path: String,
) -> Result<BookInfo, String> {
    let db_path = state.db_path();
    let old_id = book_id.clone();
    let row = blocking(move || {
        let conn = db::open(db_path)?;
        db::init_schema(&conn)?;
        relocate_book_impl(&conn, &old_id, &new_path)
    })
    .await?;

    state.remove_book_caches(&book_id);
    state.remove_book_caches(&row.id);
    state.webtoon_layouts.lock().remove(&book_id);
    state.webtoon_layouts.lock().remove(&row.id);
    state.invalidate_sources();
    Ok(to_book_info(row))
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
pub async fn get_series_books(
    state: State<'_, Arc<AppState>>,
    series_id: String,
) -> Result<Vec<BookInfo>, String> {
    state
        .db
        .with(|conn| get_series_books_impl(conn, &series_id).map_err(err))
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

/// 日志里的书目标识：只保留稳定 ID 前 8 位，绝不写书名/路径。
fn short_book_ref(book_id: &str) -> &str {
    let end = book_id.len().min(8);
    &book_id[..end]
}

/// 错误日志统一脱敏：底层错误可能带本地路径、完整 URL/query 或页面文本。
fn safe_error_text(error: &impl std::fmt::Display) -> String {
    crate::diagnostics::sanitize_text(&error.to_string(), true)
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

/// L2 成品 JPEG 还原为 `RenderedPage`。
///
/// `orig_width/orig_height` 是**逻辑页**的源尺寸（条漫切片场景下由布局缓存提供），
/// 不能回填成单片尺寸：否则 L2 冷/热路径会给出“这一页只有 2048px 高”的错误语义。
/// 调用方拿不到源尺寸时才传 0，函数回落到成品尺寸。
fn assembled_page(
    bytes: Vec<u8>,
    orig_width: u32,
    orig_height: u32,
) -> Result<RenderedPage, BackendError> {
    let (width, height) = jpeg_dims(&bytes)?;
    Ok(RenderedPage {
        width,
        height,
        orig_width: if orig_width > 0 { orig_width } else { width },
        orig_height: if orig_height > 0 { orig_height } else { height },
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
    let is_online = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|b| b.source_type != "local")
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // 2) L2 磁盘成品缓存。
        if let Some(bytes) = st.render.get(&book, index, w, h) {
            // 单页 L2 命中时源尺寸未随成品落盘；保持“成品尺寸”兜底，
            // 条漫建议只依赖宽高比，不把这里当成逻辑页权威尺寸。
            match assembled_page(bytes, 0, 0) {
                Ok(page) => return Ok(page),
                Err(e) => {
                    // 坏缓存自愈：删除后继续走全管线，而不是让该页永久失败。
                    st.render.remove_page(&book, index, w, h);
                    crate::logging::log_error(
                        "get_page",
                        &format!("L2 缓存损坏，已丢弃并重渲染第 {} 页：{e}", index + 1),
                    );
                }
            }
        }
        // 3) 全管线（常开句柄，不再每页重开 zip/重读目录）。
        let handle = st.source_handle_for_book(&book)?;
        let raw = handle.read_raw(index as usize)?;
        let raw_bytes = raw.bytes.len();
        let page = pipeline::render_raw(&raw, max_width, max_height)?;
        st.render.put(&book, index, w, h, &page.bytes);
        st.note_cache_write(raw_bytes.saturating_add(page.bytes.len()));
        Ok(page)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // 失败链路：只记稳定书 ID 前缀、页码与脱敏原因，绝不写书名/路径/query。
            crate::logging::log_error(
                "get_page",
                &format!(
                    "book={} 第 {} 页：{}",
                    short_book_ref(&book_id),
                    index + 1,
                    safe_error_text(&e)
                ),
            );
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
                .map(|bytes| assembled_page(bytes, 0, 0))
                .unwrap_or_else(|| {
                    handle.read_raw(t as usize).and_then(|raw| {
                        let p = pipeline::render_raw(&raw, mw, mh)?;
                        st.render.put(&book, t, w, h, &p.bytes);
                        Ok(p)
                    })
                });
            if let Ok(p) = page {
                let written = p.bytes.len();
                st.cache.put_page(&book, t, w, h, p);
                st.note_cache_write(written);
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
    state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|_| ())
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // L2 磁盘复用同一套渲染缓存（键 = 首页 + edge 桶）。
        if let Some(bytes) = st.render.get(&book, 0, edge, edge) {
            match assembled_page(bytes, 0, 0) {
                Ok(page) => return Ok(page),
                Err(e) => {
                    st.render.remove_page(&book, 0, edge, edge);
                    crate::logging::log_error(
                        "get_thumbnail",
                        &format!("封面 L2 缓存损坏，已丢弃并重建：{e}"),
                    );
                }
            }
        }
        let handle = st.source_handle_for_book(&book)?;
        let raw = handle.read_raw(0)?;
        let raw_bytes = raw.bytes.len();
        let page = pipeline::render_raw(&raw, Some(edge), Some(edge))?;
        st.render.put(&book, 0, edge, edge, &page.bytes);
        st.note_cache_write(raw_bytes.saturating_add(page.bytes.len()));
        Ok(page)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::logging::log_error(
                "get_thumbnail",
                &format!(
                    "book={} 封面（第 1 页）：{}",
                    short_book_ref(&book_id),
                    safe_error_text(&e)
                ),
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
fn blocking_memory(
    cache: (u64, u64, usize, usize, u64, usize),
    disk: (u64, u64, u64, u64),
) -> MemoryStats {
    use std::sync::OnceLock;
    use sysinfo::{get_current_pid, ProcessesToUpdate, System};

    // Reuse and serialize the process table: concurrent `System::new` +
    // refresh calls can stall on Windows while the reader is materializing
    // long-strip pages, which used to block the whole Settings page.
    static PROCESS_SYSTEM: OnceLock<parking_lot::Mutex<System>> = OnceLock::new();
    let mut sys = PROCESS_SYSTEM
        .get_or_init(|| parking_lot::Mutex::new(System::new()))
        .lock();
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
        disk_cache_bytes: disk.0,
        disk_cache_limit_bytes: disk.1,
        render_cache_bytes: disk.2,
        online_cache_bytes: disk.3,
    }
}

#[tauri::command]
pub async fn get_memory_stats(state: State<'_, Arc<AppState>>) -> Result<MemoryStats, String> {
    // 磁盘统计与 sysinfo 都放在 blocking 线程，避免慢盘拖住 async runtime。
    let st = state.inner().clone();
    blocking(move || {
        let snap = st.cache.stats();
        let (used, render, online) = st.disk_cache_totals();
        let limit = st.disk_cache_limit_bytes();
        Ok(blocking_memory(snap, (used, limit, render, online)))
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    pub bytes_freed: u64,
    pub files: u64,
}

/// 一键清空临时缓存：内存 L1 + 渲染 L2 + 在线原图 L2。
/// 只删除派生目录，绝不触碰 SQLite 书库/进度/设置。
#[tauri::command]
pub async fn clear_temp_cache(
    state: State<'_, Arc<AppState>>,
) -> Result<ClearCacheResult, String> {
    let st = state.inner().clone();
    blocking(move || {
        let before = st.disk_cache_totals().0;
        let files = st.render.file_count() + st.online_cache.file_count();
        st.cache.clear_pages();
        st.cache.clear_thumbs();
        st.webtoon_layouts.lock().clear();
        st.render.clear_all();
        st.online_cache.clear_all();
        // 清空后重置写盘压力计数，避免下一次阅读立刻触发一次无意义扫描。
        st.trim_disk_cache();
        let after = st.disk_cache_totals().0;
        Ok(ClearCacheResult {
            bytes_freed: before.saturating_sub(after),
            files,
        })
    })
    .await
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
        let mut meta: crate::online::StoredMeta =
            serde_json::from_str(&row.meta_json).map_err(|e| format!("在线书元数据损坏：{e}"))?;
        if meta.pages.is_empty() {
            return Err("该在线书籍没有可阅读页面".into());
        }
        let mut dims: Vec<(u32, u32)> = meta
            .pages
            .iter()
            .map(|p| (p.width.unwrap_or(0), p.height.unwrap_or(0)))
            .collect();
        // Telegram 相册等来源可能只有 CDN URL，没有 width/height。
        // 用户显式进入条漫时按页读取（走在线 L2 / 网络）并探测尺寸，
        // 只探测缺失页；结果回写 meta_json，后续布局/启动不再重复下载。
        let missing: Vec<usize> = dims
            .iter()
            .enumerate()
            .filter(|(_, (w, h))| *w == 0 || *h == 0)
            .map(|(index, _)| index)
            .collect();
        if !missing.is_empty() {
            let st = state.inner().clone();
            let bid = book_id.clone();
            let probed = blocking(move || {
                let handle = st.source_handle_for_book(&bid)?;
                let mut out: Vec<(usize, u32, u32)> = Vec::with_capacity(missing.len());
                for index in missing {
                    let raw = handle.read_raw(index)?;
                    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
                        .with_guessed_format()?
                        .into_dimensions()?;
                    if width == 0 || height == 0 {
                        return Err(BackendError::Msg(format!("第 {} 页尺寸无效", index + 1)));
                    }
                    out.push((index, width, height));
                }
                Ok(out)
            })
            .await?;
            for (index, width, height) in probed {
                dims[index] = (width, height);
                if let Some(page) = meta.pages.get_mut(index) {
                    page.width = Some(width);
                    page.height = Some(height);
                }
            }
            // best-effort 持久化：失败不影响本次布局，下次最多再探测一次。
            if let Ok(json) = serde_json::to_string(&meta) {
                let _ = state.db.with(|conn| {
                    db::upsert_online_book(
                        conn,
                        &row.id,
                        &row.path,
                        &row.title,
                        row.page_count,
                        &row.source_type,
                        &json,
                    )
                    .map_err(err)
                });
            }
        }
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
    state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|_| ())
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    // 逻辑页源尺寸：条漫布局通常已由 get_webtoon_layout 写入缓存。
    // L2 切片只有成品字节，必须借它把 orig_* 还原成**整页**尺寸，
    // 不能让调用方把单片高度误认成逻辑页高度。
    let orig_dims = state
        .webtoon_layouts
        .lock()
        .get(&book_id)
        .and_then(|dims| dims.get(index as usize).copied())
        .unwrap_or((0, 0));
    let st = state.inner().clone();
    let book = book_id.clone();
    let rendered = match blocking(move || {
        // 2) L2 磁盘切片。
        if let Some(bytes) = st.render.get_tile(&book, index, tile, w) {
            match assembled_page(bytes, orig_dims.0, orig_dims.1) {
                Ok(page) => return Ok(page),
                Err(e) => {
                    st.render.remove_tile(&book, index, tile, w);
                    crate::logging::log_error(
                        "get_webtoon_tile",
                        &format!(
                            "条漫切片 L2 损坏，已丢弃并重建（第 {} 页/片 {tile}）：{e}",
                            index + 1
                        ),
                    );
                }
            }
        }
        // 3) 整页物化（串行；一次解码直接切全部片，无中间编解码往返）。
        // 先读原页再抢切片锁：在线源 read_raw 可能下载 30s+，持全局锁会阻塞
        // 其它书/页的切片请求；锁内只做“双检 + 解码切片 + 落盘”。
        let handle = st.source_handle_for_book(&book)?;
        let raw = handle.read_raw(index as usize)?;
        let _guard = st.tile_lock.lock();
        // 双检：等锁期间可能已被别的请求物化。
        if let Some(bytes) = st.render.get_tile(&book, index, tile, w) {
            return assembled_page(bytes, orig_dims.0, orig_dims.1);
        }
        let (tiles, pages) = pipeline::render_webtoon_tiles(&raw, w)?;
        if tile >= tiles {
            return Err(BackendError::Msg(format!(
                "切片 {tile} 越界（共 {tiles} 片）"
            )));
        }
        // 全部落盘（后续滚动的切片都是磁盘命中），随后丢栅格。
        let mut written = raw.bytes.len();
        for (t, p) in pages.iter().enumerate() {
            written = written.saturating_add(p.bytes.len());
            st.render.put_tile(&book, index, t as u32, w, &p.bytes);
        }
        st.note_cache_write(written);
        Ok(pages.into_iter().nth(tile as usize).expect("切片在界内"))
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::logging::log_error(
                "get_webtoon_tile",
                &format!(
                    "book={} 第 {} 页 切片 {tile}：{}",
                    short_book_ref(&book_id),
                    index + 1,
                    safe_error_text(&e)
                ),
            );
            return Err(e);
        }
    };
    state
        .cache
        .put_tile(&book_id, index, tile, w, rendered.clone());
    Ok(to_page_image(index, rendered))
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
        (
            "disk_cache_budget_mb",
            crate::disk_cache::clamp_budget_mb(s.disk_cache_budget_mb).to_string(),
        ),
        ("library_dir", s.library_dir.clone()),
        (
            "experimental_webtoon",
            if s.experimental_webtoon {
                "true"
            } else {
                "false"
            }
            .to_string(),
        ),
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
    db::upsert_online_book(
        conn,
        &id,
        &meta.canonical_url,
        &meta.title,
        meta.page_count as u32,
        &meta.source_type,
        &meta.meta_json,
    )?;
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
                info.series_title = meta.series_title.clone();
                info.chapter_index = meta.chapter_index;
                info.next_url = meta.next_url.clone();
                books.push(info);
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok((books, changed_ids))
        })
        .map_err(BackendError::Msg)?;

    for id in &changed_ids {
        st.remove_book_caches(id);
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
        st.remove_book_caches(&row.id);
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
    crate::resilience::ensure_online_allowed()?;
    let st = state.inner().clone();
    let (row, changed) = blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let host = crate::online::filter::url_host(&url);
        let memory = filter_memory_for(&st, &host)?;
        let thresholds = thresholds_from(memory.profile.as_ref());
        let meta = crate::online::resolve_with(&http, &url, &memory, &thresholds)?;
        let (row, changed) = apply_resolved_meta(&st, &meta)?;
        if let Err(e) = persist_filter_learning(&st, &meta, &row.id) {
            crate::logging::log_error("online_filter", &format!("站点学习落库失败：{e}"));
        }
        Ok((row, changed))
    })
    .await?;

    if changed {
        state.remove_book_caches(&row.id);
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
    crate::resilience::ensure_online_allowed()?;
    if !state.settings.lock().experimental_online {
        return Err("在线直读未开启".into());
    }
    let st = state.inner().clone();
    blocking(move || ingest_resolved_pages(&st, &url, &title, &page_urls)).await
}

#[tauri::command]
pub async fn resolve_online_batch(
    state: State<'_, Arc<AppState>>,
    payload_json: String,
) -> Result<Vec<BookInfo>, String> {
    crate::resilience::ensure_online_allowed()?;
    if !state.settings.lock().experimental_online {
        return Err("在线直读未开启".into());
    }
    let st = state.inner().clone();
    blocking(move || {
        let s = st.settings.lock().clone();
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let memory = FilterMemory::default();
        let thresholds = FilterThresholds::default();
        let metas = crate::online::direct::parse_batch_payload_with(
            payload_json.as_bytes(),
            &http,
            &memory,
            &thresholds,
        )?;
        let books = ingest_resolved_batch(&st, metas.clone())?;
        for (meta, book) in metas.iter().zip(books.iter()) {
            if let Err(e) = persist_filter_learning(&st, meta, &book.id) {
                crate::logging::log_error("online_filter", &format!("批量学习落库失败：{e}"));
            }
        }
        Ok(books)
    })
    .await
}

/// 只测试 JSON 清单或单页 HTML 图集 + 代理连通性，不写库。
#[tauri::command]
pub async fn test_online_connection(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<OnlineProbe, String> {
    crate::resilience::ensure_online_allowed()?;
    let st = state.inner().clone();
    blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let host = crate::online::filter::url_host(&url);
        let memory = filter_memory_for(&st, &host)?;
        let thresholds = thresholds_from(memory.profile.as_ref());
        let t0 = Instant::now();
        let meta = crate::online::resolve_with(&http, &url, &memory, &thresholds)?;
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

// ---------- 在线图片提纯：规则库、标记/恢复与 Telegram ----------

const TELEGRAM_DOC_MAX_BYTES: usize = 256 * 1024 * 1024;

fn filter_memory_for(st: &AppState, host: &str) -> Result<FilterMemory, BackendError> {
    let (profile, rules) = st
        .db
        .with(|conn| {
            let profile = db::get_filter_profile(conn, host).map_err(err)?;
            let rules = db::rules_for_host(conn, host).map_err(err)?;
            Ok((profile, rules))
        })
        .map_err(BackendError::Msg)?;
    Ok(FilterMemory {
        host: host.to_string(),
        profile,
        rules,
    })
}

fn thresholds_from(profile: Option<&SiteProfile>) -> FilterThresholds {
    let mut thresholds = FilterThresholds::default();
    if let Some(profile) = profile {
        thresholds.width_min = profile.width_min;
        thresholds.width_max = profile.width_max;
        if let Some(aspect) = profile.aspect_max {
            thresholds.max_aspect = thresholds.max_aspect.max(aspect).min(5.0);
        }
    }
    thresholds
}

fn load_online_stored(row: &db::BookRow) -> Result<crate::online::StoredMeta, BackendError> {
    serde_json::from_str(&row.meta_json)
        .map_err(|e| BackendError::Msg(format!("在线书元数据损坏：{e}")))
}

fn rebuild_online_meta(
    row: &db::BookRow,
    stored: &crate::online::StoredMeta,
    pages: Vec<crate::online::PageRef>,
    filtered: Vec<FilteredPage>,
) -> Result<crate::online::direct::OnlineBookMeta, BackendError> {
    let canonical = crate::online::normalize_url(&row.path)?;
    let links = crate::online::direct::MetaLinks {
        series_id: stored.series_id.clone(),
        series_title: stored.series_title.clone(),
        next_url: stored.next_url.clone(),
        chapter_index: stored.chapter_index,
    };
    let mut meta = crate::online::direct::make_meta_with_links(
        &canonical,
        &row.title,
        pages,
        links,
    )?;
    let mut next: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json)
        .map_err(|e| BackendError::Msg(format!("内部元数据错误：{e}")))?;
    next.schema = 2;
    next.filtered = filtered.clone();
    next.filter_profile = stored.filter_profile.clone();
    meta.meta_json = serde_json::to_string(&next)
        .map_err(|e| BackendError::Msg(format!("清单元数据序列化失败：{e}")))?;
    meta.page_count = next.pages.len();
    meta.filtered = filtered;
    meta.filter_profile = next.filter_profile;
    Ok(meta)
}

fn page_rule_id(prefix: &str, host: &str, pattern: &RulePattern) -> String {
    let payload = serde_json::to_string(pattern).unwrap_or_default();
    let digest = hex::encode(Sha256::digest(format!("{host}|{payload}").as_bytes()));
    format!("{prefix}-{}", &digest[..24])
}

fn main_page_template(pages: &[crate::online::PageRef]) -> Option<String> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for page in pages {
        if let Some(template) = crate::online::filter::url_template(&page.url) {
            *counts.entry(template).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(template, _)| template)
}

fn invalidate_book_caches(st: &AppState, book_id: &str) {
    st.remove_book_caches(book_id);
    st.webtoon_layouts.lock().remove(book_id);
    st.invalidate_sources();
}

/// 解析成功后把站点档案与被过滤事件落库；失败不影响阅读。
fn persist_filter_learning(
    st: &AppState,
    meta: &crate::online::direct::OnlineBookMeta,
    book_id: &str,
) -> Result<(), BackendError> {
    let host = meta
        .filter_profile
        .as_ref()
        .map(|p| p.host.clone())
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| crate::online::filter::url_host(&meta.canonical_url));
    let host_for_db = host.clone();
    st.db
        .with(|conn| {
            if meta.page_count >= 3 {
                if let Some(profile) = meta.filter_profile.as_ref() {
                    db::upsert_filter_profile(conn, profile).map_err(err)?;
                }
            }
            for page in &meta.filtered {
                let url = crate::online::filter::redacted_url(&page.url);
                db::record_filter_event(
                    conn,
                    &host_for_db,
                    book_id,
                    &url,
                    "blocked",
                    &page.reason,
                    page.width,
                    page.height,
                    page.sha256.as_deref(),
                )
                .map_err(err)?;
            }
            Ok(())
        })
        .map_err(BackendError::Msg)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlineFilterExport {
    version: u32,
    exported_at: String,
    rules: Vec<FilterRule>,
    profiles: Vec<SiteProfile>,
}

fn validate_filter_rule(rule: &FilterRule) -> Result<(), String> {
    if rule.host.trim().is_empty() || rule.host.len() > 253 {
        return Err("规则 host 非法".into());
    }
    match &rule.pattern {
        RulePattern::UrlTemplate { template } => {
            if !(template.starts_with("http://") || template.starts_with("https://"))
                || template.contains('?')
                || template.contains('#')
                || template.len() > 2048
            {
                return Err("URL 模板必须是无 query/fragment 的 http(s) 地址".into());
            }
        }
        RulePattern::ExactUrl { url } => {
            if !(url.starts_with("http://") || url.starts_with("https://"))
                || url.contains('?')
                || url.contains('#')
                || url.len() > 2048
            {
                return Err("精确 URL 必须是无 query/fragment 的 http(s) 地址".into());
            }
        }
        RulePattern::Sha256 { hash } => {
            if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("SHA-256 规则必须是 64 位十六进制".into());
            }
        }
        RulePattern::DomClass { value } => {
            if value.trim().is_empty() || value.len() > 120 {
                return Err("DOM class 规则长度非法".into());
            }
        }
        RulePattern::Size { width, height } => {
            if *width == 0 || *height == 0 || *width > 100_000 || *height > 100_000 {
                return Err("尺寸规则非法".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_online_filter_status(
    state: State<'_, Arc<AppState>>,
) -> Result<FilterStats, String> {
    let st = state.inner().clone();
    blocking(move || {
        st.db
            .with(|conn| db::filter_stats(conn).map_err(err))
            .map_err(BackendError::Msg)
    })
    .await
}

#[tauri::command]
pub async fn list_online_filter_rules(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<FilterRule>, String> {
    let st = state.inner().clone();
    blocking(move || {
        st.db
            .with(|conn| db::list_filter_rules(conn).map_err(err))
            .map_err(BackendError::Msg)
    })
    .await
}

#[tauri::command]
pub async fn export_online_filter_rules(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || {
        st.db
            .with(|conn| {
                let rules = db::list_filter_rules(conn).map_err(err)?;
                let profiles = db::list_filter_profiles(conn).map_err(err)?;
                serde_json::to_string_pretty(&OnlineFilterExport {
                    version: 1,
                    exported_at: db::now_str(),
                    rules,
                    profiles,
                })
                .map_err(|e| err(format!("导出序列化失败：{e}")))
            })
            .map_err(BackendError::Msg)
    })
    .await
}

#[tauri::command]
pub async fn import_online_filter_rules(
    state: State<'_, Arc<AppState>>,
    json: String,
) -> Result<u32, String> {
    let st = state.inner().clone();
    blocking(move || {
        let value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| BackendError::Msg(format!("规则 JSON 无效：{e}")))?;
        let (rules_value, profiles_value) = if value.is_array() {
            (value, serde_json::Value::Null)
        } else {
            (
                value
                    .get("rules")
                    .cloned()
                    .ok_or_else(|| BackendError::Msg("规则 JSON 缺少 rules 数组".into()))?,
                value.get("profiles").cloned().unwrap_or(serde_json::Value::Null),
            )
        };
        let mut rules: Vec<FilterRule> = serde_json::from_value(rules_value)
            .map_err(|e| BackendError::Msg(format!("规则格式不符：{e}")))?;
        let profiles: Vec<SiteProfile> = if profiles_value.is_null() {
            Vec::new()
        } else {
            serde_json::from_value(profiles_value)
                .map_err(|e| BackendError::Msg(format!("站点档案格式不符：{e}")))?
        };
        if rules.len() > 5000 || profiles.len() > 5000 {
            return Err(BackendError::Msg("导入规则/档案数量超过上限 5000".into()));
        }
        for rule in &mut rules {
            validate_filter_rule(rule).map_err(BackendError::Msg)?;
            if rule.id.trim().is_empty() {
                rule.id = page_rule_id("imp", &rule.host, &rule.pattern);
            }
            rule.source = RuleSource::Imported;
            if rule.created_at.trim().is_empty() {
                rule.created_at = db::now_str();
            }
        }
        let imported = rules.len() as u32;
        st.db
            .with(|conn| {
                let tx = conn.unchecked_transaction().map_err(err)?;
                for rule in &rules {
                    db::upsert_filter_rule(&tx, rule).map_err(err)?;
                }
                for profile in &profiles {
                    db::upsert_filter_profile(&tx, profile).map_err(err)?;
                }
                tx.commit().map_err(err)?;
                Ok(())
            })
            .map_err(BackendError::Msg)?;
        Ok(imported)
    })
    .await
}

#[tauri::command]
pub async fn reset_online_filter_rules(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || {
        st.db
            .with(|conn| db::clear_filter_learning(conn).map_err(err))
            .map_err(BackendError::Msg)
    })
    .await
}

#[tauri::command]
pub async fn get_filtered_pages(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<FilteredPage>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let row = st
            .db
            .with(|conn| db::get_book(conn, &book_id).map_err(err))
            .map_err(BackendError::Msg)?
            .ok_or_else(|| BackendError::Msg("书籍不存在".into()))?;
        let stored = load_online_stored(&row)?;
        Ok(stored.filtered)
    })
    .await
}

#[tauri::command]
pub async fn mark_online_page_non_content(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    page_index: u32,
) -> Result<BookInfo, String> {
    let st = state.inner().clone();
    let st_work = st.clone();
    let book_id_for_cache = book_id.clone();
    let row = blocking(move || {
        let st = st_work;
        let (row, stored) = st
            .db
            .with(|conn| {
                let row = db::get_book(conn, &book_id)
                    .map_err(err)?
                    .ok_or_else(|| err("书籍不存在"))?;
                let stored = load_online_stored(&row).map_err(err)?;
                Ok((row, stored))
            })
            .map_err(BackendError::Msg)?;
        if row.source_type == "local" {
            return Err(BackendError::Msg("只有在线书支持标记非正文".into()));
        }
        let index = page_index as usize;
        let page = stored
            .pages
            .get(index)
            .cloned()
            .ok_or_else(|| BackendError::Msg("页码越界".into()))?;
        if stored.pages.len() <= 1 {
            return Err(BackendError::Msg("最后一页不能标记为非正文".into()));
        }
        // 尽力读取图片字节做 SHA-256 指纹；失败不阻断标记。
        let sha256 = st
            .source_handle_for_book(&book_id)
            .ok()
            .and_then(|handle| handle.read_raw(index).ok())
            .map(|raw| hex::encode(Sha256::digest(&raw.bytes)));
        let sha256_for_event = sha256.clone();
        let host = crate::online::filter::url_host(&page.url);
        let template = crate::online::filter::url_template(&page.url);
        let mut remaining = stored.pages.clone();
        remaining.remove(index);
        let main_template = main_page_template(&remaining);
        let mut filtered = stored.filtered.clone();
        filtered.push(FilteredPage {
            url: page.url.clone(),
            width: page.width,
            height: page.height,
            reason: "user".into(),
            score: 0.0,
            order: index,
            anchor: page.anchor.clone(),
            sha256: sha256.clone(),
        });
        filtered.sort_by_key(|p| p.order);
        let meta = rebuild_online_meta(&row, &stored, remaining, filtered)?;
        let new_page_count = meta.page_count as u32;
        let now = db::now_str();
        let mut rules = Vec::new();
        let exact = RulePattern::ExactUrl {
            url: crate::online::filter::redacted_url(&page.url),
        };
        rules.push(FilterRule {
            id: page_rule_id("usr", &host, &exact),
            host: host.clone(),
            action: FilterAction::Block,
            source: RuleSource::User,
            pattern: exact,
            reason: "user-marked".into(),
            created_at: now.clone(),
            hits: 0,
        });
        // 只有尾部推广图等“非主序列模板”才写 URL 模板规则，
        // 防止把正文模板整体拉黑。
        if let Some(template) = template {
            if main_template.as_deref() != Some(template.as_str()) {
                let pattern = RulePattern::UrlTemplate { template };
                rules.push(FilterRule {
                    id: page_rule_id("usr", &host, &pattern),
                    host: host.clone(),
                    action: FilterAction::Block,
                    source: RuleSource::User,
                    pattern,
                    reason: "user-marked-template".into(),
                    created_at: now.clone(),
                    hits: 0,
                });
            }
        }
        if let Some(hash) = sha256 {
            let pattern = RulePattern::Sha256 { hash };
            rules.push(FilterRule {
                id: page_rule_id("usr", &host, &pattern),
                host: host.clone(),
                action: FilterAction::Block,
                source: RuleSource::User,
                pattern,
                reason: "user-marked-hash".into(),
                created_at: now,
                hits: 0,
            });
        }
        let redacted = crate::online::filter::redacted_url(&page.url);
        let row = st
            .db
            .with(|conn| {
                let tx = conn.unchecked_transaction().map_err(err)?;
                for rule in &rules {
                    db::upsert_filter_rule(&tx, rule).map_err(err)?;
                }
                db::upsert_online_book(
                    &tx,
                    &row.id,
                    &row.path,
                    &row.title,
                    new_page_count,
                    &row.source_type,
                    &meta.meta_json,
                )
                .map_err(err)?;
                let current = if index < row.current_page as usize {
                    row.current_page.saturating_sub(1)
                } else {
                    row.current_page
                };
                let current = current.min(new_page_count.saturating_sub(1));
                tx.execute(
                    "UPDATE books SET current_page=?1 WHERE id=?2",
                    rusqlite::params![current as i64, row.id],
                )
                .map_err(err)?;
                db::record_filter_event(
                    &tx,
                    &host,
                    &row.id,
                    &redacted,
                    "blocked",
                    "user",
                    page.width,
                    page.height,
                    sha256_for_event.as_deref(),
                )
                .map_err(err)?;
                tx.commit().map_err(err)?;
                db::get_book(conn, &row.id)
                    .map_err(err)?
                    .ok_or_else(|| err("标记后回读书籍失败"))
            })
            .map_err(BackendError::Msg)?;
        Ok(row)
    })
    .await?;
    invalidate_book_caches(&st, &book_id_for_cache);
    Ok(to_book_info(row))
}

#[tauri::command]
pub async fn restore_online_filtered_page(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    filtered_index: u32,
) -> Result<BookInfo, String> {
    let st = state.inner().clone();
    let st_work = st.clone();
    let book_id_for_cache = book_id.clone();
    let row = blocking(move || {
        let st = st_work;
        let (row, stored) = st
            .db
            .with(|conn| {
                let row = db::get_book(conn, &book_id)
                    .map_err(err)?
                    .ok_or_else(|| err("书籍不存在"))?;
                let stored = load_online_stored(&row).map_err(err)?;
                Ok((row, stored))
            })
            .map_err(BackendError::Msg)?;
        let filtered_page = stored
            .filtered
            .get(filtered_index as usize)
            .cloned()
            .ok_or_else(|| BackendError::Msg("过滤记录不存在".into()))?;
        let host = crate::online::filter::url_host(&filtered_page.url);
        let template = crate::online::filter::url_template(&filtered_page.url);
        let redacted = crate::online::filter::redacted_url(&filtered_page.url);
        let mut pages = stored.pages.clone();
        let insert_at = filtered_page.order.min(pages.len());
        pages.insert(
            insert_at,
            crate::online::PageRef {
                url: filtered_page.url.clone(),
                width: filtered_page.width,
                height: filtered_page.height,
                anchor: filtered_page.anchor.clone(),
            },
        );
        let mut filtered = stored.filtered.clone();
        filtered.remove(filtered_index as usize);
        let meta = rebuild_online_meta(&row, &stored, pages, filtered)?;
        let new_page_count = meta.page_count as u32;
        let now = db::now_str();
        let allow_patterns = {
            let mut patterns = vec![RulePattern::ExactUrl {
                url: redacted.clone(),
            }];
            if let Some(template) = &template {
                patterns.push(RulePattern::UrlTemplate {
                    template: template.clone(),
                });
            }
            patterns
        };
        let row = st
            .db
            .with(|conn| {
                let tx = conn.unchecked_transaction().map_err(err)?;
                // 删除与该页匹配的用户 block 规则；保留其他章节规则。
                let existing = db::rules_for_host(&tx, &host).map_err(err)?;
                let mut remove_ids = Vec::new();
                for rule in existing {
                    if rule.action != FilterAction::Block {
                        continue;
                    }
                    let matched = match &rule.pattern {
                        RulePattern::UrlTemplate { template: value } => {
                            template.as_deref() == Some(value.as_str())
                        }
                        RulePattern::ExactUrl { url } => *url == redacted,
                        RulePattern::Sha256 { hash } => {
                            filtered_page.sha256.as_deref() == Some(hash.as_str())
                        }
                        RulePattern::Size { width, height } => {
                            filtered_page.width == Some(*width)
                                && filtered_page.height == Some(*height)
                        }
                        RulePattern::DomClass { .. } => false,
                    };
                    if matched {
                        remove_ids.push(rule.id);
                    }
                }
                db::delete_filter_rules(&tx, &remove_ids).map_err(err)?;
                for pattern in allow_patterns {
                    let rule = FilterRule {
                        id: page_rule_id("allow", &host, &pattern),
                        host: host.clone(),
                        action: FilterAction::Allow,
                        source: RuleSource::User,
                        pattern,
                        reason: "user-restored".into(),
                        created_at: now.clone(),
                        hits: 0,
                    };
                    db::upsert_filter_rule(&tx, &rule).map_err(err)?;
                }
                // 恢复即修正本站阈值：把该页尺寸纳入标准宽度区间。
                let mut profile = db::get_filter_profile(&tx, &host)
                    .map_err(err)?
                    .unwrap_or_else(|| SiteProfile::empty(host.clone()));
                if let Some(width) = filtered_page.width {
                    profile.width_min = Some(profile.width_min.map_or(width, |v| v.min(width)));
                    profile.width_max = Some(profile.width_max.map_or(width, |v| v.max(width)));
                }
                if let (Some(width), Some(height)) = (filtered_page.width, filtered_page.height) {
                    let aspect = crate::online::filter::aspect_ratio(width, height);
                    profile.aspect_max = Some(
                        profile
                            .aspect_max
                            .map_or(aspect.max(2.8), |v| v.max(aspect).max(2.8))
                            .min(5.0),
                    );
                }
                profile.updated_at = now.clone();
                db::upsert_filter_profile(&tx, &profile).map_err(err)?;
                db::upsert_online_book(
                    &tx,
                    &row.id,
                    &row.path,
                    &row.title,
                    new_page_count,
                    &row.source_type,
                    &meta.meta_json,
                )
                .map_err(err)?;
                let current = if insert_at <= row.current_page as usize {
                    row.current_page.saturating_add(1)
                } else {
                    row.current_page
                };
                let current = current.min(new_page_count.saturating_sub(1));
                tx.execute(
                    "UPDATE books SET current_page=?1 WHERE id=?2",
                    rusqlite::params![current as i64, row.id],
                )
                .map_err(err)?;
                db::record_filter_event(
                    &tx,
                    &host,
                    &row.id,
                    &redacted,
                    "restored",
                    "user",
                    filtered_page.width,
                    filtered_page.height,
                    filtered_page.sha256.as_deref(),
                )
                .map_err(err)?;
                tx.commit().map_err(err)?;
                db::get_book(conn, &row.id)
                    .map_err(err)?
                    .ok_or_else(|| err("恢复后回读书籍失败"))
            })
            .map_err(BackendError::Msg)?;
        Ok(row)
    })
    .await?;
    invalidate_book_caches(&st, &book_id_for_cache);
    Ok(to_book_info(row))
}

#[tauri::command]
pub async fn get_filtered_preview(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    filtered_index: u32,
) -> Result<PageImage, String> {
    let st = state.inner().clone();
    blocking(move || {
        let row = st
            .db
            .with(|conn| db::get_book(conn, &book_id).map_err(err))
            .map_err(BackendError::Msg)?
            .ok_or_else(|| BackendError::Msg("书籍不存在".into()))?;
        let stored = load_online_stored(&row)?;
        let page = stored
            .filtered
            .get(filtered_index as usize)
            .cloned()
            .ok_or_else(|| BackendError::Msg("过滤记录不存在".into()))?;
        let s = st.settings.lock().clone();
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let transport = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let mut url = page.url.clone();
        let mut resp = transport.get(
            &url,
            crate::online::PAGE_MAX_BYTES,
            Some(&row.path),
            Some(&row.path),
        )?;
        if matches!(resp.status, 403 | 404) {
            if let Some(anchor) = page.anchor.as_ref() {
                if let Ok(Some(fresh)) =
                    crate::online::telegram::refresh_page_url(&transport, anchor)
                {
                    if let Ok(normalized) = crate::online::normalize_url(&fresh) {
                        url = normalized.to_string();
                        resp = transport.get(
                            &url,
                            crate::online::PAGE_MAX_BYTES,
                            Some(&row.path),
                            Some(&row.path),
                        )?;
                    }
                }
            }
        }
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "过滤图预览 HTTP {}",
                resp.status
            )));
        }
        let image = image::load_from_memory(&resp.body)
            .map_err(|e| BackendError::Decode(format!("过滤图预览解码失败：{e}")))?;
        let (orig_w, orig_h) = image.dimensions();
        let thumb = image.thumbnail(360, 540);
        let (width, height) = thumb.dimensions();
        let mut buf = Vec::new();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
        encoder
            .encode_image(&thumb)
            .map_err(|e| BackendError::Decode(format!("过滤图预览编码失败：{e}")))?;
        Ok(PageImage {
            index: filtered_index,
            width,
            height,
            orig_width: orig_w,
            orig_height: orig_h,
            mime: "image/jpeg".into(),
            data_url: format!("data:image/jpeg;base64,{}", B64.encode(&buf)),
        })
    })
    .await
}

#[tauri::command]
pub async fn resolve_telegram_channel(
    state: State<'_, Arc<AppState>>,
    url: String,
    before: Option<i64>,
) -> Result<crate::online::telegram::TelegramChannel, String> {
    crate::resilience::ensure_online_allowed()?;
    let st = state.inner().clone();
    blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let host = crate::online::filter::url_host(&url);
        let memory = filter_memory_for(&st, &host)?;
        let thresholds = thresholds_from(memory.profile.as_ref());
        crate::online::telegram::fetch_channel(&http, &url, before, &memory, &thresholds)
    })
    .await
}

fn safe_telegram_download_name(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("telegram.cbz");
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let lower = cleaned.to_ascii_lowercase();
    if !(lower.ends_with(".zip") || lower.ends_with(".cbz")) {
        cleaned.push_str(".cbz");
    }
    if cleaned
        .trim_matches(|c| c == '.' || c == ' ' || c == '_')
        .is_empty()
    {
        "telegram.cbz".into()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn download_telegram_document(
    state: State<'_, Arc<AppState>>,
    url: String,
    filename: String,
) -> Result<BookInfo, String> {
    crate::resilience::ensure_online_allowed()?;
    let st = state.inner().clone();
    let st_work = st.clone();
    let row = blocking(move || {
        let st = st_work;
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let canonical = crate::online::normalize_url(&url)?;
        let lower_path = canonical.path().to_ascii_lowercase();
        let lower_name = filename.to_ascii_lowercase();
        // Telegram CDN 直链经常没有扩展名，以用户点击的附件名为准。
        if !(lower_path.ends_with(".zip")
            || lower_path.ends_with(".cbz")
            || lower_name.ends_with(".zip")
            || lower_name.ends_with(".cbz"))
        {
            return Err(BackendError::Msg("仅支持公开的 .zip/.cbz 漫画附件".into()));
        }
        let session_headers = st.session_online_headers.lock().clone();
        let headers =
            crate::state::effective_online_headers(&s.online_headers, session_headers.as_deref());
        let http = crate::online::http::UreqTransport::new_with_assisted(
            &s.online_proxy,
            &headers,
            st.assisted_sessions.clone(),
        )?;
        let resp = http.get(
            canonical.as_str(),
            TELEGRAM_DOC_MAX_BYTES,
            Some("https://t.me/"),
            Some(canonical.as_str()),
        )?;
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "Telegram 附件 HTTP {}",
                resp.status
            )));
        }
        let safe_name = safe_telegram_download_name(&filename);
        let root = st
            .db_path()
            .parent()
            .map(|p| p.join("downloads").join("telegram"))
            .unwrap_or_else(|| std::env::temp_dir().join("manga-reader-telegram"));
        std::fs::create_dir_all(&root)?;
        let digest = hex::encode(Sha256::digest(canonical.as_str().as_bytes()));
        let path = root.join(format!("{}-{}", &digest[..12], safe_name));
        std::fs::write(&path, &resp.body)?;
        let db_path = st.db_path();
        let imported = {
            let conn = db::open(db_path)?;
            db::init_schema(&conn)?;
            scan_single_book(&conn, &path)
        };
        match imported {
            Ok(book) => Ok(book),
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                Err(e)
            }
        }
    })
    .await?;
    invalidate_book_caches(&st, &row.id);
    Ok(row)
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
    settings.cache_budget_mb = settings.cache_budget_mb.clamp(16, 2048);
    settings.disk_cache_budget_mb =
        crate::disk_cache::clamp_budget_mb(settings.disk_cache_budget_mb);

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
    state.trim_disk_cache_async();
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
            "disk_cache_budget_mb",
            "library_dir",
            "experimental_webtoon",
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
        // 两层嵌套章节也应被递归识别。
        let nested = root.join("系列/第3话");
        std::fs::create_dir_all(&nested).unwrap();
        tiny_png(&nested.join("p1.png"));

        // 单本书：直下就是图片。
        let single = dir.join("单行本");
        std::fs::create_dir_all(&single).unwrap();
        tiny_png(&single.join("p1.png"));

        let db = dir.join("lib.db");

        // 书库根 → 逐子项/嵌套章节入库 3 本。
        let items = import_blocking(db.clone(), vec![root.to_string_lossy().into()]).unwrap();
        assert_eq!(items.iter().filter(|i| i.status == "added").count(), 3);

        // 直下图片的目录 → 单本书。
        let items = import_blocking(db.clone(), vec![single.to_string_lossy().into()]).unwrap();
        assert_eq!(items.iter().filter(|i| i.status == "added").count(), 1);

        // 重复导入 → 重新扫描并刷新页数/元数据，但不重复建书。
        let items = import_blocking(
            db,
            vec![
                root.to_string_lossy().into(),
                single.to_string_lossy().into(),
            ],
        )
        .unwrap();
        assert_eq!(items.len(), 4);
        assert!(
            items.iter().all(|i| i.status == "restored"),
            "重复导入应刷新而非静默跳过：{items:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn book_info_webtoon_ready_allows_lazy_dimension_probe() {
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
        // 缺尺寸不再永久关闭条漫：进入条漫时按页探测并回写。
        assert!(to_book_info(online).webtoon_ready);

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
            anchor: None,
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
            series_title: None,
            chapter_index: None,
            next_url: None,
            filtered: Vec::new(),
            filter_profile: None,
        };
        crate::online::direct::OnlineBookMeta {
            canonical_url: canonical_url.to_string(),
            source_type: "generic_manga".to_string(),
            title: title.to_string(),
            page_count: stored.pages.len(),
            meta_json: serde_json::to_string(&stored).expect("序列化 StoredMeta"),
            series_id: None,
            series_title: None,
            chapter_index: None,
            next_url: None,
            filtered: Vec::new(),
            filter_profile: None,
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
    fn apply_resolved_meta_is_idempotent_when_hash_unchanged() {
        let st = online_state();
        let meta = online_meta("https://example.com/gallery/2", "不变", "h1", pages(2));
        let (row, _) = apply_resolved_meta(&st, &meta).expect("首次入库");
        let id = row.id;

        let (row, changed) = apply_resolved_meta(&st, &meta).expect("同清单应可重复解析");
        assert!(!changed, "hash 未变不应标记变化");
        assert_eq!(row.id, id);
        assert_eq!(row.page_count, 2);
    }

    #[test]
    fn apply_resolved_meta_clamps_progress_on_hash_change() {
        let st = online_state();
        let old = online_meta("https://example.com/gallery/4", "旧", "h1", pages(5));
        let (row, _) = apply_resolved_meta(&st, &old).expect("首次入库");
        let id = row.id;
        st.db
            .with(|conn| {
                db::set_progress(conn, &id, 4, None).map_err(|e| e.to_string())
            })
            .expect("写入进度");

        // 页数不变的变化：进度保留。
        let same_len = online_meta("https://example.com/gallery/4", "新", "h2", pages(5));
        let (row, changed) = apply_resolved_meta(&st, &same_len).expect("清单变化应更新");
        assert!(changed);
        assert_eq!(row.title, "新");
        assert_eq!(row.current_page, 4, "页数未缩小时进度应保留");

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
            crate::online::direct::MetaLinks {
                series_id: series_id.map(str::to_string),
                next_url: next_url.map(str::to_string),
                ..crate::online::direct::MetaLinks::default()
            },
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
    fn natural_path_orders_mixed_extensions_and_nested_entries() {
        let mut mixed = vec!["page10.png", "page_2.png", "page_1.png"];
        mixed.sort_by(|a, b| natural_cmp_path(a, b));
        assert_eq!(
            mixed,
            vec!["page_1.png", "page_2.png", "page10.png"],
            "混合分隔符/扩展开关不能退回字典序"
        );

        let mut nested = vec!["chap10/1.png", "chap2/10.png", "chap2/2.png"];
        nested.sort_by(|a, b| natural_cmp_path(a, b));
        assert_eq!(
            nested,
            vec!["chap2/2.png", "chap2/10.png", "chap10/1.png"],
            "多级目录必须先按章节目录再按页号自然排序"
        );

        let mut volumes = vec!["第10话", "第2话", "第02话"];
        volumes.sort_by(|a, b| natural_cmp_path(a, b));
        assert_eq!(volumes, vec!["第02话", "第2话", "第10话"]);
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

    fn insert_series_book(
        st: &AppState,
        canonical: &str,
        title: &str,
        series_id: &str,
        series_title: &str,
        chapter_index: Option<u32>,
    ) -> String {
        let meta = crate::online::direct::make_meta_with_links(
            &url::Url::parse(canonical).unwrap(),
            title,
            pages(1),
            crate::online::direct::MetaLinks {
                series_id: Some(series_id.to_string()),
                series_title: Some(series_title.to_string()),
                chapter_index,
                next_url: None,
            },
        )
        .unwrap();
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
    fn series_books_sort_by_chapter_index_and_filter_series() {
        let st = online_state();
        let c2 = insert_series_book(&st, "http://e/s2", "第2话", "S", "Series", Some(2));
        let c1 = insert_series_book(&st, "http://e/s1", "第1话", "S", "Series", Some(1));
        let c3 = insert_series_book(&st, "http://e/s3", "第3话", "S", "Series", Some(3));
        let extra = insert_series_book(&st, "http://e/sx", "番外", "S", "Series", None);
        let other = insert_series_book(&st, "http://e/o1", "第1话", "Other", "Other", Some(1));

        st.db
            .with(|conn| {
                let books = get_series_books_impl(conn, "S").unwrap();
                let ids: Vec<&str> = books.iter().map(|b| b.id.as_str()).collect();
                assert_eq!(
                    ids,
                    vec![c1.as_str(), c2.as_str(), c3.as_str(), extra.as_str()]
                );
                assert_eq!(books[0].series_title.as_deref(), Some("Series"));
                assert_eq!(books[0].chapter_index, Some(1));
                assert!(books.iter().all(|b| b.id != other));
                assert!(get_series_books_impl(conn, "").unwrap().is_empty());
                assert!(get_series_books_impl(conn, "missing").unwrap().is_empty());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn batch_ingest_imports_all_and_persists_links() {
        let st = online_state();
        let payload = r#"{"seriesId":"S","seriesTitle":"Series","chapters":[
            {"title":"第1话","url":"http://e/1","pages":["http://x/1.jpg"]},
            {"title":"第2话","url":"http://e/2","pages":["http://x/2.jpg"]}
        ]}"#;
        let metas = crate::online::direct::parse_batch_payload(payload.as_bytes()).unwrap();
        let books = ingest_resolved_batch(&st, metas).unwrap();
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].series_id.as_deref(), Some("S"));
        assert_eq!(books[0].series_title.as_deref(), Some("Series"));
        assert_eq!(books[0].chapter_index, Some(1));
        assert_eq!(books[1].chapter_index, Some(2));
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
        // 缺尺寸的在线书允许进入条漫，布局时按页探测尺寸（不再永久关闭）。
        assert!(info.webtoon_ready);
        let book = st
            .db
            .with(|conn| db::get_book(conn, &id).map_err(|e| e.to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(book.page_count, 2);
    }

    // ---------- 失效路径检测 + 无损重定位 ----------

    fn book_row(id: &str, path: &str, source_type: &str) -> db::BookRow {
        db::BookRow {
            id: id.into(),
            path: path.into(),
            title: id.into(),
            page_count: 1,
            current_page: 0,
            updated_at: String::new(),
            scroll_pct: -1.0,
            source_type: source_type.into(),
            meta_json: "{}".into(),
        }
    }

    #[test]
    fn book_info_marks_missing_only_for_absent_local_sources() {
        let dir = test_temp_dir("missing");
        let path = dir.to_string_lossy().to_string();
        let local = book_row("local", &path, "local");
        assert!(!to_book_info(local.clone()).missing, "源目录存在时不得误报");

        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            to_book_info(local).missing,
            "本地源被移动/删除后必须标记 missing"
        );

        // 在线书没有本地路径语义，恒为 false。
        let online = book_row("online", "https://example.test/gallery/1", "generic_manga");
        assert!(!to_book_info(online).missing);
    }

    #[test]
    fn renamed_archive_keeps_page_fifteen_after_relocation() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let dir = test_temp_dir("relocate-archive");
        let old_path = dir.join("读到第15页.cbz");
        {
            let file = std::fs::File::create(&old_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            for index in 0..20 {
                zip.start_file(format!("p{index:02}.png"), SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(b"not-decoded-by-import").unwrap();
            }
            zip.finish().unwrap();
        }

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        let book = scan_single_book(&conn, &old_path).unwrap();
        assert_eq!(book.page_count, 20);
        db::set_progress(&conn, &book.id, 15, None).unwrap();

        let new_path = dir.join("改名后的漫画.cbz");
        std::fs::rename(&old_path, &new_path).unwrap();

        let row = relocate_book_impl(
            &conn,
            &book.id,
            &new_path.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(row.path, new_path.to_string_lossy());
        assert_eq!(row.page_count, 20);
        assert_eq!(row.current_page, 15, "重定位后必须仍停在第 15 页");
        assert_eq!(
            db::reading_log_days(&conn, Some(&row.id), 1).unwrap(),
            vec![(db::today_str(), 15)]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn relocate_book_impl_repoints_book_and_rejects_occupied_target() {
        let dir = test_temp_dir("relocate");
        let old_dir = dir.join("old");
        std::fs::create_dir_all(&old_dir).unwrap();
        tiny_png(&old_dir.join("p1.png"));
        let new_dir = dir.join("new");
        std::fs::create_dir_all(&new_dir).unwrap();
        tiny_png(&new_dir.join("p1.png"));

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        let old_path = old_dir.to_string_lossy().to_string();
        let old_id = db::book_id_for_path(&old_path);
        db::upsert_book(&conn, &old_id, &old_path, "旧", 1).unwrap();

        let new_path = new_dir.to_string_lossy().to_string();
        let row = relocate_book_impl(&conn, &old_id, &new_path).unwrap();
        assert_eq!(row.id, db::book_id_for_path(&new_path));
        assert_eq!(row.path, new_path);
        assert_eq!(row.title, "new");
        assert!(db::get_book(&conn, &old_id).unwrap().is_none());

        // 目标已被另一本书占用 → 明确拒绝，不能覆盖。
        let other_dir = dir.join("other");
        std::fs::create_dir_all(&other_dir).unwrap();
        tiny_png(&other_dir.join("p1.png"));
        let other_path = other_dir.to_string_lossy().to_string();
        let other_id = db::book_id_for_path(&other_path);
        db::upsert_book(&conn, &other_id, &other_path, "other", 1).unwrap();
        let err = relocate_book_impl(&conn, &row.id, &other_path)
            .unwrap_err()
            .to_string();
        assert_eq!(err, "目标路径已在书库中");

        // 目标不存在 → 明确报错。
        let err = relocate_book_impl(&conn, &row.id, &dir.join("gone.cbz").to_string_lossy())
            .unwrap_err()
            .to_string();
        assert!(err.contains("目标路径不存在"), "{err}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
