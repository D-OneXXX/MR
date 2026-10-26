//! 磁盘渲染缓存（L2）：成品 JPEG 按 (book_id, index, 请求尺寸) 落盘。
//!
//! 命中路径 = 一次 SSD 读（~1ms）+ base64，跳过 开卷/解压/解码/缩放/编码 全管线，
//! 这是「毫秒级翻页」的主力。容量与在线原图缓存共用同一软上限，
//! 由 `AppState::trim_disk_cache` 按 mtime 统一 LRU；删除书籍时整目录级联清理。

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct RenderCache {
    root: PathBuf,
}

/// 缓存目录名只接受受控值：生产 book_id 是 64 位 SHA-256 hex，原样使用；
/// 其他任意来源（测试/异常 DB/路径穿越）一律再哈希，避免 `..` 越出缓存根。
fn safe_book_id(book_id: &str) -> String {
    if book_id.len() == 64 && book_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        book_id.to_ascii_lowercase()
    } else {
        hex::encode(Sha256::digest(book_id.as_bytes()))
    }
}

impl RenderCache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn book_dir(&self, book_id: &str) -> PathBuf {
        self.root.join(safe_book_id(book_id))
    }

    fn file_path(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) -> PathBuf {
        self.book_dir(book_id)
            .join(format!("{index:06}@{req_w}x{req_h}.jpg"))
    }

    /// 命中返回成品 JPEG 字节；非 JPEG 的坏缓存立即删除并视为 miss。
    pub fn get(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) -> Option<Vec<u8>> {
        let path = self.file_path(book_id, index, req_w, req_h);
        let mut f = std::fs::File::open(&path).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        if image::guess_format(&buf).ok() != Some(image::ImageFormat::Jpeg) {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        // 访问即刷新 mtime，统一 trim 才是真正 LRU，而不是只看写入时间。
        crate::disk_cache::touch_file(&path);
        Some(buf)
    }

    /// 删除单页成品（坏缓存自愈用）。
    pub fn remove_page(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) {
        let _ = std::fs::remove_file(self.file_path(book_id, index, req_w, req_h));
    }

    /// 落盘（原子写：tmp + rename），失败静默（缓存永远不该拖垮主流程）。
    pub fn put(&self, book_id: &str, index: u32, req_w: u32, req_h: u32, bytes: &[u8]) {
        let dir = self.book_dir(book_id);
        if std::fs::create_dir_all(&dir).is_err() {
            crate::cache_health::record_failure();
            return;
        }
        let final_path = self.file_path(book_id, index, req_w, req_h);
        let tmp = dir.join(format!(".tmp-{index:06}@{req_w}x{req_h}"));
        if std::fs::write(&tmp, bytes).is_ok() {
            if std::fs::rename(&tmp, &final_path).is_err() {
                let _ = std::fs::remove_file(&tmp);
                crate::cache_health::record_failure();
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
            crate::cache_health::record_failure();
        }
    }

    /// 条漫切片存取：文件名 `{index:06}t{tile:02}@{w}.jpg`。
    pub fn get_tile(&self, book_id: &str, index: u32, tile: u32, w: u32) -> Option<Vec<u8>> {
        let path = self
            .book_dir(book_id)
            .join(format!("{index:06}t{tile:02}@{w}.jpg"));
        let mut f = std::fs::File::open(&path).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        if image::guess_format(&buf).ok() != Some(image::ImageFormat::Jpeg) {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        crate::disk_cache::touch_file(&path);
        Some(buf)
    }

    pub fn remove_tile(&self, book_id: &str, index: u32, tile: u32, w: u32) {
        let _ = std::fs::remove_file(
            self.book_dir(book_id)
                .join(format!("{index:06}t{tile:02}@{w}.jpg")),
        );
    }

    pub fn put_tile(&self, book_id: &str, index: u32, tile: u32, w: u32, bytes: &[u8]) {
        let dir = self.book_dir(book_id);
        if std::fs::create_dir_all(&dir).is_err() {
            crate::cache_health::record_failure();
            return;
        }
        let final_path = dir.join(format!("{index:06}t{tile:02}@{w}.jpg"));
        let tmp = dir.join(format!(".tmp-{index:06}t{tile:02}@{w}"));
        if std::fs::write(&tmp, bytes).is_ok() {
            if std::fs::rename(&tmp, &final_path).is_err() {
                let _ = std::fs::remove_file(&tmp);
                crate::cache_health::record_failure();
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
            crate::cache_health::record_failure();
        }
    }

    /// 删除某书全部磁盘渲染缓存。
    pub fn remove_book(&self, book_id: &str) {
        let _ = std::fs::remove_dir_all(self.book_dir(book_id));
    }

    /// 只清首页成品（封面缩略图），返回删除的文件数。
    /// 「重新生成缩略图」用；页成品不受影响。
    pub fn clear_thumb_files(&self) -> u32 {
        let mut n = 0;
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return 0;
        };
        for e in rd.flatten() {
            let book_dir = e.path();
            if !book_dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&book_dir) else {
                continue;
            };
            for f in files.flatten() {
                let name = f.file_name();
                let name = name.to_string_lossy();
                // 文件名形如 `000000@240x240.jpg`：index 段为 000000 即首页。
                if name.starts_with("000000@") && std::fs::remove_file(f.path()).is_ok() {
                    n += 1;
                }
            }
            let _ = std::fs::remove_dir(&book_dir); // 空目录顺手清掉
        }
        n
    }

    /// 清空整个渲染缓存。
    pub fn clear_all(&self) {
        crate::disk_cache::clear_dir(&self.root);
    }

    /// 统计磁盘占用（字节）。
    pub fn disk_bytes(&self) -> u64 {
        crate::disk_cache::dir_bytes(&self.root)
    }

    /// 缓存文件数（清理结果展示用）。
    pub fn file_count(&self) -> u64 {
        crate::disk_cache::count_files(&self.root)
    }

    /// 超预算按 mtime 从旧到新删除，直到 ≤ budget。单测/维护入口；
    /// 运行时统一淘汰由 `AppState::trim_disk_cache` 跨两个缓存根执行。
    pub fn trim(&self, budget: u64) {
        crate::disk_cache::trim_total(&[&self.root], budget);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_l2_jpeg_is_dropped_instead_of_poisoning_cache() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mr-rc-bad-{}-{nanos}", std::process::id()));
        let rc = RenderCache::new(dir.clone());
        rc.put("book1", 3, 800, 1200, b"not-a-jpeg");
        assert_eq!(rc.get("book1", 3, 800, 1200), None);
        assert_eq!(rc.disk_bytes(), 0, "坏文件应从 L2 删除");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remove_book_hashes_unsafe_book_id() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("mr-rc-safe-{}-{nanos}", std::process::id()));
        let rc = RenderCache::new(base.join("render"));
        std::fs::create_dir_all(&base).unwrap();
        let victim = base.join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        rc.put("../../victim.txt", 0, 100, 100, b"jpeg");
        rc.remove_book("../../victim.txt");
        assert!(victim.exists(), "任意 book_id 不得越出缓存根删除文件");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn put_get_remove_roundtrip() {
        use image::ImageEncoder as _;
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .write_image(&[255, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("mr-rc-{}", std::process::id()));
        let rc = RenderCache::new(dir.clone());
        rc.put("book1", 3, 800, 1200, &jpeg);
        assert_eq!(
            rc.get("book1", 3, 800, 1200).as_deref(),
            Some(jpeg.as_slice())
        );
        assert_eq!(rc.get("book1", 4, 800, 1200), None);
        rc.remove_book("book1");
        assert_eq!(rc.get("book1", 3, 800, 1200), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
