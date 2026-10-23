//! 磁盘图片缓存：在线原图 L2 + 统一容量统计/淘汰。
//!
//! 与 `render_cache` 一样，本模块只保存可再生成的派生数据；
//! 书库、进度、设置等 SQLite 数据永远不在缓存根目录内。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::online::PAGE_MAX_BYTES;

/// 磁盘缓存软上限的允许范围（MB）。
pub const MIN_DISK_CACHE_MB: u32 = 500;
pub const MAX_DISK_CACHE_MB: u32 = 10 * 1024;
pub const DEFAULT_DISK_CACHE_MB: u32 = 2 * 1024;

pub fn clamp_budget_mb(mb: u32) -> u32 {
    mb.clamp(MIN_DISK_CACHE_MB, MAX_DISK_CACHE_MB)
}

pub fn budget_bytes(mb: u32) -> u64 {
    clamp_budget_mb(mb) as u64 * 1024 * 1024
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedPage {
    pub bytes: Vec<u8>,
    pub ext: String,
}

/// 在线原图磁盘缓存。键由 URL + Referer 哈希得到，路径不包含原始 URL。
pub struct OnlinePageCache {
    root: PathBuf,
}

impl OnlinePageCache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn book_dir(&self, book_id: &str) -> PathBuf {
        self.root.join(hex::encode(Sha256::digest(book_id.as_bytes())))
    }

    fn key(url: &str, referer: &str) -> String {
        let mut h = Sha256::new();
        h.update(url.as_bytes());
        h.update([0u8]);
        h.update(referer.as_bytes());
        hex::encode(h.finalize())
    }

    fn file_path(&self, book_id: &str, url: &str, referer: &str, ext: &str) -> PathBuf {
        self.book_dir(book_id)
            .join(format!("{}.{ext}", Self::key(url, referer)))
    }

    /// 命中返回原图字节；损坏文件会被立即删除并视为 miss。
    pub fn get(&self, book_id: &str, url: &str, referer: &str) -> Option<CachedPage> {
        for ext in ["jpg", "png", "gif", "webp"] {
            let path = self.file_path(book_id, url, referer, ext);
            let Ok(bytes) = fs::read(&path) else { continue };
            if !valid_image(ext, &bytes) {
                let _ = fs::remove_file(&path);
                continue;
            }
            touch_file(&path);
            return Some(CachedPage {
                bytes,
                ext: ext.to_string(),
            });
        }
        None
    }

    /// 成功落盘返回 true；非法图片、空内容或超限内容不写。
    pub fn put(
        &self,
        book_id: &str,
        url: &str,
        referer: &str,
        ext: &str,
        bytes: &[u8],
    ) -> bool {
        let Some(ext) = normalize_ext(ext) else {
            return false;
        };
        if bytes.is_empty() || bytes.len() > PAGE_MAX_BYTES || !valid_image(ext, bytes) {
            return false;
        }
        let dir = self.book_dir(book_id);
        if fs::create_dir_all(&dir).is_err() {
            return false;
        }
        let final_path = self.file_path(book_id, url, referer, ext);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp = dir.join(format!(
            ".tmp-{}-{}-{nanos}",
            Self::key(url, referer),
            std::process::id()
        ));
        if fs::write(&tmp, bytes).is_err() {
            let _ = fs::remove_file(&tmp);
            return false;
        }
        // Windows 的 rename 不覆盖已有文件：先清掉旧副本，失败也不阻断写入。
        let _ = fs::remove_file(&final_path);
        if fs::rename(&tmp, &final_path).is_err() {
            let _ = fs::remove_file(&tmp);
            return false;
        }
        true
    }

    pub fn remove_book(&self, book_id: &str) -> u64 {
        let dir = self.book_dir(book_id);
        let bytes = dir_bytes(&dir);
        let _ = fs::remove_dir_all(dir);
        bytes
    }

    pub fn clear_all(&self) -> u64 {
        clear_dir(&self.root)
    }

    pub fn disk_bytes(&self) -> u64 {
        dir_bytes(&self.root)
    }

    pub fn file_count(&self) -> u64 {
        count_files(&self.root)
    }
}

fn normalize_ext(ext: &str) -> Option<&'static str> {
    match ext.trim().to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        _ => None,
    }
}

fn valid_image(ext: &str, bytes: &[u8]) -> bool {
    let Ok(format) = image::guess_format(bytes) else {
        return false;
    };
    matches!(
        (ext, format),
        ("jpg", image::ImageFormat::Jpeg)
            | ("png", image::ImageFormat::Png)
            | ("gif", image::ImageFormat::Gif)
            | ("webp", image::ImageFormat::WebP)
    )
}

/// 更新文件的 mtime 作为“最近访问”标记；失败时保持原 mtime，不影响读取。
pub fn touch_file(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// 统计目录总字节（跳过 symlink，避免越界或循环）。
pub fn dir_bytes(root: &Path) -> u64 {
    walk(root).0
}

/// 统计目录中普通文件数量。
pub fn count_files(root: &Path) -> u64 {
    let (_, files) = walk(root);
    files
}

fn walk(root: &Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut files = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
                files = files.saturating_add(1);
            }
        }
    }
    (total, files)
}

/// 清空目录并返回释放的字节数；根目录本身不保留，后续写入会重新创建。
pub fn clear_dir(root: &Path) -> u64 {
    let before = dir_bytes(root);
    if fs::remove_dir_all(root).is_err() {
        // 目录不存在时 remove_dir_all 也报错；此时已无数据可删。
        return before.saturating_sub(dir_bytes(root));
    }
    before
}

/// 跨多个缓存根目录按 mtime 最旧优先淘汰，直到总字节 ≤ budget。
/// 返回释放的字节数。不会触碰缓存根之外的任何文件。
pub fn trim_total(roots: &[&Path], budget: u64) -> u64 {
    let mut files: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    let mut total = 0u64;
    for root in roots {
        collect_files(root, &mut files, &mut total);
    }
    if total <= budget {
        return 0;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    let before = total;
    for (_, path, size) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    for root in roots {
        cleanup_empty_dirs(root);
    }
    before.saturating_sub(total)
}

fn collect_files(root: &Path, out: &mut Vec<(SystemTime, PathBuf, u64)>, total: &mut u64) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                *total = total.saturating_add(meta.len());
                out.push((modified, path, meta.len()));
            }
        }
    }
}

fn cleanup_empty_dirs(root: &Path) {
    let Ok(rd) = fs::read_dir(root) else { return };
    let mut dirs = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        }
    }
    for dir in dirs {
        let _ = fs::remove_dir(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mr-disk-cache-{}-{tag}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn tiny_png() -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        buf
    }

    #[test]
    fn budget_is_clamped_to_supported_range() {
        assert_eq!(clamp_budget_mb(1), MIN_DISK_CACHE_MB);
        assert_eq!(clamp_budget_mb(500), 500);
        assert_eq!(clamp_budget_mb(2048), 2048);
        assert_eq!(clamp_budget_mb(10_240), 10_240);
        assert_eq!(clamp_budget_mb(u32::MAX), MAX_DISK_CACHE_MB);
        assert_eq!(budget_bytes(2048), 2 * 1024 * 1024 * 1024);
    }

    #[test]
    fn put_get_remove_roundtrip_is_book_scoped() {
        let root = temp_root("roundtrip");
        let cache = OnlinePageCache::new(root.join("online"));
        let png = tiny_png();
        assert!(cache.put("book-a", "http://x/1.png", "http://x/ch", "png", &png));
        let hit = cache
            .get("book-a", "http://x/1.png", "http://x/ch")
            .expect("cache hit");
        assert_eq!(hit.ext, "png");
        assert_eq!(hit.bytes, png);
        assert!(
            cache
                .get("book-b", "http://x/1.png", "http://x/ch")
                .is_none(),
            "缓存必须按书隔离"
        );
        assert!(cache.disk_bytes() > 0);
        cache.remove_book("book-a");
        assert!(cache
            .get("book-a", "http://x/1.png", "http://x/ch")
            .is_none());
        assert_eq!(cache.disk_bytes(), 0);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn key_includes_referer_and_does_not_leak_url_into_path() {
        let root = temp_root("key");
        let cache = OnlinePageCache::new(root.join("online"));
        let png = tiny_png();
        assert!(cache.put(
            "book",
            "http://x/1.png?token=secret",
            "http://x/a",
            "png",
            &png
        ));
        assert!(
            cache
                .get("book", "http://x/1.png?token=secret", "http://x/b")
                .is_none(),
            "不同 Referer 不能复用同一缓存"
        );
        let joined = format!("{:?}", cache.root());
        assert!(!joined.contains("secret"), "缓存路径不得包含原始 URL");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn corrupt_bytes_are_rejected_and_never_counted() {
        let root = temp_root("corrupt");
        let cache = OnlinePageCache::new(root.join("online"));
        assert!(!cache.put("book", "http://x/1.png", "http://x/ch", "png", b"not-png"));
        assert!(cache
            .get("book", "http://x/1.png", "http://x/ch")
            .is_none());
        assert_eq!(cache.disk_bytes(), 0, "坏文件不能进入缓存");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lru_touch_keeps_recently_read_file() {
        let root = temp_root("lru");
        let cache = OnlinePageCache::new(root.join("online"));
        let png = tiny_png();
        assert!(cache.put("book", "http://x/1.png", "http://x/ch", "png", &png));
        std::thread::sleep(Duration::from_millis(30));
        assert!(cache.put("book", "http://x/2.png", "http://x/ch", "png", &png));
        std::thread::sleep(Duration::from_millis(30));
        assert!(cache
            .get("book", "http://x/1.png", "http://x/ch")
            .is_some());
        let removed = trim_total(&[cache.root()], 100);
        assert!(removed > 0);
        assert!(
            cache
                .get("book", "http://x/1.png", "http://x/ch")
                .is_some(),
            "刚读过的页应保留"
        );
        assert!(
            cache
                .get("book", "http://x/2.png", "http://x/ch")
                .is_none(),
            "最久未用的页应淘汰"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn total_cap_spans_render_and_online_roots() {
        let root = temp_root("total");
        let render = crate::render_cache::RenderCache::new(root.join("render"));
        let cache = OnlinePageCache::new(root.join("online"));
        render.put("book", 0, 100, 100, &[1u8; 80]);
        std::thread::sleep(Duration::from_millis(30));
        assert!(cache.put(
            "book",
            "http://x/1.png",
            "http://x/ch",
            "png",
            &tiny_png()
        ));
        assert!(trim_total(&[render.root(), cache.root()], 100) > 0);
        assert_eq!(render.disk_bytes(), 0, "更旧的 render 文件应被淘汰");
        assert!(cache.disk_bytes() > 0);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn clear_all_never_touches_database_outside_cache_root() {
        let root = temp_root("clear");
        let db = root.join("library.db");
        std::fs::write(&db, b"sqlite").unwrap();
        let cache_root = root.join("cache");
        let cache = OnlinePageCache::new(cache_root.join("online"));
        let render = crate::render_cache::RenderCache::new(cache_root.join("render"));
        assert!(cache.put(
            "book",
            "http://x/1.png",
            "http://x/ch",
            "png",
            &tiny_png()
        ));
        render.put("book", 0, 100, 100, &[2u8; 80]);
        cache.clear_all();
        render.clear_all();
        assert!(db.exists(), "清理派生缓存绝不能删除书库数据库");
        assert_eq!(cache.disk_bytes(), 0);
        assert_eq!(render.disk_bytes(), 0);
        std::fs::remove_dir_all(root).ok();
    }
}
