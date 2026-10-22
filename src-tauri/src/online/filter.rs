//! 在线图片提纯引擎：多阶段启发式 + 站点档案 + 用户规则。
//!
//! 该模块不依赖网络与数据库：调用方提供候选图片、站点学习记忆和可选的
//! 图片头探测闭包，返回保留页、被过滤页、更新后的站点档案与置信度。
//! 所有持久化（规则、档案、事件）由命令层负责，规则中的 URL 只保存脱敏后的
//! host + path（去掉 query/fragment），避免签名参数进入 SQLite。

use serde::{Deserialize, Serialize};

use crate::online::{PageAnchor, PageRef};

pub const DEFAULT_MIN_WIDTH: u32 = 320;
pub const DEFAULT_MIN_HEIGHT: u32 = 240;
pub const DEFAULT_MAX_ASPECT: f32 = 2.8;
pub const DEFAULT_MEDIAN_TOLERANCE: f32 = 0.4;
/// 单次解析最多探测多少张缺尺寸图片的头部（避免首屏请求风暴）。
pub const MAX_PROBE_IMAGES: usize = 24;

fn default_min_width() -> u32 {
    DEFAULT_MIN_WIDTH
}
fn default_min_height() -> u32 {
    DEFAULT_MIN_HEIGHT
}
fn default_max_aspect() -> f32 {
    DEFAULT_MAX_ASPECT
}
fn default_median_tolerance() -> f32 {
    DEFAULT_MEDIAN_TOLERANCE
}

/// 过滤阈值；站点档案可以收紧/放宽这些阈值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterThresholds {
    #[serde(default = "default_min_width")]
    pub min_width: u32,
    #[serde(default = "default_min_height")]
    pub min_height: u32,
    #[serde(default = "default_max_aspect")]
    pub max_aspect: f32,
    #[serde(default = "default_median_tolerance")]
    pub median_tolerance: f32,
    /// 站点档案里学到的正文标准宽度区间（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_max: Option<u32>,
    /// 是否允许对缺尺寸候选做网络探测（命令层默认 true，纯解析测试可关）。
    #[serde(default = "default_true")]
    pub probe_missing_dimensions: bool,
}

fn default_true() -> bool {
    true
}

impl Default for FilterThresholds {
    fn default() -> Self {
        Self {
            min_width: DEFAULT_MIN_WIDTH,
            min_height: DEFAULT_MIN_HEIGHT,
            max_aspect: DEFAULT_MAX_ASPECT,
            median_tolerance: DEFAULT_MEDIAN_TOLERANCE,
            width_min: None,
            width_max: None,
            probe_missing_dimensions: true,
        }
    }
}

/// 候选图来源，决定启发式的严格程度与可用的 DOM 信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CandidateSource {
    #[default]
    Json,
    Html,
    Telegram,
    Telegraph,
}

/// 图片探测结果（自然尺寸 + 可选内容指纹）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeInfo {
    pub width: u32,
    pub height: u32,
    pub sha256: Option<String>,
}

/// 过滤前候选；`width/height` 可来自清单、HTML 属性或懒加载属性。
#[derive(Debug, Clone)]
pub struct CandidateImage {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub order: usize,
    /// 位于 header/footer/nav/aside/评论区/推荐位等站点 chrome 内。
    pub in_chrome: bool,
    /// 最近的正文容器提示（selector 或 class/id），用于站点档案学习。
    pub container: Option<String>,
    /// 图片自身的 class/id 拼接，供负面词与用户规则使用。
    pub class_id: Option<String>,
    pub alt: Option<String>,
    pub source: CandidateSource,
    pub anchor: Option<PageAnchor>,
}

impl CandidateImage {
    pub fn new(url: impl Into<String>, order: usize) -> Self {
        Self {
            url: url.into(),
            width: None,
            height: None,
            order,
            in_chrome: false,
            container: None,
            class_id: None,
            alt: None,
            source: CandidateSource::Json,
            anchor: None,
        }
    }
}

/// 被过滤的页面；保留在 meta_json 供“已过滤杂图抽屉”展示与恢复。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilteredPage {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// 机器可读原因码（chrome/data/keyword:logo/small/banner/isolated/median/rule）。
    pub reason: String,
    #[serde(default)]
    pub score: f32,
    /// 原文档中的顺序，恢复时按此位置插回。
    #[serde(default)]
    pub order: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<PageAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// 一次解析后学到的站点档案。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteProfile {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_selector: Option<String>,
    /// 主图 CDN 路径模板（数字段归一化为 `#`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdn_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_max: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect_max: Option<f32>,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub updated_at: String,
}

impl SiteProfile {
    pub fn empty(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            main_selector: None,
            cdn_pattern: None,
            width_min: None,
            width_max: None,
            aspect_max: None,
            uses: 0,
            updated_at: String::new(),
        }
    }
}

/// 规则的匹配模式；所有 URL 均为脱敏后的 host + path 模板。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RulePattern {
    /// host + path，连续数字归一化为 `#`，例如 `https://x/ch/#.png`。
    UrlTemplate { template: String },
    /// 完整 URL（已去掉 query/fragment）。
    ExactUrl { url: String },
    /// 图片内容 SHA-256。
    Sha256 { hash: String },
    /// 图片 DOM class/id 片段。
    DomClass { value: String },
    /// 精确尺寸组合（正方形二维码/固定横幅）。
    Size { width: u32, height: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterAction {
    Block,
    Allow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleSource {
    User,
    Learned,
    Imported,
}

/// 持久化规则（与数据库行 1:1）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterRule {
    pub id: String,
    pub host: String,
    pub action: FilterAction,
    pub source: RuleSource,
    pub pattern: RulePattern,
    pub reason: String,
    pub created_at: String,
    #[serde(default)]
    pub hits: u64,
}

/// 一次解析可用的站点学习记忆。
#[derive(Debug, Clone, Default)]
pub struct FilterMemory {
    pub host: String,
    pub profile: Option<SiteProfile>,
    pub rules: Vec<FilterRule>,
}

/// 过滤结果。
#[derive(Debug, Clone)]
pub struct FilterOutcome {
    pub pages: Vec<PageRef>,
    pub blocked: Vec<FilteredPage>,
    /// 学到的站点档案；调用方可按置信度落库。
    pub profile: SiteProfile,
    pub input_count: usize,
    /// 保留比例（0..=1）。
    pub kept_ratio: f32,
}

/// 设置页统计。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterStats {
    pub site_profiles: u32,
    pub rules: u32,
    pub blocked_total: u64,
    pub restored_total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
}

/// 把 URL 归一化为可持久化的 host + path 模板（去掉 query/fragment/userinfo）。
pub fn url_template(raw: &str) -> Option<String> {
    let mut u = url::Url::parse(raw).ok()?;
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.set_query(None);
    u.set_fragment(None);
    let path = normalize_digit_runs(u.path());
    Some(format!(
        "{}://{}{}",
        u.scheme(),
        u.host_str().unwrap_or(""),
        path
    ))
}

/// 保留 host 与 path，去掉 query/fragment；用于规则/事件展示。
pub fn redacted_url(raw: &str) -> String {
    crate::online::redact_url_for_log(raw)
}

pub fn url_host(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

/// 连续数字归一化为 `#`；保留文件扩展名与目录结构。
pub fn normalize_digit_runs(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_digits = false;
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            if !in_digits {
                out.push('#');
                in_digits = true;
            }
        } else {
            in_digits = false;
            out.push(ch);
        }
    }
    out
}

pub fn aspect_ratio(width: u32, height: u32) -> f32 {
    if height == 0 {
        0.0
    } else {
        width as f32 / height as f32
    }
}

pub fn median_width(widths: &[u32]) -> Option<u32> {
    let mut sorted: Vec<u32> = widths.iter().copied().filter(|w| *w > 0).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        Some(((sorted[mid - 1] as u64 + sorted[mid] as u64) / 2) as u32)
    } else {
        Some(sorted[mid])
    }
}

/// 用户/自动规则是否命中候选（URL 与 class 使用脱敏键，hash/size 由调用方补充）。
pub fn rule_matches(rule: &FilterRule, candidate: &CandidateImage, sha256: Option<&str>) -> bool {
    match &rule.pattern {
        RulePattern::UrlTemplate { template } => {
            url_template(&candidate.url).as_deref() == Some(template.as_str())
        }
        RulePattern::ExactUrl { url } => redacted_url(&candidate.url) == *url,
        RulePattern::Sha256 { hash } => sha256.is_some_and(|actual| actual.eq_ignore_ascii_case(hash)),
        RulePattern::DomClass { value } => candidate
            .class_id
            .as_deref()
            .is_some_and(|classes| classes.to_ascii_lowercase().contains(&value.to_ascii_lowercase())),
        RulePattern::Size { width, height } => {
            candidate.width == Some(*width) && candidate.height == Some(*height)
        }
    }
}

/// 站点 chrome / 广告 / UI 元素的负面词。
///
/// 仅匹配 URL path、class/id、alt 与容器提示，避免把签名 query 中的随机串
/// 当成噪音；不收录 `ad`、`icon` 之外的宽泛短词，防止误杀正文文件名。
const NEGATIVE_WORDS: &[&str] = &[
    "logo",
    "avatar",
    "banner",
    "advert",
    "ad_",
    "ad-",
    "qrcode",
    "qr_code",
    "watermark",
    "icon",
    "sprite",
    "btn",
    "button",
    "footer",
    "sponsor",
    "loading",
    "placeholder",
    "thumb",
    "emoji",
    "sticker",
    "share",
    "comment",
    "promo",
    "sidebar",
    "recommend",
    "related",
];

fn placeholder_url(lower: &str) -> bool {
    lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.ends_with(".svg")
        || lower.ends_with(".ico")
        || lower.contains("1x1")
        || lower.contains("spacer")
        || lower.contains("blank.gif")
        || lower.contains("pixel.gif")
}

fn negative_hit(candidate: &CandidateImage) -> Option<&'static str> {
    let hay = format!(
        "{} {} {} {}",
        redacted_url(&candidate.url).to_ascii_lowercase(),
        candidate.class_id.as_deref().unwrap_or("").to_ascii_lowercase(),
        candidate.alt.as_deref().unwrap_or("").to_ascii_lowercase(),
        candidate.container.as_deref().unwrap_or("").to_ascii_lowercase()
    );
    NEGATIVE_WORDS
        .iter()
        .copied()
        .find(|word| hay.contains(word))
}

fn rule_is_allow(rule: &FilterRule) -> bool {
    rule.action == FilterAction::Allow
}

fn pre_probe_rule_match(rule: &FilterRule, candidate: &CandidateImage) -> bool {
    matches!(
        rule.pattern,
        RulePattern::UrlTemplate { .. }
            | RulePattern::ExactUrl { .. }
            | RulePattern::DomClass { .. }
            | RulePattern::Size { .. }
    ) && rule_matches(rule, candidate, None)
}

struct ScoredCandidate {
    candidate: CandidateImage,
    container: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    sha256: Option<String>,
    score: f32,
    reason: Option<String>,
    allow: bool,
}

/// 多阶段提纯：规则 → URL/属性 → 尺寸/宽高比 → 中位宽度 → 序列聚类 → 站点档案。
pub fn filter_candidates(
    candidates: Vec<CandidateImage>,
    memory: &FilterMemory,
    thresholds: &FilterThresholds,
    probe: &mut dyn FnMut(&CandidateImage) -> Option<ProbeInfo>,
) -> FilterOutcome {
    let input_count = candidates.len();
    let host = if memory.host.is_empty() {
        candidates
            .first()
            .map(|c| url_host(&c.url))
            .unwrap_or_default()
    } else {
        memory.host.clone()
    };
    let templates: Vec<Option<String>> = candidates
        .iter()
        .map(|c| url_template(&c.url))
        .collect();
    let mut template_counts: std::collections::HashMap<&str, usize> =
        std::collections::HashMap::new();
    for template in templates.iter().flatten() {
        *template_counts.entry(template.as_str()).or_insert(0) += 1;
    }
    let main_template = template_counts
        .iter()
        .max_by_key(|(_, count)| **count)
        .map(|(template, _)| *template);
    let main_host = candidates
        .iter()
        .find(|c| templates.get(c.order).and_then(|t| t.as_deref()) == main_template)
        .map(|c| url_host(&c.url))
        .unwrap_or_default();
    let max_aspect = memory
        .profile
        .as_ref()
        .and_then(|p| p.aspect_max)
        .map(|v| v.max(thresholds.max_aspect).min(5.0))
        .unwrap_or(thresholds.max_aspect);
    let learned_width_min = thresholds
        .width_min
        .or_else(|| memory.profile.as_ref().and_then(|p| p.width_min));
    let learned_width_max = thresholds
        .width_max
        .or_else(|| memory.profile.as_ref().and_then(|p| p.width_max));

    let mut probed = 0usize;
    let mut scored: Vec<ScoredCandidate> = Vec::with_capacity(input_count);
    for (index, candidate) in candidates.into_iter().enumerate() {
        let mut score = 1.0f32;
        let mut reason: Option<String> = None;
        let mut allow = memory
            .rules
            .iter()
            .filter(|rule| rule_is_allow(rule))
            .any(|rule| pre_probe_rule_match(rule, &candidate));
        let blocked_by_rule = memory
            .rules
            .iter()
            .filter(|rule| !rule_is_allow(rule))
            .any(|rule| pre_probe_rule_match(rule, &candidate));

        let mut width = candidate.width.filter(|v| *v > 0);
        let mut height = candidate.height.filter(|v| *v > 0);
        let mut sha256 = None;
        if (width.is_none() || height.is_none())
            && thresholds.probe_missing_dimensions
            && probed < MAX_PROBE_IMAGES
        {
            probed += 1;
            if let Some(info) = probe(&candidate) {
                if info.width > 0 && info.height > 0 {
                    width = Some(info.width);
                    height = Some(info.height);
                }
                sha256 = info.sha256;
            }
        }
        // 内容指纹规则只能在探测/显式哈希之后匹配。
        if sha256.is_some() {
            if memory
                .rules
                .iter()
                .filter(|rule| rule_is_allow(rule))
                .any(|rule| rule_matches(rule, &candidate, sha256.as_deref()))
            {
                allow = true;
            }
            if memory
                .rules
                .iter()
                .filter(|rule| !rule_is_allow(rule))
                .any(|rule| rule_matches(rule, &candidate, sha256.as_deref()))
            {
                score = 0.0;
                reason = Some("rule".into());
            }
        }

        if allow {
            score = 1.0;
            reason = None;
        } else if blocked_by_rule {
            score = 0.0;
            reason = Some("rule".into());
        }

        if !allow {
            let lower = redacted_url(&candidate.url).to_ascii_lowercase();
            if candidate.in_chrome {
                score -= 1.0;
                reason.get_or_insert_with(|| "chrome".into());
            }
            if placeholder_url(&lower) {
                score -= 1.0;
                reason.get_or_insert_with(|| "data".into());
            }
            if let Some(word) = negative_hit(&candidate) {
                score -= 0.85;
                if reason.is_none() {
                    reason = Some(format!("keyword:{word}"));
                }
            }
            if let (Some(w), Some(h)) = (width, height) {
                if w < thresholds.min_width || h < thresholds.min_height {
                    score -= 1.0;
                    reason.get_or_insert_with(|| "small".into());
                }
                if aspect_ratio(w, h) > max_aspect {
                    score -= 0.9;
                    reason.get_or_insert_with(|| "banner".into());
                }
                if let (Some(low), Some(high)) = (learned_width_min, learned_width_max) {
                    if (w < low || w > high) && aspect_ratio(w, h) <= 1.5 {
                        score -= 0.3;
                        reason.get_or_insert_with(|| "profile".into());
                    }
                }
            }
            if let Some(template) = templates.get(index).and_then(|t| t.as_deref()) {
                let count = template_counts.get(template).copied().unwrap_or(0);
                if main_template != Some(template) && count <= 1 && input_count >= 4 {
                    score -= 0.4;
                    if url_host(&candidate.url) != main_host {
                        score -= 0.2;
                    }
                    reason.get_or_insert_with(|| "isolated".into());
                }
            }
        }

        scored.push(ScoredCandidate {
            container: candidate.container.clone(),
            candidate,
            width,
            height,
            sha256,
            score,
            reason,
            allow,
        });
    }

    // 中位宽度只在拿到尺寸的候选上计算；跨页/横幅有独立豁免。
    let widths: Vec<u32> = scored.iter().filter_map(|s| s.width).collect();
    if let Some(median) = median_width(&widths) {
        let median_f = median as f32;
        let scored_len = scored.len();
        for (index, item) in scored.iter_mut().enumerate() {
            if item.allow {
                continue;
            }
            let (Some(width), Some(height)) = (item.width, item.height) else {
                continue;
            };
            let deviation = (width as f32 - median_f).abs() / median_f.max(1.0);
            let edge = index < 2 || index + 2 >= scored_len;
            let already_penalized = item.reason.is_some();
            if deviation > thresholds.median_tolerance
                && aspect_ratio(width, height) <= 1.5
                && (edge || already_penalized)
            {
                item.score -= 0.35;
                if item.reason.is_none() {
                    item.reason = Some("median".into());
                }
            }
        }
    }

    // 内容指纹规则需要在探测后判断；当前探测闭包返回 sha 的方式由调用方决定。
    // 这里保留 URL/DOM/尺寸规则的完整匹配，哈希规则由用户标记时写入，
    // 并在下一次解析的 URL 模板/尺寸规则中立即生效。

    let mut pages = Vec::new();
    let mut blocked = Vec::new();
    let mut kept_containers = Vec::new();
    for item in scored {
        if item.allow || item.score >= 0.5 {
            if let Some(container) = item.container.clone() {
                kept_containers.push(container);
            }
            pages.push(PageRef {
                url: item.candidate.url,
                width: item.width,
                height: item.height,
                anchor: item.candidate.anchor,
            });
        } else {
            blocked.push(FilteredPage {
                url: item.candidate.url,
                width: item.width,
                height: item.height,
                reason: item.reason.unwrap_or_else(|| "isolated".into()),
                score: item.score.max(0.0),
                order: item.candidate.order,
                anchor: item.candidate.anchor,
                sha256: item.sha256,
            });
        }
    }

    let kept_ratio = if input_count == 0 {
        0.0
    } else {
        pages.len() as f32 / input_count as f32
    };
    let mut profile = memory
        .profile
        .clone()
        .unwrap_or_else(|| SiteProfile::empty(&host));
    profile.host = host;
    if pages.len() >= 3 && kept_ratio >= 0.6 {
        let kept_widths: Vec<u32> = pages.iter().filter_map(|p| p.width).collect();
        let kept_templates: Vec<String> = pages
            .iter()
            .filter_map(|p| url_template(&p.url))
            .collect();
        let mut template_counts: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for template in &kept_templates {
            *template_counts.entry(template.as_str()).or_insert(0) += 1;
        }
        profile.cdn_pattern = template_counts
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .map(|(template, _)| template.to_string());
        let mut container_counts: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for container in &kept_containers {
            *container_counts.entry(container.as_str()).or_insert(0) += 1;
        }
        if let Some((selector, _)) = container_counts
            .into_iter()
            .max_by_key(|(_, count)| *count)
        {
            profile.main_selector = Some(selector.to_string());
        }
        if let Some(median) = median_width(&kept_widths) {
            let portrait: Vec<u32> = pages
                .iter()
                .filter_map(|p| match (p.width, p.height) {
                    (Some(w), Some(h)) if aspect_ratio(w, h) <= 1.5 => Some(w),
                    _ => None,
                })
                .collect();
            let base = median_width(&portrait).unwrap_or(median);
            profile.width_min = Some(
                portrait
                    .iter()
                    .copied()
                    .min()
                    .unwrap_or(base)
                    .max(1),
            );
            profile.width_max = Some(portrait.iter().copied().max().unwrap_or(base).max(1));
        }
        let observed_aspect = pages
            .iter()
            .filter_map(|p| match (p.width, p.height) {
                (Some(w), Some(h)) if w > 0 && h > 0 => Some(aspect_ratio(w, h)),
                _ => None,
            })
            .fold(0.0f32, f32::max);
        profile.aspect_max = Some(
            threshold_aspect_max(max_aspect, observed_aspect)
                .max(thresholds.max_aspect)
                .min(5.0),
        );
        profile.uses = profile.uses.saturating_add(1);
        profile.updated_at = chrono::Utc::now().to_rfc3339();
    }

    FilterOutcome {
        pages,
        blocked,
        profile,
        input_count,
        kept_ratio,
    }
}

fn threshold_aspect_max(configured: f32, observed: f32) -> f32 {
    if observed.is_finite() {
        configured.max(observed)
    } else {
        configured
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digit_runs_are_normalized_for_templates() {
        assert_eq!(
            normalize_digit_runs("/ch01/001.jpg"),
            "/ch#/#.jpg"
        );
        assert_eq!(
            url_template("https://cdn.example/ch01/001.jpg?token=secret#f").as_deref(),
            Some("https://cdn.example/ch#/#.jpg")
        );
    }

    #[test]
    fn median_handles_even_and_odd_inputs() {
        assert_eq!(median_width(&[1200, 900, 1600]), Some(1200));
        assert_eq!(median_width(&[800, 1200]), Some(1000));
        assert_eq!(median_width(&[]), None);
    }

    fn candidate(
        url: &str,
        width: u32,
        height: u32,
        order: usize,
    ) -> CandidateImage {
        let mut candidate = CandidateImage::new(url, order);
        candidate.width = Some(width);
        candidate.height = Some(height);
        candidate.source = CandidateSource::Json;
        candidate
    }

    fn no_probe(_: &CandidateImage) -> Option<ProbeInfo> {
        None
    }

    fn run(candidates: Vec<CandidateImage>, memory: &FilterMemory) -> FilterOutcome {
        let mut probe = no_probe;
        filter_candidates(
            candidates,
            memory,
            &FilterThresholds::default(),
            &mut probe,
        )
    }

    #[test]
    fn keeps_thirty_pages_and_drops_site_chrome() {
        let mut candidates: Vec<CandidateImage> = (0..30)
            .map(|i| {
                candidate(
                    &format!("https://site.example/pages/{:03}.jpg", i + 1),
                    800,
                    1200,
                    i,
                )
            })
            .collect();
        let mut logo = candidate("https://site.example/logo.png", 128, 128, 30);
        logo.in_chrome = true;
        candidates.push(logo);
        candidates.push(candidate("https://site.example/ad_banner.png", 728, 90, 31));
        candidates.push(candidate("https://site.example/qrcode.png", 300, 300, 32));
        candidates.push(candidate("https://other.example/portrait.png", 800, 1200, 33));
        let outcome = run(candidates, &FilterMemory::default());
        assert_eq!(outcome.pages.len(), 30);
        assert_eq!(outcome.blocked.len(), 4);
        assert!(outcome
            .blocked
            .iter()
            .any(|p| p.reason.contains("chrome") || p.reason.contains("keyword")));
    }

    #[test]
    fn isolated_full_size_promo_is_kept_until_user_marks_it() {
        let mut candidates: Vec<CandidateImage> = (0..3)
            .map(|i| {
                candidate(
                    &format!("https://site.example/pages/{:03}.jpg", i + 1),
                    800,
                    1200,
                    i,
                )
            })
            .collect();
        candidates.push(candidate(
            "https://site.example/extras/credits-final-01.png",
            800,
            1200,
            3,
        ));
        let outcome = run(candidates, &FilterMemory::default());
        assert_eq!(outcome.pages.len(), 4);
        assert!(outcome.blocked.is_empty());
    }

    #[test]
    fn user_url_template_rule_blocks_new_chapter_but_not_content() {
        let rule = FilterRule {
            id: "r1".into(),
            host: "site.example".into(),
            action: FilterAction::Block,
            source: RuleSource::User,
            pattern: RulePattern::UrlTemplate {
                template: "https://site.example/extras/credits-final-#.png".into(),
            },
            reason: "user".into(),
            created_at: "t".into(),
            hits: 0,
        };
        let memory = FilterMemory {
            host: "site.example".into(),
            profile: None,
            rules: vec![rule.clone()],
        };
        let candidates = vec![
            candidate("https://site.example/pages/001.jpg", 800, 1200, 0),
            candidate(
                "https://site.example/extras/credits-final-02.png",
                800,
                1200,
                1,
            ),
        ];
        let outcome = run(candidates, &memory);
        assert_eq!(outcome.pages.len(), 1);
        assert_eq!(outcome.blocked.len(), 1);
        assert_eq!(outcome.blocked[0].reason, "rule");

        let allow = FilterRule {
            id: "r2".into(),
            host: "site.example".into(),
            action: FilterAction::Allow,
            source: RuleSource::User,
            pattern: RulePattern::UrlTemplate {
                template: "https://site.example/extras/credits-final-#.png".into(),
            },
            reason: "restored".into(),
            created_at: "t".into(),
            hits: 0,
        };
        let memory = FilterMemory {
            host: "site.example".into(),
            profile: None,
            rules: vec![allow],
        };
        let candidates = vec![candidate(
            "https://site.example/extras/credits-final-02.png",
            800,
            1200,
            0,
        )];
        let outcome = run(candidates, &memory);
        assert_eq!(outcome.pages.len(), 1);
        assert!(outcome.blocked.is_empty());
    }

    #[test]
    fn spread_is_kept_but_ultra_wide_banner_is_dropped() {
        let candidates = vec![
            candidate("https://site.example/1.jpg", 800, 1200, 0),
            candidate("https://site.example/spread.jpg", 1600, 1200, 1),
            candidate("https://site.example/2.jpg", 800, 1200, 2),
            candidate("https://site.example/wide.jpg", 2400, 700, 3),
        ];
        let outcome = run(candidates, &FilterMemory::default());
        assert_eq!(outcome.pages.len(), 3);
        assert_eq!(outcome.blocked.len(), 1);
        assert!(outcome.blocked[0].reason.contains("banner"));
    }

    #[test]
    fn probe_budget_is_bounded() {
        let mut calls = 0usize;
        let mut probe = |_c: &CandidateImage| {
            calls += 1;
            Some(ProbeInfo {
                width: 800,
                height: 1200,
                sha256: None,
            })
        };
        let candidates: Vec<CandidateImage> = (0..40)
            .map(|i| CandidateImage::new(format!("https://site.example/{i}.jpg"), i))
            .collect();
        let outcome = filter_candidates(
            candidates,
            &FilterMemory::default(),
            &FilterThresholds::default(),
            &mut probe,
        );
        assert!(calls <= MAX_PROBE_IMAGES);
        assert_eq!(outcome.pages.len(), 40);
    }

    #[test]
    fn learned_profile_penalizes_outlier_width() {
        let profile = SiteProfile {
            host: "site.example".into(),
            main_selector: Some(".reader".into()),
            cdn_pattern: Some("https://site.example/pages/#.jpg".into()),
            width_min: Some(760),
            width_max: Some(840),
            aspect_max: Some(2.8),
            uses: 1,
            updated_at: "t".into(),
        };
        let memory = FilterMemory {
            host: "site.example".into(),
            profile: Some(profile),
            rules: Vec::new(),
        };
        let mut candidates: Vec<CandidateImage> = (0..5)
            .map(|i| {
                candidate(
                    &format!("https://site.example/pages/{:03}.jpg", i + 1),
                    800,
                    1200,
                    i,
                )
            })
            .collect();
        candidates.push(candidate(
            "https://site.example/pages/099.jpg",
            400,
            1200,
            5,
        ));
        let outcome = run(candidates, &memory);
        assert_eq!(outcome.pages.len(), 5);
        assert_eq!(outcome.blocked.len(), 1);
        assert!(outcome.blocked[0].reason.contains("profile")
            || outcome.blocked[0].reason.contains("median"));
    }

    #[test]
    fn size_and_url_rules_match() {
        let mut candidate = CandidateImage::new("https://x/ch01/001.jpg", 0);
        candidate.width = Some(728);
        candidate.height = Some(90);
        candidate.class_id = Some("promo-footer".into());
        let size = FilterRule {
            id: "r".into(),
            host: "x".into(),
            action: FilterAction::Block,
            source: RuleSource::User,
            pattern: RulePattern::Size {
                width: 728,
                height: 90,
            },
            reason: "user".into(),
            created_at: "t".into(),
            hits: 0,
        };
        assert!(rule_matches(&size, &candidate, None));
        let url = FilterRule {
            pattern: RulePattern::UrlTemplate {
                template: "https://x/ch#/#.jpg".into(),
            },
            ..size.clone()
        };
        assert!(rule_matches(&url, &candidate, None));
        let dom = FilterRule {
            pattern: RulePattern::DomClass {
                value: "promo".into(),
            },
            ..size
        };
        assert!(rule_matches(&dom, &candidate, None));
    }
}
