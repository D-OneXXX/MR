//! 阶段三:sidecar 客户端(ctd / mit48px / lama 的本地 HTTP 服务)。
//! 契约见 docs/sidecar-api.md;坐标为所提交图像的绝对像素。

use base64::Engine as _;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectBox {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub vertical: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrText {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarHealth {
    pub ok: bool,
    pub device: String,
    pub models: std::collections::HashMap<String, String>,
}

fn extract_error(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
}

async fn post_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    json: &serde_json::Value,
    timeout_s: u64,
) -> Result<T, String> {
    let resp = client
        .post(url)
        .timeout(std::time::Duration::from_secs(timeout_s.max(1)))
        .json(json)
        .send()
        .await
        .map_err(|e| format!("sidecar 请求失败({url}):{e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = extract_error(&body)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }
    serde_json::from_str(&body).map_err(|e| format!("sidecar 响应形状不符:{e}"))
}

pub async fn health(
    client: &reqwest::Client,
    endpoint: &str,
    timeout_s: u64,
) -> Result<SidecarHealth, String> {
    let url = format!("{}/health", endpoint.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(timeout_s.max(1).min(10)))
        .send()
        .await
        .map_err(|e| format!("sidecar 不可达({url}):{e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(extract_error(&body).unwrap_or_else(|| format!("HTTP {status}")));
    }
    serde_json::from_str(&body).map_err(|e| format!("sidecar /health 响应形状不符:{e}"))
}

pub async fn detect(
    client: &reqwest::Client,
    endpoint: &str,
    image_png_b64: &str,
    timeout_s: u64,
) -> Result<Vec<DetectBox>, String> {
    let url = format!("{}/v1/detect", endpoint.trim_end_matches('/'));
    let out: serde_json::Value =
        post_json(client, &url, &serde_json::json!({ "image": image_png_b64 }), timeout_s).await?;
    let boxes = serde_json::from_value(out["boxes"].clone())
        .map_err(|e| format!("sidecar /v1/detect boxes 形状不符:{e}"))?;
    Ok(boxes)
}

pub async fn ocr_boxes(
    client: &reqwest::Client,
    endpoint: &str,
    image_png_b64: &str,
    boxes: &[DetectBox],
    timeout_s: u64,
) -> Result<Vec<OcrText>, String> {
    let url = format!("{}/v1/ocr", endpoint.trim_end_matches('/'));
    let out: serde_json::Value = post_json(
        client,
        &url,
        &serde_json::json!({ "image": image_png_b64, "boxes": boxes }),
        timeout_s,
    )
    .await?;
    let results = serde_json::from_value(out["results"].clone())
        .map_err(|e| format!("sidecar /v1/ocr results 形状不符:{e}"))?;
    Ok(results)
}

pub async fn inpaint(
    client: &reqwest::Client,
    endpoint: &str,
    image_png_b64: &str,
    boxes: &[DetectBox],
    timeout_s: u64,
) -> Result<Vec<u8>, String> {
    let url = format!("{}/v1/inpaint", endpoint.trim_end_matches('/'));
    let out: serde_json::Value = post_json(
        client,
        &url,
        &serde_json::json!({ "image": image_png_b64, "boxes": boxes }),
        timeout_s,
    )
    .await?;
    let b64 = out["image"]
        .as_str()
        .ok_or_else(|| "sidecar /v1/inpaint 缺少 image 字段".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("sidecar /v1/inpaint 图像解码失败:{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_parses_contract_shape() {
        let body = r#"{"ok":true,"device":"cpu","models":{"detector":"ready","ocr":"not_loaded","inpaint":"missing"}}"#;
        let h: SidecarHealth = serde_json::from_str(body).unwrap();
        assert!(h.ok);
        assert_eq!(h.device, "cpu");
        assert_eq!(h.models["inpaint"], "missing");
    }

    #[test]
    fn error_body_extracts_chinese_message() {
        assert_eq!(
            extract_error(r#"{"error":"模型缺失:D:\\x.pt"}"#).as_deref(),
            Some("模型缺失:D:\\x.pt")
        );
        assert!(extract_error("not json").is_none());
    }

    #[test]
    fn detect_boxes_defaults_score() {
        let boxes: Vec<DetectBox> =
            serde_json::from_str(r#"[{"x":1,"y":2,"w":30,"h":40}]"#).unwrap();
        assert_eq!(boxes[0].score, 0.0);
        assert_eq!((boxes[0].x, boxes[0].w), (1, 30));
    }
}
