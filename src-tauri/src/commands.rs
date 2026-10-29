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
use std::time::{Instant, UNIX_EPOCH};

use crate::db::{self};
use crate::pdf;
use crate::pipeline;
use crate::pipeline::RenderedPage;
use crate::source::{self, BackendError, ImageSource};
use crate::state::AppState;
use crate::{
    BookDayPoint, BookInfo, Dashboard, HeatDay, ImportItemResult, ImportResult, MemoryStats,
    OnlineProbe, PageDim, PageEntry, PageImage, PdfChunk, RemoveResult, ScanResult, SeriesProgress,
    Settings,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::GenericImageView as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::online::filter::{
    FilterAction, FilterMemory, FilterRule, FilterStats, FilterThresholds, FilteredPage,
    RulePattern, RuleSource, SiteProfile,
};
use crate::online::http::HttpTransport;

pub(crate) fn err(e: impl ToString) -> String {
    e.to_string()
}

/// 在线清单可能缺少 width/height（典型：Telegram 相册只给 CDN URL）。
/// 条漫布局会在用户显式进入条漫时按页探测并回写尺寸，因此这里只要求
/// 有页面；绝不因为缺尺寸就把整本书的条漫能力永久关死。
fn webtoon_ready(r: &db::BookRow, stored: Option<&crate::online::StoredMeta>) -> bool {
    // PDF-1：PDF 文档尚无渲染器（PDF-2），条漫能力不适用。
    if r.format == db::BOOK_FORMAT_PDF {
        return false;
    }
    if r.source_type == "local" {
        return true;
    }
    match stored {
        Some(meta) => !meta.pages.is_empty(),
        None => {
            crate::logging::log_error("online_meta", &format!("书籍 {} 元数据损坏", r.id));
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
    // meta_json 每次列表都会解析：只解析一次，供条漫能力与系列字段共用。
    let stored = serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json).ok();
    let webtoon_ready = webtoon_ready(&r, stored.as_ref());
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
        format: r.format,
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
    a_tokens.len().cmp(&b_tokens.len()).then_with(|| a.cmp(b))
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
        Some((stem, ext)) if ["zip", "cbz", "pdf"].contains(&ext.to_ascii_lowercase().as_str()) => {
            stem.to_string()
        }
        _ => name.to_string(),
    }
}

/// 压缩包（单文件）的增量扫描指纹；目录不参与，避免漏掉嵌套变更。
fn archive_stamp(path: &Path) -> Option<db::SourceStamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(db::SourceStamp {
        mtime: modified.as_secs().min(i64::MAX as u64) as i64,
        size: meta.len().min(i64::MAX as u64) as i64,
    })
}

/// 扫描一本书：打开源 → 取页数 → upsert。
///
/// 已入库的压缩包若 mtime/字节数都未变，直接复用页数，不再解包；
/// 目录始终全量扫描（嵌套文件变化不会可靠地反映在目录 mtime 上）。
fn scan_single_book(conn: &rusqlite::Connection, path: &Path) -> Result<BookInfo, BackendError> {
    // 书库 id = sha256(path)，path 会落 SQLite/JSON；非 UTF-8 必须显式拒绝，
    // 否则 lossy 转换可能让两本不同的书落到同一个 id。
    let path_str = path
        .to_str()
        .ok_or_else(|| {
            BackendError::Msg("路径包含非 UTF-8 字符，当前版本暂不支持（non-utf8-path）".into())
        })?
        .to_string();
    // Windows 下同一路径的 `/`、`\` 与大小写写法必须落到同一本书。
    let id = db::find_book_id_by_path(conn, &path_str)?
        .unwrap_or_else(|| db::book_id_for_path(&path_str));
    // PDF-1：PDF 只做**识别与入库**——校验文件头、写入 format='pdf'，
    // 页数留 0（PDF-2 之前没有阅读能力，也不需要任何 PDF 依赖）。
    if source::is_pdf_path(path) {
        source::validate_pdf_document(path)?;
        let title = title_for(path);
        // 已知页数必须保留：PDF 的真实页数由前端 PDF.js 解析后经
        // `set_book_page_count` 回写；重新导入 / 重扫同一路径时若把它写回 0，
        // `clamp_reading_page` 就会退化成「完全不钳制」，PDF 的阅读位置也失去上界。
        // 新书没有旧行 → 0；旧书 → 沿用库里已知的页数。
        let known_pages = db::get_book(conn, &id)?
            .map(|row| row.page_count)
            .unwrap_or(0);
        db::upsert_book_with_format(
            conn,
            &id,
            &path_str,
            &title,
            known_pages,
            db::BOOK_FORMAT_PDF,
        )?;
        let _ = db::clear_source_stamp(conn, &id);
        return db::get_book(conn, &id)?
            .ok_or_else(|| BackendError::Msg("入库后回读失败".into()))
            .map(to_book_info);
    }
    let stamp = archive_stamp(path);
    if let (Some(stamp), Ok(Some(row))) = (stamp, db::get_book(conn, &id)) {
        if row.source_type == "local"
            && row.page_count > 0
            && db::source_stamp(conn, &id)? == Some(stamp)
        {
            let title = title_for(path);
            // 仍然 upsert：重复导入会刷新 updated_at 并恢复软删，只是跳过解包。
            db::upsert_book(conn, &id, &path_str, &title, row.page_count)?;
            return Ok(to_book_info(row));
        }
    }
    let result = (|| {
        let src = source::open_source(path)?;
        let count = src.page_count()? as u32;
        if count == 0 {
            return Err(BackendError::Msg("书中没有可读图片，跳过".into()));
        }
        let title = title_for(path);
        db::upsert_book(conn, &id, &path_str, &title, count)?;
        if let Some(stamp) = stamp {
            db::set_source_stamp(conn, &id, stamp)?;
        } else {
            db::clear_source_stamp(conn, &id)?;
        }
        db::get_book(conn, &id)?.ok_or_else(|| BackendError::Msg("入库后回读失败".into()))
    })();
    if result.is_err() {
        // 失败后不得保留旧指纹，否则文件回滚到旧 mtime/大小时会被误判为未变。
        let _ = db::clear_source_stamp(conn, &id);
    }
    result.map(to_book_info)
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
        } else if source::is_archive_path(&kid) || source::is_pdf_path(&kid) {
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
    } else if path.is_file() && (source::is_archive_path(&path) || source::is_pdf_path(&path)) {
        candidates.push(path.clone());
    } else {
        return Err(BackendError::Msg(format!(
            "扫描路径无效（需要目录或 .zip/.cbz/.pdf）：{root}"
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
    // 刷新后全量回读；文件 stat / meta_json 解析放在 DB 锁外，避免阻塞阅读进度写入。
    let rows = state
        .db
        .with(|conn| db::list_books(conn, None).map_err(err))?;
    let list: Vec<BookInfo> = rows.into_iter().map(to_book_info).collect();
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
    let existed = db::find_book_id_by_path(conn, &path)
        .ok()
        .flatten()
        .is_some();
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
            if !source::is_archive_path(&p) && !source::is_pdf_path(&p) {
                out.push(import_outcome(
                    &path,
                    "failed",
                    "不支持的文件（需要 .zip/.cbz/.pdf；图片文件夹请拖文件夹）".into(),
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
                        "目录中没有可识别的书籍（需要：直下图片 / 含图片的嵌套目录 / zip/cbz/pdf）"
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
                if let Err(reason) = validate_delete_target(Path::new(&b.path)) {
                    errors.push(format!("{}：{reason}", b.title));
                    continue;
                }
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
    // 只把 SQL 放在 DbSlot 锁内：逐本 symlink_metadata 与 meta_json 解析在锁外，
    // 大书库列表不会拖住阅读器的高频 set_progress。
    let rows = state
        .db
        .with(|conn| db::list_books(conn, query.as_deref()).map_err(err))?;
    Ok(rows.into_iter().map(to_book_info).collect())
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
    if path.is_file() && !source::is_archive_path(&path) && !source::is_pdf_path(&path) {
        return Err(BackendError::Msg(
            "只支持 .zip/.cbz 压缩包、.pdf 文档或图片文件夹".to_string(),
        ));
    }
    let old =
        db::get_book(conn, old_id)?.ok_or_else(|| BackendError::Msg("书籍不存在".to_string()))?;
    // PDF-1：PDF 目标只做识别与身份迁移，不解析页数（PDF-1 无渲染器，页数记 0）。
    let (page_count, format) = if source::is_pdf_path(&path) {
        source::validate_pdf_document(&path)?;
        (0u32, db::BOOK_FORMAT_PDF.to_string())
    } else {
        let source_handle = source::open_source(&path)?;
        let count = source_handle.page_count()? as u32;
        if count == 0 {
            return Err(BackendError::Msg(
                "新位置没有可读图片，无法重定位".to_string(),
            ));
        }
        (count, db::BOOK_FORMAT_IMAGE.to_string())
    };

    if old.source_type != "local" {
        return Err(BackendError::Msg("只能重定位本地书籍".to_string()));
    }
    let new_id =
        db::find_book_id_by_path(conn, &dest)?.unwrap_or_else(|| db::book_id_for_path(&dest));
    if old.id == new_id && old.path == dest {
        return Ok(old);
    }
    if new_id != old.id && db::get_book(conn, &new_id)?.is_some() {
        return Err(BackendError::Msg("目标路径已在书库中".to_string()));
    }
    // 普通书沿用原重定位（format 保持不变）；PDF 走带 format 的变体，
    // 在同一事务里把来源格式写成 pdf。
    if format == db::BOOK_FORMAT_PDF {
        return db::relocate_book_with_format(
            conn,
            old_id,
            &new_id,
            &dest,
            &title_for(&path),
            page_count,
            &format,
        );
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
///
/// L2 成品缓存的热路径专用：走 `image` crate 的头部解析，行为保持不变。
/// PDF 封面走 [`pdf::jpeg_dims`]（严格 SOF 段解析 + 尺寸边界）。
fn jpeg_dims(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()?
        .into_dimensions()?;
    Ok((w, h))
}

/// 从 PNG 字节读尺寸（严格校验签名 + IHDR，不解码、不依赖图片库）。
///
/// 旧实现只读 `bytes[16..24]`，任何「首字节像 PNG」的垃圾字节都能伪造出一个
/// 30000×30000 的尺寸。现在统一委托 [`pdf::png_dims`]：IHDR 长度字段必须是 13、
/// 块类型必须是 `"IHDR"`，否则一律拒绝。
fn png_dims(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    pdf::png_dims(bytes)
}

/// 封面解码失败 → 统一收敛到稳定错误码 `pdf-cover-invalid`。
///
/// 非中文界面靠文案**末尾**的稳定码做六语本地化（`src/features/errors/localize.ts`），
/// 所以码必须留在最后；内层文案若已带同名码则先去重，避免出现两次。
fn pdf_cover_invalid(error: BackendError) -> BackendError {
    let detail = error.to_string().replace("（pdf-cover-invalid）", "");
    BackendError::Msg(format!("PDF 封面缓存已损坏：{detail}（pdf-cover-invalid）"))
}

/// PDF 封面字节（前端 PDF.js 渲染后回传）→ `RenderedPage`。
///
/// 只接受 JPEG / PNG；其它字节一律视为坏缓存（调用方负责删除）。
/// 尺寸必须过 [`pdf::validate_cover_dimensions`] 的边界（单边 ≤4096px、面积 ≤16Mpx），
/// 否则一张压缩比极高的超大图会被**每次**读取缩略图时完整 base64 送进前端。
fn pdf_cover_page(bytes: Vec<u8>) -> Result<RenderedPage, BackendError> {
    let (mime, dims) = if pdf::is_jpeg(&bytes) {
        (
            "image/jpeg",
            pdf::jpeg_dims(&bytes).map_err(pdf_cover_invalid)?,
        )
    } else if pdf::is_png(&bytes) {
        ("image/png", png_dims(&bytes).map_err(pdf_cover_invalid)?)
    } else {
        return Err(BackendError::Msg(
            "PDF 封面缓存已损坏（pdf-cover-invalid）".into(),
        ));
    };
    let (width, height) = dims;
    // 尺寸边界（AGENTS.md §4.5）：单边 ≤4096px、面积 ≤16Mpx。
    pdf::validate_cover_dimensions(width, height)?;
    Ok(RenderedPage {
        width,
        height,
        orig_width: width,
        orig_height: height,
        mime: mime.to_string(),
        data_url: format!("data:{mime};base64,{}", B64.encode(&bytes)),
        bytes,
    })
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
    let (is_online, format) = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|b| (b.source_type != "local", b.format))
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    // PDF-2：PDF 绝不能进入图片取页管线（页面由前端 PDF.js 渲染）。
    // 这里显式拦下，避免 L2 里恰好存在同尺寸封面时被当成「第 1 页」返回。
    if format == db::BOOK_FORMAT_PDF {
        return Err("PDF 源不支持按图片取页（pdf-source-unsupported）".to_string());
    }
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
    // 先查来源格式：PDF 没有「首页图片」，封面来自前端渲染后写回的 L2 缓存。
    // PDF 绝不能走 source_handle_for_book（那条路径有意拒绝 PDF）。
    let format = state.db.with(|conn| {
        db::get_book(conn, &book_id)
            .map_err(err)?
            .map(|row| row.format)
            .ok_or_else(|| "书籍不存在".to_string())
    })?;
    if format == db::BOOK_FORMAT_PDF {
        return pdf_thumbnail(state.inner(), &book_id).await;
    }
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

/// PDF 封面读取：固定边长（[`pdf::PDF_COVER_EDGE`]）的 L2 缓存成品。
///
/// 与图片书不同：PDF 没有首页图，封面由前端 PDF.js 渲染后经
/// `put_pdf_thumbnail` 写回缓存。缓存缺失时返回稳定错误码
/// `pdf-cover-missing`，前端据此生成封面（而不是显示空白）。
async fn pdf_thumbnail(state: &Arc<AppState>, book_id: &str) -> Result<PageImage, String> {
    let st = state.clone();
    let book = book_id.to_string();
    let rendered = blocking(move || -> Result<RenderedPage, BackendError> {
        let Some(bytes) = st
            .render
            .get_raw(&book, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE)
        else {
            return Err(BackendError::Msg(
                "PDF 封面尚未生成（pdf-cover-missing）".into(),
            ));
        };
        match pdf_cover_page(bytes) {
            Ok(page) => Ok(page),
            Err(error) => {
                // 坏缓存自愈：删掉后让前端重新生成封面。
                st.render
                    .remove_page(&book, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE);
                Err(error)
            }
        }
    })
    .await?;
    Ok(to_page_image(0, rendered))
}

/// PDF 字节分块（PDF-2）：把本地 PDF 按字节区间喂给前端 PDF.js。
///
/// - 只允许**本地 PDF 书源**（`format='pdf'` 且 `source_type='local'`）；
/// - 路径必须通过本地书源安全策略（书库之外 / 系统目录里的 PDF 一律拒绝）；
/// - `length` 钳制到 4 MiB（`pdf::MAX_PDF_CHUNK_BYTES`）；
/// - `offset` 越界 → 返回空数据（前端视为 EOF），不是错误；
/// - `total` 始终是文件真实大小。
#[tauri::command]
pub async fn get_pdf_chunk(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    offset: u64,
    length: u32,
) -> Result<PdfChunk, String> {
    let st = state.inner().clone();
    let bid = book_id.clone();
    let result = blocking(move || -> Result<PdfChunk, BackendError> {
        let row = st
            .db
            .with(|conn| {
                db::get_book(conn, &bid)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "书籍不存在".to_string())
            })
            .map_err(BackendError::Msg)?;
        if row.format != db::BOOK_FORMAT_PDF {
            return Err(BackendError::Msg("该书不是 PDF 文档（pdf-not-pdf）".into()));
        }
        if row.source_type != "local" {
            return Err(BackendError::Msg(
                "PDF 源必须是本地文件（pdf-source-not-local）".into(),
            ));
        }
        let path = PathBuf::from(&row.path);
        // 先判「文件还在不在」：缺失文件如果直接走路径策略，错误码会退化成
        // 「不在允许范围内」，用户看不到真正的原因（文件被移动/删除）。
        if !path.exists() {
            return Err(BackendError::Msg("PDF 文件不存在（pdf-not-found）".into()));
        }
        // 本地书源路径策略：绝对路径、真实存在、.pdf、不在系统/应用目录内。
        if !is_safe_library_source_path(&path) {
            return Err(BackendError::Msg(
                "PDF 源路径不在允许的本地书源范围内（pdf-source-not-allowed）".into(),
            ));
        }
        let (total, bytes) = pdf::read_pdf_chunk(&path, offset, length)?;
        Ok(PdfChunk {
            total,
            data: B64.encode(&bytes),
        })
    })
    .await;
    match result {
        Ok(chunk) => Ok(chunk),
        Err(error) => {
            // 失败链路只记稳定书 ID 前缀、偏移与长度，绝不写书名/路径。
            crate::logging::log_error(
                "get_pdf_chunk",
                &format!(
                    "book={} offset={} length={}：{}",
                    short_book_ref(&book_id),
                    offset,
                    length,
                    safe_error_text(&error)
                ),
            );
            Err(error)
        }
    }
}

/// 写回 PDF 页数（PDF-2）：前端 PDF.js 解析出真实页数后调用。
///
/// 只更新 `books.page_count`：不动 id / path / format / 进度 / updated_at。
/// 仅 PDF 书可写；页数必须落在 `1..=1_000_000`。
#[tauri::command]
pub async fn set_book_page_count(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    page_count: u32,
) -> Result<(), String> {
    state.db.with(|conn| {
        let row = db::get_book(conn, &book_id)
            .map_err(err)?
            .ok_or_else(|| "书籍不存在".to_string())?;
        let count = pdf::validate_pdf_page_count(&row.format, page_count).map_err(err)?;
        db::set_book_page_count(conn, &book_id, count).map_err(err)
    })
}

/// 写入 PDF 封面（PDF-2）：前端 PDF.js 渲染首页后回传缓存。
///
/// - 只允许 PDF 书；
/// - base64 解码后必须 ≤ 2 MiB，且必须是 JPEG / PNG（任意字节不得进缓存）；
/// - 以**固定边长**（[`pdf::PDF_COVER_EDGE`]）落 L2 渲染缓存的第 0 页，
///   与 `get_thumbnail` 的读取键严格一致（不受 `max_size` 影响）。
#[tauri::command]
pub async fn put_pdf_thumbnail(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    data_base64: String,
) -> Result<(), String> {
    let st = state.inner().clone();
    let bid = book_id.clone();
    let result = blocking(move || -> Result<(), BackendError> {
        let row = st
            .db
            .with(|conn| {
                db::get_book(conn, &bid)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "书籍不存在".to_string())
            })
            .map_err(BackendError::Msg)?;
        if row.format != db::BOOK_FORMAT_PDF {
            return Err(BackendError::Msg(
                "只有 PDF 书可以保存封面（pdf-not-pdf）".into(),
            ));
        }
        let bytes = decode_base64_lenient(&data_base64).ok_or_else(|| {
            BackendError::Msg("PDF 封面数据不是合法 base64（pdf-cover-invalid）".into())
        })?;
        store_pdf_cover(&st, &bid, &bytes)?;
        Ok(())
    })
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            crate::logging::log_error(
                "put_pdf_thumbnail",
                &format!(
                    "book={}：{}",
                    short_book_ref(&book_id),
                    safe_error_text(&error)
                ),
            );
            Err(error)
        }
    }
}

/// base64 解码（宽容）：先按标准填充解码，再退回无填充变体。
fn decode_base64_lenient(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    B64.decode(trimmed).ok().or_else(|| {
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(trimmed)
            .ok()
    })
}

/// 把校验过的 PDF 封面字节写入 L2 渲染缓存（第 0 页，固定边长）。
fn store_pdf_cover(st: &Arc<AppState>, book_id: &str, bytes: &[u8]) -> Result<(), BackendError> {
    pdf::validate_pdf_cover(bytes)?;
    st.render
        .put(book_id, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE, bytes);
    st.note_cache_write(bytes.len());
    Ok(())
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
        cache_write_failures: crate::cache_health::failures(),
    }
}

/// 更新下载前预检：系统临时目录所在卷的可用字节数。
/// 失败返回 None，由前端决定是否放行（不把探测失败伪装成磁盘耗尽）。
#[tauri::command]
pub fn get_temp_free_bytes() -> Option<u64> {
    crate::platform::free_bytes(&std::env::temp_dir())
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
pub async fn clear_temp_cache(state: State<'_, Arc<AppState>>) -> Result<ClearCacheResult, String> {
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

/// 阅读位置钳制（PDF-2 有例外）。
///
/// - 普通图片书：钳到 `page_count - 1`（页数未知时钳到 0）。
/// - PDF 且**页数尚未回写**（`page_count == 0`）：不按页数钳制，但**仍按
///   `MAX_PDF_PAGE_COUNT` 设上界**。总页数由前端 PDF.js 解析后经
///   `set_book_page_count` 写回；此时若照常钳制，恢复位置会被压成第 1 页，
///   造成「PDF 阅读位置丢失」。页数补齐后即恢复常规钳制。
///
///   上界不是可有可无的：钳制被豁免期间 `reading_log` 的当日页数增量等于
///   `page - prev` 且无上限，一个越界页码会直接污染阅读统计。PDF 页数上界
///   是 `MAX_PDF_PAGE_COUNT`，因此存储值必须同样有界——既保住「进度不丢」，
///   又不让无效页位无限期存在。
fn clamp_reading_page(row: &db::BookRow, page: u32) -> u32 {
    if row.format == db::BOOK_FORMAT_PDF && row.page_count == 0 {
        return page.min(pdf::MAX_PDF_PAGE_COUNT);
    }
    page.min(row.page_count.saturating_sub(1))
}

#[tauri::command]
pub async fn set_progress(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    page: u32,
    scroll_pct: Option<f64>,
) -> Result<(), String> {
    // 页码钳制与写入必须在同一 DB 锁内完成，避免两次 db.with 之间
    // 书籍被删除/页数变化导致写入越界。
    let pct = scroll_pct.map(|p| p.clamp(0.0, 1.0));
    state.db.with(|conn| {
        let row = db::get_book(conn, &book_id)
            .map_err(err)?
            .ok_or_else(|| "书籍不存在".to_string())?;
        let clamped = clamp_reading_page(&row, page);
        db::set_progress(conn, &book_id, clamped, pct).map_err(err)
    })
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
            let dims: Option<(u32, u32)> =
                handle.read_partial(i, 256 * 1024).ok().and_then(|partial| {
                    image::ImageReader::new(std::io::Cursor::new(&partial.bytes))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok())
                        .filter(|d| d.0 > 0 && d.1 > 0)
                });
            let (w, h) = match dims {
                Some(d) => d,
                None => {
                    let raw = handle.read_raw(i)?;
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
    // 页数骤降通常意味着站点改版/反爬误判/图片被过滤；直接覆盖会把
    // current_page 钳到末页，用户看起来像“进度被吞”。保留旧清单并要求
    // 用户显式删除后重新导入。
    if let Some(old) = old.as_ref() {
        if old.page_count > 0 && (meta.page_count as u32) < old.page_count {
            return Err(BackendError::Msg(format!(
                "在线清单页数从 {} 降到 {}，已拒绝覆盖以保护阅读进度（online-page-count-drop）",
                old.page_count, meta.page_count
            )));
        }
    }
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
    let mut meta =
        crate::online::direct::make_meta_with_links(&canonical, &row.title, pages, links)?;
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
pub async fn export_online_filter_rules(state: State<'_, Arc<AppState>>) -> Result<String, String> {
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
                value
                    .get("profiles")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
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
pub async fn reset_online_filter_rules(state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
        // 与 pipeline 共用 header 预检：超巨图/解码炸弹在读整图前拒绝，
        // panic=abort 下绝不能把不受控尺寸交给 image::load_from_memory。
        let raw = crate::source::RawPage {
            bytes: resp.body,
            ext: String::new(),
        };
        crate::pipeline::source_dimensions(&raw)?;
        let image = image::load_from_memory(&raw.bytes)
            .map_err(|e| BackendError::Decode(format!("过滤图预览解码失败：{e}")))?;
        let (orig_w, orig_h) = image.dimensions();
        let thumb = image.thumbnail(360, 540);
        let (width, height) = thumb.dimensions();
        let mut buf = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
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

fn path_key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        raw.to_ascii_lowercase()
    } else {
        raw
    }
}

/// `target` 是否等于 `root` 或位于其下（用于系统目录，不用于用户主目录）。
fn path_within(target: &Path, root: &Path) -> bool {
    let t = path_key(target);
    let mut r = path_key(root);
    while r.ends_with('\\') && r.len() > 1 {
        r.pop();
    }
    if t == r {
        return true;
    }
    let prefix = if r.ends_with('\\') {
        r
    } else {
        format!("{r}\\")
    };
    t.starts_with(&prefix)
}

fn canonical_existing(path: &Path) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }
    path.canonicalize()
        .ok()
        .or_else(|| Some(path.to_path_buf()))
}

fn sensitive_system_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        for key in [
            "SystemRoot",
            "windir",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
        ] {
            if let Some(value) = std::env::var_os(key) {
                dirs.push(PathBuf::from(value));
            }
        }
    }
    #[cfg(not(windows))]
    {
        for path in [
            "/usr", "/etc", "/var", "/opt", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev",
            "/proc", "/sys", "/run",
        ] {
            dirs.push(PathBuf::from(path));
        }
    }
    dirs.into_iter()
        .filter_map(|path| canonical_existing(&path))
        .collect()
}

/// 宽目录：本身及其祖先不可作为删除目标，但其子目录可作为正常书库。
fn sensitive_user_wide_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push = |path: Option<PathBuf>| {
        if let Some(path) = path {
            if let Some(path) = canonical_existing(&path) {
                dirs.push(path);
            }
        }
    };
    push(dirs::home_dir());
    push(dirs::home_dir().and_then(|home| home.parent().map(Path::to_path_buf)));
    push(dirs::document_dir());
    push(dirs::desktop_dir());
    push(dirs::download_dir());
    push(dirs::picture_dir());
    push(dirs::video_dir());
    push(dirs::audio_dir());
    dirs
}

/// 用户数据/配置/缓存目录：本身及其祖先不可作为删除目标。
///
/// Windows 的 `AppData`、macOS 的 `Library`、Linux 的 `~/.local` 是上述
/// 目录的共同父级。只做等值判断会漏掉这些宽目录本身；一旦它们被当作
/// 书源，`remove_dir_all` 会波及其它应用的数据。
///
/// 注意：这里只用于**祖先**判定。不能把所有子孙都拒绝——`%TEMP%` 位于
/// `%LOCALAPPDATA%` 之下，浏览器下载/导入的临时书源必须仍可删除。应用自己的
/// 数据/缓存目录由 `protected_app_roots` 单独做子孙判定。
fn sensitive_user_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push = |path: Option<PathBuf>| {
        if let Some(path) = path {
            if let Some(path) = canonical_existing(&path) {
                dirs.push(path);
            }
        }
    };
    push(dirs::data_dir());
    push(dirs::data_local_dir());
    push(dirs::cache_dir());
    push(dirs::config_dir());
    if let Some(home) = dirs::home_dir() {
        let private = if cfg!(windows) {
            Some(home.join("AppData"))
        } else if cfg!(target_os = "macos") {
            Some(home.join("Library"))
        } else {
            Some(home.join(".local"))
        };
        push(private);
    }
    if let Ok(data) = crate::data_dir() {
        push(Some(data));
    }
    if let Some(cache) = crate::paths::cache_dir() {
        push(Some(cache.to_path_buf()));
    }
    dirs
}

/// 应用自己的数据/缓存根：其内部一律不可删除（library.db、日志、缓存）。
fn protected_app_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(data) = crate::data_dir() {
        if let Some(path) = canonical_existing(&data) {
            roots.push(path);
        }
    }
    if let Some(cache) = crate::paths::cache_dir() {
        if let Some(path) = canonical_existing(cache) {
            roots.push(path);
        }
    }
    roots
}

/// 删除目标是否落在受保护范围：系统目录双向、宽目录的祖先、数据目录的祖先、
/// 应用数据/缓存目录的子孙。
fn is_protected_source_path(
    canon: &Path,
    system_dirs: &[PathBuf],
    wide_dirs: &[PathBuf],
    data_dirs: &[PathBuf],
    app_roots: &[PathBuf],
) -> bool {
    if system_dirs
        .iter()
        .any(|root| path_within(canon, root) || path_within(root, canon))
    {
        return true;
    }
    if wide_dirs.iter().any(|dir| path_within(dir, canon)) {
        return true;
    }
    if data_dirs.iter().any(|dir| path_within(dir, canon)) {
        return true;
    }
    app_roots.iter().any(|root| path_within(canon, root))
}

/// 判断一个本地书源路径是否允许参与“删除源文件”。
///
/// 规则：
/// - 必须是绝对路径、当前存在；
/// - 文件必须是 `.zip`/`.cbz`/`.pdf`（绝不删除 library.db、日志或任意普通文件）；
/// - 目录不得是文件系统根、系统目录、用户主目录/文档/桌面/下载等宽目录本身，
///   也不得是这些目录或用户数据/缓存目录的**祖先**（例如 Windows 的 `AppData`）；
/// - 允许宽目录的**子目录**作为漫画书目录，避免误伤正常书库；数据/缓存目录内部
///   一律拒绝。
///
/// 该函数同时用于 `.mrbackup` 恢复过滤，避免恶意备份把宽目录或其祖先伪装成书籍。
pub(crate) fn is_safe_library_source_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(canon) = canonical_existing(path) else {
        return false;
    };
    // PDF-1：PDF 是单文件书源，与压缩包同一边界（绝对路径、真实存在、
    // 不在系统/应用目录内）；其余普通文件仍然一律拒绝删除。
    if canon.is_file()
        && !crate::source::is_archive_path(&canon)
        && !crate::source::is_pdf_path(&canon)
    {
        return false;
    }
    if canon.parent().is_none() {
        return false;
    }
    if is_protected_source_path(
        &canon,
        &sensitive_system_dirs(),
        &sensitive_user_wide_dirs(),
        &sensitive_user_data_dirs(),
        &protected_app_roots(),
    ) {
        return false;
    }
    true
}

/// 删除源文件前的锚定校验：路径缺失不阻断“硬删记录”，
/// 但任何不安全目标都必须被拒绝，且不调用 remove_dir_all/remove_file。
fn validate_delete_target(path: &Path) -> Result<(), &'static str> {
    if !path.exists() {
        return Ok(());
    }
    if !is_safe_library_source_path(path) {
        return Err("sensitive-delete-target");
    }
    Ok(())
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
    // 数据库不可用必须显式失败；启动恢复门会阻止用户在坏库上改设置。
    res
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

    /// PDF-1：合法 PDF 应被识别并入库，format='pdf'，页数 0（PDF-1 无渲染器）。
    #[test]
    fn import_pdf_document_is_recognized_and_stored_with_pdf_format() {
        let dir = test_temp_dir("import-pdf");
        let db = dir.join("lib.db");
        let pdf = dir.join("漫画第一话.pdf");
        std::fs::write(&pdf, b"%PDF-1.7 header bytes").unwrap();

        let items = import_blocking(db.clone(), vec![pdf.to_string_lossy().to_string()]).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, "added", "message={}", items[0].message);
        let book = items[0].book.as_ref().expect("PDF 应返回书籍信息");
        assert_eq!(book.format, "pdf");
        assert_eq!(book.source_type, "local");
        assert_eq!(book.page_count, 0, "PDF-1 不解析页数");

        let conn = rusqlite::Connection::open(&db).unwrap();
        let row = db::get_book(&conn, &book.id).unwrap().expect("PDF 应入库");
        assert_eq!(row.format, db::BOOK_FORMAT_PDF);
        assert_eq!(row.path, pdf.to_string_lossy().to_string());
        assert_eq!(
            book.id,
            db::book_id_for_path(&pdf.to_string_lossy()),
            "PDF 书 id 必须仍是 sha256(path)"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 重新导入 / 重扫同一 PDF **不得**把已回写的页数清零。
    ///
    /// PDF 的真实页数由前端 PDF.js 解析后经 `set_book_page_count` 写回；
    /// 若导入分支把它写回 0，`clamp_reading_page` 就会退化成「完全不钳制」，
    /// 阅读位置失去上界。
    #[test]
    fn reimporting_a_pdf_keeps_the_known_page_count() {
        let dir = test_temp_dir("import-pdf-reimport");
        let db = dir.join("lib.db");
        let pdf = dir.join("漫画第一话.pdf");
        std::fs::write(&pdf, b"%PDF-1.7 header bytes").unwrap();

        // 首次导入：页数未知（0）。
        let items = import_blocking(db.clone(), vec![pdf.to_string_lossy().to_string()]).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, "added", "message={}", items[0].message);
        let id = items[0]
            .book
            .as_ref()
            .expect("PDF 应返回书籍信息")
            .id
            .clone();

        // 前端 PDF.js 解析后回写真实页数。
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            db::set_book_page_count(&conn, &id, 7).unwrap();
            let row = db::get_book(&conn, &id).unwrap().expect("PDF 应入库");
            assert_eq!(row.page_count, 7, "页数回写必须生效");
        }

        // 重新导入同一路径 → 页数必须仍是 7，格式仍是 pdf。
        let items = import_blocking(db.clone(), vec![pdf.to_string_lossy().to_string()]).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, "restored", "message={}", items[0].message);
        let conn = rusqlite::Connection::open(&db).unwrap();
        let row = db::get_book(&conn, &id).unwrap().expect("PDF 应仍在库");
        assert_eq!(row.page_count, 7, "重新导入不得清零已知页数");
        assert_eq!(row.format, db::BOOK_FORMAT_PDF);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// PDF-1：魔数不符的 .pdf 必须安全失败，且不得入库、不得被当成压缩包。
    #[test]
    fn import_malformed_pdf_fails_safely_without_creating_a_book() {
        let dir = test_temp_dir("import-bad-pdf");
        let db = dir.join("lib.db");

        // 1) 内容不是 PDF（伪装成 .pdf 的普通文本）。
        let fake = dir.join("fake.pdf");
        std::fs::write(&fake, b"this is not a pdf at all").unwrap();
        let items = import_blocking(db.clone(), vec![fake.to_string_lossy().to_string()]).unwrap();
        assert_eq!(items[0].status, "failed");
        assert!(
            items[0].message.contains("pdf-not-valid"),
            "message={}",
            items[0].message
        );
        assert!(items[0].book.is_none());

        // 2) 实际是 ZIP 但改了后缀：既不能当 PDF，也不能当压缩包入库。
        let disguised = dir.join("disguised.pdf");
        build_zip(&disguised);
        let items =
            import_blocking(db.clone(), vec![disguised.to_string_lossy().to_string()]).unwrap();
        assert_eq!(items[0].status, "failed");
        assert!(
            items[0].message.contains("pdf-not-valid"),
            "message={}",
            items[0].message
        );
        assert!(items[0].book.is_none());

        // 3) 失败不得留下任何书记录。
        let conn = rusqlite::Connection::open(&db).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "失败的 PDF 导入不得留下书记录");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// PDF-1 回归：既有 ZIP/CBZ 与图片文件夹导入行为不受影响，且 format 仍是 image。
    #[test]
    fn import_archives_and_folders_keep_image_format_after_pdf_introduction() {
        let dir = test_temp_dir("import-image-regression");
        let db = dir.join("lib.db");
        let zip = dir.join("book.zip");
        build_zip(&zip);
        let cbz = dir.join("book.cbz");
        build_zip(&cbz);
        let folder = dir.join("folder");
        std::fs::create_dir_all(&folder).unwrap();
        tiny_png(&folder.join("p1.png"));

        let items = import_blocking(
            db.clone(),
            vec![
                zip.to_string_lossy().to_string(),
                cbz.to_string_lossy().to_string(),
                folder.to_string_lossy().to_string(),
            ],
        )
        .unwrap();
        assert_eq!(items.len(), 3);
        for item in &items {
            assert_eq!(item.status, "added", "message={}", item.message);
            let book = item.book.as_ref().expect("应有书籍信息");
            assert_eq!(book.format, "image", "既有书源格式必须保持 image");
        }

        let conn = rusqlite::Connection::open(&db).unwrap();
        let formats: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT format FROM books ORDER BY id")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(formats.len(), 3);
        assert!(formats.iter().all(|f| f == "image"));

        std::fs::remove_dir_all(&dir).ok();
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

    #[test]
    fn delete_target_guard_rejects_sensitive_and_non_archive_paths() {
        let dir = test_temp_dir("delete-guard");
        let book_dir = dir.join("book");
        std::fs::create_dir_all(&book_dir).unwrap();
        assert!(
            validate_delete_target(&book_dir).is_ok(),
            "普通书目录应允许"
        );
        assert!(is_safe_library_source_path(&book_dir));

        let archive = dir.join("book.cbz");
        std::fs::write(&archive, b"cbz").unwrap();
        assert!(validate_delete_target(&archive).is_ok());
        assert!(is_safe_library_source_path(&archive));

        let text = dir.join("notes.txt");
        std::fs::write(&text, b"text").unwrap();
        assert!(
            validate_delete_target(&text).is_err(),
            "非压缩包文件绝不能进入 remove_file"
        );
        assert!(!is_safe_library_source_path(&text));

        // 缺失路径允许硬删记录，但不会产生删除动作。
        assert!(validate_delete_target(&dir.join("gone.cbz")).is_ok());

        if let Some(home) = dirs::home_dir() {
            assert!(
                validate_delete_target(&home).is_err(),
                "用户主目录本身必须拒绝"
            );
            assert!(!is_safe_library_source_path(&home));
        }
        if let Some(docs) = dirs::document_dir().filter(|path| path.exists()) {
            assert!(
                validate_delete_target(&docs).is_err(),
                "用户文档目录本身必须拒绝"
            );
        }
        assert!(!is_safe_library_source_path(Path::new(
            "relative/manga.cbz"
        )));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn protected_source_path_rejects_ancestors_and_appdata_descendants() {
        let base = test_temp_dir("protected-source");
        let appdata = base.join("AppData");
        let roaming = appdata.join("Roaming");
        let other_app = roaming.join("OtherApp");
        let books = base.join("Books");
        let volume = books.join("vol1");
        std::fs::create_dir_all(&other_app).unwrap();
        std::fs::create_dir_all(&volume).unwrap();

        let data_dirs = std::slice::from_ref(&roaming);
        assert!(
            is_protected_source_path(&appdata, &[], &[], data_dirs, &[]),
            "AppData 是 Roaming 的祖先，必须拒绝"
        );
        let app_roots = std::slice::from_ref(&roaming);
        assert!(
            is_protected_source_path(&other_app, &[], &[], &[], app_roots),
            "应用数据根下的其它目录必须拒绝"
        );
        assert!(
            !is_protected_source_path(&books, &[], &[], data_dirs, app_roots),
            "普通书库不得被误判"
        );

        let wide_dirs = std::slice::from_ref(&books);
        assert!(
            is_protected_source_path(&base, &[], wide_dirs, &[], &[]),
            "宽目录的祖先必须拒绝"
        );
        assert!(
            !is_protected_source_path(&volume, &[], wide_dirs, &[], &[]),
            "宽目录的子目录必须允许"
        );
        std::fs::remove_dir_all(&base).ok();
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

    #[cfg(unix)]
    #[test]
    fn non_utf8_book_path_is_rejected_instead_of_lossy_collision() {
        use std::os::unix::ffi::OsStringExt as _;

        let dir = test_temp_dir("non-utf8");
        let mut name = b"bad-".to_vec();
        name.push(0xFF);
        name.extend_from_slice(b".cbz");
        let path = dir.join(std::ffi::OsString::from_vec(name));
        build_zip(&path);

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        let error = scan_single_book(&conn, &path).unwrap_err().to_string();
        assert!(error.contains("non-utf8-path"), "{error}");
        assert!(db::list_books(&conn, None).unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unchanged_archive_skips_rescan_and_changed_file_reopens() {
        use std::io::Write as _;

        let dir = test_temp_dir("stamp");
        let path = dir.join("incremental.cbz");
        build_zip(&path);
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();

        let first = scan_single_book(&conn, &path).unwrap();
        assert_eq!(first.page_count, 1);

        let meta = std::fs::symlink_metadata(&path).unwrap();
        let original_modified = meta.modified().unwrap();
        let len = meta.len() as usize;
        // 同长度垃圾字节 + 恢复原 mtime：指纹不变，扫描必须跳过解包。
        {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .unwrap();
            file.write_all(&vec![b'x'; len]).unwrap();
            file.set_modified(original_modified).unwrap();
        }
        let second = scan_single_book(&conn, &path).expect("指纹未变时不得重新解包");
        assert_eq!(second.page_count, 1);
        assert_eq!(second.id, first.id);

        // mtime 变化后必须重新打开；此时文件已是垃圾，应失败并清掉指纹。
        {
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(original_modified + std::time::Duration::from_secs(5))
                .unwrap();
        }
        assert!(scan_single_book(&conn, &path).is_err());
        assert_eq!(db::source_stamp(&conn, &first.id).unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn import_dedupes_windows_path_variants() {
        let dir = test_temp_dir("win-path-dedupe");
        let book = dir.join("CaseTest.cbz");
        build_zip(&book);
        let db = dir.join("lib.db");

        let first = import_blocking(db.clone(), vec![book.to_string_lossy().into()]).unwrap();
        assert_eq!(first[0].status, "added");
        // 同一文件：正斜杠 + 全大写（Windows 大小写不敏感）。
        let variant = book.to_string_lossy().replace('\\', "/").to_uppercase();
        let second = import_blocking(db.clone(), vec![variant]).unwrap();
        assert_eq!(second[0].status, "restored", "路径变体不得重复建书");
        let conn = db::open(db).unwrap();
        assert_eq!(db::list_books(&conn, None).unwrap().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
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
            format: db::BOOK_FORMAT_IMAGE.into(),
        };
        assert!(to_book_info(local).webtoon_ready);

        let online = db::BookRow {
            id: "o".into(), path: "http://x/a".into(), title: "O".into(),
            page_count: 2, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200},{"url":"http://x/2.jpg"}]}"#.into(),
            format: db::BOOK_FORMAT_IMAGE.into(),
        };
        // 缺尺寸不再永久关闭条漫：进入条漫时按页探测并回写。
        assert!(to_book_info(online).webtoon_ready);

        let online_ok = db::BookRow {
            id: "o2".into(), path: "http://x/b".into(), title: "O2".into(),
            page_count: 1, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200}]}"#.into(),
            format: db::BOOK_FORMAT_IMAGE.into(),
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
            format: db::BOOK_FORMAT_IMAGE.into(),
        };
        assert!(!to_book_info(corrupt).webtoon_ready);
    }

    #[test]
    fn online_source_path_is_never_deleted() {
        let url = "https://example.com/gallery/1";
        assert!(!delete_source_if_local(url, "generic_manga").unwrap());
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
    fn apply_resolved_meta_keeps_progress_and_rejects_page_drop() {
        let st = online_state();
        let old = online_meta("https://example.com/gallery/4", "旧", "h1", pages(5));
        let (row, _) = apply_resolved_meta(&st, &old).expect("首次入库");
        let id = row.id;
        st.db
            .with(|conn| db::set_progress(conn, &id, 4, None).map_err(|e| e.to_string()))
            .expect("写入进度");

        // 页数不变的变化：进度保留。
        let same_len = online_meta("https://example.com/gallery/4", "新", "h2", pages(5));
        let (row, changed) = apply_resolved_meta(&st, &same_len).expect("清单变化应更新");
        assert!(changed);
        assert_eq!(row.title, "新");
        assert_eq!(row.current_page, 4, "页数未缩小时进度应保留");

        // 页数缩小：拒绝覆盖，旧清单与进度原样保留。
        let shorter = online_meta("https://example.com/gallery/4", "新", "h3", pages(2));
        let err = apply_resolved_meta(&st, &shorter).expect_err("页数骤降应拒绝");
        assert!(err.to_string().contains("online-page-count-drop"), "{err}");
        let preserved = st
            .db
            .with(|conn| db::get_book(conn, &id).map_err(|e| e.to_string()))
            .unwrap()
            .expect("旧书仍在");
        assert_eq!(preserved.page_count, 5);
        assert_eq!(preserved.current_page, 4, "拒绝覆盖时进度不得被钳制");
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
            format: db::BOOK_FORMAT_IMAGE.into(),
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

        let row = relocate_book_impl(&conn, &book.id, &new_path.to_string_lossy()).unwrap();
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

    /* ---------------- PDF-2：封面缓存与页数回写 ---------------- */

    /// 极小 JPEG（2×2）：走真实的 jpeg 编码器，保证魔数与尺寸都真实。
    fn tiny_jpeg() -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut buf)
            .write_image(
                &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
                2,
                2,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        buf
    }

    /// 带内存库与独立渲染缓存根的 AppState（绝不碰真实用户缓存目录）。
    fn pdf_test_state(tag: &str) -> (Arc<AppState>, PathBuf) {
        let dir = test_temp_dir(tag);
        let mut state = AppState::new();
        state.render = crate::render_cache::RenderCache::new(dir.join("render_cache"));
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        state.db.set(conn);
        (Arc::new(state), dir)
    }

    /// 非 JPEG 字节与超限载荷一律拒绝；合法 JPEG 能落缓存并原样读回。
    ///
    /// 写回**只收 JPEG**：L2 缓存文件名固定 `.jpg`，PNG 会被 `RenderCache::get`
    /// 当成坏缓存删掉，等于静默丢封面（详见 `pdf::validate_pdf_cover` 的注释）。
    #[test]
    fn pdf_cover_rejects_non_image_bytes_and_oversized_payloads() {
        let (state, dir) = pdf_test_state("pdf-cover");
        let book = "p1";

        // 任意字节不得进入缓存。
        let err = store_pdf_cover(&state, book, b"not-an-image-at-all")
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // PNG 也不得写回（读取路径才容忍历史 PNG）。
        let png = crate::pdf::fixtures::png_header(256, 256);
        let err = store_pdf_cover(&state, book, &png).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // 超限（> 2 MiB）。
        let oversized = vec![0xFFu8; pdf::MAX_PDF_COVER_BYTES + 1];
        let err = store_pdf_cover(&state, book, &oversized)
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-too-large"), "got: {err}");

        // 空字节。
        let err = store_pdf_cover(&state, book, &[]).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // 合法 JPEG → 写入固定边长的第 0 页，并能原样读回。
        let jpeg = tiny_jpeg();
        store_pdf_cover(&state, book, &jpeg).unwrap();
        let stored = state
            .render
            .get_raw(book, 0, pdf::PDF_COVER_EDGE, pdf::PDF_COVER_EDGE)
            .expect("封面必须落在固定边长的第 0 页");
        assert_eq!(stored, jpeg, "封面字节必须原样落盘");
        // 其它边长读不到（固定边长是唯一键）。
        assert!(state.render.get_raw(book, 0, 240, 240).is_none());

        // 读回后能解析尺寸并组装成 PageImage。
        let page = pdf_cover_page(stored).unwrap();
        assert_eq!(page.mime, "image/jpeg");
        assert_eq!(page.width, 2);
        assert_eq!(page.height, 2);
        assert!(page.data_url.starts_with("data:image/jpeg;base64,"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 封面必须**受尺寸边界约束**（AGENTS.md §4.5：单边 ≤4096px、面积 ≤16Mpx）。
    ///
    /// 一张 30000×30000 的压缩图只有几十 KB，字节数闸门拦不住；
    /// 写入与读取两侧都要被尺寸边界拦下，否则会被反复 base64 送进前端。
    #[test]
    fn pdf_cover_dimensions_are_bounded_on_write_and_read() {
        let (state, dir) = pdf_test_state("pdf-cover-dims");

        // 写入：一张「声称 30000×30000」的 JPEG 必须被尺寸边界拦下。
        let huge_jpeg = crate::pdf::fixtures::jpeg_header(30_000, 30_000);
        let err = store_pdf_cover(&state, "p1", &huge_jpeg)
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");

        // 读取：历史 PNG 缓存同样要过尺寸边界（否则每次读缩略图都被整张送出去）。
        let huge_png = crate::pdf::fixtures::png_header(30_000, 30_000);
        let err = pdf_cover_page(huge_png).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");

        // 读取：合法 PNG 仍然可读（老版本可能写进来过）。
        let ok_png = crate::pdf::fixtures::png_header(256, 256);
        let page = pdf_cover_page(ok_png).expect("合法 PNG 封面应可读");
        assert_eq!(page.mime, "image/png");
        assert_eq!(page.width, 256);
        assert_eq!(page.height, 256);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 封面解码失败必须带稳定码 `pdf-cover-invalid`（非中文界面靠它本地化）。
    #[test]
    fn pdf_cover_decode_failure_carries_stable_code() {
        // 魔数是 JPEG，但段链不合法 → 解码失败。
        let broken = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02];
        let err = pdf_cover_page(broken).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
        assert!(
            err.trim_end().ends_with("（pdf-cover-invalid）"),
            "稳定码必须在文案末尾：{err}"
        );

        // PNG 头部损坏同样收敛到稳定码。
        let mut broken_png = crate::pdf::fixtures::png_header(256, 256);
        broken_png[12..16].copy_from_slice(b"IDAT");
        let err = pdf_cover_page(broken_png).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
        assert!(
            err.trim_end().ends_with("（pdf-cover-invalid）"),
            "稳定码必须在文案末尾：{err}"
        );
    }

    /// PDF 封面缺失时必须返回稳定错误码 `pdf-cover-missing`（前端据此生成封面）。
    #[tokio::test]
    async fn pdf_thumbnail_reports_missing_cover_with_stable_code() {
        let (state, dir) = pdf_test_state("pdf-thumb-missing");
        state
            .db
            .with(|conn| {
                db::upsert_book_with_format(
                    conn,
                    "p1",
                    "C:/Books/Comic.pdf",
                    "Comic",
                    0,
                    db::BOOK_FORMAT_PDF,
                )
                .map_err(err)
            })
            .unwrap();

        let error = pdf_thumbnail(&state, "p1").await.unwrap_err();
        assert!(
            error.contains("pdf-cover-missing"),
            "PDF 缺封面必须给出稳定码：{error}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 写入封面后 `pdf_thumbnail` 能读回同一张图（固定边长，max_size 无关）。
    #[tokio::test]
    async fn pdf_thumbnail_reads_back_the_stored_cover() {
        let (state, dir) = pdf_test_state("pdf-thumb-hit");
        let jpeg = tiny_jpeg();
        store_pdf_cover(&state, "p1", &jpeg).unwrap();

        let page = pdf_thumbnail(&state, "p1").await.expect("封面应可读回");
        assert_eq!(page.index, 0);
        assert_eq!(page.width, 2);
        assert_eq!(page.height, 2);
        assert_eq!(page.mime, "image/jpeg");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// base64 解码宽容：标准填充与无填充都能解，非法输入返回 None。
    #[test]
    fn base64_decoding_is_lenient_but_rejects_garbage() {
        let payload = b"%PDF-1.7";
        let encoded = B64.encode(payload);
        assert_eq!(decode_base64_lenient(&encoded).unwrap(), payload.to_vec());
        assert_eq!(
            decode_base64_lenient(encoded.trim_end_matches('=')).unwrap(),
            payload.to_vec(),
            "无填充变体也必须能解"
        );
        assert!(decode_base64_lenient("   ").is_none());
        assert!(decode_base64_lenient("not base64!!").is_none());
    }

    /// 阅读位置钳制：图片书照常钳制；PDF 在页数尚未回写时不得压成第 1 页。
    #[test]
    fn reading_page_clamp_keeps_pdf_position_until_page_count_is_known() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        db::upsert_book(&conn, "b1", "p/b1", "图片书", 10).unwrap();
        db::upsert_book_with_format(&conn, "p1", "p/p1.pdf", "PDF 书", 0, db::BOOK_FORMAT_PDF)
            .unwrap();

        let image = db::get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(clamp_reading_page(&image, 3), 3);
        assert_eq!(clamp_reading_page(&image, 99), 9, "图片书必须钳到最后一页");

        // PDF：页数未知 → 原样保留（否则恢复位置会被压成 0）。
        let pdf = db::get_book(&conn, "p1").unwrap().unwrap();
        assert_eq!(clamp_reading_page(&pdf, 3), 3);

        // PDF：页数未知时仍须有上界——无效页位不得无限期存在，
        // 否则 `reading_log` 的当日增量会被放大。
        assert_eq!(
            clamp_reading_page(&pdf, u32::MAX),
            crate::pdf::MAX_PDF_PAGE_COUNT,
            "页数未知时也必须钳到 PDF 页数上界"
        );

        // PDF：页数补齐后 → 照常钳制。
        db::set_book_page_count(&conn, "p1", 4).unwrap();
        let pdf = db::get_book(&conn, "p1").unwrap().unwrap();
        assert_eq!(clamp_reading_page(&pdf, 3), 3);
        assert_eq!(clamp_reading_page(&pdf, 99), 3, "页数已知后必须钳制");
    }
}
