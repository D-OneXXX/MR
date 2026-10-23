//! Local-only diagnostics collection, sanitization and Markdown export.
//!
//! Raw frontend errors, breadcrumbs and backend logs live only in bounded
//! process memory. Every value is sanitized before it leaves the backend;
//! nothing in this module performs network I/O.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use chrono::{Local, SecondsFormat};
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::AppState;

const MAX_ERRORS: usize = 30;
const MAX_BREADCRUMBS: usize = 20;
const MAX_ERROR_MESSAGE: usize = 8 * 1024;
const MAX_STACK: usize = 24 * 1024;
const MAX_ROUTE: usize = 512;
const MAX_EXPORT_BYTES: usize = 2 * 1024 * 1024;

const KNOWN_SOURCES: &[&str] = &[
    "window.error",
    "unhandledrejection",
    "console.error",
    "error-boundary",
];
const KNOWN_KINDS: &[&str] = &[
    "navigation",
    "readerMode",
    "archiveImport",
    "folderImport",
    "onlineRead",
    "settingsChange",
    "themeChange",
    "localeChange",
    "onlinePairing",
    "recovery",
    "safeMode",
    "update",
    "privacy",
    "readerPage",
    "other",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRuntime {
    pub version: String,
    pub build_baseline: String,
    pub os: String,
    pub arch: String,
    pub route: Option<String>,
    pub reader_mode: Option<String>,
    pub reader_page: Option<u32>,
    /// `direct` or `proxy`; never the proxy host or credentials.
    pub network_mode: String,
    pub proxy_scheme: Option<String>,
    pub online_enabled: bool,
    pub safe_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticError {
    pub at: String,
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBreadcrumb {
    pub at: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundle {
    pub generated_at: String,
    pub runtime: DiagnosticRuntime,
    pub breadcrumbs: Vec<DiagnosticBreadcrumb>,
    pub errors: Vec<DiagnosticError>,
    pub logs: Vec<crate::logging::LogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendErrorInput {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreadcrumbInput {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContextInput {
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub reader_mode: Option<String>,
    #[serde(default)]
    pub reader_page: Option<u32>,
    #[serde(default)]
    pub safe_mode: Option<bool>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeContext {
    route: Option<String>,
    reader_mode: Option<String>,
    reader_page: Option<u32>,
    safe_mode: bool,
}

fn errors_slot() -> &'static Mutex<Vec<DiagnosticError>> {
    static SLOT: OnceLock<Mutex<Vec<DiagnosticError>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Vec::new()))
}

fn breadcrumbs_slot() -> &'static Mutex<Vec<DiagnosticBreadcrumb>> {
    static SLOT: OnceLock<Mutex<Vec<DiagnosticBreadcrumb>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Vec::new()))
}

fn context_slot() -> &'static Mutex<RuntimeContext> {
    static SLOT: OnceLock<Mutex<RuntimeContext>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(RuntimeContext::default()))
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

fn bounded(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let boundary = (0..=max)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    text.truncate(boundary);
    text.push_str("…");
    text
}

fn normalize_kind(raw: &str) -> String {
    let trimmed = raw.trim();
    if KNOWN_KINDS.iter().any(|kind| *kind == trimmed) {
        trimmed.to_string()
    } else {
        "other".to_string()
    }
}

fn normalize_source(raw: &str) -> String {
    let trimmed = raw.trim();
    if KNOWN_SOURCES.iter().any(|source| *source == trimmed) {
        trimmed.to_string()
    } else {
        "other".to_string()
    }
}

fn mode_allowlist(raw: &str) -> Option<String> {
    match raw.trim() {
        "single" | "double" | "webtoon" => Some(raw.trim().to_string()),
        _ => None,
    }
}

/// Route shown in the UI/prompt: no query/fragment/book id/user path.
pub fn display_route(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut path = trimmed;
    let parsed_path: String;
    if path.starts_with("http://") || path.starts_with("https://") {
        if let Ok(url) = Url::parse(path) {
            parsed_path = url.path().to_string();
            path = &parsed_path;
        }
    }
    path = path.trim_start_matches('#');
    path = path.split(['?', '#']).next().unwrap_or(path);
    if !path.starts_with('/') {
        path = match path {
            "reader" => "/reader",
            "settings" => "/settings",
            "browser" => "/browser",
            _ => "/",
        };
    }
    let normalized = if path.starts_with("/reader/") {
        "/reader/:id".to_string()
    } else {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    };
    Some(bounded(normalized, MAX_ROUTE))
}

// ---------- Sanitizer ----------

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static sanitizer regex must compile"))
}

fn header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?im)(?P<lead>^|[\s{,;])(?P<header>proxy-authorization|authorization|cookie|set-cookie|x-api-key|api-key)[ \t]*(?P<sep>:[ \t]*)[^\r\n]*",
    )
}

fn key_value_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r#"(?i)(?P<lead>^|[^A-Za-z0-9_])(?P<quote>["']?)(?P<key>access_token|refresh_token|session_token|sessionid|api_key|apikey|password|passwd|signature|secret|token|session|auth|sig|cookie|authorization|x-api-key)(?P<close>["']?)(?P<sep>\s*[:=]\s*)(?P<val>"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&)\]}]+)"#,
    )
}

fn bearer_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"(?i)\b(?P<kind>bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}",
    )
}

fn jwt_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    )
}

fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r#"(?i)\bhttps?://[^\s<>"'`]+"#)
}

fn url_token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, "\u{e000}(\\d+)\u{e001}")
}

fn windows_home_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        r#"(?i)[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\r\n<>"']+[\\/]?"#,
    )
}

fn unix_home_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // `/run/media/<username>/`：Linux 桌面自动挂载的可移动介质/外置盘，
    // 用户名同样是可识别个人身份的信息，与 `/home/` 同级脱敏。
    regex(&RE, r#"(?:/home/|/Users/|/run/media/)[^/\s"'<>]+/?"#)
}

/// `/mnt/<挂载名>/`：挂载点名称（NAS 共享名、分区标签）可能暴露
/// 用户的存储习惯，整段折叠为 `<MOUNT>/`，保留“位于挂载盘”这一语义。
fn unix_mount_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r#"/mnt/[^/\s"'<>]+/?"#)
}

const MANGA_EXTENSIONS: &str = "cbz|zip|cbr|cbt|rar|7z|pdf|jpe?g|png|webp|avif|gif|bmp";
fn manga_pattern(body: &str) -> String {
    format!(r#"(?i){body}[^\r\n\t"'<>|?*:]*?\.(?:{MANGA_EXTENSIONS})\b"#)
}

fn win_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, &manga_pattern(r"[A-Za-z]:[\\/]"))
}

fn unc_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, &manga_pattern(r"\\\\"))
}

/// `<USER_HOME>/` / `<MOUNT>/` 前缀后再接漫画文件的路径：前缀替换完成后，
/// 剩余目录链继续折叠（`<…>/<MANGA_DIR>/<MANGA_FILE>.ext`）。
fn home_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, &manga_pattern(r"<(?:USER_HOME|MOUNT)>[\\/]"))
}

fn unix_abs_path_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        &format!(r#"(?m)(?:^|[\s("'`])(/[^\r\n\t"'<>|?*:]*?)\.(?:{MANGA_EXTENSIONS})\b"#),
    )
}

fn bare_file_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(
        &RE,
        &format!(
            r#"(?i)(?:^|(?P<lead>[\s("'=,;:<>]))(?P<file>[^\s\\/"'<>|:*?]+\.(?:{MANGA_EXTENSIONS})\b)"#
        ),
    )
}

fn sensitive_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "session"
            | "session_token"
            | "sessionid"
            | "api_key"
            | "apikey"
            | "secret"
            | "password"
            | "passwd"
            | "sig"
            | "signature"
            | "auth"
    )
}

fn trim_url_tail(raw: &str) -> (&str, &str) {
    let mut end = raw.len();
    while let Some(ch) = raw[..end].chars().next_back() {
        if matches!(ch, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}') {
            end -= ch.len_utf8();
        } else {
            break;
        }
    }
    (&raw[..end], &raw[end..])
}

fn sanitize_url(raw: &str, redact_path: bool) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return "<URL_REDACTED>".to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("");
    }
    if url.password().is_some() {
        let _ = url.set_password(None);
    }
    let scheme = url.scheme().to_string();
    let Some(host) = url.host_str().map(str::to_string) else {
        return "<URL_REDACTED>".to_string();
    };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };

    let query = if redact_path {
        if url.query().is_some() {
            Some("<REDACTED>".to_string())
        } else {
            None
        }
    } else {
        let mut pairs = url
            .query_pairs()
            .map(|(key, value)| {
                if sensitive_key(&key) {
                    (key.into_owned(), "<REDACTED>".to_string())
                } else {
                    (key.into_owned(), value.into_owned())
                }
            })
            .peekable();
        if pairs.peek().is_none() {
            None
        } else {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in pairs {
                serializer.append_pair(&key, &value);
            }
            // Keep the human-readable placeholder visible in previews/logs.
            Some(serializer.finish().replace("%3CREDACTED%3E", "<REDACTED>"))
        }
    };

    let path = if redact_path {
        "/<URL_PATH_REDACTED>".to_string()
    } else {
        let path = url.path().to_string();
        if path.is_empty() {
            "/".to_string()
        } else {
            path
        }
    };
    match query {
        Some(query) => format!("{scheme}://{authority}{port}{path}?{query}"),
        None => format!("{scheme}://{authority}{port}{path}"),
    }
}

fn replace_file_path(raw: &str) -> String {
    let extension = raw
        .rfind('.')
        .map(|index| &raw[index..])
        .unwrap_or_default();
    let (prefix, separator) =
        if raw.len() >= 2 && raw.as_bytes()[0].is_ascii_alphabetic() && raw.as_bytes()[1] == b':' {
            let sep = raw
                .chars()
                .nth(2)
                .filter(|c| *c == '/' || *c == '\\')
                .unwrap_or('\\');
            (format!("{}:", &raw[..1]), sep)
        } else if let Some(rest) = raw
            .strip_prefix("<USER_HOME>")
            .or_else(|| raw.strip_prefix("<MOUNT>"))
        {
            let sep = rest
                .chars()
                .next()
                .filter(|c| *c == '/' || *c == '\\')
                .unwrap_or('\\');
            (raw[..raw.len() - rest.len()].to_string(), sep)
        } else if raw.starts_with("\\\\") {
            ("\\\\".to_string(), '\\')
        } else if raw.starts_with('/') {
            (String::new(), '/')
        } else {
            (String::new(), '\\')
        };
    format!("{prefix}{separator}<MANGA_DIR>{separator}<MANGA_FILE>{extension}")
}

fn replace_bare_file(raw: &str) -> String {
    let extension = raw
        .rfind('.')
        .map(|index| &raw[index..])
        .unwrap_or_default();
    format!("<MANGA_FILE>{extension}")
}

/// Remove personal data and credentials from arbitrary diagnostic text.
///
/// This is intentionally conservative: when a value looks like a local
/// manga/archive/image path, its directory chain and basename are replaced.
pub fn sanitize_text(input: &str, redact_url_paths: bool) -> String {
    let header_redacted = header_regex()
        .replace_all(input, |caps: &regex::Captures<'_>| {
            let lead = caps.name("lead").map(|m| m.as_str()).unwrap_or_default();
            let header = caps.name("header").map(|m| m.as_str()).unwrap_or_default();
            let sep = caps.name("sep").map(|m| m.as_str()).unwrap_or_default();
            format!("{lead}{header}{sep}<REDACTED>")
        })
        .into_owned();

    // Protect URLs first so their `https://` prefix and file-like paths cannot
    // be mistaken for Windows/Unix files by the path sanitizer.
    let mut urls: Vec<String> = Vec::new();
    let mut protected = String::with_capacity(header_redacted.len());
    let mut last = 0usize;
    for hit in url_regex().find_iter(&header_redacted) {
        let (url, tail) = trim_url_tail(hit.as_str());
        protected.push_str(&header_redacted[last..hit.start()]);
        protected.push('\u{e000}');
        protected.push_str(&urls.len().to_string());
        protected.push('\u{e001}');
        urls.push(sanitize_url(url, redact_url_paths));
        protected.push_str(tail);
        last = hit.end();
    }
    protected.push_str(&header_redacted[last..]);

    let redacted = key_value_regex()
        .replace_all(&protected, |caps: &regex::Captures<'_>| {
            let lead = caps.name("lead").map(|m| m.as_str()).unwrap_or_default();
            let quote = caps
                .name("quote")
                .map(|m| m.as_str())
                .filter(|q| !q.is_empty())
                .unwrap_or("\"");
            let key = caps.name("key").map(|m| m.as_str()).unwrap_or_default();
            let sep = caps.name("sep").map(|m| m.as_str()).unwrap_or_default();
            let has_quoted_key = caps
                .name("quote")
                .map(|m| !m.as_str().is_empty())
                .unwrap_or(false);
            if has_quoted_key {
                // JSON 键：保留键/值引号，输出仍是可读 JSON。
                format!("{lead}{quote}{key}{quote}{sep}{quote}<REDACTED>{quote}")
            } else {
                format!("{lead}{key}{sep}<REDACTED>")
            }
        })
        .into_owned();
    let redacted = bearer_regex()
        .replace_all(&redacted, "${kind} <REDACTED>")
        .into_owned();
    let redacted = jwt_regex()
        .replace_all(&redacted, "<REDACTED>")
        .into_owned();
    let redacted = windows_home_regex()
        .replace_all(&redacted, "<USER_HOME>\\")
        .into_owned();
    let redacted = unix_home_regex()
        .replace_all(&redacted, "<USER_HOME>/")
        .into_owned();
    let redacted = unix_mount_regex()
        .replace_all(&redacted, "<MOUNT>/")
        .into_owned();

    let mut sanitized = win_path_regex()
        .replace_all(&redacted, |caps: &regex::Captures<'_>| {
            replace_file_path(caps.get(0).map(|m| m.as_str()).unwrap_or_default())
        })
        .into_owned();
    for path_regex in [unc_path_regex(), home_path_regex()] {
        sanitized = path_regex
            .replace_all(&sanitized, |caps: &regex::Captures<'_>| {
                replace_file_path(caps.get(0).map(|m| m.as_str()).unwrap_or_default())
            })
            .into_owned();
    }
    sanitized = unix_abs_path_regex()
        .replace_all(&sanitized, |caps: &regex::Captures<'_>| {
            let whole = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
            let Some(start) = whole.find('/') else {
                return whole.to_string();
            };
            format!("{}{}", &whole[..start], replace_file_path(&whole[start..]))
        })
        .into_owned();
    sanitized = bare_file_regex()
        .replace_all(&sanitized, |caps: &regex::Captures<'_>| {
            let lead = caps.name("lead").map(|m| m.as_str()).unwrap_or_default();
            let file = caps.name("file").map(|m| m.as_str()).unwrap_or_default();
            format!("{lead}{}", replace_bare_file(file))
        })
        .into_owned();

    // Restore already-sanitized URLs after path processing.
    url_token_regex()
        .replace_all(&sanitized, |caps: &regex::Captures<'_>| {
            caps.get(1)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .and_then(|index| urls.get(index).cloned())
                .unwrap_or_else(|| "<URL_REDACTED>".to_string())
        })
        .into_owned()
}

/// Sanitizes a free-form bundle string and bounds it for IPC.
fn sanitize_bounded(input: &str, max: usize, redact_urls: bool) -> String {
    bounded(sanitize_text(input, redact_urls), max)
}

fn manga_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "cbz"
            | "zip"
            | "cbr"
            | "cbt"
            | "rar"
            | "7z"
            | "pdf"
            | "jpg"
            | "jpeg"
            | "png"
            | "webp"
            | "avif"
            | "gif"
            | "bmp"
    )
    .then_some(ext)
}

/// Exact local library names gathered only for the current export. These terms
/// cover directory-only paths and bare folder names that generic path regexes
/// cannot classify safely.
fn known_private_terms(state: &AppState) -> Vec<(String, String)> {
    let rows = state
        .db
        .with(|conn| crate::db::list_books(conn, None).map_err(|err| err.to_string()))
        .unwrap_or_default();
    let generic = [
        "users",
        "desktop",
        "downloads",
        "documents",
        "appdata",
        "local",
        "roaming",
        "temp",
        "tmp",
        "library",
        "books",
        "manga",
        "comics",
    ];
    let mut terms: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows.into_iter().filter(|row| row.source_type == "local") {
        let path = Path::new(row.path.trim());
        let extension = manga_extension(path);
        let replacement = extension
            .as_ref()
            .map(|ext| format!("<MANGA_FILE>.{ext}"))
            .unwrap_or_else(|| "<MANGA_DIR>".to_string());
        let mut candidates: Vec<String> = Vec::new();
        let raw = row.path.trim().to_string();
        // Full paths are the strongest match; shorter names are fallbacks for
        // logs that only mention a book/folder.
        if !raw.is_empty() && extension.is_none() {
            candidates.push(raw.clone());
            candidates.push(raw.replace('\\', "/"));
        }
        if let Some(parent) = path.parent().and_then(Path::file_name) {
            candidates.push(parent.to_string_lossy().into_owned());
        }
        if let Some(name) = path.file_name() {
            candidates.push(name.to_string_lossy().into_owned());
            if let Some(stem) = path.file_stem() {
                candidates.push(stem.to_string_lossy().into_owned());
            }
        }
        if !row.title.trim().is_empty() {
            candidates.push(row.title.trim().to_string());
        }
        for term in candidates {
            let trimmed = term.trim();
            if trimmed.len() < 2
                || trimmed.contains('<')
                || trimmed.contains('>')
                || generic
                    .iter()
                    .any(|generic| trimmed.eq_ignore_ascii_case(generic))
                || !seen.insert(trimmed.to_string())
            {
                continue;
            }
            terms.push((trimmed.to_string(), replacement.clone()));
        }
    }
    terms.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    terms
}

fn sanitize_with_private_terms(
    input: &str,
    redact_urls: bool,
    terms: &[(String, String)],
) -> String {
    let mut value = input.to_string();
    for (term, replacement) in terms {
        if value.contains(term) {
            value = value.replace(term, replacement);
        }
    }
    sanitize_text(&value, redact_urls)
}

fn sanitize_bounded_with_terms(
    input: &str,
    max: usize,
    redact_urls: bool,
    terms: &[(String, String)],
) -> String {
    bounded(sanitize_with_private_terms(input, redact_urls, terms), max)
}

// ---------- Collection ----------

#[tauri::command]
pub fn diagnostics_record_frontend_error(entry: FrontendErrorInput) -> Result<(), String> {
    let message = entry.message.trim();
    if message.is_empty() {
        return Ok(());
    }
    let source = normalize_source(&entry.source);
    let mut errors = errors_slot().lock();
    if errors
        .last()
        .is_some_and(|last| last.source == source && last.message == message)
    {
        return Ok(());
    }
    if errors.len() >= MAX_ERRORS {
        errors.remove(0);
    }
    errors.push(DiagnosticError {
        at: now(),
        source,
        message: bounded(message.to_string(), MAX_ERROR_MESSAGE),
        stack: entry
            .stack
            .filter(|stack| !stack.trim().is_empty())
            .map(|stack| bounded(stack, MAX_STACK)),
        route: entry
            .route
            .as_deref()
            .and_then(display_route)
            .map(|route| bounded(route, MAX_ROUTE)),
    });
    Ok(())
}

#[tauri::command]
pub fn diagnostics_record_breadcrumb(entry: BreadcrumbInput) -> Result<(), String> {
    let mut breadcrumbs = breadcrumbs_slot().lock();
    if breadcrumbs.len() >= MAX_BREADCRUMBS {
        breadcrumbs.remove(0);
    }
    breadcrumbs.push(DiagnosticBreadcrumb {
        at: now(),
        kind: normalize_kind(&entry.kind),
        route: entry
            .route
            .as_deref()
            .and_then(display_route)
            .map(|route| bounded(route, MAX_ROUTE)),
    });
    Ok(())
}

#[tauri::command]
pub fn diagnostics_update_context(context: RuntimeContextInput) -> Result<(), String> {
    let mut slot = context_slot().lock();
    if let Some(route) = context.route {
        slot.route = display_route(&route);
    }
    if let Some(mode) = context.reader_mode {
        slot.reader_mode = mode_allowlist(&mode);
    }
    if let Some(page) = context.reader_page {
        slot.reader_page = Some(page);
    }
    if let Some(active) = context.safe_mode {
        slot.safe_mode = active;
    }
    Ok(())
}

#[tauri::command]
pub fn diagnostics_collect(
    state: tauri::State<'_, Arc<AppState>>,
    redact_url_paths: bool,
) -> Result<DiagnosticBundle, String> {
    let app_info = crate::update::get_app_info();
    let settings = state.settings.lock().clone();
    let private_terms = known_private_terms(state.inner());
    let proxy = settings.online_proxy.trim().to_string();
    let proxy_scheme = if proxy.is_empty() {
        None
    } else {
        Url::parse(&proxy).ok().map(|url| url.scheme().to_string())
    };
    let context = context_slot().lock().clone();
    let os = sysinfo::System::long_os_version()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| std::env::consts::OS.to_string());

    let runtime = DiagnosticRuntime {
        version: app_info.version,
        build_baseline: app_info.build_baseline,
        os: sanitize_text(&os, redact_url_paths),
        arch: std::env::consts::ARCH.to_string(),
        route: context.route,
        reader_mode: context.reader_mode,
        reader_page: context.reader_page,
        network_mode: if proxy.is_empty() { "direct" } else { "proxy" }.to_string(),
        proxy_scheme,
        online_enabled: settings.experimental_online,
        safe_mode: context.safe_mode,
    };

    let breadcrumbs = breadcrumbs_slot()
        .lock()
        .iter()
        .map(|item| DiagnosticBreadcrumb {
            at: item.at.clone(),
            kind: normalize_kind(&item.kind),
            route: item
                .route
                .as_deref()
                .map(|route| sanitize_bounded(route, MAX_ROUTE, redact_url_paths)),
        })
        .collect();

    let errors = errors_slot()
        .lock()
        .iter()
        .map(|item| DiagnosticError {
            at: item.at.clone(),
            source: normalize_source(&item.source),
            message: sanitize_bounded_with_terms(
                &item.message,
                MAX_ERROR_MESSAGE,
                redact_url_paths,
                &private_terms,
            ),
            stack: item.stack.as_deref().map(|stack| {
                sanitize_bounded_with_terms(stack, MAX_STACK, redact_url_paths, &private_terms)
            }),
            route: item
                .route
                .as_deref()
                .map(|route| sanitize_bounded(route, MAX_ROUTE, redact_url_paths)),
        })
        .collect();

    let logs = crate::logging::recent_logs(80)
        .into_iter()
        .map(|entry| crate::logging::LogEntry {
            at: entry.at,
            scope: sanitize_bounded(&entry.scope, 80, redact_url_paths),
            message: sanitize_bounded_with_terms(
                &entry.message,
                MAX_ERROR_MESSAGE,
                redact_url_paths,
                &private_terms,
            ),
        })
        .collect();

    Ok(DiagnosticBundle {
        generated_at: now(),
        runtime,
        breadcrumbs,
        errors,
        logs,
    })
}

/// Sanitize the free-text reproduction field before it is interpolated into
/// the prompt. Uses the same private-term list and sanitizer as the bundle.
#[tauri::command]
pub fn diagnostics_sanitize_description(
    state: tauri::State<'_, Arc<AppState>>,
    text: String,
) -> Result<String, String> {
    let terms = known_private_terms(state.inner());
    Ok(sanitize_bounded_with_terms(
        &text,
        MAX_ERROR_MESSAGE,
        true,
        &terms,
    ))
}

/// Write the exact Markdown the user previewed. Explicit click only; no upload.
#[tauri::command]
pub fn diagnostics_export(markdown: String) -> Result<String, String> {
    if markdown.trim().is_empty() {
        return Err("诊断内容为空".to_string());
    }
    if markdown.len() > MAX_EXPORT_BYTES {
        return Err("诊断内容超过导出上限".to_string());
    }
    let dir = dirs::download_dir()
        .or_else(|| crate::data_dir().ok().map(|dir| dir.join("diagnostics")))
        .ok_or_else(|| "无法定位导出目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建导出目录失败：{err}"))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let mut path = dir.join(format!("mangareader-diagnostic-{stamp}.md"));
    let mut suffix = 1u32;
    while path.exists() {
        path = dir.join(format!("mangareader-diagnostic-{stamp}-{suffix}.md"));
        suffix = suffix.saturating_add(1);
    }
    std::fs::write(&path, markdown.as_bytes()).map_err(|err| format!("写入诊断文件失败：{err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Record backend panics in the in-memory log ring, then delegate to the
/// previous hook so developer console output is preserved.
pub fn install_panic_hook() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        crate::logging::log_error("panic", &format!("{payload} ({location})"));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_chinese_path_hides_username_and_manga_names() {
        let input = r"打开失败 C:\Users\李雷\Comics\海贼王\第01话.cbz（无法读取）";
        let output = sanitize_text(input, true);
        assert!(
            output.contains("<USER_HOME>\\<MANGA_DIR>\\<MANGA_FILE>.cbz"),
            "{output}"
        );
        for leaked in ["李雷", "Comics", "海贼王", "第01话"] {
            assert!(!output.contains(leaked), "{leaked} leaked in {output}");
        }
    }

    #[test]
    fn json_quoted_credentials_are_redacted() {
        let input = r#"{"Cookie":"session=SECRET_JSON_COOKIE","Authorization":"Bearer SECRET_JSON_TOKEN","api_key":"SECRET_JSON_KEY","nested":{"token":"SECRET_NESTED"}}"#;
        let output = sanitize_text(input, false);
        for secret in [
            "SECRET_JSON_COOKIE",
            "SECRET_JSON_TOKEN",
            "SECRET_JSON_KEY",
            "SECRET_NESTED",
        ] {
            assert!(!output.contains(secret), "{secret} leaked in {output}");
        }
        assert!(output.contains(r#""api_key":"<REDACTED>""#), "{output}");
    }

    #[test]
    fn drive_path_preserves_extension_and_hides_folders() {
        let output = sanitize_text(r"D:\Library\进击的巨人\第1卷\01.PNG", true);
        assert!(
            output.starts_with(r"D:\<MANGA_DIR>\<MANGA_FILE>"),
            "{output}"
        );
        assert!(output.ends_with(".PNG"), "{output}");
        for leaked in ["Library", "进击的巨人", "第1卷", "01"] {
            assert!(!output.contains(leaked), "{leaked} leaked in {output}");
        }
    }

    #[test]
    fn unix_home_archive_is_collapsed() {
        let output = sanitize_text("/home/alice/manga/One Piece/ch1.zip", true);
        assert!(
            output.contains("<USER_HOME>/<MANGA_DIR>/<MANGA_FILE>.zip"),
            "{output}"
        );
        for leaked in ["alice", "One Piece", "ch1"] {
            assert!(!output.contains(leaked), "{leaked} leaked in {output}");
        }
    }

    #[test]
    fn linux_removable_media_paths_hide_username_and_mount_name() {
        // udisks 自动挂载路径：用户名必须脱敏。
        let output = sanitize_text("/run/media/alice/SDCARD/manga/海贼王 第01卷.zip", true);
        assert!(!output.contains("alice"), "{output}");
        assert!(!output.contains("海贼王"), "{output}");
        assert!(
            output.contains("<USER_HOME>/") || output.contains("<MANGA_DIR>"),
            "{output}"
        );

        // /mnt 挂载点：挂载名折叠为 <MOUNT>，不再泄露 NAS 共享名。
        let output = sanitize_text("无法读取 /mnt/nas-share/comics/nested/第2话.cbz", true);
        assert!(!output.contains("nas-share"), "{output}");
        assert!(!output.contains("第2话"), "{output}");
        assert!(output.contains("<MOUNT>"), "{output}");
    }

    #[test]
    fn bare_manga_file_is_replaced() {
        let output = sanitize_text("failed: 进击的巨人.cbz", false);
        assert!(output.contains("<MANGA_FILE>.cbz"), "{output}");
        assert!(!output.contains("进击的巨人"), "{output}");
    }

    #[test]
    fn token_url_is_redacted_and_path_option_is_honored() {
        let secret = "https://example.com/chapter/42?token=abc123&x=1";
        let hidden = sanitize_text(secret, true);
        assert!(
            hidden.contains("https://example.com/<URL_PATH_REDACTED>"),
            "{hidden}"
        );
        assert!(hidden.contains("<REDACTED>"), "{hidden}");
        assert!(!hidden.contains("abc123"), "{hidden}");
        assert!(!hidden.contains("chapter/42"), "{hidden}");

        let kept = sanitize_text(secret, false);
        assert!(kept.contains("/chapter/42"), "{kept}");
        assert!(!kept.contains("abc123"), "{kept}");
        assert!(kept.contains("token=<REDACTED>"), "{kept}");
    }

    #[test]
    fn credential_headers_and_bearer_are_redacted() {
        let input = "Authorization: Bearer topsecret\nCookie: a=b; c=d\napi_key=xyz\nrequest { Cookie: inline=secret }";
        let output = sanitize_text(input, false);
        assert!(output.contains("Authorization: <REDACTED>"), "{output}");
        assert!(output.contains("Cookie: <REDACTED>"), "{output}");
        assert!(!output.contains("topsecret"), "{output}");
        assert!(!output.contains("a=b"), "{output}");
        assert!(!output.contains("xyz"), "{output}");
        assert!(!output.contains("inline=secret"), "{output}");
    }

    #[test]
    fn ordinary_debug_text_remains() {
        let input = "Tauri IPC timeout after 2000ms in ReaderDock";
        assert_eq!(sanitize_text(input, true), input);
    }

    #[test]
    fn known_library_folder_and_title_are_redacted() {
        let folder = r"C:\Users\李雷\Desktop\模板\R18\Hidden Arena 1-6";
        let terms = vec![
            (folder.to_string(), "<MANGA_DIR>".to_string()),
            ("Hidden Arena 1-6".to_string(), "<MANGA_DIR>".to_string()),
        ];
        let input = format!("无法读取《Hidden Arena 1-6》：{folder}");
        let output = sanitize_with_private_terms(&input, true, &terms);
        for leaked in ["李雷", "模板", "R18", "Hidden Arena"] {
            assert!(!output.contains(leaked), "{leaked} leaked in {output}");
        }
        assert!(output.contains("<MANGA_DIR>"));
    }

    #[test]
    fn route_normalization_drops_ids_queries_and_fragments() {
        assert_eq!(
            display_route("#/reader/abc?page=12").as_deref(),
            Some("/reader/:id")
        );
        assert_eq!(
            display_route("https://x.test/settings?tab=privacy").as_deref(),
            Some("/settings")
        );
        assert_eq!(display_route("#/settings").as_deref(), Some("/settings"));
        assert_eq!(display_route(""), None);
    }

    #[test]
    fn bounded_respects_unicode_boundaries() {
        let output = bounded("诊断诊断诊断".to_string(), 8);
        assert!(output.len() <= 11);
        assert!(output.starts_with("诊断"));
    }
}
