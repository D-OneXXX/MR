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
/// 本地压缩包的安全上限：页数与声明的总解压体积。
pub const MAX_LOCAL_PAGES: usize = 10_000;
pub const MAX_ARCHIVE_UNCOMPRESSED: u64 = 4 * 1024 * 1024 * 1024;

pub fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|ext| {
        lower.len() > ext.len() + 1
            && lower.ends_with(ext)
            && lower.as_bytes()[lower.len() - ext.len() - 1] == b'.'
    })
}

/// zip 条目名：`display` 用于展示与自然序排序，`index` 用于按中央目录
/// 索引读取（不依赖 zip crate 的名称解码结果）。
///
/// 背景：条目未带 UTF-8 标志时，中文 Windows 压缩工具（WinRAR/360压缩等）
/// 实际写入的是 GBK 字节，Linux/Windows 上展示层都会变成乱码。修复只影响
/// 展示名——即使猜测错误，`index` 仍保证按索引读页 100% 命中。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntryName {
    pub index: usize,
    pub display: String,
}

/// 非 UTF-8 ZIP 条目名修复（纯函数，任何平台都可测试）。
///
/// 解码优先级：UTF-8 → GB18030 → Shift_JIS → zip crate 的 UTF-8/lossy 结果兜底。
/// - 原始字节是合法 UTF-8 → 原样返回；
/// - GB18030（GBK 超集，覆盖中文 Windows 打包工具写入的 CP936 字节）与
///   Shift_JIS（日文原版包 CP932）都常能无错解出（双字节编码大量重叠），
///   此时用**全角假名出现率**裁决：Shift_JIS 解码含平/片假名而 GB18030
///   不含 → 判定日文包；半角片假名（GBK 汉字按 SJIS 解出的典型噪声）
///   不作为日文证据；
/// - 两种解码都出现替换字符 → 回退调用方提供的 zip 解码/lossy 结果。
///
/// 修复只影响展示名——纯汉字日文名与中文名在无假名时无法区分，会按
/// GB18030 展示（可能仍乱码），但读取按中央目录 `index` 进行，
/// 页序与内容不受影响。
fn fixup_entry_name(raw: &[u8], zip_decoded: &str) -> String {
    if std::str::from_utf8(raw).is_ok() {
        return zip_decoded.to_string();
    }
    let (gb, _, gb_errors) = encoding_rs::GB18030.decode(raw);
    let (sj, _, sj_errors) = encoding_rs::SHIFT_JIS.decode(raw);
    match (gb_errors, sj_errors) {
        (false, true) => gb.into_owned(),
        (true, false) => sj.into_owned(),
        (false, false) => {
            if has_fullwidth_kana(&sj) && !has_fullwidth_kana(&gb) {
                sj.into_owned()
            } else {
                gb.into_owned()
            }
        }
        (true, true) => zip_decoded.to_string(),
    }
}

/// 全角假名（平假名 U+3041..U+309F / 片假名 U+30A0..U+30FF）出现检测。
/// 刻意不含半角片假名：GBK 汉字字节按 Shift_JIS 解码会大量产生半角片
/// 假名噪声，不能作为日文证据。
fn has_fullwidth_kana(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\u{3041}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}'))
}

/// 归档魔数嗅探：在交给 zip crate 之前先读文件头 8 字节，识别改后缀的
/// 伪装包，避免把 RAR/7z 当 ZIP 解析时在深层爆出难懂错误或卡死。
///
/// - `50 4B 03 04`（本地文件头）/ `50 4B 05 06`（空归档中央目录）/
///   `50 4B 07 08`（分卷数据描述）→ 合法 ZIP；
/// - `52 61 72 21`（`Rar!`）→ RAR 改后缀伪装；
/// - `37 7A BC AF 27 1C`（`7z\xBC\xAF'`）→ 7z 改后缀伪装；
/// - 其它 → 非压缩包内容。
///
/// 错误文案内嵌括号形式稳定错误码（`archive-disguised-rar` 等），前端
/// `src/features/errors/localize.ts` 据此映射六语提示。
fn sniff_archive_magic(path: &Path) -> Result<(), BackendError> {
    use std::io::Read as _;
    let mut file = File::open(path)?;
    let mut head = [0u8; 8];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(BackendError::Io(e.to_string())),
        }
    }
    let head = &head[..filled];
    const ZIP_LOCAL: &[u8] = &[0x50, 0x4B, 0x03, 0x04];
    const ZIP_EOCD: &[u8] = &[0x50, 0x4B, 0x05, 0x06];
    const ZIP_SPAN: &[u8] = &[0x50, 0x4B, 0x07, 0x08];
    const RAR: &[u8] = &[0x52, 0x61, 0x72, 0x21];
    const SEVEN_Z: &[u8] = &[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
    if head.starts_with(ZIP_LOCAL) || head.starts_with(ZIP_EOCD) || head.starts_with(ZIP_SPAN) {
        return Ok(());
    }
    if head.starts_with(RAR) {
        return Err(BackendError::Zip(
            "该文件实际是 RAR 压缩包（仅改了后缀名），请转换为标准无密码 ZIP/CBZ 后再导入（archive-disguised-rar）".into(),
        ));
    }
    if head.starts_with(SEVEN_Z) {
        return Err(BackendError::Zip(
            "该文件实际是 7z 压缩包（仅改了后缀名），请转换为标准无密码 ZIP/CBZ 后再导入（archive-disguised-7z）".into(),
        ));
    }
    Err(BackendError::Zip(
        "该文件不是有效的 ZIP/CBZ 压缩包，请转为标准无密码 ZIP/CBZ（archive-not-zip）".into(),
    ))
}

/// 统一收集 zip/cbz 图片条目，并在打开阶段拒绝 zip bomb / 超大归档 / 加密包。
fn zip_image_names(archive: &mut zip::ZipArchive<File>) -> Result<Vec<ZipEntryName>, BackendError> {
    let mut names = Vec::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        // by_index_raw：只读中央目录元数据、不解密不解压——加密条目在这里
        // 显式报结构化错误，而不是等读到该页时爆出底层解密失败。
        let entry = archive.by_index_raw(index)?;
        if entry.encrypted() {
            return Err(BackendError::Zip(
                "压缩包已加密或包含加密条目，请转为标准无密码 ZIP/CBZ 后再导入（archive-encrypted）".into(),
            ));
        }
        let raw = entry.name_raw();
        let decoded = entry
            .name()
            .map(|name| name.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(raw).into_owned());
        if entry.is_dir() || !is_image_name(&decoded) {
            continue;
        }
        total = total.saturating_add(entry.size());
        if names.len() >= MAX_LOCAL_PAGES {
            return Err(BackendError::Zip(format!(
                "压缩包图片数超过上限 {MAX_LOCAL_PAGES}"
            )));
        }
        if total > MAX_ARCHIVE_UNCOMPRESSED {
            return Err(BackendError::Zip(
                "压缩包总解压体积超过安全上限（4 GiB）".into(),
            ));
        }
        let display = fixup_entry_name(raw, &decoded);
        names.push(ZipEntryName { index, display });
    }
    Ok(names)
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
        files.sort_by(|a, b| {
            crate::commands::natural_cmp_path(&a.to_string_lossy(), &b.to_string_lossy())
        });
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
    /// 归档内图片条目名（按展示名自然序排序，索引稳定）。
    names: Vec<ZipEntryName>,
}

impl ZipSource {
    pub fn open(path: &Path) -> Result<Self, BackendError> {
        sniff_archive_magic(path)?;
        let file = File::open(path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let mut names = zip_image_names(&mut archive)?;
        names.sort_by(|a, b| crate::commands::natural_cmp_path(&a.display, &b.display));
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
        Ok(self.names.iter().map(|n| n.display.clone()).collect())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let name = self
            .names
            .get(index)
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
        let mut archive = self.reopen()?;
        let mut entry = archive.by_index(name.index)?;
        // 安全：拒绝 ZipSlip（虽然只读内存不落盘，仍做校验）。
        if entry.enclosed_name().is_none() {
            return Err(BackendError::Zip(format!("非法条目名：{}", name.display)));
        }
        if entry.size() > PAGE_MAX_BYTES as u64 {
            return Err(BackendError::Zip(format!(
                "单页解压体积超过上限：{}",
                name.display
            )));
        }
        let mut bytes = Vec::with_capacity(entry.size().min(32 * 1024 * 1024) as usize);
        (&mut entry)
            .take(PAGE_MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > PAGE_MAX_BYTES {
            return Err(BackendError::Zip(format!(
                "单页解压体积超过上限：{}",
                name.display
            )));
        }
        let ext = name
            .display
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
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
///
/// Telegram 等 CDN 直链带时效签名：遇到 403/404 时按页锚点静默刷新一次并
/// 写回本句柄的内存页表；持久化仍只保存 `channel + message_id` 坐标。
pub struct OnlineSource {
    book_id: String,
    pages: parking_lot::Mutex<Vec<PageRef>>,
    http: Arc<dyn HttpTransport>,
    permits: Arc<BlockingSemaphore>,
    /// 整本规范化 URL：作为单页请求的 Referer/Origin 来源（防盗链站点需要）。
    referer: String,
    /// 在线原图磁盘 L2；按 book + URL + Referer 缓存，离线重读不再发请求。
    cache: Option<Arc<crate::disk_cache::OnlinePageCache>>,
}

impl OnlineSource {
    pub fn new(
        book_id: String,
        pages: Vec<PageRef>,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
        referer: String,
        cache: Option<Arc<crate::disk_cache::OnlinePageCache>>,
    ) -> Self {
        Self {
            book_id,
            pages: parking_lot::Mutex::new(pages),
            http,
            permits: Arc::new(BlockingSemaphore::new(concurrency)),
            referer,
            cache,
        }
    }

    /// 取单页快照；调用方不得持有锁做网络 I/O。
    fn page_at(&self, index: usize) -> Result<PageRef, BackendError> {
        self.pages
            .lock()
            .get(index)
            .cloned()
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))
    }

    fn replace_page_url(&self, index: usize, url: String) {
        if let Some(page) = self.pages.lock().get_mut(index) {
            page.url = url;
        }
    }

    fn get_page(
        &self,
        page: &PageRef,
        index: usize,
    ) -> Result<crate::online::http::HttpResponse, BackendError> {
        self.http
            .get(
                &page.url,
                PAGE_MAX_BYTES,
                Some(&self.referer),
                Some(&self.referer),
            )
            .map_err(|e| {
                // 传输层失败（连接/超时/过大等）也带脱敏后的页 URL 留痕，便于定位。
                let msg = format!(
                    "第 {} 页请求失败（{}）：{e}",
                    index + 1,
                    crate::online::redact_url_for_log(&page.url)
                );
                crate::logging::log_error("online_page", &msg);
                BackendError::from(e)
            })
    }
}

impl ImageSource for OnlineSource {
    fn page_count(&self) -> Result<usize, BackendError> {
        Ok(self.pages.lock().len())
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(self
            .pages
            .lock()
            .iter()
            .enumerate()
            .map(|(i, p)| crate::online::page_name(p, i))
            .collect())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let mut page = self.page_at(index)?;
        // 原图磁盘 L2：命中时不占用并发许可，也不发起网络请求。
        if let Some(cache) = &self.cache {
            if let Some(hit) = cache.get(&self.book_id, &page.url, &self.referer) {
                return Ok(RawPage {
                    bytes: hit.bytes,
                    ext: hit.ext,
                });
            }
        }
        // 每本书独立的并发闸门：限制同时在途的页面下载数。
        let _guard = self.permits.acquire();
        let mut resp = self.get_page(&page, index)?;
        // Telegram CDN 直链过期：403/404 时按原消息坐标重新解析一次。
        if matches!(resp.status, 403 | 404) {
            if let Some(anchor) = page.anchor.as_ref() {
                match crate::online::telegram::refresh_page_url(&*self.http, anchor) {
                    Ok(Some(fresh)) => {
                        if let Ok(normalized) = crate::online::normalize_url(&fresh) {
                            let fresh = normalized.to_string();
                            if fresh != page.url {
                                crate::logging::log_error(
                                    "online_page",
                                    &format!("第 {} 页直链失效，已按消息锚点刷新", index + 1),
                                );
                                self.replace_page_url(index, fresh.clone());
                                page.url = fresh;
                                resp = self.get_page(&page, index)?;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        crate::logging::log_error(
                            "online_page",
                            &format!("第 {} 页直链刷新失败：{e}", index + 1),
                        );
                    }
                }
            }
        }
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
        if let Some(cache) = &self.cache {
            cache.put(&self.book_id, &page.url, &self.referer, ext, &resp.body);
        }
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
        names: Vec<ZipEntryName>,
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
            sniff_archive_magic(path)?;
            let file = File::open(path)?;
            let mut archive = zip::ZipArchive::new(file)?;
            let mut names = zip_image_names(&mut archive)?;
            names.sort_by(|a, b| crate::commands::natural_cmp_path(&a.display, &b.display));
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
        book_id: String,
        canonical_url: String,
        pages: Vec<PageRef>,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
        cache: Option<Arc<crate::disk_cache::OnlinePageCache>>,
    ) -> Result<Self, BackendError> {
        Ok(Self {
            path: PathBuf::from(&canonical_url),
            kind: HandleKind::Online(OnlineSource::new(
                book_id,
                pages,
                http,
                concurrency,
                canonical_url,
                cache,
            )),
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
            HandleKind::Zip { names, .. } => Ok(names.iter().map(|n| n.display.clone()).collect()),
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
                let mut entry = ar.by_index(name.index)?;
                if entry.enclosed_name().is_none() {
                    return Err(BackendError::Zip(format!("非法条目名：{}", name.display)));
                }
                if entry.size() > PAGE_MAX_BYTES as u64 {
                    return Err(BackendError::Zip(format!(
                        "单页解压体积超过上限：{}",
                        name.display
                    )));
                }
                let mut bytes = Vec::with_capacity(entry.size().min(32 * 1024 * 1024) as usize);
                (&mut entry)
                    .take(PAGE_MAX_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > PAGE_MAX_BYTES {
                    return Err(BackendError::Zip(format!(
                        "单页解压体积超过上限：{}",
                        name.display
                    )));
                }
                let ext = name
                    .display
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
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
                let mut entry = ar.by_index(name.index)?;
                if entry.enclosed_name().is_none() {
                    return Err(BackendError::Zip(format!("非法条目名：{}", name.display)));
                }
                let mut bytes = Vec::new();
                (&mut entry).take(max_bytes).read_to_end(&mut bytes)?;
                let ext = name
                    .display
                    .rsplit('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
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

    use super::{fixup_entry_name, ImageSource};

    /// 每次请求记录 (url, referer, max_bytes, header_scope)。
    type RequestLog = Mutex<Vec<(String, Option<String>, usize, Option<String>)>>;

    /// 固定响应的假传输。
    struct FakeHttp {
        status: u16,
        body: Vec<u8>,
        requests: RequestLog,
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
            header_scope: Option<&str>,
        ) -> Result<HttpResponse, OnlineError> {
            self.requests.lock().unwrap().push((
                url.to_string(),
                referer.map(str::to_string),
                max_bytes,
                header_scope.map(str::to_string),
            ));
            Ok(HttpResponse {
                status: self.status,
                final_url: "http://x/1.png".into(),
                content_type: Some("image/png".into()),
                body: self.body.clone(),
            })
        }
    }

    #[test]
    fn zip_entry_name_fixup_recovers_gbk_but_keeps_utf8() {
        // 合法 UTF-8 原始字节 → 与 zip crate 解码一致（含非 ASCII）。
        let utf8_raw = "第01话/1.png".as_bytes();
        assert_eq!(fixup_entry_name(utf8_raw, "decoded"), "decoded");

        // GBK 字节（中文 Windows 压缩工具、未设 UTF-8 标志）→ 修复为汉字。
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode("第01话/1.png");
        assert!(
            std::str::from_utf8(&gbk_bytes).is_err(),
            "GBK 字节不应是合法 UTF-8"
        );
        let fixed = fixup_entry_name(&gbk_bytes, "mojibake");
        assert_eq!(fixed, "第01话/1.png");

        // 既非 UTF-8 也非 GB18030/Shift_JIS 的字节 → 回退 zip crate 的 CP437 解码结果。
        assert_eq!(
            fixup_entry_name(&[0xff, 0xfe, 0x81, 0x30, 0x0a], "cp437"),
            "cp437"
        );
    }

    #[test]
    fn zip_entry_name_fixup_recovers_shift_jis_via_kana_tiebreak() {
        // 日文原版包（CP932）：Shift_JIS 字节在 GB18030 下也能无错解出
        // （得到生僻汉字噪声），靠全角假名出现率裁决为 Shift_JIS。
        let (sj_bytes, _, _) = encoding_rs::SHIFT_JIS.encode("よるのゆめ/01.png");
        assert!(
            std::str::from_utf8(&sj_bytes).is_err(),
            "Shift_JIS 字节不应是合法 UTF-8"
        );
        let fixed = fixup_entry_name(&sj_bytes, "mojibake");
        assert_eq!(fixed, "よるのゆめ/01.png");

        // GBK 汉字按 Shift_JIS 解码会得到半角片假名噪声——半角假名不算
        // 日文证据，中文包必须仍按 GB18030 胜出。
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode("深夜食堂/第3卷");
        let fixed = fixup_entry_name(&gbk_bytes, "mojibake");
        assert_eq!(fixed, "深夜食堂/第3卷");
    }

    #[test]
    fn sniff_archive_magic_flags_disguised_archives() {
        use super::sniff_archive_magic;
        let dir = std::env::temp_dir();
        let tag = format!(
            "mr-sniff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let write = |name: &str, bytes: &[u8]| {
            let p = dir.join(format!("{tag}-{name}"));
            std::fs::write(&p, bytes).unwrap();
            p
        };

        // 合法 ZIP 本地文件头。
        let zip_path = write("ok.cbz", &[0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
        assert!(sniff_archive_magic(&zip_path).is_ok());

        // RAR 改后缀（`Rar!`）。
        let rar_path = write(
            "fake-rar.cbz",
            &[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00],
        );
        let err = sniff_archive_magic(&rar_path).unwrap_err().to_string();
        assert!(err.contains("archive-disguised-rar"), "got: {err}");

        // 7z 改后缀（`7z BC AF 27 1C`）。
        let sz_path = write(
            "fake-7z.cbz",
            &[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04],
        );
        let err = sniff_archive_magic(&sz_path).unwrap_err().to_string();
        assert!(err.contains("archive-disguised-7z"), "got: {err}");

        // 既不是 ZIP 也不是 RAR/7z 的杂项内容。
        let junk_path = write("junk.cbz", b"not an archive at all..");
        let err = sniff_archive_magic(&junk_path).unwrap_err().to_string();
        assert!(err.contains("archive-not-zip"), "got: {err}");

        for p in [zip_path, rar_path, sz_path, junk_path] {
            let _ = std::fs::remove_file(p);
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
                anchor: None,
            },
            PageRef {
                url: "http://x/002.png".into(),
                width: None,
                height: None,
                anchor: None,
            },
        ]
    }

    #[test]
    fn online_source_reads_pages_and_names() {
        let http = Arc::new(FakeHttp::ok(tiny_png()));
        let src = super::OnlineSource::new(
            "book-test".into(),
            pages(),
            http.clone(),
            2,
            "http://x/gallery/1".into(),
            None,
        );
        assert_eq!(src.page_count().unwrap(), 2);
        assert_eq!(src.entry_names().unwrap(), vec!["001.png", "002.png"]);
        let raw = src.read_raw(0).unwrap();
        assert_eq!(raw.ext, "png");
        assert!(raw.bytes.starts_with(b"\x89PNG"));
        assert!(src.read_raw(2).is_err());
        // 单页请求携带页 URL、整本规范化 URL 作为 Referer/header scope，以及单页字节上限。
        assert_eq!(
            *http.requests.lock().unwrap(),
            vec![(
                "http://x/001.png".to_string(),
                Some("http://x/gallery/1".to_string()),
                crate::online::PAGE_MAX_BYTES,
                Some("http://x/gallery/1".to_string()),
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
                "book-test".into(),
                pages(),
                Arc::new(FakeHttp::ok(bytes.to_vec())),
                1,
                "http://x/gallery/1".into(),
                None,
            );
            let raw = src
                .read_raw(0)
                .unwrap_or_else(|e| panic!("{name} 魔数应识别为图片：{e}"));
            assert_eq!(raw.ext, *ext, "{name}");
        }

        // 可识别但不支持编码的 BMP：明确报错，而不是当成未知图片放行。
        let bmp = super::OnlineSource::new(
            "book-test".into(),
            pages(),
            Arc::new(FakeHttp::ok(b"BM\x00\x00\x00\x00".to_vec())),
            1,
            "http://x/gallery/1".into(),
            None,
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
            "book-test".into(),
            pages(),
            Arc::new(FakeHttp::status(404, b"missing".to_vec())),
            1,
            "http://x/gallery/1".into(),
            None,
        );
        let err = bad_status
            .read_raw(0)
            .err()
            .expect("非 2xx 应返回错误")
            .to_string();
        assert!(err.contains("HTTP 404"), "{err}");

        let not_image = super::OnlineSource::new(
            "book-test".into(),
            pages(),
            Arc::new(FakeHttp::ok(b"plain text".to_vec())),
            1,
            "http://x/gallery/1".into(),
            None,
        );
        let err = not_image
            .read_raw(0)
            .err()
            .expect("非图片应返回错误")
            .to_string();
        assert!(err.contains("不是图片"), "{err}");
    }

    #[test]
    fn online_source_refreshes_expired_telegram_cdn_once() {
        struct RefreshingHttp;
        impl HttpTransport for RefreshingHttp {
            fn get(
                &self,
                url: &str,
                _max: usize,
                _referer: Option<&str>,
                _scope: Option<&str>,
            ) -> Result<HttpResponse, OnlineError> {
                if url.contains("embed=1") {
                    return Ok(HttpResponse {
                        status: 200,
                        final_url: url.into(),
                        content_type: Some("text/html".into()),
                        body: br#"<div class="tgme_widget_message" data-post="testchannel/102">
                            <a class="tgme_widget_message_photo_wrap"
                               style="background-image:url('http://cdn.test/fresh.png')"></a>
                        </div>"#
                            .to_vec(),
                    });
                }
                if url.ends_with("old.png") {
                    return Ok(HttpResponse {
                        status: 403,
                        final_url: url.into(),
                        content_type: None,
                        body: b"expired".to_vec(),
                    });
                }
                if url.ends_with("fresh.png") {
                    return Ok(HttpResponse {
                        status: 200,
                        final_url: url.into(),
                        content_type: Some("image/png".into()),
                        body: tiny_png(),
                    });
                }
                Ok(HttpResponse {
                    status: 404,
                    final_url: url.into(),
                    content_type: None,
                    body: Vec::new(),
                })
            }
        }

        let page = PageRef {
            url: "http://cdn.test/old.png".into(),
            width: Some(800),
            height: Some(1200),
            anchor: Some(crate::online::PageAnchor {
                channel: "testchannel".into(),
                message_id: 102,
                photo_index: 0,
                refresh_base: Some("https://t.me".into()),
            }),
        };
        let src = super::OnlineSource::new(
            "book-test".into(),
            vec![page],
            Arc::new(RefreshingHttp),
            1,
            "https://t.me/testchannel/102".into(),
            None,
        );
        let raw = src.read_raw(0).expect("刷新后应读到新 CDN 地址");
        assert!(!raw.bytes.is_empty());
        assert_eq!(raw.ext, "png");
        assert_eq!(src.page_count().unwrap(), 1);
    }

    #[test]
    fn zip_entries_use_natural_order_and_nested_paths() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mr-zip-order-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("order.cbz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        // 写入顺序故意是字典序错乱的；读取必须按自然页序返回。
        for name in [
            "10.jpg",
            "2.png",
            "1.jpg",
            "20.jpg",
            "11.jpg",
            "chap10/1.png",
            "chap2/10.png",
            "chap2/2.png",
        ] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();

        let source = super::ZipSource::open(&path).unwrap();
        assert_eq!(
            source.entry_names().unwrap(),
            vec![
                "1.jpg",
                "2.png",
                "10.jpg",
                "11.jpg",
                "20.jpg",
                "chap2/2.png",
                "chap2/10.png",
                "chap10/1.png",
            ],
            "混合扩展名与多级目录都必须按页号自然排序"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// 递归快照目录（相对路径 + 文件字节数）：用于断言读取过程不落盘。
    fn dir_snapshot(root: &Path) -> Vec<(String, u64)> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
            let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .collect();
            entries.sort();
            for path in entries {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let meta = std::fs::metadata(&path).unwrap();
                if meta.is_dir() {
                    out.push((format!("{rel}/"), 0));
                    walk(root, &path, out);
                } else {
                    out.push((rel, meta.len()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    /// 打开只读中央目录 + 按需解压单条：中文名不乱码、页数正确、绝不落盘。
    #[test]
    fn zip_source_reads_on_demand_without_extracting() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mr-zip-stream-{}-{nanos}", std::process::id()));
        // 归档放在子目录里，旁边再放一个空目录：任何“解压到磁盘”都会破坏快照。
        let archive_dir = root.join("archive");
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();

        let path = archive_dir.join("中文 名.cbz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        // 写入顺序故意打乱；内容各不相同，便于验证“只取命中条目”。
        for (name, body) in [
            ("10.jpg", b"ten-page".as_slice()),
            ("1.jpg", b"one-page".as_slice()),
            ("notes.txt", b"not-an-image".as_slice()),
            ("2.png", b"two-page".as_slice()),
            ("子目录/中文 名.png", b"nested-chinese".as_slice()),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(body).unwrap();
        }
        // 显式目录条目必须被忽略（既不算页，也不触发解压）。
        zip.add_directory("空目录/", options).unwrap();
        zip.finish().unwrap();

        let before = dir_snapshot(&root);
        let source = super::ZipSource::open(&path).unwrap();
        let names = source.entry_names().unwrap();
        assert_eq!(
            names,
            vec!["1.jpg", "2.png", "10.jpg", "子目录/中文 名.png"],
            "中文名不得乱码，且 1/2/10 必须按数值自然序"
        );
        assert_eq!(
            source.page_count().unwrap(),
            4,
            "页数 = 图片条目数（忽略目录条目与非图片文件）"
        );

        // 只读取 index=2（自然序即 10.jpg），字节必须与写入内容一致。
        let raw = source.read_raw(2).unwrap();
        assert_eq!(raw.bytes, b"ten-page");
        assert_eq!(raw.ext, "jpg");
        assert!(source.read_raw(4).is_err(), "越界页码必须报错");

        // 生产热路径的常开句柄同样只能按需读取。
        let handle = super::SourceHandle::open(&path).unwrap();
        assert_eq!(handle.page_count().unwrap(), 4);
        assert_eq!(handle.read_raw(2).unwrap().bytes, b"ten-page");
        drop(handle);

        assert_eq!(
            dir_snapshot(&root),
            before,
            "打开/单页读取不得在归档目录内外产生任何解压文件"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn online_source_reuses_disk_page_cache() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mr-source-cache-{}-{nanos}", std::process::id()));
        let cache = Arc::new(crate::disk_cache::OnlinePageCache::new(root.join("online")));
        let http = Arc::new(FakeHttp::ok(tiny_png()));
        let src = super::OnlineSource::new(
            "book-test".into(),
            pages(),
            http.clone(),
            1,
            "http://x/gallery/1".into(),
            Some(cache.clone()),
        );
        src.read_raw(0).unwrap();
        src.read_raw(0).unwrap();
        assert_eq!(http.requests.lock().unwrap().len(), 1, "第二遍应命中磁盘");
        assert!(cache.disk_bytes() > 0);
        assert_eq!(cache.file_count(), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn online_source_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<super::OnlineSource>();
    }

    #[test]
    fn online_handle_rejects_header_probe() {
        let handle = super::SourceHandle::open_online(
            "book-test".into(),
            "http://x/gallery/1".into(),
            pages(),
            Arc::new(FakeHttp::ok(tiny_png())),
            2,
            None,
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
