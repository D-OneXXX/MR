//! 全局应用状态（`AppState` 的真实后端形态）：
//! settings（内存 + SQLite 持久化）/ SQLite 句柄 / 图片预算缓存
//! / 常开源句柄池 / 磁盘渲染缓存。

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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

pub(crate) fn effective_online_headers(saved: &str, session: Option<&str>) -> String {
    session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(saved)
        .to_string()
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

pub(crate) struct HandoffRuntime {
    pub port: u16,
    pub token: String,
    pub callback_url: String,
    pub allow_session_headers: bool,
    pub script: String,
    pub cancel: Arc<AtomicBool>,
}

pub(crate) struct HandoffStatusSnapshot {
    pub port: u16,
    pub pairing_token: String,
    pub callback_url: String,
    pub received_chapters: u32,
    pub allow_session_headers: bool,
    pub script: String,
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// 进程内会话临时请求头；优先于 Settings.online_headers，绝不持久化/记日志。
    pub session_online_headers: Mutex<Option<String>>,
    pub db: DbSlot,
    pub cache: ImageCache,
    /// 阶段三:OCR/翻译共用一个连接池化的 HTTP 客户端。
    pub http: reqwest::Client,
    /// 常开源句柄池（book_id → 已打开的 zip/目录），热路径免重复开卷。
    pub sources: Mutex<HashMap<String, Arc<SourceHandle>>>,
    /// 源句柄代际：清单/设置/删除变化时递增，防止旧数据打开的新句柄插回池中。
    source_epoch: AtomicU64,
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
    handoff_runtime: Mutex<Option<HandoffRuntime>>,
    handoff_received: AtomicU32,
    pub _version: u64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            session_online_headers: Mutex::new(None),
            db: DbSlot::new(),
            cache: ImageCache::new(),
            http: reqwest::Client::new(),
            sources: Mutex::new(HashMap::new()),
            source_epoch: AtomicU64::new(0),
            prefetching: Mutex::new(HashSet::new()),
            tile_lock: Mutex::new(()),
            webtoon_layouts: Mutex::new(HashMap::new()),
            render: RenderCache::new(default_render_root()),
            db_path: Mutex::new(std::path::PathBuf::new()),
            handoff_runtime: Mutex::new(None),
            handoff_received: AtomicU32::new(0),
            _version: 3,
        }
    }

    /// 开始新的 handoff 会话；旧会话会被取消，计数归零。
    pub(crate) fn begin_handoff(&self, runtime: HandoffRuntime) -> Arc<AtomicBool> {
        let cancel = runtime.cancel.clone();
        let mut slot = self.handoff_runtime.lock();
        if let Some(previous) = slot.replace(runtime) {
            previous.cancel.store(true, Ordering::SeqCst);
        }
        self.handoff_received.store(0, Ordering::SeqCst);
        cancel
    }

    /// 仅当当前会话仍是该 flag 时清理，避免新会话被旧线程误清。
    pub(crate) fn finish_handoff(&self, flag: &Arc<AtomicBool>) {
        let mut slot = self.handoff_runtime.lock();
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.cancel, flag))
        {
            *slot = None;
        }
    }

    pub(crate) fn cancel_handoff(&self) {
        if let Some(runtime) = self.handoff_runtime.lock().take() {
            runtime.cancel.store(true, Ordering::SeqCst);
        }
    }

    pub(crate) fn handoff_status(&self) -> Option<HandoffStatusSnapshot> {
        let slot = self.handoff_runtime.lock();
        let runtime = slot.as_ref()?;
        Some(HandoffStatusSnapshot {
            port: runtime.port,
            pairing_token: runtime.token.clone(),
            callback_url: runtime.callback_url.clone(),
            received_chapters: self.handoff_received.load(Ordering::SeqCst),
            allow_session_headers: runtime.allow_session_headers,
            script: runtime.script.clone(),
        })
    }

    /// 只累加当前会话的导入话数；旧会话在新会话启动后的回传不会污染计数。
    pub(crate) fn add_handoff_received(&self, flag: &Arc<AtomicBool>, count: u32) {
        let slot = self.handoff_runtime.lock();
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.cancel, flag))
        {
            self.handoff_received.fetch_add(count, Ordering::SeqCst);
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
    ///
    /// 打开句柄前记录源代际；插入池前复核。若期间发生清单更新/设置变化/删除，
    /// 丢弃本次句柄并用新数据有界重试一次，避免旧 meta 或旧代理/请求头打开的
    /// 句柄污染池。第二次仍变化则返回可读错误。
    pub fn source_handle_for_book(
        &self,
        book_id: &str,
    ) -> Result<Arc<SourceHandle>, crate::source::BackendError> {
        self.source_handle_for_book_checked(book_id, true)
    }

    fn source_handle_for_book_checked(
        &self,
        book_id: &str,
        allow_retry: bool,
    ) -> Result<Arc<SourceHandle>, crate::source::BackendError> {
        let epoch = self.source_epoch.load(Ordering::SeqCst);
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
            let session_headers = self.session_online_headers.lock().clone();
            let headers = effective_online_headers(&s.online_headers, session_headers.as_deref());
            let transport = crate::online::http::UreqTransport::new(&s.online_proxy, &headers)?;
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
        if self.source_epoch.load(Ordering::SeqCst) != epoch {
            drop(pool);
            return if allow_retry {
                self.source_handle_for_book_checked(book_id, false)
            } else {
                Err(crate::source::BackendError::Msg(
                    "源配置已变化，请重试".into(),
                ))
            };
        }
        if pool.len() >= 16 {
            pool.clear();
        }
        pool.insert(book_id.to_string(), handle.clone());
        Ok(handle)
    }

    /// 使全部常开源句柄失效：先递增代际，再清空池。
    ///
    /// 必须先递增再清空：反向顺序会让“旧代际读取、清空后插入”的句柄漏网。
    /// 残留竞态：在途预取/后台渲染无法撤回，旧页可能在此后写回 L1/L2；
    /// 这里只保证句柄池不插入旧配置句柄，不充当 L2 的 generation key。
    pub fn invalidate_sources(&self) {
        let mut pool = self.sources.lock();
        self.source_epoch.fetch_add(1, Ordering::SeqCst);
        pool.clear();
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
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    use rusqlite::Connection;

    use super::{effective_online_headers, AppState};
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
    fn invalidate_sources_clears_pool_and_advances_epoch() {
        let state = test_state();
        let dir = temp_dir("invalidate");
        write_tiny_png(&dir.join("001.png"));
        let path = dir.to_string_lossy().to_string();
        let book_id = crate::db::book_id_for_path(&path);
        state
            .db
            .with(|conn| {
                crate::db::upsert_book(conn, &book_id, &path, "失效测试", 1)
                    .map_err(|e| e.to_string())
            })
            .expect("写入本地书");

        let first = state.source_handle_for_book(&book_id).expect("打开本地书");
        assert!(state.sources.lock().contains_key(&book_id));

        let before = state.source_epoch.load(Ordering::SeqCst);
        state.invalidate_sources();
        assert_eq!(state.source_epoch.load(Ordering::SeqCst), before + 1);
        assert!(state.sources.lock().is_empty(), "失效后句柄池应为空");

        let second = state
            .source_handle_for_book(&book_id)
            .expect("失效后应能重新打开");
        assert!(
            !Arc::ptr_eq(&first, &second),
            "失效后应返回新打开的句柄，而不是旧池中的 Arc"
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
            series_id: None,
            series_title: None,
            chapter_index: None,
            next_url: None,
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
    fn session_headers_override_saved_headers_until_cleared() {
        assert_eq!(
            effective_online_headers("Cookie: saved", None),
            "Cookie: saved"
        );
        assert_eq!(
            effective_online_headers("Cookie: saved", Some("Cookie: session")),
            "Cookie: session"
        );
        assert_eq!(
            effective_online_headers("Cookie: saved", Some("   ")),
            "Cookie: saved"
        );
    }

    fn handoff_runtime(cancel: Arc<AtomicBool>) -> super::HandoffRuntime {
        super::HandoffRuntime {
            port: 12345,
            token: "token".into(),
            callback_url: "http://127.0.0.1:12345/handoff?token=token".into(),
            allow_session_headers: true,
            script: "script".into(),
            cancel,
        }
    }

    #[test]
    fn handoff_status_tracks_runtime_and_received_count() {
        let state = AppState::new();
        assert!(state.handoff_status().is_none());

        let flag = state.begin_handoff(handoff_runtime(Arc::new(AtomicBool::new(false))));
        let status = state.handoff_status().expect("应处于活动状态");
        assert_eq!(status.port, 12345);
        assert_eq!(status.pairing_token, "token");
        assert!(status.allow_session_headers);
        assert_eq!(status.received_chapters, 0);

        state.add_handoff_received(&flag, 2);
        assert_eq!(state.handoff_status().unwrap().received_chapters, 2);
        state.cancel_handoff();
        assert!(state.handoff_status().is_none());
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn handoff_cancel_flag_is_replaceable_and_finished() {
        let state = AppState::new();
        let flag = state.begin_handoff(handoff_runtime(Arc::new(AtomicBool::new(false))));
        assert!(!flag.load(Ordering::SeqCst));
        state.cancel_handoff();
        assert!(flag.load(Ordering::SeqCst));

        let flag = state.begin_handoff(handoff_runtime(Arc::new(AtomicBool::new(false))));
        state.finish_handoff(&flag);
        state.cancel_handoff();
        assert!(
            !flag.load(Ordering::SeqCst),
            "finished session must not be cancellable"
        );
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
