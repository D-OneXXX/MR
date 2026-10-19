//! JSON 清单型直链图片集 Provider。
//!
//! 清单格式：`{"version":1,"title":"...","pages":["url" | {"url","width","height"}]}`。
//! 生产入口由 [`crate::online::resolve`] 统一调度；本模块的
//! [`DirectImageProvider::resolve`] 保留为拉取 + 解析的测试/兼容入口。

use sha2::{Digest, Sha256};

use crate::online::http::HttpTransport;
use crate::online::{
    normalize_url, title_from_url, truncate_chars, PageRef, StoredMeta, MANIFEST_MAX_BYTES,
    MAX_PAGES,
};
use crate::source::BackendError;

/// 在线书解析结果（尚未落库）。
#[derive(Debug, Clone)]
pub struct OnlineBookMeta {
    pub canonical_url: String,
    pub source_type: String,
    pub title: String,
    pub page_count: usize,
    pub meta_json: String,
}

#[derive(Debug, serde::Deserialize)]
struct RawManifest {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    title: Option<String>,
    pages: Vec<RawPageEntry>,
}

/// 清单页条目：纯 URL 字符串或带尺寸提示的对象。
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum RawPageEntry {
    Url(String),
    Obj {
        url: String,
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
    },
}

/// manifestHash 的稳定输入：最终标题 + 页面列表。
#[derive(serde::Serialize)]
struct HashInput<'a> {
    title: &'a str,
    pages: &'a [PageRef],
}

pub struct DirectImageProvider;

impl DirectImageProvider {
    /// 仅接受 http/https URL。
    pub fn can_handle(&self, url: &url::Url) -> bool {
        matches!(url.scheme(), "http" | "https")
    }

    /// 拉取清单 URL 并解析（保留为测试/兼容入口）。
    pub fn resolve(
        &self,
        http: &dyn HttpTransport,
        raw_url: &str,
    ) -> Result<OnlineBookMeta, BackendError> {
        let url = normalize_url(raw_url)?;
        if !self.can_handle(&url) {
            return Err(BackendError::Msg("仅支持 http/https 清单 URL".into()));
        }
        let resp = http.get(url.as_str(), MANIFEST_MAX_BYTES, None)?;
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "清单 HTTP {}：{}",
                resp.status, resp.final_url
            )));
        }
        parse_manifest(&resp.body, &url)
    }
}

/// 解析 JSON 清单正文；标题缺失时退回 URL 推导名。
pub fn parse_manifest(body: &[u8], url: &url::Url) -> Result<OnlineBookMeta, BackendError> {
    let raw: RawManifest = serde_json::from_slice(body)
        .map_err(|e| BackendError::Msg(format!("清单格式不符：{e}")))?;
    if let Some(v) = raw.version {
        if v != 1 {
            return Err(BackendError::Msg(format!("不支持的清单版本：{v}")));
        }
    }
    if raw.pages.is_empty() {
        return Err(BackendError::Msg("清单 pages 不能为空".into()));
    }
    if raw.pages.len() > MAX_PAGES {
        return Err(BackendError::Msg(format!("清单页数超过上限 {MAX_PAGES}")));
    }
    let mut pages = Vec::with_capacity(raw.pages.len());
    for (i, entry) in raw.pages.into_iter().enumerate() {
        let (raw_page, width, height) = match entry {
            RawPageEntry::Url(url) => (url, None, None),
            RawPageEntry::Obj { url, width, height } => (url, width, height),
        };
        let page_url = normalize_url(&raw_page)
            .map_err(|e| BackendError::Msg(format!("第 {} 页 URL 非法：{e}", i + 1)))?;
        let (width, height) = match (width, height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
            _ => (None, None),
        };
        pages.push(PageRef {
            url: page_url.to_string(),
            width,
            height,
        });
    }
    let title = raw
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| title_from_url(url));
    make_meta(url, &title, pages)
}

/// 将最终标题与页面列表封装为 [`OnlineBookMeta`]（计算 manifestHash）。
pub fn make_meta(
    canonical_url: &url::Url,
    title: &str,
    pages: Vec<PageRef>,
) -> Result<OnlineBookMeta, BackendError> {
    let title = truncate_chars(title.trim(), 200);
    let hash = {
        let mut h = Sha256::new();
        h.update(
            serde_json::to_string(&HashInput {
                title: &title,
                pages: &pages,
            })
            .map_err(|e| BackendError::Msg(format!("清单序列化失败：{e}")))?
            .as_bytes(),
        );
        hex::encode(h.finalize())
    };
    let stored = StoredMeta {
        schema: 1,
        manifest_hash: hash,
        fetched_at: crate::db::now_str(),
        pages,
    };
    let meta_json = serde_json::to_string(&stored)
        .map_err(|e| BackendError::Msg(format!("清单元数据序列化失败：{e}")))?;
    Ok(OnlineBookMeta {
        canonical_url: canonical_url.to_string(),
        source_type: "generic_manga".into(),
        title,
        page_count: stored.pages.len(),
        meta_json,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::http::{HttpResponse, HttpTransport};
    use crate::online::{OnlineError, StoredMeta};

    struct FakeTransport {
        body: Vec<u8>,
    }

    impl HttpTransport for FakeTransport {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            Ok(HttpResponse {
                status: 200,
                final_url: "http://example.com/manifest.json".into(),
                content_type: Some("application/json".into()),
                body: self.body.clone(),
            })
        }
    }

    fn resolve(body: &str) -> Result<OnlineBookMeta, crate::source::BackendError> {
        DirectImageProvider.resolve(
            &FakeTransport {
                body: body.as_bytes().to_vec(),
            },
            "http://example.com/manifest.json",
        )
    }

    #[test]
    fn resolves_string_and_object_pages() {
        let meta = resolve(
            r#"{"version":1,"title":"Test","pages":["http://x/1.jpg",{"url":"http://x/2.jpg","width":800,"height":1200}]}"#,
        )
        .unwrap();
        assert_eq!(meta.title, "Test");
        assert_eq!(meta.page_count, 2);
        assert_eq!(meta.source_type, "generic_manga");
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages.len(), 2);
        assert_eq!(stored.pages[0].width, None);
        assert_eq!(stored.pages[1].width, Some(800));
        assert_eq!(stored.pages[1].height, Some(1200));
    }

    #[test]
    fn title_falls_back_and_truncates() {
        let meta = resolve(r#"{"pages":["http://x/1.jpg"]}"#).unwrap();
        assert_eq!(meta.title, "manifest.json");
        // 空白标题按缺失处理，回到 URL 推导名。
        let meta = resolve(r#"{"title":"   ","pages":["http://x/1.jpg"]}"#).unwrap();
        assert_eq!(meta.title, "manifest.json");
        let long = "a".repeat(300);
        let meta = resolve(&format!(
            r#"{{"title":"{long}","pages":["http://x/1.jpg"]}}"#
        ))
        .unwrap();
        assert_eq!(meta.title.chars().count(), 200);
    }

    #[test]
    fn normalizes_title_and_drops_incomplete_dimensions() {
        let meta = resolve(
            r#"{"title":"  Trimmed  ","pages":[{"url":"http://x/1.jpg","width":800},{"url":"http://x/2.jpg","width":0,"height":1200}]}"#,
        )
        .unwrap();
        assert_eq!(meta.title, "Trimmed");
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        // 宽高必须同时为正，才保留尺寸提示。
        assert!(stored
            .pages
            .iter()
            .all(|p| p.width.is_none() && p.height.is_none()));
    }

    #[test]
    fn rejects_bad_shapes_and_urls() {
        assert!(resolve(r#"{"pages":[]}"#).is_err());
        assert!(resolve(r#"{"version":2,"pages":["http://x/1.jpg"]}"#).is_err());
        assert!(resolve(r#"{"pages":["file:///x.jpg"]}"#).is_err());
        assert!(resolve(r#"{"pages":[{"url":"http://user:pass@x/1.jpg"}]}"#).is_err());
    }

    #[test]
    fn hash_is_stable_for_same_manifest() {
        let a = resolve(r#"{"title":"T","pages":["http://x/1.jpg"]}"#).unwrap();
        let b = resolve(r#"{"title":"T","pages":["http://x/1.jpg"]}"#).unwrap();
        let sa: StoredMeta = serde_json::from_str(&a.meta_json).unwrap();
        let sb: StoredMeta = serde_json::from_str(&b.meta_json).unwrap();
        assert_eq!(sa.manifest_hash, sb.manifest_hash);
    }
}
