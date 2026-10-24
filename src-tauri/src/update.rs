//! 应用更新：清单校验、补丁优先/全量回退下载、SHA-256 + Minisign 校验、安装启动。
//!
//! 设计约定：
//! - 运行时状态自持（`OnceLock`），不修改 `AppState`；命令间通过模块内状态衔接。
//! - 清单与制品地址只允许 HTTPS；HTTP 仅限回环主机（本地冒烟测试）。
//! - 编译期 `MR_UPDATE_PUBKEY` 配置了 Minisign 公钥时，所选制品必须携带有效签名；
//!   未配置公钥时拒绝所有非回环制品（不做“静默接受未签名生产更新”）。
//! - SHA-256 始终强制校验，下载边写边算；任何失败都会删除半成品文件。
//! - 进度通过 Tauri Channel 推送（约 100ms 节流），支持取消；失败信息全部为中文且不含 URL 凭据。

use std::cmp::Ordering;
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use minisign_verify::{Error as MinisignError, PublicKey, Signature};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

// ---------- 常量 ----------

const MANIFEST_MAX_BYTES: usize = 1024 * 1024; // 1 MiB
/// 未提供 size 时的兜底上限，避免异常服务端无限写入临时目录。
const ARTIFACT_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 下载不设 HTTP 客户端总超时（大包/慢网），仅设连接超时与整体安全上限。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const CHUNK_WAIT: Duration = Duration::from_millis(750);
/// 连续约 5 分钟收不到数据视为下载停滞（配合 10 分钟总超时）。
const MAX_IDLE_WAITS: u32 = 400;
const UPDATE_DIR_NAME: &str = "mangareader-updates";
const PENDING_INSTALL_FILE: &str = "pending-install.json";
const FALLBACK_FILE_STEM: &str = "MangaReader-update";

const PHASE_DOWNLOADING: &str = "downloading";
const PHASE_VERIFYING: &str = "verifying";
const PHASE_READY: &str = "ready";

const FALLBACK_NO_PATCH: &str = "no-patch";
const FALLBACK_VERSION_MISMATCH: &str = "version-mismatch";
const FALLBACK_MAJOR_UPGRADE: &str = "major-upgrade";
const FALLBACK_MULTI_MINOR: &str = "multi-minor";
const FALLBACK_PATCH_AVAILABLE: &str = "patch-available";

const CANCELED_MESSAGE: &str = "更新下载已取消";
const UI_CHANNEL_ERROR: &str = "无法向界面发送下载进度，已中止更新";

// ---------- 对前端暴露的数据结构 ----------

/// 应用基础信息（安全面板/关于页使用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub build_baseline: String,
    pub target: String,
    pub profile: String,
    /// 任一更新通道配置了签名公钥（补丁通道 MR_UPDATE_PUBKEY 或
    /// tauri.conf.json plugins.updater.pubkey）；「软件更新」卡片徽章使用。
    pub signature_configured: bool,
    pub sha256_enforced: bool,
    /// 构建来源指纹：`official`（官方 CI 注入 `MR_BUILD_ORIGIN=official`，
    /// 产物走官方签名）/ `community`（第三方自行修改编译，默认值）。
    /// 用于「关于」页徽章与诊断快照，防止社区魔改版的 Bug 混淆官方排查。
    pub build_origin: String,
    /// Linux 安装形态：`appimage`（可自动替换）/ `system`（deb/rpm，
    /// 引导手动安装）/ `portable` / 空串（非 Linux，前端跳过相关提示）。
    pub linux_install: String,
}

/// 单个安装包（补丁或全量）的元信息；不向前端暴露 URL。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub kind: String,
    pub size: u64,
    pub format: String,
}

/// 一次更新检查的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub kind: Option<String>,
    pub patch_eligible: bool,
    pub fallback_reason: String,
    pub patch: Option<ArtifactInfo>,
    pub full: ArtifactInfo,
    pub notes: String,
    pub released_at: Option<String>,
    pub mandatory: bool,
}

/// 已下载并完成校验、可安装的更新。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyUpdate {
    pub version: String,
    pub kind: String,
    pub size: u64,
    pub format: String,
    pub sha256: String,
}

/// 上一次安装尝试未生效（重启后当前版本仍低于目标版本）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousUpdateFailure {
    pub version: String,
    pub kind: String,
    pub started_at: String,
}

/// 更新运行时快照（前端重挂载后恢复 UI 状态）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub ready: Option<ReadyUpdate>,
    pub downloading: bool,
    pub last_verified_at: Option<String>,
    pub last_verified_kind: Option<String>,
    pub previous_attempt_failed: Option<PreviousUpdateFailure>,
}

/// 下载进度事件（Tauri Channel）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    pub request_id: String,
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    pub bytes_per_second: f64,
}

// ---------- 清单反序列化 ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    released_at: Option<String>,
    #[serde(default)]
    mandatory: bool,
    #[serde(default)]
    patch: Option<ArtifactEntry>,
    full: ArtifactEntry,
    /// 覆盖 version/artifacts 的清单签名（minisign 文本）。
    #[serde(default)]
    signature: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactEntry {
    #[serde(default)]
    from_version: Option<String>,
    url: String,
    #[serde(default)]
    size: u64,
    sha256: String,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Debug, Clone)]
struct ValidManifest {
    version: Version,
    version_raw: String,
    notes: String,
    released_at: Option<String>,
    mandatory: bool,
    patch: Option<Artifact>,
    full: Artifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Patch,
    Full,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Patch => "patch",
            Self::Full => "full",
        }
    }

    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "patch" => Ok(Self::Patch),
            "full" => Ok(Self::Full),
            _ => Err("未知的更新类型".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallerFormat {
    Nsis,
    Msi,
    Deb,
    Rpm,
    AppImage,
}

impl InstallerFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Nsis => "nsis",
            Self::Msi => "msi",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::AppImage => "appimage",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Nsis => ".exe",
            Self::Msi => ".msi",
            Self::Deb => ".deb",
            Self::Rpm => ".rpm",
            Self::AppImage => ".AppImage",
        }
    }
}

#[derive(Debug, Clone)]
struct Artifact {
    kind: ArtifactKind,
    url: Url,
    size: u64,
    sha256: String,
    signature: Option<String>,
    format: InstallerFormat,
    from_version: Option<Version>,
}

// ---------- 版本比较（semver-ish） ----------

#[derive(Debug, Clone)]
struct Version {
    core: Vec<u64>,
    pre: Vec<PreId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreId {
    Num(u64),
    Alpha(String),
}

impl Version {
    fn parse(raw: &str) -> Result<Self, String> {
        let mut s = raw.trim();
        if s.is_empty() {
            return Err("版本号为空".to_string());
        }
        if let Some(rest) = s.strip_prefix('v').or_else(|| s.strip_prefix('V')) {
            if rest.starts_with(|c: char| c.is_ascii_digit()) {
                s = rest;
            }
        }
        // 构建元数据（+xxx）不参与比较，但必须是合法的点分标识符。
        if let Some((base, build)) = s.split_once('+') {
            if base.is_empty() || build.is_empty() {
                return Err("版本号格式无效".to_string());
            }
            for ident in build.split('.') {
                if ident.is_empty()
                    || !ident
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err("版本号格式无效".to_string());
                }
            }
            s = base;
        }
        let (core_part, pre_part) = match s.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (s, None),
        };
        if core_part.is_empty() {
            return Err("版本号格式无效".to_string());
        }
        let mut core = Vec::new();
        for segment in core_part.split('.') {
            if segment.is_empty()
                || !segment.bytes().all(|b| b.is_ascii_digit())
                || (segment.len() > 1 && segment.starts_with('0'))
            {
                return Err("版本号格式无效".to_string());
            }
            let n = segment
                .parse::<u64>()
                .map_err(|_| "版本号格式无效".to_string())?;
            core.push(n);
        }
        if core.len() != 3 {
            return Err("版本号必须是 MAJOR.MINOR.PATCH".to_string());
        }
        let mut pre = Vec::new();
        if let Some(pre_text) = pre_part {
            if pre_text.is_empty() {
                return Err("版本号格式无效".to_string());
            }
            for ident in pre_text.split('.') {
                if ident.is_empty()
                    || !ident
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err("版本号格式无效".to_string());
                }
                if ident.bytes().all(|b| b.is_ascii_digit()) {
                    if ident.len() > 1 && ident.starts_with('0') {
                        return Err("预发布数字标识不能有前导零".to_string());
                    }
                    pre.push(PreId::Num(
                        ident
                            .parse::<u64>()
                            .map_err(|_| "版本号格式无效".to_string())?,
                    ));
                } else {
                    pre.push(PreId::Alpha(ident.to_string()));
                }
            }
        }
        Ok(Self { core, pre })
    }

    fn major(&self) -> u64 {
        self.core.first().copied().unwrap_or(0)
    }

    fn minor(&self) -> u64 {
        self.core.get(1).copied().unwrap_or(0)
    }

    fn compare(&self, other: &Self) -> Ordering {
        let core_len = self.core.len().max(other.core.len());
        for i in 0..core_len {
            let a = self.core.get(i).copied().unwrap_or(0);
            let b = other.core.get(i).copied().unwrap_or(0);
            match a.cmp(&b) {
                Ordering::Equal => {}
                ord => return ord,
            }
        }
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                let len = self.pre.len().max(other.pre.len());
                for i in 0..len {
                    match (self.pre.get(i), other.pre.get(i)) {
                        (Some(a), Some(b)) => match compare_pre(a, b) {
                            Ordering::Equal => {}
                            ord => return ord,
                        },
                        (Some(_), None) => return Ordering::Greater,
                        (None, Some(_)) => return Ordering::Less,
                        (None, None) => return Ordering::Equal,
                    }
                }
                Ordering::Equal
            }
        }
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.compare(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.compare(other)
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.compare(other) == Ordering::Equal
    }
}

impl Eq for Version {}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, n) in self.core.iter().enumerate() {
            if i > 0 {
                f.write_str(".")?;
            }
            write!(f, "{n}")?;
        }
        if !self.pre.is_empty() {
            f.write_str("-")?;
            for (i, p) in self.pre.iter().enumerate() {
                if i > 0 {
                    f.write_str(".")?;
                }
                match p {
                    PreId::Num(n) => write!(f, "{n}")?,
                    PreId::Alpha(s) => f.write_str(s)?,
                }
            }
        }
        Ok(())
    }
}

fn compare_pre(a: &PreId, b: &PreId) -> Ordering {
    match (a, b) {
        (PreId::Num(x), PreId::Num(y)) => x.cmp(y),
        (PreId::Num(_), PreId::Alpha(_)) => Ordering::Less,
        (PreId::Alpha(_), PreId::Num(_)) => Ordering::Greater,
        (PreId::Alpha(x), PreId::Alpha(y)) => x.cmp(y),
    }
}

// ---------- 模块级运行时状态 ----------

struct ActiveDownload {
    cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
struct StoredArtifact {
    ready: ReadyUpdate,
    path: PathBuf,
}

#[derive(Default)]
struct UpdateRuntime {
    /// 每次新下载递增；用于阻止被替换的旧任务写回状态。
    generation: u64,
    active: Option<ActiveDownload>,
    ready: Option<StoredArtifact>,
    last_verified_at: Option<String>,
    last_verified_kind: Option<String>,
    last_attempt_at: Option<String>,
    last_attempt_ok: bool,
    previous_failure: Option<PreviousUpdateFailure>,
}

static RUNTIME: OnceLock<Mutex<UpdateRuntime>> = OnceLock::new();

fn runtime() -> &'static Mutex<UpdateRuntime> {
    RUNTIME.get_or_init(|| Mutex::new(UpdateRuntime::default()))
}

/// 一次下载的“会话”；Drop 时清理 `downloading` 标记（即使提前返回）。
struct DownloadSession {
    generation: u64,
    cancel: Arc<AtomicBool>,
}

impl Drop for DownloadSession {
    fn drop(&mut self) {
        let mut rt = runtime().lock();
        if rt.generation == self.generation {
            rt.active = None;
        }
    }
}

/// 半成品文件守卫：除非显式 `keep()`，否则 Drop 时删除（覆盖所有错误路径）。
struct PartialFileGuard {
    path: Option<PathBuf>,
    keep: bool,
}

impl PartialFileGuard {
    fn new() -> Self {
        Self {
            path: None,
            keep: false,
        }
    }

    fn track(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        if let Some(path) = self.path.take() {
            remove_file_quiet(&path);
        }
    }
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn configured_public_key() -> Option<&'static str> {
    option_env!("MR_UPDATE_PUBKEY")
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

/// 原生 GitHub 通道（`tauri.conf.json plugins.updater.pubkey`）是否配置公钥。
/// 由 `lib.rs` 在 setup 阶段注入一次；序列化整个 Config 而非逐字段匹配，
/// 避免依赖 tauri-utils `PluginConfig` 的内部形态。
static NATIVE_UPDATER_PUBKEY: OnceLock<bool> = OnceLock::new();

pub fn set_native_updater_pubkey_present(present: bool) {
    let _ = NATIVE_UPDATER_PUBKEY.set(present);
}

pub fn native_updater_pubkey_present() -> bool {
    *NATIVE_UPDATER_PUBKEY.get().unwrap_or(&false)
}

/// 是否在构建期配置了补丁通道的更新签名公钥（下载/回环策略门使用；
/// 原生通道公钥不参与补丁通道策略，见 `any_update_signature_configured`）。
pub fn signature_configured() -> bool {
    configured_public_key().is_some()
}

/// 是否配置了任一更新通道的签名公钥：
/// - 补丁通道：编译期 `MR_UPDATE_PUBKEY`；
/// - 原生 GitHub 通道：`tauri.conf.json plugins.updater.pubkey`。
/// 这是设置页「软件更新」卡片签名徽章的唯一事实源。
pub fn any_update_signature_configured() -> bool {
    signature_configured() || native_updater_pubkey_present()
}

/// 最近一次校验的时间与状态（"verified" / "failed"）；安全面板使用。
pub fn last_verification() -> Option<(String, String)> {
    let rt = runtime().lock();
    let at = rt.last_attempt_at.clone()?;
    let status = if rt.last_attempt_ok {
        "verified"
    } else {
        "failed"
    };
    Some((at, status.to_string()))
}

fn begin_download() -> DownloadSession {
    let (generation, cancel, previous_ready) = {
        let mut rt = runtime().lock();
        if let Some(active) = rt.active.take() {
            active.cancel.store(true, AtomicOrdering::SeqCst);
        }
        rt.generation = rt.generation.wrapping_add(1);
        let generation = rt.generation;
        let cancel = Arc::new(AtomicBool::new(false));
        rt.active = Some(ActiveDownload {
            cancel: cancel.clone(),
        });
        (generation, cancel, rt.ready.take())
    };
    if let Some(stale) = previous_ready {
        remove_file_quiet(&stale.path);
    }
    DownloadSession { generation, cancel }
}

fn store_ready(generation: u64, stored: StoredArtifact) -> bool {
    let mut rt = runtime().lock();
    if rt.generation != generation {
        return false;
    }
    let kind = stored.ready.kind.clone();
    rt.ready = Some(stored);
    rt.active = None;
    let now = now_iso8601();
    rt.last_verified_at = Some(now.clone());
    rt.last_verified_kind = Some(kind);
    rt.last_attempt_at = Some(now);
    rt.last_attempt_ok = true;
    true
}

fn record_verification_failure() {
    let mut rt = runtime().lock();
    rt.last_attempt_at = Some(now_iso8601());
    rt.last_attempt_ok = false;
}

fn clear_ready_for_path(generation: u64, path: &Path) -> bool {
    let mut rt = runtime().lock();
    if rt.generation != generation {
        return false;
    }
    if rt
        .ready
        .as_ref()
        .map(|stored| stored.path == path)
        .unwrap_or(false)
    {
        rt.ready = None;
        true
    } else {
        false
    }
}

fn clear_ready_path(path: &Path) {
    let mut rt = runtime().lock();
    if rt
        .ready
        .as_ref()
        .map(|stored| stored.path == path)
        .unwrap_or(false)
    {
        rt.ready = None;
    }
}

fn remove_file_quiet(path: &Path) {
    // 清理失败不影响用户可见结果；文件位于私有临时目录。
    let _ = std::fs::remove_file(path);
}

fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(AtomicOrdering::SeqCst) {
        Err(CANCELED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

// ---------- URL 策略 ----------

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1"
}

fn is_loopback_url(url: &Url) -> bool {
    url.host_str().map(is_loopback_host).unwrap_or(false)
}

/// 只允许 HTTPS；HTTP 仅允许回环主机。拒绝 userinfo、非 http(s)、空主机。
fn validate_download_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("更新地址为空".to_string());
    }
    let url = Url::parse(trimmed).map_err(|_| "更新地址格式无效".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("更新地址不允许包含用户名或密码".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "更新地址缺少主机名".to_string())?;
    if host.is_empty() {
        return Err("更新地址缺少主机名".to_string());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" => {
            if is_loopback_host(host) {
                Ok(url)
            } else {
                Err("更新地址必须使用 HTTPS（仅本机调试允许 http）".to_string())
            }
        }
        _ => Err("更新地址必须使用 HTTPS（仅本机调试允许 http）".to_string()),
    }
}

// ---------- 清单校验与选择 ----------

fn normalize_sha256(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("更新清单中的 SHA-256 值无效".to_string());
    }
    Ok(value.to_ascii_lowercase())
}

fn sha256_matches(expected: &str, actual: &str) -> bool {
    expected.len() == 64
        && actual.len() == 64
        && expected.eq_ignore_ascii_case(actual)
}

fn resolve_format(explicit: Option<&str>, url: &Url) -> Result<InstallerFormat, String> {
    if let Some(raw) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return match raw.to_ascii_lowercase().as_str() {
            "nsis" => Ok(InstallerFormat::Nsis),
            "msi" => Ok(InstallerFormat::Msi),
            "deb" => Ok(InstallerFormat::Deb),
            "rpm" => Ok(InstallerFormat::Rpm),
            "appimage" | "app-image" => Ok(InstallerFormat::AppImage),
            _ => Err("不支持的安装包格式".to_string()),
        };
    }
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".msi") {
        Ok(InstallerFormat::Msi)
    } else if path.ends_with(".deb") {
        Ok(InstallerFormat::Deb)
    } else if path.ends_with(".rpm") {
        Ok(InstallerFormat::Rpm)
    } else if path.ends_with(".appimage") {
        Ok(InstallerFormat::AppImage)
    } else {
        // Windows 的历史清单允许无后缀下载地址并回落 NSIS；Linux 绝不能把
        // 未知制品误当 Windows 安装包，必须要求明确的 deb/rpm/AppImage。
        #[cfg(target_os = "linux")]
        {
            return Err(
                "Linux 更新包 URL 缺少可识别的 .deb/.rpm/.AppImage 后缀".to_string(),
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(InstallerFormat::Nsis)
        }
    }
}

fn normalize_artifact(entry: ArtifactEntry, kind: ArtifactKind) -> Result<Artifact, String> {
    if entry.size > ARTIFACT_MAX_BYTES {
        return Err("更新包大小超出安全上限".to_string());
    }
    let url = validate_download_url(&entry.url)?;
    let sha256 = normalize_sha256(&entry.sha256)?;
    let format = resolve_format(entry.format.as_deref(), &url)?;
    let signature = entry
        .signature
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let from_version = match entry.from_version {
        Some(raw) => Some(Version::parse(&raw).map_err(|_| "补丁来源版本号无效".to_string())?),
        None => None,
    };
    Ok(Artifact {
        kind,
        url,
        size: entry.size,
        sha256,
        signature,
        format,
        from_version,
    })
}

fn validate_manifest(raw: Manifest) -> Result<ValidManifest, String> {
    let version_raw = raw.version.trim().to_string();
    let version =
        Version::parse(&version_raw).map_err(|_| "更新清单中的版本号无效".to_string())?;
    let full = normalize_artifact(raw.full, ArtifactKind::Full)?;
    // 补丁是可选的：字段损坏时丢弃补丁并回退全量，不影响整体更新能力。
    let patch = raw.patch.and_then(|entry| match normalize_artifact(entry, ArtifactKind::Patch) {
        Ok(artifact) if artifact.from_version.is_some() => Some(artifact),
        _ => None,
    });
    Ok(ValidManifest {
        version,
        version_raw,
        notes: raw.notes,
        released_at: raw.released_at,
        mandatory: raw.mandatory,
        patch,
        full,
    })
}

fn artifact_info(artifact: &Artifact) -> ArtifactInfo {
    ArtifactInfo {
        kind: artifact.kind.as_str().to_string(),
        size: artifact.size,
        format: artifact.format.as_str().to_string(),
    }
}

/// 计算推荐安装包与回退原因；第二个返回值仅在补丁可用时为 `Some`。
fn evaluate(current: &Version, manifest: &ValidManifest) -> (UpdateCheck, Option<Artifact>) {
    let available = manifest.version.compare(current) == Ordering::Greater;
    let (patch_eligible, fallback_reason, usable_patch) = if !available {
        (false, "", None)
    } else {
        match manifest.patch.as_ref() {
            None => (false, FALLBACK_NO_PATCH, None),
            Some(patch) => {
                if manifest.version.major() != current.major() {
                    (false, FALLBACK_MAJOR_UPGRADE, None)
                } else if manifest.version.minor().saturating_sub(current.minor()) >= 2 {
                    // A patch may only bridge adjacent minor releases; skipping
                    // multiple minors must go through a full installer.
                    (false, FALLBACK_MULTI_MINOR, None)
                } else if patch.from_version.as_ref() != Some(current) {
                    (false, FALLBACK_VERSION_MISMATCH, None)
                } else {
                    (true, FALLBACK_PATCH_AVAILABLE, Some(patch.clone()))
                }
            }
        }
    };
    let kind = if !available {
        None
    } else if patch_eligible {
        Some(ArtifactKind::Patch.as_str().to_string())
    } else {
        Some(ArtifactKind::Full.as_str().to_string())
    };
    let check = UpdateCheck {
        current_version: current.to_string(),
        latest_version: manifest.version_raw.clone(),
        available,
        kind,
        patch_eligible,
        fallback_reason: fallback_reason.to_string(),
        patch: manifest.patch.as_ref().map(artifact_info),
        full: artifact_info(&manifest.full),
        notes: manifest.notes.clone(),
        released_at: manifest.released_at.clone(),
        mandatory: manifest.mandatory,
    };
    (check, usable_patch)
}

// ---------- 网络 ----------

fn http_client_with_timeout(timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    // 不允许通过重定向把请求降级到明文或非常规协议：每次跳转都重新
    // 套用与初始地址相同的 HTTPS/回环策略，超限则停止跟随。
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.stop()
        } else if validate_download_url(attempt.url().as_str()).is_ok() {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(redirects)
        .user_agent(concat!("MangaReader/", env!("CARGO_PKG_VERSION")));
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|_| "无法初始化更新网络客户端".to_string())
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    http_client_with_timeout(Some(timeout))
}

/// 注意：不要拼接 `reqwest::Error` 的 Display，避免把带查询参数的 URL 泄露到界面。
fn map_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "更新服务请求超时，请检查网络后重试".to_string()
    } else if error.is_connect() {
        "无法连接更新服务，请检查网络后重试".to_string()
    } else if error.is_body() || error.is_decode() {
        "更新数据读取失败，请稍后重试".to_string()
    } else {
        "更新服务请求失败，请稍后重试".to_string()
    }
}

fn current_version() -> Result<Version, String> {
    Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| "当前应用版本号无效".to_string())
}

async fn fetch_manifest(raw_url: &str) -> Result<ValidManifest, String> {
    let url = validate_download_url(raw_url)?;
    let client = http_client(CHECK_TIMEOUT)?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| map_network_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("获取更新清单失败（HTTP {}）", status.as_u16()));
    }
    // 重定向后的最终地址同样受策略约束。
    validate_download_url(response.url().as_str())?;
    if configured_public_key().is_none() && !is_loopback_url(response.url()) {
        return Err("未配置更新签名公钥，已拒绝未签名更新".to_string());
    }
    if response
        .content_length()
        .map(|len| len > MANIFEST_MAX_BYTES as u64)
        .unwrap_or(false)
    {
        return Err("更新清单超过 1 MiB 限制".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_network_error(&error))?
    {
        if body.len().saturating_add(chunk.len()) > MANIFEST_MAX_BYTES {
            return Err("更新清单超过 1 MiB 限制".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    let allow_unsigned =
        configured_public_key().is_none() && is_loopback_url(response.url());
    verify_manifest_signature(&body, allow_unsigned)?;
    let manifest: Manifest =
        serde_json::from_slice(&body).map_err(|_| "更新清单格式无效".to_string())?;
    validate_manifest(manifest)
}

/// 清单签名覆盖版本、URL、sha256、size 与 notes 等所有字段；签名前把
/// `signature` 字段移除，再对 serde_json 的稳定键序序列化做 minisign 校验。
///
/// 未配置公钥时只允许调用方明确传入 `allow_unsigned=true`（生产路径仅在
/// 回环 URL 下传入）；远程清单绝不放行。
fn verify_manifest_signature(body: &[u8], allow_unsigned: bool) -> Result<(), String> {
    verify_manifest_signature_with(body, configured_public_key(), allow_unsigned)
}

fn parse_public_key(raw: &str) -> Result<PublicKey, String> {
    let parsed = if raw.contains('\n') {
        PublicKey::decode(raw)
    } else {
        PublicKey::from_base64(raw)
    };
    parsed.map_err(|_| "更新签名公钥无效，已拒绝更新".to_string())
}

fn verify_manifest_signature_with(
    body: &[u8],
    public_key: Option<&str>,
    allow_unsigned: bool,
) -> Result<(), String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "更新清单格式无效".to_string())?;
    let signature_text = value
        .get("signature")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let Some(public_key) = public_key else {
        // 没有公钥可验证，清单签名不能视为可信；只允许显式回环测试放行。
        return if allow_unsigned {
            Ok(())
        } else {
            Err("未配置更新签名公钥，已拒绝未签名更新".to_string())
        };
    };
    let signature_text =
        signature_text.ok_or_else(|| "更新清单缺少签名，已拒绝更新".to_string())?;
    let signature = parse_signature(&signature_text)?;
    let key = parse_public_key(public_key)?;
    if let Some(object) = value.as_object_mut() {
        object.remove("signature");
    }
    let canonical =
        serde_json::to_vec(&value).map_err(|_| "更新清单规范化失败".to_string())?;
    key.verify(&canonical, &signature, true)
        .map_err(|_| "更新清单签名校验失败，已拒绝更新".to_string())
}

// ---------- 文件与签名 ----------

fn update_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(UPDATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建更新缓存目录：{err}"))?;
    Ok(dir)
}

fn pending_install_path() -> Result<PathBuf, String> {
    Ok(update_dir()?.join(PENDING_INSTALL_FILE))
}

fn write_pending_install(ready: &ReadyUpdate) -> Result<(), String> {
    let pending = PreviousUpdateFailure {
        version: ready.version.clone(),
        kind: ready.kind.clone(),
        started_at: now_iso8601(),
    };
    let raw = serde_json::to_vec(&pending)
        .map_err(|_| "无法记录更新安装状态".to_string())?;
    std::fs::write(pending_install_path()?, raw)
        .map_err(|error| format!("无法记录更新安装状态：{error}"))
}

fn clear_pending_install() {
    if let Ok(path) = pending_install_path() {
        remove_file_quiet(&path);
    }
}

/// 读取并消费上一次安装标记。只有当前版本仍低于目标版本才算失败；
/// 版本已追上说明补丁/全量包已成功应用，直接清除标记。
fn take_pending_install_failure() -> Option<PreviousUpdateFailure> {
    let path = pending_install_path().ok()?;
    let raw = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let pending: PreviousUpdateFailure = serde_json::from_slice(&raw).ok()?;
    let target = Version::parse(&pending.version).ok()?;
    let current = current_version().ok()?;
    if current.compare(&target) == Ordering::Less {
        Some(pending)
    } else {
        None
    }
}

fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() >= 96 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.');
    if trimmed.is_empty() {
        FALLBACK_FILE_STEM.to_string()
    } else {
        trimmed.to_string()
    }
}

fn artifact_file_name(artifact: &Artifact, version: &str, generation: u64) -> String {
    let from_url = artifact
        .url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(sanitize_file_name);
    let mut base = match from_url {
        Some(name) => name,
        None => format!(
            "{}-{}",
            FALLBACK_FILE_STEM,
            sanitize_file_name(version)
        ),
    };
    let extension = artifact.format.extension();
    if !base
        .to_ascii_lowercase()
        .ends_with(&extension.to_ascii_lowercase())
    {
        base.push_str(extension);
    }
    // 进程号 + 代数前缀：避免多个实例/多次下载写同一路径（File::create 仍会截断）。
    format!("{}-{generation}-{base}", std::process::id())
}

fn load_public_key() -> Result<PublicKey, String> {
    let raw = configured_public_key().ok_or_else(|| "未配置更新签名公钥".to_string())?;
    let parsed = if raw.contains('\n') {
        PublicKey::decode(raw)
    } else {
        PublicKey::from_base64(raw)
    };
    parsed.map_err(|_| "更新签名公钥无效，已拒绝更新".to_string())
}

/// 接受完整 Minisign 签名文本，或“签名文本的 base64 包裹”。
///
/// 说明：`minisign-verify` 0.2 只支持包含 trusted comment + 全局签名的 4 行签名；
/// 仅有 74 字节 signature box 的裸 base64 无法完成全局签名校验，会返回明确错误。
fn parse_signature(raw: &str) -> Result<Signature, String> {
    let text = raw.trim().trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Err("更新包签名数据为空，已拒绝安装".to_string());
    }
    if let Ok(signature) = decode_signature_text(text) {
        return Ok(signature);
    }
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(text) {
        if let Ok(inner) = std::str::from_utf8(&decoded) {
            if let Ok(signature) = decode_signature_text(inner.trim()) {
                return Ok(signature);
            }
        }
    }
    Err("更新包签名格式无效，已拒绝安装".to_string())
}

fn decode_signature_text(text: &str) -> Result<Signature, MinisignError> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    match lines.len() {
        len if len >= 4 => {
            let normalized = format!(
                "{}\n{}\n{}\n{}",
                lines[0], lines[1], lines[2], lines[3]
            );
            Signature::decode(&normalized)
        }
        3 => {
            // 兼容缺少 untrusted comment 行的 3 行签名。
            if lines[1].starts_with("trusted comment:") {
                let normalized = format!(
                    "untrusted comment: signature\n{}\n{}\n{}",
                    lines[0], lines[1], lines[2]
                );
                Signature::decode(&normalized)
            } else {
                Err(MinisignError::InvalidEncoding)
            }
        }
        _ => Signature::decode(text),
    }
}

/// 配置了公钥时，返回必须校验的 (公钥, 签名)；未配置时仅允许回环地址。
fn prepare_signature(artifact: &Artifact) -> Result<Option<(PublicKey, Signature)>, String> {
    if signature_configured() {
        let raw = artifact
            .signature
            .as_deref()
            .ok_or_else(|| "更新包缺少签名，已拒绝安装".to_string())?;
        let key = load_public_key()?;
        let signature = parse_signature(raw)?;
        Ok(Some((key, signature)))
    } else if is_loopback_url(&artifact.url) {
        Ok(None)
    } else {
        Err("未配置更新签名公钥，已拒绝未签名更新".to_string())
    }
}

fn verify_signature_file(
    path: &Path,
    key: &PublicKey,
    signature: &Signature,
) -> Result<(), String> {
    match key.verify_stream(signature) {
        Ok(mut verifier) => {
            let mut file = std::fs::File::open(path)
                .map_err(|err| format!("无法读取更新安装包：{err}"))?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|err| format!("无法读取更新安装包：{err}"))?;
                if read == 0 {
                    break;
                }
                verifier.update(&buffer[..read]);
            }
            verifier
                .finalize()
                .map_err(|_| "更新包签名校验失败，已删除下载文件".to_string())
        }
        Err(MinisignError::UnsupportedLegacyMode) => {
            // 旧式（非预哈希）签名不支持流式校验，回退为一次性读取。
            let data = std::fs::read(path)
                .map_err(|err| format!("无法读取更新安装包：{err}"))?;
            key.verify(&data, signature, true)
                .map_err(|_| "更新包签名校验失败，已删除下载文件".to_string())
        }
        Err(MinisignError::UnexpectedKeyId) => {
            Err("更新包签名与当前公钥不匹配，已拒绝安装".to_string())
        }
        Err(_) => Err("更新包签名数据无效，已拒绝安装".to_string()),
    }
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| format!("无法读取更新安装包：{err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|err| format!("无法读取更新安装包：{err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ---------- 下载 ----------

struct StreamedArtifact {
    bytes: u64,
    sha256_hex: String,
}

fn emit_update_event(
    on_event: &Channel<UpdateEvent>,
    request_id: &str,
    phase: &str,
    downloaded: u64,
    total: u64,
    bytes_per_second: f64,
) -> Result<(), String> {
    let percent = if phase != PHASE_DOWNLOADING {
        100.0
    } else if total > 0 {
        ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    on_event
        .send(UpdateEvent {
            request_id: request_id.to_string(),
            phase: phase.to_string(),
            downloaded,
            total,
            percent,
            bytes_per_second,
        })
        .map_err(|_| UI_CHANNEL_ERROR.to_string())
}

async fn stream_artifact(
    mut response: reqwest::Response,
    path: &Path,
    artifact: &Artifact,
    total: u64,
    cancel: &AtomicBool,
    on_event: &Channel<UpdateEvent>,
    request_id: &str,
) -> Result<StreamedArtifact, String> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|err| format!("无法创建更新临时文件：{err}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut speed = 0.0f64;
    let mut last_emit = Instant::now();
    let mut last_emit_at = last_emit;
    let mut last_emit_bytes: u64 = 0;
    let mut idle_waits: u32 = 0;
    let started = Instant::now();

    emit_update_event(
        on_event,
        request_id,
        PHASE_DOWNLOADING,
        0,
        total,
        0.0,
    )?;

    loop {
        ensure_not_cancelled(cancel)?;
        if started.elapsed() > DOWNLOAD_TIMEOUT {
            return Err("更新下载超过安全时限（60 分钟），已中止".to_string());
        }
        let chunk = match tokio::time::timeout(CHUNK_WAIT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(map_network_error(&error)),
            Err(_) => {
                idle_waits = idle_waits.saturating_add(1);
                if idle_waits >= MAX_IDLE_WAITS {
                    return Err("更新下载超时，请稍后重试".to_string());
                }
                continue;
            }
        };
        idle_waits = 0;
        if chunk.is_empty() {
            continue;
        }
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if artifact.size > 0 && downloaded > artifact.size {
            return Err("更新包大小与清单不一致，已删除下载文件".to_string());
        }
        if downloaded > ARTIFACT_MAX_BYTES {
            return Err("更新包超过安全大小上限，已中止下载".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("写入更新文件失败：{err}"))?;

        let now = Instant::now();
        if now.saturating_duration_since(last_emit) >= PROGRESS_INTERVAL {
            let elapsed = now
                .saturating_duration_since(last_emit_at)
                .as_secs_f64()
                .max(0.001);
            let instant = downloaded.saturating_sub(last_emit_bytes) as f64 / elapsed;
            speed = if speed <= f64::EPSILON {
                instant
            } else {
                // 指数滑动平均，避免进度条速度剧烈跳动。
                speed * 0.75 + instant * 0.25
            };
            emit_update_event(
                on_event,
                request_id,
                PHASE_DOWNLOADING,
                downloaded,
                total,
                speed,
            )?;
            last_emit = now;
            last_emit_at = now;
            last_emit_bytes = downloaded;
        }
    }

    file.flush()
        .await
        .map_err(|err| format!("写入更新文件失败：{err}"))?;
    file.sync_all()
        .await
        .map_err(|err| format!("写入更新文件失败：{err}"))?;
    drop(file);
    ensure_not_cancelled(cancel)?;

    Ok(StreamedArtifact {
        bytes: downloaded,
        sha256_hex: hex::encode(hasher.finalize()),
    })
}

async fn perform_download(
    session: &DownloadSession,
    manifest_url: &str,
    requested_version: &Version,
    requested_kind: ArtifactKind,
    request_id: &str,
    on_event: &Channel<UpdateEvent>,
) -> Result<ReadyUpdate, String> {
    let current = current_version()?;
    let manifest = fetch_manifest(manifest_url).await?;
    ensure_not_cancelled(session.cancel.as_ref())?;

    // 未配置签名公钥时只允许本机回环清单，避免远端清单把未签名制品
    // 指向 localhost（或反向）绕过策略。
    if !signature_configured() {
        let parsed_manifest = Url::parse(manifest_url.trim())
            .map_err(|_| "更新清单地址无效".to_string())?;
        if !is_loopback_url(&parsed_manifest) {
            return Err("未配置更新签名公钥，已拒绝未签名更新".to_string());
        }
    }

    if manifest.version != *requested_version {
        return Err("更新清单已变更，请重新检查更新".to_string());
    }
    let (check, eligible_patch) = evaluate(&current, &manifest);
    if !check.available {
        return Err("当前已是最新版本，无需更新".to_string());
    }
    let artifact = match requested_kind {
        ArtifactKind::Patch => eligible_patch
            .ok_or_else(|| "补丁包不可用，请改用全量包".to_string())?,
        ArtifactKind::Full => manifest.full.clone(),
    };
    let signature = prepare_signature(&artifact)?;

    let dir = update_dir()?;
    let file_name = artifact_file_name(&artifact, &manifest.version_raw, session.generation);
    let path = dir.join(&file_name);
    if path.parent().map(|parent| parent == dir.as_path()) != Some(true) {
        return Err("更新临时文件路径无效".to_string());
    }
    let mut guard = PartialFileGuard::new();
    guard.track(path.clone());

    // 不用 reqwest 的总请求超时：大包在慢网下会被 10 分钟硬切断；
    // 改为连接超时 + 分块空闲超时 + 60 分钟整体上限。
    let client = http_client_with_timeout(None)?;
    let response = client
        .get(artifact.url.clone())
        .send()
        .await
        .map_err(|error| map_network_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载更新包失败（HTTP {}）", status.as_u16()));
    }
    validate_download_url(response.url().as_str())?;
    if !signature_configured() && !is_loopback_url(response.url()) {
        return Err("未配置更新签名公钥，已拒绝未签名更新".to_string());
    }
    ensure_not_cancelled(session.cancel.as_ref())?;

    let total = if artifact.size > 0 {
        artifact.size
    } else {
        response.content_length().unwrap_or(0)
    };
    let streamed = stream_artifact(
        response,
        &path,
        &artifact,
        total,
        session.cancel.as_ref(),
        on_event,
        request_id,
    )
    .await?;

    emit_update_event(
        on_event,
        request_id,
        PHASE_VERIFYING,
        streamed.bytes,
        total.max(streamed.bytes),
        0.0,
    )?;

    if artifact.size > 0 && streamed.bytes != artifact.size {
        record_verification_failure();
        return Err("更新包大小与清单不一致，已删除下载文件".to_string());
    }
    if !sha256_matches(&streamed.sha256_hex, &artifact.sha256) {
        record_verification_failure();
        return Err("更新包 SHA-256 校验失败，已删除下载文件".to_string());
    }
    if let Some((key, signature)) = signature {
        let verify_path = path.clone();
        let verified = tokio::task::spawn_blocking(move || {
            verify_signature_file(&verify_path, &key, &signature)
        })
        .await
        .map_err(|_| "更新包签名校验中断，请重试".to_string())?;
        if let Err(error) = verified {
            record_verification_failure();
            return Err(error);
        }
    }
    ensure_not_cancelled(session.cancel.as_ref())?;

    let ready = ReadyUpdate {
        version: manifest.version_raw.clone(),
        kind: artifact.kind.as_str().to_string(),
        size: streamed.bytes,
        format: artifact.format.as_str().to_string(),
        sha256: artifact.sha256.clone(),
    };
    let stored = StoredArtifact {
        ready: ready.clone(),
        path: path.clone(),
    };
    if !store_ready(session.generation, stored) {
        return Err("更新下载已被新的下载任务替换".to_string());
    }
    guard.keep();
    let still_current = {
        let rt = runtime().lock();
        rt.generation == session.generation
    };
    if !still_current {
        return Err("更新下载已被新的下载任务替换".to_string());
    }
    if let Err(error) = emit_update_event(
        on_event,
        request_id,
        PHASE_READY,
        streamed.bytes,
        total.max(streamed.bytes),
        0.0,
    ) {
        if clear_ready_for_path(session.generation, &path) {
            remove_file_quiet(&path);
        }
        return Err(error);
    }
    Ok(ready)
}

// ---------- 安装 ----------

#[cfg(windows)]
fn powershell_quote(path: &Path) -> String {
    // PowerShell 单引号字符串：路径中的单引号用两个单引号转义；
    // 中文/emoji 由 UTF-16LE EncodedCommand 承载，不经过 OEM 码页。
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

#[cfg(windows)]
fn installer_script(path: &Path, format: &str, relaunch_exe: &Path) -> Result<String, String> {
    let installer = powershell_quote(path);
    let exe = powershell_quote(relaunch_exe);
    let install = match format {
        "msi" => format!(
            "$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('\"' + {installer} + '\"'), '/passive', '/norestart') -Wait -PassThru"
        ),
        "nsis" => format!(
            "$p = Start-Process -FilePath {installer} -ArgumentList '/S' -Wait -PassThru"
        ),
        _ => return Err("不支持的安装包格式".to_string()),
    };
    // 先等应用释放文件句柄，再等待安装器结束，最后拉起新版本。
    Ok(format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         Start-Sleep -Milliseconds 900\n\
         {install}\n\
         Start-Process -FilePath {exe}\n"
    ))
}

#[cfg(windows)]
fn encode_powershell(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

#[cfg(windows)]
fn spawn_installer(path: &Path, format: &str, relaunch_exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    // DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP：
    // 安装/重启脚本独立于本进程运行。
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let script = installer_script(path, format, relaunch_exe)?;
    let encoded = encode_powershell(&script);
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动安装程序：{error}"))
}

/// Linux 安装策略：
/// - **AppImage 运行态**：下载的新 AppImage 经校验后原子替换当前
///   `.AppImage` 文件（备份 → 改名 → 拉起新进程 → 清理/回滚），无需 root；
/// - **系统安装态（.deb/.rpm）**：`/usr/bin` 下的文件归包管理器管辖，
///   应用绝不以 root 自居去改系统文件——返回稳定错误码
///   `linux-manual-install`，由前端引导用户下载后用包管理器安装。
#[cfg(target_os = "linux")]
fn spawn_installer(path: &Path, format: &str, relaunch_exe: &Path) -> Result<(), String> {
    match format {
        "appimage" => install_appimage(path, relaunch_exe),
        "deb" | "rpm" => Err(
            "系统安装态的更新包由包管理器管辖，请下载后手动安装（linux-manual-install）"
                .to_string(),
        ),
        other => Err(format!("Linux 暂不支持自动安装 {other} 格式的更新包")),
    }
}

/// AppImage 原地替换：备份旧文件 → 新文件改名到位 → 拉起新版本。
/// 任何一步失败都回滚，保证旧版本始终可双击运行。
#[cfg(target_os = "linux")]
fn install_appimage(new_appimage: &Path, _relaunch_exe: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    // APPIMAGE 由 AppImage 运行时注入，指向磁盘上的 .AppImage 文件本体
    // （不是 /tmp/.mount_* 下的 squashfs 挂载点）。缺失说明不是 AppImage
    // 运行态（开发/便携运行），原地替换无从谈起。
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    let Some(target) = target else {
        return Err("当前不是 AppImage 运行态，无法自动替换（linux-manual-install）".to_string());
    };

    let mut permissions = std::fs::metadata(new_appimage)
        .map_err(|err| format!("无法读取更新包属性：{err}"))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(new_appimage, permissions)
        .map_err(|err| format!("无法为更新包添加执行权限：{err}"))?;

    let backup = target.with_extension("old-appimage");
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(&target, &backup).map_err(|err| format!("无法备份当前 AppImage：{err}"))?;
    if let Err(err) = std::fs::rename(new_appimage, &target) {
        let _ = std::fs::rename(&backup, &target);
        return Err(format!("无法替换 AppImage：{err}"));
    }
    match std::process::Command::new(&target).spawn() {
        Ok(_) => {
            // 新版本已拉起；旧文件不再需要，直接清理。
            let _ = std::fs::remove_file(&backup);
            Ok(())
        }
        Err(err) => {
            // 新版本启动失败：回滚旧文件，用户仍能运行旧版。
            let _ = std::fs::remove_file(&target);
            let _ = std::fs::rename(&backup, &target);
            Err(format!("无法启动新版本 AppImage：{err}"))
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn spawn_installer(_path: &Path, _format: &str, _relaunch_exe: &Path) -> Result<(), String> {
    Err("当前平台暂不支持自动安装更新，请手动安装".to_string())
}

// ---------- Tauri 命令 ----------

/// 应用基础信息（同步）。
#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_baseline: build_baseline().to_string(),
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_string(),
        signature_configured: any_update_signature_configured(),
        sha256_enforced: true,
        build_origin: build_origin().to_string(),
        linux_install: crate::platform::install_channel().to_string(),
    }
}

fn build_baseline() -> &'static str {
    match option_env!("MR_BUILD_BASELINE") {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                "local"
            } else {
                trimmed
            }
        }
        None => "local",
    }
}

/// 构建来源指纹（编译期注入）：
/// - 官方发布流水线注入 `MR_BUILD_ORIGIN=official`；
/// - 社区构建脚本显式注入 `community`；
/// - 本地裸 `cargo build` / `tauri dev` 未注入 → 默认按社区构建对待
///   （宁可误标社区，不可把第三方产物冒充官方）。
pub fn build_origin() -> &'static str {
    match option_env!("MR_BUILD_ORIGIN") {
        Some(value) if value.trim().eq_ignore_ascii_case("official") => "official",
        _ => "community",
    }
}

/// 拉取并校验更新清单，不触发下载。
#[tauri::command]
pub async fn check_update(manifest_url: String) -> Result<UpdateCheck, String> {
    let current = current_version()?;
    let manifest = fetch_manifest(&manifest_url).await?;
    let (check, _patch) = evaluate(&current, &manifest);
    Ok(check)
}

/// 下载并校验指定版本的安装包（补丁或全量）。
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    manifest_url: String,
    version: String,
    kind: String,
    request_id: String,
    on_event: Channel<UpdateEvent>,
) -> Result<ReadyUpdate, String> {
    let _ = app;
    validate_download_url(&manifest_url)?;
    let requested_kind = ArtifactKind::parse(&kind)?;
    let requested_version =
        Version::parse(&version).map_err(|_| "更新版本号无效".to_string())?;
    let session = begin_download();
    perform_download(
        &session,
        &manifest_url,
        &requested_version,
        requested_kind,
        &request_id,
        &on_event,
    )
    .await
}

/// 再次校验已存制品并启动安装程序，随后退出应用。
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let stored = {
        let rt = runtime().lock();
        rt.ready
            .as_ref()
            .cloned()
            .ok_or_else(|| "没有可安装的更新包，请先下载".to_string())?
    };

    match tokio::fs::metadata(&stored.path).await {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => {
            clear_ready_path(&stored.path);
            return Err("更新安装包无效，请重新下载".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            clear_ready_path(&stored.path);
            return Err("更新安装包不存在，请重新下载".to_string());
        }
        Err(error) => return Err(format!("无法读取更新安装包：{error}")),
    }

    let digest = sha256_file(&stored.path).await?;
    if !sha256_matches(&digest, &stored.ready.sha256) {
        record_verification_failure();
        clear_ready_path(&stored.path);
        remove_file_quiet(&stored.path);
        return Err("更新包校验失败，请重新下载".to_string());
    }

    let current_exe = std::env::current_exe()
        .map_err(|error| format!("无法定位当前应用路径：{error}"))?;
    write_pending_install(&stored.ready)?;
    if let Err(error) = spawn_installer(&stored.path, &stored.ready.format, &current_exe) {
        clear_pending_install();
        return Err(error);
    }

    {
        let mut rt = runtime().lock();
        if rt
            .ready
            .as_ref()
            .map(|ready| ready.path == stored.path)
            .unwrap_or(false)
        {
            rt.ready = None;
        }
    }
    app.exit(0);
    Ok(())
}

/// 用户显式点击「立即重启」后重启应用。
///
/// 不经过 process 插件，也不暴露 `process:*` 权限；命令由本应用注册，
/// 因此只授予 update 面板使用。绝不由后台自动调用。
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// 请求取消当前下载；下载循环会在下一个检查点删除半成品并退出。
#[tauri::command]
pub fn cancel_update() {
    let rt = runtime().lock();
    if let Some(active) = rt.active.as_ref() {
        active.cancel.store(true, AtomicOrdering::SeqCst);
    }
}

/// 返回可安装制品与下载状态，供前端重挂载后恢复。
#[tauri::command]
pub fn get_update_snapshot() -> UpdateSnapshot {
    let pending_failure = take_pending_install_failure();
    let mut rt = runtime().lock();
    if rt.previous_failure.is_none() {
        rt.previous_failure = pending_failure;
    }
    UpdateSnapshot {
        ready: rt.ready.as_ref().map(|stored| stored.ready.clone()),
        downloading: rt.active.is_some(),
        last_verified_at: rt.last_verified_at.clone(),
        last_verified_kind: rt.last_verified_kind.clone(),
        previous_attempt_failed: rt.previous_failure.clone(),
    }
}

// ---------- 测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(ch: char) -> String {
        std::iter::repeat(ch).take(64).collect()
    }

    fn version(raw: &str) -> Version {
        Version::parse(raw).expect("测试版本号应有效")
    }

    fn entry(url: &str, from: Option<&str>, format: Option<&str>) -> ArtifactEntry {
        ArtifactEntry {
            from_version: from.map(str::to_string),
            url: url.to_string(),
            size: 1024,
            sha256: sha('a'),
            signature: Some("untrusted comment: test".to_string()),
            format: format.map(str::to_string),
        }
    }

    fn full_entry() -> ArtifactEntry {
        entry(
            "https://example.com/MangaReader_0.9.1_x64-setup.exe",
            None,
            Some("nsis"),
        )
    }

    fn manifest_of(ver: &str, patch: Option<ArtifactEntry>) -> ValidManifest {
        validate_manifest(Manifest {
            version: ver.to_string(),
            notes: "修复若干问题".to_string(),
            released_at: Some("2026-10-22T00:00:00Z".to_string()),
            mandatory: false,
            patch,
            full: full_entry(),
            signature: None,
        })
        .expect("测试清单应有效")
    }

    #[test]
    fn semver_ordering_and_parsing() {
        assert!(version("0.9.0") < version("0.9.1"));
        assert!(version("1.0.0-alpha") < version("1.0.0"));
        assert!(version("1.0.0-alpha.1") < version("1.0.0-alpha.2"));
        assert!(version("1.0.0-alpha.2") < version("1.0.0-alpha.10"));
        assert!(version("1.0.0-alpha") < version("1.0.0-beta"));
        assert!(version("1.0.0-1") < version("1.0.0-alpha"));
        assert!(version("2.0.0") > version("1.99.99"));
        assert_eq!(version("1.2.3+build.7"), version("1.2.3"));
        assert_eq!(version("v1.2.3"), version("1.2.3"));
        assert!(Version::parse("").is_err());
        assert!(Version::parse("1.2").is_err());
        assert!(Version::parse("1.2.3.4").is_err());
        assert!(Version::parse("01.2.3").is_err());
        assert!(Version::parse("1.2.x").is_err());
        assert!(Version::parse("1..2").is_err());
        assert!(Version::parse("1.2.3-").is_err());
        assert!(Version::parse("1.2.3-alpha..1").is_err());
        assert!(Version::parse("1.2.3-01").is_err());
    }

    #[test]
    fn artifact_selection_prefers_eligible_patch() {
        let current = version("0.9.0");
        let manifest = manifest_of(
            "0.9.1",
            Some(entry(
                "https://example.com/patch.exe",
                Some("0.9.0"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert!(check.available);
        assert_eq!(check.kind.as_deref(), Some("patch"));
        assert!(check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_PATCH_AVAILABLE);
        assert_eq!(
            patch.map(|artifact| artifact.kind),
            Some(ArtifactKind::Patch)
        );
        assert!(check.patch.is_some());
        assert_eq!(check.patch.as_ref().map(|info| info.kind.as_str()), Some("patch"));
    }

    #[test]
    fn artifact_selection_falls_back_on_major_upgrade() {
        let current = version("1.2.3");
        let manifest = manifest_of(
            "2.0.0",
            Some(entry(
                "https://example.com/patch.exe",
                Some("1.2.3"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert!(check.available);
        assert_eq!(check.kind.as_deref(), Some("full"));
        assert!(!check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_MAJOR_UPGRADE);
        assert!(patch.is_none());
        // 补丁信息仍应展示，便于前端说明体积。
        assert!(check.patch.is_some());
    }

    #[test]
    fn artifact_selection_falls_back_on_version_mismatch() {
        let current = version("0.9.0");
        let manifest = manifest_of(
            "0.9.1",
            Some(entry(
                "https://example.com/patch.exe",
                Some("0.8.5"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert_eq!(check.kind.as_deref(), Some("full"));
        assert!(!check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_VERSION_MISMATCH);
        assert!(patch.is_none());
    }

    #[test]
    fn artifact_selection_falls_back_across_multiple_minor_versions() {
        let current = version("1.0.0");
        let manifest = manifest_of(
            "1.2.0",
            Some(entry(
                "https://example.com/patch.exe",
                Some("1.0.0"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert_eq!(check.kind.as_deref(), Some("full"));
        assert!(!check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_MULTI_MINOR);
        assert!(patch.is_none());
    }

    #[test]
    fn artifact_selection_allows_patch_across_one_minor_version() {
        let current = version("1.0.0");
        let manifest = manifest_of(
            "1.1.0",
            Some(entry(
                "https://example.com/patch.exe",
                Some("1.0.0"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert_eq!(check.kind.as_deref(), Some("patch"));
        assert!(check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_PATCH_AVAILABLE);
        assert!(patch.is_some());
    }

    #[test]
    fn artifact_selection_falls_back_without_patch() {
        let current = version("0.9.0");
        let manifest = manifest_of("0.9.1", None);
        let (check, patch) = evaluate(&current, &manifest);
        assert!(check.available);
        assert_eq!(check.kind.as_deref(), Some("full"));
        assert!(!check.patch_eligible);
        assert_eq!(check.fallback_reason, FALLBACK_NO_PATCH);
        assert!(patch.is_none());
        assert!(check.patch.is_none());
    }

    #[test]
    fn artifact_selection_handles_up_to_date() {
        let current = version("0.9.1");
        let manifest = manifest_of(
            "0.9.1",
            Some(entry(
                "https://example.com/patch.exe",
                Some("0.9.1"),
                Some("nsis"),
            )),
        );
        let (check, patch) = evaluate(&current, &manifest);
        assert!(!check.available);
        assert!(check.kind.is_none());
        assert!(!check.patch_eligible);
        assert_eq!(check.fallback_reason, "");
        assert!(patch.is_none());
        assert_eq!(check.latest_version, "0.9.1");

        let older = manifest_of("0.8.0", None);
        let (check, _) = evaluate(&current, &older);
        assert!(!check.available);
        assert!(check.kind.is_none());
    }

    #[test]
    fn url_policy_allows_https_and_loopback_http() {
        assert!(validate_download_url("https://example.com/manifest.json").is_ok());
        assert!(validate_download_url("https://example.com:8443/a/b").is_ok());
        assert!(validate_download_url("http://127.0.0.1:8787/manifest.json").is_ok());
        assert!(validate_download_url("http://localhost:8787/manifest.json").is_ok());
        assert!(validate_download_url("http://[::1]:8787/manifest.json").is_ok());
    }

    #[test]
    fn url_policy_rejects_insecure_or_credentialed_urls() {
        assert!(validate_download_url("http://example.com/manifest.json").is_err());
        assert!(validate_download_url("http://127.0.0.1.evil.com/manifest.json").is_err());
        assert!(validate_download_url("https://user:pass@example.com/x").is_err());
        assert!(validate_download_url("https://user@example.com/x").is_err());
        assert!(validate_download_url("ftp://example.com/x").is_err());
        assert!(validate_download_url("file:///C:/x").is_err());
        assert!(validate_download_url("https://").is_err());
        assert!(validate_download_url("").is_err());
        assert!(validate_download_url("   ").is_err());
    }

    #[test]
    fn artifact_urls_follow_same_policy() {
        let mut bad_full = full_entry();
        bad_full.url = "http://example.com/setup.exe".to_string();
        let bad = Manifest {
            version: "0.9.1".to_string(),
            notes: String::new(),
            released_at: None,
            mandatory: false,
            patch: None,
            full: bad_full,
            signature: None,
        };
        assert!(validate_manifest(bad).is_err());

        let mut loopback_full = full_entry();
        loopback_full.url = "http://127.0.0.1:8787/setup.exe".to_string();
        let good = Manifest {
            version: "0.9.1".to_string(),
            notes: String::new(),
            released_at: None,
            mandatory: false,
            patch: None,
            full: loopback_full,
            signature: None,
        };
        assert!(validate_manifest(good).is_ok());
    }

    #[test]
    fn manifest_parse_and_format_inference() {
        let json = serde_json::json!({
            "version": "0.9.1",
            "notes": "修复若干问题",
            "releasedAt": "2026-10-22T00:00:00Z",
            "mandatory": true,
            "unknownField": "ignored",
            "patch": {
                "fromVersion": "0.9.0",
                "url": "https://example.com/MangaReader_0.9.0_to_0.9.1.nsis.patch.exe",
                "size": 1234,
                "sha256": sha('A'),
                "signature": "untrusted comment: x",
                "format": "nsis"
            },
            "full": {
                "url": "https://example.com/MangaReader_0.9.1_x64-setup.MSI",
                "size": 9876,
                "sha256": sha('B')
            }
        });
        let parsed: Manifest = serde_json::from_value(json).expect("清单应可解析");
        let manifest = validate_manifest(parsed).expect("清单应有效");
        assert_eq!(manifest.version, version("0.9.1"));
        assert_eq!(manifest.version_raw, "0.9.1");
        assert_eq!(manifest.full.format, InstallerFormat::Msi);
        assert_eq!(manifest.full.sha256, sha('b'));
        assert_eq!(manifest.full.size, 9876);
        assert_eq!(
            manifest.patch.as_ref().map(|patch| patch.format),
            Some(InstallerFormat::Nsis)
        );
        assert!(manifest.mandatory);
        assert_eq!(manifest.notes, "修复若干问题");
        assert_eq!(manifest.released_at.as_deref(), Some("2026-10-22T00:00:00Z"));
    }

    #[test]
    fn format_resolution_rules() {
        let exe = Url::parse("https://example.com/setup.exe").expect("url");
        let msi = Url::parse("https://example.com/setup.MSI").expect("url");
        let bin = Url::parse("https://example.com/download").expect("url");
        let deb = Url::parse("https://example.com/MangaReader_0.15.0_amd64.deb").expect("url");
        let rpm = Url::parse("https://example.com/MangaReader-0.15.0-x86_64.rpm").expect("url");
        let appimage =
            Url::parse("https://example.com/MangaReader_0.15.0_amd64.AppImage").expect("url");
        assert_eq!(resolve_format(None, &exe).expect("nsis"), InstallerFormat::Nsis);
        assert_eq!(resolve_format(None, &msi).expect("msi"), InstallerFormat::Msi);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(resolve_format(None, &bin).expect("nsis"), InstallerFormat::Nsis);
        #[cfg(target_os = "linux")]
        assert!(
            resolve_format(None, &bin).is_err(),
            "Linux 无后缀 URL 必须拒绝，不能回落 NSIS"
        );
        assert_eq!(resolve_format(None, &deb).expect("deb"), InstallerFormat::Deb);
        assert_eq!(resolve_format(None, &rpm).expect("rpm"), InstallerFormat::Rpm);
        assert_eq!(
            resolve_format(None, &appimage).expect("appimage"),
            InstallerFormat::AppImage
        );
        assert_eq!(
            resolve_format(Some("NSIS"), &msi).expect("explicit"),
            InstallerFormat::Nsis
        );
        assert_eq!(
            resolve_format(Some("AppImage"), &exe).expect("explicit appimage"),
            InstallerFormat::AppImage
        );
        assert_eq!(
            resolve_format(Some("deb"), &exe).expect("explicit deb"),
            InstallerFormat::Deb
        );
        assert!(resolve_format(Some("appx"), &exe).is_err());
    }

    #[test]
    fn patch_with_invalid_payload_is_ignored() {
        let mut broken = entry(
            "https://example.com/patch.exe",
            Some("0.9.0"),
            Some("nsis"),
        );
        broken.sha256 = "not-a-sha".to_string();
        let manifest = manifest_of("0.9.1", Some(broken));
        assert!(manifest.patch.is_none());
        let (check, patch) = evaluate(&version("0.9.0"), &manifest);
        assert_eq!(check.fallback_reason, FALLBACK_NO_PATCH);
        assert_eq!(check.kind.as_deref(), Some("full"));
        assert!(patch.is_none());
    }

    #[test]
    fn sha_helpers() {
        assert_eq!(normalize_sha256(&sha('A')).expect("hex"), sha('a'));
        assert!(normalize_sha256("").is_err());
        assert!(normalize_sha256(&"g".repeat(64)).is_err());
        assert!(normalize_sha256(&"a".repeat(63)).is_err());
        assert!(normalize_sha256(&"a".repeat(65)).is_err());
        assert!(sha256_matches(&sha('A'), &sha('a')));
        assert!(!sha256_matches(&sha('a'), &sha('b')));
        let digest = hex::encode(Sha256::digest(b"abc"));
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn file_name_sanitization_blocks_traversal() {
        let name = sanitize_file_name("..\\..\\evil name.exe");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(':'));
        assert!(name.ends_with(".exe"));
        assert_eq!(sanitize_file_name(""), FALLBACK_FILE_STEM);
        assert_eq!(sanitize_file_name(".."), FALLBACK_FILE_STEM);

        let artifact = Artifact {
            kind: ArtifactKind::Full,
            url: Url::parse("https://example.com/download").expect("url"),
            size: 1,
            sha256: sha('a'),
            signature: None,
            format: InstallerFormat::Msi,
            from_version: None,
        };
        let generated = artifact_file_name(&artifact, "0.9.1", 7);
        assert!(generated.starts_with(&format!("{}-7-", std::process::id())));
        assert!(generated.ends_with(".msi"));
        assert!(Path::new(&generated).components().count() == 1);
    }

    const TEST_PUBKEY: &str =
        "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    fn wrong_public_key() -> PublicKey {
        let mut raw = base64::engine::general_purpose::STANDARD
            .decode(TEST_PUBKEY)
            .expect("测试公钥 base64");
        raw[10] ^= 0x01;
        parse_public_key(&base64::engine::general_purpose::STANDARD.encode(raw))
            .expect("翻转字节后的公钥仍应可解析")
    }

    fn signature_test_file(tag: &str, data: &[u8]) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mr-update-sign-{tag}-{}-{nanos}.bin",
            std::process::id()
        ));
        std::fs::write(&path, data).expect("写入签名测试文件");
        path
    }

    #[test]
    fn signature_file_rejects_tampered_bytes_and_wrong_key() {
        let path = signature_test_file("verify", b"test");
        let key = PublicKey::from_base64(TEST_PUBKEY).expect("测试公钥");
        let signature = Signature::decode(TEST_SIGNATURE).expect("测试签名");

        verify_signature_file(&path, &key, &signature).expect("原始字节应验签通过");

        std::fs::write(&path, b"tampered").unwrap();
        assert!(
            verify_signature_file(&path, &key, &signature).is_err(),
            "篡改字节必须拒绝"
        );

        std::fs::write(&path, b"test").unwrap();
        let wrong = wrong_public_key();
        assert!(
            verify_signature_file(&path, &wrong, &signature).is_err(),
            "错误公钥必须拒绝"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unsigned_manifest_is_only_allowed_for_explicit_unsigned_mode() {
        let body = br#"{"version":"0.9.1","notes":"test","full":{"url":"https://example.com/x.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}"#;
        assert!(
            verify_manifest_signature_with(body, None, true).is_ok(),
            "回环/测试显式放行时允许无签名清单"
        );
        assert!(
            verify_manifest_signature_with(body, None, false).is_err(),
            "未配置公钥且非显式放行时必须拒绝"
        );
        assert!(
            verify_manifest_signature_with(body, Some(TEST_PUBKEY), false).is_err(),
            "配置公钥时未签名清单必须拒绝"
        );

        let signature = serde_json::json!({
            "version": "0.9.1",
            "notes": "test",
            "signature": TEST_SIGNATURE,
            "full": {
                "url": "https://example.com/x.exe",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size": 1
            }
        });
        let raw = serde_json::to_vec(&signature).unwrap();
        assert!(
            verify_manifest_signature_with(&raw, Some(TEST_PUBKEY), false).is_err(),
            "签名覆盖的是制品字节，不是任意清单 JSON，必须拒绝"
        );
    }

    #[test]
    fn signature_parser_accepts_text_and_base64_text() {
        let full = "untrusted comment: signature from minisign secret key\n\
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n\
trusted comment: timestamp:1555779966\tfile:test\n\
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        assert!(parse_signature(full).is_ok());
        let wrapped = base64::engine::general_purpose::STANDARD.encode(full);
        assert!(parse_signature(&wrapped).is_ok());

        let lines: Vec<&str> = full.lines().collect();
        let three_lines = format!("{}\n{}\n{}", lines[1], lines[2], lines[3]);
        assert!(parse_signature(&three_lines).is_ok());

        assert!(parse_signature("").is_err());
        assert!(parse_signature("not a signature").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn installer_script_uses_utf16_and_powershell_quoting() {
        let installer = Path::new(r"C:\用户\漫画 目录\更 新'包.msi");
        let exe = Path::new(r"C:\用户\漫画 目录\MangaReader.exe");
        let script = installer_script(installer, "msi", exe).unwrap();
        assert!(script.contains("更 新''包.msi"), "{script}");
        assert!(script.contains("Start-Process -FilePath 'msiexec.exe'"));
        assert!(!script.contains(".cmd"));

        let encoded = encode_powershell(&script);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let decoded = String::from_utf16(&units).unwrap();
        assert_eq!(decoded, script);
        assert!(decoded.contains("漫画 目录"));
    }

    #[test]
    fn update_event_serializes_camel_case() {
        let event = UpdateEvent {
            request_id: "req-1".to_string(),
            phase: PHASE_DOWNLOADING.to_string(),
            downloaded: 50,
            total: 100,
            percent: 50.0,
            bytes_per_second: 12.5,
        };
        let value = serde_json::to_value(&event).expect("serialize");
        assert_eq!(value["requestId"], "req-1");
        assert_eq!(value["phase"], "downloading");
        assert_eq!(value["downloaded"], 50);
        assert_eq!(value["total"], 100);
        assert_eq!(value["percent"], 50.0);
        assert_eq!(value["bytesPerSecond"], 12.5);
        assert!(value.get("request_id").is_none());
    }
}
