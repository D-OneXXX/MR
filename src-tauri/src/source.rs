//! 统一图片源：本地文件夹与 zip/cbz 同一接口（全新设计，与旧 Qt 工程无关）。
//!
//! 设计要点（流式 + 预算制）：
//! - 永远只读需要的单页字节，不做整包解压、不在内存保留整本；
//! - `FolderSource` 按文件名排序后随机读取单文件；
//! - `ZipSource` 每次按需打开归档、只读取命中的单个条目字节，读完即关。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use thiserror::Error;

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

/// 常开句柄（热路径用）：zip 归档保持打开（避免每页重开+解析中央目录），
/// 文件夹缓存文件清单。内部 Mutex 只在单页读取时短暂持锁。
pub struct SourceHandle {
    path: PathBuf,
    kind: HandleKind,
}

enum HandleKind {
    Folder { files: Vec<PathBuf> },
    Zip {
        archive: parking_lot::Mutex<zip::ZipArchive<File>>,
        names: Vec<String>,
    },
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

    pub fn page_count(&self) -> Result<usize, BackendError> {
        Ok(match &self.kind {
            HandleKind::Folder { files } => files.len(),
            HandleKind::Zip { names, .. } => names.len(),
        })
    }

    pub fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(match &self.kind {
            HandleKind::Folder { files } => files
                .iter()
                .map(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect(),
            HandleKind::Zip { names, .. } => names.clone(),
        })
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
        }
    }
}
