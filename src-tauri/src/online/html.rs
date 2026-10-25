//! 单页 HTML 图集：轻量 DOM 扫描 + 多阶段提纯。
//!
//! 不执行 JS、不跟随分页查看器，只提取当前页 `<img>`。扫描器维护元素栈，
//! 剔除 header/footer/nav/aside、评论区/推荐位等站点 chrome，识别
//! data-src / data-original / data-lazy-src / data-srcset 懒加载真实地址，
//! 然后把候选交给 [`crate::online::filter`] 做尺寸、序列与站点档案过滤。

use std::collections::HashSet;

use regex::Regex;

use crate::online::direct::{make_filtered_meta, probe_image, OnlineBookMeta};
use crate::online::filter::{
    filter_candidates, CandidateImage, CandidateSource, FilterMemory, FilterThresholds,
};
use crate::online::http::HttpTransport;
use crate::online::OnlineError;
use crate::online::{normalize_url, truncate_chars, MAX_PAGES};
use crate::source::BackendError;

/// 解析单页 HTML 图集正文（离线/兼容入口；不做网络尺寸探测）。
#[allow(dead_code)]
pub fn parse_gallery(
    body: &[u8],
    base_url: &url::Url,
    canonical_url: &url::Url,
) -> Result<OnlineBookMeta, BackendError> {
    struct NoProbe;
    impl HttpTransport for NoProbe {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
            _header_scope: Option<&str>,
        ) -> Result<crate::online::http::HttpResponse, OnlineError> {
            Err(OnlineError::Network("probe disabled".into()))
        }
    }
    let thresholds = FilterThresholds {
        probe_missing_dimensions: false,
        ..FilterThresholds::default()
    };
    parse_gallery_with(
        body,
        base_url,
        canonical_url,
        &NoProbe,
        &FilterMemory::default(),
        &thresholds,
    )
}

/// 带网络尺寸探测的 HTML 图集解析入口。
pub fn parse_gallery_with(
    body: &[u8],
    base_url: &url::Url,
    canonical_url: &url::Url,
    http: &dyn HttpTransport,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let text = decode_html(body);
    let title = extract_title(&text).unwrap_or_else(|| crate::online::title_from_url(base_url));
    // <base href> 改变相对图片解析基准；标题回退仍用最终 URL。
    let effective_base = base_href(&text, base_url).unwrap_or_else(|| base_url.clone());

    let mut stack: Vec<OpenElement> = Vec::new();
    let mut candidates: Vec<CandidateImage> = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0usize;
    while let Some((start, end)) = next_tag(&text, pos) {
        pos = end;
        let tag = &text[start..end];
        let Some(name) = tag_name(tag) else {
            continue;
        };
        let attrs = parse_attrs(tag);
        if tag.trim_start().starts_with("</") {
            if let Some(index) = stack.iter().rposition(|el| el.name == name) {
                stack.truncate(index);
            }
            continue;
        }
        // script/style 内容不是 DOM；跳过其闭合标签前的全部文本。
        if matches!(name.as_str(), "script" | "style") && !tag.trim_end().ends_with("/>") {
            if let Some(close) = find_ci(&text, &format!("</{name}"), pos) {
                pos = text[close..]
                    .find('>')
                    .map(|offset| close + offset + 1)
                    .unwrap_or(text.len());
            }
            continue;
        }
        let class_id = attr_value(&attrs, "class")
            .into_iter()
            .chain(attr_value(&attrs, "id"))
            .collect::<Vec<_>>()
            .join(" ");
        let parent = stack.last();
        let self_chrome = is_chrome_tag(&name) || is_chrome_class(&class_id);
        let chrome = parent.map(|el| el.chrome).unwrap_or(false) || self_chrome;
        let container = if is_content_tag(&name) || is_content_class(&class_id) {
            Some(selector_hint(&name, &attrs))
        } else {
            parent.and_then(|el| el.container.clone())
        };
        if name == "img" {
            if let Some(url) = image_url(&attrs, &effective_base) {
                if seen.insert(url.clone()) {
                    let (width, height) = image_dimensions(&attrs);
                    let img_class = class_id.trim().to_string();
                    let alt = attr_value(&attrs, "alt").map(|v| decode_entities(&v));
                    candidates.push(CandidateImage {
                        url,
                        width,
                        height,
                        order: candidates.len(),
                        in_chrome: chrome || is_chrome_class(&img_class),
                        container: container.clone(),
                        class_id: (!img_class.is_empty()).then_some(img_class),
                        alt,
                        source: CandidateSource::Html,
                        anchor: None,
                    });
                    if candidates.len() > MAX_PAGES.saturating_mul(8) {
                        return Err(BackendError::Msg(format!(
                            "HTML 图片数超过上限 {MAX_PAGES}"
                        )));
                    }
                }
            }
            // img 是 void 元素，不入栈。
            continue;
        }
        if !is_void(&name) && !tag.trim_end().ends_with("/>") {
            stack.push(OpenElement {
                name,
                chrome,
                container,
            });
        }
    }

    if candidates.is_empty() {
        return Err(BackendError::Msg(
            "未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围".into(),
        ));
    }
    let referer = canonical_url.as_str().to_string();
    let mut memory = memory.clone();
    if memory.host.is_empty() {
        memory.host = crate::online::filter::url_host(canonical_url.as_str());
    }
    let mut probe = |candidate: &CandidateImage| probe_image(http, &referer, candidate);
    let outcome = filter_candidates(candidates, &memory, thresholds, &mut probe);
    if outcome.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "未找到正文图片（已过滤 {} 张非正文图）",
            outcome.blocked.len()
        )));
    }
    if outcome.pages.len() > MAX_PAGES {
        return Err(BackendError::Msg(format!(
            "HTML 图片数超过上限 {MAX_PAGES}"
        )));
    }
    let title = truncate_chars(&title, 200);
    make_filtered_meta(
        canonical_url,
        &title,
        outcome,
        crate::online::direct::MetaLinks::default(),
    )
}

struct OpenElement {
    name: String,
    chrome: bool,
    container: Option<String>,
}

fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn is_chrome_tag(name: &str) -> bool {
    matches!(name, "header" | "footer" | "nav" | "aside")
}

fn tokens(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
}

fn is_chrome_class(value: &str) -> bool {
    const EXACT: &[&str] = &[
        "ad", "ads", "adv", "advert", "banner", "promo", "sponsor", "comment", "comments",
        "sidebar", "recommend", "related", "share", "menu", "breadcrumb", "toolbar",
    ];
    const CONTAINS: &[&str] = &[
        "header", "footer", "nav", "logo", "avatar", "qrcode", "watermark", "thumb", "icon",
        "loading", "placeholder", "sprite", "button", "btn", "sticker", "emoji",
    ];
    let lower = value.to_ascii_lowercase();
    tokens(&lower).any(|token| EXACT.contains(&token.as_str()))
        || CONTAINS.iter().any(|word| lower.contains(word))
}

fn is_content_tag(name: &str) -> bool {
    matches!(name, "main" | "article")
}

fn is_content_class(value: &str) -> bool {
    const WORDS: &[&str] = &[
        "reader", "content", "chapter", "gallery", "comic", "manga", "pages", "viewer",
    ];
    let lower = value.to_ascii_lowercase();
    WORDS.iter().any(|word| lower.contains(word))
}

fn selector_hint(name: &str, attrs: &[(String, String)]) -> String {
    let class = attr_value(attrs, "class").unwrap_or_default();
    let id = attr_value(attrs, "id").unwrap_or_default();
    let class = class
        .split_whitespace()
        .next()
        .unwrap_or("")
        .chars()
        .take(60)
        .collect::<String>();
    let id = id.chars().take(60).collect::<String>();
    if !id.is_empty() {
        format!("{name}#{id}")
    } else if !class.is_empty() {
        format!("{name}.{class}")
    } else {
        name.to_string()
    }
}

/// 按 BOM / `<meta charset>` / `Content-Type` meta 解码 HTML；无声明时按 UTF-8
/// lossy。编码标签只在前 8 KiB 内查找，避免把正文误当标签。
fn decode_html(body: &[u8]) -> String {
    use encoding_rs::{Encoding, UTF_8};
    if let Some((encoding, bom_len)) = Encoding::for_bom(body) {
        let (text, _, _) = encoding.decode(&body[bom_len..]);
        return text.into_owned();
    }
    let probe = String::from_utf8_lossy(&body[..body.len().min(8192)]);
    let lower = probe.to_ascii_lowercase();
    let label = lower
        .split("charset=")
        .nth(1)
        .map(|tail| {
            tail.trim_start_matches(['"', '\''])
                .split(|c: char| c == '"' || c == '\'' || c == ';' || c == '>' || c.is_whitespace())
                .next()
                .unwrap_or("")
        })
        .filter(|label| !label.is_empty());
    let encoding = label
        .and_then(|label| Encoding::for_label(label.as_bytes()))
        .unwrap_or(UTF_8);
    let (text, _, _) = encoding.decode(body);
    text.into_owned()
}

fn base_href(text: &str, base_url: &url::Url) -> Option<url::Url> {
    let re = Regex::new(r#"(?is)<base\b[^>]*href\s*=\s*["']([^"']+)["']"#).ok()?;
    let raw = decode_entities(re.captures(text)?.get(1)?.as_str().trim());
    let joined = base_url.join(&raw).ok()?;
    normalize_url(joined.as_str()).ok()
}

fn extract_title(text: &str) -> Option<String> {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    re.captures(text)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 找到下一个标签的字节区间 `[start, end)`；跳过注释与 doctype。
fn next_tag(text: &str, from: usize) -> Option<(usize, usize)> {
    let mut cursor = from;
    loop {
        let start = text[cursor..].find('<')? + cursor;
        if text[start..].starts_with("<!--") {
            let end = text[start + 4..].find("-->")? + start + 7;
            cursor = end;
            continue;
        }
        if text[start..].starts_with("<!") || text[start..].starts_with("<?") {
            let end = text[start..].find('>')? + start + 1;
            cursor = end;
            continue;
        }
        let mut quote: Option<char> = None;
        for (offset, ch) in text[start + 1..].char_indices() {
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
                continue;
            }
            if ch == '"' || ch == '\'' {
                quote = Some(ch);
            } else if ch == '>' {
                return Some((start, start + 1 + offset + 1));
            }
        }
        return None;
    }
}

fn tag_name(tag: &str) -> Option<String> {
    let inner = tag
        .trim_start_matches('<')
        .trim_start_matches('/')
        .trim_start();
    let name: String = inner
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':')
        .collect::<String>()
        .to_ascii_lowercase();
    (!name.is_empty()).then_some(name)
}

fn parse_attrs(tag: &str) -> Vec<(String, String)> {
    let re = Regex::new(
        r#"(?is)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
    )
    .expect("attr regex");
    re.captures_iter(tag)
        .filter_map(|caps| {
            let name = caps.get(1)?.as_str().to_ascii_lowercase();
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            Some((name, value))
        })
        .collect()
}

fn attr_value(attrs: &[(String, String)], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.trim().is_empty())
}

fn image_dimensions(attrs: &[(String, String)]) -> (Option<u32>, Option<u32>) {
    let parse = |name: &str| {
        attr_value(attrs, name)
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|v| *v > 0)
    };
    (
        parse("width").or_else(|| parse("data-width")),
        parse("height").or_else(|| parse("data-height")),
    )
}

fn first_srcset_url(value: &str) -> Option<String> {
    value
        .split(',')
        .next()
        .and_then(|part| part.split_whitespace().next())
        .map(str::to_string)
}

fn image_url(attrs: &[(String, String)], base_url: &url::Url) -> Option<String> {
    let mut candidates = Vec::new();
    for key in ["data-src", "data-original", "data-lazy-src"] {
        if let Some(value) = attr_value(attrs, key) {
            candidates.push(value);
        }
    }
    if let Some(value) = attr_value(attrs, "data-srcset").and_then(|v| first_srcset_url(&v)) {
        candidates.push(value);
    }
    if let Some(value) = attr_value(attrs, "src") {
        candidates.push(value);
    }
    for raw in candidates {
        let raw = decode_entities(raw.trim());
        if raw.is_empty()
            || raw.starts_with("data:")
            || raw.starts_with("blob:")
            || raw.starts_with("javascript:")
        {
            continue;
        }
        let lower = raw.to_ascii_lowercase();
        if lower.ends_with(".svg") || lower.ends_with(".ico") {
            continue;
        }
        let Ok(joined) = base_url.join(&raw) else {
            continue;
        };
        let Ok(normalized) = normalize_url(joined.as_str()) else {
            continue;
        };
        return Some(normalized.to_string());
    }
    None
}

/// 去掉标题中的 HTML 标签。
fn strip_tags(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("tag strip regex")
        .replace_all(s, "")
        .to_string()
}

/// 解码标题中的常见 HTML 实体（单次解码）。
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let lower = haystack[from..].to_ascii_lowercase();
    lower.find(&needle.to_ascii_lowercase()).map(|i| from + i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gallery(html: &str) -> OnlineBookMeta {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        parse_gallery(html.as_bytes(), &page, &page).unwrap()
    }

    #[test]
    fn extracts_title_and_images() {
        let meta = gallery(
            r#"<html><head><title>My Gallery</title></head>
            <body>
              <img src="/1.png">
              <img data-src="2.png">
              <img data-original="https://cdn.example/3.png">
            </body></html>"#,
        );
        assert_eq!(meta.title, "My Gallery");
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        assert_eq!(stored.pages[1].url, "http://gallery.example/view/2.png");
        assert_eq!(stored.pages[2].url, "https://cdn.example/3.png");
    }

    #[test]
    fn drops_thirty_page_chrome_and_keeps_all_content() {
        let mut html = String::from(
            r#"<html><head><title>QA HTML Gallery</title></head><body>
            <header><img src="/logo.png" width="128" height="128" class="logo"></header>
            <nav><img src="/ad.png" width="728" height="90" class="ad-banner"></nav>
            <aside class="comments"><img src="https://other.example/avatar.png" width="200" height="200"></aside>
            <main><div class="reader-content">"#,
        );
        for i in 1..=30 {
            html.push_str(&format!(
                r#"<img src="/page-{:03}.png" width="800" height="1200" alt="page">"#,
                i
            ));
        }
        html.push_str(
            r#"<img src="/qrcode.png" width="300" height="300" alt="qrcode">
            <img src="/thumb.png" width="240" height="240" alt="thumbnail">
            </div></main>
            <footer><img src="/icon.png" width="64" height="64"></footer></body></html>"#,
        );
        let meta = gallery(&html);
        assert_eq!(meta.page_count, 30);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert!(stored.filtered.len() >= 5);
        assert!(stored
            .filtered
            .iter()
            .any(|p| p.reason.contains("chrome")));
        assert!(stored.filtered.iter().any(|p| {
            p.reason.contains("small")
                || p.reason.contains("banner")
                || p.reason.contains("keyword")
        }));
        assert!(meta.filter_profile.is_some());
    }

    #[test]
    fn normalizes_joined_urls_and_skips_userinfo_and_fragments() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let long_path = "a".repeat(2100);
        let html = format!(
            r#"<html><body>
              <img src="https://user:pass@cdn.example/secret.png">
              <img src="/1.png#frag">
              <img src="/1.png">
              <img src="/{long_path}.png">
              <img src="https://cdn.example/2.png#part">
              <img src="https://cdn.example/2.png">
            </body></html>"#
        );
        let meta = parse_gallery(html.as_bytes(), &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        assert_eq!(stored.pages[1].url, "https://cdn.example/2.png");
    }

    #[test]
    fn falls_back_when_data_src_is_blank_or_placeholder() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="   " src="/blank.png">
              <img data-src="data:image/gif;base64,R0lGOD" src="/data.png">
              <img data-src="blob:http://gallery.example/x" src="/blob.png">
              <img data-src="javascript:void(0)" src="/js.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 4);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/blank.png",
                "http://gallery.example/data.png",
                "http://gallery.example/blob.png",
                "http://gallery.example/js.png",
            ]
        );
    }

    #[test]
    fn prefers_data_src_then_data_original_then_src() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="/a.png" data-original="/b.png" src="/c.png">
              <img data-original="/d.png" src="/e.png">
              <img src="/f.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/a.png",
                "http://gallery.example/d.png",
                "http://gallery.example/f.png",
            ]
        );
    }

    #[test]
    fn supports_data_lazy_src_and_ignores_lazy_placeholder_only_when_src_exists() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-lazy-src="/lazy-only.png">
              <img data-lazy-src="/lazy.png" src="/real.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        let urls: Vec<&str> = stored.pages.iter().map(|p| p.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "http://gallery.example/lazy-only.png",
                "http://gallery.example/lazy.png",
            ]
        );
    }

    #[test]
    fn decodes_entities_in_image_urls_before_join() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body><img src="/a.png?x=1&amp;y=2"></body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/a.png?x=1&y=2");
    }

    #[test]
    fn decodes_entities_in_a_single_pass() {
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_entities("A &amp; B"), "A & B");
    }

    #[test]
    fn viewer_only_page_is_rejected() {
        let page = url::Url::parse("http://gallery.example/g/1/token").unwrap();
        let html = br#"<html><body><a href="/s/abc/1-1">1</a></body></html>"#;
        let err = parse_gallery(html, &page, &page)
            .err()
            .unwrap()
            .to_string();
        assert_eq!(
            err,
            "未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围"
        );
    }

    #[test]
    fn dedupes_and_skips_non_http_sources() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-src="1.png">
              <img src="1.png">
              <img src="data:image/png;base64,AAAA">
              <img src="javascript:void(0)">
              <img src="//cdn.example/2.png">
              <img src="http://cdn.example/2.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/view/1.png");
        assert_eq!(stored.pages[1].url, "http://cdn.example/2.png");
        assert!(stored
            .pages
            .iter()
            .all(|p| p.width.is_none() && p.height.is_none()));
    }

    #[test]
    fn rejects_more_than_max_pages() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let mut html = String::from("<html><body>");
        for i in 0..=crate::online::MAX_PAGES {
            html.push_str(&format!(r#"<img src="/{i}.png">"#));
        }
        html.push_str("</body></html>");
        let err = parse_gallery(html.as_bytes(), &page, &page)
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("超过上限"), "{err}");
    }

    #[test]
    fn decodes_declared_charset_and_honors_base_href() {
        let source = r#"<html><head><meta charset="gbk"><base href="https://cdn.example/gallery/"><title>中文图集</title></head><body><img src="01.jpg"></body></html>"#;
        let (encoded, _, _) = encoding_rs::GBK.encode(source);
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let meta = parse_gallery(&encoded, &page, &page).unwrap();
        assert_eq!(meta.title, "中文图集");
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "https://cdn.example/gallery/01.jpg");
    }

    #[test]
    fn tag_scanner_handles_quotes_comments_and_scripts() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
            <!-- <img src="/hidden.png"> -->
            <script>document.write('<img src="/script.png">')</script>
            <img alt="a > b" src="/real.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 1);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/real.png");
    }
}
