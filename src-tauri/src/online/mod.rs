//! 在线源公共类型、URL 规范化、阻塞信号量与错误。
//!
//! 统一解析入口见 [`resolve`]：一次拉取后先试 JSON 清单，再试单页 HTML 图集。

pub mod direct;
pub mod filter;
pub mod handoff;
pub mod html;
pub mod http;
pub mod telegram;

use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{Condvar, Mutex};

use crate::source::BackendError;

/// 单本清单 JSON 的字节上限（2 MiB）。
pub const MANIFEST_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 单页图片的字节上限（32 MiB）。
pub const PAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 单本在线书的最大页数。
pub const MAX_PAGES: usize = 5000;
/// 在线请求使用的标准桌面浏览器 User-Agent（防盗链图床常按 UA 拒绝自定义客户端）。
pub const ONLINE_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/// Telegram 等会过期的图片源坐标；图片直链失效时按此重新解析。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageAnchor {
    pub channel: String,
    pub message_id: i64,
    #[serde(default)]
    pub photo_index: u32,
    /// 刷新消息页的 origin（生产为 https://t.me；本地夹具可指向隔离服务）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_base: Option<String>,
}

/// 单个页面引用（URL + 可选尺寸提示 + 过期源锚点）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PageRef {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<PageAnchor>,
}

/// 在线书缓存元数据（camelCase 落盘，与前端契约一致）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMeta {
    pub schema: u32,
    pub manifest_hash: String,
    pub fetched_at: String,
    pub pages: Vec<PageRef>,
    /// 同一系列的稳定标识；旧 meta_json 缺省为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    /// 系列显示名；合集清单的 seriesTitle。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_title: Option<String>,
    /// 合集内的 1-based 章节序号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_index: Option<u32>,
    /// 下一话的规范化 URL；旧 meta_json 缺省为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
    /// 被提纯引擎剔除的页面，供“已过滤杂图抽屉”展示与恢复。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filtered: Vec<filter::FilteredPage>,
    /// 上次解析学到的站点档案（只读展示/调试用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_profile: Option<filter::SiteProfile>,
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
    #[error("响应过大（上限 {0} 字节）（online-fetch-failed）")]
    TooLarge(usize),
}

impl From<OnlineError> for BackendError {
    fn from(e: OnlineError) -> Self {
        BackendError::Network(e.to_string())
    }
}

/// 仅 debug/单元测试可通过显式环境变量放行回环夹具；release 永远拒绝。
pub(crate) fn allow_loopback_for_dev() -> bool {
    cfg!(test)
        || (cfg!(debug_assertions)
            && std::env::var_os("MR_ALLOW_LOOPBACK_ONLINE").is_some())
}

/// 私网 / link-local / 元数据 / 保留地址阻断。
pub(crate) fn is_blocked_ip(ip: IpAddr, allow_loopback: bool) -> bool {
    if ip.is_loopback() {
        return !allow_loopback;
    }
    if ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                // 100.64.0.0/10 CGNAT
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                // 0.0.0.0/8
                || octets[0] == 0
                // 224.0.0.0/4 及以上为组播/保留
                || octets[0] >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4), allow_loopback);
            }
            v6.is_unique_local() || v6.is_unicast_link_local()
        }
    }
}

/// 对字面 IP / localhost 做早期校验；域名解析留给 HTTP transport 在每跳执行。
pub(crate) fn validate_host_literal(
    host: &str,
    allow_loopback: bool,
) -> Result<(), String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip, allow_loopback) {
            return Err("目标地址位于本机/私网/链路本地，已拒绝（online-blocked-address）".to_string());
        }
        return Ok(());
    }
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        if !allow_loopback {
            return Err("目标地址指向 localhost，已拒绝（online-blocked-address）".to_string());
        }
    }
    Ok(())
}

/// 规范化外部 URL：仅允许 http/https、拒绝 userinfo、去掉 fragment、限制 2048 字节。
pub fn normalize_url(raw: &str) -> Result<url::Url, BackendError> {
    let raw = raw.trim();
    if raw.len() > 2048 {
        return Err(BackendError::Msg(
            "URL 过长（上限 2048 字节）（online-url-invalid）".into(),
        ));
    }
    let mut u = url::Url::parse(raw)
        .map_err(|e| BackendError::Msg(format!("URL 无效：{e}（online-url-invalid）")))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(BackendError::Msg(
            "仅支持 http/https URL（online-url-invalid）".into(),
        ));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(BackendError::Msg(
            "URL 不能包含用户名或密码（online-url-invalid）".into(),
        ));
    }
    validate_host_literal(
        u.host_str().unwrap_or_default(),
        allow_loopback_for_dev(),
    )
    .map_err(BackendError::Msg)?;
    u.set_fragment(None);
    Ok(u)
}

/// 批量导入共用的页面 URL 整理：逐个规范化、保序去重、1..=MAX_PAGES。
pub fn normalize_page_urls(page_urls: &[String]) -> Result<Vec<PageRef>, BackendError> {
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    for (index, raw) in page_urls.iter().enumerate() {
        let page = normalize_url(raw)
            .map_err(|e| BackendError::Msg(format!("第 {} 页 URL 非法：{e}", index + 1)))?;
        let page = page.to_string();
        if seen.insert(page.clone()) {
            pages.push(PageRef {
                url: page,
                width: None,
                height: None,
                anchor: None,
            });
        }
    }
    if pages.is_empty() {
        return Err(BackendError::Msg(
            "页面列表不能为空（online-url-invalid）".into(),
        ));
    }
    if pages.len() > MAX_PAGES {
        return Err(BackendError::Msg(format!(
            "页面数量超过上限 {MAX_PAGES}（online-too-many-pages）"
        )));
    }
    Ok(pages)
}

/// 从 URL 推导书名：优先倒数第一个非空路径段（解码），否则退回主机名。
pub fn title_from_url(u: &url::Url) -> String {
    u.path_segments()
        .and_then(|s| s.filter(|x| !x.is_empty()).last())
        .map(|s| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8_lossy()
                .to_string()
        })
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
                .map(|s| {
                    percent_encoding::percent_decode_str(s)
                        .decode_utf8_lossy()
                        .to_string()
                })
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("第 {} 页", index + 1))
}

/// 统一在线解析入口：Telegram/Telegraph 走专用 Provider；其余只拉取一次，
/// 先按 JSON 清单解析，失败后尝试单页 HTML 图集。
pub fn resolve(
    http: &dyn http::HttpTransport,
    raw_url: &str,
) -> Result<direct::OnlineBookMeta, BackendError> {
    resolve_with(
        http,
        raw_url,
        &filter::FilterMemory::default(),
        &filter::FilterThresholds {
            // 兼容入口不做额外图片探测；生产命令层使用默认 true。
            probe_missing_dimensions: false,
            ..filter::FilterThresholds::default()
        },
    )
}

/// 带站点学习记忆的解析入口；命令层负责从 SQLite 读取/写回档案与规则。
pub fn resolve_with(
    http: &dyn http::HttpTransport,
    raw_url: &str,
    memory: &filter::FilterMemory,
    thresholds: &filter::FilterThresholds,
) -> Result<direct::OnlineBookMeta, BackendError> {
    // `tg://` 不是 http(s)，必须在 normalize_url 之前识别。
    if telegram::is_telegram_url(raw_url) {
        return telegram::resolve_book(http, raw_url.trim(), memory, thresholds);
    }
    let url = normalize_url(raw_url)?;
    let resp = http.get(url.as_str(), MANIFEST_MAX_BYTES, None, Some(url.as_str()))?;
    if !(200..300).contains(&resp.status) {
        return Err(BackendError::Network(format!(
            "内容 HTTP {}：{}（online-fetch-failed）",
            resp.status,
            redact_url_for_log(&resp.final_url)
        )));
    }
    // 书身份保持用户请求的规范化 URL；HTML 相对图片与标题回退则使用重定向后的最终 URL。
    // final_url 非法时退回请求 URL，避免因传输层给出的异常值中断解析。
    let base_url = normalize_url(&resp.final_url).unwrap_or_else(|_| url.clone());
    // 只有正文根本不是 JSON 时才回退 HTML；合法 JSON 但清单语义错误
    // （版本、页数、页 URL 非法等）必须原样返回清单错误，避免误当图集导入。
    let body_is_json = serde_json::from_slice::<serde_json::Value>(&resp.body).is_ok();
    let mut effective_memory = memory.clone();
    if effective_memory.host.is_empty() {
        effective_memory.host = filter::url_host(url.as_str());
    }
    match direct::parse_manifest_with(&resp.body, &url, http, &effective_memory, thresholds) {
        Ok(meta) => Ok(meta),
        Err(json_err) if body_is_json => Err(json_err),
        Err(json_err) => match html::parse_gallery_with(
            &resp.body,
            &base_url,
            &url,
            http,
            &effective_memory,
            thresholds,
        ) {
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

/// 日志脱敏：只保留 scheme/host/path，去掉 userinfo、query 与 fragment。
/// 解析失败时退化为按首个 `?` / `#` 截断，并尽力去掉 authority 中的 userinfo。
pub fn redact_url_for_log(raw: &str) -> String {
    if let Ok(mut u) = url::Url::parse(raw) {
        // 先移除密码再移除用户名；两者都为空时序列化不会输出 `@`。
        let _ = u.set_password(None);
        let _ = u.set_username("");
        u.set_query(None);
        u.set_fragment(None);
        return u.to_string();
    }
    let cut = raw.find(|c| c == '?' || c == '#').unwrap_or(raw.len());
    let s = &raw[..cut];
    if let Some(scheme_end) = s.find("://") {
        let authority_start = scheme_end + 3;
        let authority_end = s[authority_start..]
            .find('/')
            .map(|i| authority_start + i)
            .unwrap_or(s.len());
        if let Some(at) = s[authority_start..authority_end].rfind('@') {
            return format!(
                "{}{}",
                &s[..authority_start],
                &s[authority_start + at + 1..]
            );
        }
    }
    s.to_string()
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
    use std::sync::{Arc, Mutex};
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
        // userinfo 同样不能进入日志。
        assert_eq!(
            redact_url_for_log("https://user:pass@example.com/a?token=secret#frag"),
            "https://example.com/a"
        );
        assert_eq!(
            redact_url_for_log("http://alice@example.com:8080/a"),
            "http://example.com:8080/a"
        );
        // 非法 URL 退化为按首个 ? / # 截断。
        assert_eq!(redact_url_for_log("not a url?x=1#f"), "not a url");
        assert_eq!(redact_url_for_log("plain#frag"), "plain");
        assert_eq!(redact_url_for_log("plain"), "plain");
        // 解析失败时也尽力去掉 authority 中的 userinfo（scheme 非法导致无法解析）。
        assert_eq!(
            redact_url_for_log("ht tp://user:pass@example.com/a?x=1"),
            "ht tp://example.com/a"
        );
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
        let p = PageRef {
            url: "https://x/a/001.jpg".into(),
            width: None,
            height: None,
            anchor: None,
        };
        assert_eq!(page_name(&p, 0), "001.jpg");
        let p = PageRef {
            url: "https://x/".into(),
            width: None,
            height: None,
            anchor: None,
        };
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
    fn online_ua_is_standard_desktop_browser() {
        assert!(ONLINE_UA.starts_with("Mozilla/5.0"), "{ONLINE_UA}");
        assert!(ONLINE_UA.contains("Windows NT 10.0"), "{ONLINE_UA}");
        assert!(ONLINE_UA.contains("Chrome/"), "{ONLINE_UA}");
    }

    #[test]
    fn normalize_page_urls_dedupes_and_validates() {
        let pages = normalize_page_urls(&[
            "HTTP://X/1.jpg#a".into(),
            "http://x/1.jpg#b".into(),
            "http://x/2.jpg".into(),
        ])
        .unwrap();
        assert_eq!(
            pages.iter().map(|p| p.url.as_str()).collect::<Vec<_>>(),
            vec!["http://x/1.jpg", "http://x/2.jpg"]
        );
        assert_eq!(
            normalize_page_urls(&[]).unwrap_err().to_string(),
            "页面列表不能为空（online-url-invalid）"
        );
        assert_eq!(
            normalize_page_urls(&["file:///x".into()])
                .unwrap_err()
                .to_string(),
            "第 1 页 URL 非法：仅支持 http/https URL（online-url-invalid）"
        );
        let too_many: Vec<String> = (0..=MAX_PAGES)
            .map(|i| format!("http://x/{i}.jpg"))
            .collect();
        assert_eq!(
            normalize_page_urls(&too_many).unwrap_err().to_string(),
            format!("页面数量超过上限 {MAX_PAGES}（online-too-many-pages）")
        );
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
        scopes: Mutex<Vec<Option<String>>>,
    }

    impl StubTransport {
        fn ok(body: &[u8]) -> Self {
            Self {
                status: 200,
                body: body.to_vec(),
                final_url: "http://example.com/final".into(),
                calls: AtomicUsize::new(0),
                scopes: Mutex::new(Vec::new()),
            }
        }

        fn with_final_url(mut self, final_url: &str) -> Self {
            self.final_url = final_url.into();
            self
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn scopes(&self) -> Vec<Option<String>> {
            self.scopes.lock().unwrap().clone()
        }
    }

    impl http::HttpTransport for StubTransport {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
            header_scope: Option<&str>,
        ) -> Result<http::HttpResponse, OnlineError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.scopes
                .lock()
                .unwrap()
                .push(header_scope.map(str::to_string));
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
    fn resolve_keeps_invalid_json_manifest_errors_without_html_fallback() {
        // 合法 JSON、但页 URL 非法（夹带 <img> 仅用于证明没有走 HTML 回退）。
        let t = StubTransport::ok(
            br#"{"version":1,"pages":["file:///bad.png"],"note":"<img src='http://x/ok.jpg'>"}"#,
        );
        let err = resolve(&t, "http://example.com/manifest.json")
            .unwrap_err()
            .to_string();
        assert!(err.contains("第 1 页 URL 非法"), "{err}");
        assert!(!err.contains("HTML="), "{err}");
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

    #[test]
    fn resolve_non_2xx_error_redacts_url_query() {
        let t = StubTransport {
            status: 404,
            body: b"missing".to_vec(),
            final_url: "http://example.com/missing?token=secret#frag".into(),
            ..StubTransport::ok(b"")
        };
        let err = resolve(&t, "http://example.com/x").unwrap_err().to_string();
        assert!(err.contains("404"), "{err}");
        assert!(err.contains("http://example.com/missing"), "{err}");
        assert!(!err.contains("token=secret"), "{err}");
    }

    #[test]
    fn resolve_manifest_request_uses_normalized_url_as_scope() {
        let t = StubTransport::ok(br#"{"pages":["http://x/1.jpg"]}"#);
        resolve(&t, "http://example.com/list?token=secret#frag").unwrap();
        assert_eq!(
            t.scopes(),
            vec![Some("http://example.com/list?token=secret".to_string())]
        );
    }

    #[test]
    fn ssrf_ip_ranges_are_blocked_except_dev_loopback() {
        use std::net::{Ipv4Addr, Ipv6Addr};
        let blocked = [
            Ipv4Addr::new(10, 1, 2, 3),
            Ipv4Addr::new(172, 16, 0, 1),
            Ipv4Addr::new(192, 168, 1, 1),
            Ipv4Addr::new(169, 254, 169, 254),
            Ipv4Addr::new(100, 64, 0, 1),
            Ipv4Addr::new(0, 0, 0, 0),
            Ipv4Addr::new(224, 0, 0, 1),
        ];
        for ip in blocked {
            assert!(
                is_blocked_ip(IpAddr::V4(ip), false),
                "私网/保留地址必须阻断：{ip}"
            );
        }
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), false));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1)), false));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::LOCALHOST), false));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::LOCALHOST), true));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST), false));
        assert!(!is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST), true));
        assert!(is_blocked_ip(
            IpAddr::V6("fc00::1".parse().unwrap()),
            true
        ));
        assert!(is_blocked_ip(
            IpAddr::V6("fe80::1".parse().unwrap()),
            true
        ));
        assert!(is_blocked_ip(
            "::ffff:127.0.0.1".parse().unwrap(),
            false
        ));
    }

    #[test]
    fn normalize_url_rejects_private_literals_but_allows_loopback_in_tests() {
        for bad in [
            "http://10.0.0.1/x",
            "http://172.16.0.1/x",
            "http://192.168.0.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[fc00::1]/x",
            "http://[fe80::1]/x",
        ] {
            assert!(normalize_url(bad).is_err(), "必须拒绝：{bad}");
        }
        assert!(normalize_url("http://127.0.0.1:8080/x").is_ok());
        assert!(normalize_url("http://localhost:8080/x").is_ok());
        assert!(normalize_url("http://example.com/x").is_ok());
    }
}
