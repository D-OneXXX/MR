# 阶段三:框选 OCR + 翻译 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阅读器内框选任意区域 → 本地 Windows OCR 或 HTTP OCR → OpenAI 兼容 LLM 翻译,浮层展示可复制,调用统计入库。

**Architecture:** 后端新增 `ocr.rs`(裁剪 + WinRT/HTTP OCR)与 `translate.rs`(OpenAI 兼容请求),SQLite 加 `trans_log` 表;三个新 Tauri 命令 `ocr_region / translate_region / get_trans_stats` 注册进 `generate_handler`;前端阅读器加选区模式(复用现有 pointer 体系),设置页翻译区转正式并显示统计。

**Tech Stack:** Tauri 2 + Rust(`windows` 0.62 WinRT / `image` / `reqwest` rustls / `rusqlite`)+ React 19 + TypeScript。

**注意:** 本项目当前**不是 git 仓库**,所有"Commit"步骤替换为"运行测试确认通过"检查点。Windows 上运行;cargo 在 `src-tauri/` 下执行。

---

### Task 1: Cargo 依赖(windows crate,仅 Windows target)

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 在 `[dependencies]` 之后追加 target 段**

```toml
# 阶段三:本地 OCR 走 WinRT Windows.Media.Ocr(仅 Windows)。
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = [
    "Foundation",
    "Globalization",
    "Graphics_Imaging",
    "Media_Ocr",
    "Storage_Streams",
    "Win32_System_Com",
] }
```

- [ ] **Step 2: 验证依赖可解析**

Run: `cd src-tauri && cargo check`
Expected: 编译通过(或仅既有警告),无依赖解析错误。

---

### Task 2: db.rs — trans_log 表 + log_trans + trans_stats(TDD)

**Files:**
- Modify: `src-tauri/src/db.rs`
- Test: `src-tauri/src/db.rs` 文件末尾新增 `#[cfg(test)] mod tests`(该文件目前没有测试模块)

- [ ] **Step 1: 写失败测试**

在 `db.rs` 末尾追加(db.rs 已 `use crate::source::BackendError`,测试内另需 `crate::TransLogEntry` 断言):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn trans_log_roundtrip_and_stats() {
        let conn = mem();
        log_trans(&conn, "ocr", true, 120).unwrap();
        log_trans(&conn, "ocr", false, 80).unwrap();
        log_trans(&conn, "trans", true, 900).unwrap();

        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 2);
        assert_eq!(s.ocr_fail, 1);
        assert_eq!(s.ocr_avg_ms, 100.0);
        assert_eq!(s.trans_calls, 1);
        assert_eq!(s.trans_fail, 0);
        assert_eq!(s.trans_avg_ms, 900.0);

        // recent 按 id 倒序,最近一条在前。
        assert_eq!(s.recent.len(), 3);
        assert_eq!(s.recent[0].kind, "trans");
        assert!(s.recent[0].ok);
        assert_eq!(s.recent[0].elapsed_ms, 900);
        assert!(!s.recent[1].ok);
        assert_eq!(s.recent[2].kind, "ocr");
        assert!(!s.recent[2].created_at.is_empty());
    }

    #[test]
    fn trans_stats_empty_and_limit() {
        let conn = mem();
        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 0);
        assert_eq!(s.ocr_avg_ms, 0.0);
        assert!(s.recent.is_empty());

        for i in 0..60 {
            log_trans(&conn, "ocr", true, i as u64).unwrap();
        }
        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 60);
        assert_eq!(s.recent.len(), 50, "recent 只保留最近 50 条");
        assert_eq!(s.recent[0].elapsed_ms, 59);
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test db::tests`
Expected: 编译失败,`log_trans` / `trans_stats` 未定义。

- [ ] **Step 3: 实现**

3a. `init_schema` 的 `execute_batch` 字符串里追加:

```sql
        CREATE TABLE IF NOT EXISTS trans_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            ok INTEGER NOT NULL DEFAULT 1,
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT ''
        );
```

3b. `db.rs` 顶部 `use` 区加:

```rust
use crate::{TransLogEntry, TransStats};
```

3c. 文件末尾(`mod tests` 之前)加实现:

```rust
/// 记一条 OCR/翻译调用日志(kind: "ocr" | "trans")。
pub fn log_trans(conn: &Connection, kind: &str, ok: bool, elapsed_ms: u64) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO trans_log(kind, ok, elapsed_ms, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![kind, ok as i64, elapsed_ms as i64, now_str()],
    )?;
    Ok(())
}

/// 聚合 OCR/翻译调用统计 + 最近 50 条(id 倒序)。
pub fn trans_stats(conn: &Connection) -> Result<TransStats, BackendError> {
    let agg = |kind: &str| -> Result<(u64, u64, f64), BackendError> {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(ok = 0), 0), COALESCE(AVG(elapsed_ms), 0.0)
             FROM trans_log WHERE kind = ?1",
            params![kind],
            |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(From::from)
    };
    let (ocr_calls, ocr_fail, ocr_avg_ms) = agg("ocr")?;
    let (trans_calls, trans_fail, trans_avg_ms) = agg("trans")?;
    let mut stmt = conn.prepare(
        "SELECT kind, ok, elapsed_ms, created_at FROM trans_log ORDER BY id DESC LIMIT 50",
    )?;
    let recent = stmt
        .query_map([], |r| {
            Ok(TransLogEntry {
                kind: r.get(0)?,
                ok: r.get::<_, i64>(1)? != 0,
                elapsed_ms: r.get::<_, i64>(2)? as u64,
                created_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(TransStats {
        ocr_calls,
        ocr_fail,
        ocr_avg_ms,
        trans_calls,
        trans_fail,
        trans_avg_ms,
        recent,
    })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test db::tests`
Expected: `test result: ok`,2 个测试全过。

---

### Task 3: state.rs 加 HTTP 客户端 + translate.rs(TDD)

**Files:**
- Modify: `src-tauri/src/state.rs`
- Create: `src-tauri/src/translate.rs`
- Modify: `src-tauri/src/lib.rs`(注册模块)

- [ ] **Step 1: 写失败测试(translate.rs 测试先行,文件先建测试骨架)**

创建 `src-tauri/src/translate.rs`,先只放类型与测试:

```rust
//! 阶段三翻译:OpenAI 兼容 /chat/completions。
//! build_request / parse_response 纯函数可单测;translate 负责真实 HTTP。

use crate::Settings;

pub struct TransReq {
    pub url: String,
    pub body: serde_json::Value,
    pub bearer: Option<String>,
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
        let r = build_request(&settings(), "こんにちは").unwrap();
        assert_eq!(r.url, "http://localhost:8080/v1/chat/completions");
        assert_eq!(r.bearer.as_deref(), Some("sk-test"));
        assert_eq!(r.body["model"], "qwen2.5:7b");
        assert_eq!(r.body["temperature"], 0.2);
        assert_eq!(r.body["messages"][0]["role"], "system");
        let sys = r.body["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("ja") && sys.contains("zh"));
        assert_eq!(r.body["messages"][1]["content"], "こんにちは");
    }

    #[test]
    fn build_request_requires_endpoint_and_model() {
        let mut s = settings();
        s.trans_endpoint = " ".into();
        assert!(build_request(&s, "x").is_err());
        let mut s = settings();
        s.trans_model = "".into();
        assert!(build_request(&s, "x").is_err());
    }

    #[test]
    fn build_request_no_bearer_when_key_empty() {
        let mut s = settings();
        s.trans_api_key = "  ".into();
        let r = build_request(&s, "x").unwrap();
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test translate::tests`
Expected: 编译失败(`build_request`/`parse_response` 未定义;模块也尚未在 lib.rs 声明,先在 lib.rs 加 `mod translate;` 再跑)。

- [ ] **Step 3: 实现并注册模块**

3a. `lib.rs` 模块声明区加 `mod translate;`(与 `mod commands;` 同风格,放在 `mod state;` 之后)。

3b. `translate.rs` 在测试之前补实现:

```rust
/// 组装 OpenAI 兼容请求:endpoint 拼接 /chat/completions,key 非空才带 Bearer。
pub fn build_request(s: &Settings, text: &str) -> Result<TransReq, String> {
    let endpoint = s.trans_endpoint.trim();
    if endpoint.is_empty() {
        return Err("请在设置中填写翻译 Endpoint".into());
    }
    let model = s.trans_model.trim();
    if model.is_empty() {
        return Err("请在设置中填写翻译 Model".into());
    }
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let system = format!(
        "你是漫画翻译引擎。把用户文本从 {} 翻译成 {},只输出译文,不要解释,不要引号。",
        s.src_lang.trim(),
        s.dst_lang.trim()
    );
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
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "翻译响应缺少 choices[0].message.content".into())
}

/// 真实请求:返回 (译文, 模型, 耗时 ms)。
pub async fn translate(
    client: &reqwest::Client,
    s: &Settings,
    text: &str,
) -> Result<(String, String, u64), String> {
    let t0 = std::time::Instant::now();
    let req = build_request(s, text)?;
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
```

3c. `state.rs`:`AppState` 结构体加字段 `pub http: reqwest::Client`,`AppState::new()` 里加 `http: reqwest::Client::new(),`。

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test translate::tests`
Expected: 4 个测试全过。

---

### Task 4: ocr.rs — 裁剪/PNG/HTTP OCR(TDD)+ 本地 WinRT OCR

**Files:**
- Create: `src-tauri/src/ocr.rs`
- Modify: `src-tauri/src/lib.rs`(注册模块)

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/ocr.rs`:

```rust
//! 阶段三 OCR:相对坐标裁剪 + 编码 PNG(纯函数,可单测);
//! 本地 WinRT Windows.Media.Ocr 或 HTTP OCR 二选一,由 ocrEndpoint 是否为空决定。

use crate::source::{BackendError, RawPage};
use crate::RegionRect;
use base64::Engine as _;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, GenericImageView, ImageEncoder};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RegionRect;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> RegionRect {
        RegionRect { x, y, w, h }
    }

    /// 2x3 渐变 PNG(不透明红)。
    fn tiny_png() -> Vec<u8> {
        let img = image::DynamicImage::new_rgba8(2, 3);
        encode_png(&img).unwrap()
    }

    #[test]
    fn crop_clamps_and_encodes() {
        let raw = RawPage { bytes: tiny_png(), ext: "png".into() };
        // 越界钳制:仍产出 2x3 全图。
        let img = crop_dyn(&raw, &rect(-0.5, -0.5, 2.0, 2.0)).unwrap();
        assert_eq!(img.dimensions(), (2, 3));
        // 半图。
        let img = crop_dyn(&raw, &rect(0.0, 0.0, 0.5, 0.5)).unwrap();
        assert_eq!(img.dimensions(), (1, 2));
    }

    #[test]
    fn crop_rejects_tiny() {
        let raw = RawPage { bytes: tiny_png(), ext: "png".into() };
        // 2000x3000 图上取 <4px 的框才触发"选区太小";2x3 图任何框都可能过小。
        assert!(crop_dyn(&raw, &rect(0.0, 0.0, 0.001, 0.001)).is_err());
        assert!(crop_dyn(&raw, &rect(0.5, 0.5, 0.0, 0.0)).is_err());
    }

    #[test]
    fn crop_rejects_bad_image() {
        let raw = RawPage { bytes: b"junk".to_vec(), ext: "png".into() };
        assert!(crop_dyn(&raw, &rect(0.0, 0.0, 0.5, 0.5)).is_err());
    }

    #[test]
    fn http_payload_roundtrip() {
        let png = tiny_png();
        let body = http_body(&png);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let b64 = v["image"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(decoded, png);
        assert_eq!(parse_http_response(r#"{"text":"あ"}"#).unwrap(), "あ");
        assert!(parse_http_response(r#"{"nope":1}"#).is_err());
        assert!(parse_http_response("html").is_err());
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test ocr::tests`
Expected: 编译失败(函数未定义;lib.rs 加 `mod ocr;` 后再跑)。

- [ ] **Step 3: 实现**

3a. `lib.rs` 加 `mod ocr;`。

3b. `ocr.rs` 测试模块之前补实现:

```rust
fn clamp01(v: f64) -> f64 {
    if v.is_nan() { 0.0 } else { v.max(0.0).min(1.0) }
}

/// 相对矩形(0..1)→ 原图像素裁剪;宽或高 <4px 视为误触。
pub fn crop_dyn(raw: &RawPage, rect: &RegionRect) -> Result<DynamicImage, BackendError> {
    let img = image::load_from_memory(&raw.bytes)?;
    let (w, h) = img.dimensions();
    let x0 = (clamp01(rect.x) * f64::from(w)).floor() as u32;
    let y0 = (clamp01(rect.y) * f64::from(h)).floor() as u32;
    let x1 = (clamp01(rect.x + rect.w) * f64::from(w)).ceil() as u32;
    let y1 = (clamp01(rect.y + rect.h) * f64::from(h)).ceil() as u32;
    if x1 <= x0.saturating_add(3) || y1 <= y0.saturating_add(3) {
        return Err(BackendError::Msg("选区太小".into()));
    }
    Ok(img.crop_imm(x0, y0, x1 - x0, y1 - y0))
}

/// RGBA8 → PNG 字节。
pub fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, BackendError> {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = Vec::new();
    PngEncoder::new(&mut out).write_image(rgba.as_raw(), w, h, image::ExtendedColorType::Rgba8)?;
    Ok(out)
}

/// HTTP OCR 请求体:{"image": "<base64 png>"}。
pub fn http_body(png: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    serde_json::json!({ "image": b64 }).to_string()
}

/// HTTP OCR 响应解析:{"text": "..."}。
pub fn parse_http_response(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("OCR 响应不是 JSON:{e}"))?;
    v["text"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "OCR 响应缺少 text 字段".into())
}

/// HTTP OCR:POST endpoint(完整 URL),超时按设置。
pub async fn ocr_http(
    client: &reqwest::Client,
    endpoint: &str,
    png: &[u8],
    timeout_s: u64,
) -> Result<String, String> {
    let resp = client
        .post(endpoint)
        .timeout(std::time::Duration::from_secs(timeout_s.max(1)))
        .header("Content-Type", "application/json")
        .body(http_body(png))
        .send()
        .await
        .map_err(|e| format!("OCR 请求失败:{e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let head: String = body.chars().take(200).collect();
        return Err(format!("OCR 服务返回 {status}:{head}"));
    }
    parse_http_response(&body)
}

/// 本地 OCR(WinRT Windows.Media.Ocr,仅 Windows);单边超限先降采样。
#[cfg(windows)]
pub fn ocr_local(png: &[u8], lang: &str) -> Result<String, String> {
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::core::HSTRING;

    // WinRT 异步 .get() 需要线程进 COM;已初始化时忽略错误。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let engine = (|| -> windows::core::Result<OcrEngine> {
        let l = Language::CreateLanguage(&HSTRING::from(lang))?;
        OcrEngine::TryCreateFromLanguage(&l)
    })()
    .or_else(|_| OcrEngine::TryCreateFromUserProfileLanguages())
    .map_err(|_| {
        format!(
            "系统缺少 {lang} OCR 语言包:请在系统设置→时间和语言→语言中安装,或在设置页配置 OCR Endpoint"
        )
    })?;

    // Windows OCR 单边上限(MaxImageDimension,典型 4096),超出先降采样。
    let max_dim = OcrEngine::MaxImageDimension().unwrap_or(4096);
    let img = image::load_from_memory(png).map_err(|e| format!("选区图解码失败:{e}"))?;
    let img = if img.width().max(img.height()) > max_dim {
        let k = f64::from(max_dim) / f64::from(img.width().max(img.height()));
        let (nw, nh) = (
            (f64::from(img.width()) * k).round() as u32,
            (f64::from(img.height()) * k).round() as u32,
        );
        img.resize_exact(nw.max(1), nh.max(1), image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let png = encode_png(&img).map_err(|e| e.to_string())?;

    let werr = |e: windows::core::Error| format!("本地 OCR 失败:{e}");
    let stream = InMemoryRandomAccessStream::new().map_err(werr)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(werr)?;
    writer.WriteBytes(&png).map_err(werr)?;
    writer.StoreAsync().map_err(werr)?.get().map_err(werr)?;
    writer.FlushAsync().map_err(werr)?.get().map_err(werr)?;
    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(werr)?.get().map_err(werr)?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(werr)?.get().map_err(werr)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(werr)?.get().map_err(werr)?;
    let text = result.Text().map_err(werr)?.to_string();
    Ok(text.trim().to_string())
}

/// 非 Windows 占位:本地 OCR 不可用,提示配置 endpoint。
#[cfg(not(windows))]
pub fn ocr_local(_png: &[u8], _lang: &str) -> Result<String, String> {
    Err("当前平台不支持本地 OCR,请在设置页配置 OCR Endpoint".into())
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd src-tauri && cargo test ocr::tests`
Expected: 4 个测试全过。

---

### Task 5: commands + lib.rs 接线(三个新命令、注册、持久化 API key)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: commands.rs 实现三个命令**

1a. 顶部 `use` 区补:

```rust
use std::time::Instant;
use crate::ocr;
use crate::translate;
use crate::{OcrResult, RegionRect, TransStats, TranslateResult};
```

1b. `set_settings` 之前追加命令实现:

```rust
/// 阶段三:框选区域 OCR。裁剪原图(非展示缩放图)→ 本地 WinRT / HTTP OCR。
#[tauri::command]
pub async fn ocr_region(
    state: State<'_, Arc<AppState>>,
    book_id: String,
    index: u32,
    rect: RegionRect,
) -> Result<OcrResult, String> {
    let t0 = Instant::now();
    let (path, endpoint, lang, timeout_s) = {
        let s = state.settings.lock().clone();
        let row = state
            .db
            .with(|conn| db::get_book(conn, &book_id).map_err(err))?
            .ok_or_else(|| "书籍不存在".to_string())?;
        (row.path, s.ocr_endpoint, s.src_lang, s.ocr_timeout_s)
    };
    let png = blocking(move || -> Result<Vec<u8>, BackendError> {
        let src = source::open_source(Path::new(&path))?;
        let count = src.page_count()?;
        if index >= count as u32 {
            return Err(BackendError::Msg(format!(
                "页码 {index} 超出范围(共 {count} 页)"
            )));
        }
        let raw = src.read_raw(index as usize)?;
        ocr::encode_png(&ocr::crop_dyn(&raw, &rect)?)
    })
    .await?;

    let client = state.http.clone();
    let res = if endpoint.trim().is_empty() {
        blocking(move || ocr::ocr_local(&png, &lang).map_err(BackendError::Msg)).await
    } else {
        ocr::ocr_http(&client, endpoint.trim(), &png, timeout_s)
            .await
            .map_err(BackendError::Msg)
    };

    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = state.db.with(|conn| db::log_trans(conn, "ocr", res.is_ok(), elapsed_ms));
    match res {
        Ok(text) => Ok(OcrResult { text, elapsed_ms }),
        Err(e) => Err(e.to_string()),
    }
}

/// 阶段三:翻译一段文本(OpenAI 兼容)。
#[tauri::command]
pub async fn translate_region(
    state: State<'_, Arc<AppState>>,
    text: String,
) -> Result<TranslateResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可翻译的文本".into());
    }
    let t0 = Instant::now();
    let s = state.settings.lock().clone();
    let res = translate::translate(&state.http, &s, &text).await;
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = state.db.with(|conn| db::log_trans(conn, "trans", res.is_ok(), elapsed_ms));
    let (translated, model, _) = res?;
    Ok(TranslateResult { translated, model, elapsed_ms })
}

/// 阶段三:OCR/翻译调用统计(设置页展示)。
#[tauri::command]
pub async fn get_trans_stats(state: State<'_, Arc<AppState>>) -> Result<TransStats, String> {
    state.db.with(|conn| db::trans_stats(conn).map_err(err))
}
```

- [ ] **Step 2: lib.rs 接线**

2a. `generate_handler![...]` 列表末尾(`commands::set_settings` 之后)追加:

```rust
            commands::ocr_region,
            commands::translate_region,
            commands::get_trans_stats
```

2b. `set_settings` 的 `persist` 数组在 `("trans_model", ...)` 之后补一行:

```rust
        ("trans_api_key", settings.trans_api_key.clone()),
```

- [ ] **Step 3: 全量后端测试 + 检查**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全部测试通过(含既有 cache/pipeline/db 测试);`cargo check` 无错误。

---

### Task 6: 前端契约 + 选区纯函数(TDD)

**Files:**
- Modify: `src/lib/tauri.ts`
- Create: `src/components/Reader/region.ts`
- Create: `scripts/verify-region.mjs`

- [ ] **Step 1: tauri.ts 契约扩展**

1a. `Settings` 接口 `libraryDir: string;` 之后加 `transApiKey: string;`。

1b. 文件中类型区(`ScanResult` 之后)追加:

```ts
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  text: string;
  elapsedMs: number;
}

export interface TranslateResult {
  translated: string;
  model: string;
  elapsedMs: number;
}

export interface TransLogEntry {
  kind: string;
  ok: boolean;
  elapsedMs: number;
  createdAt: string;
}

export interface TransStats {
  ocrCalls: number;
  ocrFail: number;
  ocrAvgMs: number;
  transCalls: number;
  transFail: number;
  transAvgMs: number;
  recent: TransLogEntry[];
}
```

1c. `api` 对象末尾(`clearPages` 之后)追加:

```ts
  ocrRegion: (bookId: string, index: number, rect: RegionRect) =>
    invoke<OcrResult>("ocr_region", { book_id: bookId, index, rect }),
  translateRegion: (text: string) =>
    invoke<TranslateResult>("translate_region", { text }),
  getTransStats: () => invoke<TransStats>("get_trans_stats"),
```

- [ ] **Step 2: 写选区纯函数 + 验证脚本(先写脚本再写实现,跑失败)**

2a. 创建 `scripts/verify-region.mjs`(沿用 verify-spread 的复制式验证):

```js
// 阶段三验收:选区归一化纯函数验证(与 src/components/Reader/region.ts 同逻辑)。
// 运行:node scripts/verify-region.mjs
function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
function rectFromPoints(ax, ay, bx, by) {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}
function normRect(r) {
  const x0 = clamp01(r.x), y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w), y1 = clamp01(r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const MIN_RECT = 0.012;
function rectArea(r) { return r.w * r.h; }
function isUsable(r) { return rectArea(normRect(r)) >= MIN_RECT; }
function normPoint(el, cx, cy) {
  return {
    x: clamp01((cx - el.left) / (el.width || 1)),
    y: clamp01((cy - el.top) / (el.height || 1)),
  };
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
const check = (name, got, want) => {
  const ok = eq(got, want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
// 反向拖动归一化
check("reverse drag", rectFromPoints(0.8, 0.9, 0.2, 0.3), { x: 0.2, y: 0.3, w: 0.6, h: 0.6 });
// normRect 钳制越界
check("clamp over", normRect({ x: -0.2, y: -0.2, w: 1.5, h: 1.5 }), { x: 0, y: 0, w: 1, h: 1 });
check("clamp tail", normRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
// 可用性阈值
check("usable big", isUsable({ x: 0, y: 0, w: 0.5, h: 0.5 }), true);
check("usable tiny", isUsable({ x: 0, y: 0, w: 0.1, h: 0.1 }), false);
check("usable edge", isUsable({ x: 0, y: 0, w: 0.12, h: 0.1 }), true);
// 元素内归一化点
const el = { left: 100, top: 50, width: 200, height: 100 };
const p = normPoint(el, 150, 100);
check("norm point", near(p.x, 0.25) && near(p.y, 0.5), true);
const q = normPoint(el, 0, 0);
check("norm point outside", q.x === 0 && q.y === 0, true);
// 退化输入
check("nan guard", clamp01(NaN), 0);
check("zero el", normPoint({ left: 0, top: 0, width: 0, height: 0 }, 5, 5).x, 0);
if (fail > 0) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log("\nAll region checks passed.");
```

Run: `node scripts\verify-region.mjs`
Expected: 全 PASS(此脚本是实现的行为规约)。

- [ ] **Step 3: 写 region.ts(与脚本同逻辑的 TS 版)**

创建 `src/components/Reader/region.ts`:

```ts
/** 选区纯函数 — 相对坐标(0..1,相对页图元素)。与 scripts/verify-region.mjs 同逻辑。 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 面积阈值:小于该值的选区视为误触,不发起 OCR。 */
export const MIN_RECT = 0.012;

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** 两点 → 正规化矩形(支持反向拖动)。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/** 钳制到单位正方形内。 */
export function normRect(r: Rect): Rect {
  const x0 = clamp01(r.x);
  const y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w);
  const y1 = clamp01(r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectArea(r: Rect): number {
  return r.w * r.h;
}

export function isUsable(r: Rect): boolean {
  return rectArea(normRect(r)) >= MIN_RECT;
}

/** 视口坐标 → 元素内相对坐标(0..1)。 */
export function normPoint(el: ElRect, cx: number, cy: number): { x: number; y: number } {
  return {
    x: clamp01((cx - el.left) / (el.width || 1)),
    y: clamp01((cy - el.top) / (el.height || 1)),
  };
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误(若此时 Reader/Settings 尚未用新 API,tsc 也不会报错)。

---

### Task 7: Reader.tsx 选区模式 + Reader.css

**Files:**
- Modify: `src/pages/Reader.tsx`
- Modify: `src/components/Reader.css`

- [ ] **Step 1: Reader.tsx 状态与处理逻辑**

1a. `lucide-react` 导入列表补 `Copy, Languages`。

1b. `../lib/tauri` 导入补类型:

```ts
import { api, type BookInfo, type PageEntry, type OcrResult, type TranslateResult } from "../lib/tauri";
```

1c. `spread` 导入之后加:

```ts
import {
  isUsable,
  normPoint,
  rectFromPoints,
  type Rect,
} from "../components/Reader/region";
```

1d. 状态区(`const [sizeTick, setSizeTick] = useState(0);` 之后)加:

```tsx
  /* ---------- 阶段三:选区翻译 ---------- */
  const [regionMode, setRegionMode] = useState(false);
  const [selPx, setSelPx] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [ocrRes, setOcrRes] = useState<OcrResult | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [transRes, setTransRes] = useState<TranslateResult | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const selDragRef = useRef<{ idx: number; el: DOMRect; ax: number; ay: number } | null>(null);
  const regionRef = useRef(false);
  const regionPanelRef = useRef(false);
```

1e. `uiLockRef` 同步 effect(`useEffect(..., [tocOpen, setOpen, poke])` 那段)改为把选区面板算进锁:

```tsx
  useEffect(() => {
    const panel = regionPanelRef.current;
    overlayRef.current = tocOpen || setOpen || panel;
    uiLockRef.current = tocOpen || setOpen || panel;
    if (tocOpen || setOpen || panel) {
      setUiVisible(true);
      window.clearTimeout(hideTimer.current);
    } else {
      poke();
    }
  }, [tocOpen, setOpen, poke]);
```

1f. 结果面板开合时同步 refs(加在其后):

```tsx
  useEffect(() => {
    const panel = ocrBusy || ocrRes !== null || transBusy || transRes !== null;
    if (regionPanelRef.current !== panel) {
      regionPanelRef.current = panel;
      overlayRef.current = tocOpen || setOpen || panel;
      uiLockRef.current = tocOpen || setOpen || panel;
      if (panel) {
        setUiVisible(true);
        window.clearTimeout(hideTimer.current);
      }
    }
  }, [ocrBusy, ocrRes, transBusy, transRes, tocOpen, setOpen, poke]);
```

1g. 选区动作(放在 `resetView` 之后):

```tsx
  /* ---------- 阶段三:选区翻译动作 ---------- */
  const exitRegion = useCallback(() => {
    setRegionMode(false);
    setSelPx(null);
    selDragRef.current = null;
    setOcrRes(null);
    setTransRes(null);
    setOcrBusy(false);
    setTransBusy(false);
    regionRef.current = false;
    regionPanelRef.current = false;
    poke();
  }, [poke]);

  const toggleRegion = useCallback(() => {
    if (regionRef.current) {
      exitRegion();
    } else {
      setRegionMode(true);
      regionRef.current = true;
      setTocOpen(false);
      setSetOpen(false);
      poke();
    }
  }, [exitRegion, poke]);

  const runOcr = useCallback(
    (idx: number, rect: Rect) => {
      setOcrBusy(true);
      setOcrRes(null);
      setTransRes(null);
      api
        .ocrRegion(bookId, idx, rect)
        .then(setOcrRes, (e) => toastErr("ocr_region", e))
        .finally(() => setOcrBusy(false));
    },
    [bookId],
  );

  const doTranslate = useCallback(() => {
    if (!ocrRes?.text) return;
    setTransBusy(true);
    setTransRes(null);
    api
      .translateRegion(ocrRes.text)
      .then(setTransRes, (e) => toastErr("translate_region", e))
      .finally(() => setTransBusy(false));
  }, [ocrRes]);

  const copyOcr = useCallback(() => {
    const t = ocrRes?.text ?? transRes?.translated ?? "";
    if (!t) return;
    navigator.clipboard.writeText(t).then(
      () => toast("已复制"),
      () => toastErr("clipboard", "复制失败"),
    );
  }, [ocrRes, transRes]);
```

1h. pointer 处理:三处分支插入选区逻辑。

`onPointerDown` 开头(`pointers.current.set` 之前)插:

```tsx
    // 阶段三:选区模式下,单指在页图上按下 → 开始框选(不影响双指缩放)。
    if (regionMode && e.pointerType !== "touch" && e.button === 0) {
      const img = (e.target as HTMLElement).closest("img");
      if (img) {
        const r = img.getBoundingClientRect();
        const p = normPoint(r, e.clientX, e.clientY);
        selDragRef.current = { idx: Number(img.dataset.idx), el: r, ax: p.x, ay: p.y };
        setSelPx({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
        return;
      }
    }
```

`onPointerMove` 在 `const prev = pointers.current.get(e.pointerId);` 之前插:

```tsx
    // 阶段三:框选拖动(不进入 pan/pinch 分支)。
    if (selDragRef.current) {
      const d = selDragRef.current;
      const p = normPoint(d.el, e.clientX, e.clientY);
      const r = rectFromPoints(d.ax, d.ay, p.x, p.y);
      setSelPx({
        left: d.el.left + r.x * d.el.width,
        top: d.el.top + r.y * d.el.height,
        width: r.w * d.el.width,
        height: r.h * d.el.height,
      });
      return;
    }
```

`endPointer` 开头插:

```tsx
    // 阶段三:框选收尾 → 发起 OCR。
    if (selDragRef.current && e.pointerId === tap.current.id) {
      const d = selDragRef.current;
      selDragRef.current = null;
      setSelPx(null);
      const p = normPoint(d.el, e.clientX, e.clientY);
      const rect = rectFromPoints(d.ax, d.ay, p.x, p.y);
      if (isUsable(rect) && !Number.isNaN(d.idx)) runOcr(d.idx, rect);
      return;
    }
```

同时 `onPointerDown` 原有 `tap.current = ...` 赋值前加一行守卫(选区按下不算 tap):

```tsx
    } else if (pointers.current.size === 1 && !selDragRef.current) {
```

1i. 键盘:`Escape` 分支改为先退选区:

```tsx
        case "Escape":
          // 选区开着先退选区,弹层开着先关弹层,否则返回书库。
          if (regionRef.current) {
            exitRegion();
          } else if (overlayRef.current) {
            setTocOpen(false);
            setSetOpen(false);
          } else {
            nav("/");
          }
          break;
```

键盘 effect 的依赖数组 `[go, jumpTo, toggleMode, nav]` 补 `exitRegion`。并在 switch 里加快捷键:

```tsx
        case "o":
        case "O":
          toggleRegion();
          break;
```

依赖数组补 `toggleRegion`。

1j. 渲染:

- `reader-canvas` 的 `className` 改为模板串追加 region 样式:`className={`reader-canvas${regionMode ? " region-mode" : ""}`}`。
- 页 `<img>` 加 `data-idx={idx}`。
- `reader-pages` 容器 div 结束后、`{bookState === ...}` 三元外(即 canvas div 内、状态分支之后)加选区浮框:

```tsx
        {selPx && (
          <div
            className="region-overlay"
            style={{ left: selPx.left, top: selPx.top, width: selPx.width, height: selPx.height }}
          />
        )}
```

- 底部 bar 的"阅读设置"按钮之前加:

```tsx
        <button
          className={`rbtn${regionMode ? " on" : ""}`}
          onClick={toggleRegion}
          title="选区翻译 (o)"
        >
          <Languages size={16} />
        </button>
```

- `Toaster` 之前加结果面板:

```tsx
      {/* 阶段三:选区结果面板 */}
      {regionMode && (ocrBusy || ocrRes || transBusy || transRes) && (
        <div className="reader-region fade-in">
          <div className="rr-head">
            <span>
              选区 OCR
              {ocrBusy ? " · 识别中…" : ocrRes ? ` · ${ocrRes.elapsedMs} ms` : ""}
            </span>
            <span style={{ display: "flex", gap: 2 }}>
              <button className="rbtn" onClick={copyOcr} title="复制" disabled={!ocrRes && !transRes}>
                <Copy size={14} />
              </button>
              <button className="rbtn" onClick={exitRegion} title="关闭并退出选区 (Esc)">
                <X size={14} />
              </button>
            </span>
          </div>
          <div className="rr-text mono">
            {ocrBusy ? "…" : ocrRes?.text || "未识别到文本"}
          </div>
          <div className="rr-actions">
            <button
              className="rbtn rr-translate"
              onClick={doTranslate}
              disabled={transBusy || !ocrRes?.text}
            >
              {transBusy ? <RefreshCw size={14} className="rr-spin" /> : <Languages size={14} />}
              {transBusy ? "翻译中…" : "翻译"}
            </button>
            {transRes && (
              <span className="rr-meta mono">
                {transRes.model} · {transRes.elapsedMs} ms
              </span>
            )}
          </div>
          {transRes && <div className="rr-text rr-trans">{transRes.translated}</div>}
        </div>
      )}
```

- [ ] **Step 2: Reader.css 追加样式**

文件末尾(`@media` 之前)追加:

```css
/* Stage-3 region translate */
.reader-canvas.region-mode { cursor: crosshair; }

.region-overlay {
  position: fixed;
  border: 2px dashed #7dd3fc;
  background: rgba(125, 211, 252, 0.12);
  border-radius: 4px;
  pointer-events: none;
  z-index: 35;
}

.reader-region {
  position: absolute;
  bottom: 74px;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, 92vw);
  max-height: min(46vh, 420px);
  overflow-y: auto;
  background: rgba(18, 18, 22, 0.94);
  backdrop-filter: blur(16px);
  border: 1px solid #27272a;
  border-radius: 14px;
  padding: 12px 14px;
  z-index: 45;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #a1a1aa;
}
.rr-text {
  font-size: 13px;
  line-height: 1.7;
  color: #e4e4e7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow-y: auto;
}
.rr-trans { color: #7dd3fc; max-height: 140px; }
.rr-actions { display: flex; align-items: center; gap: 10px; }
.rr-translate {
  border: 1px solid #3f3f46;
  border-radius: 8px;
  padding: 6px 14px;
  gap: 6px;
  font-size: 12px;
}
.rr-translate:disabled { opacity: 0.4; }
.rr-meta { font-size: 11px; color: #71717a; }
.rr-spin { animation: rr-rot 0.9s linear infinite; }
@keyframes rr-rot { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

---

### Task 8: Settings.tsx 转正式 + 统计

**Files:**
- Modify: `src/pages/Settings.tsx`

- [ ] **Step 1: 契约与状态**

1a. 导入行 `import { api, type MemoryStats, type Settings } from "../lib/tauri";` 改为:

```ts
import { api, type MemoryStats, type Settings, type TransStats } from "../lib/tauri";
```

1b. `DEFAULT_FORM` 的 `libraryDir: "",` 之后加 `transApiKey: "",`。

1c. 组件状态区加 `const [stats, setStats] = useState<TransStats | null>(null);`;

加载 effect 的 `Promise.all([api.getSettings(), api.getMemoryStats()])` 改为:

```ts
    Promise.all([api.getSettings(), api.getMemoryStats(), api.getTransStats()])
      .then(
        ([s, m, t]) => {
          if (!alive) return;
          setForm({ ...DEFAULT_FORM, ...s });
          setMem(m);
          setStats(t);
```

(后续 `document.documentElement.dataset.theme` 等保持不变;解构改为三元。)

- [ ] **Step 2: 翻译卡片转正式**

2a. 卡片标题徽标改:`<Languages size={15} /> 翻译服务 <span className="badge">阶段三</span>`,下方 hint 改为:

```tsx
        <p className="hint">
          OCR 默认走 Windows 本地引擎(需系统语言包);配置 OCR Endpoint 则改发
          {" "}"image"→"text"{" "}JSON 协议。翻译走 OpenAI 兼容 /chat/completions。
        </p>
```

2b. API Key 输入框改为受控:

```tsx
          <label className="field">
            <span>API Key</span>
            <input
              className="input mono"
              type="password"
              value={form.transApiKey}
              placeholder="Bearer 鉴权,可留空"
              onChange={(e) => set("transApiKey", e.currentTarget.value)}
              aria-label="API Key"
            />
          </label>
```

2c. OCR Endpoint 的 hint 改为 `placeholder="留空用 Windows 本地 OCR"`,输入框上方 `span` 文案改 `OCR Endpoint`。

2d. 卡片末尾(`</div>` 网格之后)加统计块:

```tsx
        {stats && (
          <div className="trans-stats hint mono" style={{ marginTop: 12 }}>
            OCR {stats.ocrCalls} 次(失败 {stats.ocrFail},均值{" "}
            {stats.ocrAvgMs.toFixed(0)} ms) · 翻译 {stats.transCalls} 次(失败{" "}
            {stats.transFail},均值 {stats.transAvgMs.toFixed(0)} ms)
            {stats.recent[0] ? ` · 最近 ${stats.recent[0].createdAt}` : " · 暂无调用"}
          </div>
        )}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

---

### Task 9: 全量验证

- [ ] **Step 1: 后端测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过(含既有与新增 db/translate/ocr 测试)。

- [ ] **Step 2: 前端验证脚本**

Run: `node scripts\verify-spread.mjs && node scripts\verify-region.mjs`
Expected: 两个脚本均输出 `All ... passed.`。

- [ ] **Step 3: 前端构建(含 tsc + vite)**

Run: `npm run build`
Expected: tsc 无错误,vite 构建产物写入 `dist/`。

- [ ] **Step 4: 手工冒烟(可选,需 GUI)**

`npm run tauri dev` → 设置页保存配置 → 开书 → 按 `o` → 框选气泡 → OCR → 翻译 → 复制;Esc 退出;设置页统计增长。

---

## Self-Review

1. **Spec 覆盖**:trans_log 表/统计(Task 2)、HTTP 客户端(Task 3)、translate.rs(Task 3)、ocr.rs 裁剪/本地/HTTP(Task 4)、三命令+注册+API key 持久化(Task 5)、tauri.ts 契约与 transApiKey 修复(Task 6)、选区交互(Task 7)、设置页转正+统计(Task 8)——与设计文档逐条对齐。
2. **占位扫描**:无 TBD/TODO;所有代码步骤含完整代码。
3. **类型一致性**:`RegionRect{x,y,w,h}` 前后端一致(camelCase serde);`TransStats` 字段与 lib.rs 契约一致;`api.ocrRegion` 参数键沿用项目既有 snake_case 风格(`{ book_id: bookId, index, rect }`,与现有 `getBook` 用法一致);`region.ts` 与 `verify-region.mjs` 逻辑逐行同源。
