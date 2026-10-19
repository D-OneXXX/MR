//! 单页 HTML 直铺图集：只提取当前页 `<img>`，不跟随分页查看器。
//!
//! 支持 `src` / `data-src` / `data-original` 三种属性，相对地址按基准 URL（重定向后的
//! 最终 URL）解析，书身份仍使用用户请求的规范化 URL；去重后要求 1 到 [`MAX_PAGES`] 张。
//! 不推断主图、不执行 JS、不做切片混淆还原。

use std::collections::HashSet;

use regex::Regex;

use crate::online::direct::{make_meta, OnlineBookMeta};
use crate::online::{normalize_url, truncate_chars, PageRef, MAX_PAGES};
use crate::source::BackendError;

/// 解析单页 HTML 图集正文。
///
/// `base_url` 是相对图片地址与标题回退的基准（通常是 `HttpResponse.final_url`），
/// `canonical_url` 是稳定的书身份（用户请求的规范化 URL）。
pub fn parse_gallery(
    body: &[u8],
    base_url: &url::Url,
    canonical_url: &url::Url,
) -> Result<OnlineBookMeta, BackendError> {
    let text = String::from_utf8_lossy(body);
    let title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let title = title_re
        .captures(&text)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::online::title_from_url(base_url));
    let title = truncate_chars(&title, 200);

    // 已知限制：正则按次编译。单页解析的额外开销可接受，暂不做缓存。
    let img_re = Regex::new(r"(?is)<img\b[^>]*>").unwrap();
    let data_src = Regex::new(r#"(?is)\bdata-src\s*=\s*["']([^"']+)["']"#).unwrap();
    let data_original = Regex::new(r#"(?is)\bdata-original\s*=\s*["']([^"']+)["']"#).unwrap();
    // `src` 必须位于属性边界，避免误匹配 `data-lazy-src` 等自定义属性。
    let src = Regex::new(r#"(?is)(?:^|\s)src\s*=\s*["']([^"']+)["']"#).unwrap();
    let patterns: [&Regex; 3] = [&data_src, &data_original, &src];

    let mut pages = Vec::new();
    let mut seen = HashSet::new();
    for tag in img_re.find_iter(&text) {
        let Some(url) = first_image_url(tag.as_str(), base_url, &patterns) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        pages.push(PageRef {
            url,
            width: None,
            height: None,
        });
        if pages.len() > MAX_PAGES {
            return Err(BackendError::Msg(format!(
                "HTML 图片数超过上限 {MAX_PAGES}"
            )));
        }
    }
    if pages.is_empty() {
        return Err(BackendError::Msg(
            "未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围".into(),
        ));
    }
    make_meta(canonical_url, &title, pages)
}

/// 按属性优先级（data-src → data-original → src）返回第一个有效图片地址。
///
/// 空值、`data:`/`blob:`/`javascript:` 占位以及无法规范化（含 userinfo、超长、
/// 非 http/https）的候选都会被跳过，继续尝试下一个属性。
fn first_image_url(tag: &str, base_url: &url::Url, patterns: &[&Regex]) -> Option<String> {
    for re in patterns {
        let Some(caps) = re.captures(tag) else {
            continue;
        };
        let raw = decode_entities(caps[1].trim());
        if raw.is_empty()
            || raw.starts_with("data:")
            || raw.starts_with("blob:")
            || raw.starts_with("javascript:")
        {
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
        .unwrap()
        .replace_all(s, "")
        .to_string()
}

/// 解码标题中的常见 HTML 实体（单次解码）。
///
/// 先解码非 `&amp;` 实体、最后解码 `&amp;`，避免 `&amp;lt;` 被二次解码成 `<`。
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_and_images() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><head><title>My Gallery</title></head>
            <body>
              <img src="/1.png">
              <img data-src="2.png">
              <img data-original="https://cdn.example/3.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.title, "My Gallery");
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        // 标准 RFC 3986 join：相对路径替换页面 URL 的最后一段。
        assert_eq!(stored.pages[1].url, "http://gallery.example/view/2.png");
        assert_eq!(stored.pages[2].url, "https://cdn.example/3.png");
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
    fn src_attribute_does_not_match_data_lazy_src() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html = br#"<html><body>
              <img data-lazy-src="/lazy-only.png">
              <img data-lazy-src="/lazy.png" src="/real.png">
            </body></html>"#;
        let meta = parse_gallery(html, &page, &page).unwrap();
        assert_eq!(meta.page_count, 1);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/real.png");
    }

    #[test]
    fn decodes_entities_in_image_urls_before_join() {
        let page = url::Url::parse("http://gallery.example/view/1").unwrap();
        let html =
            br#"<html><body><img src="/a.png?x=1&amp;y=2"></body></html>"#;
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
        let err = parse_gallery(html, &page, &page).err().unwrap().to_string();
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
            .unwrap_err()
            .to_string();
        assert!(err.contains("超过上限"), "{err}");
    }
}
