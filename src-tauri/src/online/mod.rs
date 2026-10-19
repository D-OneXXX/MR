//! 在线源公共类型、URL 规范化、阻塞信号量与错误。
//!
//! 统一解析入口见 [`resolve`]：一次拉取后先试 JSON 清单，再试单页 HTML 图集。

pub mod direct;
pub mod html;
pub mod http;

use std::sync::{Condvar, Mutex};

use crate::source::BackendError;

/// 单本清单 JSON 的字节上限（2 MiB）。
pub const MANIFEST_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 单页图片的字节上限（32 MiB）。
pub const PAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 单本在线书的最大页数。
pub const MAX_PAGES: usize = 5000;
/// 在线请求使用的 User-Agent。
pub const ONLINE_UA: &str = "MangaReader/0.1 online-direct";

/// 单个页面引用（URL + 可选尺寸提示）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PageRef {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// 在线书缓存元数据（camelCase 落盘，与前端契约一致）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMeta {
    pub schema: u32,
    pub manifest_hash: String,
    pub fetched_at: String,
    pub pages: Vec<PageRef>,
}

/// 在线源内部错误（最终统一映射为 [`BackendError::Network`]）。
#[derive(Debug, thiserror::Error)]
pub enum OnlineError {
    // 最终由 BackendError::Network 统一加"网络错误："前缀，此处不再重复。
    #[error("{0}")]
    Network(String),
    #[error("代理无效：{0}")]
    Proxy(String),
    #[error("请求头无效：{0}")]
    HeaderInvalid(String),
    #[error("响应过大（上限 {0} 字节）")]
    TooLarge(usize),
}

impl From<OnlineError> for BackendError {
    fn from(e: OnlineError) -> Self {
        BackendError::Network(e.to_string())
    }
}

/// 规范化外部 URL：仅允许 http/https、拒绝 userinfo、去掉 fragment、限制 2048 字节。
pub fn normalize_url(raw: &str) -> Result<url::Url, BackendError> {
    let raw = raw.trim();
    if raw.len() > 2048 {
        return Err(BackendError::Msg("URL 过长（上限 2048 字节）".into()));
    }
    let mut u = url::Url::parse(raw)
        .map_err(|e| BackendError::Msg(format!("URL 无效：{e}")))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(BackendError::Msg("仅支持 http/https URL".into()));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(BackendError::Msg("URL 不能包含用户名或密码".into()));
    }
    u.set_fragment(None);
    Ok(u)
}

/// 从 URL 推导书名：优先倒数第一个非空路径段（解码），否则退回主机名。
pub fn title_from_url(u: &url::Url) -> String {
    u.path_segments()
        .and_then(|s| s.filter(|x| !x.is_empty()).last())
        .map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| u.host_str().unwrap_or("在线漫画").to_string())
}

/// 页面显示名：优先 URL 文件名（解码），否则用一基序号。
pub fn page_name(p: &PageRef, index: usize) -> String {
    url::Url::parse(&p.url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|s| s.filter(|x| !x.is_empty()).last())
                .map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("第 {} 页", index + 1))
}

/// 统一在线解析入口：只拉取一次，先按 JSON 清单解析，失败后尝试单页 HTML 图集。
pub fn resolve(
    http: &dyn http::HttpTransport,
    raw_url: &str,
) -> Result<direct::OnlineBookMeta, BackendError> {
    let url = normalize_url(raw_url)?;
    let resp = http.get(url.as_str(), MANIFEST_MAX_BYTES, None)?;
    if !(200..300).contains(&resp.status) {
        return Err(BackendError::Network(format!(
            "内容 HTTP {}：{}",
            resp.status, resp.final_url
        )));
    }
    // 书身份保持用户请求的规范化 URL；HTML 相对图片与标题回退则使用重定向后的最终 URL。
    // final_url 非法时退回请求 URL，避免因传输层给出的异常值中断解析。
    let base_url = normalize_url(&resp.final_url).unwrap_or_else(|_| url.clone());
    match direct::parse_manifest(&resp.body, &url) {
        Ok(meta) => Ok(meta),
        Err(json_err) => match html::parse_gallery(&resp.body, &base_url, &url) {
            Ok(meta) => Ok(meta),
            Err(html_err) => Err(BackendError::Msg(format!(
                "无法解析为 JSON 或 HTML 图集：JSON={json_err}; HTML={html_err}"
            ))),
        },
    }
}

/// 按字符（非字节）截断，避免切断多字节字符。
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 日志脱敏：只保留 scheme/host/path，去掉 query 与 fragment。
/// 解析失败时退化为按首个 `?` / `#` 截断。
pub fn redact_url_for_log(raw: &str) -> String {
    if let Ok(mut u) = url::Url::parse(raw) {
        u.set_query(None);
        u.set_fragment(None);
        return u.to_string();
    }
    let cut = raw.find(|c| c == '?' || c == '#').unwrap_or(raw.len());
    raw[..cut].to_string()
}

/// 校验代理地址：空=直连；仅支持 http/https/socks5，且不允许 userinfo。
pub fn validate_proxy(raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(());
    }
    let u = url::Url::parse(raw).map_err(|e| format!("代理地址无效：{e}"))?;
    if !matches!(u.scheme(), "http" | "https" | "socks5") {
        return Err("代理仅支持 http/https/socks5".into());
    }
    if u.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("代理地址缺少主机名".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("代理地址不能包含用户名或密码".into());
    }
    Ok(())
}

/// 校验手动请求头：JSON 对象或单行 Cookie（供 set_settings 调用）。
pub fn validate_headers(raw: &str) -> Result<(), String> {
    http::RequestHeaders::parse(raw)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 基于条件变量的阻塞信号量（并发上限夹取到 1..=8）。
pub struct BlockingSemaphore {
    limit: usize,
    used: Mutex<usize>,
    cv: Condvar,
}

impl BlockingSemaphore {
    pub fn new(limit: usize) -> Self {
        Self {
            limit: limit.clamp(1, 8),
            used: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    /// 获取许可；达到上限时阻塞等待。
    pub fn acquire(&self) -> SemaphoreGuard<'_> {
        let mut used = self.used.lock().unwrap();
        while *used >= self.limit {
            used = self.cv.wait(used).unwrap();
        }
        *used += 1;
        SemaphoreGuard { sem: self }
    }

    fn release(&self) {
        let mut used = self.used.lock().unwrap();
        *used = used.saturating_sub(1);
        self.cv.notify_one();
    }
}

/// 许可守卫：析构时归还信号量。
#[must_use = "丢弃守卫会立刻释放许可"]
pub struct SemaphoreGuard<'a> {
    sem: &'a BlockingSemaphore,
}

impl Drop for SemaphoreGuard<'_> {
    fn drop(&mut self) {
        self.sem.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn normalize_url_strips_fragment_and_rejects_file() {
        let u = normalize_url(" HTTPS://Example.COM/a?x=1#frag ").unwrap();
        assert_eq!(u.as_str(), "https://example.com/a?x=1");
        assert!(normalize_url("file:///C:/a.jpg").is_err());
        assert!(normalize_url("http://user:pass@example.com/a").is_err());
    }

    #[test]
    fn redact_url_for_log_strips_query_and_fragment() {
        assert_eq!(
            redact_url_for_log("https://example.com/a/b?token=secret#frag"),
            "https://example.com/a/b"
        );
        assert_eq!(
            redact_url_for_log("http://example.com:8080/gallery/1?x=1"),
            "http://example.com:8080/gallery/1"
        );
        // 非法 URL 退化为按首个 ? / # 截断。
        assert_eq!(redact_url_for_log("not a url?x=1#f"), "not a url");
        assert_eq!(redact_url_for_log("plain#frag"), "plain");
        assert_eq!(redact_url_for_log("plain"), "plain");
    }

    #[test]
    fn title_falls_back_to_path_then_host() {
        let u = url::Url::parse("https://example.com/gallery/123/").unwrap();
        assert_eq!(title_from_url(&u), "123");
        let u = url::Url::parse("https://example.com/").unwrap();
        assert_eq!(title_from_url(&u), "example.com");
    }

    #[test]
    fn page_name_uses_filename_or_index() {
        let p = PageRef { url: "https://x/a/001.jpg".into(), width: None, height: None };
        assert_eq!(page_name(&p, 0), "001.jpg");
        let p = PageRef { url: "https://x/".into(), width: None, height: None };
        assert_eq!(page_name(&p, 2), "第 3 页");
    }

    #[test]
    fn proxy_validation_accepts_empty_and_socks5() {
        assert!(validate_proxy("").is_ok());
        assert!(validate_proxy("socks5://127.0.0.1:1080").is_ok());
        assert!(validate_proxy("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy("ftp://127.0.0.1:21").is_err());
        assert!(validate_proxy("http://user:pass@127.0.0.1:7890").is_err());
    }

    #[test]
    fn proxy_requires_nonempty_host() {
        assert!(validate_proxy("socks5://").is_err());
        assert!(validate_proxy("socks5://:1080").is_err());
        assert!(validate_proxy("http://").is_err());
    }

    #[test]
    fn network_error_has_single_prefix() {
        let e: BackendError = OnlineError::Network("连接失败".into()).into();
        assert_eq!(e.to_string(), "网络错误：连接失败");
    }

    #[test]
    fn url_length_limit_reports_bytes() {
        let raw = format!("http://example.com/{}", "a".repeat(2048));
        let e = normalize_url(&raw).unwrap_err().to_string();
        assert!(e.contains("2048 字节"), "{e}");
    }

    #[test]
    fn semaphore_limits_concurrency() {
        let sem = Arc::new(BlockingSemaphore::new(1));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let sem = sem.clone();
            let active = active.clone();
            let peak = peak.clone();
            handles.push(std::thread::spawn(move || {
                let _guard = sem.acquire();
                let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }

    struct StubTransport {
        status: u16,
        body: Vec<u8>,
        final_url: String,
        calls: AtomicUsize,
    }

    impl StubTransport {
        fn ok(body: &[u8]) -> Self {
            Self {
                status: 200,
                body: body.to_vec(),
                final_url: "http://example.com/final".into(),
                calls: AtomicUsize::new(0),
            }
        }

        fn with_final_url(mut self, final_url: &str) -> Self {
            self.final_url = final_url.into();
            self
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl http::HttpTransport for StubTransport {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
        ) -> Result<http::HttpResponse, OnlineError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(http::HttpResponse {
                status: self.status,
                final_url: self.final_url.clone(),
                content_type: None,
                body: self.body.clone(),
            })
        }
    }

    #[test]
    fn resolve_prefers_json_over_html() {
        // JSON 里故意夹带 <img>：若先走 HTML 解析会得到 2 页，因此 1 页即证明 JSON 优先。
        let t = StubTransport::ok(
            br#"{"title":"JSON","pages":["http://x/1.jpg"],"note":"<img src='http://x/2.jpg'>"}"#,
        );
        let meta = resolve(&t, "http://example.com/manifest.json").unwrap();
        assert_eq!(meta.title, "JSON");
        assert_eq!(meta.page_count, 1);
        assert_eq!(t.calls(), 1);
    }

    #[test]
    fn resolve_falls_back_to_html() {
        let t = StubTransport::ok(
            br#"<html><head><title>HTML</title></head><body><img src="/1.png"></body></html>"#,
        );
        let meta = resolve(&t, "http://example.com/gallery").unwrap();
        assert_eq!(meta.title, "HTML");
        assert_eq!(meta.page_count, 1);
        assert_eq!(t.calls(), 1);
    }

    #[test]
    fn resolve_uses_final_url_for_relative_images_but_keeps_canonical_url() {
        let t = StubTransport::ok(br#"<html><body><img src="2.png"></body></html>"#)
            .with_final_url("http://cdn.example/dir/final.html");
        let meta = resolve(&t, "http://example.com/request").unwrap();
        // 书名身份保持用户请求的规范化 URL，不随重定向变化。
        assert_eq!(meta.canonical_url, "http://example.com/request");
        // 无 <title> 时标题也按最终 URL 推导。
        assert_eq!(meta.title, "final.html");
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://cdn.example/dir/2.png");
        assert_eq!(t.calls(), 1);
    }

    #[test]
    fn resolve_reports_both_parse_failures() {
        let t = StubTransport::ok(b"plain text, no manifest and no images");
        let err = resolve(&t, "http://example.com/x").unwrap_err().to_string();
        assert!(err.contains("无法解析为 JSON 或 HTML 图集"), "{err}");
        assert!(err.contains("JSON="), "{err}");
        assert!(err.contains("HTML="), "{err}");
        assert_eq!(t.calls(), 1);
    }

    #[test]
    fn resolve_rejects_non_2xx() {
        let t = StubTransport {
            status: 404,
            body: b"missing".to_vec(),
            ..StubTransport::ok(b"")
        };
        let err = resolve(&t, "http://example.com/x").unwrap_err().to_string();
        assert!(err.contains("404"), "{err}");
    }
}
