//! 图片管线：按需解码单页 + 按显示尺寸降采样 + JPEG 重编码。
//!
//! 约束（预算制，写入内存前就控制大小）：
//! - 解码只针对单页原始字节（`source` 已保证流式单页读）；
//! - 若请求 `max_width/max_height`（前端视口尺寸），先算目标尺寸再做
//!   `thumbnail` 一步式降采样，不保留全分辨率中间图；
//! - 输出统一为 JPEG dataURL（前端契约要求 base64 dataURL；JPEG 体积可控）。
//! - 缩略图走同样的管线（目标边 ≤ `max_size`，默认 240px）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{ImageError, ImageFormat};

use crate::source::{BackendError, RawPage};

/// 条漫切片的目标显示高度（设备像素）；前后端共享同一常量保证边界一致。
pub const WEBTOON_TILE_H: u32 = 2048;
/// 超过该源高度视为"长图"：解码必须走按显示宽度缩放路径。
pub const TALL_IMAGE_H: u32 = 8000;

/// 条漫切片数：显示高度（宽 = render_w 时）均分为 ≤WEBTOON_TILE_H 的片。
pub fn webtoon_tile_count(orig_w: u32, orig_h: u32, render_w: u32) -> u32 {
    if orig_w == 0 || orig_h == 0 || render_w == 0 {
        return 1;
    }
    let disp_h = (orig_h as f64 * render_w as f64 / orig_w as f64).ceil() as u64;
    ((disp_h + WEBTOON_TILE_H as u64 - 1) / WEBTOON_TILE_H as u64).max(1) as u32
}

/// 解码后待缓存/待返回的成品图（已是最终输出尺寸）。
/// `bytes` = JPEG 成品字节（磁盘缓存直接落盘用）；`data_url` 前端契约不变；
/// `orig_width/orig_height` = 源图原始尺寸（条漫建议/切片布局用），进内存缓存时保留（很小）。
#[derive(Debug, Clone)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub orig_width: u32,
    pub orig_height: u32,
    pub mime: String,
    pub data_url: String,
    pub bytes: Vec<u8>,
}

fn decoded_format(raw: &RawPage) -> Result<ImageFormat, BackendError> {
    // 先信扩展名（zip 条目名可信度高），无扩展名再嗅探魔数。
    let by_ext = match raw.ext.as_str() {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    if let Some(fmt) = by_ext {
        return Ok(fmt);
    }
    Ok(image::guess_format(&raw.bytes).map_err(image::ImageError::from)?)
}

/// 按目标框计算等比缩放尺寸（任一边超限才缩小；不放大）。
pub fn fit_size(src_w: u32, src_h: u32, max_w: Option<u32>, max_h: Option<u32>) -> (u32, u32) {
    if src_w == 0 || src_h == 0 {
        return (1, 1);
    }
    let mut w = src_w as f64;
    let mut h = src_h as f64;
    if let Some(mw) = max_w {
        if mw > 0 && w > mw as f64 {
            let k = mw as f64 / w;
            w *= k;
            h *= k;
        }
    }
    if let Some(mh) = max_h {
        if mh > 0 && h > mh as f64 {
            let k = mh as f64 / h;
            w *= k;
            h *= k;
        }
    }
    (w.max(1.0).round() as u32, h.max(1.0).round() as u32)
}

/// 解码单页并按需降采样，重编码为 JPEG dataURL。
///
/// - `image` 0.25 的 JPEG 走 zune-jpeg（快）；降采样用 Triangle 滤镜
///   （比默认 Lanczos3 快数倍，阅读视口下画质差异不可辨）；
/// - **长图保护**：源高 > 8000px 且为 JPEG 且请求了目标宽时，走 jpeg-decoder
///   的 IDCT 缩放解码（按显示宽度），全分辨率栅格从不进内存；
/// - 成品字节同时返回，供磁盘渲染缓存落盘。
pub fn render_raw(raw: &RawPage, max_w: Option<u32>, max_h: Option<u32>) -> Result<RenderedPage, BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
        .with_guessed_format()?
        .into_dimensions()?;

    let tall_jpeg = sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg && max_w.is_some() && max_w.unwrap_or(0) > 0;
    if tall_jpeg {
        return render_tall_jpeg(raw, sw, sh, max_w, max_h);
    }

    let img = image::load_from_memory_with_format(&raw.bytes, fmt).map_err(ImageError::from)?;
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    let img = if tw == sw && th == sh {
        img
    } else {
        img.resize(tw, th, image::imageops::FilterType::Triangle)
    };
    finish_render(img, sw, sh)
}

/// 长图专用：IDCT 缩放解码到不超过目标宽的最大 1/2^k 档，再精确缩放到目标尺寸。
pub fn render_tall_jpeg(
    raw: &RawPage,
    sw: u32,
    sh: u32,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<RenderedPage, BackendError> {
    let img = decode_tall_jpeg_img(raw, sw, sh, max_w, max_h)?;
    finish_render(img, sw, sh)
}

/// 长图解码（不下线编码）：返回已缩放到目标尺寸的栅格。
fn decode_tall_jpeg_img(
    raw: &RawPage,
    sw: u32,
    sh: u32,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<image::DynamicImage, BackendError> {
    let target_w = max_w.unwrap_or(0);
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    // jpeg-decoder 的 scale 目标：按目标宽求比例的高（u16 上限内的源都成立）。
    let want_h = ((sh as u64 * tw as u64) / sw as u64).min(u16::MAX as u64) as u16;

    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(&raw.bytes));
    decoder.read_info()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    decoder.scale(target_w.min(u16::MAX as u32) as u16, want_h)
        .map_err(|e| BackendError::Decode(format!("长图缩放不可用：{e}")))?;
    let pixels = decoder.decode()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    let info = decoder.info().ok_or_else(|| BackendError::Decode("缺少 JPEG 信息".into()))?;

    let img = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => image::RgbImage::from_raw(
            info.width as u32,
            info.height as u32,
            pixels,
        )
        .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into()))?
        .into(),
        jpeg_decoder::PixelFormat::L8 => {
            let gray = image::GrayImage::from_raw(info.width as u32, info.height as u32, pixels)
                .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into()))?;
            image::DynamicImage::ImageLuma8(gray)
        }
        _ => {
            // CMYK 等罕见格式退回常规解码（长图 CMYK 极罕见；牺牲一次全分辨率）。
            image::load_from_memory_with_format(&raw.bytes, ImageFormat::Jpeg).map_err(ImageError::from)?
        }
    };
    let (dw, dh) = (img.width(), img.height());
    // 缩放解码的结果可能比目标略大（档位 1/2^k），精确缩到位。
    Ok(if dw == tw && dh == th {
        img
    } else {
        img.resize_exact(tw, th, image::imageops::FilterType::Triangle)
    })
}

/// 统一收尾：RGB 转换 + JPEG 编码 + dataURL。
fn finish_render(img: image::DynamicImage, sw: u32, sh: u32) -> Result<RenderedPage, BackendError> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 82);
        enc.encode_image(&rgb)?;
    }
    // 内存缓冲即走即用，不落盘（磁盘渲染缓存由调用方决定）。
    let data_url = format!("data:image/jpeg;base64,{}", B64.encode(&buf));
    Ok(RenderedPage {
        width: w,
        height: h,
        orig_width: sw,
        orig_height: sh,
        mime: "image/jpeg".to_string(),
        data_url,
        bytes: buf,
    })
}

/// 条漫整页 → 全部切片（**一次解码、一次 RGB 转换、逐片编码**）。
///
/// 性能要点（用户报"切换等待太久"的根因修复）：
/// - 解码一次拿显示宽栅格（长图 JPEG 走 IDCT 缩放解码），不再"整页编码→再解码回来"；
/// - `to_rgb8` 只做一次，逐片从同一栅格裁剪，不再每片重复整图转换；
/// - 切片几何与 `webtoon_tile_count`（前端同公式）严格一致，边界无缝。
pub fn render_webtoon_tiles(
    raw: &RawPage,
    max_w: u32,
) -> Result<(u32, Vec<RenderedPage>), BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
        .with_guessed_format()?
        .into_dimensions()?;
    let img = if sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg {
        decode_tall_jpeg_img(raw, sw, sh, Some(max_w), None)?
    } else {
        let img = image::load_from_memory_with_format(&raw.bytes, fmt).map_err(ImageError::from)?;
        let (tw, th) = fit_size(sw, sh, Some(max_w), None);
        if tw == sw && th == sh {
            img
        } else {
            img.resize(tw, th, image::imageops::FilterType::Triangle)
        }
    };

    let tiles = webtoon_tile_count(sw, sh, max_w);
    let rgb = img.to_rgb8(); // 只转换一次
    let (w, h) = (rgb.width(), rgb.height());
    let per = (h as u64).div_ceil(tiles.max(1) as u64) as u32;
    let mut out = Vec::with_capacity(tiles as usize);
    for t in 0..tiles {
        let y0 = (t * per).min(h);
        let y1 = ((t + 1) * per).min(h).max(y0);
        let crop = image::imageops::crop_imm(&rgb, 0, y0, w, y1 - y0);
        let slice = crop.to_image();
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
            enc.encode_image(&slice)?;
        }
        out.push(RenderedPage {
            width: w,
            height: y1 - y0,
            orig_width: w,
            orig_height: h,
            mime: "image/jpeg".to_string(),
            data_url: format!("data:image/jpeg;base64,{}", B64.encode(&buf)),
            bytes: buf,
        });
    }
    Ok((tiles, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_size_downscales_only() {
        // 超限等比缩小。
        assert_eq!(fit_size(2000, 1000, Some(1000), None), (1000, 500));
        assert_eq!(fit_size(1000, 2000, None, Some(1000)), (500, 1000));
        // 未超限不放大。
        assert_eq!(fit_size(100, 100, Some(800), Some(600)), (100, 100));
        // 无限制原样。
        assert_eq!(fit_size(640, 100, None, None), (640, 100));
    }

    #[test]
    fn webtoon_tiles_cover_full_height() {
        use image::ImageEncoder as _;
        // 100×5000 PNG（非 JPEG，走常规解码路径）：切片必须无缝覆盖整高。
        let mut img = image::RgbImage::new(100, 5000);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), 100, 5000, image::ExtendedColorType::Rgb8)
            .unwrap();
        let raw = RawPage {
            bytes: buf,
            ext: "png".into(),
        };
        let (tiles, pages) = render_webtoon_tiles(&raw, 200).unwrap();
        assert!(tiles >= 1);
        assert_eq!(pages.len() as u32, tiles);
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, 5000, "切片应无缝覆盖整高（无重叠无缝隙）");
        assert!(pages
            .iter()
            .all(|p| p.data_url.starts_with("data:image/jpeg;base64,")));
    }
}
