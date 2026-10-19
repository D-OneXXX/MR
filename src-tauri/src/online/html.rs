//! 单页 HTML 直铺图集：只提取当前页 `<img>`，不跟随分页查看器。
//!
//! 支持 `src` / `data-src` / `data-original` 三种属性，相对地址按页面 URL 解析，
//! 去重后要求 1 到 [`MAX_PAGES`] 张；不推断主图、不执行 JS、不做切片混淆还原。

use std::collections::HashSet;

use regex::Regex;

use crate::online::direct::{make_meta, OnlineBookMeta};
use crate::online::{truncate_chars, PageRef, MAX_PAGES};
use crate::source::BackendError;

/// 解析单页 HTML 图集正文。
pub fn parse_gallery(body: &[u8], page_url: &url::Url) -> Result<OnlineBookMeta, BackendError> {
    let text = String::from_utf8_lossy(body);
    let title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let title = title_re
        .captures(&text)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::online::title_from_url(page_url));
    let title = truncate_chars(&title, 200);

    let img_re = Regex::new(r"(?is)<img\b[^>]*>").unwrap();
    let data_src = Regex::new(r#"(?is)\bdata-src\s*=\s*["']([^"']+)["']"#).unwrap();
    let data_original = Regex::new(r#"(?is)\bdata-original\s*=\s*["']([^"']+)["']"#).unwrap();
    let src = Regex::new(r#"(?is)\bsrc\s*=\s*["']([^"']+)["']"#).unwrap();

    let mut pages = Vec::new();
    let mut seen = HashSet::new();
    for tag in img_re.find_iter(&text) {
        let tag = tag.as_str();
        let raw = data_src
            .captures(tag)
            .or_else(|| data_original.captures(tag))
            .or_else(|| src.captures(tag))
            .map(|c| c[1].trim().to_string());
        let Some(raw) = raw else { continue };
        if raw.is_empty()
            || raw.starts_with("data:")
            || raw.starts_with("blob:")
            || raw.starts_with("javascript:")
        {
            continue;
        }
        let Ok(abs) = page_url.join(&raw) else {
            continue;
        };
        if !matches!(abs.scheme(), "http" | "https") {
            continue;
        }
        let url = abs.to_string();
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
    make_meta(page_url, &title, pages)
}

/// 去掉标题中的 HTML 标签。
fn strip_tags(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(s, "")
        .to_string()
}

/// 解码标题中的常见 HTML 实体（单次解码）。
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
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
        let meta = parse_gallery(html, &page).unwrap();
        assert_eq!(meta.title, "My Gallery");
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://gallery.example/1.png");
        // 标准 RFC 3986 join：相对路径替换页面 URL 的最后一段。
        assert_eq!(stored.pages[1].url, "http://gallery.example/view/2.png");
        assert_eq!(stored.pages[2].url, "https://cdn.example/3.png");
    }

    #[test]
    fn viewer_only_page_is_rejected() {
        let page = url::Url::parse("http://gallery.example/g/1/token").unwrap();
        let html = br#"<html><body><a href="/s/abc/1-1">1</a></body></html>"#;
        let err = parse_gallery(html, &page).err().unwrap().to_string();
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
        let meta = parse_gallery(html, &page).unwrap();
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
        let err = parse_gallery(html.as_bytes(), &page)
            .unwrap_err()
            .to_string();
        assert!(err.contains("超过上限"), "{err}");
    }
}
