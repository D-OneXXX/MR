//! 全局应用状态（`AppState` 的真实后端形态）：
//! settings（内存 + SQLite 持久化）/ SQLite 句柄 / 图片预算缓存
//! / 常开源句柄池 / 磁盘渲染缓存。

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::cache::ImageCache;
use crate::disk_cache::{self, OnlinePageCache};
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

    pub fn clear(&self) {
        *self.inner.lock() = None;
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

// ---------- 辅助会话注册表（受控 WebView 验证交接） ----------

/// 辅助会话 origin 的字节上限。
pub(crate) const MAX_ASSISTED_ORIGIN_BYTES: usize = 256;
/// 辅助会话 User-Agent 的字节上限。
pub(crate) const MAX_ASSISTED_USER_AGENT_BYTES: usize = 512;
/// 辅助会话请求头长度上限（Cookie 串可能较长，但必须有界）。
pub(crate) const MAX_ASSISTED_HEADERS_BYTES: usize = 8 * 1024;

/// 辅助会话（origin → 上下文）的进程内存态快照。
///
/// 合规红线（与 `session_online_headers` 同级）：
/// - 只驻留内存，绝不写 SQLite、绝不写日志；
/// - `headers` 只来自用户显式提供的那份，绝不从 WebView 抓取 Cookie；
/// - `user_agent` 非机密，可按 origin 复用到同源直读请求。
#[derive(Clone, Default)]
pub struct AssistedSession {
    /// 受控 WebView 自己的 User-Agent 字符串（非机密）。
    pub user_agent: Option<String>,
    /// 用户显式提供的请求头原文（机密，仅内存）。
    pub headers: Option<String>,
}

/// 手工实现 Debug：请求头是机密，调试输出里只显示「是否携带」，绝不打印内容。
impl std::fmt::Debug for AssistedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssistedSession")
            .field("user_agent", &self.user_agent)
            .field(
                "headers",
                &if self.headers.is_some() {
                    Some("<redacted>")
                } else {
                    None
                },
            )
            .finish()
    }
}

/// 归一化并校验辅助会话 origin：仅 http/https、无控制字符（含 CRLF）、无 userinfo、长度受限。
///
/// 返回规范化的 origin（`scheme://host[:port]`，默认端口已归一）。
/// WHATWG URL 解析会吞掉 `\t`/`\r`/`\n`，因此必须先显式拒绝控制字符。
pub(crate) fn normalize_assisted_origin(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_ASSISTED_ORIGIN_BYTES {
        return Err(format!(
            "origin 过长（上限 {MAX_ASSISTED_ORIGIN_BYTES} 字节）"
        ));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err("origin 含非法字符".into());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("origin 不能为空".into());
    }
    let u = url::Url::parse(trimmed).map_err(|_| "origin 无效".to_string())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("origin 仅支持 http/https".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("origin 不得包含用户名或密码".into());
    }
    if u.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("origin 缺少主机名".into());
    }
    Ok(u.origin().ascii_serialization())
}

/// 校验辅助会话 User-Agent：非空、无控制字符（含 CRLF）、长度受限。
pub(crate) fn normalize_assisted_user_agent(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_ASSISTED_USER_AGENT_BYTES {
        return Err(format!(
            "userAgent 过长（上限 {MAX_ASSISTED_USER_AGENT_BYTES} 字节）"
        ));
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err("userAgent 含非法字符".into());
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("userAgent 不能为空".into());
    }
    Ok(trimmed.to_string())
}

/// 辅助会话注册表：origin → 辅助会话（进程内存，绝不持久化）。
pub struct AssistedSessionRegistry {
    sessions: Mutex<HashMap<String, AssistedSession>>,
}

impl Default for AssistedSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AssistedSessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 登记（或覆盖）某 origin 的辅助会话；origin 与 UA 均先校验。
    /// 返回规范化后的 origin。注册表只在内存里，绝不写库、绝不记日志。
    pub fn register(&self, origin: &str, session: AssistedSession) -> Result<String, String> {
        let canonical = normalize_assisted_origin(origin)?;
        let user_agent = match session.user_agent.as_deref() {
            Some(ua) => Some(normalize_assisted_user_agent(ua)?),
            None => None,
        };
        let headers = session
            .headers
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty());
        // 注册表自己再兜一层：长度上限 + 复用在线请求头的合法性校验
        // （拒绝 CRLF / 非法头名 / Host 等危险头），避免上游漏检把畸形头带进请求。
        if let Some(raw) = headers.as_deref() {
            if raw.len() > MAX_ASSISTED_HEADERS_BYTES {
                return Err(format!(
                    "请求头过长（上限 {MAX_ASSISTED_HEADERS_BYTES} 字节）"
                ));
            }
            crate::online::validate_headers(raw).map_err(|e| format!("请求头非法：{e}"))?;
        }
        let mut guard = self.sessions.lock();
        // 合并语义：本次没带的字段沿用旧值。
        // 否则一次「只带 UA、不带头」的登记会把已登记的会话头清空。
        let previous = guard.get(&canonical);
        let user_agent =
            user_agent.or_else(|| previous.and_then(|session| session.user_agent.clone()));
        let headers = headers.or_else(|| previous.and_then(|session| session.headers.clone()));
        guard.insert(
            canonical.clone(),
            AssistedSession {
                user_agent,
                headers,
            },
        );
        Ok(canonical)
    }

    /// 取某 origin 的辅助会话快照；origin 非法或未登记时返回 None。
    pub fn get(&self, origin: &str) -> Option<AssistedSession> {
        let canonical = normalize_assisted_origin(origin).ok()?;
        self.sessions.lock().get(&canonical).cloned()
    }

    /// 目标 URL 命中的辅助会话 UA；未命中返回 None（调用方回落到标准桌面 UA）。
    pub fn user_agent_for_url(&self, url: &url::Url) -> Option<String> {
        let origin = url.origin().ascii_serialization();
        self.sessions
            .lock()
            .get(&origin)
            .and_then(|session| session.user_agent.clone())
    }

    /// 目标 origin 命中的用户自备请求头（仅内存，不落库、不记日志）。
    pub fn headers_for_origin(&self, origin: &str) -> Option<String> {
        self.get(origin).and_then(|session| session.headers)
    }

    /// 目标 URL 的 origin 命中的用户自备请求头。
    ///
    /// 这是「按 origin 复用」的唯一入口：请求头只发给**当初登记它的那个站点**，
    /// 其它 origin 一律拿不到，避免上一站凭据泄漏到下一站。
    pub fn headers_for_url(&self, url: &url::Url) -> Option<String> {
        let origin = url.origin().ascii_serialization();
        self.sessions
            .lock()
            .get(&origin)
            .and_then(|session| session.headers.clone())
    }

    /// 已登记的 origin 数量（不含任何会话内容，仅计数）。
    pub fn len(&self) -> usize {
        self.sessions.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 清空注册表：停止 handoff 或清理在线痕迹时调用，确保上下文不残留。
    pub fn clear(&self) {
        self.sessions.lock().clear();
    }
}

/// 缓存根环境变量只接受绝对路径、末级目录名必须与缓存类型一致
/// （`render_cache` / `online_cache`），且不得等于数据目录或它的祖先。
/// 清理命令会 `remove_dir_all` 整个根，因此必须把误配挡在构造阶段。
fn safe_cache_root(
    raw: &str,
    fallback: std::path::PathBuf,
    expected_leaf: &str,
) -> std::path::PathBuf {
    let candidate = std::path::PathBuf::from(raw.trim());
    if !candidate.is_absolute() || candidate.parent().is_none() {
        return fallback;
    }
    if candidate.file_name().and_then(|name| name.to_str()) != Some(expected_leaf) {
        crate::logging::log_error(
            "cache",
            &format!("缓存根末级目录必须是 {expected_leaf}，已回落到默认目录"),
        );
        return fallback;
    }
    let candidate = std::fs::canonicalize(&candidate).unwrap_or(candidate);
    if let Ok(data) = crate::data_dir() {
        let data = std::fs::canonicalize(&data).unwrap_or(data);
        if candidate == data || data.starts_with(&candidate) {
            return fallback;
        }
    }
    candidate
}

/// 渲染缓存根目录：环境变量优先（测试隔离），否则 Tauri `app_cache_dir()`
/// 下的 `render_cache`；路径尚未安装时回落到旧本地目录（不丢历史缓存）。
fn default_render_root() -> std::path::PathBuf {
    let fallback = crate::paths::cache_dir()
        .map(|c| c.join("render_cache"))
        .or_else(|| {
            dirs::data_local_dir().map(|d| d.join("com.local.manga-reader").join("render_cache"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("manga-reader-render-cache"));
    if let Ok(p) = std::env::var("MR_RENDER_CACHE_DIR") {
        if !p.trim().is_empty() {
            return safe_cache_root(&p, fallback, "render_cache");
        }
    }
    fallback
}

/// 在线原图缓存根目录：与渲染缓存同级，便于统一统计与 LRU 淘汰。
fn default_online_cache_root() -> std::path::PathBuf {
    let fallback = crate::paths::cache_dir()
        .map(|c| c.join("online_cache"))
        .or_else(|| {
            dirs::data_local_dir().map(|d| d.join("com.local.manga-reader").join("online_cache"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("manga-reader-online-cache"));
    if let Ok(p) = std::env::var("MR_ONLINE_CACHE_DIR") {
        if !p.trim().is_empty() {
            return safe_cache_root(&p, fallback, "online_cache");
        }
    }
    fallback
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
    /// 辅助会话注册表（origin → UA / 用户自备请求头）；只在内存，绝不写库、绝不记日志。
    pub assisted_sessions: Arc<AssistedSessionRegistry>,
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
    #[allow(clippy::type_complexity)]
    pub webtoon_layouts: Mutex<HashMap<String, Arc<Vec<(u32, u32)>>>>,
    /// 磁盘渲染缓存（成品 JPEG，二次访问 ~1ms）。
    pub render: RenderCache,
    /// 在线原图磁盘 L2（URL+Referer 哈希，LRU）。
    pub online_cache: Arc<OnlinePageCache>,
    /// 磁盘缓存写入压力：累计超过阈值即后台统一 trim。
    cache_pressure: AtomicU64,
    db_path: Mutex<std::path::PathBuf>,
    /// 启动数据库自检的稳定错误码；None = 健康。
    db_error: Mutex<Option<String>>,
    handoff_runtime: Mutex<Option<HandoffRuntime>>,
    handoff_received: AtomicU32,
    /// 文件关联/命令行直开的待处理请求（FIFO）。
    ///
    /// 只驻留内存；请求由 `open_with` 入队，前端通过 `take_pending_open`
    /// 一次性消费。事件只是唤醒信号，重复事件不会重复打开同一本书。
    pending_open: Mutex<VecDeque<crate::open_with::OpenWithRequest>>,
    pub _version: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            session_online_headers: Mutex::new(None),
            assisted_sessions: Arc::new(AssistedSessionRegistry::new()),
            db: DbSlot::new(),
            cache: ImageCache::new(),
            http: reqwest::Client::new(),
            sources: Mutex::new(HashMap::new()),
            source_epoch: AtomicU64::new(0),
            prefetching: Mutex::new(HashSet::new()),
            tile_lock: Mutex::new(()),
            webtoon_layouts: Mutex::new(HashMap::new()),
            render: RenderCache::new(default_render_root()),
            online_cache: Arc::new(OnlinePageCache::new(default_online_cache_root())),
            cache_pressure: AtomicU64::new(0),
            db_path: Mutex::new(std::path::PathBuf::new()),
            db_error: Mutex::new(None),
            handoff_runtime: Mutex::new(None),
            handoff_received: AtomicU32::new(0),
            pending_open: Mutex::new(VecDeque::new()),
            _version: 3,
        }
    }

    /// 入队一次文件关联/命令行打开请求。只存内存。
    pub fn push_open_request(&self, request: crate::open_with::OpenWithRequest) {
        let mut queue = self.pending_open.lock();
        // 上限防御：极端情况下（外部脚本连续拉起）最多保留 16 条。
        if queue.len() >= 16 {
            queue.pop_front();
        }
        queue.push_back(request);
    }

    /// 消费下一条打开请求；前端循环调用直到 None。
    pub fn take_open_request(&self) -> Option<crate::open_with::OpenWithRequest> {
        self.pending_open.lock().pop_front()
    }

    /// 开始新的 handoff 会话；旧会话会被取消，计数归零，辅助会话上下文一并清空。
    pub(crate) fn begin_handoff(&self, runtime: HandoffRuntime) -> Arc<AtomicBool> {
        let cancel = runtime.cancel.clone();
        let mut slot = self.handoff_runtime.lock();
        if let Some(previous) = slot.replace(runtime) {
            previous.cancel.store(true, Ordering::SeqCst);
        }
        self.handoff_received.store(0, Ordering::SeqCst);
        // 新会话不复用旧会话的辅助上下文（UA/用户自备请求头只在内存里）。
        self.assisted_sessions.clear();
        cancel
    }

    /// 仅当当前会话仍是该 flag 时清理，避免新会话被旧线程误清。
    /// 返回 true 表示清理的就是当前会话（调用方据此清空辅助会话上下文）。
    pub(crate) fn finish_handoff(&self, flag: &Arc<AtomicBool>) -> bool {
        let mut slot = self.handoff_runtime.lock();
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.cancel, flag))
        {
            *slot = None;
            true
        } else {
            false
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

    // ---------- 辅助会话（受控 WebView 验证交接） ----------

    /// 登记辅助会话（origin → UA / 用户自备请求头）。
    ///
    /// 只驻留内存：绝不写 SQLite、绝不写日志；请求头只接受用户显式提供的那份。
    /// 返回规范化后的 origin。
    pub fn register_assisted_session(
        &self,
        origin: &str,
        session: AssistedSession,
    ) -> Result<String, String> {
        self.assisted_sessions.register(origin, session)
    }

    /// 取某 origin 的辅助会话快照；未登记返回 None。
    pub fn assisted_session(&self, origin: &str) -> Option<AssistedSession> {
        self.assisted_sessions.get(origin)
    }

    /// 目标 URL 命中的辅助会话 UA；未命中返回 None（回落到标准桌面 Chrome UA）。
    pub fn assisted_user_agent(&self, url: &url::Url) -> Option<String> {
        self.assisted_sessions.user_agent_for_url(url)
    }

    /// 清空辅助会话注册表：停止 handoff 或清理在线痕迹时调用。
    pub fn clear_assisted_sessions(&self) {
        self.assisted_sessions.clear();
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
        let (path, source_type, meta_json, format) = self
            .db
            .with(|conn| {
                crate::db::get_book(conn, book_id)
                    .map_err(|e| e.to_string())?
                    .map(|b| (b.path, b.source_type, b.meta_json, b.format))
                    .ok_or_else(|| "书籍不存在".to_string())
            })
            .map_err(crate::source::BackendError::Msg)?;

        // PDF-1：PDF 只做识别与入库，尚无渲染器（PDF-2）。
        // 在取页口统一拦下，避免用 ZIP/图片源的逻辑误读 PDF。
        if format == crate::db::BOOK_FORMAT_PDF {
            return Err(crate::source::BackendError::Msg(
                "PDF 阅读功能尚未实现（pdf-render-unsupported）".into(),
            ));
        }

        let handle = if source_type == "local" {
            Arc::new(SourceHandle::open(std::path::Path::new(&path))?)
        } else if source_type == "generic_manga" {
            let stored: crate::online::StoredMeta = serde_json::from_str(&meta_json)
                .map_err(|e| crate::source::BackendError::Msg(format!("在线书元数据损坏：{e}")))?;
            let s = self.settings.lock().clone();
            let session_headers = self.session_online_headers.lock().clone();
            let headers = effective_online_headers(&s.online_headers, session_headers.as_deref());
            // 带辅助会话上下文：命中已注册 origin 时复用该会话的 UA（内存态，不落库）。
            let transport = crate::online::http::UreqTransport::new_with_assisted(
                &s.online_proxy,
                &headers,
                self.assisted_sessions.clone(),
            )?;
            Arc::new(SourceHandle::open_online(
                book_id.to_string(),
                path,
                stored.pages,
                Arc::new(transport),
                s.online_concurrency as usize,
                Some(self.online_cache.clone()),
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

    /// 当前磁盘缓存软上限（字节）。内存设置只做展示，真正淘汰在空闲/启动时执行。
    pub fn disk_cache_limit_bytes(&self) -> u64 {
        disk_cache::budget_bytes(self.settings.lock().disk_cache_budget_mb)
    }

    /// (总占用, 渲染缓存, 在线原图缓存)
    pub fn disk_cache_totals(&self) -> (u64, u64, u64) {
        let render = self.render.disk_bytes();
        let online = self.online_cache.disk_bytes();
        (render.saturating_add(online), render, online)
    }

    /// 两个缓存根共用一个预算，按文件 mtime 最旧优先淘汰。
    pub fn trim_disk_cache(&self) -> u64 {
        self.cache_pressure.store(0, Ordering::Relaxed);
        let budget = self.disk_cache_limit_bytes();
        disk_cache::trim_total(&[self.render.root(), self.online_cache.root()], budget)
    }

    /// 累计写盘超过阈值时后台触发统一淘汰；由取页/切片路径在落盘后调用。
    /// 大章节连续阅读也能在超过 256MB 后尽快回到软上限，而不必等 5 分钟巡检。
    pub fn note_cache_write(self: &Arc<Self>, bytes: usize) {
        if bytes == 0 {
            return;
        }
        const TRIGGER_BYTES: u64 = 256 * 1024 * 1024;
        let total = self
            .cache_pressure
            .fetch_add(bytes as u64, Ordering::Relaxed)
            .saturating_add(bytes as u64);
        if total >= TRIGGER_BYTES {
            self.cache_pressure.store(0, Ordering::Relaxed);
            let state = self.clone();
            std::thread::spawn(move || {
                state.trim_disk_cache();
            });
        }
    }

    /// 后台执行统一淘汰，避免设置保存/翻页路径被大目录扫描阻塞。
    pub fn trim_disk_cache_async(self: &Arc<Self>) {
        let state = self.clone();
        std::thread::spawn(move || {
            let removed = state.trim_disk_cache();
            if removed > 0 {
                crate::logging::log_error(
                    "cache",
                    &format!("磁盘缓存超出软上限，已按 LRU 释放 {removed} 字节"),
                );
            }
        });
    }

    /// 删除一本书的全部派生缓存（内存、渲染 L2、在线原图 L2）。
    pub fn remove_book_caches(&self, book_id: &str) {
        self.cache.remove_book(book_id);
        self.render.remove_book(book_id);
        self.online_cache.remove_book(book_id);
    }

    pub fn set_db_path(&self, p: std::path::PathBuf) {
        *self.db_path.lock() = p;
    }

    pub fn db_path(&self) -> std::path::PathBuf {
        self.db_path.lock().clone()
    }

    /// 记录启动自检失败码（db-open-failed / db-schema-failed / db-quick-check-failed）。
    pub fn set_db_error(&self, code: &str) {
        *self.db_error.lock() = Some(code.to_string());
    }

    pub fn clear_db_error(&self) {
        *self.db_error.lock() = None;
    }

    pub fn db_error_code(&self) -> Option<String> {
        self.db_error.lock().clone()
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

    use super::{
        effective_online_headers, normalize_assisted_origin, safe_cache_root, AppState,
        AssistedSession, AssistedSessionRegistry, MAX_ASSISTED_ORIGIN_BYTES,
        MAX_ASSISTED_USER_AGENT_BYTES,
    };
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
    fn db_health_error_code_roundtrips() {
        let state = AppState::new();
        assert!(state.db_error_code().is_none());
        state.set_db_error("db-quick-check-failed");
        assert_eq!(
            state.db_error_code().as_deref(),
            Some("db-quick-check-failed")
        );
        state.clear_db_error();
        assert!(state.db_error_code().is_none());
    }

    #[test]
    fn cache_root_override_rejects_relative_and_file_system_root() {
        let fallback = std::path::PathBuf::from("safe-fallback");
        assert_eq!(
            safe_cache_root("relative/cache", fallback.clone(), "render_cache"),
            fallback
        );
        assert_eq!(
            safe_cache_root("   ", fallback.clone(), "render_cache"),
            fallback
        );
        #[cfg(windows)]
        assert_eq!(
            safe_cache_root(r"C:\", fallback.clone(), "render_cache"),
            fallback
        );
        // 末级目录不是缓存类型 → 拒绝（防止把任意目录交给 remove_dir_all）。
        #[cfg(windows)]
        assert_eq!(
            safe_cache_root(
                r"C:\Users\public\Documents",
                fallback.clone(),
                "render_cache"
            ),
            fallback
        );
        // 末级目录匹配的绝对路径才接受。
        #[cfg(windows)]
        assert_eq!(
            safe_cache_root(
                r"C:\Users\public\render_cache",
                fallback.clone(),
                "render_cache"
            ),
            std::path::PathBuf::from(r"C:\Users\public\render_cache")
        );
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
                    anchor: None,
                },
                crate::online::PageRef {
                    url: "http://example.test/002.png".into(),
                    width: None,
                    height: None,
                    anchor: None,
                },
            ],
            series_id: None,
            series_title: None,
            chapter_index: None,
            next_url: None,
            filtered: Vec::new(),
            filter_profile: None,
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

    // ---------- 辅助会话注册表 ----------

    fn assisted_session(user_agent: &str) -> AssistedSession {
        AssistedSession {
            user_agent: Some(user_agent.to_string()),
            headers: Some("Cookie: sid=secret".to_string()),
        }
    }

    #[test]
    fn assisted_registry_rejects_invalid_origin_and_user_agent() {
        let state = AppState::new();
        // 非 http/https 一律拒绝。
        for bad in [
            "ftp://example.com",
            "file:///c:/tmp",
            "javascript:alert(1)",
            "data:text/html,x",
            "",
        ] {
            assert!(
                state
                    .register_assisted_session(bad, assisted_session("UA/1.0"))
                    .is_err(),
                "非法 origin 必须被拒绝：{bad}"
            );
        }
        // 含 CRLF（WHATWG 解析会吞掉，必须显式拒绝）。
        for bad in [
            "https://example.com\r\nX-Injected: 1",
            "https://example.com\n",
            "https://example.com\r",
        ] {
            assert!(
                state
                    .register_assisted_session(bad, assisted_session("UA/1.0"))
                    .is_err(),
                "含控制字符的 origin 必须被拒绝：{bad:?}"
            );
        }
        // 超长。
        let long = format!("https://{}.com", "a".repeat(MAX_ASSISTED_ORIGIN_BYTES));
        assert!(state
            .register_assisted_session(&long, assisted_session("UA/1.0"))
            .is_err());
        // UA 含 CRLF / 超长同样拒绝。
        assert!(state
            .register_assisted_session("https://example.com", assisted_session("UA/1.0\r\nX: 1"))
            .is_err());
        assert!(state
            .register_assisted_session(
                "https://example.com",
                AssistedSession {
                    user_agent: Some("U".repeat(MAX_ASSISTED_USER_AGENT_BYTES + 1)),
                    headers: None,
                }
            )
            .is_err());
        // 非法输入不得留下任何注册记录。
        assert_eq!(state.assisted_sessions.len(), 0);
    }

    #[test]
    fn assisted_registry_normalizes_origin_and_matches_only_same_origin() {
        let state = AppState::new();
        let canonical = state
            .register_assisted_session(
                "https://Gallery.Example/gallery/1?x=1",
                assisted_session("Assisted-UA/1.0"),
            )
            .expect("合法 origin 应登记");
        assert_eq!(canonical, "https://gallery.example");
        assert_eq!(state.assisted_sessions.len(), 1);

        let hit = url::Url::parse("https://gallery.example/chapter/2").unwrap();
        assert_eq!(
            state.assisted_user_agent(&hit).as_deref(),
            Some("Assisted-UA/1.0")
        );
        // 跨 origin（不同 host / 不同 scheme / 不同端口）都不命中。
        for miss in [
            "https://other.example/chapter/2",
            "http://gallery.example/chapter/2",
            "https://gallery.example:8443/chapter/2",
        ] {
            let url = url::Url::parse(miss).unwrap();
            assert_eq!(state.assisted_user_agent(&url), None, "{miss}");
        }
    }

    #[test]
    fn assisted_sessions_are_memory_only_and_never_persisted() {
        let state = test_state();
        state
            .register_assisted_session(
                "https://gallery.example",
                assisted_session("Assisted-UA/9.9"),
            )
            .expect("登记辅助会话");
        // 内存里可见。
        let session = state
            .assisted_session("https://gallery.example")
            .expect("应能取回辅助会话");
        assert_eq!(session.user_agent.as_deref(), Some("Assisted-UA/9.9"));
        assert_eq!(session.headers.as_deref(), Some("Cookie: sid=secret"));

        // 但 SQLite 的 settings 表里不得出现任何相关 key/值。
        let dump = state
            .db
            .with(|conn| {
                let mut stmt = conn
                    .prepare("SELECT k, v FROM settings")
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                let mut out = String::new();
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let k: String = row.get(0).map_err(|e| e.to_string())?;
                    let v: String = row.get(1).map_err(|e| e.to_string())?;
                    out.push_str(&k);
                    out.push('=');
                    out.push_str(&v);
                    out.push('\n');
                }
                Ok(out)
            })
            .unwrap();
        assert!(
            !dump.contains("Assisted-UA") && !dump.contains("sid=secret"),
            "辅助会话内容不得写入 SQLite：{dump}"
        );
        assert!(
            !dump.to_lowercase().contains("assist")
                && !dump.to_lowercase().contains("user_agent")
                && !dump.to_lowercase().contains("gallery.example"),
            "settings 表不得出现辅助会话相关 key：{dump}"
        );
        assert!(
            state
                .db
                .with(|conn| crate::db::get_setting(conn, "online_headers")
                    .map_err(|e| e.to_string()))
                .unwrap()
                .is_none(),
            "辅助会话不得顺带落库任何设置项"
        );
    }

    #[test]
    fn clear_assisted_sessions_empties_the_registry() {
        let state = AppState::new();
        state
            .register_assisted_session(
                "https://gallery.example",
                assisted_session("Assisted-UA/1.0"),
            )
            .expect("登记辅助会话");
        assert_eq!(state.assisted_sessions.len(), 1);
        state.clear_assisted_sessions();
        assert_eq!(state.assisted_sessions.len(), 0);
        assert!(state.assisted_session("https://gallery.example").is_none());
        let url = url::Url::parse("https://gallery.example/chapter/2").unwrap();
        assert_eq!(state.assisted_user_agent(&url), None);
    }

    #[test]
    fn assisted_registry_validates_origin_helper() {
        assert_eq!(
            normalize_assisted_origin("https://example.com").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_assisted_origin("http://127.0.0.1:8080/x").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(normalize_assisted_origin("ftp://example.com").is_err());
        assert!(normalize_assisted_origin("https://example.com\r\n").is_err());
    }

    #[test]
    fn assisted_registry_can_be_used_standalone() {
        let registry = AssistedSessionRegistry::new();
        assert!(registry.is_empty());
        registry
            .register(
                "https://gallery.example",
                AssistedSession {
                    user_agent: Some("UA/1.0".into()),
                    headers: Some("Cookie: sid=abc".into()),
                },
            )
            .unwrap();
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry
                .headers_for_origin("https://gallery.example")
                .as_deref(),
            Some("Cookie: sid=abc")
        );
        registry.clear();
        assert!(registry.is_empty());
    }
}
