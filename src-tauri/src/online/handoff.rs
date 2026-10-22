//! 本地长驻配对桥接：系统浏览器页面把当前 DOM 图片地址 POST 回 127.0.0.1。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

use crate::commands;
use crate::source::BackendError;
use crate::state::HandoffRuntime;
use crate::AppState;

const HANDOFF_PATH: &str = "/handoff";
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffStatus {
    pub active: bool,
    pub port: u16,
    pub pairing_token: String,
    pub callback_url: String,
    pub received_chapters: u32,
    pub allow_session_headers: bool,
    pub script: String,
}

fn inactive_handoff_status() -> HandoffStatus {
    HandoffStatus {
        active: false,
        port: 0,
        pairing_token: String::new(),
        callback_url: String::new(),
        received_chapters: 0,
        allow_session_headers: false,
        script: String::new(),
    }
}

#[derive(Debug)]
pub(crate) enum HandoffError {
    BadRequest(String),
    Internal(String),
}

impl From<BackendError> for HandoffError {
    fn from(error: BackendError) -> Self {
        match error {
            BackendError::Msg(message) => Self::BadRequest(message),
            other => Self::Internal(other.to_string()),
        }
    }
}

#[derive(Debug)]
pub(crate) enum HandoffOutcome {
    Stopped,
    Disabled,
}

fn generate_handoff_token() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut bytes = [0u8; 16];
        let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
        if status.0 >= 0 {
            return hex::encode(bytes);
        }
    }
    fallback_token()
}

fn fallback_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut bytes = Vec::with_capacity(16);
    for round in 0..2u8 {
        let state = RandomState::new();
        let mut hasher = state.build_hasher();
        hasher.write_u8(round);
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        );
        hasher.write_u32(std::process::id());
        hasher.write_usize(&state as *const RandomState as usize);
        bytes.extend_from_slice(&hasher.finish().to_le_bytes());
    }
    hex::encode(&bytes[..16])
}

fn build_script(callback_url: &str) -> String {
    const TEMPLATE: &str = r#"
/*
 * MangaReader 通用合集收集脚本，由用户在自己的浏览器里手动执行。
 * 只读取当前页面已渲染的图片地址与 title/location；不读取 Cookie，不翻页，不爬取。
 */
(async () => {
  const endpoint = __CALLBACK__;
  const MR_BUCKET = 'mangareader.bridge.chapters:' + location.origin;
  const MR_SERIES_ID = ''; // 可选：固定系列 ID
  const MR_SERIES_TITLE = ''; // 可选：固定系列名
  const MR_SESSION_HEADERS = ''; // 可选：填入请求头后随请求携带；仅内存，不落盘、不记日志
  const load = () => {
    try {
      const value = JSON.parse(localStorage.getItem(MR_BUCKET) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  };
  const save = (chapters) => {
    try { localStorage.setItem(MR_BUCKET, JSON.stringify(chapters)); } catch (_) {}
  };
  window.MR_BRIDGE = {
    list: () => load(),
    reset: () => {
      try { localStorage.removeItem(MR_BUCKET); } catch (_) {}
      alert('MangaReader：已清空当前站点的章节收集');
    },
  };
  const urls = new Set();
  const add = (value) => {
    if (!value) return;
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.href);
    } catch (_) {}
  };
  document.querySelectorAll('img').forEach((img) => {
    for (const attr of ['src', 'data-src', 'data-original']) add(img.getAttribute(attr));
  });
  document.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (href && /\.(?:jpe?g|png|gif|webp)(?:[?#].*)?$/i.test(href)) add(href);
  });
  const current = { url: location.href, title: document.title, pages: Array.from(urls) };
  const chapters = load().filter((chapter) => chapter && typeof chapter.url === 'string');
  const existing = chapters.findIndex((chapter) => chapter.url === current.url);
  if (existing >= 0) chapters[existing] = current;
  else chapters.push(current);
  save(chapters);
  const payload = { chapters };
  if (MR_SERIES_ID.trim()) payload.seriesId = MR_SERIES_ID.trim();
  if (MR_SERIES_TITLE.trim()) payload.seriesTitle = MR_SERIES_TITLE.trim();
  if (MR_SESSION_HEADERS.trim()) payload.sessionHeaders = MR_SESSION_HEADERS;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    alert(response.ok
      ? `MangaReader：已提交 ${chapters.length} 章`
      : `MangaReader：提交失败（${response.status}）`);
  } catch (_) {
    alert('MangaReader：无法连接本地导入服务');
  }
})();
"#;
    let callback = serde_json::to_string(callback_url).unwrap_or_else(|_| "\"\"".into());
    TEMPLATE.replace("__CALLBACK__", &callback)
}

fn token_matches(supplied: Option<&str>, expected: &str) -> bool {
    let Some(supplied) = supplied else {
        return false;
    };
    if supplied.len() != expected.len() {
        return false;
    }
    supplied
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let length = if status == 204 { 0 } else { body.len() };
    let header = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        status_reason(status)
    );
    stream.write_all(header.as_bytes())?;
    if status != 204 && !body.is_empty() {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn respond_error(stream: &mut TcpStream, status: u16, message: &str) {
    let _ = respond(
        stream,
        status,
        "text/plain; charset=utf-8",
        message.as_bytes(),
    );
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

struct RequestError {
    status: u16,
    message: &'static str,
}

impl RequestError {
    fn bad(message: &'static str) -> Self {
        Self {
            status: 400,
            message,
        }
    }
}

fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, RequestError> {
    let _ = stream.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SOCKET_TIMEOUT));

    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if data.len() > MAX_HEADER_BYTES {
            return Err(RequestError {
                status: 413,
                message: "headers too large",
            });
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|_| RequestError::bad("cannot read request"))?;
        if read == 0 {
            return Err(RequestError::bad("empty request"));
        }
        data.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_double_crlf(&data) {
            break end + 4;
        }
    };

    let header = String::from_utf8_lossy(&data[..header_end]);
    let mut lines = header.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| RequestError::bad("missing method"))?
        .to_ascii_uppercase();
    let target = parts
        .next()
        .ok_or_else(|| RequestError::bad("missing target"))?
        .to_string();

    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| RequestError::bad("invalid content-length"))?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding") && !value.is_empty() {
            return Err(RequestError::bad("chunked body unsupported"));
        }
    }

    let body = if method == "POST" {
        let length = content_length.ok_or(RequestError {
            status: 411,
            message: "content-length required",
        })?;
        if length > MAX_BODY_BYTES {
            return Err(RequestError {
                status: 413,
                message: "body too large",
            });
        }
        let mut body = data[header_end..].to_vec();
        body.truncate(length);
        while body.len() < length {
            let read = stream
                .read(&mut chunk)
                .map_err(|_| RequestError::bad("cannot read body"))?;
            if read == 0 {
                return Err(RequestError::bad("short body"));
            }
            body.extend_from_slice(&chunk[..read]);
            if body.len() > MAX_BODY_BYTES {
                return Err(RequestError {
                    status: 413,
                    message: "body too large",
                });
            }
        }
        body
    } else {
        Vec::new()
    };

    Ok(HttpRequest {
        method,
        target,
        body,
    })
}

fn parse_target(target: &str) -> Option<Url> {
    if target.starts_with("http://") || target.starts_with("https://") {
        Url::parse(target).ok()
    } else {
        Url::parse(&format!("http://127.0.0.1{target}")).ok()
    }
}

/// 校验 sessionHeaders（若存在），再解析单本/合集并批量入库。
pub(crate) fn process_handoff_value(
    state: &Arc<AppState>,
    value: &serde_json::Value,
    allow_session_headers: bool,
) -> Result<Vec<crate::BookInfo>, HandoffError> {
    if !state.settings.lock().experimental_online {
        return Err(HandoffError::BadRequest("在线直读未开启".into()));
    }
    if allow_session_headers {
        if let Some(headers) = value.get("sessionHeaders") {
            let raw = headers
                .as_str()
                .ok_or_else(|| HandoffError::BadRequest("sessionHeaders 必须为字符串".into()))?;
            if !raw.trim().is_empty() {
                commands::apply_session_online_headers(state, Some(raw.to_string()))
                    .map_err(HandoffError::BadRequest)?;
            }
        }
    }
    let body =
        serde_json::to_vec(value).map_err(|error| HandoffError::Internal(error.to_string()))?;
    let metas = crate::online::direct::parse_batch_payload(&body).map_err(HandoffError::from)?;
    commands::ingest_resolved_batch(state, metas).map_err(HandoffError::from)
}

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    import: &mut impl FnMut(serde_json::Value) -> Result<Vec<crate::BookInfo>, HandoffError>,
) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            respond_error(&mut stream, error.status, error.message);
            return;
        }
    };

    let target = match parse_target(&request.target) {
        Some(target) if target.path() == HANDOFF_PATH => target,
        Some(_) => {
            respond_error(&mut stream, 404, "not found");
            return;
        }
        None => {
            respond_error(&mut stream, 400, "invalid target");
            return;
        }
    };
    let supplied = target
        .query_pairs()
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.into_owned());
    if !token_matches(supplied.as_deref(), token) {
        respond_error(&mut stream, 403, "forbidden");
        return;
    }

    match request.method.as_str() {
        "OPTIONS" => {
            let _ = respond(&mut stream, 204, "text/plain", b"");
        }
        "POST" => {
            let value: serde_json::Value = match serde_json::from_slice(&request.body) {
                Ok(value) => value,
                Err(_) => {
                    respond_error(&mut stream, 400, "invalid JSON");
                    return;
                }
            };
            match import(value) {
                Ok(books) => {
                    let books: Vec<serde_json::Value> = books
                        .iter()
                        .map(|book| {
                            serde_json::json!({
                                "id": book.id,
                                "title": book.title,
                            })
                        })
                        .collect();
                    let body = serde_json::json!({ "books": books }).to_string();
                    let _ = respond(&mut stream, 200, "application/json", body.as_bytes());
                }
                Err(HandoffError::BadRequest(message)) => {
                    respond_error(&mut stream, 400, &message);
                }
                Err(HandoffError::Internal(message)) => {
                    respond_error(&mut stream, 500, &message);
                }
            }
        }
        _ => {
            respond_error(&mut stream, 405, "method not allowed");
        }
    }
}

/// 长驻循环：停止信号/实验开关关闭才退出；成功导入后继续接受下一轮。
pub(crate) fn serve_handoff<F, E>(
    listener: TcpListener,
    token: String,
    cancel: Arc<AtomicBool>,
    enabled: E,
    mut import: F,
) -> HandoffOutcome
where
    F: FnMut(serde_json::Value) -> Result<Vec<crate::BookInfo>, HandoffError>,
    E: Fn() -> bool,
{
    if listener.set_nonblocking(true).is_err() {
        return HandoffOutcome::Stopped;
    }
    loop {
        if cancel.load(Ordering::SeqCst) {
            return HandoffOutcome::Stopped;
        }
        if !enabled() {
            return HandoffOutcome::Disabled;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                handle_connection(stream, &token, &mut import);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return HandoffOutcome::Stopped,
        }
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn start_browser_handoff(
    app: AppHandle,
    allow_session_headers: bool,
) -> Result<HandoffStatus, String> {
    crate::resilience::ensure_online_allowed()?;
    let state = app.state::<Arc<AppState>>().inner().clone();
    if !state.settings.lock().experimental_online {
        return Err("在线直读未开启".into());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("启动本地回调失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取本地回调端口失败：{e}"))?
        .port();
    let token = generate_handoff_token();
    let callback_url = format!("http://127.0.0.1:{port}{HANDOFF_PATH}?token={token}");
    let script = build_script(&callback_url);
    let cancel = Arc::new(AtomicBool::new(false));
    state.begin_handoff(HandoffRuntime {
        port,
        token: token.clone(),
        callback_url: callback_url.clone(),
        allow_session_headers,
        script: script.clone(),
        cancel: cancel.clone(),
    });
    let thread_cancel = cancel.clone();
    let received_flag = cancel.clone();
    let thread_state = state.clone();
    let import_state = state.clone();
    let enabled_state = state.clone();
    let thread_app = app.clone();
    let emit_app = app.clone();
    let thread_token = token.clone();
    std::thread::spawn(move || {
        let outcome = serve_handoff(
            listener,
            thread_token,
            thread_cancel.clone(),
            move || enabled_state.settings.lock().experimental_online,
            move |value| {
                let books = process_handoff_value(&import_state, &value, allow_session_headers)?;
                import_state.add_handoff_received(&received_flag, books.len() as u32);
                let _ = emit_app.emit("online-handoff-imported", &books);
                focus_main(&emit_app);
                Ok(books)
            },
        );
        if matches!(outcome, HandoffOutcome::Disabled) || !thread_cancel.load(Ordering::SeqCst) {
            let _ = thread_app.emit("online-handoff-stopped", ());
        }
        thread_state.finish_handoff(&thread_cancel);
    });

    Ok(HandoffStatus {
        active: true,
        port,
        pairing_token: token,
        callback_url,
        received_chapters: 0,
        allow_session_headers,
        script,
    })
}

fn current_handoff_status(state: &AppState) -> HandoffStatus {
    match state.handoff_status() {
        Some(status) => HandoffStatus {
            active: true,
            port: status.port,
            pairing_token: status.pairing_token,
            callback_url: status.callback_url,
            received_chapters: status.received_chapters,
            allow_session_headers: status.allow_session_headers,
            script: status.script,
        },
        None => inactive_handoff_status(),
    }
}

#[tauri::command]
pub fn get_browser_handoff_status(
    state: State<'_, Arc<AppState>>,
) -> Result<HandoffStatus, String> {
    Ok(current_handoff_status(&state))
}

#[tauri::command]
pub fn stop_browser_handoff(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.cancel_handoff();
    let _ = app.emit("online-handoff-stopped", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use rusqlite::Connection;
    use serde_json::Value;

    use crate::AppState;

    fn test_token() -> String {
        "a".repeat(32)
    }

    fn test_state() -> Arc<AppState> {
        let st = Arc::new(AppState::new());
        let conn = Connection::open_in_memory().expect("打开内存数据库");
        crate::db::init_schema(&conn).expect("初始化表结构");
        st.db.set(conn);
        st.settings.lock().experimental_online = true;
        st
    }

    fn spawn_server<F, E>(
        token: String,
        cancel: Arc<AtomicBool>,
        enabled: E,
        import: F,
    ) -> (u16, std::thread::JoinHandle<HandoffOutcome>)
    where
        F: FnMut(Value) -> Result<Vec<crate::BookInfo>, HandoffError> + Send + 'static,
        E: Fn() -> bool + Send + 'static,
    {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("绑定 loopback");
        let port = listener.local_addr().unwrap().port();
        let handle =
            std::thread::spawn(move || serve_handoff(listener, token, cancel, enabled, import));
        (port, handle)
    }

    fn send_request(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("连接 handoff");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn post_json(port: u16, token: &str, body: &str) -> String {
        let request = format!(
            "POST /handoff?token={token} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        send_request(port, &request)
    }

    fn processor(
        st: Arc<AppState>,
        allow_session_headers: bool,
    ) -> impl FnMut(Value) -> Result<Vec<crate::BookInfo>, HandoffError> {
        move |value| process_handoff_value(&st, &value, allow_session_headers)
    }

    #[test]
    fn token_is_32_hex_chars() {
        let token = generate_handoff_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "{token}");
        assert_ne!(token, generate_handoff_token());
    }

    #[test]
    fn script_collects_chapters_without_reading_cookies() {
        let callback = "http://127.0.0.1:1234/handoff?token=abc";
        let script = build_script(callback);
        for needle in [
            "localStorage",
            "mangareader.bridge.chapters",
            "window.MR_BRIDGE",
            "MR_SESSION_HEADERS",
            "seriesId",
            "seriesTitle",
            "chapters",
            "src",
            "data-src",
            "data-original",
            "a[href]",
            "location.href",
            "document.title",
            "fetch",
            callback,
        ] {
            assert!(script.contains(needle), "缺少 {needle}");
        }
        assert!(!script.contains("document.cookie"));
    }

    #[test]
    fn wrong_token_is_403_without_import() {
        let called = Arc::new(AtomicUsize::new(0));
        let called_in_server = called.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            move |_| {
                called_in_server.fetch_add(1, Ordering::SeqCst);
                Err(HandoffError::Internal("不应被调用".into()))
            },
        );

        let body = r#"{"url":"http://example.com/g","title":"T","pages":["http://x/1.jpg"]}"#;
        let response = post_json(port, &"b".repeat(32), body);
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        assert_eq!(called.load(Ordering::SeqCst), 0);

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn same_session_accepts_multiple_posts() {
        let st = test_state();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            processor(st.clone(), false),
        );

        let first = r#"{"url":"http://e/1","title":"One","pages":["http://x/1.jpg"]}"#;
        let second = r#"{"url":"http://e/2","title":"Two","pages":["http://x/2.jpg"]}"#;
        let response = post_json(port, &test_token(), first);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"books\""), "{response}");
        let response = post_json(port, &test_token(), second);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");

        for canonical in ["http://e/1", "http://e/2"] {
            let id = crate::db::book_id_for_path(canonical);
            let stored = st
                .db
                .with(|conn| crate::db::get_book(conn, &id).map_err(|e| e.to_string()))
                .unwrap();
            assert!(stored.is_some(), "{canonical} 应入库");
        }

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
        assert!(
            TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err(),
            "停止后监听应关闭"
        );
    }

    #[test]
    fn invalid_pages_are_rejected_without_import() {
        let st = test_state();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            processor(st.clone(), false),
        );

        let bad_url = r#"{"url":"http://example.com/g","title":"T","pages":["file:///x"]}"#;
        let response = post_json(port, &test_token(), bad_url);
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        let pages: Vec<String> = (0..=crate::online::MAX_PAGES)
            .map(|i| format!("http://x/{i}.jpg"))
            .collect();
        let body = serde_json::json!({
            "url": "http://example.com/g2",
            "title": "T",
            "pages": pages,
        })
        .to_string();
        let response = post_json(port, &test_token(), &body);
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        for canonical in ["http://example.com/g", "http://example.com/g2"] {
            let id = crate::db::book_id_for_path(canonical);
            let stored = st
                .db
                .with(|conn| crate::db::get_book(conn, &id).map_err(|e| e.to_string()))
                .unwrap();
            assert!(stored.is_none(), "非法清单不得入库");
        }

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn options_preflight_returns_204_and_cors_headers() {
        let called = Arc::new(AtomicUsize::new(0));
        let called_in_server = called.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            move |_| {
                called_in_server.fetch_add(1, Ordering::SeqCst);
                Err(HandoffError::Internal("不应被调用".into()))
            },
        );
        let request = format!(
            "OPTIONS /handoff?token={} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://example.com\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\n\r\n",
            test_token()
        );
        let response = send_request(port, &request);
        assert!(response.starts_with("HTTP/1.1 204"), "{response}");
        assert!(
            response.contains("Access-Control-Allow-Origin: *"),
            "{response}"
        );
        assert!(
            response.contains("Access-Control-Allow-Methods: POST, OPTIONS"),
            "{response}"
        );
        assert!(
            response.contains("Access-Control-Allow-Headers: content-type"),
            "{response}"
        );
        assert_eq!(called.load(Ordering::SeqCst), 0);

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn session_headers_are_memory_only_and_validated() {
        let st = test_state();
        st.settings.lock().online_headers = "Cookie: saved".into();
        st.db
            .with(|conn| {
                crate::db::set_setting(conn, "online_headers", "Cookie: saved")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            processor(st.clone(), true),
        );

        let valid = r#"{"sessionHeaders":"Cookie: bridge","url":"http://e/h1","title":"H","pages":["http://x/1.jpg"]}"#;
        let response = post_json(port, &test_token(), valid);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(!response.contains("Cookie: bridge"), "{response}");
        assert_eq!(
            st.session_online_headers.lock().as_deref(),
            Some("Cookie: bridge")
        );
        let stored = st
            .db
            .with(|conn| crate::db::get_setting(conn, "online_headers").map_err(|e| e.to_string()))
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some("Cookie: saved"),
            "会话头不得写入 SQLite"
        );

        let invalid = r#"{"sessionHeaders":"Host: example.com","url":"http://e/h2","title":"H2","pages":["http://x/1.jpg"]}"#;
        let response = post_json(port, &test_token(), invalid);
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(!response.contains("Host: example.com"), "{response}");
        assert_eq!(
            st.session_online_headers.lock().as_deref(),
            Some("Cookie: bridge"),
            "非法头不得覆盖当前会话头"
        );
        let id = crate::db::book_id_for_path("http://e/h2");
        assert!(st
            .db
            .with(|conn| crate::db::get_book(conn, &id).map_err(|e| e.to_string()))
            .unwrap()
            .is_none());

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn batch_payload_imports_chapters_with_links() {
        let st = test_state();
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            processor(st.clone(), false),
        );
        let body = r#"{"seriesId":"S","chapters":[
            {"title":"第1话","url":"http://e/1","pages":["http://x/1.jpg"]},
            {"title":"第2话","url":"http://e/2","pages":["http://x/2.jpg"]}
        ]}"#;
        let response = post_json(port, &test_token(), body);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\"books\""), "{response}");

        let first_id = crate::db::book_id_for_path("http://e/1");
        let first = st
            .db
            .with(|conn| crate::db::get_book(conn, &first_id).map_err(|e| e.to_string()))
            .unwrap()
            .expect("第一话应入库");
        let stored: crate::online::StoredMeta = serde_json::from_str(&first.meta_json).unwrap();
        assert_eq!(stored.series_id.as_deref(), Some("S"));
        assert_eq!(stored.next_url.as_deref(), Some("http://e/2"));

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn session_headers_are_ignored_when_disallowed() {
        let st = test_state();
        *st.session_online_headers.lock() = Some("Cookie: existing".into());
        let cancel = Arc::new(AtomicBool::new(false));
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            processor(st.clone(), false),
        );

        let body = r#"{"sessionHeaders":"Cookie: disallowed","url":"http://e/ignored","title":"I","pages":["http://x/1.jpg"]}"#;
        let response = post_json(port, &test_token(), body);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(!response.contains("Cookie: disallowed"), "{response}");
        assert_eq!(
            st.session_online_headers.lock().as_deref(),
            Some("Cookie: existing")
        );
        let id = crate::db::book_id_for_path("http://e/ignored");
        assert!(st
            .db
            .with(|conn| crate::db::get_book(conn, &id).map_err(|e| e.to_string()))
            .unwrap()
            .is_some());

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
    }

    #[test]
    fn handoff_status_is_inactive_before_start_and_after_stop() {
        let st = test_state();
        let idle = current_handoff_status(&st);
        assert!(!idle.active);
        assert_eq!(idle.port, 0);
        assert!(idle.pairing_token.is_empty());

        let cancel = Arc::new(AtomicBool::new(false));
        st.begin_handoff(HandoffRuntime {
            port: 4321,
            token: "pair-token".into(),
            callback_url: "http://127.0.0.1:4321/handoff?token=pair-token".into(),
            allow_session_headers: true,
            script: "script".into(),
            cancel,
        });
        let active = current_handoff_status(&st);
        assert!(active.active);
        assert_eq!(active.port, 4321);
        assert_eq!(active.pairing_token, "pair-token");
        assert!(active.allow_session_headers);
        assert_eq!(active.script, "script");

        st.cancel_handoff();
        assert!(!current_handoff_status(&st).active);
    }

    #[test]
    fn status_counts_received_chapters_for_current_session() {
        let st = test_state();
        let cancel = Arc::new(AtomicBool::new(false));
        st.begin_handoff(HandoffRuntime {
            port: 1,
            token: "token".into(),
            callback_url: "http://127.0.0.1:1/handoff?token=token".into(),
            allow_session_headers: false,
            script: "script".into(),
            cancel: cancel.clone(),
        });
        let status = st.handoff_status().expect("活动会话");
        assert_eq!(status.received_chapters, 0);

        let import_state = st.clone();
        let received_flag = cancel.clone();
        let (port, handle) = spawn_server(
            test_token(),
            cancel.clone(),
            || true,
            move |value| {
                let books = process_handoff_value(&import_state, &value, false)?;
                import_state.add_handoff_received(&received_flag, books.len() as u32);
                Ok(books)
            },
        );
        let body = r#"{"chapters":[
            {"title":"1","url":"http://e/c1","pages":["http://x/1.jpg"]},
            {"title":"2","url":"http://e/c2","pages":["http://x/2.jpg"]}
        ]}"#;
        let response = post_json(port, &test_token(), body);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(st.handoff_status().unwrap().received_chapters, 2);

        st.cancel_handoff();
        assert!(st.handoff_status().is_none());
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Stopped));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn disabled_setting_stops_bridge() {
        let enabled = Arc::new(AtomicBool::new(true));
        let enabled_in_server = enabled.clone();
        let (_, handle) = spawn_server(
            test_token(),
            Arc::new(AtomicBool::new(false)),
            move || enabled_in_server.load(Ordering::SeqCst),
            |_| Err(HandoffError::Internal("不应被调用".into())),
        );
        enabled.store(false, Ordering::SeqCst);
        assert!(matches!(handle.join().unwrap(), HandoffOutcome::Disabled));
    }
}
