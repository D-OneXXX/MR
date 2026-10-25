//! Telegram 公开频道/群组的免登录 Web 预览解析。
//!
//! 仅访问 `https://t.me/s/<channel>`、`https://t.me/<channel>/<id>?embed=1`
//! 与 `https://telegra.ph/<slug>` 的公开 HTML，不登录、不读取第三方 Cookie、
//! 不向 WebView 注入脚本。图片直链带时效签名，持久化只保存
//! `channel + message_id + photo_index` 锚点；403/404 时按锚点静默刷新。

use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::online::direct::{make_filtered_meta, probe_image, MetaLinks, OnlineBookMeta};
use crate::online::filter::{
    filter_candidates, CandidateImage, CandidateSource, FilterMemory, FilterThresholds,
};
use crate::online::http::HttpTransport;
use crate::online::{
    normalize_url, redact_url_for_log, title_from_url, truncate_chars, PageAnchor,
    MANIFEST_MAX_BYTES,
};
use crate::source::BackendError;

/// 公开直读目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramTarget {
    /// 频道主页（可带 `?before=` 分页游标）。
    Channel {
        channel: String,
        before: Option<i64>,
        refresh_base: String,
    },
    /// 单条消息（相册组会一并聚合）。
    Message {
        channel: String,
        message_id: i64,
        refresh_base: String,
    },
    /// Telegraph 单章页面。
    Telegraph { url: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TelegramChapterKind {
    Telegraph,
    Photos,
    Document,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDocument {
    pub url: String,
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChapter {
    /// 稳定标识：`channel/message_id` 或 `channel/group:<grouped_id>`。
    pub id: String,
    pub title: String,
    /// 可再次交给 `resolve_online_url` 的规范化 URL。
    pub url: String,
    pub message_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
    pub kind: TelegramChapterKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<TelegramDocument>,
    #[serde(default)]
    pub grouped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannel {
    pub channel: String,
    pub title: String,
    pub chapters: Vec<TelegramChapter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    pub has_more: bool,
}

/// 是否为受支持的 Telegram/Telegraph 链接。
pub fn is_telegram_url(raw: &str) -> bool {
    let raw = raw.trim().to_ascii_lowercase();
    raw.starts_with("tg://")
        || raw.starts_with("https://t.me/")
        || raw.starts_with("http://t.me/")
        || raw.starts_with("https://telegram.me/")
        || raw.starts_with("http://telegram.me/")
        || raw.starts_with("https://telegra.ph/")
        || raw.starts_with("http://telegra.ph/")
}

/// 调试构建的隔离夹具：`MR_TELEGRAM_TEST_ORIGIN=http://127.0.0.1:PORT`。
/// 仅接受 loopback 地址；release 构建永远返回 None。
fn test_origin() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let origin = std::env::var("MR_TELEGRAM_TEST_ORIGIN").ok()?;
    let origin = origin.trim().trim_end_matches('/').to_string();
    let u = url::Url::parse(&origin).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    if matches!(u.scheme(), "http" | "https")
        && (host == "127.0.0.1" || host == "localhost")
    {
        Some(origin)
    } else {
        None
    }
}

/// 把频道/消息/tg:// 链接归一化为受支持目标。
pub fn normalize_target(raw: &str) -> Result<TelegramTarget, BackendError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(BackendError::Msg("Telegram 链接不能为空".into()));
    }
    if let Some(rest) = raw.strip_prefix("tg://resolve?") {
        let query = url::form_urlencoded::parse(rest.as_bytes());
        let channel = query
            .filter(|(k, _)| k == "domain")
            .map(|(_, v)| v.trim().to_string())
            .find(|v| !v.is_empty())
            .ok_or_else(|| BackendError::Msg("tg:// 链接缺少 domain 参数".into()))?;
        let channel = validate_channel(&channel)?;
        return Ok(TelegramTarget::Channel {
            channel,
            before: None,
            refresh_base: test_origin().unwrap_or_else(|| "https://t.me".into()),
        });
    }
    let mut u = url::Url::parse(raw).map_err(|e| BackendError::Msg(format!("URL 无效：{e}")))?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "telegra.ph" {
        if !matches!(u.scheme(), "http" | "https") {
            return Err(BackendError::Msg("仅支持 http/https Telegraph URL".into()));
        }
        u.set_query(None);
        u.set_fragment(None);
        let url = if let Some(origin) = test_origin() {
            let slug = u.path().trim_start_matches('/').trim();
            if slug.is_empty() {
                return Err(BackendError::Msg("Telegraph 链接缺少页面名".into()));
            }
            format!("{origin}/telegraph/{slug}")
        } else {
            u.to_string()
        };
        return Ok(TelegramTarget::Telegraph { url });
    }
    if !matches!(host.as_str(), "t.me" | "telegram.me") {
        return Err(BackendError::Msg("不是受支持的 Telegram 链接".into()));
    }
    let segments: Vec<String> = u
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let Some(first) = segments.first() else {
        return Err(BackendError::Msg("Telegram 链接缺少频道名".into()));
    };
    let channel = if first == "s" {
        segments
            .get(1)
            .cloned()
            .ok_or_else(|| BackendError::Msg("Telegram 预览链接缺少频道名".into()))?
    } else {
        first.clone()
    };
    let channel = validate_channel(&channel)?;
    let message_id = if first == "s" {
        segments.get(2).and_then(|v| v.parse::<i64>().ok())
    } else {
        segments.get(1).and_then(|v| v.parse::<i64>().ok())
    };
    let before = u
        .query_pairs()
        .find(|(k, _)| k == "before")
        .and_then(|(_, v)| v.parse::<i64>().ok())
        .filter(|v| *v > 0);
    let refresh_base = test_origin().unwrap_or_else(|| "https://t.me".into());
    match message_id {
        Some(message_id) if message_id > 0 => Ok(TelegramTarget::Message {
            channel,
            message_id,
            refresh_base,
        }),
        _ => Ok(TelegramTarget::Channel {
            channel,
            before,
            refresh_base,
        }),
    }
}

fn validate_channel(raw: &str) -> Result<String, BackendError> {
    let channel = raw.trim().to_ascii_lowercase();
    if channel.is_empty()
        || channel.len() > 64
        || !channel
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(BackendError::Msg("Telegram 频道名非法".into()));
    }
    Ok(channel)
}

/// 拉取频道页并解析章节列表（`before` 用于向上回溯）。
pub fn fetch_channel(
    http: &dyn HttpTransport,
    raw_url: &str,
    before: Option<i64>,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<TelegramChannel, BackendError> {
    let target = normalize_target(raw_url)?;
    let TelegramTarget::Channel {
        channel,
        before: target_before,
        refresh_base,
    } = target
    else {
        return Err(BackendError::Msg("该链接不是 Telegram 频道主页".into()));
    };
    let cursor = before.or(target_before).filter(|v| *v > 0);
    let mut url = format!("{refresh_base}/s/{channel}");
    if let Some(cursor) = cursor {
        url.push_str(&format!("?before={cursor}"));
    }
    let resp = get_html(http, &url, "https://t.me/")?;
    parse_channel_html(&resp, &channel, &refresh_base, cursor, memory, thresholds)
}

fn parse_channel_html(
    html: &str,
    channel: &str,
    refresh_base: &str,
    cursor: Option<i64>,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<TelegramChannel, BackendError> {
    let _ = (refresh_base, cursor);
    let title = channel_title(html).unwrap_or_else(|| channel.to_string());
    let messages = parse_messages(html);
    let groups = group_messages(messages);
    let mut chapters = Vec::new();
    for group in groups {
        if group.photos.is_empty()
            && group.telegraph.is_none()
            && group.document.is_none()
        {
            continue;
        }
        let message_id = group.first_id;
        let title = chapter_title(&group.text, message_id);
        let grouped = group.messages > 1;
        let (kind, url, page_count, document) = if let Some(document) = group.document {
            (
                TelegramChapterKind::Document,
                format!("https://t.me/{channel}/{message_id}"),
                None,
                Some(document),
            )
        } else if let Some(telegraph) = group.telegraph {
            (
                TelegramChapterKind::Telegraph,
                telegraph,
                None,
                None,
            )
        } else {
            (
                TelegramChapterKind::Photos,
                format!("https://t.me/{channel}/{message_id}"),
                Some(group.photos.len() as u32),
                None,
            )
        };
        chapters.push(TelegramChapter {
            id: format!("{channel}/{message_id}"),
            title,
            url,
            message_id,
            page_count,
            kind,
            document,
            grouped,
        });
    }
    chapters.sort_by_key(|c| c.message_id);
    let before = parse_before(html);
    let _ = (cursor, memory, thresholds);
    Ok(TelegramChannel {
        channel: channel.to_string(),
        title,
        chapters,
        before,
        has_more: before.is_some(),
    })
}

fn get_html(
    http: &dyn HttpTransport,
    url: &str,
    referer: &str,
) -> Result<String, BackendError> {
    let resp = http.get(url, MANIFEST_MAX_BYTES, Some(referer), Some(url))?;
    if !(200..300).contains(&resp.status) {
        return Err(BackendError::Network(format!(
            "Telegram 页面 HTTP {}：{}",
            resp.status,
            redact_url_for_log(url)
        )));
    }
    Ok(String::from_utf8_lossy(&resp.body).to_string())
}

/// 解析单条消息 / 相册组 / Telegraph 页面并返回可入库的在线书。
pub fn resolve_book(
    http: &dyn HttpTransport,
    raw_url: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    match normalize_target(raw_url)? {
        TelegramTarget::Telegraph { url } => {
            resolve_telegraph(http, &url, memory, thresholds)
        }
        TelegramTarget::Message {
            channel,
            message_id,
            refresh_base,
        } => resolve_message(
            http,
            &channel,
            message_id,
            &refresh_base,
            memory,
            thresholds,
        ),
        TelegramTarget::Channel { .. } => Err(BackendError::Msg(
            "Telegram 频道主页已识别；请先选择章节再进入阅读器".into(),
        )),
    }
}

fn resolve_message(
    http: &dyn HttpTransport,
    channel: &str,
    message_id: i64,
    refresh_base: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let embed_url = format!("{refresh_base}/{channel}/{message_id}?embed=1");
    let html = get_html(http, &embed_url, "https://t.me/")?;
    let messages = parse_messages(&html);
    let message = messages
        .iter()
        .find(|m| m.id == message_id)
        .or_else(|| messages.first())
        .ok_or_else(|| BackendError::Msg("Telegram 消息页没有可解析内容".into()))?;
    if message.photos.is_empty() {
        if let Some(telegraph) = message.telegraph.as_deref() {
            return resolve_telegraph(http, telegraph, memory, thresholds);
        }
        if message.document.is_some() {
            return Err(BackendError::Msg(
                "压缩包附件请使用下载按钮导入".into(),
            ));
        }
        return Err(BackendError::Msg(
            "未找到正文图片；该消息可能是纯文本或贴纸".into(),
        ));
    }
    let canonical = url::Url::parse(&format!("https://t.me/{channel}/{message_id}"))
        .map_err(|e| BackendError::Msg(format!("Telegram 规范化失败：{e}")))?;
    let title = chapter_title(&message.text, message_id);
    let candidates: Vec<CandidateImage> = message
        .photos
        .iter()
        .enumerate()
        .map(|(index, url)| CandidateImage {
            url: url.clone(),
            width: None,
            height: None,
            order: index,
            in_chrome: false,
            container: None,
            class_id: None,
            alt: Some(title.clone()),
            source: CandidateSource::Telegram,
            anchor: Some(PageAnchor {
                channel: channel.to_string(),
                message_id,
                photo_index: index as u32,
                refresh_base: Some(refresh_base.to_string()),
            }),
        })
        .collect();
    let referer = canonical.as_str().to_string();
    let mut probe = |candidate: &CandidateImage| probe_image(http, &referer, candidate);
    let outcome = filter_candidates(candidates, memory, thresholds, &mut probe);
    if outcome.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "未找到正文图片（已过滤 {} 张非正文图）",
            outcome.blocked.len()
        )));
    }
    make_filtered_meta(&canonical, &title, outcome, MetaLinks::default())
}

fn resolve_telegraph(
    http: &dyn HttpTransport,
    url: &str,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
) -> Result<OnlineBookMeta, BackendError> {
    let canonical = normalize_url(url)?;
    let html = get_html(http, canonical.as_str(), "https://telegra.ph/")?;
    let title = telegraph_title(&html).unwrap_or_else(|| title_from_url(&canonical));
    let article = extract_article(&html);
    let img_re = Regex::new(r"(?is)<img\b[^>]*>").expect("img regex");
    let src_re = Regex::new(r#"(?is)\bsrc\s*=\s*["']([^"']+)["']"#).expect("src regex");
    let data_re = Regex::new(r#"(?is)\bdata-src\s*=\s*["']([^"']+)["']"#).expect("data regex");
    let width_re = Regex::new(r#"(?is)\b(?:width|data-width)\s*=\s*["']?(\d+)"#).expect("w regex");
    let height_re =
        Regex::new(r#"(?is)\b(?:height|data-height)\s*=\s*["']?(\d+)"#).expect("h regex");
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for tag in img_re.find_iter(article) {
        let tag = tag.as_str();
        let raw = data_re
            .captures(tag)
            .or_else(|| src_re.captures(tag))
            .map(|c| decode_entities(c[1].trim()))
            .unwrap_or_default();
        if raw.is_empty() || raw.starts_with("data:") || raw.starts_with("blob:") {
            continue;
        }
        let lower = raw.to_ascii_lowercase();
        if lower.ends_with(".svg") || lower.ends_with(".ico") {
            continue;
        }
        let Ok(joined) = canonical.join(&raw) else {
            continue;
        };
        let Ok(url) = normalize_url(joined.as_str()) else {
            continue;
        };
        let url = url.to_string();
        if !seen.insert(url.clone()) {
            continue;
        }
        let width = width_re
            .captures(tag)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|v| *v > 0);
        let height = height_re
            .captures(tag)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|v| *v > 0);
        candidates.push(CandidateImage {
            url,
            width,
            height,
            order: candidates.len(),
            in_chrome: false,
            container: Some("article".into()),
            class_id: None,
            alt: None,
            source: CandidateSource::Telegraph,
            anchor: None,
        });
    }
    if candidates.is_empty() {
        return Err(BackendError::Msg("Telegraph 页面未找到图片".into()));
    }
    let referer = canonical.as_str().to_string();
    let mut probe = |candidate: &CandidateImage| probe_image(http, &referer, candidate);
    let outcome = filter_candidates(candidates, memory, thresholds, &mut probe);
    if outcome.pages.is_empty() {
        return Err(BackendError::Msg(format!(
            "Telegraph 图片均被判定为非正文图（已过滤 {} 张）",
            outcome.blocked.len()
        )));
    }
    let title = truncate_chars(&title, 200);
    make_filtered_meta(&canonical, &title, outcome, MetaLinks::default())
}

/// 图片直链 403/404 时按锚点重新请求消息页，返回新的直链。
pub fn refresh_page_url(
    http: &dyn HttpTransport,
    anchor: &PageAnchor,
) -> Result<Option<String>, BackendError> {
    let base = anchor
        .refresh_base
        .as_deref()
        .unwrap_or("https://t.me")
        .trim_end_matches('/');
    let base_url = url::Url::parse(base)
        .map_err(|e| BackendError::Msg(format!("刷新基地址无效：{e}")))?;
    let host = base_url.host_str().unwrap_or("").to_ascii_lowercase();
    let local = host == "127.0.0.1" || host == "localhost";
    if !matches!(base_url.scheme(), "http" | "https")
        || !(matches!(host.as_str(), "t.me" | "telegram.me") || local)
    {
        return Err(BackendError::Msg("刷新基地址不在允许范围".into()));
    }
    let url = format!(
        "{base}/{}/{}?embed=1",
        anchor.channel, anchor.message_id
    );
    let html = get_html(http, &url, "https://t.me/")?;
    let photos = parse_messages(&html)
        .into_iter()
        .find(|m| m.id == anchor.message_id)
        .or_else(|| parse_messages(&html).into_iter().next())
        .map(|m| m.photos)
        .unwrap_or_default();
    // 只返回锚点对应的图片；相册顺序异常时宁可失败重试，也不能悄悄
    // 把另一页当成当前页。
    Ok(photos.get(anchor.photo_index as usize).cloned())
}

// ---------- HTML parsing helpers ----------

#[derive(Debug, Clone, Default)]
struct ParsedMessage {
    id: i64,
    grouped_id: Option<String>,
    text: String,
    photos: Vec<String>,
    telegraph: Option<String>,
    document: Option<TelegramDocument>,
}

#[derive(Debug, Clone)]
struct MessageGroup {
    first_id: i64,
    grouped_id: Option<String>,
    messages: usize,
    text: String,
    photos: Vec<String>,
    telegraph: Option<String>,
    document: Option<TelegramDocument>,
}

impl MessageGroup {
    fn from_message(message: ParsedMessage) -> Self {
        Self {
            first_id: message.id,
            grouped_id: message.grouped_id,
            messages: 1,
            text: message.text,
            photos: message.photos,
            telegraph: message.telegraph,
            document: message.document,
        }
    }

    fn push(&mut self, message: ParsedMessage) {
        self.messages += 1;
        if self.text.is_empty() {
            self.text = message.text;
        }
        self.photos.extend(message.photos);
        if self.telegraph.is_none() {
            self.telegraph = message.telegraph;
        }
        if self.document.is_none() {
            self.document = message.document;
        }
    }
}

fn parse_messages(html: &str) -> Vec<ParsedMessage> {
    let wrap_re = Regex::new(
        r#"(?is)<div[^>]*class="(?:[^"]*\s)?tgme_widget_message(?:\s[^"]*)?"[^>]*>"#,
    )
    .expect("message regex");
    let mut starts = Vec::new();
    for m in wrap_re.find_iter(html) {
        starts.push((m.start(), m.end(), m.as_str().to_string()));
    }
    let mut out = Vec::new();
    for (index, (start, tag_end, tag)) in starts.iter().enumerate() {
        let end = starts
            .get(index + 1)
            .map(|(next, _, _)| *next)
            .unwrap_or(html.len());
        let block = &html[*tag_end..end];
        let Some(post) = attr(tag, "data-post") else {
            continue;
        };
        let Some(id) = post
            .rsplit('/')
            .next()
            .and_then(|v| v.parse::<i64>().ok())
        else {
            continue;
        };
        let grouped_id = attr(tag, "data-grouped-id").filter(|v| !v.trim().is_empty());
        let text = message_text(block);
        let photos = message_photos(block);
        let telegraph = telegraph_link(block);
        let document = message_document(block);
        let _ = start;
        out.push(ParsedMessage {
            id,
            grouped_id,
            text,
            photos,
            telegraph,
            document,
        });
    }
    out.sort_by_key(|m| m.id);
    out
}

fn group_messages(messages: Vec<ParsedMessage>) -> Vec<MessageGroup> {
    let mut groups: Vec<MessageGroup> = Vec::new();
    for message in messages {
        if let Some(grouped_id) = message.grouped_id.as_deref() {
            if let Some(group) = groups
                .iter_mut()
                .find(|g| g.grouped_id.as_deref() == Some(grouped_id))
            {
                group.push(message);
                continue;
            }
        }
        let can_merge = groups.last().is_some_and(|last| {
            let current_photo_only =
                !message.photos.is_empty() && message.telegraph.is_none() && message.document.is_none();
            let last_photo_only = last.telegraph.is_none()
                && last.document.is_none()
                && !last.photos.is_empty();
            current_photo_only
                && last_photo_only
                && message.id - last.first_id <= 1
                && (message.text.trim().is_empty()
                    || last.text.trim().is_empty()
                    || message.text.trim() == last.text.trim())
        });
        if can_merge {
            if let Some(last) = groups.last_mut() {
                last.push(message);
            }
        } else {
            groups.push(MessageGroup::from_message(message));
        }
    }
    groups
}

fn channel_title(html: &str) -> Option<String> {
    let meta = Regex::new(
        r#"(?is)<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']"#,
    )
    .ok()?;
    let meta2 = Regex::new(
        r#"(?is)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']og:title["']"#,
    )
    .ok()?;
    meta.captures(html)
        .or_else(|| meta2.captures(html))
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let re = Regex::new(
                r#"(?is)<div[^>]*class="[^"]*tgme_channel_info_header_title[^"]*"[^>]*>(.*?)</div>"#,
            )
            .ok()?;
            re.captures(html)
                .map(|c| decode_entities(&strip_tags(&c[1])))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

fn telegraph_title(html: &str) -> Option<String> {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    re.captures(html)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn extract_article(html: &str) -> &str {
    let re = Regex::new(r"(?is)<article\b[^>]*>(.*?)</article>").expect("article regex");
    re.captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or(html)
}

fn message_text(block: &str) -> String {
    let re = Regex::new(
        r#"(?is)<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>"#,
    )
    .expect("text regex");
    re.captures(block)
        .map(|c| decode_entities(&strip_tags(&c[1])))
        .map(|s| s.replace('\u{00a0}', " "))
        .unwrap_or_default()
}

fn message_photos(block: &str) -> Vec<String> {
    let wrap = Regex::new(
        r#"(?is)<a[^>]*class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>"#,
    )
    .expect("photo regex");
    let style = Regex::new(
        r#"(?is)background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)"#,
    )
    .expect("style regex");
    let img = Regex::new(r#"(?is)<img[^>]+src\s*=\s*["']([^"']+)["']"#).expect("img regex");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for wrapper in wrap.find_iter(block) {
        let tag = wrapper.as_str();
        let raw = style
            .captures(tag)
            .map(|c| c[1].trim().to_string())
            .or_else(|| {
                let end = block[wrapper.end()..]
                    .find("</a>")
                    .map(|offset| wrapper.end() + offset)
                    .unwrap_or(block.len());
                img.captures(&block[wrapper.start()..end])
                    .map(|c| c[1].trim().to_string())
            });
        let Some(raw) = raw else {
            continue;
        };
        let raw = decode_entities(&raw);
        let raw = if raw.starts_with("//") {
            format!("https:{raw}")
        } else if raw.starts_with('/') {
            format!("https://t.me{raw}")
        } else {
            raw
        };
        if let Ok(url) = normalize_url(&raw) {
            let url = url.to_string();
            if seen.insert(url.clone()) {
                out.push(url);
            }
        }
    }
    out
}

fn telegraph_link(block: &str) -> Option<String> {
    let re = Regex::new(r#"(?is)https?://telegra\.ph/[A-Za-z0-9_-]+"#).ok()?;
    re.find(block).map(|m| decode_entities(m.as_str()))
}

fn message_document(block: &str) -> Option<TelegramDocument> {
    let re = Regex::new(
        r#"(?is)<a[^>]*class="[^"]*tgme_widget_message_document_wrap[^"]*"[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#,
    )
    .ok()?;
    let caps = re.captures(block)?;
    let raw = decode_entities(caps.get(1)?.as_str().trim());
    let url = if raw.starts_with("//") {
        format!("https:{raw}")
    } else if raw.starts_with('/') {
        format!("https://t.me{raw}")
    } else {
        raw
    };
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    let text = decode_entities(&strip_tags(caps.get(2).map(|m| m.as_str()).unwrap_or("")));
    let filename = text
        .split_whitespace()
        .next()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            url::Url::parse(&url)
                .ok()
                .and_then(|u| {
                    u.path_segments()
                        .and_then(|mut s| s.rfind(|x| !x.is_empty()))
                        .map(str::to_string)
                })
        })
        .unwrap_or_else(|| "telegram.cbz".into());
    // Telegram CDN 文档直链常常没有扩展名；以消息里的文件名为准，
    // 只有两者都不是 zip/cbz 才拒绝。
    let url_lower = url.to_ascii_lowercase();
    let name_lower = filename.to_ascii_lowercase();
    if !(url_lower.contains(".zip")
        || url_lower.contains(".cbz")
        || name_lower.ends_with(".zip")
        || name_lower.ends_with(".cbz"))
    {
        return None;
    }
    let size = Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(KB|MB|GB)")
        .ok()
        .and_then(|re| re.captures(&text))
        .and_then(|c| {
            let value = c[1].parse::<f64>().ok()?;
            let unit = c[2].to_ascii_uppercase();
            let multiplier = match unit.as_str() {
                "KB" => 1024.0,
                "MB" => 1024.0 * 1024.0,
                "GB" => 1024.0 * 1024.0 * 1024.0,
                _ => 1.0,
            };
            Some((value * multiplier) as u64)
        });
    Some(TelegramDocument {
        url,
        filename,
        size,
    })
}

fn parse_before(html: &str) -> Option<i64> {
    let re = Regex::new(r#"(?i)(?:href|data-before)\s*=\s*["'][^"']*before=(\d+)"#).ok()?;
    re.captures(html)
        .and_then(|c| c[1].parse::<i64>().ok())
        .filter(|v| *v > 0)
}

fn chapter_title(text: &str, message_id: i64) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let cleaned = first
        .split_whitespace()
        .filter(|token| !token.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let title = if cleaned.is_empty() {
        format!("消息 {message_id}")
    } else {
        cleaned
    };
    truncate_chars(&title, 120)
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)\b{}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        regex::escape(name)
    );
    let re = Regex::new(&pattern).ok()?;
    re.captures(tag)
        .and_then(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
        .map(|m| m.as_str().to_string())
}

fn strip_tags(s: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("strip regex")
        .replace_all(s, "")
        .to_string()
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;
    use crate::online::http::HttpResponse;
    use crate::online::OnlineError;

    struct MapHttp {
        responses: HashMap<String, (u16, Vec<u8>)>,
        calls: Mutex<Vec<String>>,
    }

    impl MapHttp {
        fn new(responses: Vec<(&str, u16, Vec<u8>)>) -> Self {
            Self {
                responses: responses
                    .into_iter()
                    .map(|(url, status, body)| (url.to_string(), (status, body)))
                    .collect(),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for MapHttp {
        fn get(
            &self,
            url: &str,
            _max: usize,
            _referer: Option<&str>,
            _scope: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            self.calls.lock().unwrap().push(url.to_string());
            if let Some((status, body)) = self.responses.get(url) {
                Ok(HttpResponse {
                    status: *status,
                    final_url: url.to_string(),
                    content_type: Some("text/html".into()),
                    body: body.clone(),
                })
            } else {
                Ok(HttpResponse {
                    status: 404,
                    final_url: url.to_string(),
                    content_type: None,
                    body: Vec::new(),
                })
            }
        }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(
                &vec![120u8; (width * height * 4) as usize],
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        buf
    }

    fn channel_html() -> String {
        r#"<html><head><meta property="og:title" content="QA Channel"></head><body>
        <div class="tgme_widget_message" data-post="demo/101">
          <a class="tgme_widget_message_user_photo"><img src="https://cdn/avatar.png"></a>
          <div class="tgme_widget_message_text">频道公告：闲聊</div>
        </div>
        <div class="tgme_widget_message" data-post="demo/102" data-grouped-id="g1">
          <div class="tgme_widget_message_text">第01话 相册</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/1.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/2.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="demo/103" data-grouped-id="g1">
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/3.png')"></a>
        </div>
        <div class="tgme_widget_message" data-post="demo/104">
          <div class="tgme_widget_message_text">第02话 <a href="https://telegra.ph/QA-Test-01">telegraph</a></div>
        </div>
        <div class="tgme_widget_message" data-post="demo/105">
          <div class="tgme_widget_message_text">第03话 附件</div>
          <a class="tgme_widget_message_document_wrap" href="https://cdn/ch3.zip">ch3.zip 12 MB</a>
        </div>
        <div class="tgme_widget_message" data-post="demo/106">
          <i class="tgme_widget_message_sticker"></i>
        </div>
        <a class="tme_messages_more" href="?before=99">more</a>
        </body></html>"#
            .to_string()
    }

    #[test]
    fn normalizes_telegram_url_forms() {
        assert_eq!(
            normalize_target("https://t.me/s/Demo_Channel").unwrap(),
            TelegramTarget::Channel {
                channel: "demo_channel".into(),
                before: None,
                refresh_base: "https://t.me".into(),
            }
        );
        assert_eq!(
            normalize_target("https://t.me/demo/123").unwrap(),
            TelegramTarget::Message {
                channel: "demo".into(),
                message_id: 123,
                refresh_base: "https://t.me".into(),
            }
        );
        assert_eq!(
            normalize_target("tg://resolve?domain=demo").unwrap(),
            TelegramTarget::Channel {
                channel: "demo".into(),
                before: None,
                refresh_base: "https://t.me".into(),
            }
        );
        assert!(normalize_target("https://example.com/x").is_err());
        assert!(normalize_target("https://t.me/bad name").is_err());
    }

    #[test]
    fn channel_parses_albums_telegraph_documents_and_filters_chatter() {
        let http = MapHttp::new(vec![(
            "https://t.me/s/demo",
            200,
            channel_html().into_bytes(),
        )]);
        let channel = fetch_channel(
            &http,
            "https://t.me/s/demo",
            None,
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(channel.title, "QA Channel");
        assert_eq!(channel.chapters.len(), 3);
        assert_eq!(channel.before, Some(99));
        assert!(channel.has_more);
        let kinds: Vec<_> = channel.chapters.iter().map(|c| c.kind).collect();
        assert_eq!(
            kinds,
            vec![
                TelegramChapterKind::Photos,
                TelegramChapterKind::Telegraph,
                TelegramChapterKind::Document,
            ]
        );
        assert_eq!(channel.chapters[0].page_count, Some(3));
        assert_eq!(channel.chapters[0].message_id, 102);
        assert!(channel.chapters[0].grouped);
        assert_eq!(
            channel.chapters[2]
                .document
                .as_ref()
                .map(|d| d.filename.as_str()),
            Some("ch3.zip")
        );
    }

    #[test]
    fn message_resolves_album_with_anchors_and_filters_small_noise() {
        let embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/200">
          <div class="tgme_widget_message_text">Album 1</div>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/a.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/b.png')"></a>
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/qr.png')"></a>
        </div></body></html>"#;
        let http = MapHttp::new(vec![
            (
                "https://t.me/demo/200?embed=1",
                200,
                embed.as_bytes().to_vec(),
            ),
            ("https://cdn/a.png", 200, png(800, 1200)),
            ("https://cdn/b.png", 200, png(800, 1200)),
            ("https://cdn/qr.png", 200, png(200, 200)),
        ]);
        let meta = resolve_book(
            &http,
            "https://t.me/demo/200",
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(meta.page_count, 2);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages.len(), 2);
        assert_eq!(stored.filtered.len(), 1);
        let anchor = stored.pages[0].anchor.as_ref().unwrap();
        assert_eq!(anchor.channel, "demo");
        assert_eq!(anchor.message_id, 200);
        assert_eq!(anchor.photo_index, 0);
    }

    #[test]
    fn telegraph_extracts_article_images_and_drops_small_logo() {
        let html = r#"<html><head><title>Telegraph QA</title></head><body><article>
            <figure><img src="/file/a.png"></figure>
            <figure><img src="/file/b.png"></figure>
            <figure><img src="/file/c.png"></figure>
            <figure><img src="/file/logo.png" width="96" height="96"></figure>
        </article></body></html>"#;
        let http = MapHttp::new(vec![
            ("https://telegra.ph/QA-Test-01", 200, html.as_bytes().to_vec()),
            ("https://telegra.ph/file/a.png", 200, png(800, 1200)),
            ("https://telegra.ph/file/b.png", 200, png(800, 1200)),
            ("https://telegra.ph/file/c.png", 200, png(800, 1200)),
        ]);
        let meta = resolve_book(
            &http,
            "https://telegra.ph/QA-Test-01",
            &FilterMemory::default(),
            &FilterThresholds::default(),
        )
        .unwrap();
        assert_eq!(meta.page_count, 3);
        let stored: crate::online::StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.filtered.len(), 1);
    }

    #[test]
    fn refresh_returns_new_cdn_url_for_expired_photo() {
        let embed = r#"<html><body>
        <div class="tgme_widget_message" data-post="demo/200">
          <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn/new.png')"></a>
        </div></body></html>"#;
        let http = MapHttp::new(vec![(
            "https://t.me/demo/200?embed=1",
            200,
            embed.as_bytes().to_vec(),
        )]);
        let anchor = PageAnchor {
            channel: "demo".into(),
            message_id: 200,
            photo_index: 0,
            refresh_base: Some("https://t.me".into()),
        };
        let fresh = refresh_page_url(&http, &anchor).unwrap();
        assert_eq!(fresh.as_deref(), Some("https://cdn/new.png"));
    }
}
