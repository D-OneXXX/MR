//! 阶段三:翻译工作台后端。
//! 检测/OCR/擦除经 sidecar(docs/sidecar-api.md),翻译走 OpenAI 兼容服务
//! (SQLite 按 书+页+原文+目标语言 缓存,术语表按系列注入 prompt)。

use std::sync::Arc;
use std::time::Instant;

use base64::Engine as _;
use image::GenericImageView;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::commands::{blocking, err};
use crate::db;
use crate::ocr;
use crate::sidecar::{self, DetectBox, OcrText};
use crate::state::AppState;
use crate::translate;

/// 翻译缓存键:sha256(book_id | index | 规范化原文 | 目标语言)。
pub fn cache_key(book_id: &str, index: u32, text: &str, dst_lang: &str) -> String {
    let mut h = Sha256::new();
    h.update(book_id.as_bytes());
    h.update([0u8]);
    h.update(index.to_le_bytes());
    h.update([0u8]);
    h.update(text.trim().as_bytes());
    h.update([0u8]);
    h.update(dst_lang.trim().as_bytes());
    hex::encode(h.finalize())
}

/// 工作台翻译 system prompt:默认规则 + 术语表(按系列)注入。
pub fn build_trans_system_prompt(src: &str, dst: &str, glossary: &[(String, String)]) -> String {
    let mut p = format!(
        "你是漫画翻译引擎。把用户文本从 {src} 翻译成 {dst},只输出译文,不要解释,不要引号。"
    );
    if !glossary.is_empty() {
        p.push_str("\n术语表(必须严格遵守):\n");
        for (s, d) in glossary {
            p.push_str(&format!("{s}={d}\n"));
        }
    }
    p
}

pub(crate) struct PagePng {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 按 bookId 读取原始分辨率整页 PNG（本地/在线共用；展示缩放是前端的责任）。
pub(crate) fn load_page_png_for_book(
    st: &Arc<AppState>,
    book_id: &str,
    index: u32,
) -> Result<PagePng, crate::source::BackendError> {
    let handle = st.source_handle_for_book(book_id)?;
    let count = handle.page_count()?;
    if index >= count as u32 {
        return Err(crate::source::BackendError::Msg(format!(
            "页码 {index} 超出范围(共 {count} 页)"
        )));
    }
    let raw = handle.read_raw(index as usize)?;
    let img = image::load_from_memory(&raw.bytes)?;
    let (width, height) = (img.width(), img.height());
    let png = ocr::encode_png(&img)?;
    Ok(PagePng { png, width, height })
}

/// sidecar 连接参数；bookId 仅用于校验书籍存在。
fn wb_ctx(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
) -> Result<(String, u64), String> {
    let s = state.settings.lock().clone();
    state
        .db
        .with(|conn| db::get_book(conn, book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    Ok((s.sidecar_endpoint, s.sidecar_timeout_s))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbDetectResult {
    pub width: u32,
    pub height: u32,
    pub boxes: Vec<DetectBox>,
    pub elapsed_ms: u64,
}

/// 步骤一(前半):整页文本检测,返回原图尺寸 + 绝对像素框。
#[tauri::command]
pub async fn wb_detect(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
) -> Result<WbDetectResult, String> {
    let t0 = Instant::now();
    let (endpoint, timeout) = wb_ctx(&state, &book_id)?;
    let st = state.inner().clone();
    let bid = book_id.clone();
    let page = blocking(move || load_page_png_for_book(&st, &bid, index)).await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&page.png);
    let client = state.http.clone();
    let boxes = sidecar::detect(&client, endpoint.trim(), &b64, timeout).await?;
    Ok(WbDetectResult {
        width: page.width,
        height: page.height,
        boxes,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbOcrResult {
    pub results: Vec<OcrText>,
    pub elapsed_ms: u64,
}

/// 步骤一(后半):对(人工删改后的)框逐个 OCR,results 与传入 boxes 同序。
#[tauri::command]
pub async fn wb_ocr(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    boxes: Vec<DetectBox>,
) -> Result<WbOcrResult, String> {
    let t0 = Instant::now();
    let (endpoint, timeout) = wb_ctx(&state, &book_id)?;
    let st = state.inner().clone();
    let bid = book_id.clone();
    let page = blocking(move || load_page_png_for_book(&st, &bid, index)).await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&page.png);
    let client = state.http.clone();
    let results = sidecar::ocr_boxes(&client, endpoint.trim(), &b64, &boxes, timeout).await?;
    Ok(WbOcrResult {
        results,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbImageResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: u64,
}

/// 步骤二(擦除):把保留框的区域从原图上擦掉,返回整页结果图。
#[tauri::command]
pub async fn wb_inpaint(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    boxes: Vec<DetectBox>,
) -> Result<WbImageResult, String> {
    let t0 = Instant::now();
    let (endpoint, timeout) = wb_ctx(&state, &book_id)?;
    let st = state.inner().clone();
    let bid = book_id.clone();
    let page = blocking(move || load_page_png_for_book(&st, &bid, index)).await?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&page.png);
    let client = state.http.clone();
    let bytes = sidecar::inpaint(&client, endpoint.trim(), &b64, &boxes, timeout).await?;
    // 闭包需要 'static:一次 move 进去,同时取回尺寸与原字节。
    let (dims, bytes) = blocking(move || {
        let img = image::load_from_memory(&bytes)?;
        Ok::<_, crate::source::BackendError>((img.dimensions(), bytes))
    })
    .await?;
    Ok(WbImageResult {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        width: dims.0,
        height: dims.1,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbTransItem {
    pub text: String,
    pub translated: String,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbTranslateResult {
    pub items: Vec<WbTransItem>,
    pub elapsed_ms: u64,
}

/// 批量翻译核心(工作台命令与后台队列共用):
/// 去重保序 → 术语表注入 → 逐条缓存查找 → 未命中调 LLM 并回写。
/// 返回与输入 texts 同序的 (译文, 是否缓存命中)。
pub(crate) async fn translate_texts_cached(
    st: &AppState,
    book_id: &str,
    index: u32,
    texts: &[String],
) -> Result<Vec<(String, bool)>, String> {
    let t0 = Instant::now();
    // 去重保序;空串原样回空。
    let mut uniq: Vec<String> = Vec::new();
    for t in texts {
        let t = t.trim().to_string();
        if !t.is_empty() && !uniq.contains(&t) {
            uniq.push(t);
        }
    }
    if uniq.is_empty() {
        return Ok(texts.iter().map(|_| (String::new(), false)).collect());
    }
    let s = st.settings.lock().clone();
    let glossary = st.db.with(|conn| db::glossary_list(conn, book_id).map_err(err))?;
    let keys: Vec<String> = uniq
        .iter()
        .map(|t| cache_key(book_id, index, t, &s.dst_lang))
        .collect();
    // 读缓存(命中记录先留档,用于 cached 标记)。
    let mut hits: Vec<Option<String>> = {
        let keys = keys.clone();
        st.db.with(move |conn| {
            let mut out = Vec::new();
            for k in &keys {
                out.push(db::cache_get(conn, k).map_err(err)?);
            }
            Ok::<_, String>(out)
        })?
    };
    let was_cached: Vec<bool> = hits.iter().map(|h| h.is_some()).collect();
    // 未命中的逐条翻译(保序),成功后写缓存。
    let system = build_trans_system_prompt(s.src_lang.trim(), s.dst_lang.trim(), &glossary);
    for (i, text) in uniq.iter().enumerate() {
        if hits[i].is_some() {
            continue;
        }
        let (translated, _, _) =
            translate::translate_with_system(&st.http, &s, &system, text).await?;
        let k = keys[i].clone();
        let put = translated.clone();
        let bid = book_id.to_string();
        let _ = st
            .db
            .with(move |conn| db::cache_put(conn, &k, &put, &bid).map_err(err));
        hits[i] = Some(translated);
    }
    let _ = st.db.with(|conn| {
        db::log_trans(conn, "trans", true, t0.elapsed().as_millis() as u64).map_err(err)
    });
    // 按输入顺序展开(重复文本共享译文)。
    let lookup: std::collections::HashMap<&str, (String, bool)> = uniq
        .iter()
        .enumerate()
        .map(|(i, t)| {
            (
                t.as_str(),
                (hits[i].clone().unwrap_or_default(), was_cached[i]),
            )
        })
        .collect();
    Ok(texts
        .iter()
        .map(|t| match lookup.get(t.trim()) {
            Some((translated, cached)) => (translated.clone(), *cached),
            None => (String::new(), false),
        })
        .collect())
}

/// 步骤二(翻译):批量翻译,命中缓存秒出;术语表注入;结果与输入 texts 同序。
#[tauri::command]
pub async fn wb_translate(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    texts: Vec<String>,
) -> Result<WbTranslateResult, String> {
    let t0 = Instant::now();
    if texts.iter().all(|t| t.trim().is_empty()) {
        return Err("没有可翻译的文本".into());
    }
    let pairs = translate_texts_cached(&state, &book_id, index, &texts).await?;
    let items = texts
        .into_iter()
        .zip(pairs)
        .map(|(text, (translated, cached))| WbTransItem {
            text,
            translated,
            cached,
        })
        .collect();
    Ok(WbTranslateResult {
        items,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

// ---------- 页 OCR 存档(翻过的页秒出;工作台与批量队列共用) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WbStoredOcr {
    pub width: u32,
    pub height: u32,
    pub boxes: Vec<DetectBox>,
    pub texts: Vec<String>,
}

/// 存一页的检测框与 OCR 文本(步骤一成功后由前端调用;批量队列由 worker 直接写库)。
#[tauri::command]
pub async fn wb_save_ocr(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    width: u32,
    height: u32,
    boxes: Vec<DetectBox>,
    texts: Vec<String>,
) -> Result<(), String> {
    let boxes_json = serde_json::to_string(&boxes).map_err(err)?;
    let texts_json = serde_json::to_string(&texts).map_err(err)?;
    let (bw, bh) = (width, height);
    state.db.with(move |conn| {
        db::save_page_ocr(conn, &book_id, index, bw, bh, &boxes_json, &texts_json)
            .map_err(err)
    })
}

/// 读一页已存档的 OCR(存在则工作台跳过检测/OCR 模型,秒出)。
#[tauri::command]
pub async fn wb_get_ocr(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
) -> Result<Option<WbStoredOcr>, String> {
    let row = state
        .db
        .with(|conn| db::get_page_ocr(conn, &book_id, index).map_err(err))?;
    Ok(row.and_then(|row| {
        Some(WbStoredOcr {
            width: row.width,
            height: row.height,
            boxes: serde_json::from_str(&row.boxes).ok()?,
            texts: serde_json::from_str(&row.texts).ok()?,
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_deterministic_and_sensitive() {
        let a = cache_key("book1", 3, "テスト", "zh");
        let b = cache_key("book1", 3, "テスト", "zh");
        assert_eq!(a, b);
        assert_ne!(cache_key("book1", 3, "テスト", "zh"), cache_key("book2", 3, "テスト", "zh"));
        assert_ne!(cache_key("book1", 3, "テスト", "zh"), cache_key("book1", 4, "テスト", "zh"));
        assert_ne!(cache_key("book1", 3, "テスト", "zh"), cache_key("book1", 3, "違う", "zh"));
        assert_ne!(cache_key("book1", 3, "テスト", "zh"), cache_key("book1", 3, "テスト", "en"));
        // 前后空白规范化后命中同一缓存。
        assert_eq!(cache_key("b", 0, " x ", "zh"), cache_key("b", 0, "x", "zh"));
    }

    #[test]
    fn system_prompt_includes_rules_and_glossary() {
        let plain = build_trans_system_prompt("ja", "zh", &[]);
        assert!(plain.contains("ja") && plain.contains("zh"));
        let g = build_trans_system_prompt(
            "ja",
            "zh",
            &[("ナルト".into(), "鸣人".into()), ("サスケ".into(), "佐助".into())],
        );
        assert!(g.contains("ナルト=鸣人"));
        assert!(g.contains("サスケ=佐助"));
    }
}
