//! 通用内嵌浏览器窗口与下载导入。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::TimeZone;
use tauri::utils::config::WebviewUrl;
use tauri::webview::{DownloadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::commands;
use crate::db;
use crate::AppState;

const BROWSER_LABEL: &str = "browser";
const BROWSER_TITLE: &str = "MangaReader 浏览器";
const BROWSER_WIDTH: f64 = 1200.0;
const BROWSER_HEIGHT: f64 = 820.0;

/// 下载文件名长度上限（保留扩展名后按字符截断）。
const MAX_DOWNLOAD_FILENAME_CHARS: usize = 120;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserDownload {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub imported: bool,
}

fn validate_browser_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅支持 http/https URL".into());
    }
    Ok(url)
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

fn clean_filename_part(part: &str) -> String {
    part.chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        .collect()
}

fn sanitize_download_filename(raw: &str) -> String {
    let (stem, ext) = split_extension(raw.trim());
    let mut stem = clean_filename_part(stem)
        .trim_matches(|c| c == ' ' || c == '.')
        .to_string();
    let ext = clean_filename_part(ext)
        .trim_matches(|c| c == ' ' || c == '.')
        .to_string();
    if stem.is_empty() {
        stem = "download".into();
    }
    let suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let max_stem = MAX_DOWNLOAD_FILENAME_CHARS
        .saturating_sub(suffix.chars().count())
        .max(1);
    let mut stem: String = stem.chars().take(max_stem).collect();
    stem = stem.trim_end_matches(|c| c == ' ' || c == '.').to_string();
    if stem.is_empty() {
        stem = "download".into();
    }
    format!("{stem}{suffix}")
}

fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = split_extension(filename);
    for i in 1u32.. {
        let suffix = format!(" ({i})");
        let name = if ext.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{ext}")
        };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
    }
    unreachable!("文件名后缀空间耗尽")
}

fn url_download_name(url: &Url) -> Option<String> {
    let last = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .last()?;
    Some(
        percent_encoding::percent_decode_str(last)
            .decode_utf8_lossy()
            .to_string(),
    )
}

fn prepare_download_destination(
    downloads_dir: &Path,
    url: &Url,
    suggested: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(downloads_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    let raw = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .or_else(|| url_download_name(url))
        .unwrap_or_else(|| "download".into());
    Ok(unique_download_path(
        downloads_dir,
        &sanitize_download_filename(&raw),
    ))
}

fn is_importable_download(path: &Path) -> bool {
    crate::source::is_archive_path(path)
}

fn simplify_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn normalize_existing_path(path: &Path) -> Result<PathBuf, std::io::Error> {
    Ok(simplify_path(std::fs::canonicalize(path)?))
}

fn is_within(root: &Path, path: &Path) -> bool {
    match (normalize_existing_path(root), normalize_existing_path(path)) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

fn downloads_dir() -> Result<PathBuf, String> {
    let dir = crate::data_dir()?.join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    normalize_existing_path(&dir).map_err(|e| format!("定位下载目录失败：{e}"))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadEvent {
    path: String,
    name: String,
    imported: bool,
    book_id: Option<String>,
}

fn finish_download(app: AppHandle, path: PathBuf) {
    let path = normalize_existing_path(&path).unwrap_or(path);
    let within_downloads = downloads_dir()
        .ok()
        .is_some_and(|dir| is_within(&dir, &path));
    let imported = if within_downloads && is_importable_download(&path) {
        let db_path = app.state::<Arc<AppState>>().db_path();
        match commands::import_local_archive(db_path, &path) {
            Ok(book_id) => {
                if book_id.is_some() {
                    if let Err(e) = commands::set_file_readonly(&path) {
                        crate::logging::log_error(
                            "browser_import",
                            &format!("设置只读失败 {}：{e}", path.display()),
                        );
                    }
                }
                book_id
            }
            Err(e) => {
                crate::logging::log_error(
                    "browser_import",
                    &format!("导入下载失败 {}：{e}", path.display()),
                );
                None
            }
        }
    } else {
        None
    };

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();
    let payload = BrowserDownloadEvent {
        path: path.to_string_lossy().to_string(),
        name,
        imported: imported.is_some(),
        book_id: imported,
    };
    if let Err(e) = app.emit_to("main", "browser-download", &payload) {
        crate::logging::log_error("browser_download", &format!("发送下载事件失败：{e}"));
    }
}

fn handle_download_event(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let result = downloads_dir()
                .and_then(|dir| prepare_download_destination(&dir, &url, destination));
            match result {
                Ok(path) => {
                    *destination = path;
                    true
                }
                Err(e) => {
                    crate::logging::log_error("browser_download", &format!("准备下载失败：{e}"));
                    false
                }
            }
        }
        DownloadEvent::Finished {
            path: Some(path),
            success: true,
            ..
        } => {
            let app = app.clone();
            std::thread::spawn(move || finish_download(app, path));
            true
        }
        _ => true,
    }
}

/// 浏览器窗导航白名单：只允许 http/https，且**禁止跳回应用自身的本地源**。
///
/// 内嵌浏览器加载的是远程页面；一旦远程页自跳到 `tauri.localhost`（或开发态的
/// `localhost:1420`），它就会变成「本地 Origin」，从而可能拿到该窗口的本地能力。
/// 这里在导航层直接拦掉，避免远程页借导航提权。
fn navigation_allowed(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "tauri.localhost" || host.ends_with(".tauri.localhost") {
        return false;
    }
    // 开发态应用源（Vite dev server）同样禁止：远程页跳到它就等于拿到应用 Origin。
    if (host == "localhost" || host == "127.0.0.1" || host == "[::1]") && url.port() == Some(1420)
    {
        return false;
    }
    true
}

#[tauri::command]
pub async fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    crate::resilience::ensure_online_allowed()?;
    let url = validate_browser_url(&url)?;
    if let Some(window) = app.get_webview_window(BROWSER_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        window.navigate(url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // WebView 构建不能占住 async IPC 线程/主事件循环；移到阻塞池。
    tauri::async_runtime::spawn_blocking(move || {
        let download_app = app.clone();
        WebviewWindowBuilder::new(&app, BROWSER_LABEL, WebviewUrl::External(url))
            .title(BROWSER_TITLE)
            .inner_size(BROWSER_WIDTH, BROWSER_HEIGHT)
            .on_download(move |_webview, event| handle_download_event(&download_app, event))
            .on_navigation(|target| navigation_allowed(&target))
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("浏览器窗口任务失败：{e}"))?
}

#[tauri::command]
pub fn navigate_browser(app: AppHandle, url: String) -> Result<(), String> {
    crate::resilience::ensure_online_allowed()?;
    let url = validate_browser_url(&url)?;
    let window = app
        .get_webview_window(BROWSER_LABEL)
        .ok_or_else(|| "浏览器窗口未打开".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_browser_downloads(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BrowserDownload>, String> {
    let dir = downloads_dir()?;
    collect_downloads(&dir, |path| {
        let id = db::book_id_for_path(path);
        state
            .db
            .with(|conn| {
                db::get_book(conn, &id)
                    .map(|book| book.is_some())
                    .map_err(|e| e.to_string())
            })
            .unwrap_or(false)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_browser_download(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<Option<String>, String> {
    let downloads = downloads_dir()?;
    let candidate =
        normalize_existing_path(Path::new(&path)).map_err(|e| format!("下载文件不存在：{e}"))?;
    if !is_within(&downloads, &candidate) || !candidate.is_file() {
        return Err("只能导入下载目录中的文件".into());
    }
    if !is_importable_download(&candidate) {
        return Ok(None);
    }

    let db_path = state.db_path();
    let import_path = candidate.clone();
    let book_id =
        commands::blocking(move || commands::import_local_archive(db_path, &import_path)).await?;
    if book_id.is_some() {
        if let Err(e) = commands::set_file_readonly(&candidate) {
            crate::logging::log_error(
                "browser_import",
                &format!("设置只读失败 {}：{e}", candidate.display()),
            );
        }
    }
    Ok(book_id)
}

fn collect_downloads(
    dir: &Path,
    is_imported: impl Fn(&str) -> bool,
) -> Result<Vec<BrowserDownload>, std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        let path = path.to_string_lossy().into_owned();
        let modified_secs = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let modified = chrono::Local
            .timestamp_opt(modified_secs as i64, 0)
            .single()
            .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default();
        rows.push((
            modified_secs,
            BrowserDownload {
                imported: is_imported(&path),
                path,
                name: entry.file_name().to_string_lossy().into_owned(),
                size: metadata.len(),
                modified,
            },
        ));
    }
    rows.sort_by(|(a_secs, a), (b_secs, b)| b_secs.cmp(a_secs).then_with(|| a.name.cmp(&b.name)));
    Ok(rows.into_iter().map(|(_, row)| row).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn navigation_blocks_app_local_origins_and_non_http() {
        for raw in [
            "http://tauri.localhost/index.html",
            "https://sub.tauri.localhost/x",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "file:///c:/windows/system32/calc.exe",
            "tauri://localhost",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(raw).expect("URL 应可解析");
            assert!(!navigation_allowed(&url), "{raw} 必须被拦截");
        }
        for raw in [
            "https://example.com/a",
            "http://127.0.0.1:18080/pair", // 配对桥接的回环页必须放行
        ] {
            let url = Url::parse(raw).expect("URL 应可解析");
            assert!(navigation_allowed(&url), "{raw} 应被放行");
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mr-browser-{}-{tag}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn validates_only_http_and_https() {
        assert!(validate_browser_url("https://example.com/a").is_ok());
        assert!(validate_browser_url(" http://example.com ").is_ok());
        for raw in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/a",
            "not a url",
        ] {
            assert!(validate_browser_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn sanitizes_separators_controls_and_preserves_extension() {
        assert_eq!(sanitize_download_filename("a/b\\c\x00d?.zip"), "abcd.zip");
        assert_eq!(sanitize_download_filename("book.CBZ"), "book.CBZ");
        assert_eq!(sanitize_download_filename("\x00/\\"), "download");
        assert_eq!(sanitize_download_filename("   "), "download");
    }

    #[test]
    fn limits_length_without_dropping_extension() {
        let raw = format!("{}.cbz", "长".repeat(300));
        let name = sanitize_download_filename(&raw);
        assert!(name.ends_with(".cbz"), "{name}");
        assert!(
            name.chars().count() <= MAX_DOWNLOAD_FILENAME_CHARS,
            "{}",
            name.chars().count()
        );
    }

    #[test]
    fn destination_is_inside_download_dir_and_never_overwrites() {
        let dir = temp_dir("dest");
        let original = dir.join("book.zip");
        std::fs::write(&original, b"keep").unwrap();

        let url = url::Url::parse("https://example.com/files/book.zip").unwrap();
        let first = prepare_download_destination(
            &dir,
            &url,
            Path::new("C:/Users/alice/Downloads/book.zip"),
        )
        .unwrap();
        assert_eq!(first, dir.join("book (1).zip"));
        assert!(first.is_absolute());
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");

        std::fs::write(&first, b"one").unwrap();
        let second = prepare_download_destination(
            &dir,
            &url,
            Path::new("C:/Users/alice/Downloads/book.zip"),
        )
        .unwrap();
        assert_eq!(second, dir.join("book (2).zip"));
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn destination_falls_back_to_url_filename() {
        let dir = temp_dir("fallback");
        let url = url::Url::parse("https://example.com/files/fallback.cbz?x=1").unwrap();
        let path = prepare_download_destination(&dir, &url, Path::new("")).unwrap();
        assert_eq!(path, dir.join("fallback.cbz"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn routes_only_zip_and_cbz_to_import() {
        for name in ["a.zip", "a.cbz", "A.ZIP", "A.CBZ"] {
            assert!(is_importable_download(Path::new(name)), "{name}");
        }
        for name in ["a.png", "a.jpg", "a.txt", "a"] {
            assert!(!is_importable_download(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn normalizes_paths_for_containment_checks() {
        let dir = temp_dir("normalize");
        let inside = dir.join("a.zip");
        std::fs::write(&inside, b"zip").unwrap();
        let normalized = normalize_existing_path(&inside).unwrap();
        assert!(normalized.is_absolute());
        #[cfg(windows)]
        assert!(
            !normalized.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            normalized.display()
        );
        assert!(is_within(&dir, &inside));

        let outside_dir = temp_dir("normalize-outside");
        let outside = outside_dir.join("b.zip");
        std::fs::write(&outside, b"zip").unwrap();
        assert!(!is_within(&dir, &outside));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn collects_downloads_with_import_state() {
        let dir = temp_dir("list");
        std::fs::write(dir.join("a.zip"), b"zip").unwrap();
        std::fs::write(dir.join("b.png"), b"image!").unwrap();

        let rows = collect_downloads(&dir, |path| path.ends_with("a.zip")).unwrap();
        assert_eq!(rows.len(), 2);

        let a = rows.iter().find(|r| r.name == "a.zip").unwrap();
        assert_eq!(a.size, 3);
        assert!(a.imported);
        assert!(!a.modified.is_empty());
        assert!(a.modified.contains('-'), "{}", a.modified);
        assert_eq!(a.path, dir.join("a.zip").to_string_lossy().to_string());

        let b = rows.iter().find(|r| r.name == "b.png").unwrap();
        assert_eq!(b.size, 6);
        assert!(!b.imported);

        std::fs::remove_dir_all(&dir).ok();
    }
}
