//! 阶段三 OCR:相对坐标裁剪 + 编码 PNG(纯函数,可单测);
//! 本地 WinRT Windows.Media.Ocr 或 HTTP OCR 二选一,由 ocrEndpoint 是否为空决定。

use base64::Engine as _;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, GenericImageView, ImageEncoder};

use crate::source::{BackendError, RawPage};
use crate::RegionRect;

fn clamp01(v: f64) -> f64 {
    if v.is_nan() {
        0.0
    } else {
        v.max(0.0).min(1.0)
    }
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
    v["text"].as_str().map(str::to_string).ok_or_else(|| {
        let head: String = body.chars().take(200).collect();
        format!("OCR 响应缺少 text 字段:{head}")
    })
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
        let nw = (f64::from(img.width()) * k).round() as u32;
        let nh = (f64::from(img.height()) * k).round() as u32;
        img.resize_exact(nw.max(1), nh.max(1), image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let png = encode_png(&img).map_err(|e| e.to_string())?;

    let werr = |e: windows::core::Error| format!("本地 OCR 失败:{e}");
    let stream = InMemoryRandomAccessStream::new().map_err(werr)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(werr)?;
    writer.WriteBytes(&png).map_err(werr)?;
    writer.StoreAsync().map_err(werr)?.join().map_err(werr)?;
    writer.FlushAsync().map_err(werr)?.join().map_err(werr)?;
    // Store/Flush 后流位置在末尾,解码器从当前位置读,必须先回卷。
    stream.Seek(0).map_err(werr)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(werr)?
        .join()
        .map_err(werr)?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(werr)?
        .join()
        .map_err(werr)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(werr)?
        .join()
        .map_err(werr)?;
    let text = result.Text().map_err(werr)?.to_string();
    Ok(text.trim().to_string())
}

/// 非 Windows 占位:本地 OCR 不可用,提示配置 endpoint。
#[cfg(not(windows))]
pub fn ocr_local(_png: &[u8], _lang: &str) -> Result<String, String> {
    Err("当前平台不支持本地 OCR,请在设置页配置 OCR Endpoint".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> RegionRect {
        RegionRect { x, y, w, h }
    }

    /// 100x60 空白 RGBA 样图(任何合法裁剪都大于 4px 最小边长)。
    fn sample_png() -> Vec<u8> {
        let img = image::DynamicImage::new_rgba8(100, 60);
        encode_png(&img).unwrap()
    }

    #[test]
    fn crop_clamps_and_encodes() {
        let raw = RawPage { bytes: sample_png(), ext: "png".into() };
        // 越界钳制:仍产出 100x60 全图。
        let img = crop_dyn(&raw, &rect(-0.5, -0.5, 2.0, 2.0)).unwrap();
        assert_eq!(img.dimensions(), (100, 60));
        // 半图。
        let img = crop_dyn(&raw, &rect(0.0, 0.0, 0.5, 0.5)).unwrap();
        assert_eq!(img.dimensions(), (50, 30));
    }

    #[test]
    fn crop_rejects_tiny() {
        let raw = RawPage { bytes: sample_png(), ext: "png".into() };
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
        let png = sample_png();
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
