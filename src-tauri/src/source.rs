//! 统一图片源：本地文件夹与 zip/cbz 同一接口（全新设计，与旧 Qt 工程无关）。
//!
//! 设计要点（流式 + 预算制）：
//! - 永远只读需要的单页字节，不做整包解压、不在内存保留整本；
//! - `FolderSource` 按文件名排序后随机读取单文件；
//! - `ZipSource` 每次按需打开归档、只读取命中的单个条目字节，读完即关。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use thiserror::Error;

use crate::online::http::HttpTransport;
use crate::online::{BlockingSemaphore, PageRef, PAGE_MAX_BYTES};

/// 后端统一错误（最终 `.to_string()` 后传给前端）。
#[derive(Debug, Error)]
pub enum BackendError {
    #[error("IO 错误：{0}")]
    Io(String),
    #[error("压缩包错误：{0}")]
    Zip(String),
    #[error("图片解码错误：{0}")]
    Decode(String),
    #[error("数据库错误：{0}")]
    Db(String),
    #[error("网络错误：{0}")]
    Network(String),
    #[error("{0}")]
    Msg(String),
}

impl From<std::io::Error> for BackendError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<zip::result::ZipError> for BackendError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Zip(e.to_string())
    }
}

impl From<image::ImageError> for BackendError {
    fn from(e: image::ImageError) -> Self {
        Self::Decode(e.to_string())
    }
}

impl From<rusqlite::Error> for BackendError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.to_string())
    }
}

/// 本项目可解码的图片扩展名（与 `image` crate 启用的特性对齐：jpeg/png/gif/webp）。
pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];

pub fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|ext| {
        lower.len() > ext.len() + 1
            && lower.ends_with(ext)
            && lower.as_bytes()[lower.len() - ext.len() - 1] == b'.'
    })
}

pub fn is_archive_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("zip") | Some("cbz")
    )
}

/// 单页原始字节 + 扩展名提示（供解码器选用）。
pub struct RawPage {
    pub bytes: Vec<u8>,
    pub ext: String,
}

/// 统一图片源接口：页数 / 页序 / 按需读单页。
pub trait ImageSource: Send + Sync {
    fn page_count(&self) -> Result<usize, BackendError>;
    fn entry_names(&self) -> Result<Vec<String>, BackendError>;
    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError>;
}

/// 本地文件夹源：首次扫描排序，后续按索引随机读文件。
pub struct FolderSource {
    files: Vec<PathBuf>,
}

impl FolderSource {
    pub fn open(dir: &Path) -> Result<Self, BackendError> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(|e| BackendError::Io(format!("读取目录失败 {}：{e}", dir.display())))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .map(is_image_name)
                        .unwrap_or(false)
            })
            .collect();
        files.sort();
        Ok(Self { files })
    }
}

impl ImageSource for FolderSource {
    fn page_count(&self) -> Result<usize, BackendError> {
        Ok(self.files.len())
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(self
            .files
            .iter()
            .map(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string()
            })
            .collect())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let path = self
            .files
            .get(index)
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
        let bytes = std::fs::read(path)?;
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        Ok(RawPage { bytes, ext })
    }
}

/// zip/cbz 源：无常驻句柄，每次按需打开归档、只读命中条目（流式、读完即关）。
pub struct ZipSource {
    path: PathBuf,
    /// 归档内图片条目名（按名排序，索引稳定）。
    names: Vec<String>,
}

impl ZipSource {
    pub fn open(path: &Path) -> Result<Self, BackendError> {
        let file = File::open(path)?;
        let archive = zip::ZipArchive::new(file)?;
        let mut names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.name_for_index(i).map(|s| s.to_string()))
            .filter(|n| !n.ends_with('/') && is_image_name(n))
            .collect();
        names.sort();
        Ok(Self {
            path: path.to_path_buf(),
            names,
        })
    }

    fn reopen(&self) -> Result<zip::ZipArchive<File>, BackendError> {
        Ok(zip::ZipArchive::new(File::open(&self.path)?)?)
    }
}

impl ImageSource for ZipSource {
    fn page_count(&self) -> Result<usize, BackendError> {
        Ok(self.names.len())
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(self.names.clone())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let name = self
            .names
            .get(index)
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
        let mut archive = self.reopen()?;
        let mut entry = archive.by_name(name)?;
        // 安全：拒绝 ZipSlip（虽然只读内存不落盘，仍做校验）。
        if entry.enclosed_name().is_none() {
            return Err(BackendError::Zip(format!("非法条目名：{name}")));
        }
        let mut bytes = Vec::with_capacity(entry.size().min(32 * 1024 * 1024) as usize);
        entry.read_to_end(&mut bytes)?;
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        Ok(RawPage { bytes, ext })
    }
}

/// 按路径自动选择源：目录 → 文件夹源；.zip/.cbz → 压缩包源。
pub enum AnySource {
    Folder(FolderSource),
    Zip(ZipSource),
}

pub fn open_source(path: &Path) -> Result<AnySource, BackendError> {
    if path.is_dir() {
        Ok(AnySource::Folder(FolderSource::open(path)?))
    } else if is_archive_path(path) {
        Ok(AnySource::Zip(ZipSource::open(path)?))
    } else {
        Err(BackendError::Msg(format!(
            "不支持的书籍路径（需要图片目录或 .zip/.cbz）：{}",
            path.display()
        )))
    }
}

impl ImageSource for AnySource {
    fn page_count(&self) -> Result<usize, BackendError> {
        match self {
            AnySource::Folder(s) => s.page_count(),
            AnySource::Zip(s) => s.page_count(),
        }
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        match self {
            AnySource::Folder(s) => s.entry_names(),
            AnySource::Zip(s) => s.entry_names(),
        }
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        match self {
            AnySource::Folder(s) => s.read_raw(index),
            AnySource::Zip(s) => s.read_raw(index),
        }
    }
}

/// 在线图片源：页列表来自 meta_json；read_raw 按需下载单页。
pub struct OnlineSource {
    pages: Vec<PageRef>,
    http: Arc<dyn HttpTransport>,
    permits: Arc<BlockingSemaphore>,
    /// 整本规范化 URL：作为单页请求的 Referer/Origin 来源（防盗链站点需要）。
    referer: String,
}

impl OnlineSource {
    pub fn new(
        pages: Vec<PageRef>,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
        referer: String,
    ) -> Self {
        Self {
            pages,
            http,
            permits: Arc::new(BlockingSemaphore::new(concurrency)),
            referer,
        }
    }
}

impl ImageSource for OnlineSource {
    fn page_count(&self) -> Result<usize, BackendError> {
        Ok(self.pages.len())
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(self
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| crate::online::page_name(p, i))
            .collect())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let page = self
            .pages
            .get(index)
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
        // 每本书独立的并发闸门：限制同时在途的页面下载数。
        let _guard = self.permits.acquire();
        let resp = self
            .http
            .get(&page.url, PAGE_MAX_BYTES, Some(&self.referer))
            .map_err(|e| {
                // 传输层失败（连接/超时/过大等）也带脱敏后的页 URL 留痕，便于定位。
                let msg = format!(
                    "第 {} 页请求失败（{}）：{e}",
                    index + 1,
                    crate::online::redact_url_for_log(&page.url)
                );
                crate::logging::log_error("online_page", &msg);
                BackendError::from(e)
            })?;
        if !(200..300).contains(&resp.status) {
            let msg = format!("第 {} 页 HTTP {}", index + 1, resp.status);
            crate::logging::log_error(
                "online_page",
                &format!("{msg}：{}", crate::online::redact_url_for_log(&page.url)),
            );
            return Err(BackendError::Network(msg));
        }
        let fmt = match image::guess_format(&resp.body) {
            Ok(f) => f,
            Err(_) => {
                let msg = format!("第 {} 页返回的不是图片", index + 1);
                crate::logging::log_error(
                    "online_page",
                    &format!("{msg}：{}", crate::online::redact_url_for_log(&page.url)),
                );
                return Err(BackendError::Network(msg));
            }
        };
        let ext = match fmt {
            image::ImageFormat::Jpeg => "jpg",
            image::ImageFormat::Png => "png",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::WebP => "webp",
            _ => {
                return Err(BackendError::Network(format!(
                    "第 {} 页图片格式不支持",
                    index + 1
                )))
            }
        };
        Ok(RawPage {
            bytes: resp.body,
            ext: ext.into(),
        })
    }
}

/// 常开句柄（热路径用）：zip 归档保持打开（避免每页重开+解析中央目录），
/// 文件夹缓存文件清单。内部 Mutex 只在单页读取时短暂持锁。
pub struct SourceHandle {
    path: PathBuf,
    kind: HandleKind,
}

enum HandleKind {
    Folder {
        files: Vec<PathBuf>,
    },
    Zip {
        archive: parking_lot::Mutex<zip::ZipArchive<File>>,
        names: Vec<String>,
    },
    Online(OnlineSource),
}

impl SourceHandle {
    pub fn open(path: &Path) -> Result<Self, BackendError> {
        if path.is_dir() {
            Ok(Self {
                path: path.to_path_buf(),
                kind: HandleKind::Folder {
                    files: FolderSource::open(path)?.files,
                },
            })
        } else if is_archive_path(path) {
            let file = File::open(path)?;
            let archive = zip::ZipArchive::new(file)?;
            let mut names: Vec<String> = (0..archive.len())
                .filter_map(|i| archive.name_for_index(i).map(|s| s.to_string()))
                .filter(|n| !n.ends_with('/') && is_image_name(n))
                .collect();
            names.sort();
            Ok(Self {
                path: path.to_path_buf(),
                kind: HandleKind::Zip {
                    archive: parking_lot::Mutex::new(archive),
                    names,
                },
            })
        } else {
            Err(BackendError::Msg(format!(
                "不支持的书籍路径（需要图片目录或 .zip/.cbz）：{}",
                path.display()
            )))
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 在线源句柄：`canonical_url` 同时作为路径标识与整本 Referer。
    pub fn open_online(
        canonical_url: String,
        pages: Vec<PageRef>,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
    ) -> Result<Self, BackendError> {
        Ok(Self {
            path: PathBuf::from(&canonical_url),
            kind: HandleKind::Online(OnlineSource::new(pages, http, concurrency, canonical_url)),
        })
    }

    pub fn page_count(&self) -> Result<usize, BackendError> {
        match &self.kind {
            HandleKind::Folder { files } => Ok(files.len()),
            HandleKind::Zip { names, .. } => Ok(names.len()),
            HandleKind::Online(s) => s.page_count(),
        }
    }

    pub fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        match &self.kind {
            HandleKind::Folder { files } => Ok(files
                .iter()
                .map(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect()),
            HandleKind::Zip { names, .. } => Ok(names.clone()),
            HandleKind::Online(s) => s.entry_names(),
        }
    }

    pub fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        match &self.kind {
            HandleKind::Folder { files } => {
                let path = files
                    .get(index)
                    .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
                let bytes = std::fs::read(path)?;
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                Ok(RawPage { bytes, ext })
            }
            HandleKind::Zip { archive, names } => {
                let name = names
                    .get(index)
                    .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
                let mut ar = archive.lock();
                let mut entry = ar.by_name(name)?;
                if entry.enclosed_name().is_none() {
                    return Err(BackendError::Zip(format!("非法条目名：{name}")));
                }
                let mut bytes = Vec::with_capacity(entry.size().min(32 * 1024 * 1024) as usize);
                entry.read_to_end(&mut bytes)?;
                let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                Ok(RawPage { bytes, ext })
            }
            HandleKind::Online(s) => s.read_raw(index),
        }
    }

    /// 只读条目前 `max_bytes` 字节（图片 header 尺寸解析用，不解压全图）。
    /// 截断可能导致解析失败，调用方需有回退路径。
    pub fn read_partial(&self, index: usize, max_bytes: u64) -> Result<RawPage, BackendError> {
        match &self.kind {
            HandleKind::Folder { files } => {
                let path = files
                    .get(index)
                    .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
                let f = std::fs::File::open(path)?;
                let mut bytes = Vec::new();
                f.take(max_bytes).read_to_end(&mut bytes)?;
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                Ok(RawPage { bytes, ext })
            }
            HandleKind::Zip { archive, names } => {
                let name = names
                    .get(index)
                    .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
                let mut ar = archive.lock();
                let mut entry = ar.by_name(name)?;
                if entry.enclosed_name().is_none() {
                    return Err(BackendError::Zip(format!("非法条目名：{name}")));
                }
                let mut bytes = Vec::new();
                (&mut entry).take(max_bytes).read_to_end(&mut bytes)?;
                let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                Ok(RawPage { bytes, ext })
            }
            // 在线页没有可廉价读取的本地 header：头部探测必须走整页下载，直接拒绝。
            HandleKind::Online(_) => Err(BackendError::Msg("在线源不支持 header 探测".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use crate::online::http::{HttpResponse, HttpTransport};
    use crate::online::{OnlineError, PageRef};

    use super::ImageSource;

    /// 固定响应的假传输：记录每次请求的 (url, referer, max_bytes)，便于断言参数透传。
    struct FakeHttp {
        status: u16,
        body: Vec<u8>,
        requests: Mutex<Vec<(String, Option<String>, usize)>>,
    }

    impl FakeHttp {
        fn ok(body: Vec<u8>) -> Self {
            Self::status(200, body)
        }

        fn status(status: u16, body: Vec<u8>) -> Self {
            Self {
                status,
                body,
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for FakeHttp {
        fn get(
            &self,
            url: &str,
            max_bytes: usize,
            referer: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            self.requests.lock().unwrap().push((
                url.to_string(),
                referer.map(str::to_string),
                max_bytes,
            ));
            Ok(HttpResponse {
                status: self.status,
                final_url: "http://x/1.png".into(),
                content_type: Some("image/png".into()),
                body: self.body.clone(),
            })
        }
    }

    fn tiny_png() -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        buf
    }

    fn pages() -> Vec<PageRef> {
        vec![
            PageRef {
                url: "http://x/001.png".into(),
                width: Some(1),
                height: Some(1),
            },
            PageRef {
                url: "http://x/002.png".into(),
                width: None,
                height: None,
            },
        ]
    }

    #[test]
    fn online_source_reads_pages_and_names() {
        let http = Arc::new(FakeHttp::ok(tiny_png()));
        let src = super::OnlineSource::new(pages(), http.clone(), 2, "http://x/gallery/1".into());
        assert_eq!(src.page_count().unwrap(), 2);
        assert_eq!(src.entry_names().unwrap(), vec!["001.png", "002.png"]);
        let raw = src.read_raw(0).unwrap();
        assert_eq!(raw.ext, "png");
        assert!(raw.bytes.starts_with(b"\x89PNG"));
        assert!(src.read_raw(2).is_err());
        // 单页请求携带页 URL、整本规范化 URL 作为 Referer，以及单页字节上限。
        assert_eq!(
            *http.requests.lock().unwrap(),
            vec![(
                "http://x/001.png".to_string(),
                Some("http://x/gallery/1".to_string()),
                crate::online::PAGE_MAX_BYTES,
            )]
        );
    }

    #[test]
    fn online_source_maps_image_magic_to_extensions() {
        // (用例名, 魔数字节, 期望扩展名)：只校验魔数识别与扩展名映射，不涉及解码。
        let cases: &[(&str, &[u8], &str)] = &[
            ("jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10], "jpg"),
            ("png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\r", "png"),
            ("gif", b"GIF89a\x01\x00\x01\x00", "gif"),
            ("webp", b"RIFF\x10\x00\x00\x00WEBPVP8 ", "webp"),
        ];
        for (name, bytes, ext) in cases {
            let src = super::OnlineSource::new(
                pages(),
                Arc::new(FakeHttp::ok(bytes.to_vec())),
                1,
                "http://x/gallery/1".into(),
            );
            let raw = src
                .read_raw(0)
                .unwrap_or_else(|e| panic!("{name} 魔数应识别为图片：{e}"));
            assert_eq!(raw.ext, *ext, "{name}");
        }

        // 可识别但不支持编码的 BMP：明确报错，而不是当成未知图片放行。
        let bmp = super::OnlineSource::new(
            pages(),
            Arc::new(FakeHttp::ok(b"BM\x00\x00\x00\x00".to_vec())),
            1,
            "http://x/gallery/1".into(),
        );
        let err = bmp
            .read_raw(0)
            .err()
            .expect("BMP 应返回格式不支持")
            .to_string();
        assert!(err.contains("图片格式不支持"), "{err}");
    }

    #[test]
    fn online_source_rejects_bad_status_and_non_image() {
        let bad_status = super::OnlineSource::new(
            pages(),
            Arc::new(FakeHttp::status(404, b"missing".to_vec())),
            1,
            "http://x/gallery/1".into(),
        );
        let err = bad_status
            .read_raw(0)
            .err()
            .expect("非 2xx 应返回错误")
            .to_string();
        assert!(err.contains("HTTP 404"), "{err}");

        let not_image = super::OnlineSource::new(
            pages(),
            Arc::new(FakeHttp::ok(b"plain text".to_vec())),
            1,
            "http://x/gallery/1".into(),
        );
        let err = not_image
            .read_raw(0)
            .err()
            .expect("非图片应返回错误")
            .to_string();
        assert!(err.contains("不是图片"), "{err}");
    }

    #[test]
    fn online_source_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<super::OnlineSource>();
    }

    #[test]
    fn online_handle_rejects_header_probe() {
        let handle = super::SourceHandle::open_online(
            "http://x/gallery/1".into(),
            pages(),
            Arc::new(FakeHttp::ok(tiny_png())),
            2,
        )
        .unwrap();
        assert_eq!(handle.page_count().unwrap(), 2);
        assert_eq!(handle.path(), Path::new("http://x/gallery/1"));
        let err = handle
            .read_partial(0, 1024)
            .err()
            .expect("在线源 header 探测应返回错误")
            .to_string();
        assert_eq!(err, "在线源不支持 header 探测");
    }
}
