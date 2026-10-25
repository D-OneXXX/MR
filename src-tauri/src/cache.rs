//! 内存预算制缓存（v3）：
//!
//! - `thumb_cache`: 缩略图 LRU，默认 128MB，可调；按字节记账；
//! - `page_cache`: 成品页 LRU，键 = (book, index, 请求宽, 请求高)，
//!   默认 128MB（与缩略图同一个预算滑杆），不再限 ±2 页窗口——
//!   翻回去的页直接命中内存（~0.1ms），这是毫秒级翻页的 L1；
//! - L1 只驻留 data_url：bytes 在 put 入口剥离（权威副本在磁盘 L2），
//!   同一页的内存占用接近减半；
//! - 磁盘渲染缓存（L2）见 render_cache.rs。

use std::hash::Hash;
use std::num::NonZeroUsize;

use lru::LruCache;
use parking_lot::Mutex;

use crate::pipeline::RenderedPage;

/// 默认缩略图/页缓存预算：各 128MB。
pub const DEFAULT_BUDGET_BYTES: u64 = 128 * 1024 * 1024;

fn page_bytes(p: &RenderedPage) -> usize {
    // L1 只存 data_url（bytes 在 put 入口剥离，落盘由 L2 负责），
    // 记账按实际驻留的字符串长度。
    p.data_url.len()
}

struct ByteLru<K: Hash + Eq> {
    inner: LruCache<K, (RenderedPage, usize)>,
    bytes: u64,
    limit: u64,
}

impl<K: Hash + Eq + Clone> ByteLru<K> {
    fn new(limit_bytes: u64, cap_entries: usize) -> Self {
        Self {
            inner: LruCache::new(
                NonZeroUsize::new(cap_entries.max(16)).expect("cap>0"),
            ),
            bytes: 0,
            limit: limit_bytes.max(1),
        }
    }

    fn get(&mut self, k: &K) -> Option<RenderedPage> {
        self.inner.get(k).map(|(p, _)| p.clone())
    }

    fn put(&mut self, k: K, page: RenderedPage) {
        let size = page_bytes(&page);
        if size as u64 > self.limit {
            // 单张超预算：不缓存，直接返回调用方使用即可。
            return;
        }
        if let Some((_, old)) = self.inner.pop(&k) {
            self.bytes = self.bytes.saturating_sub(old as u64);
        }
        while !self.inner.is_empty() && self.bytes + size as u64 > self.limit {
            if let Some((_, (_, s))) = self.inner.pop_lru() {
                self.bytes = self.bytes.saturating_sub(s as u64);
            } else {
                break;
            }
        }
        self.bytes += size as u64;
        self.inner.put(k, (page, size));
    }

    fn set_limit(&mut self, limit_bytes: u64) {
        self.limit = limit_bytes.max(1);
        while self.bytes > self.limit {
            if let Some((_, (_, s))) = self.inner.pop_lru() {
                self.bytes = self.bytes.saturating_sub(s as u64);
            } else {
                break;
            }
        }
    }

    /// 弹出所有匹配前缀的键（remove_book 用）。
    fn remove_by<F: Fn(&K) -> bool>(&mut self, f: F) {
        let keys: Vec<K> = self
            .inner
            .iter()
            .filter(|(k, _)| f(k))
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            // lru 0.12.5 的 pop 直接返回 V（非 (K,V)）。
            if let Some((_, s)) = self.inner.pop(&k) {
                self.bytes = self.bytes.saturating_sub(s as u64);
            }
        }
    }
}

type PageKey = (String, u32, u32, u32); // (book, index, req_w, req_h)
type TileKey = (String, u32, u32, u32); // (book, index, tile, render_w)

/// 全局缓存：缩略图 LRU + 成品页 LRU + 条漫切片 LRU。内部 `parking_lot::Mutex`
/// （临界区极短、无 await，满足 tokio 异步 command 约束）。
pub struct ImageCache {
    thumbs: Mutex<ByteLru<String>>,
    pages: Mutex<ByteLru<PageKey>>,
    /// 条漫切片：预算固定 48MB（切片体积小、翻滚复用率高）。
    tiles: Mutex<ByteLru<TileKey>>,
}

/// 条漫切片缓存预算。
pub const WEBTOON_BUDGET_BYTES: u64 = 48 * 1024 * 1024;

impl ImageCache {
    pub fn new() -> Self {
        Self {
            thumbs: Mutex::new(ByteLru::new(DEFAULT_BUDGET_BYTES, 512)),
            pages: Mutex::new(ByteLru::new(DEFAULT_BUDGET_BYTES, 512)),
            tiles: Mutex::new(ByteLru::new(WEBTOON_BUDGET_BYTES, 512)),
        }
    }

    /// 缩略图命中则返回克隆。
    pub fn get_thumb(&self, book_id: &str) -> Option<RenderedPage> {
        self.thumbs.lock().get(&book_id.to_string())
    }

    pub fn put_thumb(&self, book_id: &str, mut page: RenderedPage) {
        // 与 put_page 同理：L1 只留 data_url。
        page.bytes = Vec::new();
        self.thumbs.lock().put(book_id.to_string(), page);
    }

    /// 设置缩略图与页缓存预算（同一滑杆，字节），超限立即收缩。
    pub fn set_budgets(&self, limit_bytes: u64) {
        self.thumbs.lock().set_limit(limit_bytes);
        self.pages.lock().set_limit(limit_bytes);
    }

    /// 页缓存：命中 (book, index, req_w, req_h) 返回克隆。
    pub fn get_page(&self, book_id: &str, index: u32, req_w: u32, req_h: u32) -> Option<RenderedPage> {
        self.pages
            .lock()
            .get(&(book_id.to_string(), index, req_w, req_h))
    }

    pub fn put_page(&self, book_id: &str, index: u32, req_w: u32, req_h: u32, mut page: RenderedPage) {
        // L1 只留 data_url：bytes 的权威副本在磁盘 L2，双份驻留等于浪费一半预算。
        page.bytes = Vec::new();
        self.pages
            .lock()
            .put((book_id.to_string(), index, req_w, req_h), page);
    }

    /// 删除书籍时级联清理：该书缩略图 + 全部页缓存 + 条漫切片。
    pub fn remove_book(&self, book_id: &str) {
        self.thumbs.lock().remove_by(|k| k == book_id);
        self.pages
            .lock()
            .remove_by(|(b, _, _, _)| b == book_id);
        self.tiles.lock().remove_by(|(b, _, _, _)| b == book_id);
    }

    /// 阅读器退出时清空页缓存与条漫切片（缩略图 LRU 保留）。
    pub fn clear_pages(&self) {
        {
            let mut p = self.pages.lock();
            p.inner.clear();
            p.bytes = 0;
        }
        let mut t = self.tiles.lock();
        t.inner.clear();
        t.bytes = 0;
    }

    /// 清空缩略图 LRU（「重新生成缩略图」用；磁盘侧由 render_cache 清）。
    pub fn clear_thumbs(&self) {
        self.thumbs.lock().inner.clear();
        self.thumbs.lock().bytes = 0;
    }

    /// 条漫切片缓存（虚拟化滚动的高频小对象，独立 48MB 预算）。
    pub fn get_tile(&self, book_id: &str, index: u32, tile: u32, w: u32) -> Option<RenderedPage> {
        self.tiles.lock().get(&(book_id.to_string(), index, tile, w))
    }

    pub fn put_tile(&self, book_id: &str, index: u32, tile: u32, w: u32, mut page: RenderedPage) {
        // 同页缓存：只驻留 data_url。
        page.bytes = Vec::new();
        self.tiles
            .lock()
            .put((book_id.to_string(), index, tile, w), page);
    }

    /// (总字节, 总预算, 页数, 缩略图数, 条漫字节, 条漫片数)
    pub fn stats(&self) -> (u64, u64, usize, usize, u64, usize) {
        let t = self.thumbs.lock();
        let p = self.pages.lock();
        let wt = self.tiles.lock();
        (
            t.bytes + p.bytes,
            t.limit + p.limit,
            p.inner.len(),
            t.inner.len(),
            wt.bytes,
            wt.inner.len(),
        )
    }

    /// 测试辅助：当前页缓存条数。
    #[cfg(test)]
    pub fn page_entries(&self) -> usize {
        self.pages.lock().inner.len()
    }
}

impl Default for ImageCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::RenderedPage;

    fn fake_page(bytes: usize) -> RenderedPage {
        RenderedPage {
            width: 100,
            height: 100,
            orig_width: 100,
            orig_height: 100,
            mime: "image/jpeg".into(),
            data_url: format!("data:image/jpeg;base64,{}", "a".repeat(bytes)),
            bytes: vec![0u8; bytes],
        }
    }

    #[test]
    fn thumb_lru_evicts_by_bytes() {
        // 记账 = data_url 长度（fake_page(400) 的 data_url = 23 前缀 + 400）。
        let mut lru: ByteLru<String> = ByteLru::new(1000, 64);
        lru.put("a".into(), fake_page(400));
        lru.put("b".into(), fake_page(400));
        assert!(lru.get(&"a".to_string()).is_some());
        // 触达 a 后再放入 c：应淘汰最久未用的 b，总字节 ≤ 预算。
        lru.put("c".into(), fake_page(400));
        assert!(lru.get(&"b".to_string()).is_none());
        assert!(lru.get(&"a".to_string()).is_some());
        assert!(lru.get(&"c".to_string()).is_some());
        assert!(lru.bytes <= 1000);
    }

    #[test]
    fn page_lru_keeps_more_than_window_and_evicts_by_bytes() {
        let cache = ImageCache::new();
        // 默认 128MB 预算：200 张小页全部留在内存（旧 ±2 窗口做不到）。
        for i in 0..200u32 {
            cache.put_page("book1", i, 800, 1200, fake_page(1000));
        }
        assert_eq!(cache.page_entries(), 200);
        assert!(cache.get_page("book1", 0, 800, 1200).is_some());
        assert!(cache.get_page("book1", 199, 800, 1200).is_some());
        // 不同尺寸键互不混淆。
        assert!(cache.get_page("book1", 0, 400, 600).is_none());
    }

    #[test]
    fn set_budgets_shrinks_immediately() {
        let cache = ImageCache::new();
        for i in 0..5 {
            cache.put_thumb(&format!("book{i}"), fake_page(10_000));
        }
        cache.put_page("bookX", 0, 100, 100, fake_page(10_000));
        cache.set_budgets(15_000);
        let (bytes, limit, _, _, _, _) = cache.stats();
        assert!(bytes <= 30_000, "bytes {bytes}");
        assert!(bytes <= limit);
    }

    #[test]
    fn remove_book_evicts_thumb_and_pages() {
        let cache = ImageCache::new();
        cache.put_thumb("bookA", fake_page(10));
        cache.put_page("bookA", 0, 100, 100, fake_page(10));
        cache.put_page("bookA", 1, 100, 100, fake_page(10));
        cache.put_thumb("bookB", fake_page(10));
        cache.put_page("bookB", 0, 100, 100, fake_page(10));
        cache.remove_book("bookA");
        assert!(cache.get_thumb("bookA").is_none());
        assert!(cache.get_page("bookA", 0, 100, 100).is_none());
        assert!(cache.get_page("bookA", 1, 100, 100).is_none());
        assert!(cache.get_thumb("bookB").is_some());
        assert!(cache.get_page("bookB", 0, 100, 100).is_some());
    }

    #[test]
    fn clear_pages_keeps_thumbs() {
        let cache = ImageCache::new();
        cache.put_thumb("bookA", fake_page(10));
        cache.put_page("bookA", 0, 100, 100, fake_page(10));
        cache.clear_pages();
        assert!(cache.get_page("bookA", 0, 100, 100).is_none());
        assert!(cache.get_thumb("bookA").is_some());
    }
}
