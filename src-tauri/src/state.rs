//! 全局应用状态（`AppState` 的真实后端形态）：
//! settings（内存 + SQLite 持久化）/ SQLite 句柄 / 图片预算缓存
//! / 常开源句柄池 / 磁盘渲染缓存。

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::cache::ImageCache;
use crate::render_cache::RenderCache;
use crate::source::SourceHandle;
use crate::Settings;

/// SQLite 打开失败时也允许应用启动（书库命令返回可读错误）。
pub struct DbSlot {
    inner: Mutex<Option<Connection>>,
}

impl DbSlot {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn set(&self, conn: Connection) {
        *self.inner.lock() = Some(conn);
    }

    pub fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String> {
        let guard = self.inner.lock();
        match guard.as_ref() {
            Some(conn) => f(conn),
            None => Err("数据库尚未初始化".to_string()),
        }
    }
}

/// 渲染缓存根目录：环境变量优先（测试隔离），否则默认本地数据目录。
fn default_render_root() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("MR_RENDER_CACHE_DIR") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    dirs::data_local_dir()
        .map(|d| d.join("com.local.manga-reader").join("render_cache"))
        .unwrap_or_else(std::env::temp_dir)
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub db: DbSlot,
    pub cache: ImageCache,
    /// 阶段三:OCR/翻译共用一个连接池化的 HTTP 客户端。
    pub http: reqwest::Client,
    /// 常开源句柄池（book_id → 已打开的 zip/目录），热路径免重复开卷。
    pub sources: Mutex<HashMap<String, Arc<SourceHandle>>>,
    /// 邻页预取在途标记，防止快速翻页时重复渲染同一页。
    pub prefetching: Mutex<HashSet<(String, u32, u32, u32)>>,
    /// 条漫切片"整页物化"全局锁：一次只解码一张长图到显示宽度，
    /// 切完所有片立即释放栅格（峰值内存 = 单张缩放后栅格）。
    pub tile_lock: Mutex<()>,
    /// 条漫布局缓存（book_id → 逐页源尺寸）：切换条漫免重新读全部页头。
    pub webtoon_layouts: Mutex<HashMap<String, Arc<Vec<(u32, u32)>>>>,
    /// 磁盘渲染缓存（成品 JPEG，二次访问 ~1ms）。
    pub render: RenderCache,
    db_path: Mutex<std::path::PathBuf>,
    pub _version: u64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            db: DbSlot::new(),
            cache: ImageCache::new(),
            http: reqwest::Client::new(),
            sources: Mutex::new(HashMap::new()),
            prefetching: Mutex::new(HashSet::new()),
            tile_lock: Mutex::new(()),
            webtoon_layouts: Mutex::new(HashMap::new()),
            render: RenderCache::new(default_render_root()),
            db_path: Mutex::new(std::path::PathBuf::new()),
            _version: 3,
        }
    }

    /// 取（或打开）某书的常开句柄；池满 16 本时整体清空重开（廉价兜底驱逐）。
    pub fn source_handle(
        &self,
        book_id: &str,
        path: &str,
    ) -> Result<Arc<SourceHandle>, crate::source::BackendError> {
        {
            let pool = self.sources.lock();
            if let Some(h) = pool.get(book_id) {
                return Ok(h.clone());
            }
        }
        let handle = Arc::new(SourceHandle::open(std::path::Path::new(path))?);
        let mut pool = self.sources.lock();
        if pool.len() >= 16 {
            pool.clear();
        }
        pool.insert(book_id.to_string(), handle.clone());
        Ok(handle)
    }

    /// 按 bookId 打开本地或在线源，并复用 16 本常开池。
    pub fn source_handle_for_book(
        &self,
        book_id: &str,
    ) -> Result<Arc<SourceHandle>, crate::source::BackendError> {
        {
            let pool = self.sources.lock();
            if let Some(h) = pool.get(book_id) {
                return Ok(h.clone());
            }
        }
        let (path, source_type, meta_json) = self
            .db
            .with(|conn| {
                crate::db::get_book(conn, book_id)
                    .map_err(|e| e.to_string())?
                    .map(|b| (b.path, b.source_type, b.meta_json))
                    .ok_or_else(|| "书籍不存在".to_string())
            })
            .map_err(crate::source::BackendError::Msg)?;

        let handle = if source_type == "local" {
            Arc::new(SourceHandle::open(std::path::Path::new(&path))?)
        } else if source_type == "generic_manga" {
            let stored: crate::online::StoredMeta = serde_json::from_str(&meta_json)
                .map_err(|e| crate::source::BackendError::Msg(format!("在线书元数据损坏：{e}")))?;
            let s = self.settings.lock().clone();
            let transport =
                crate::online::http::UreqTransport::new(&s.online_proxy, &s.online_headers)?;
            Arc::new(SourceHandle::open_online(
                path,
                stored.pages,
                Arc::new(transport),
                s.online_concurrency as usize,
            )?)
        } else if source_type == "anime" {
            return Err(crate::source::BackendError::Msg(
                "第二阶段视频源尚未实现".into(),
            ));
        } else {
            return Err(crate::source::BackendError::Msg(format!(
                "未知来源类型：{source_type}"
            )));
        };

        let mut pool = self.sources.lock();
        if pool.len() >= 16 {
            pool.clear();
        }
        pool.insert(book_id.to_string(), handle.clone());
        Ok(handle)
    }

    pub fn set_db_path(&self, p: std::path::PathBuf) {
        *self.db_path.lock() = p;
    }

    pub fn db_path(&self) -> std::path::PathBuf {
        self.db_path.lock().clone()
    }
}

#[cfg(test)]
mod tests {
    //! `source_handle_for_book` 的离线覆盖：内存 SQLite + 本地临时图片，
    //! 在线分支只构造 `UreqTransport`（read 前无 I/O），不发起任何网络请求。

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use rusqlite::Connection;

    use super::AppState;
    use crate::source::{BackendError, SourceHandle};

    fn test_state() -> AppState {
        let state = AppState::new();
        let conn = Connection::open_in_memory().expect("打开内存数据库");
        crate::db::init_schema(&conn).expect("初始化表结构");
        state.db.set(conn);
        state
    }

    fn err_text(result: Result<Arc<SourceHandle>, BackendError>) -> String {
        match result {
            Ok(_) => panic!("应返回错误，实际打开了源"),
            Err(e) => e.to_string(),
        }
    }

    /// 独立临时目录（进程号 + 纳秒 + 序号），避免并行测试互撞。
    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mr-state-{}-{tag}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn write_tiny_png(path: &Path) {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .expect("编码测试 PNG");
        std::fs::write(path, buf).expect("写入测试 PNG");
    }

    #[test]
    fn source_handle_for_book_reports_missing_book() {
        let state = test_state();
        let err = err_text(state.source_handle_for_book("no-such-book"));
        assert_eq!(err, "书籍不存在");
    }

    #[test]
    fn source_handle_for_book_opens_local_book_and_reuses_pool() {
        let state = test_state();
        let dir = temp_dir("local");
        write_tiny_png(&dir.join("001.png"));
        let path = dir.to_string_lossy().to_string();
        let book_id = crate::db::book_id_for_path(&path);
        state
            .db
            .with(|conn| {
                crate::db::upsert_book(conn, &book_id, &path, "本地测试", 1)
                    .map_err(|e| e.to_string())
            })
            .expect("写入本地书");

        let first = state.source_handle_for_book(&book_id).expect("打开本地书");
        assert_eq!(first.page_count().unwrap(), 1);
        assert_eq!(first.path(), Path::new(&path));

        let second = state
            .source_handle_for_book(&book_id)
            .expect("第二次应命中常开池");
        assert!(
            Arc::ptr_eq(&first, &second),
            "同一 bookId 的第二次调用应返回同一个 Arc"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn source_handle_for_book_opens_online_book_and_reuses_pool() {
        let state = test_state();
        let canonical = "http://example.test/gallery/1".to_string();
        let meta = crate::online::StoredMeta {
            schema: 1,
            manifest_hash: "hash".into(),
            fetched_at: "2026-10-19 00:00:00".into(),
            pages: vec![
                crate::online::PageRef {
                    url: "http://example.test/001.png".into(),
                    width: Some(1),
                    height: Some(1),
                },
                crate::online::PageRef {
                    url: "http://example.test/002.png".into(),
                    width: None,
                    height: None,
                },
            ],
        };
        let meta_json = serde_json::to_string(&meta).expect("序列化 StoredMeta");
        state
            .db
            .with(|conn| {
                crate::db::upsert_online_book(
                    conn,
                    "online-book",
                    &canonical,
                    "在线测试",
                    2,
                    "generic_manga",
                    &meta_json,
                )
                .map_err(|e| e.to_string())
            })
            .expect("写入在线书");

        let first = state
            .source_handle_for_book("online-book")
            .expect("打开在线书");
        // 在线源构造 UreqTransport 但不读页，因此离线安全。
        assert_eq!(first.page_count().unwrap(), 2);
        assert_eq!(first.path(), Path::new(&canonical));
        assert_eq!(first.entry_names().unwrap(), vec!["001.png", "002.png"]);

        let second = state
            .source_handle_for_book("online-book")
            .expect("第二次应命中常开池");
        assert!(
            Arc::ptr_eq(&first, &second),
            "在线书第二次调用应返回同一个 Arc"
        );
    }

    #[test]
    fn source_handle_for_book_rejects_anime_source() {
        let state = test_state();
        state
            .db
            .with(|conn| {
                crate::db::upsert_online_book(
                    conn,
                    "anime-book",
                    "http://example.test/anime/1",
                    "动画测试",
                    1,
                    "anime",
                    "{}",
                )
                .map_err(|e| e.to_string())
            })
            .expect("写入 anime 书");

        let err = err_text(state.source_handle_for_book("anime-book"));
        assert_eq!(err, "第二阶段视频源尚未实现");
    }

    #[test]
    fn source_handle_for_book_rejects_unknown_source_type() {
        let state = test_state();
        state
            .db
            .with(|conn| {
                crate::db::upsert_online_book(
                    conn,
                    "weird-book",
                    "http://example.test/weird/1",
                    "未知来源测试",
                    1,
                    "epub",
                    "{}",
                )
                .map_err(|e| e.to_string())
            })
            .expect("写入未知来源书");

        let err = err_text(state.source_handle_for_book("weird-book"));
        assert_eq!(err, "未知来源类型：epub");
    }
}
