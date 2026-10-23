//! 图片管线：按需解码单页 + 按显示尺寸降采样 + JPEG 重编码。
//!
//! 约束（预算制，写入内存前就控制大小）：
//! - 解码只针对单页原始字节（`source` 已保证流式单页读）；
//! - 若请求 `max_width/max_height`（前端视口尺寸），先算目标尺寸再做
//!   `thumbnail` 一步式降采样，不保留全分辨率中间图；
//! - 输出统一为 JPEG dataURL（前端契约要求 base64 dataURL；JPEG 体积可控）。
//! - 缩略图走同样的管线（目标边 ≤ `max_size`，默认 240px）。
//!
//! 超高分辨率条漫防线（20000–65000px 高的未切分巨图）：
//! - WebView2 单张纹理高度上限约 16384px，整图直送 `<img>` 会显存溢出成黑/白块；
//! - 条漫路径走**先切后缩**（按源图纵向切带 → 逐带缩放到显示宽 → 输出连续切片），
//!   不再额外持有「整图缩放副本」：相比旧实现省掉一份同尺寸副本，
//!   但仍需同时存活「一张显示宽工作栅格 + 一条源带」，长图 JPEG 走 IDCT 缩放解码；
//! - 单页/双页路径兜底：缩放后仍超 `MAX_SAFE_TEXTURE_H` 就等比再缩小，
//!   宁可变小也不能把超限纹理交给前端。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{ImageError, ImageFormat};

use crate::source::{BackendError, RawPage};

/// 条漫切片的目标显示高度（设备像素）；前后端共享同一常量保证边界一致。
pub const WEBTOON_TILE_H: u32 = 2048;
/// 超过该源高度视为"长图"：解码必须走按显示宽度缩放路径。
pub const TALL_IMAGE_H: u32 = 8000;

/// **WebView2 单张纹理的安全高度上限**（设备像素）。
///
/// 来源与理由：WebView2（Chromium / ANGLE / D3D 后端）的单张纹理维度上限约为
/// **16384px**；把这个上限当成"可用高度"在超高图上会触发显存分配失败，
/// 前端表现为整块黑/白图（条漫 20000–65000px 高时必现）。
/// 这里取上限的**一半**（8192）作为安全线：
/// 1. 给缩放取整留余量，避免正好压线；
/// 2. 兼容不同 GPU/驱动上更低的实际上限；
/// 3. 前端若再放大一次也不会越过 16384。
pub const MAX_SAFE_TEXTURE_H: u32 = 8192;

/// **单片源高度上限**（源图坐标系，单位：像素行）。
///
/// 来源与理由：条漫必须"先切后缩"——按源图纵向切带、逐带缩放到显示宽度，
/// 而不是"整图解码 → 整体缩放 → 再切"（后者峰值内存 ≈ 原图 + 整图缩放副本 +
/// 切片栅格，1600×65000 的图仅缩放副本就 ~300MB）。
/// 4096 行的源带在 1600px 宽时约 19MB（RGB888），缩完立刻释放，
/// 峰值内存只与带宽相关、与总图高度无关；同时单片输出高度也不会超过它。
pub const MAX_SLICE_H: u32 = 4096;

/// 源图像素数上限：防御畸形/恶意头部导致的巨额分配（返回错误而不是 OOM 崩溃）。
const MAX_SOURCE_PIXELS: u64 = 160_000_000;

/// 条漫切片数：把**单个逻辑页**（源尺寸 `orig_w × orig_h`）在显示宽度
/// `render_w` 下的显示高度均分为 ≤`WEBTOON_TILE_H` 的片。
///
/// 语义边界（页/片解耦）：
/// - 返回值只描述「逻辑页 P 内部切几片」，**不是页码**；上层进度/SQLite 一律用
///   逻辑页下标 P（`get_webtoon_layout` 的数组下标 / `book.pageCount`）。
/// - 前端 `Webtoon.tsx::webtoonTileCount` 必须用同一运算顺序
///   （`ceil(ceil(orig_h * render_w / orig_w) / TILE_H)`，至少 1，任一为 0 → 1）。
/// - 实际物化片数还会 `.min(display_h)`（见 `render_webtoon_tiles`），
///   保证极端长宽比下每片至少 1 显示行；前端镜像同一兜底。
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

/// 整数版 `round(x * num / den)`（四舍五入；den = 0 时返回 0）。
fn mul_round(x: u64, num: u64, den: u64) -> u64 {
    if den == 0 {
        return 0;
    }
    (x * num + den / 2) / den
}

/// 读取并校验源图尺寸：0 尺寸 / 像素数超限 / 头解析失败 → `BackendError`（不 panic）。
fn source_dimensions(raw: &RawPage) -> Result<(u32, u32), BackendError> {
    let dims = image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
        .with_guessed_format()?
        .into_dimensions()
        .map_err(|e| BackendError::Decode(format!("读取图片尺寸失败：{e}")))?;
    let (w, h) = (dims.0, dims.1);
    if w == 0 || h == 0 {
        return Err(BackendError::Decode(format!("图片尺寸非法（{w}×{h}）")));
    }
    if (w as u64).saturating_mul(h as u64) > MAX_SOURCE_PIXELS {
        return Err(BackendError::Decode(format!(
            "图片尺寸过大（{w}×{h}），超过解码上限 {MAX_SOURCE_PIXELS} 像素"
        )));
    }
    Ok((w, h))
}

/// `DynamicImage` → `RgbImage`；RGB8 直接**拿走**缓冲区（避免整图克隆）。
fn into_rgb(img: image::DynamicImage) -> image::RgbImage {
    match img {
        image::DynamicImage::ImageRgb8(v) => v,
        other => other.to_rgb8(),
    }
}

/// 纹理安全目标尺寸：任一边超过 `MAX_SAFE_TEXTURE_H` 就**等比**缩小。
///
/// 宁可变小，也不能把超限纹理交给前端（WebView2 会渲染成黑/白块）；
/// 等比缩放保证与 `orig_width/orig_height` 的宽高比关系保持正确。
fn safe_fit(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (1, 1);
    }
    if w <= MAX_SAFE_TEXTURE_H && h <= MAX_SAFE_TEXTURE_H {
        return (w, h);
    }
    let k = MAX_SAFE_TEXTURE_H as f64 / w.max(h) as f64;
    (
        ((w as f64 * k).round() as u32).clamp(1, MAX_SAFE_TEXTURE_H),
        ((h as f64 * k).round() as u32).clamp(1, MAX_SAFE_TEXTURE_H),
    )
}

/// 纹理安全兜底：任一边超过 `MAX_SAFE_TEXTURE_H` 就**等比**再缩小。
fn clamp_texture_safe(rgb: image::RgbImage) -> Result<image::RgbImage, BackendError> {
    let (w, h) = (rgb.width(), rgb.height());
    if w == 0 || h == 0 {
        return Err(BackendError::Decode("渲染结果尺寸为零".into()));
    }
    let (nw, nh) = safe_fit(w, h);
    if nw == w && nh == h {
        return Ok(rgb);
    }
    Ok(image::imageops::resize(
        &rgb,
        nw,
        nh,
        image::imageops::FilterType::Triangle,
    ))
}

/// 解码单页并按需降采样，重编码为 JPEG dataURL。
///
/// - `image` 0.25 的 JPEG 走 zune-jpeg（快）；降采样用 Triangle 滤镜
///   （比默认 Lanczos3 快数倍，阅读视口下画质差异不可辨）；
/// - **长图保护**：源高 > 8000px 且为 JPEG 且请求了目标宽时，走 jpeg-decoder
///   的 IDCT 缩放解码（按显示宽度），全分辨率栅格从不进内存；
/// - **纹理保护**：结果超过 `MAX_SAFE_TEXTURE_H` 时等比再缩一次（宁可变小也不给前端超限纹理）；
/// - 成品字节同时返回，供磁盘渲染缓存落盘。
pub fn render_raw(
    raw: &RawPage,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<RenderedPage, BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = source_dimensions(raw)?;

    let tall_jpeg = sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg && max_w.unwrap_or(0) > 0;
    if tall_jpeg {
        return render_tall_jpeg(raw, sw, sh, max_w, max_h);
    }

    let img = image::load_from_memory_with_format(&raw.bytes, fmt).map_err(ImageError::from)?;
    // 目标尺寸直接落到纹理安全线内：避免先缩放成超限大图再压扁（省一份峰值内存）。
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    let (fw, fh) = safe_fit(tw, th);
    let img = if fw == sw && fh == sh {
        img
    } else {
        img.resize_exact(fw, fh, image::imageops::FilterType::Triangle)
    };
    finish_render(into_rgb(img), sw, sh)
}

/// 长图专用：IDCT 缩放解码到不超过目标宽的最大 1/2^k 档，再精确缩放到目标尺寸。
pub fn render_tall_jpeg(
    raw: &RawPage,
    sw: u32,
    sh: u32,
    max_w: Option<u32>,
    max_h: Option<u32>,
) -> Result<RenderedPage, BackendError> {
    let (tw, th) = fit_size(sw, sh, max_w, max_h);
    // 纹理安全兜底先算目标尺寸：直接缩到安全尺寸，不生成整高副本。
    let (fw, fh) = safe_fit(tw, th);
    let raster = decode_tall_jpeg_raster(raw, tw, tall_want_h(sw, sh, tw))?;
    // 缩放解码的结果可能比目标略大（档位 1/2^k），精确缩到位。
    let rgb = if raster.width() == fw && raster.height() == fh {
        raster
    } else {
        image::imageops::resize(&raster, fw, fh, image::imageops::FilterType::Triangle)
    };
    finish_render(rgb, sw, sh)
}

/// 长图请求给 IDCT 解码器的高度（u16 上限内的源都成立）。
fn tall_want_h(sw: u32, sh: u32, tw: u32) -> u32 {
    if sw == 0 {
        return sh;
    }
    ((sh as u64 * tw as u64) / sw as u64)
        .clamp(1, u16::MAX as u64) as u32
}

/// 长图 JPEG 解码（不下线编码）：返回 IDCT 缩放解码后的栅格。
///
/// **不做**最终整图缩放——那是"先切后缩"要避免的整图副本；条漫路径改为
/// 按带逐段缩放，单页路径才做一次精确整图缩放。
fn decode_tall_jpeg_raster(
    raw: &RawPage,
    req_w: u32,
    req_h: u32,
) -> Result<image::RgbImage, BackendError> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(&raw.bytes));
    decoder.read_info()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    // jpeg-decoder 的 scale 目标：按目标宽求比例的高（u16 上限内的源都成立）。
    let want_w = req_w.clamp(1, u16::MAX as u32) as u16;
    let want_h = req_h.clamp(1, u16::MAX as u32) as u16;
    decoder
        .scale(want_w, want_h)
        .map_err(|e| BackendError::Decode(format!("长图缩放不可用：{e}")))?;
    let pixels = decoder
        .decode()
        .map_err(|e| BackendError::Decode(format!("长图解码失败：{e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| BackendError::Decode("缺少 JPEG 信息".into()))?;

    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => image::RgbImage::from_raw(
            info.width as u32,
            info.height as u32,
            pixels,
        )
        .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into())),
        jpeg_decoder::PixelFormat::L8 => {
            let gray = image::GrayImage::from_raw(info.width as u32, info.height as u32, pixels)
                .ok_or_else(|| BackendError::Decode("长图像素缓冲不匹配".into()))?;
            Ok(image::RgbImage::from_fn(gray.width(), gray.height(), |x, y| {
                let g = gray.get_pixel(x, y)[0];
                image::Rgb([g, g, g])
            }))
        }
        _ => {
            // CMYK 等罕见格式退回常规解码（长图 CMYK 极罕见；牺牲一次全分辨率）。
            let img =
                image::load_from_memory_with_format(&raw.bytes, ImageFormat::Jpeg).map_err(ImageError::from)?;
            Ok(into_rgb(img))
        }
    }
}

/// 统一收尾：纹理安全兜底 + JPEG 编码 + dataURL。
fn finish_render(rgb: image::RgbImage, sw: u32, sh: u32) -> Result<RenderedPage, BackendError> {
    let rgb = clamp_texture_safe(rgb)?;
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

/// 条漫切片几何计划（显示坐标系 = 设备像素）。
///
/// 边界按 `round(j * disp_h / n)` 均分，与前端 `Webtoon.tsx` 的
/// `tileTopAt/tileHeightAt`（同样的均分取整）一致 → 前后端切片几何不漂移。
struct TilePlan {
    /// 长度 = 片数 + 1；`bounds[j]..bounds[j+1]` 是第 j 片的显示行区间。
    bounds: Vec<u32>,
}

impl TilePlan {
    fn build(disp_h: u32, tiles: u32) -> TilePlan {
        let n = tiles.max(1) as u64;
        let mut bounds: Vec<u32> = (0..=tiles)
            .map(|j| mul_round(j as u64, disp_h as u64, n) as u32)
            .collect();
        let last = bounds.len() - 1;
        bounds[0] = 0;
        bounds[last] = disp_h;
        // 单调性兜底（正常输入下取整已保证单调且每片 ≥1 行）。
        for j in 1..bounds.len() {
            if bounds[j] < bounds[j - 1] {
                bounds[j] = bounds[j - 1];
            }
        }
        for j in (0..bounds.len() - 1).rev() {
            if bounds[j] > bounds[j + 1] {
                bounds[j] = bounds[j + 1];
            }
        }
        TilePlan { bounds }
    }
}

/// 把 `total` 均分成 `n` 份（每份 ≥1，和恰为 `total`）。
fn split_even(total: u32, n: usize) -> Vec<u32> {
    let n = n.max(1);
    let base = total / n as u32;
    let mut rem = total % n as u32;
    let mut parts = vec![base; n];
    for p in parts.iter_mut() {
        if rem > 0 {
            *p += 1;
            rem -= 1;
        }
    }
    parts
}

/// 条漫整页 → 全部切片（**先切后缩**：按源图切带 → 逐带缩放 → 输出连续切片）。
///
/// 内存要点（用户报"巨图显存/内存爆掉"的根因修复）：
/// - 解码一次拿到工作栅格（长图 JPEG 走 IDCT 缩放解码，全分辨率栅格不进内存）；
/// - **不再**额外做"整图缩放"（那会同时持有原图 + 同尺寸缩放副本，1600×65000 ≈ 300MB）；
///   改为按源图纵向切带（每带 ≤ `MAX_SLICE_H` 行）逐带缩放，缩完立刻释放；
///   注意：工作栅格本身仍是「显示宽 × 显示高」的一份，非 JPEG 格式还需整图解码一次；
/// - 每片高度 ≤ `WEBTOON_TILE_H`（≤ `MAX_SLICE_H`），切片高度之和 == 显示高度；
/// - 切片几何与 `webtoon_tile_count`（前端同公式）严格一致，边界无缝；
/// - **逻辑页 identity 不变**：每个 `RenderedPage.orig_width/orig_height` 都是
///   该逻辑页的**源图原始尺寸** `(sw, sh)`（不是单片自己的 `width/height`，
///   也不是降采样后的显示尺寸）。这样 L1（刚渲染）与 L2（磁盘命中）对
///   `get_webtoon_layout` 的源尺寸口径完全一致。调用方（`get_webtoon_tile`）
///   只按 `(index, tile)` 取片，页码语义始终由 `index` 保持。
pub fn render_webtoon_tiles(
    raw: &RawPage,
    max_w: u32,
) -> Result<(u32, Vec<RenderedPage>), BackendError> {
    let fmt = decoded_format(raw)?;
    let (sw, sh) = source_dimensions(raw)?;
    if max_w == 0 {
        return Err(BackendError::Msg("条漫渲染宽度必须大于 0".into()));
    }

    // 显示几何：目标宽 = min(源宽, 请求宽)（不放大），显示高等比。
    let (tw, th) = fit_size(sw, sh, Some(max_w), None);
    if tw == 0 || th == 0 {
        return Err(BackendError::Decode(format!("条漫显示尺寸非法（{tw}×{th}）")));
    }
    // 片数与前端 `webtoon_tile_count` 公式一致（前端 Webtoon.tsx 同公式）。
    // 上限再收一道：每片至少 1 显示行（极端比例下不会产生 0 高切片）。
    let tiles = webtoon_tile_count(sw, sh, max_w).min(th.max(1));
    let plan = TilePlan::build(th, tiles);

    // 工作栅格（只解码一次）：长图 JPEG 走 IDCT 缩放解码；其余格式整图解码。
    let work: image::RgbImage = if sh > TALL_IMAGE_H && fmt == ImageFormat::Jpeg {
        decode_tall_jpeg_raster(raw, tw, tall_want_h(sw, sh, tw))?
    } else {
        let img = image::load_from_memory_with_format(&raw.bytes, fmt).map_err(ImageError::from)?;
        into_rgb(img)
    };
    let rh = work.height();

    let mut out: Vec<RenderedPage> = Vec::with_capacity(tiles as usize);
    for j in 0..tiles as usize {
        let d0 = plan.bounds[j];
        let d1 = plan.bounds[j + 1];
        let disp_h = d1 - d0;
        // 显示行 → 工作栅格行（工作栅格可能是 1/2^k 的 IDCT 缩放结果）。
        let w0 = work_row_at(d0, rh, th);
        let w1 = work_row_at(d1, rh, th);
        let tile = render_band_tile(&work, w0, w1, tw, disp_h)?;

        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
            enc.encode_image(&tile)?;
        }
        out.push(RenderedPage {
            width: tw,
            height: disp_h,
            // 逻辑页源尺寸：与 get_webtoon_layout 同口径，L1/L2 一致。
            orig_width: sw,
            orig_height: sh,
            mime: "image/jpeg".to_string(),
            data_url: format!("data:image/jpeg;base64,{}", B64.encode(&buf)),
            bytes: buf,
        });
    }
    Ok((tiles, out))
}

/// 显示行 → 工作栅格行（等比映射 + 取整 + 边界收敛）。
fn work_row_at(disp_row: u32, work_h: u32, disp_h: u32) -> u32 {
    if work_h == 0 || disp_h == 0 {
        return 0;
    }
    (mul_round(disp_row as u64, work_h as u64, disp_h as u64) as u32).min(work_h)
}

/// 把工作栅格的行区间 `[w0, w1)` 缩放成 `(tw, disp_h)` 的一张切片。
///
/// 内存友好：源行区间超过 `MAX_SLICE_H` 时切成多条源带，**逐带缩放后立刻拼进
/// 切片缓冲**——任意时刻只多活「一条源带（≤ MAX_SLICE_H 行）+ 一张切片栅格」，
/// 不会同时持有「原图 + 整图缩放副本 + 全部切片栅格」。
fn render_band_tile(
    work: &image::RgbImage,
    w0: u32,
    w1: u32,
    tw: u32,
    disp_h: u32,
) -> Result<image::RgbImage, BackendError> {
    let rh = work.height();
    let ww = work.width();
    let w0 = w0.min(rh);
    let w1 = w1.min(rh).max(w0);
    let src_h = w1 - w0;
    if tw == 0 || disp_h == 0 {
        return Err(BackendError::Decode("切片尺寸非法".into()));
    }
    if src_h == 0 {
        // 极端比例下源行缺失：用相邻单行拉伸兜底（绝不 panic）。
        let row = w0.min(rh.saturating_sub(1));
        let crop = image::imageops::crop_imm(work, 0, row, ww, 1).to_image();
        return Ok(image::imageops::resize(
            &crop,
            tw,
            disp_h,
            image::imageops::FilterType::Triangle,
        ));
    }
    if src_h <= MAX_SLICE_H {
        // 单带：裁出这一条源带后直接缩放（不产生整图副本）。
        let crop = image::imageops::crop_imm(work, 0, w0, ww, src_h).to_image();
        return Ok(image::imageops::resize(
            &crop,
            tw,
            disp_h,
            image::imageops::FilterType::Triangle,
        ));
    }

    // 多带：显示高与源行都按份切开，逐带缩放后拼进切片缓冲。
    // 正常情况下 n = ceil(src_h / MAX_SLICE_H)；极端比例（显示高远小于源行数）
    // 下 n 受显示高所限，带高可能超过 MAX_SLICE_H——宁可如此也不产生 0 高切片。
    let mut n = ((src_h as u64 + MAX_SLICE_H as u64 - 1) / MAX_SLICE_H as u64) as usize;
    n = n.min(disp_h as usize).min(src_h as usize).max(1);
    let disp_parts = split_even(disp_h, n);
    let src_parts = split_even(src_h, n);

    let mut out = image::RgbImage::new(tw, disp_h);
    let mut dy = 0u32;
    let mut sy = w0;
    for c in 0..n {
        let crop = image::imageops::crop_imm(work, 0, sy, ww, src_parts[c]).to_image();
        let scaled = image::imageops::resize(
            &crop,
            tw,
            disp_parts[c],
            image::imageops::FilterType::Triangle,
        );
        image::imageops::replace(&mut out, &scaled, 0, dy as i64);
        dy += disp_parts[c];
        sy += src_parts[c];
    }
    Ok(out)
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

    /* ---------------- 超高分辨率条漫（>20000px）防线 ---------------- */

    /// 内存构造超高条漫测试图（不落盘）：纵向平滑渐变，便于校验切片落位。
    fn ultra_tall_page(w: u32, h: u32) -> RawPage {
        use image::ImageEncoder as _;
        let mut img = image::RgbImage::new(w, h);
        for (_x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([((y as u64 * 255) / h as u64) as u8, 128, 64]);
        }
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut buf,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
        RawPage {
            bytes: buf,
            ext: "png".into(),
        }
    }

    /// 渐变参考值（与 `ultra_tall_page` 的配色一致）。
    fn ramp(y: u32, h: u32) -> u8 {
        ((y as u64 * 255) / h as u64) as u8
    }

    /// 内存构造超高条漫 JPEG（走长图 IDCT 缩放解码路径）。
    fn ultra_tall_jpeg(w: u32, h: u32) -> RawPage {
        let mut img = image::RgbImage::new(w, h);
        for (_x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([((y as u64 * 255) / h as u64) as u8, 128, 64]);
        }
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85)
            .encode_image(&img)
            .unwrap();
        RawPage {
            bytes: buf,
            ext: "jpg".into(),
        }
    }

    /// 长图 JPEG：切片几何必须与前端公式一致，且不 panic。
    #[test]
    fn webtoon_tiles_handle_ultra_tall_jpeg() {
        let (w, h) = (320u32, 20000u32);
        let raw = ultra_tall_jpeg(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        assert_eq!(tiles, webtoon_tile_count(w, h, w));
        assert!(pages.iter().all(|p| p.height <= WEBTOON_TILE_H));
        assert!(pages.iter().all(|p| p.width == w));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, fit_size(w, h, Some(w), None).1);
    }

    /// 长图 JPEG 单页：缩放后仍超纹理上限时必须等比再缩（IDCT 路径 + 兜底）。
    #[test]
    fn render_raw_clamps_ultra_tall_jpeg() {
        let (w, h) = (320u32, 20000u32);
        let raw = ultra_tall_jpeg(w, h);
        for max_w in [None, Some(w)] {
            let page = render_raw(&raw, max_w, None).unwrap();
            assert!(
                page.height <= MAX_SAFE_TEXTURE_H,
                "长图 JPEG 输出高度 {} 超限",
                page.height
            );
            assert_eq!(page.orig_width, w);
            assert_eq!(page.orig_height, h);
            let expect = w as f64 / h as f64;
            let got = page.width as f64 / page.height as f64;
            assert!((got - expect).abs() / expect < 0.02, "宽高比失真：{got} vs {expect}");
        }
    }

    /// 400×24000 巨图：切片数/片高/无缝覆盖必须与前端公式一致。
    #[test]
    fn webtoon_tiles_handle_ultra_tall_page() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();

        let expect = webtoon_tile_count(w, h, w);
        assert_eq!(tiles, expect, "片数必须与 webtoon_tile_count（前端同公式）一致");
        assert_eq!(expect, 12, "24000 / 2048 → 12 片");
        assert_eq!(pages.len() as u32, tiles);

        // 每片高度 ≤ WEBTOON_TILE_H（也因此 ≤ MAX_SLICE_H）
        assert!(
            pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
            "单片高度不得超过 {WEBTOON_TILE_H}"
        );
        assert!(pages.iter().all(|p| p.height <= MAX_SLICE_H));

        // 切片高度之和 == 显示高度（无缝覆盖，不丢像素）
        let total: u32 = pages.iter().map(|p| p.height).sum();
        let disp_h = fit_size(w, h, Some(w), None).1;
        assert_eq!(disp_h, h);
        assert_eq!(total, disp_h, "切片高度之和必须等于显示高度");
        assert!(pages.iter().all(|p| p.width == w));
        assert!(pages
            .iter()
            .all(|p| p.data_url.starts_with("data:image/jpeg;base64,")));
    }

    /// 切片必须首尾相接、顺序正确：逐片解码回来比对首尾行与源图渐变。
    #[test]
    fn webtoon_tiles_are_contiguous_and_in_order() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        let disp_h = fit_size(w, h, Some(w), None).1 as u64;
        let n = tiles as u64;

        let mut covered = 0u32;
        for (j, p) in pages.iter().enumerate() {
            // 与前端 tileTopAt 同公式：round(j * dispH / tiles)
            let b0 = ((j as u64 * disp_h + n / 2) / n) as u32;
            let b1 = (((j + 1) as u64 * disp_h + n / 2) / n) as u32;
            assert_eq!(p.height, b1 - b0, "第 {j} 片高度必须与切片几何一致");
            covered += p.height;

            let img = image::load_from_memory_with_format(&p.bytes, ImageFormat::Jpeg)
                .unwrap()
                .to_rgb8();
            assert_eq!(img.width(), w);
            assert_eq!(img.height(), p.height);
            let first = img.get_pixel(0, 0)[0] as i32;
            let last = img.get_pixel(0, img.height() - 1)[0] as i32;
            assert!(
                (first - ramp(b0, h) as i32).abs() <= 12,
                "第 {j} 片首行应落在源行 {b0}（实际 {first}）"
            );
            assert!(
                (last - ramp(b1 - 1, h) as i32).abs() <= 12,
                "第 {j} 片末行应落在源行 {}（实际 {last}）",
                b1 - 1
            );
        }
        assert_eq!(covered, disp_h as u32, "所有切片必须无缝覆盖整高");
    }

    /// 缩放路径（先切后缩）：缩到 1/4 宽时单片源行 > MAX_SLICE_H，
    /// 强制走"逐带缩放"，几何与覆盖仍必须正确。
    #[test]
    fn webtoon_tiles_scale_band_by_band() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let render_w = 100u32;
        let (tiles, pages) = render_webtoon_tiles(&raw, render_w).unwrap();
        let disp_h = fit_size(w, h, Some(render_w), None).1;
        assert_eq!(disp_h, 6000);
        assert_eq!(tiles, webtoon_tile_count(w, h, render_w));
        assert!(pages.iter().all(|p| p.height <= WEBTOON_TILE_H));
        assert!(pages.iter().all(|p| p.width == render_w));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, disp_h, "缩放后切片仍必须无缝覆盖整高");
    }

    /* ---------------- 逻辑页 P 与物理切片解耦（页/片语义） ---------------- */

    /// 800×21000 超长 PNG：片数 > 1、单片 ≤ WEBTOON_TILE_H、片高之和 == 显示总高；
    /// 且每个 `RenderedPage.orig_height` 都是**整页**显示总高（不是单片高度），
    /// 保证上层仍能按「一页一条目」保持逻辑页语义。
    #[test]
    fn webtoon_tiles_800x21000_keep_logical_page_identity() {
        let (w, h) = (800u32, 21000u32);
        let raw = ultra_tall_page(w, h);
        let (tiles, pages) = render_webtoon_tiles(&raw, w).unwrap();
        let disp_h = fit_size(w, h, Some(w), None).1;

        assert_eq!(disp_h, h, "源宽 = 渲染宽时应等比保持源高");
        assert_eq!(tiles, webtoon_tile_count(w, h, w));
        assert_eq!(tiles, 11, "ceil(21000 / 2048) = 11 片");
        assert!(tiles > 1, "超长图必须切多片，不能整图直送 <img>");
        assert_eq!(pages.len() as u32, tiles);

        // 每片 ≤ 2048（也 ≤ MAX_SLICE_H）；片高之和 == 21000（无缝、无重叠）。
        assert!(
            pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
            "单片高度不得超过 {WEBTOON_TILE_H}"
        );
        assert!(pages.iter().all(|p| p.height < h));
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, disp_h, "所有切片高度之和必须等于显示总高");

        // 逻辑页 identity：每片都上报整页源尺寸，而不是自己的片高/显示尺寸。
        for (j, p) in pages.iter().enumerate() {
            assert_eq!(
                p.orig_height, h,
                "第 {j} 片的 orig_height 必须是整页源高（不是单片高度/显示高）"
            );
            assert_eq!(p.orig_width, w);
            assert_eq!(p.width, w);
            assert_ne!(p.orig_height, p.height);
        }
    }

    /// 片数公式与实际物化片数在三种宽高关系下必须一致（±1 片都不允许）：
    /// 源宽 > 请求宽（缩放）、源宽 < 请求宽（后端不放大）、极端长宽比。
    #[test]
    fn webtoon_tile_count_matches_rendered_tiles() {
        let cases = [
            (800u32, 9000u32, 400u32, "源宽 > 请求宽"),
            (400u32, 10000u32, 800u32, "源宽 < 请求宽（不放大）"),
            (60u32, 6000u32, 320u32, "极端竖长条 100:1"),
            (6000u32, 120u32, 320u32, "极端横长条 50:1"),
            // 2048 整数倍边界：928 × 448 / 7 = 59392 = 2048 × 29。
            // 前端若先算 ratio 再乘 W，浮点会得到 59392.00000000001 → 30 片，
            // 而去请求第 30 片（后端只物化 29 片）会直接越界报错。
            (7u32, 928u32, 448u32, "2048 整数倍边界"),
        ];
        for (sw, sh, rw, why) in cases {
            let raw = ultra_tall_page(sw, sh);
            let (tiles, pages) = render_webtoon_tiles(&raw, rw).unwrap();
            let expect = webtoon_tile_count(sw, sh, rw);
            let (tw, display_h) = fit_size(sw, sh, Some(rw), None);

            assert_eq!(tiles, expect, "{why}：{sw}×{sh}@{rw} 片数与公式漂移");
            assert_eq!(pages.len() as u32, tiles);
            assert!(
                tiles <= display_h.max(1),
                "{why}：片数不得超过显示行数（每片至少 1 行）"
            );

            let total: u32 = pages.iter().map(|p| p.height).sum();
            assert_eq!(total, display_h, "{why}：切片高度之和必须等于显示总高");
            assert!(
                pages.iter().all(|p| p.height <= WEBTOON_TILE_H),
                "{why}：单片高度超过 {WEBTOON_TILE_H}"
            );
            assert!(pages.iter().all(|p| p.width == tw));
            assert!(
                pages.iter().all(|p| p.orig_width == sw && p.orig_height == sh),
                "{why}：orig_* 必须保持逻辑页源尺寸（L1/L2 同口径）"
            );
        }
    }

    /// 计数公式的零值 / ceil 边界兜底，以及「极端 1px 宽」时按显示高收敛：
    /// `webtoon_tile_count` 可能大于显示行数，`render_webtoon_tiles` 用
    /// `.min(display_h)` 保证每片 ≥1 显示行；前端 `webtoonTileCount` 镜像同一顺序。
    #[test]
    fn webtoon_tile_count_guards_and_extreme_narrow() {
        // 宽/高/渲染宽任一为 0 → 1（与前端 0 宽兜底一致）。
        assert_eq!(webtoon_tile_count(0, 100, 800), 1);
        assert_eq!(webtoon_tile_count(100, 0, 800), 1);
        assert_eq!(webtoon_tile_count(100, 100, 0), 1);
        // ceil 边界：正好一片 / 多一行即两片。
        assert_eq!(webtoon_tile_count(100, 2048, 100), 1);
        assert_eq!(webtoon_tile_count(100, 2049, 100), 2);
        // 源宽 < 请求宽：仍按请求宽估高（两端同公式），后端渲染不放大。
        assert_eq!(webtoon_tile_count(400, 10000, 800), 10);
        // 2048 整数倍边界（928 × 448 / 7 = 59392 = 2048 × 29）：必须恰好 29 片。
        assert_eq!(webtoon_tile_count(7, 928, 448), 29);

        // 1px 宽 + 2160 渲染宽：ceil(300 * 2160 / 2048) = 317 > 显示高 300。
        let raw = ultra_tall_page(1, 300);
        assert_eq!(webtoon_tile_count(1, 300, 2160), 317);
        let (tiles, pages) = render_webtoon_tiles(&raw, 2160).unwrap();
        assert_eq!(tiles, 300, "实际片数受显示高兜底，每片 ≥1 行");
        assert_eq!(pages.len() as u32, 300);
        let total: u32 = pages.iter().map(|p| p.height).sum();
        assert_eq!(total, 300);
        assert!(pages.iter().all(|p| p.height == 1));
        assert!(pages.iter().all(|p| p.orig_height == 300));
    }

    /// 单页模式兜底：巨图渲染结果高度不得超过 MAX_SAFE_TEXTURE_H，且比例正确。
    #[test]
    fn render_raw_clamps_ultra_tall_to_safe_texture() {
        let (w, h) = (400u32, 24000u32);
        let raw = ultra_tall_page(w, h);
        let page = render_raw(&raw, None, None).unwrap();
        assert!(
            page.height <= MAX_SAFE_TEXTURE_H,
            "单页输出高度 {} 超过纹理安全上限 {MAX_SAFE_TEXTURE_H}",
            page.height
        );
        assert!(page.width > 0);
        // 原始尺寸仍要如实上报（条漫布局/比例用）
        assert_eq!(page.orig_width, w);
        assert_eq!(page.orig_height, h);
        // 宽高比与原图一致（等比再缩放）
        let expect = w as f64 / h as f64;
        let got = page.width as f64 / page.height as f64;
        assert!(
            (got - expect).abs() / expect < 0.01,
            "宽高比失真：{got} vs {expect}"
        );
        assert!(page.data_url.starts_with("data:image/jpeg;base64,"));
    }

    /// 极端/畸形输入必须返回可读错误，不得 panic。
    #[test]
    fn pipeline_rejects_invalid_input_without_panic() {
        // 非图片字节
        let bad = RawPage {
            bytes: b"definitely not an image".to_vec(),
            ext: "png".into(),
        };
        assert!(render_raw(&bad, Some(800), Some(800)).is_err());
        assert!(render_webtoon_tiles(&bad, 800).is_err());
        // 渲染宽度非法
        let raw = ultra_tall_page(16, 32);
        assert!(render_webtoon_tiles(&raw, 0).is_err());
        // 空字节
        let empty = RawPage {
            bytes: Vec::new(),
            ext: "png".into(),
        };
        assert!(render_raw(&empty, Some(800), Some(800)).is_err());
        assert!(render_webtoon_tiles(&empty, 800).is_err());
    }
}
