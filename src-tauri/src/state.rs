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

    pub fn set_db_path(&self, p: std::path::PathBuf) {
        *self.db_path.lock() = p;
    }

    pub fn db_path(&self) -> std::path::PathBuf {
        self.db_path.lock().clone()
    }
}
