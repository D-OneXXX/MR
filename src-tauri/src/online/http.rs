//! 阻塞 HTTP Transport：ureq + 代理 + 重试 + 响应大小上限。

use std::io::Read;
use std::time::Duration;

use crate::online::{validate_proxy, OnlineError, ONLINE_UA};

/// 一次 HTTP 请求的最终结果（含重定向后的最终 URL）。
pub struct HttpResponse {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// 页面/清单下载使用的同步传输抽象（便于测试替换）。
pub trait HttpTransport: Send + Sync {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
    ) -> Result<HttpResponse, OnlineError>;
}

/// 手动请求头：JSON 对象或单行 Cookie。
#[derive(Debug, Clone)]
pub struct RequestHeaders {
    values: Vec<(String, String)>,
}

/// Host/Content-Length/Connection/Transfer-Encoding 不允许由用户覆盖。
fn is_forbidden_header(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding"
    )
}

/// RFC 7230 token：字母/数字与 `!#$%&'*+-.^_`|~`，用于请求头名称校验。
fn is_token_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

impl RequestHeaders {
    /// 解析手动请求头；拒绝非法名称/CRLF 与 Host/Content-Length/Connection/Transfer-Encoding。
    pub fn parse(raw: &str) -> Result<Self, OnlineError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Ok(Self { values: Vec::new() });
        }
        let values: Vec<(String, String)> = if raw.starts_with('{') {
            let map: std::collections::BTreeMap<String, String> = serde_json::from_str(raw)
                .map_err(|e| OnlineError::HeaderInvalid(format!("JSON 请求头无效：{e}")))?;
            map.into_iter().collect()
        } else {
            // 单行模式只接受 Cookie；若整行以禁用头名开头（如 Host: ...）直接拒绝。
            if let Some((name, _)) = raw.split_once(':') {
                if is_forbidden_header(name) {
                    return Err(OnlineError::HeaderInvalid(format!(
                        "不允许设置 {}",
                        name.trim()
                    )));
                }
            }
            // `Cookie:` 前缀大小写不敏感，输出统一为规范的 `Cookie`。
            let cookie = match raw.split_once(':') {
                Some((name, rest)) if name.trim().eq_ignore_ascii_case("cookie") => {
                    rest.trim().to_string()
                }
                _ => raw.to_string(),
            };
            vec![("Cookie".to_string(), cookie)]
        };
        for (k, v) in &values {
            if !is_token_name(k) || v.contains('\r') || v.contains('\n') {
                return Err(OnlineError::HeaderInvalid(
                    "请求头名称或值包含非法字符".into(),
                ));
            }
            if is_forbidden_header(k) {
                return Err(OnlineError::HeaderInvalid(format!("不允许设置 {k}")));
            }
        }
        Ok(Self { values })
    }

    fn has(&self, name: &str) -> bool {
        self.values
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(name))
    }
}

/// ureq 阻塞传输实现。
pub struct UreqTransport {
    agent: ureq::Agent,
    headers: RequestHeaders,
}

struct RawResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    body: Vec<u8>,
    retry_after_s: Option<u64>,
    location: Option<String>,
}

/// 最多跟随的重定向次数；第 6 个重定向响应视为错误。
const MAX_REDIRECTS: usize = 5;

/// 主机是否相同（大小写不敏感）。
fn same_host(a: &url::Url, b: &url::Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

/// origin（scheme + host + port）是否相同；端口按 scheme 默认值归一。
fn same_origin(a: &url::Url, b: &url::Url) -> bool {
    a.scheme().eq_ignore_ascii_case(b.scheme())
        && same_host(a, b)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 解析导入源/整本书的 header scope；非法或非 http(s) 时返回 None（不发送用户头）。
fn parse_header_scope(raw: Option<&str>) -> Option<url::Url> {
    let u = url::Url::parse(raw?).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    Some(u)
}

/// 跨源时去掉 Referer 的 query 与 fragment，同源保持原样。
fn referer_value(target: &url::Url, page: &url::Url, scope: Option<&url::Url>) -> String {
    let same_referer = same_origin(target, page);
    let same_scope = scope.is_some_and(|s| same_origin(target, s));
    if same_referer && same_scope {
        page.to_string()
    } else {
        let mut u = page.clone();
        u.set_query(None);
        u.set_fragment(None);
        u.to_string()
    }
}

/// 归一化代理地址：小写 scheme；https 按 HTTP CONNECT 代理映射为 http；
/// 仅保留 http/socks5，并要求非空 host。
fn normalize_proxy(raw: &str) -> Result<Option<String>, OnlineError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    validate_proxy(raw).map_err(OnlineError::Proxy)?;
    let u = url::Url::parse(raw).map_err(|e| OnlineError::Proxy(format!("代理地址无效：{e}")))?;
    let scheme = match u.scheme() {
        "http" | "https" => "http",
        "socks5" => "socks5",
        other => {
            return Err(OnlineError::Proxy(format!(
                "代理仅支持 http/https/socks5，收到 {other}"
            )))
        }
    };
    let host = u
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| OnlineError::Proxy("代理地址缺少主机名".into()))?;
    Ok(Some(match (scheme, u.port_or_known_default()) {
        ("socks5", None) => format!("socks5://{host}"),
        (_, Some(port)) => format!("{scheme}://{host}:{port}"),
        (_, None) => format!("{scheme}://{host}"),
    }))
}

impl UreqTransport {
    pub fn new(proxy: &str, headers: &str) -> Result<Self, OnlineError> {
        let proxy = normalize_proxy(proxy)?;
        let headers = RequestHeaders::parse(headers)?;
        let mut builder = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            // 关闭 ureq 自动重定向：手动跟随以便每个 hop 重新应用请求头。
            .redirects(0)
            .user_agent(ONLINE_UA);
        if let Some(proxy) = proxy {
            let p = ureq::Proxy::new(&proxy).map_err(|e| OnlineError::Proxy(e.to_string()))?;
            builder = builder.proxy(p);
        }
        Ok(Self {
            agent: builder.build(),
            headers,
        })
    }

    /// 单次请求：应用手动请求头与派生的 Referer/Origin。
    /// 用户请求头只在目标与 header_scope 同 origin（scheme+host+port）时发送；
    /// 跨 origin 丢弃全部用户请求头（含 Cookie/Authorization/自定义密钥头），
    /// 只保留由页面 URL 派生的 Referer/Origin。
    fn execute(
        &self,
        target: &url::Url,
        scope: Option<&url::Url>,
        max_bytes: usize,
        referer: Option<&str>,
    ) -> Result<RawResponse, OnlineError> {
        let within_scope = scope.is_some_and(|s| same_origin(target, s));
        let mut req = self.agent.get(target.as_str());
        if within_scope {
            for (k, v) in &self.headers.values {
                req = req.set(k, v);
            }
        }
        if let Some(page) = referer {
            if let Ok(u) = url::Url::parse(page) {
                if matches!(u.scheme(), "http" | "https") {
                    if u.host_str().is_some() {
                        // 跨 origin 时用户头已被丢弃，必须使用派生值；
                        // 同 origin 时显式配置的同名头优先。
                        if !within_scope || !self.headers.has("referer") {
                            req = req.set("Referer", &referer_value(target, &u, scope));
                        }
                        if !within_scope || !self.headers.has("origin") {
                            let origin = u.origin().ascii_serialization();
                            req = req.set("Origin", &origin);
                        }
                    }
                }
            }
        }
        match req.call() {
            Ok(resp) => read_response(resp, target, max_bytes),
            Err(ureq::Error::Status(_, resp)) => read_response(resp, target, max_bytes),
            // Transport 的 Display/Debug 可能包含完整请求 URL/query，日志会经
            // `BackendError` 落到 `app.log`。只保留错误类别，避免泄漏查询串。
            Err(ureq::Error::Transport(t)) => {
                Err(OnlineError::Network(format!("传输失败（{:?}）", t.kind())))
            }
        }
    }

    /// 手动跟随 301/302/303/307/308；每一跳都按同一个 header_scope 判断
    /// （用户请求头只在同 origin 时发送，跨 origin 仅派生 Referer/Origin）。
    fn get_once(
        &self,
        url: &url::Url,
        max_bytes: usize,
        referer: Option<&str>,
        scope: Option<&url::Url>,
    ) -> Result<RawResponse, OnlineError> {
        let mut current = url.clone();
        for hop in 0..=MAX_REDIRECTS {
            let raw = self.execute(&current, scope, max_bytes, referer)?;
            if !is_redirect(raw.status) {
                return Ok(raw);
            }
            if hop == MAX_REDIRECTS {
                return Err(OnlineError::Network(format!(
                    "重定向次数过多（上限 {MAX_REDIRECTS} 次）"
                )));
            }
            let location = raw
                .location
                .as_deref()
                .ok_or_else(|| OnlineError::Network("重定向缺少 Location".into()))?;
            let next = current
                .join(location)
                .map_err(|e| OnlineError::Network(format!("重定向地址无效：{e}")))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(OnlineError::Network("重定向到非 HTTP(S) URL".into()));
            }
            // 重定向目标同样受输入约束：拒绝 userinfo 与超长 URL。
            if !next.username().is_empty() || next.password().is_some() {
                return Err(OnlineError::Network(
                    "重定向目标不能包含用户名或密码".into(),
                ));
            }
            if next.as_str().len() > 2048 {
                return Err(OnlineError::Network(
                    "重定向目标 URL 过长（上限 2048 字节）".into(),
                ));
            }
            current = next;
        }
        unreachable!("redirect loop always returns")
    }
}

/// 校验 URL 仅允许 http/https。
fn ensure_http_url(raw: &str) -> Result<url::Url, OnlineError> {
    let u = url::Url::parse(raw).map_err(|e| OnlineError::Network(format!("URL 无效：{e}")))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(OnlineError::Network("仅支持 http/https URL".into()));
    }
    Ok(u)
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn read_response(
    resp: ureq::Response,
    url: &url::Url,
    max_bytes: usize,
) -> Result<RawResponse, OnlineError> {
    let status = resp.status();
    let final_url = url.to_string();
    let location = resp.header("location").map(str::to_string);
    let content_type = resp.header("content-type").map(str::to_string);
    let retry_after_s = resp
        .header("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let mut body = Vec::new();
    resp.into_reader()
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut body)
        .map_err(|e| OnlineError::Network(e.to_string()))?;
    if body.len() > max_bytes {
        return Err(OnlineError::TooLarge(max_bytes));
    }
    Ok(RawResponse {
        status,
        final_url,
        content_type,
        body,
        retry_after_s,
        location,
    })
}

fn should_retry(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

impl HttpTransport for UreqTransport {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
        header_scope: Option<&str>,
    ) -> Result<HttpResponse, OnlineError> {
        let url = ensure_http_url(url)?;
        let scope = parse_header_scope(header_scope);
        for attempt in 0..=2u32 {
            match self.get_once(&url, max_bytes, referer, scope.as_ref())? {
                raw if should_retry(raw.status) && attempt < 2 => {
                    let wait_ms = raw
                        .retry_after_s
                        .map(|s| s.saturating_mul(1000))
                        .unwrap_or(if attempt == 0 { 500 } else { 1500 })
                        .min(5000);
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
                raw => {
                    return Ok(HttpResponse {
                        status: raw.status,
                        final_url: raw.final_url,
                        content_type: raw.content_type,
                        body: raw.body,
                    });
                }
            }
        }
        unreachable!("retry loop always returns")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    fn spawn_server(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            for (status, ct, body) in responses {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    408 => "Request Timeout",
                    429 => "Too Many Requests",
                    503 => "Service Unavailable",
                    _ => "Error",
                };
                let headers = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                s.write_all(headers.as_bytes()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        (format!("http://{addr}/page"), h)
    }

    #[test]
    fn reads_200_and_preserves_404_status() {
        let (url, h) = spawn_server(vec![
            (200, "image/png", b"png-bytes".to_vec()),
            (404, "text/plain", b"missing".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.content_type.as_deref(), Some("image/png"));
        assert_eq!(r.body, b"png-bytes");
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, b"missing");
        h.join().unwrap();
    }

    #[test]
    fn retries_429_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (429, "text/plain", b"slow".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn retries_408_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (408, "text/plain", b"timeout".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn retries_503_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (503, "text/plain", b"busy".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn retry_exhaustion_returns_last_503() {
        let (url, h) = spawn_server(vec![
            (503, "text/plain", b"first".to_vec()),
            (503, "text/plain", b"second".to_vec()),
            (503, "text/plain", b"third".to_vec()),
        ]);
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None, None).unwrap();
        assert_eq!(r.status, 503);
        assert_eq!(r.body, b"third");
        h.join().unwrap();
    }

    #[test]
    fn rejects_body_larger_than_limit() {
        let (url, h) = spawn_server(vec![(200, "image/png", vec![0u8; 16])]);
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get(&url, 8, None, None),
            Err(OnlineError::TooLarge(8))
        ));
        h.join().unwrap();
    }

    #[test]
    fn rejects_invalid_proxy() {
        assert!(UreqTransport::new("ftp://127.0.0.1:21", "").is_err());
        assert!(UreqTransport::new("http://user:pass@127.0.0.1:7890", "").is_err());
        assert!(UreqTransport::new("socks5://", "").is_err());
        assert!(UreqTransport::new("socks5://:1080", "").is_err());
        assert!(UreqTransport::new("http://", "").is_err());
    }

    #[test]
    fn accepts_supported_proxy_forms() {
        assert!(UreqTransport::new("http://127.0.0.1:7890", "").is_ok());
        assert!(UreqTransport::new("socks5://127.0.0.1:1080", "").is_ok());
        // 大写 scheme 与 https（按 HTTP CONNECT 代理处理）必须在构造期归一化。
        assert!(UreqTransport::new("HTTPS://127.0.0.1:7890", "").is_ok());
        assert_eq!(
            normalize_proxy("HTTPS://127.0.0.1:7890")
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            normalize_proxy("socks5://127.0.0.1:1080")
                .unwrap()
                .as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn rejects_non_http_url_without_network() {
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get("file:///C:/a.png", 1024, None, None),
            Err(OnlineError::Network(_))
        ));
        assert!(ensure_http_url("https://example.com/a.png").is_ok());
    }

    fn spawn_redirect() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let (mut s, _) = listener.accept().unwrap();
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /start "), "{req}");
            assert!(req.contains("Cookie: sid=abc"), "{req}");
            assert!(req.contains("Referer: http://gallery.example/g/1"), "{req}");
            s.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let (mut s2, _) = listener.accept().unwrap();
            let n = s2.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /final "), "{req}");
            assert!(req.contains("Cookie: sid=abc"), "{req}");
            assert!(req.contains("Referer: http://gallery.example/g/1"), "{req}");
            s2.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            )
            .unwrap();
        });
        (format!("http://{addr}/start"), h)
    }

    #[test]
    fn follows_redirect_and_reports_final_url() {
        let (url, h) = spawn_redirect();
        let t = UreqTransport::new("", "Cookie: sid=abc").unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        assert!(r.final_url.ends_with("/final"), "{}", r.final_url);
        h.join().unwrap();
    }

    /// 有界 accept：监听非阻塞 + 截止时间，避免实现异常时测试永久挂起。
    fn accept_bounded(listener: &TcpListener) -> std::net::TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        listener.set_nonblocking(true).unwrap();
        loop {
            match listener.accept() {
                Ok((s, _)) => {
                    s.set_nonblocking(false).unwrap();
                    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    s.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
                    return s;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "等待客户端请求超时");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("accept 失败：{e}"),
            }
        }
    }

    /// 只处理一次请求的 loopback hop；可返回 302 或 200，并回传收到的原始请求。
    fn spawn_hop(redirect_to: Option<String>) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut s = accept_bounded(&listener);
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            match redirect_to {
                Some(location) => {
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    s.write_all(resp.as_bytes()).unwrap();
                }
                None => {
                    s.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .unwrap();
                }
            }
            req
        });
        (format!("http://{addr}/start"), h)
    }

    /// 同源两跳：/start 302 → /final，回传第二跳的原始请求。
    fn spawn_same_origin_redirect() -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut first = accept_bounded(&listener);
            let n = first.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /start "));
            first
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            let mut second = accept_bounded(&listener);
            let n = second.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            second
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            req
        });
        (format!("http://{addr}/start"), h)
    }

    /// 读取原始请求中的指定请求头（名称大小写不敏感）。
    fn header_value<'a>(req: &'a str, name: &str) -> Option<&'a str> {
        req.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.eq_ignore_ascii_case(name) {
                Some(v.trim())
            } else {
                None
            }
        })
    }

    const CREDENTIAL_HEADERS: &str = r#"{"Cookie":"sid=abc","Authorization":"Bearer secret","X-Test":"yes","X-Api-Key":"secret-key"}"#;

    #[test]
    fn redirect_same_host_other_port_drops_all_user_headers() {
        // 同主机不同端口即跨 origin：所有用户请求头都不得重放。
        let (target_url, target_h) = spawn_hop(None);
        let (start_url, start_h) = spawn_hop(Some(target_url));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), Some("sid=abc"));
        assert_eq!(header_value(&first, "authorization"), Some("Bearer secret"));
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), None, "{second}");
        assert_eq!(header_value(&second, "authorization"), None, "{second}");
        assert_eq!(header_value(&second, "x-test"), None, "{second}");
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_cross_host_drops_all_user_headers() {
        // 127.0.0.1 → localhost 视为跨主机：Cookie、Authorization 与自定义头都丢弃。
        let (target_url, target_h) = spawn_hop(None);
        let port = url::Url::parse(&target_url).unwrap().port().unwrap();
        let (start_url, start_h) = spawn_hop(Some(format!("http://localhost:{port}/final")));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), Some("sid=abc"));
        assert_eq!(header_value(&first, "authorization"), Some("Bearer secret"));
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), None, "{second}");
        assert_eq!(header_value(&second, "authorization"), None, "{second}");
        assert_eq!(header_value(&second, "x-test"), None, "{second}");
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_cross_host_drops_api_key() {
        // 自定义密钥头（X-Api-Key）跨主机时同样不得重放。
        let (target_url, target_h) = spawn_hop(None);
        let port = url::Url::parse(&target_url).unwrap().port().unwrap();
        let (start_url, start_h) = spawn_hop(Some(format!("http://localhost:{port}/final")));
        let t = UreqTransport::new("", r#"{"X-Api-Key":"secret-key"}"#).unwrap();
        let r = t
            .get(&start_url, 1024, None, Some(start_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = start_h.join().unwrap();
        assert_eq!(header_value(&first, "x-api-key"), Some("secret-key"));
        let second = target_h.join().unwrap();
        assert_eq!(header_value(&second, "x-api-key"), None, "{second}");
    }

    #[test]
    fn redirect_same_origin_keeps_cookie_and_authorization() {
        let (url, h) = spawn_same_origin_redirect();
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        let second = h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), Some("sid=abc"));
        assert_eq!(
            header_value(&second, "authorization"),
            Some("Bearer secret")
        );
        assert_eq!(header_value(&second, "x-test"), Some("yes"));
        assert_eq!(header_value(&second, "x-api-key"), Some("secret-key"));
    }

    #[test]
    fn rejects_redirect_target_with_userinfo() {
        let (start_url, h) = spawn_hop(Some("http://user:pass@127.0.0.1:1/final".into()));
        let t = UreqTransport::new("", "").unwrap();
        let msg = match t.get(&start_url, 1024, None, None) {
            Ok(_) => panic!("重定向目标含 userinfo 时应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.contains("用户名或密码"), "{msg}");
        h.join().unwrap();
    }

    #[test]
    fn rejects_overlong_redirect_target() {
        let target = format!("http://127.0.0.1:1/{}", "a".repeat(2100));
        let (start_url, h) = spawn_hop(Some(target));
        let t = UreqTransport::new("", "").unwrap();
        let msg = match t.get(&start_url, 1024, None, None) {
            Ok(_) => panic!("重定向目标超长时应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.contains("2048 字节"), "{msg}");
        h.join().unwrap();
    }

    #[test]
    fn rejects_more_than_five_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            for _ in 0..6 {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                s.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            }
        });
        let t = UreqTransport::new("", "").unwrap();
        let err = match t.get(&format!("http://{addr}/loop"), 1024, None, None) {
            Ok(_) => panic!("超过 5 次重定向应报错"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(err.contains("重定向"), "{err}");
        h.join().unwrap();
    }

    #[test]
    fn transport_failure_message_excludes_url_and_query() {
        // 预留 loopback 端口后立即释放，保证连接被拒绝；不访问公网。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let t = UreqTransport::new("", "").unwrap();
        let url = format!("http://127.0.0.1:{port}/x?token=secret");
        let msg = match t.get(&url, 1024, None, None) {
            Ok(_) => panic!("连接被拒绝时应返回错误"),
            Err(OnlineError::Network(msg)) => msg,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(msg.starts_with("传输失败（"), "{msg}");
        assert!(!msg.contains("token=secret"), "{msg}");
        assert!(!msg.contains("/x?"), "{msg}");
    }

    #[test]
    fn parses_headers_and_rejects_forbidden() {
        assert!(RequestHeaders::parse("").is_ok());
        assert!(RequestHeaders::parse("Cookie: a=b").is_ok());
        assert!(RequestHeaders::parse("a=b").is_ok());
        assert!(RequestHeaders::parse(r#"{"Authorization":"Bearer x"}"#).is_ok());
        assert!(RequestHeaders::parse("Host: example.com").is_err());
        assert!(RequestHeaders::parse("content-length: 1").is_err());
        assert!(RequestHeaders::parse("Connection: keep-alive").is_err());
        assert!(RequestHeaders::parse("Transfer-Encoding: chunked").is_err());
        assert!(RequestHeaders::parse("X-Test: a\r\nInjected: b").is_err());
        assert!(RequestHeaders::parse("{\"X\\r\\nInjected\":\"b\"}").is_err());
        assert!(RequestHeaders::parse(r#"{"":"x"}"#).is_err());
        assert!(RequestHeaders::parse("{not-json}").is_err());
        // 请求头名称必须是 RFC 7230 token：空格、控制符、分隔符均拒绝。
        assert!(RequestHeaders::parse(r#"{"Bad Name":"x"}"#).is_err());
        assert!(RequestHeaders::parse("{\"X\\tY\":\"x\"}").is_err());
        assert!(RequestHeaders::parse(r#"{"X@Y":"x"}"#).is_err());
        assert!(RequestHeaders::parse(r#"{"X[Y":"x"}"#).is_err());
    }

    fn spawn_header_server(expected: &'static [&'static str]) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            let ok = expected.iter().all(|e| req.contains(e));
            let resp = if ok {
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
            } else {
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            s.write_all(resp.as_bytes()).unwrap();
        });
        (format!("http://{addr}/x"), h)
    }

    #[test]
    fn sends_custom_headers_and_referer() {
        let (url, h) = spawn_header_server(&[
            "X-Test: yes",
            "Referer: http://gallery.example/g/1",
            "Origin: http://gallery.example",
        ]);
        let t = UreqTransport::new("", r#"{"X-Test":"yes"}"#).unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn cookie_prefix_strip_is_case_insensitive() {
        assert_eq!(
            RequestHeaders::parse("CoOkIe: sid=xyz").unwrap().values,
            vec![("Cookie".to_string(), "sid=xyz".to_string())]
        );
        // 线上请求头也必须是规范的 `Cookie` 名与去掉前缀后的值。
        let (url, h) = spawn_header_server(&["Cookie: sid=xyz"]);
        let t = UreqTransport::new("", "COOKIE: sid=xyz").unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn explicit_referer_and_origin_win() {
        let (url, h) = spawn_header_server(&[
            "Referer: http://mine.example/page",
            "Origin: http://mine.example",
        ]);
        let t = UreqTransport::new(
            "",
            r#"{"Referer":"http://mine.example/page","Origin":"http://mine.example"}"#,
        )
        .unwrap();
        let r = t
            .get(
                &url,
                1024,
                Some("http://gallery.example/g/1"),
                Some(url.as_str()),
            )
            .unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn same_scope_page_sends_user_headers() {
        let (url, h) = spawn_header_server(&[
            "Cookie: sid=abc",
            "Authorization: Bearer secret",
            "X-Api-Key: secret-key",
        ]);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t.get(&url, 1024, None, Some(url.as_str())).unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }

    #[test]
    fn cross_scope_page_drops_user_headers() {
        let (url, h) = spawn_hop(None);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&url, 1024, None, Some("http://gallery.example/g/1"))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        for name in ["cookie", "authorization", "x-test", "x-api-key"] {
            assert_eq!(header_value(&req, name), None, "{req}");
        }
    }

    #[test]
    fn invalid_header_scope_sends_no_user_headers() {
        let (url, h) = spawn_hop(None);
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&url, 1024, None, Some("not a valid absolute url"))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        for name in ["cookie", "authorization", "x-test", "x-api-key"] {
            assert_eq!(header_value(&req, name), None, "{req}");
        }
    }

    #[test]
    fn cross_origin_referer_drops_query_and_fragment() {
        let (url, h) = spawn_hop(None);
        let referer = "http://gallery.example/g/1?token=secret#frag";
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, Some(referer), Some(referer)).unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "referer"),
            Some("http://gallery.example/g/1"),
            "{req}"
        );
        assert!(!req.contains("token=secret"), "{req}");
        assert!(!req.contains("#frag"), "{req}");
    }

    #[test]
    fn origin_header_includes_non_default_port_and_keeps_same_origin_referer() {
        let (url, h) = spawn_hop(None);
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        let referer = format!("{url}?token=secret#frag");
        let t = UreqTransport::new("", "").unwrap();
        let r = t
            .get(&url, 1024, Some(&referer), Some(url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let req = h.join().unwrap();
        assert_eq!(
            header_value(&req, "origin"),
            Some(format!("http://127.0.0.1:{port}").as_str()),
            "{req}"
        );
        assert_eq!(
            header_value(&req, "referer"),
            Some(referer.as_str()),
            "{req}"
        );
    }

    #[test]
    fn redirect_from_cross_scope_to_same_scope_restores_user_headers() {
        let (same_scope_url, same_scope_h) = spawn_hop(None);
        let (cross_scope_url, cross_scope_h) = spawn_hop(Some(same_scope_url.clone()));
        let t = UreqTransport::new("", CREDENTIAL_HEADERS).unwrap();
        let r = t
            .get(&cross_scope_url, 1024, None, Some(same_scope_url.as_str()))
            .unwrap();
        assert_eq!(r.status, 200);
        let first = cross_scope_h.join().unwrap();
        assert_eq!(header_value(&first, "cookie"), None, "{first}");
        let second = same_scope_h.join().unwrap();
        assert_eq!(header_value(&second, "cookie"), Some("sid=abc"), "{second}");
        assert_eq!(
            header_value(&second, "authorization"),
            Some("Bearer secret"),
            "{second}"
        );
    }
}
