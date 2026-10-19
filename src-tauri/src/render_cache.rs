//! 磁盘渲染缓存（L2）：成品 JPEG 按 (book_id, index, 请求尺寸) 落盘。
//!
//! 命中路径 = 一次 SSD 读（~1ms）+ base64，跳过 开卷/解压/解码/缩放/编码 全管线，
//! 这是「毫秒级翻页」的主力。预算 2GB，超限按 mtime 删最旧；删除书籍时整目录级联清理。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 磁盘渲染缓存总预算：2GB（约数千页成品图）。
pub const RENDER_DISK_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
/// 自上次 trim 起累计写入超过该值就再 trim 一次。
const TRIM_INTERVAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RenderCache {
    root: PathBuf,
    written_since_trim: std::sync::Arc<AtomicU64>,
}

impl RenderCache {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            written_since_trim: std::sync::Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn book_dir(&self, book_id: &str) -> PathBuf {
        self.root.join(book_id)
    }

    fn file_path(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) -> PathBuf {
        self.book_dir(book_id)
            .join(format!("{index:06}@{req_w}x{req_h}.jpg"))
    }

    /// 命中返回成品 JPEG 字节。
    pub fn get(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) -> Option<Vec<u8>> {
        let mut f = std::fs::File::open(self.file_path(book_id, index, req_w, req_h)).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    /// 落盘（原子写：tmp + rename），失败静默（缓存永远不该拖垮主流程）。
    pub fn put(&self, book_id: &str, index: u32, req_w: u32, req_h: u32, bytes: &[u8]) {
        let dir = self.book_dir(book_id);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let final_path = self.file_path(book_id, index, req_w, req_h);
        let tmp = dir.join(format!(".tmp-{index:06}@{req_w}x{req_h}"));
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &final_path);
            self.written_since_trim.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// 条漫切片存取：文件名 `{index:06}t{tile:02}@{w}.jpg`。
    pub fn get_tile(&self, book_id: &str, index: u32, tile: u32, w: u32) -> Option<Vec<u8>> {
        let mut f = std::fs::File::open(
            self.book_dir(book_id)
                .join(format!("{index:06}t{tile:02}@{w}.jpg")),
        )
        .ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    pub fn put_tile(&self, book_id: &str, index: u32, tile: u32, w: u32, bytes: &[u8]) {
        let dir = self.book_dir(book_id);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let final_path = dir.join(format!("{index:06}t{tile:02}@{w}.jpg"));
        let tmp = dir.join(format!(".tmp-{index:06}t{tile:02}@{w}"));
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &final_path);
        } else {
            let _ = std::fs::remove_file(&tmp);
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
        let Ok(rd) = std::fs::read_dir(&self.root) else { return 0 };
        for e in rd.flatten() {
            let book_dir = e.path();
            if !book_dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&book_dir) else { continue };
            for f in files.flatten() {
                let name = f.file_name();
                let name = name.to_string_lossy();
                // 文件名形如 `000000@240x240.jpg`：index 段为 000000 即首页。
                if name.starts_with("000000@") {
                    if std::fs::remove_file(f.path()).is_ok() {
                        n += 1;
                    }
                }
            }
            let _ = std::fs::remove_dir(&book_dir); // 空目录顺手清掉
        }
        n
    }

    /// 清空整个渲染缓存。
    pub fn clear_all(&self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }

    /// 统计磁盘占用（字节）。
    pub fn disk_bytes(&self) -> u64 {
        walk_size(&self.root)
    }

    /// 超预算按 mtime 从旧到新删除，直到 ≤ budget。启动与大量写入后调用。
    pub fn trim(&self, budget: u64) {
        if self.disk_bytes() <= budget {
            return;
        }
        let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
        collect(&self.root, &mut files);
        files.sort_by_key(|(t, _, _)| *t);
        let mut total: u64 = files.iter().map(|(_, _, s)| s).sum();
        for (_, path, size) in files {
            if total <= budget {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
        cleanup_empty_dirs(&self.root);
        self.written_since_trim.store(0, Ordering::Relaxed);
    }

    /// 写入量累积过阈值时在后台线程 trim（不阻塞请求）。
    pub fn maybe_trim(&self, budget: u64) {
        if self.written_since_trim.load(Ordering::Relaxed) > TRIM_INTERVAL_BYTES {
            let this = self.clone();
            std::thread::spawn(move || this.trim(budget));
        }
    }
}

fn walk_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(md) = e.metadata() {
                total += md.len();
            }
        }
    }
    total
}

fn collect(dir: &Path, out: &mut Vec<(std::time::SystemTime, PathBuf, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if let Ok(md) = e.metadata() {
            let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            out.push((mtime, p, md.len()));
        }
    }
}

fn cleanup_empty_dirs(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            // remove_dir 只删空目录，非空自动失败，无需预检。
            let _ = std::fs::remove_dir(&p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_remove_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mr-rc-{}", std::process::id()));
        let rc = RenderCache::new(dir.clone());
        rc.put("book1", 3, 800, 1200, b"jpeg-bytes");
        assert_eq!(rc.get("book1", 3, 800, 1200).as_deref(), Some(b"jpeg-bytes".as_slice()));
        assert_eq!(rc.get("book1", 4, 800, 1200), None);
        rc.remove_book("book1");
        assert_eq!(rc.get("book1", 3, 800, 1200), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
