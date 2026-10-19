//! 阶段三翻译:OpenAI 兼容 /chat/completions。
//! build_request / parse_response 纯函数可单测;translate 负责真实 HTTP。

use crate::Settings;

pub struct TransReq {
    pub url: String,
    pub body: serde_json::Value,
    pub bearer: Option<String>,
}

/// 组装 OpenAI 兼容请求:endpoint 拼接 /chat/completions,key 非空才带 Bearer。
/// system 由调用方给(工作台注入术语表;直连翻译用默认提示)。
pub fn build_request(s: &Settings, system: &str, text: &str) -> Result<TransReq, String> {
    let endpoint = s.trans_endpoint.trim();
    if endpoint.is_empty() {
        return Err("请在设置中填写翻译 Endpoint".into());
    }
    let model = s.trans_model.trim();
    if model.is_empty() {
        return Err("请在设置中填写翻译 Model".into());
    }
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "temperature": s.trans_temp,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": text }
        ]
    });
    let key = s.trans_api_key.trim();
    let bearer = (!key.is_empty()).then(|| key.to_string());
    Ok(TransReq { url, body, bearer })
}

/// 解析 choices[0].message.content。
pub fn parse_response(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("翻译响应不是 JSON:{e}"))?;
    v["choices"][0]["message"]["content"].as_str().map(str::to_string).ok_or_else(|| {
        let head: String = body.chars().take(200).collect();
        format!("翻译响应缺少 choices[0].message.content:{head}")
    })
}

/// 默认提示词直连翻译:返回 (译文, 模型, 耗时 ms)。
pub async fn translate(
    client: &reqwest::Client,
    s: &Settings,
    text: &str,
) -> Result<(String, String, u64), String> {
    let system = format!(
        "你是漫画翻译引擎。把用户文本从 {} 翻译成 {},只输出译文,不要解释,不要引号。",
        s.src_lang.trim(),
        s.dst_lang.trim()
    );
    translate_with_system(client, s, &system, text).await
}

/// 自定义 system prompt 翻译(工作台注入术语表):返回 (译文, 模型, 耗时 ms)。
pub async fn translate_with_system(
    client: &reqwest::Client,
    s: &Settings,
    system: &str,
    text: &str,
) -> Result<(String, String, u64), String> {
    let t0 = std::time::Instant::now();
    let req = build_request(s, system, text)?;
    let mut r = client
        .post(&req.url)
        .timeout(std::time::Duration::from_secs(s.trans_timeout_s.max(1)))
        .json(&req.body);
    if let Some(k) = &req.bearer {
        r = r.bearer_auth(k);
    }
    let resp = r.send().await.map_err(|e| format!("翻译请求失败:{e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let head: String = body.chars().take(200).collect();
        return Err(format!("翻译服务返回 {status}:{head}"));
    }
    let translated = parse_response(&body)?;
    Ok((translated, s.trans_model.clone(), t0.elapsed().as_millis() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            trans_endpoint: "http://localhost:8080/v1/".into(),
            trans_api_key: "sk-test".into(),
            trans_model: "qwen2.5:7b".into(),
            trans_temp: 0.2,
            trans_timeout_s: 15,
            src_lang: "ja".into(),
            dst_lang: "zh".into(),
            ..Settings::default()
        }
    }

    #[test]
    fn build_request_shapes_openai_body() {
        let r = build_request(&settings(), "系统提示词", "こんにちは").unwrap();
        assert_eq!(r.url, "http://localhost:8080/v1/chat/completions");
        assert_eq!(r.bearer.as_deref(), Some("sk-test"));
        assert_eq!(r.body["model"], "qwen2.5:7b");
        // Settings.trans_temp 是 f32,JSON 里按 f64 表示(f32 精度)。
        assert_eq!(r.body["temperature"], serde_json::Value::from(0.2_f32));
        assert_eq!(r.body["messages"][0]["role"], "system");
        assert_eq!(r.body["messages"][0]["content"], "系统提示词");
        assert_eq!(r.body["messages"][1]["content"], "こんにちは");
    }

    #[test]
    fn build_request_requires_endpoint_and_model() {
        let mut s = settings();
        s.trans_endpoint = " ".into();
        assert!(build_request(&s, "sys", "x").is_err());
        let mut s = settings();
        s.trans_model = "".into();
        assert!(build_request(&s, "sys", "x").is_err());
    }

    #[test]
    fn build_request_no_bearer_when_key_empty() {
        let mut s = settings();
        s.trans_api_key = "  ".into();
        let r = build_request(&s, "sys", "x").unwrap();
        assert!(r.bearer.is_none());
    }

    #[test]
    fn parse_response_reads_choices0() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好"}}]}"#;
        assert_eq!(parse_response(body).unwrap(), "你好");
        assert!(parse_response(r#"{"choices":[]}"#).is_err());
        assert!(parse_response("not json").is_err());
    }
}
