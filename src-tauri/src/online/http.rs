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

impl RequestHeaders {
    /// 解析手动请求头；拒绝 CR/LF 与 Host/Content-Length/Connection/Transfer-Encoding。
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
            let cookie = raw
                .strip_prefix("Cookie:")
                .or_else(|| raw.strip_prefix("cookie:"))
                .unwrap_or(raw)
                .trim()
                .to_string();
            vec![("Cookie".to_string(), cookie)]
        };
        for (k, v) in &values {
            if k.trim().is_empty()
                || k.contains('\r')
                || k.contains('\n')
                || v.contains('\r')
                || v.contains('\n')
            {
                return Err(OnlineError::HeaderInvalid("请求头包含非法字符".into()));
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
}

impl UreqTransport {
    pub fn new(proxy: &str, headers: &str) -> Result<Self, OnlineError> {
        validate_proxy(proxy).map_err(OnlineError::Proxy)?;
        let headers = RequestHeaders::parse(headers)?;
        let mut builder = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirects(5)
            .user_agent(ONLINE_UA);
        if !proxy.trim().is_empty() {
            let p =
                ureq::Proxy::new(proxy.trim()).map_err(|e| OnlineError::Proxy(e.to_string()))?;
            builder = builder.proxy(p);
        }
        Ok(Self {
            agent: builder.build(),
            headers,
        })
    }

    fn get_once(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
    ) -> Result<RawResponse, OnlineError> {
        let mut req = self.agent.get(url);
        for (k, v) in &self.headers.values {
            req = req.set(k, v);
        }
        if let Some(page) = referer {
            if let Ok(u) = url::Url::parse(page) {
                if matches!(u.scheme(), "http" | "https") {
                    if let Some(host) = u.host_str() {
                        if !self.headers.has("referer") {
                            req = req.set("Referer", page);
                        }
                        if !self.headers.has("origin") {
                            let origin = format!("{}://{}", u.scheme(), host);
                            req = req.set("Origin", &origin);
                        }
                    }
                }
            }
        }
        match req.call() {
            Ok(resp) => read_response(resp, max_bytes),
            Err(ureq::Error::Status(_, resp)) => read_response(resp, max_bytes),
            Err(ureq::Error::Transport(t)) => Err(OnlineError::Network(t.to_string())),
        }
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

fn read_response(resp: ureq::Response, max_bytes: usize) -> Result<RawResponse, OnlineError> {
    let status = resp.status();
    let final_url = resp.get_url().to_string();
    // 重定向后的最终 URL 必须仍是 HTTP(S)。
    ensure_http_url(&final_url)
        .map_err(|_| OnlineError::Network("重定向到非 HTTP(S) URL".into()))?;
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
    })
}

fn should_retry(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

impl HttpTransport for UreqTransport {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
    ) -> Result<HttpResponse, OnlineError> {
        ensure_http_url(url)?;
        for attempt in 0..=2u32 {
            match self.get_once(url, max_bytes, referer)? {
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
        let r = t.get(&url, 1024, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.content_type.as_deref(), Some("image/png"));
        assert_eq!(r.body, b"png-bytes");
        let r = t.get(&url, 1024, None).unwrap();
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
        let r = t.get(&url, 1024, None).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn rejects_body_larger_than_limit() {
        let (url, h) = spawn_server(vec![(200, "image/png", vec![0u8; 16])]);
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get(&url, 8, None),
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
    fn rejects_non_http_url_without_network() {
        let t = UreqTransport::new("", "").unwrap();
        assert!(matches!(
            t.get("file:///C:/a.png", 1024, None),
            Err(OnlineError::Network(_))
        ));
        assert!(ensure_http_url("https://example.com/a.png").is_ok());
    }

    fn spawn_redirect() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            s.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let (mut s2, _) = listener.accept().unwrap();
            let _ = s2.read(&mut buf);
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
        let t = UreqTransport::new("", "").unwrap();
        let r = t.get(&url, 1024, None).unwrap();
        assert_eq!(r.status, 200);
        assert!(r.final_url.ends_with("/final"));
        h.join().unwrap();
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
            .get(&url, 1024, Some("http://gallery.example/g/1"))
            .unwrap();
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
            .get(&url, 1024, Some("http://gallery.example/g/1"))
            .unwrap();
        assert_eq!(r.status, 200);
        h.join().unwrap();
    }
}
