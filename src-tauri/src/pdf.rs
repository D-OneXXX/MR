//! PDF 文件级支持（PDF-2）：源校验 + 字节分块读取。
//!
//! 职责边界（刻意保持窄，避免把后端变成 PDF 解析器）：
//! - 后端**不解析 PDF 结构、不渲染页面**：页面渲染由前端 PDF.js 完成，
//!   后端只提供受控的字节分块通道（`get_pdf_chunk`）；
//! - **不引入任何第三方 PDF 依赖**：避免原生依赖、体积膨胀与供应链风险；
//! - 读取只允许「已入库的本地 PDF 书源」，路径必须通过本地书源安全策略
//!   （`commands::is_safe_library_source_path`），书库之外的 PDF 一律拒绝；
//! - 所有错误文案都带稳定 kebab-case 错误码，前端据此做六语本地化
//!   （`src/features/errors/localize.ts`）。
//!
//! 稳定错误码：
//! - `pdf-not-found`：文件不存在；
//! - `pdf-not-valid`：不是普通文件 / 扩展名不是 `.pdf` / 路径含 `..` / 文件头不是 `%PDF-`；
//! - `pdf-too-large`：文件超过 [`MAX_PDF_FILE_BYTES`]；
//! - `pdf-cover-invalid`：封面字节非法（非 JPEG/PNG、头部损坏、空字节）；
//! - `pdf-cover-too-large`：封面字节数超过 [`MAX_PDF_COVER_BYTES`]（2 MiB）；
//! - `pdf-cover-dimensions`：封面**尺寸**越界（单边 > [`MAX_PDF_COVER_EDGE`]，
//!   或面积 > [`MAX_PDF_COVER_PIXELS`]）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};

use crate::source::{is_pdf_path, validate_pdf_document, BackendError};

/// 单次 IPC 分块上限（4 MiB）：前端请求超出部分由后端静默钳制。
pub const MAX_PDF_CHUNK_BYTES: u32 = 4 * 1024 * 1024;

/// 本地 PDF 体积上限（512 MiB）：超限一律拒绝，避免把超大文件喂给前端。
pub const MAX_PDF_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// PDF 页数上限（写库用）：1 000 000 页，远超任何真实文档。
pub const MAX_PDF_PAGE_COUNT: u32 = 1_000_000;

/// PDF 封面在 L2 渲染缓存里的**固定**边长（像素）。
///
/// 必须固定：`get_thumbnail` 会被前端用不同的 `max_size`（240 / 256）调用，
/// 封面若按请求尺寸分桶存储就会互相找不到。写入与读取共用这一个常量。
pub const PDF_COVER_EDGE: u32 = 256;

/// PDF 封面字节上限（2 MiB）：封面由前端渲染后回传，必须有界。
pub const MAX_PDF_COVER_BYTES: usize = 2 * 1024 * 1024;

/// PDF 封面**单边**上限（像素）。
///
/// 与 AGENTS.md §4.5 的画布边界一致：封面最终会被 base64 后送进前端 `<img>`，
/// 一张 30000×30000 的压缩 PNG 只有几十 KB，却会在**每次**读缩略图时被
/// 完整送一遍，既拖垮 IPC 又可能撑爆 WebView 纹理。
/// 写入与读取两侧都必须过这道边界。
pub const MAX_PDF_COVER_EDGE: u32 = 4096;

/// PDF 封面**像素面积**上限（16 Mpx）。
pub const MAX_PDF_COVER_PIXELS: u64 = 16_000_000;

/// JPEG 魔数（前三字节 `FF D8 FF`）。
pub const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF];
/// PNG 魔数（完整 8 字节签名）。
pub const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// 字节是否是 JPEG。
pub fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(JPEG_MAGIC)
}

/// 字节是否是 PNG。
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_MAGIC)
}

/// 路径是否含 `..` 片段（字面量路径穿越）。
///
/// 目录型书源允许 `..`（用户可能真的扫描了 `C:\Books\..\Books`），
/// 但 **PDF 是单文件书源**：路径里的 `..` 没有任何合理用途，
/// 一律拒绝，绝不「规范化之后再放行」。
pub fn has_parent_dir_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

/// 校验本地 PDF 源并返回文件字节数。
///
/// 依次检查：
/// 1. 路径不得含 `..` 片段（字面量穿越直接拒绝）；
/// 2. 文件必须存在（`pdf-not-found`）；
/// 3. 必须是普通文件（目录不是 PDF 文档，`pdf-not-valid`）；
/// 4. 扩展名必须是 `.pdf`（大小写不敏感，`pdf-not-valid`）；
/// 5. 体积不得超过 [`MAX_PDF_FILE_BYTES`]（`pdf-too-large`）；
/// 6. 文件头必须是 `%PDF-`（复用 PDF-1 的 `validate_pdf_document`，不重复实现魔数）。
pub fn validate_pdf_source(path: &Path) -> Result<u64, BackendError> {
    if has_parent_dir_component(path) {
        return Err(BackendError::Msg("PDF 路径无效（pdf-not-valid）".into()));
    }
    if !path.exists() {
        return Err(BackendError::Msg("PDF 文件不存在（pdf-not-found）".into()));
    }
    if !path.is_file() {
        return Err(BackendError::Msg(
            "PDF 路径不是普通文件（pdf-not-valid）".into(),
        ));
    }
    if !is_pdf_path(path) {
        return Err(BackendError::Msg(
            "PDF 路径不是 .pdf 文件（pdf-not-valid）".into(),
        ));
    }
    let size = std::fs::metadata(path)
        .map(|meta| meta.len())
        .map_err(|e| BackendError::Io(e.to_string()))?;
    // 体积上限先于魔数校验：超大文件不必再读文件头。
    if size > MAX_PDF_FILE_BYTES {
        return Err(BackendError::Msg(
            "PDF 文件超过体积上限 512 MiB（pdf-too-large）".into(),
        ));
    }
    // 文件头魔数：复用 PDF-1 的校验，错误码同为 `pdf-not-valid`。
    validate_pdf_document(path)?;
    Ok(size)
}

/// 读取 `[offset, offset + length)` 区间的原始字节。
///
/// 返回 `(文件总字节数, 本次读到的字节)`：
/// - `length` 钳制到 [`MAX_PDF_CHUNK_BYTES`]（4 MiB）；
/// - `offset` 越界（≥ 总长）→ 返回空字节（前端视为 EOF），**不是错误**；
/// - 读取永远不越过文件末尾。
pub fn read_pdf_chunk(
    path: &Path,
    offset: u64,
    length: u32,
) -> Result<(u64, Vec<u8>), BackendError> {
    let total = validate_pdf_source(path)?;
    let want = (length as u64).min(MAX_PDF_CHUNK_BYTES as u64);
    if want == 0 || offset >= total {
        return Ok((total, Vec::new()));
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    // take 上界 = min(请求长度, 剩余字节)：绝不越过文件末尾。
    let cap = want.min(total - offset);
    file.take(cap).read_to_end(&mut buf)?;
    Ok((total, buf))
}

/// 校验「PDF 页数」写入：仅 PDF 书、页数在 `1..=MAX_PDF_PAGE_COUNT`。
///
/// 纯函数（不碰数据库），命令层与单测共用同一份规则。
pub fn validate_pdf_page_count(format: &str, page_count: u32) -> Result<u32, BackendError> {
    if format != crate::db::BOOK_FORMAT_PDF {
        return Err(BackendError::Msg(
            "只有 PDF 书可以写入页数（pdf-not-pdf）".into(),
        ));
    }
    if page_count == 0 || page_count > MAX_PDF_PAGE_COUNT {
        return Err(BackendError::Msg(
            "PDF 页数超出允许范围（pdf-page-count-invalid）".into(),
        ));
    }
    Ok(page_count)
}

/// PNG 尺寸（严格）：签名 + IHDR 长度 + IHDR 类型都要对得上。
///
/// PNG 布局：8 字节签名 + 4 字节长度(=13) + 4 字节 `"IHDR"` + 4 字节宽 + 4 字节高。
/// 只读 `bytes[16..24]` 是不够的：任何「首字节像 PNG」的垃圾字节都能伪造出
/// 一个 30000×30000 的尺寸，然后被原样 base64 送进前端。
pub fn png_dims(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    if bytes.len() < 24 || !is_png(bytes) {
        return Err(BackendError::Msg(
            "PDF 封面 PNG 头不完整（pdf-cover-invalid）".into(),
        ));
    }
    // IHDR 长度字段（bytes[8..12]，大端）必须是 13。
    let ihdr_len = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    if ihdr_len != 13 || &bytes[12..16] != b"IHDR" {
        return Err(BackendError::Msg(
            "PDF 封面 PNG 头不合法（pdf-cover-invalid）".into(),
        ));
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return Err(BackendError::Msg(
            "PDF 封面 PNG 尺寸非法（pdf-cover-invalid）".into(),
        ));
    }
    Ok((width, height))
}

/// JPEG 尺寸（严格）：沿段链扫描到 SOF0/SOF1/SOF2。
///
/// 段结构：`FF <marker> [len(2) payload...]`；SOF 段的 payload 是
/// `精度(1) | 高(2) | 宽(2) | 分量数(1) | ...`。
/// 只支持 SOF0（基线）/ SOF1（扩展顺序）/ SOF2（渐进）——前端
/// `canvas.toDataURL("image/jpeg")` 产出的正是基线 SOF0。
pub fn jpeg_dims(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    if bytes.len() < 4 || !is_jpeg(bytes) {
        return Err(BackendError::Msg(
            "PDF 封面 JPEG 头不完整（pdf-cover-invalid）".into(),
        ));
    }
    let mut i = 2usize; // 跳过 SOI(FFD8)
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1; // 填充字节
            continue;
        }
        // 无长度字段的独立标记。
        if marker == 0x01 || marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xD9 {
            break; // EOI：没有 SOF 就是坏图
        }
        if i + 3 >= bytes.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if seg_len < 2 {
            break;
        }
        if matches!(marker, 0xC0..=0xC2) {
            // SOF: marker(2) | len(2) | 精度(1) | 高(2) | 宽(2)
            if i + 9 > bytes.len() {
                break;
            }
            let height = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            if width == 0 || height == 0 {
                break;
            }
            return Ok((width, height));
        }
        if marker == 0xDA {
            break; // SOS：熵编码数据开始，后面不再有尺寸信息
        }
        i += 2 + seg_len;
    }
    Err(BackendError::Msg(
        "PDF 封面 JPEG 头不合法（pdf-cover-invalid）".into(),
    ))
}

/// 封面尺寸（按魔数分派）：JPEG 走 SOF 段，PNG 走 IHDR 块。
pub fn cover_dimensions(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    if is_jpeg(bytes) {
        jpeg_dims(bytes)
    } else if is_png(bytes) {
        png_dims(bytes)
    } else {
        Err(BackendError::Msg(
            "PDF 封面必须是 JPEG 或 PNG（pdf-cover-invalid）".into(),
        ))
    }
}

/// 封面**尺寸**边界：单边 ≤ [`MAX_PDF_COVER_EDGE`]、面积 ≤ [`MAX_PDF_COVER_PIXELS`]。
///
/// 与字节数上限（2 MiB）是两道互补的闸门：压缩比高的图字节数很小，
/// 只能靠尺寸边界拦住（AGENTS.md §4.5 的画布边界）。
pub fn validate_cover_dimensions(width: u32, height: u32) -> Result<(), BackendError> {
    if width == 0 || height == 0 {
        return Err(BackendError::Msg(
            "PDF 封面尺寸非法（pdf-cover-invalid）".into(),
        ));
    }
    if width > MAX_PDF_COVER_EDGE || height > MAX_PDF_COVER_EDGE {
        return Err(BackendError::Msg(
            "PDF 封面单边超过 4096px 上限（pdf-cover-dimensions）".into(),
        ));
    }
    if width as u64 * height as u64 > MAX_PDF_COVER_PIXELS {
        return Err(BackendError::Msg(
            "PDF 封面像素面积超过 16Mpx 上限（pdf-cover-dimensions）".into(),
        ));
    }
    Ok(())
}

/// 校验前端送来的 PDF 封面字节（**写入**路径）：必须是 JPEG，且字节数与尺寸都有界。
///
/// 纯函数（不碰缓存），命令层与单测共用同一份规则：
/// 绝不允许任意字节进入渲染缓存。
///
/// **为什么写回只收 JPEG**：L2 渲染缓存的文件名后缀是写死的 `.jpg`
/// （`render_cache::RenderCache::file_path`），而 `RenderCache::get` 只认 JPEG，
/// 落进来的 PNG 会被当成坏缓存**直接删掉**——等于静默丢掉封面。
/// 前端本来就只用 `canvas.toDataURL("image/jpeg", 0.9)` 生成封面，
/// 所以写回收紧成「只收 JPEG」是最小且安全的改法；
/// 读取路径仍容忍历史 PNG（见 [`validate_pdf_cover_read`]），不删已有条目。
pub fn validate_pdf_cover(bytes: &[u8]) -> Result<(), BackendError> {
    if bytes.is_empty() {
        return Err(BackendError::Msg(
            "PDF 封面为空（pdf-cover-invalid）".into(),
        ));
    }
    if bytes.len() > MAX_PDF_COVER_BYTES {
        return Err(BackendError::Msg(
            "PDF 封面超过体积上限 2 MiB（pdf-cover-too-large）".into(),
        ));
    }
    if !is_jpeg(bytes) {
        return Err(BackendError::Msg(
            "PDF 封面必须是 JPEG（pdf-cover-invalid）".into(),
        ));
    }
    let (width, height) = jpeg_dims(bytes)?;
    validate_cover_dimensions(width, height)?;
    Ok(())
}

/// 校验**已落盘**的 PDF 封面字节（**读取**路径）：返回尺寸。
///
/// 与写回路径的区别只有两点：
/// 1. 容忍历史 PNG 缓存（老版本可能写进来过），但仍要求头部可解析；
/// 2. 字节数与尺寸同样有界——读路径会把封面 base64 后送进前端，
///    一张超大图会被**反复**送出去。
pub fn validate_pdf_cover_read(bytes: &[u8]) -> Result<(u32, u32), BackendError> {
    if bytes.is_empty() {
        return Err(BackendError::Msg(
            "PDF 封面为空（pdf-cover-invalid）".into(),
        ));
    }
    if bytes.len() > MAX_PDF_COVER_BYTES {
        return Err(BackendError::Msg(
            "PDF 封面超过体积上限 2 MiB（pdf-cover-too-large）".into(),
        ));
    }
    let (width, height) = cover_dimensions(bytes)?;
    validate_cover_dimensions(width, height)?;
    Ok((width, height))
}

/// 封面字节**构造器**（仅测试用）：跨模块复用同一套 PNG/JPEG 头格式，
/// 避免 `commands.rs` 与 `pdf.rs` 各写一份、久而久之格式漂移。
#[cfg(test)]
pub(crate) mod fixtures {
    /// 最小 PNG 头（24 字节：签名 + IHDR 长度 + "IHDR" + 宽 + 高）。
    ///
    /// 只够 [`crate::pdf::png_dims`] 解析尺寸，不代表完整可解码 PNG。
    pub(crate) fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = super::PNG_MAGIC.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    /// 最小 JPEG 头：SOI + JFIF APP0 + SOF0（带真实宽高）。
    ///
    /// 只够 [`crate::pdf::jpeg_dims`] 解析尺寸，不代表完整可解码 JPEG。
    pub(crate) fn jpeg_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        // APP0(JFIF)：payload 14 字节 + 长度字段 2 字节 = 16。
        bytes.extend_from_slice(&[0xFF, 0xE0]);
        bytes.extend_from_slice(&16u16.to_be_bytes());
        bytes.extend_from_slice(b"JFIF\0");
        bytes.extend_from_slice(&[1, 1, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0]);
        // SOF0：marker(2) + len(2) + 精度(1) + 高(2) + 宽(2) + 分量(1) + 分量(3)。
        bytes.extend_from_slice(&[0xFF, 0xC0]);
        bytes.extend_from_slice(&11u16.to_be_bytes());
        bytes.push(8);
        bytes.extend_from_slice(&(height as u16).to_be_bytes());
        bytes.extend_from_slice(&(width as u16).to_be_bytes());
        bytes.push(1);
        bytes.extend_from_slice(&[1, 0x11, 0]);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        cover_dimensions, has_parent_dir_component, is_jpeg, jpeg_dims, png_dims, read_pdf_chunk,
        validate_cover_dimensions, validate_pdf_cover, validate_pdf_cover_read,
        validate_pdf_page_count, validate_pdf_source, MAX_PDF_CHUNK_BYTES, MAX_PDF_COVER_BYTES,
        MAX_PDF_COVER_EDGE, MAX_PDF_COVER_PIXELS, MAX_PDF_FILE_BYTES,
    };
    use crate::db::BOOK_FORMAT_PDF;

    /// 真实编码器产出的 2×2 JPEG（确保严格 SOF 解析器能吃下真图）。
    fn tiny_jpeg() -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut buf)
            .write_image(
                &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
                2,
                2,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        buf
    }

    /// 独立临时目录（进程号 + 纳秒），测试结束整目录删除。
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mr-pdf-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 写一个最小合法 PDF（`%PDF-` 文件头 + 填充字节）。
    fn write_pdf(path: &Path, size: usize) {
        let mut bytes = vec![b'x'; size];
        let head = b"%PDF-1.7\n";
        bytes[..head.len()].copy_from_slice(head);
        std::fs::write(path, bytes).expect("写入测试 PDF");
    }

    #[test]
    fn chunk_read_at_start_middle_and_past_eof() {
        let dir = temp_dir("chunk");
        let path = dir.join("book.pdf");
        let payload = b"%PDF-1.7\n0123456789";
        std::fs::write(&path, payload).unwrap();

        // offset 0 → 全量字节。
        let (total, bytes) = read_pdf_chunk(&path, 0, 1024).unwrap();
        assert_eq!(total, payload.len() as u64);
        assert_eq!(bytes, payload.to_vec());

        // 中段偏移 → 只返回剩余部分。
        let (total, bytes) = read_pdf_chunk(&path, 9, 1024).unwrap();
        assert_eq!(total, payload.len() as u64);
        assert_eq!(bytes, payload[9..].to_vec());

        // 越过 EOF → 空数据，但 total 仍是真实大小（前端据此判定 EOF）。
        let (total, bytes) = read_pdf_chunk(&path, payload.len() as u64 + 100, 1024).unwrap();
        assert_eq!(total, payload.len() as u64);
        assert!(bytes.is_empty(), "越界读取必须返回空数据而不是错误");

        // length = 0 → 空数据，total 仍正确。
        let (total, bytes) = read_pdf_chunk(&path, 0, 0).unwrap();
        assert_eq!(total, payload.len() as u64);
        assert!(bytes.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn chunk_length_is_clamped_to_four_mib() {
        let dir = temp_dir("clamp");
        let path = dir.join("big.pdf");
        // 5 MiB：足以观察到「请求 8 MiB 只拿到 4 MiB」。
        let size = 5 * 1024 * 1024;
        write_pdf(&path, size);

        let (total, bytes) = read_pdf_chunk(&path, 0, u32::MAX).unwrap();
        assert_eq!(total, size as u64);
        assert_eq!(
            bytes.len(),
            MAX_PDF_CHUNK_BYTES as usize,
            "超长请求必须被钳制到 4 MiB"
        );

        // 末尾之前的分块同样受钳制。
        let (total, bytes) = read_pdf_chunk(&path, 0, MAX_PDF_CHUNK_BYTES * 2).unwrap();
        assert_eq!(total, size as u64);
        assert_eq!(bytes.len(), MAX_PDF_CHUNK_BYTES as usize);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_file_is_rejected_with_pdf_too_large() {
        let dir = temp_dir("too-large");
        let path = dir.join("huge.pdf");
        // 稀疏文件：写入文件头后直接设置长度，不占用真实磁盘空间。
        std::fs::write(&path, b"%PDF-1.7\n").unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_PDF_FILE_BYTES + 1).unwrap();
        drop(file);

        let err = validate_pdf_source(&path).unwrap_err().to_string();
        assert!(err.contains("pdf-too-large"), "got: {err}");
        // 读取路径同样拒绝：超大文件不得分块喂给前端。
        let err = read_pdf_chunk(&path, 0, 1024).unwrap_err().to_string();
        assert!(err.contains("pdf-too-large"), "got: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_sources_are_rejected() {
        let dir = temp_dir("invalid");

        // 目录：不是普通文件。
        let folder = dir.join("folder.pdf");
        std::fs::create_dir_all(&folder).unwrap();
        let err = validate_pdf_source(&folder).unwrap_err().to_string();
        assert!(err.contains("pdf-not-valid"), "got: {err}");

        // 非 .pdf 扩展名。
        let other = dir.join("book.cbz");
        std::fs::write(&other, b"%PDF-1.7\n").unwrap();
        let err = validate_pdf_source(&other).unwrap_err().to_string();
        assert!(err.contains("pdf-not-valid"), "got: {err}");

        // 缺失文件。
        let missing = dir.join("missing.pdf");
        let err = validate_pdf_source(&missing).unwrap_err().to_string();
        assert!(err.contains("pdf-not-found"), "got: {err}");

        // 扩展名正确但文件头不是 %PDF-（伪装文件）。
        let fake = dir.join("fake.pdf");
        std::fs::write(&fake, b"PK\x03\x04rest").unwrap();
        let err = validate_pdf_source(&fake).unwrap_err().to_string();
        assert!(err.contains("pdf-not-valid"), "got: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn traversal_paths_are_rejected_and_never_escape() {
        let dir = temp_dir("traversal");
        // 目标存在且是合法 PDF，但路径里带 `..` → 一律拒绝。
        let outside = dir.join("outside.pdf");
        write_pdf(&outside, 32);
        let traversal = dir.join("nested").join("..").join("outside.pdf");
        assert!(has_parent_dir_component(&traversal));
        let err = validate_pdf_source(&traversal).unwrap_err().to_string();
        assert!(err.contains("pdf-not-valid"), "got: {err}");
        let err = read_pdf_chunk(&traversal, 0, 16).unwrap_err().to_string();
        assert!(err.contains("pdf-not-valid"), "got: {err}");

        // 越界到目录之外（`../../`）同样被识别。
        assert!(has_parent_dir_component(Path::new("a/../../b.pdf")));
        assert!(!has_parent_dir_component(Path::new("a/b.pdf")));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn page_count_validation_only_accepts_pdf_books_in_range() {
        assert_eq!(validate_pdf_page_count(BOOK_FORMAT_PDF, 1).unwrap(), 1);
        assert_eq!(
            validate_pdf_page_count(BOOK_FORMAT_PDF, super::MAX_PDF_PAGE_COUNT).unwrap(),
            super::MAX_PDF_PAGE_COUNT
        );
        // 非 PDF 书 → 拒绝。
        let err = validate_pdf_page_count(crate::db::BOOK_FORMAT_IMAGE, 10)
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-not-pdf"), "got: {err}");
        // 越界页数 → 拒绝。
        for count in [0, super::MAX_PDF_PAGE_COUNT + 1] {
            let err = validate_pdf_page_count(BOOK_FORMAT_PDF, count)
                .unwrap_err()
                .to_string();
            assert!(err.contains("pdf-page-count-invalid"), "got: {err}");
        }
    }

    /// 写回路径的封面契约：**只收 JPEG**，且字节数 / 尺寸都有界。
    ///
    /// 为什么 PNG 写不进来：L2 渲染缓存的文件名后缀固定是 `.jpg`
    /// （`render_cache::RenderCache::file_path`），而 `RenderCache::get` 只认 JPEG，
    /// 落进来的 PNG 会被当成坏缓存**直接删掉**——等于静默丢封面。
    /// 所以写回收紧成「只收 JPEG」；读取路径仍容忍历史 PNG（见
    /// `validate_pdf_cover_read` 的用例）。
    #[test]
    fn cover_bytes_must_be_jpeg_and_dimension_bounded() {
        // 合法 JPEG（真实编码器产物）→ 放行。
        let jpeg = tiny_jpeg();
        assert!(validate_pdf_cover(&jpeg).is_ok());
        assert!(is_jpeg(&jpeg));

        // PNG 一律不得写回（读取路径才容忍 PNG）。
        let png = super::fixtures::png_header(256, 256);
        let err = validate_pdf_cover(&png).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // 空字节。
        let err = validate_pdf_cover(&[]).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // 任意字节（既不是 JPEG 也不是 PNG）。
        let err = validate_pdf_cover(b"not-an-image-at-all")
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // 超限（2 MiB 上限）。
        let oversized = vec![0xFFu8; MAX_PDF_COVER_BYTES + 1];
        let err = validate_pdf_cover(&oversized).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-too-large"), "got: {err}");
    }

    /// 尺寸解析必须**严格**：PNG 的 IHDR 长度/类型、JPEG 的 SOF 段都要对得上。
    ///
    /// 旧实现只读 PNG 的 bytes[16..24]，任何「首字节像 PNG」的垃圾都能伪造尺寸。
    #[test]
    fn cover_dimension_parsers_are_strict() {
        // PNG：IHDR 长度必须是 13，块类型必须是 "IHDR"。
        assert_eq!(
            png_dims(&super::fixtures::png_header(640, 480)).unwrap(),
            (640, 480)
        );
        let mut bad_len = super::fixtures::png_header(640, 480);
        bad_len[8..12].copy_from_slice(&12u32.to_be_bytes());
        let err = png_dims(&bad_len).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
        let mut bad_type = super::fixtures::png_header(640, 480);
        bad_type[12..16].copy_from_slice(b"IDAT");
        let err = png_dims(&bad_type).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
        // 头部不完整。
        let err = png_dims(super::PNG_MAGIC).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");

        // JPEG：真实编码器产物与手工构造的 SOF0 都要能解出尺寸。
        assert_eq!(jpeg_dims(&tiny_jpeg()).unwrap(), (2, 2));
        assert_eq!(
            jpeg_dims(&super::fixtures::jpeg_header(300, 200)).unwrap(),
            (300, 200)
        );
        // 段链损坏 → 拒绝。
        let err = jpeg_dims(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02])
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
        // 不是图片 → 拒绝。
        let err = cover_dimensions(b"not-an-image-at-all")
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-invalid"), "got: {err}");
    }

    /// 尺寸边界：单边 ≤4096px、面积 ≤16Mpx（AGENTS.md §4.5 的画布边界）。
    ///
    /// 一张 30000×30000 的 PNG 只有几十 KB，字节数闸门拦不住，
    /// 必须靠尺寸边界挡住，否则会被反复 base64 送进前端。
    #[test]
    fn cover_dimensions_are_bounded_on_both_write_and_read_paths() {
        // 单边超限（30000×30000）。
        let huge_png = super::fixtures::png_header(30_000, 30_000);
        let err = validate_cover_dimensions(30_000, 30_000)
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");

        // 面积超限（单边合法，但面积 > 16Mpx）。
        let err = validate_cover_dimensions(4000, 4001)
            .unwrap_err()
            .to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");

        // 边界内：4000×4000 = 16_000_000，正好等于上限，放行。
        assert!(validate_cover_dimensions(4000, 4000).is_ok());
        assert!(validate_cover_dimensions(MAX_PDF_COVER_EDGE, 1).is_ok());
        assert_eq!(MAX_PDF_COVER_PIXELS, 16_000_000);

        // 写回路径：一张「声称 30000×30000」的 JPEG 必须被尺寸边界拦下。
        let huge_jpeg = super::fixtures::jpeg_header(30_000, 30_000);
        let err = validate_pdf_cover(&huge_jpeg).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");

        // 读取路径：历史 PNG 缓存同样要过尺寸边界（否则会被反复送进前端）。
        let err = validate_pdf_cover_read(&huge_png).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-dimensions"), "got: {err}");
        // 读取路径仍容忍合法 PNG（老版本可能写进来过）。
        assert_eq!(
            validate_pdf_cover_read(&super::fixtures::png_header(256, 256)).unwrap(),
            (256, 256)
        );
        // 读取路径对超大字节数同样有闸门。
        let oversized = vec![0xFFu8; MAX_PDF_COVER_BYTES + 1];
        let err = validate_pdf_cover_read(&oversized).unwrap_err().to_string();
        assert!(err.contains("pdf-cover-too-large"), "got: {err}");
    }
}
