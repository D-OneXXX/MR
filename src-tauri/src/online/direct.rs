//! JSON 清单型直链图片集 Provider。
//!
//! 清单格式：`{"version":1,"title":"...","pages":["url" | {"url","width","height"}]}`。
//! 生产入口由 [`crate::online::resolve`] 统一调度；本模块的
//! [`DirectImageProvider::resolve`] 保留为拉取 + 解析的测试/兼容入口。

use sha2::{Digest, Sha256};

use crate::online::filter::{
    filter_candidates, CandidateImage, CandidateSource, FilterMemory, FilterThresholds, ProbeInfo,
};
use crate::online::http::HttpTransport;
use crate::online::{
    normalize_page_urls, normalize_url, redact_url_for_log, title_from_url, truncate_chars,
    PageRef, StoredMeta, MANIFEST_MAX_BYTES, MAX_PAGES,
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
    pub series_id: Option<String>,
    pub series_title: Option<String>,
    pub chapter_index: Option<u32>,
    pub next_url: Option<String>,
    /// 被提纯引擎剔除的页面（写入 meta_json 供抽屉展示/恢复）。
    pub filtered: Vec<super::filter::FilteredPage>,
    /// 本次解析学到的站点档案（命令层决定是否落库）。
    pub filter_profile: Option<super::filter::SiteProfile>,
}

/// 链路字段的可选集合；manifestHash 不包含这些字段。
#[derive(Debug, Clone, Default)]
pub struct MetaLinks {
    pub series_id: Option<String>,
    pub series_title: Option<String>,
    pub next_url: Option<String>,
    pub chapter_index: Option<u32>,
}

#[derive(Debug, serde::Deserialize)]
struct RawManifest {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "seriesId")]
    series_id: Option<String>,
    #[serde(default, rename = "seriesTitle")]
    series_title: Option<String>,
    #[serde(default, rename = "nextUrl")]
    next_url: Option<String>,
    pages: Vec<RawPageEntry>,
}

#[derive(Debug, serde::Deserialize)]
struct RawSingleManifest {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "seriesId")]
    series_id: Option<String>,
    #[serde(default, rename = "seriesTitle")]
    series_title: Option<String>,
    #[serde(default, rename = "nextUrl")]
    next_url: Option<String>,
    #[serde(default)]
    pages: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RawChapter {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    pages: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RawBatchManifest {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default, rename = "seriesId")]
    series_id: Option<String>,
    #[serde(default, rename = "seriesTitle")]
    series_title: Option<String>,
    #[serde(default, rename = "nextUrl")]
    next_url: Option<String>,
    #[serde(default)]
    chapters: Vec<RawChapter>,
}

/// 清单页条目：纯 URL 字符串或带尺寸提示的对象。
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum RawPageEntry {
    Url(String),
    Obj {
        url: String,
        // 用 i64 接收，负数/超 u32 的值在解析后统一丢弃，而不是让整份清单反序列化失败。
        #[serde(default)]
        width: Option<i64>,
        #[serde(default)]
        height: Option<i64>,
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
        let resp = http.get(url.as_str(), MANIFEST_MAX_BYTES, None, Some(url.as_str()))?;
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "清单 HTTP {}：{}",
                resp.status,
                redact_url_for_log(&resp.final_url)
            )));
        }
        parse_manifest(&resp.body, &url)
    }
}

/// 解析 JSON 清单正文；标题缺失时退回 URL 推导名。
///
/// 这是保留给离线测试/兼容调用的入口：不做网络尺寸探测，但仍执行 URL/尺寸
/// 静态过滤。生产入口见 [`parse_manifest_with`]。
pub fn parse_manifest(body: &[u8], url: &url::Url) -> Result<OnlineBookMeta, BackendError> {
    let parsed = parse_raw_manifest(body, url)?;
    let mut memory = FilterMemory {
        host: crate::online::filter::url_host(url.as_str()),
        ..FilterMemory::default()
    };
    if memory.host.is_empty() {
        memory.host = url.host_str().unwrap_or("").to_string();
    }
    let candidates: Vec<CandidateImage> = parsed
        .pages
        .iter()
        .enumerate()
        .map(|(index, page)| CandidateImage {
            url: page.url.clone(),
            width: page.width,
            height: page.height,
            order: index,
            in_chrome: false,
            container: None,
            class_id: None,
            alt: None,
            source: CandidateSource::Json,
            anchor: page.anchor.clone(),
        })
        .collect();
    let mut probe = |_c: &CandidateImage| None;
    let outcome = filter_candidates(
        candidates,
        &memory,
        &FilterThresholds {
            probe_missing_dimensions: false,
            ..FilterThresholds::default()
        },
        &mut probe,
    );
    if outcome.pages.is_empty() && !parsed.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "清单图片均被判定为非正文图（已过滤 {} 张）",
            outcome.blocked.len()
        )));
    }
    make_filtered_meta(url, &parsed.title, outcome, parsed.links)
}

/// 带网络尺寸探测的清单解析入口。
pub fn parse_manifest_with(
    body: &[u8],
    url: &url::Url,
    http: &dyn HttpTransport,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let parsed = parse_raw_manifest(body, url)?;
    let candidates: Vec<CandidateImage> = parsed
        .pages
        .iter()
        .enumerate()
        .map(|(index, page)| CandidateImage {
            url: page.url.clone(),
            width: page.width,
            height: page.height,
            order: index,
            in_chrome: false,
            container: None,
            class_id: None,
            alt: None,
            source: CandidateSource::Json,
            anchor: page.anchor.clone(),
        })
        .collect();
    let mut memory = memory.clone();
    if memory.host.is_empty() {
        memory.host = crate::online::filter::url_host(url.as_str());
    }
    let referer = url.as_str().to_string();
    let mut probe = |candidate: &CandidateImage| {
        probe_image(http, &referer, candidate)
    };
    let outcome = filter_candidates(candidates, &memory, thresholds, &mut probe);
    if outcome.pages.is_empty() && !parsed.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "清单图片均被判定为非正文图（已过滤 {} 张）",
            outcome.blocked.len()
        )));
    }
    make_filtered_meta(url, &parsed.title, outcome, parsed.links)
}

struct RawParsedManifest {
    title: String,
    pages: Vec<PageRef>,
    links: MetaLinks,
}

fn parse_raw_manifest(body: &[u8], url: &url::Url) -> Result<RawParsedManifest, BackendError> {
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
    let mut seen = std::collections::HashSet::new();
    for (i, entry) in raw.pages.into_iter().enumerate() {
        let (raw_page, width, height) = match entry {
            RawPageEntry::Url(url) => (url, None, None),
            RawPageEntry::Obj { url, width, height } => (url, width, height),
        };
        let page_url = normalize_url(&raw_page)
            .map_err(|e| BackendError::Msg(format!("第 {} 页 URL 非法：{e}", i + 1)))?;
        // 宽高必须同时落在 1..=u32::MAX 才保留，否则两者都丢弃。
        let (width, height) = match (width, height) {
            (Some(w), Some(h)) => match (u32::try_from(w), u32::try_from(h)) {
                (Ok(w), Ok(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
                _ => (None, None),
            },
            _ => (None, None),
        };
        let normalized = page_url.to_string();
        if !seen.insert(normalized.clone()) {
            continue;
        }
        pages.push(PageRef {
            url: normalized,
            width,
            height,
            anchor: None,
        });
    }
    let title = raw
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| title_from_url(url));
    let series_id = non_empty(raw.series_id.as_deref());
    let series_title = non_empty(raw.series_title.as_deref());
    let next_url = normalized_optional_url(raw.next_url.as_deref())?;
    Ok(RawParsedManifest {
        title,
        pages,
        links: MetaLinks {
            series_id,
            series_title,
            next_url,
            chapter_index: None,
        },
    })
}

pub(crate) fn probe_image(
    http: &dyn HttpTransport,
    referer: &str,
    candidate: &CandidateImage,
) -> Option<ProbeInfo> {
    // 4 MiB 足够覆盖绝大多数图片头；超限时放弃探测，交给声明尺寸/规则。
    let resp = http
        .get(
            &candidate.url,
            4 * 1024 * 1024,
            Some(referer),
            Some(referer),
        )
        .ok()?;
    if !(200..300).contains(&resp.status) {
        return None;
    }
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&resp.body))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some(ProbeInfo {
        width,
        height,
        sha256: Some(hex::encode(Sha256::digest(&resp.body))),
    })
}

/// 用过滤结果构建带 filtered/profile 的 meta_json。
pub fn make_filtered_meta(
    canonical_url: &url::Url,
    title: &str,
    outcome: crate::online::filter::FilterOutcome,
    links: MetaLinks,
) -> Result<OnlineBookMeta, BackendError> {
    let blocked = outcome.blocked.clone();
    let profile = outcome.profile.clone();
    let mut meta = make_meta_with_links(canonical_url, title, outcome.pages, links)?;
    let mut stored: StoredMeta = serde_json::from_str(&meta.meta_json)
        .map_err(|e| BackendError::Msg(format!("内部元数据错误：{e}")))?;
    stored.schema = 2;
    stored.filtered = blocked.clone();
    stored.filter_profile = Some(profile.clone());
    meta.meta_json = serde_json::to_string(&stored)
        .map_err(|e| BackendError::Msg(format!("清单元数据序列化失败：{e}")))?;
    meta.filtered = blocked;
    meta.filter_profile = Some(profile);
    meta.page_count = stored.pages.len();
    Ok(meta)
}

/// 将最终标题与页面列表封装为 [`OnlineBookMeta`]（计算 manifestHash）。
pub fn make_meta(
    canonical_url: &url::Url,
    title: &str,
    pages: Vec<PageRef>,
) -> Result<OnlineBookMeta, BackendError> {
    make_meta_with_links(canonical_url, title, pages, MetaLinks::default())
}

/// 带系列/章节/下一话链路的封装；manifestHash 仍只由 title + pages 计算。
pub fn make_meta_with_links(
    canonical_url: &url::Url,
    title: &str,
    pages: Vec<PageRef>,
    links: MetaLinks,
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
        schema: 2,
        manifest_hash: hash,
        fetched_at: crate::db::now_str(),
        pages,
        series_id: links.series_id.clone(),
        series_title: links.series_title.clone(),
        chapter_index: links.chapter_index,
        next_url: links.next_url.clone(),
        filtered: Vec::new(),
        filter_profile: None,
    };
    let meta_json = serde_json::to_string(&stored)
        .map_err(|e| BackendError::Msg(format!("清单元数据序列化失败：{e}")))?;
    Ok(OnlineBookMeta {
        canonical_url: canonical_url.to_string(),
        source_type: "generic_manga".into(),
        title,
        page_count: stored.pages.len(),
        meta_json,
        series_id: links.series_id,
        series_title: links.series_title,
        chapter_index: links.chapter_index,
        next_url: links.next_url,
        filtered: Vec::new(),
        filter_profile: None,
    })
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_optional_url(raw: Option<&str>) -> Result<Option<String>, BackendError> {
    match non_empty(raw) {
        Some(raw) => Ok(Some(normalize_url(&raw)?.to_string())),
        None => Ok(None),
    }
}

fn check_version(version: Option<u32>) -> Result<(), BackendError> {
    if let Some(version) = version {
        if version != 1 {
            return Err(BackendError::Msg(format!("不支持的清单版本：{version}")));
        }
    }
    Ok(())
}

fn title_or_url(title: Option<&str>, url: &url::Url) -> String {
    non_empty(title).unwrap_or_else(|| title_from_url(url))
}

fn series_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn parent_path(url: &url::Url) -> String {
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.collect())
        .unwrap_or_default();
    if segments.is_empty() {
        return "/".into();
    }
    let parent = &segments[..segments.len().saturating_sub(1)];
    if parent.is_empty() {
        "/".into()
    } else {
        format!("/{}/", parent.join("/"))
    }
}

/// 解析单本或合集批量清单；合集章节通过 next_url 自动串联。
pub fn parse_batch_payload(body: &[u8]) -> Result<Vec<OnlineBookMeta>, BackendError> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| BackendError::Msg(format!("清单格式不符：{e}")))?;
    if value.get("chapters").is_some() {
        let raw: RawBatchManifest = serde_json::from_value(value)
            .map_err(|e| BackendError::Msg(format!("清单格式不符：{e}")))?;
        check_version(raw.version)?;
        if raw.chapters.is_empty() {
            return Err(BackendError::Msg("合集清单 chapters 不能为空".into()));
        }
        if raw.chapters.len() > 100 {
            return Err(BackendError::Msg("合集章节数超过上限 100".into()));
        }
        let top_next = normalized_optional_url(raw.next_url.as_deref())?;

        let mut urls = Vec::with_capacity(raw.chapters.len());
        for (index, chapter) in raw.chapters.iter().enumerate() {
            let raw_url = non_empty(chapter.url.as_deref())
                .ok_or_else(|| BackendError::Msg(format!("第 {} 章缺少 url 字段", index + 1)))?;
            let url = normalize_url(&raw_url)
                .map_err(|e| BackendError::Msg(format!("第 {} 章 URL 非法：{e}", index + 1)))?;
            urls.push(url);
        }

        let explicit_series_id = non_empty(raw.series_id.as_deref());
        let series_title = non_empty(raw.series_title.as_deref());
        let series_id = explicit_series_id
            .or_else(|| series_title.as_deref().map(series_hash))
            .unwrap_or_else(|| series_hash(&parent_path(&urls[0])));

        let mut metas = Vec::with_capacity(raw.chapters.len());
        for (index, chapter) in raw.chapters.iter().enumerate() {
            let url = &urls[index];
            let title = title_or_url(chapter.title.as_deref(), url);
            let pages = normalize_page_urls(&chapter.pages)?;
            let next_url = urls
                .get(index + 1)
                .map(|next| next.to_string())
                .or_else(|| top_next.clone());
            metas.push(make_meta_with_links(
                url,
                &title,
                pages,
                MetaLinks {
                    series_id: Some(series_id.clone()),
                    series_title: series_title.clone(),
                    next_url,
                    chapter_index: Some((index + 1) as u32),
                },
            )?);
        }
        Ok(metas)
    } else {
        let raw: RawSingleManifest = serde_json::from_value(value)
            .map_err(|e| BackendError::Msg(format!("清单格式不符：{e}")))?;
        check_version(raw.version)?;
        let raw_url = non_empty(raw.url.as_deref())
            .ok_or_else(|| BackendError::Msg("单本清单缺少 url 字段".into()))?;
        let url = normalize_url(&raw_url)?;
        let pages = normalize_page_urls(&raw.pages)?;
        let title = title_or_url(raw.title.as_deref(), &url);
        let series_id = non_empty(raw.series_id.as_deref());
        let series_title = non_empty(raw.series_title.as_deref());
        let next_url = normalized_optional_url(raw.next_url.as_deref())?;
        Ok(vec![make_meta_with_links(
            &url,
            &title,
            pages,
            MetaLinks {
                series_id,
                series_title,
                next_url,
                chapter_index: None,
            },
        )?])
    }
}

/// 批量清单：先按原格式解析，再逐章应用提纯（保留系列/下一话链路）。
pub fn parse_batch_payload_with(
    body: &[u8],
    http: &dyn HttpTransport,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<Vec<OnlineBookMeta>, BackendError> {
    let metas = parse_batch_payload(body)?;
    let mut out = Vec::with_capacity(metas.len());
    for meta in metas {
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json)
            .map_err(|e| BackendError::Msg(format!("内部元数据错误：{e}")))?;
        let canonical = normalize_url(&meta.canonical_url)?;
        let mut memory = memory.clone();
        if memory.host.is_empty() {
            memory.host = crate::online::filter::url_host(canonical.as_str());
        }
        let referer = canonical.as_str().to_string();
        let candidates: Vec<CandidateImage> = stored
            .pages
            .iter()
            .enumerate()
            .map(|(index, page)| CandidateImage {
                url: page.url.clone(),
                width: page.width,
                height: page.height,
                order: index,
                in_chrome: false,
                container: None,
                class_id: None,
                alt: None,
                source: CandidateSource::Json,
                anchor: page.anchor.clone(),
            })
            .collect();
        let mut probe = |candidate: &CandidateImage| {
            probe_image(http, &referer, candidate)
        };
        let outcome = filter_candidates(candidates, &memory, thresholds, &mut probe);
        if outcome.pages.is_empty() && !stored.pages.is_empty() {
            return Err(BackendError::Msg(format!(
                "章节「{}」的图片均被判定为非正文图（已过滤 {} 张）",
                meta.title,
                outcome.blocked.len()
            )));
        }
        let links = MetaLinks {
            series_id: stored.series_id,
            series_title: stored.series_title,
            next_url: stored.next_url,
            chapter_index: stored.chapter_index,
        };
        out.push(make_filtered_meta(
            &canonical,
            &meta.title,
            outcome,
            links,
        )?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::http::{HttpResponse, HttpTransport};
    use crate::online::{OnlineError, StoredMeta};

    struct FakeTransport {
        body: Vec<u8>,
        scopes: std::sync::Mutex<Vec<Option<String>>>,
    }

    impl HttpTransport for FakeTransport {
        fn get(
            &self,
            _url: &str,
            _max: usize,
            _referer: Option<&str>,
            header_scope: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            self.scopes
                .lock()
                .unwrap()
                .push(header_scope.map(str::to_string));
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
                scopes: std::sync::Mutex::new(Vec::new()),
            },
            "http://example.com/manifest.json",
        )
    }

    #[test]
    fn resolve_passes_normalized_manifest_scope() {
        let http = FakeTransport {
            body: br#"{"pages":["http://x/1.jpg"]}"#.to_vec(),
            scopes: std::sync::Mutex::new(Vec::new()),
        };
        DirectImageProvider
            .resolve(&http, "http://example.com/manifest.json?token=secret#frag")
            .unwrap();
        assert_eq!(
            *http.scopes.lock().unwrap(),
            vec![Some(
                "http://example.com/manifest.json?token=secret".to_string()
            )]
        );
    }

    #[test]
    fn manifest_dedupes_repeated_urls() {
        let meta = resolve(
            r#"{"pages":["http://x/1.jpg","http://x/1.jpg#dup",{"url":"http://x/1.jpg","width":800,"height":1200},"http://x/2.jpg"]}"#,
        )
        .unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages[0].url, "http://x/1.jpg");
        assert_eq!(stored.pages[1].url, "http://x/2.jpg");
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
    fn drops_negative_and_oversized_dimensions() {
        let meta = resolve(
            r#"{"pages":[
                {"url":"http://x/1.jpg","width":-1,"height":1200},
                {"url":"http://x/2.jpg","width":4294967296,"height":1200},
                {"url":"http://x/3.jpg","width":800,"height":-5},
                {"url":"http://x/4.jpg","width":4294967295,"height":4294967295}
            ]}"#,
        )
        .unwrap();
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert!(stored.pages[..3]
            .iter()
            .all(|p| p.width.is_none() && p.height.is_none()));
        assert_eq!(stored.pages[3].width, Some(u32::MAX));
        assert_eq!(stored.pages[3].height, Some(u32::MAX));
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

    #[test]
    fn links_do_not_change_manifest_hash() {
        let url = url::Url::parse("http://example.com/gallery").unwrap();
        let pages = vec![PageRef {
            url: "http://x/1.jpg".into(),
            width: None,
            height: None,
            anchor: None,
        }];
        let plain = make_meta(&url, "T", pages.clone()).unwrap();
        let linked = make_meta_with_links(
            &url,
            "T",
            pages,
            MetaLinks {
                series_id: Some("series-a".into()),
                next_url: Some("http://example.com/next".into()),
                ..MetaLinks::default()
            },
        )
        .unwrap();
        let a: StoredMeta = serde_json::from_str(&plain.meta_json).unwrap();
        let b: StoredMeta = serde_json::from_str(&linked.meta_json).unwrap();
        assert_eq!(a.manifest_hash, b.manifest_hash);
        assert_eq!(b.series_id.as_deref(), Some("series-a"));
        assert_eq!(b.next_url.as_deref(), Some("http://example.com/next"));
    }

    #[test]
    fn stored_meta_old_json_remains_compatible() {
        let old: StoredMeta =
            serde_json::from_str(r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[]}"#)
                .unwrap();
        assert!(old.series_id.is_none());
        assert!(old.next_url.is_none());
        let json = serde_json::to_string(&old).unwrap();
        assert!(!json.contains("seriesId"), "{json}");
        assert!(!json.contains("nextUrl"), "{json}");
    }

    #[test]
    fn parse_manifest_reads_normalized_links() {
        let url = url::Url::parse("http://example.com/manifest").unwrap();
        let meta = parse_manifest(
            br#"{"pages":["http://x/1.jpg"],"seriesId":"  s  ","nextUrl":"HTTP://X/next#frag"}"#,
            &url,
        )
        .unwrap();
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.series_id.as_deref(), Some("s"));
        assert_eq!(stored.next_url.as_deref(), Some("http://x/next"));
    }

    #[test]
    fn parse_manifest_blank_links_are_none_and_bad_next_url_errors() {
        let url = url::Url::parse("http://example.com/manifest").unwrap();
        let meta = parse_manifest(
            br#"{"pages":["http://x/1.jpg"],"seriesId":"  ","nextUrl":" "}"#,
            &url,
        )
        .unwrap();
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert!(stored.series_id.is_none());
        assert!(stored.next_url.is_none());
        assert!(parse_manifest(
            br#"{"pages":["http://x/1.jpg"],"nextUrl":"file:///x"}"#,
            &url
        )
        .is_err());
    }

    #[test]
    fn parses_single_batch_manifest_and_chapter_chain() {
        let single = parse_batch_payload(
            br#"{"url":"HTTP://Example.COM/c1#f","title":"","seriesId":" S ",
                 "nextUrl":"http://example.com/c2","pages":["http://x/1.jpg","http://x/1.jpg#frag","http://x/2.jpg"]}"#,
        )
        .unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].canonical_url, "http://example.com/c1");
        assert_eq!(single[0].title, "c1");
        assert_eq!(single[0].page_count, 2);
        assert_eq!(single[0].series_id.as_deref(), Some("S"));
        assert_eq!(single[0].next_url.as_deref(), Some("http://example.com/c2"));
        let stored: StoredMeta = serde_json::from_str(&single[0].meta_json).unwrap();
        assert_eq!(stored.series_id.as_deref(), Some("S"));
        assert_eq!(stored.next_url.as_deref(), Some("http://example.com/c2"));

        let batch = parse_batch_payload(
            r#"{"version":1,"seriesTitle":" Series ","chapters":[
                    {"title":"第1话","url":"HTTP://E/1#f","pages":["http://x/1.jpg"]},
                    {"title":"","url":"http://e/2","pages":["http://x/2.jpg"]}
                 ],"nextUrl":"HTTP://E/3#x"}"#
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(batch.len(), 2);
        let first: StoredMeta = serde_json::from_str(&batch[0].meta_json).unwrap();
        let second: StoredMeta = serde_json::from_str(&batch[1].meta_json).unwrap();
        let expected_series = test_hash("Series");
        assert_eq!(first.series_id.as_deref(), Some(expected_series.as_str()));
        assert_eq!(second.series_id.as_deref(), Some(expected_series.as_str()));
        assert_eq!(
            batch[0].series_id.as_deref(),
            Some(expected_series.as_str())
        );
        assert_eq!(batch[0].series_title.as_deref(), Some("Series"));
        assert_eq!(batch[0].chapter_index, Some(1));
        assert_eq!(batch[1].chapter_index, Some(2));
        assert_eq!(batch[0].canonical_url, "http://e/1");
        assert_eq!(batch[0].title, "第1话");
        assert_eq!(batch[1].title, "2");
        assert_eq!(batch[0].next_url.as_deref(), Some("http://e/2"));
        assert_eq!(first.next_url.as_deref(), Some("http://e/2"));
        assert_eq!(second.next_url.as_deref(), Some("http://e/3"));
    }

    fn test_hash(value: &str) -> String {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(value.as_bytes()))
    }

    #[test]
    fn batch_series_id_is_stable_and_prefers_explicit_id() {
        let body = r#"{"seriesTitle":" Series ","chapters":[
            {"title":"1","url":"http://e/ch/1","pages":["http://x/1.jpg"]}
        ]}"#;
        let first = parse_batch_payload(body.as_bytes()).unwrap();
        let second = parse_batch_payload(body.as_bytes()).unwrap();
        assert_eq!(first[0].series_id, second[0].series_id);
        assert_eq!(
            first[0].series_id.as_deref(),
            Some(test_hash("Series").as_str())
        );

        let other = r#"{"seriesTitle":"Other","chapters":[
            {"title":"1","url":"http://e/ch/1","pages":["http://x/1.jpg"]}
        ]}"#;
        assert_ne!(
            first[0].series_id,
            parse_batch_payload(other.as_bytes()).unwrap()[0].series_id
        );

        let explicit = r#"{"seriesId":" explicit ","seriesTitle":"Series","chapters":[
            {"title":"1","url":"http://e/ch/1","pages":["http://x/1.jpg"]}
        ]}"#;
        let meta = parse_batch_payload(explicit.as_bytes()).unwrap();
        assert_eq!(meta[0].series_id.as_deref(), Some("explicit"));
        assert_eq!(meta[0].series_title.as_deref(), Some("Series"));
    }

    #[test]
    fn batch_series_id_falls_back_to_first_chapter_parent_path() {
        let body = r#"{"chapters":[
            {"title":"1","url":"HTTP://E/ch/1#f","pages":["http://x/1.jpg"]},
            {"title":"2","url":"http://e/ch/2","pages":["http://x/2.jpg"]}
        ]}"#;
        let metas = parse_batch_payload(body.as_bytes()).unwrap();
        assert_eq!(
            metas[0].series_id.as_deref(),
            Some(test_hash("/ch/").as_str())
        );
        assert_eq!(metas[0].series_id, metas[1].series_id);
        assert!(metas[0].series_title.is_none());
    }

    #[test]
    fn batch_manifest_rejects_bad_shapes() {
        assert_eq!(
            parse_batch_payload(br#"{"chapters":[]}"#)
                .unwrap_err()
                .to_string(),
            "合集清单 chapters 不能为空"
        );
        assert_eq!(
            parse_batch_payload(br#"{"pages":["http://x/1.jpg"]}"#)
                .unwrap_err()
                .to_string(),
            "单本清单缺少 url 字段"
        );
        assert_eq!(
            parse_batch_payload(br#"{"chapters":[{"title":"T","pages":["http://x/1.jpg"]}]}"#)
                .unwrap_err()
                .to_string(),
            "第 1 章缺少 url 字段"
        );
        assert_eq!(
            parse_batch_payload(br#"{"version":2,"url":"http://e/1","pages":["http://x/1.jpg"]}"#)
                .unwrap_err()
                .to_string(),
            "不支持的清单版本：2"
        );
        assert!(parse_batch_payload(
            br#"{"url":"http://e/1","nextUrl":"file:///x","pages":["http://x/1.jpg"]}"#
        )
        .is_err());

        let chapters: Vec<serde_json::Value> = (0..=100)
            .map(|i| {
                serde_json::json!({
                    "title": format!("第{i}话"),
                    "url": format!("http://e/{i}"),
                    "pages": ["http://x/1.jpg"],
                })
            })
            .collect();
        let body = serde_json::json!({"chapters": chapters}).to_string();
        assert_eq!(
            parse_batch_payload(body.as_bytes())
                .unwrap_err()
                .to_string(),
            "合集章节数超过上限 100"
        );
    }
}
