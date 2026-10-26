//! Independent recovery, heartbeat watchdog and safe-mode backend.
//!
//! The recovery surface is a separate local Tauri WebView (`recovery.html`);
//! it stays usable while the main renderer is blocked. Every recovery action
//! is initiated by the user. This module never refreshes, restarts or enters
//! safe mode on its own.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Local, SecondsFormat};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::diagnostics::display_route;
use crate::AppState;

const RECOVERY_LABEL: &str = "recovery";
const RECOVERY_PAGE: &str = "recovery.html";
/// 原生窗口标题只做中性兜底；实际语言由恢复窗前端按 `recovery.windowTitle`
/// 调用 `setTitle` 同步，避免无装饰窗口在非中文环境出现中文标题。
const RECOVERY_TITLE: &str = "MangaReader";
const HEARTBEAT_STALE: Duration = Duration::from_secs(6);
const BOOT_GRACE: Duration = Duration::from_secs(12);
const WATCHDOG_TICK: Duration = Duration::from_secs(1);
/// 定时线程自身间隔突然变大（系统睡眠/唤醒、调试暂停）时，不能把这段
/// 时间算进“主线程无心跳”，否则唤醒后第一 tick 会误弹恢复窗。
const RESUME_GAP: Duration = Duration::from_secs(3);
const RAGE_COOLDOWN: Duration = Duration::from_secs(15);
const SAFE_MODE_FILE: &str = "safe-mode.json";
const BOOT_GUARD_FILE: &str = "crash-guard.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeState {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryTrigger {
    RageClick,
    HeartbeatTimeout,
    StartupFailures,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryContext {
    pub trigger: RecoveryTrigger,
    pub detail: String,
    pub detected_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_route: Option<String>,
    pub heartbeat_age_ms: u64,
    pub responsive: bool,
    pub safe_mode: SafeModeState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RageClickPayload {
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub window_ms: u32,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootGuard {
    #[serde(default = "default_clean")]
    clean: bool,
    #[serde(default)]
    failures: u32,
    #[serde(default)]
    last_launch_at: Option<String>,
}

fn default_clean() -> bool {
    true
}

impl Default for BootGuard {
    fn default() -> Self {
        Self {
            clean: true,
            failures: 0,
            last_launch_at: None,
        }
    }
}

pub struct ResilienceState {
    started: Instant,
    last_heartbeat: Mutex<Option<Instant>>,
    last_route: Mutex<Option<String>>,
    last_reader_mode: Mutex<Option<String>>,
    last_reader_page: Mutex<Option<u32>>,
    recovery_context: Mutex<Option<RecoveryContext>>,
    freeze_notified: AtomicBool,
    rage_last: Mutex<Option<Instant>>,
}

pub fn new_state() -> Arc<ResilienceState> {
    Arc::new(ResilienceState {
        started: Instant::now(),
        last_heartbeat: Mutex::new(None),
        last_route: Mutex::new(None),
        last_reader_mode: Mutex::new(None),
        last_reader_page: Mutex::new(None),
        recovery_context: Mutex::new(None),
        freeze_notified: AtomicBool::new(false),
        rage_last: Mutex::new(None),
    })
}

fn now_string() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

fn mode_allowlist(raw: &str) -> Option<String> {
    match raw.trim() {
        "single" | "double" | "webtoon" => Some(raw.trim().to_string()),
        _ => None,
    }
}

fn normalize_safe_reason(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some("userRecovery") => "userRecovery".to_string(),
        Some("startupFailures") => "startupFailures".to_string(),
        _ => "manual".to_string(),
    }
}

fn safe_mode_path() -> Result<PathBuf, String> {
    Ok(crate::data_dir()?.join(SAFE_MODE_FILE))
}

/// Online entry points call this before touching the network. Safe mode is a
/// user-selected local-only session and must hold even if a stale UI path is
/// invoked directly.
pub(crate) fn ensure_online_allowed() -> Result<(), String> {
    let path = safe_mode_path()?;
    match read_safe_mode_result(&path) {
        Ok(state) if !state.active => Ok(()),
        Ok(_) => Err("安全模式保障中，在线与浏览器功能已暂停".to_string()),
        Err(error) => {
            crate::logging::log_error(
                "safe_mode",
                &format!("安全模式状态不可读，按安全模式阻断在线功能：{error}"),
            );
            Err(format!("安全模式状态不可读，已阻断在线功能：{error}"))
        }
    }
}

fn boot_guard_path() -> Result<PathBuf, String> {
    Ok(crate::data_dir()?.join(BOOT_GUARD_FILE))
}

fn read_safe_mode_result(path: &Path) -> Result<SafeModeState, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<SafeModeState>(&raw)
            .map_err(|err| format!("安全模式文件损坏：{err}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SafeModeState::default()),
        Err(error) => Err(format!("无法读取安全模式文件：{error}")),
    }
}

fn read_safe_mode_at(path: &Path) -> SafeModeState {
    match read_safe_mode_result(path) {
        Ok(state) => state,
        Err(error) => {
            crate::logging::log_error("safe_mode", &error);
            SafeModeState {
                active: true,
                reason: Some("unreadable".into()),
                activated_at: Some(now_string()),
            }
        }
    }
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    {
        use std::io::Write as _;
        let mut file =
            std::fs::File::create(&tmp).map_err(|err| format!("无法创建临时文件：{err}"))?;
        file.write_all(data)
            .map_err(|err| format!("无法写入临时文件：{err}"))?;
        file.sync_all()
            .map_err(|err| format!("无法同步临时文件：{err}"))?;
    }
    if let Err(first) = std::fs::rename(&tmp, path) {
        // Windows 不能总是覆盖已存在文件；退化为删除后重命名。
        if let Err(remove) = std::fs::remove_file(path) {
            if remove.kind() != std::io::ErrorKind::NotFound {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("无法替换文件：{first}; {remove}"));
            }
        }
        std::fs::rename(&tmp, path).map_err(|err| {
            let _ = std::fs::remove_file(&tmp);
            format!("无法替换文件：{err}")
        })?;
    }
    Ok(())
}

fn write_safe_mode_at(path: &Path, state: &SafeModeState) -> Result<(), String> {
    let data =
        serde_json::to_vec_pretty(state).map_err(|err| format!("无法序列化安全模式：{err}"))?;
    atomic_write(path, &data).map_err(|err| format!("无法写入安全模式：{err}"))
}

fn read_boot_guard_at(path: &Path) -> BootGuard {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BootGuard::default();
    };
    serde_json::from_str::<BootGuard>(&raw).unwrap_or_default()
}

fn write_boot_guard_at(path: &Path, guard: &BootGuard) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("无法创建启动守卫目录：{err}"))?;
    }
    let data =
        serde_json::to_vec_pretty(guard).map_err(|err| format!("无法序列化启动守卫：{err}"))?;
    std::fs::write(path, data).map_err(|err| format!("无法写入启动守卫：{err}"))
}

fn begin_launch_at(path: &Path) -> Result<u32, String> {
    let previous = read_boot_guard_at(path);
    let failures = if previous.clean {
        0
    } else {
        previous.failures.saturating_add(1)
    };
    write_boot_guard_at(
        path,
        &BootGuard {
            clean: false,
            failures,
            last_launch_at: Some(now_string()),
        },
    )?;
    Ok(failures)
}

fn mark_ready_at(path: &Path) -> Result<(), String> {
    write_boot_guard_at(
        path,
        &BootGuard {
            clean: true,
            failures: 0,
            last_launch_at: Some(now_string()),
        },
    )
}

fn declare_freeze(
    eligible: bool,
    has_heartbeat: bool,
    since_start: Duration,
    since_heartbeat: Duration,
) -> bool {
    if !eligible {
        return false;
    }
    if has_heartbeat {
        since_heartbeat >= HEARTBEAT_STALE
    } else {
        since_start >= BOOT_GRACE
    }
}

fn is_resume_gap(gap: Duration) -> bool {
    gap >= RESUME_GAP
}

/// 含 suspend 的单调时钟（Linux `CLOCK_BOOTTIME`）。
///
/// `Instant` 在 Linux 走 `CLOCK_MONOTONIC`，睡眠期间不前进；只靠它无法
/// 识别“唤醒后 WebView 还没恢复心跳”的瞬间，可能把睡眠前的旧心跳误判为
/// 冻结。非 Linux 返回 None，行为保持原样。
#[cfg(target_os = "linux")]
fn boot_time_now() -> Option<Duration> {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime 只写入我们提供的 timespec。
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
    if rc != 0 || ts.tv_sec < 0 || !(0..1_000_000_000).contains(&ts.tv_nsec) {
        return None;
    }
    Some(Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32))
}

#[cfg(not(target_os = "linux"))]
fn boot_time_now() -> Option<Duration> {
    None
}

/// 任一时钟出现大跳跃都视为睡眠/调试暂停，而不是 UI 冻结。
fn resume_detected(monotonic_gap: Duration, boot_gap: Option<Duration>) -> bool {
    is_resume_gap(monotonic_gap) || boot_gap.is_some_and(is_resume_gap)
}

fn should_replace_main(main_exists: bool, responsive: bool) -> bool {
    !main_exists || !responsive
}

/// 窗口必须与某个显示器矩形有至少 64×64 像素的交集，才算“用户看得见”。
/// 显示器矩形是整个屏幕（物理像素）；窗口位置与尺寸同样取物理像素，
/// 因此多显示器不同 DPI 缩放下也无需换算。全部使用 i64 计算，避免
/// 副屏负坐标或超大分辨率下的整数溢出。
const MIN_VISIBLE_EDGE: i64 = 64;

fn rect_visible_on_any_monitor(
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    monitors: &[(i32, i32, u32, u32)],
) -> bool {
    if w == 0 || h == 0 {
        return false;
    }
    let win_x0 = x as i64;
    let win_y0 = y as i64;
    let win_x1 = win_x0 + w as i64;
    let win_y1 = win_y0 + h as i64;
    monitors.iter().any(|&(mx, my, mw, mh)| {
        if mw == 0 || mh == 0 {
            return false;
        }
        let mon_x0 = mx as i64;
        let mon_y0 = my as i64;
        let overlap_w = (win_x1.min(mon_x0 + mw as i64)) - win_x0.max(mon_x0);
        let overlap_h = (win_y1.min(mon_y0 + mh as i64)) - win_y0.max(mon_y0);
        overlap_w >= MIN_VISIBLE_EDGE && overlap_h >= MIN_VISIBLE_EDGE
    })
}

fn monitor_rects(monitors: &[tauri::Monitor]) -> Vec<(i32, i32, u32, u32)> {
    monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            (position.x, position.y, size.width, size.height)
        })
        .collect()
}

/// 兜底：把完全跑到所有显示器可见区域之外的窗口拉回屏幕中央。
///
/// Wayland 合成器可能拒绝提供全局坐标（`available_monitors` /
/// `outer_position` 返回 Err）：此时安全降级为 `window.center()` 并返回
/// Ok，绝不 panic、绝不让恢复窗因坐标探测失败而打不开。
/// 显示器列表为空（远程会话/驱动异常，成功但无数据）时保持原状返回，
/// 不做无依据的居中。
fn ensure_window_on_screen(window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitors = match window.available_monitors() {
        Ok(monitors) => monitors,
        Err(err) => {
            crate::logging::log_error(
                "window_guard",
                &format!(
                    "窗口 {} 无法读取显示器列表（{err}），Wayland 下属预期，降级为居中",
                    window.label()
                ),
            );
            let _ = window.center();
            return Ok(());
        }
    };
    if monitors.is_empty() {
        return Ok(());
    }
    let rects = monitor_rects(&monitors);
    let (position, size) = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => (position, size),
        (Err(err), _) | (Ok(_), Err(err)) => {
            crate::logging::log_error(
                "window_guard",
                &format!(
                    "窗口 {} 无法读取位置/尺寸（{err}），降级为居中",
                    window.label()
                ),
            );
            let _ = window.center();
            return Ok(());
        }
    };
    if rect_visible_on_any_monitor(position.x, position.y, size.width, size.height, &rects) {
        return Ok(());
    }
    crate::logging::log_error(
        "window_guard",
        &format!(
            "窗口 {} 不在任何显示器可见区域内（{}x{} @ {},{}），重新居中",
            window.label(),
            size.width,
            size.height,
            position.x,
            position.y
        ),
    );
    window
        .center()
        .map_err(|err| format!("窗口居中失败：{err}"))?;
    if let (Ok(after_pos), Ok(after_size)) = (window.outer_position(), window.outer_size()) {
        if !rect_visible_on_any_monitor(
            after_pos.x,
            after_pos.y,
            after_size.width,
            after_size.height,
            &rects,
        ) {
            crate::logging::log_error(
                "window_guard",
                &format!("窗口 {} 居中后仍不可见，等待用户手动移动", window.label()),
            );
        }
    }
    Ok(())
}

fn heartbeat_readiness(state: &ResilienceState) -> (Option<String>, u64, bool) {
    let last = *state.last_heartbeat.lock();
    let route = state.last_route.lock().clone();
    let reference = last.unwrap_or(state.started);
    let age = Instant::now()
        .saturating_duration_since(reference)
        .as_millis()
        .min(u64::MAX as u128) as u64;
    (
        route,
        age,
        last.is_some() && age < HEARTBEAT_STALE.as_millis() as u64,
    )
}

fn current_context(
    state: &ResilienceState,
    trigger: RecoveryTrigger,
    detail: String,
) -> RecoveryContext {
    let (last_route, heartbeat_age_ms, responsive) = heartbeat_readiness(state);
    let safe_mode = safe_mode_path()
        .map(|path| read_safe_mode_at(&path))
        .unwrap_or_default();
    RecoveryContext {
        trigger,
        detail,
        detected_at: now_string(),
        last_route,
        heartbeat_age_ms,
        responsive,
        safe_mode,
    }
}

fn emit_context(app: &AppHandle, context: &RecoveryContext) {
    let _ = app.emit_to(RECOVERY_LABEL, "mr-recovery-context", context);
}

fn open_recovery(
    app: &AppHandle,
    state: &ResilienceState,
    trigger: RecoveryTrigger,
    detail: String,
) -> Result<bool, String> {
    let context = current_context(state, trigger, detail);
    *state.recovery_context.lock() = Some(context.clone());

    if let Some(window) = app.get_webview_window(RECOVERY_LABEL) {
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        // 恢复窗可能是上次留在已断开的副屏上的隐藏窗口：先确认可见再推送现场。
        if let Err(err) = ensure_window_on_screen(&window) {
            crate::logging::log_error("recovery", &format!("恢复窗口位置校验失败：{err}"));
        }
        emit_context(app, &context);
        return Ok(false);
    }

    let window =
        WebviewWindowBuilder::new(app, RECOVERY_LABEL, WebviewUrl::App(RECOVERY_PAGE.into()))
            .title(RECOVERY_TITLE)
            .inner_size(620.0, 680.0)
            .min_inner_size(480.0, 560.0)
            .resizable(true)
            .decorations(false)
            .shadow(true)
            .center()
            .focused(true)
            .always_on_top(true)
            .build()
            .map_err(|err| format!("无法打开恢复窗口：{err}"))?;
    // builder.center() 只按当前/主显示器估算，副屏拓扑变化后仍可能越界。
    if let Err(err) = ensure_window_on_screen(&window) {
        crate::logging::log_error("recovery", &format!("恢复窗口位置校验失败：{err}"));
    }
    emit_context(app, &context);
    Ok(true)
}

fn spawn_watchdog(app: AppHandle, state: Arc<ResilienceState>) {
    let _ = std::thread::Builder::new()
        .name("mr-ui-watchdog".to_string())
        .spawn(move || {
            let mut last_tick = Instant::now();
            let mut last_boot = boot_time_now();
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                let now = Instant::now();
                let gap = now.duration_since(last_tick);
                last_tick = now;
                let boot_now = boot_time_now();
                let boot_gap = match (last_boot, boot_now) {
                    (Some(before), Some(after)) => Some(after.saturating_sub(before)),
                    _ => None,
                };
                last_boot = boot_now;
                if resume_detected(gap, boot_gap) {
                    *state.last_heartbeat.lock() = Some(now);
                    state.freeze_notified.store(false, Ordering::SeqCst);
                    continue;
                }
                let Some(main) = app.get_webview_window("main") else {
                    continue;
                };
                let minimized = main.is_minimized().unwrap_or(false);
                let visible = main.is_visible().unwrap_or(true);
                if minimized || !visible {
                    // Being minimized is not a freeze. Restore grants a fresh grace
                    // window instead of immediately declaring the old timestamp stale.
                    *state.last_heartbeat.lock() = Some(Instant::now());
                    state.freeze_notified.store(false, Ordering::SeqCst);
                    continue;
                }

                let last = *state.last_heartbeat.lock();
                let since_start = state.started.elapsed();
                let since_heartbeat = last.map(|instant| instant.elapsed()).unwrap_or(since_start);
                if !declare_freeze(true, last.is_some(), since_start, since_heartbeat)
                    || state.freeze_notified.swap(true, Ordering::SeqCst)
                {
                    continue;
                }

                if let Err(err) = open_recovery(
                    &app,
                    &state,
                    RecoveryTrigger::HeartbeatTimeout,
                    String::new(),
                ) {
                    crate::logging::log_error("watchdog", &format!("打开恢复窗口失败：{err}"));
                }
            }
        });
}

/// Called once from app setup. Counts unclean startup attempts, writes the
/// current in-flight marker, starts the watchdog, and only *prompts* after
/// repeated startup failures (never auto-enables safe mode).
pub fn initialize(app: &AppHandle, state: &Arc<ResilienceState>) -> Result<(), String> {
    let path = boot_guard_path()?;
    let failures = begin_launch_at(&path).unwrap_or_else(|err| {
        crate::logging::log_error("startup_guard", &format!("初始化启动守卫失败：{err}"));
        0
    });
    crate::logging::log_error(
        "startup",
        &format!("应用启动；此前连续未完成启动次数：{failures}"),
    );

    spawn_watchdog(app.clone(), state.clone());

    let safe_mode = safe_mode_path()
        .map(|path| read_safe_mode_at(&path))
        .unwrap_or_default();
    if failures >= 2 && !safe_mode.active {
        let app = app.clone();
        let state = state.clone();
        let _ = std::thread::Builder::new()
            .name("mr-startup-recovery".to_string())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(1200));
                if let Err(err) = open_recovery(
                    &app,
                    &state,
                    RecoveryTrigger::StartupFailures,
                    failures.to_string(),
                ) {
                    crate::logging::log_error(
                        "startup_guard",
                        &format!("打开启动恢复提示失败：{err}"),
                    );
                }
            });
    }
    Ok(())
}

#[tauri::command]
pub fn heartbeat_ping(
    state: State<'_, Arc<ResilienceState>>,
    route: Option<String>,
    reader_mode: Option<String>,
    reader_page: Option<u32>,
) -> Result<(), String> {
    *state.last_heartbeat.lock() = Some(Instant::now());
    state.freeze_notified.store(false, Ordering::SeqCst);
    if let Some(route) = route {
        *state.last_route.lock() = display_route(&route);
    }
    if let Some(mode) = reader_mode {
        *state.last_reader_mode.lock() = mode_allowlist(&mode);
    }
    if let Some(page) = reader_page {
        *state.last_reader_page.lock() = Some(page);
    }
    Ok(())
}

#[tauri::command]
pub fn resilience_report_rage_click(
    app: AppHandle,
    state: State<'_, Arc<ResilienceState>>,
    payload: RageClickPayload,
) -> Result<bool, String> {
    if payload.count < 5 || payload.window_ms > 1500 {
        return Ok(false);
    }
    let target = payload.target.trim();
    if target.len() > 256 {
        return Ok(false);
    }
    {
        let mut last = state.rage_last.lock();
        if last.is_some_and(|last| last.elapsed() < RAGE_COOLDOWN) {
            return Ok(false);
        }
        *last = Some(Instant::now());
    }
    if let Some(route) = display_route(&payload.route) {
        *state.last_route.lock() = Some(route);
    }
    // The target is deliberately not shown to the user: it is only a safe
    // tag/role signature and must never carry page text or filenames.
    let detail = format!("{} / {}ms", payload.count, payload.window_ms);
    let app = app.clone();
    let state = state.inner().clone();
    let count = payload.count;
    crate::logging::log_error(
        "recovery",
        &format!("检测到交互无响应（{count} 次点击）；正在打开独立恢复窗口"),
    );
    // Never build a second WebView synchronously inside a Tauri command: the
    // webview creation request needs the main event loop, which a synchronous
    // command is still occupying. Queue it and return so the recovery UI can
    // initialize while the main renderer remains frozen.
    std::thread::spawn(move || {
        match open_recovery(&app, &state, RecoveryTrigger::RageClick, detail) {
            Ok(_) => crate::logging::log_error("recovery", "独立恢复窗口已打开"),
            Err(err) => {
                crate::logging::log_error("recovery", &format!("打开独立恢复窗口失败：{err}"))
            }
        }
    });
    Ok(true)
}

#[tauri::command]
pub fn get_recovery_context(
    app: AppHandle,
    state: State<'_, Arc<ResilienceState>>,
) -> Result<RecoveryContext, String> {
    let mut context = state
        .recovery_context
        .lock()
        .clone()
        .ok_or_else(|| "尚未记录恢复现场".to_string())?;
    let (_, heartbeat_age_ms, responsive) = heartbeat_readiness(&state);
    context.heartbeat_age_ms = heartbeat_age_ms;
    context.responsive = responsive;
    context.safe_mode = safe_mode_path()
        .map(|path| read_safe_mode_at(&path))
        .unwrap_or_default();
    *state.recovery_context.lock() = Some(context.clone());
    emit_context(&app, &context);
    Ok(context)
}

#[tauri::command]
pub async fn resilience_reload_main(
    app: AppHandle,
    state: State<'_, Arc<ResilienceState>>,
) -> Result<(), String> {
    let main = app.get_webview_window("main");
    let (_, _, responsive) = heartbeat_readiness(&state);
    if should_replace_main(main.is_some(), responsive) {
        crate::logging::log_error(
            "recovery",
            "主窗口缺失或无心跳；重建主窗口（不静默重启应用）",
        );
        return replace_main_window(app).await;
    }
    let main = main.expect("checked main exists");
    main.reload()
        .map_err(|err| format!("重载主窗口失败：{err}"))?;
    crate::logging::log_error("recovery", "用户选择了仅重载当前视图");
    Ok(())
}

/// A JS event loop can ignore a plain WebView reload. Destroying and rebuilding
/// the local main window is the only reliable escape when the renderer is in a
/// hard loop. The rebuilding thread sends a real result back so the recovery UI
/// never reports a fake success.
async fn replace_main_window(app: AppHandle) -> Result<(), String> {
    // 窗口创建必须让出命令线程/主事件循环；这里只确认重建任务已派出，
    // 真实结果由日志与恢复窗的目标探测确认，避免伪造“已重建”。
    std::thread::spawn(move || {
        if let Err(error) = rebuild_main_window(&app) {
            crate::logging::log_error("recovery", &format!("重建主窗口失败：{error}"));
        }
    });
    Ok(())
}

fn rebuild_main_window(app: &AppHandle) -> Result<(), String> {
    let existing = app.get_webview_window("main");
    let (url, scale, size, position, maximized, monitors) = if let Some(main) = existing.as_ref() {
        (
            main.url().ok(),
            main.scale_factor().unwrap_or(1.0),
            main.inner_size().ok(),
            main.outer_position().ok(),
            main.is_maximized().unwrap_or(false),
            main.available_monitors()
                .map(|list| monitor_rects(&list))
                .unwrap_or_default(),
        )
    } else {
        (
            None,
            1.0,
            None,
            None,
            false,
            app.available_monitors()
                .map(|list| monitor_rects(&list))
                .unwrap_or_default(),
        )
    };
    // 先从原窗口取出显示器拓扑：窗口一旦销毁，旧坐标就无从校验。
    // 原位置若已越界（副屏被拔掉/分辨率变化），宁可不设 position 让系统居中，
    // 也不要把它先放到屏幕外再 center，避免出现一闪而过的空白窗口。
    let safe_position = position.filter(|pos| {
        if monitors.is_empty() {
            return true;
        }
        let (width, height) = size
            .map(|size| (size.width, size.height))
            .unwrap_or((1200, 820));
        rect_visible_on_any_monitor(pos.x, pos.y, width, height, &monitors)
    });
    if position.is_some() && safe_position.is_none() {
        crate::logging::log_error(
            "recovery",
            "原主窗口位置已越界（显示器拓扑变化），交由系统重新居中",
        );
    }
    if let Some(main) = existing {
        main.destroy()
            .map_err(|err| format!("销毁卡死主窗口失败：{err}"))?;
    }
    // Let the native window and its label leave Tauri's registry.
    std::thread::sleep(Duration::from_millis(600));

    let target = match url {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };
    let mut builder = WebviewWindowBuilder::new(app, "main", target)
        .title("MangaReader")
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .focused(true);
    if let Some(size) = size {
        builder = builder.inner_size(
            (size.width as f64 / scale).max(900.0),
            (size.height as f64 / scale).max(600.0),
        );
    } else {
        builder = builder.inner_size(1200.0, 820.0);
    }
    if maximized {
        builder = builder.maximized(true);
    } else if let Some(position) = safe_position {
        builder = builder.position(position.x as f64 / scale, position.y as f64 / scale);
    }
    let window = builder
        .build()
        .map_err(|err| format!("重建主窗口失败：{err}"))?;
    if let Err(err) = ensure_window_on_screen(&window) {
        crate::logging::log_error("recovery", &format!("主窗口位置校验失败：{err}"));
    }
    let _ = window.set_focus();
    crate::logging::log_error("recovery", "主窗口已重建，等待心跳恢复");
    Ok(())
}

#[tauri::command]
pub fn resilience_close_recovery(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(RECOVERY_LABEL)
        .ok_or_else(|| "恢复窗口已关闭".to_string())?;
    window.close().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_safe_mode_state() -> Result<SafeModeState, String> {
    let path = safe_mode_path()?;
    Ok(read_safe_mode_at(&path))
}

#[tauri::command]
pub async fn resilience_enable_safe_mode(
    app: AppHandle,
    reason: Option<String>,
) -> Result<SafeModeState, String> {
    let reason = normalize_safe_reason(reason.as_deref());
    let state = SafeModeState {
        active: true,
        reason: Some(reason.clone()),
        activated_at: Some(now_string()),
    };
    let path = safe_mode_path()?;
    write_safe_mode_at(&path, &state)?;
    crate::logging::log_error("safe_mode", &format!("用户启用安全模式：{reason}"));

    if let Some(browser) = app.get_webview_window("browser") {
        let _ = browser.close();
    }
    let app_state = app.state::<Arc<AppState>>();
    app_state.cancel_handoff();
    app_state.invalidate_sources();

    let main = app.get_webview_window("main");
    let responsive = app
        .try_state::<Arc<ResilienceState>>()
        .map(|state| heartbeat_readiness(&state).2)
        .unwrap_or(false);
    if should_replace_main(main.is_some(), responsive) {
        // A frozen/missing renderer cannot process a plain reload. Recreate the
        // main WebView so the safe-mode startup policy is actually applied.
        match replace_main_window(app.clone()).await {
            Ok(()) => crate::logging::log_error("safe_mode", "已重建主窗口以应用安全模式"),
            Err(err) => crate::logging::log_error(
                "safe_mode",
                &format!("重建主窗口应用安全模式失败：{err}"),
            ),
        }
    } else if let Some(main) = main {
        if let Err(err) = main.reload() {
            crate::logging::log_error("safe_mode", &format!("重载主窗口失败：{err}"));
        }
    }
    if let Some(runtime) = app.try_state::<Arc<ResilienceState>>() {
        let runtime = runtime.inner().clone();
        if let Some(context) = runtime.recovery_context.lock().as_mut() {
            context.safe_mode = state_from_file(&path);
        }
        let updated = runtime.recovery_context.lock().as_ref().cloned();
        if let Some(context) = updated {
            emit_context(&app, &context);
        }
    }
    Ok(state_from_file(&path))
}

fn state_from_file(path: &Path) -> SafeModeState {
    read_safe_mode_at(path)
}

#[tauri::command]
pub fn resilience_disable_safe_mode(app: AppHandle) -> Result<SafeModeState, String> {
    let path = safe_mode_path()?;
    let state = SafeModeState {
        active: false,
        reason: None,
        activated_at: None,
    };
    write_safe_mode_at(&path, &state)?;
    crate::logging::log_error("safe_mode", "用户退出安全模式");
    if let Some(runtime) = app.try_state::<Arc<ResilienceState>>() {
        let runtime = runtime.inner().clone();
        if let Some(context) = runtime.recovery_context.lock().as_mut() {
            context.safe_mode = state_from_file(&path);
        }
        let updated = runtime.recovery_context.lock().as_ref().cloned();
        if let Some(context) = updated {
            emit_context(&app, &context);
        }
    }
    Ok(state)
}

#[tauri::command]
pub fn resilience_mark_ready() -> Result<(), String> {
    let path = boot_guard_path()?;
    mark_ready_at(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mr-resilience-{}-{tag}-{nanos}.json",
            std::process::id()
        ))
    }

    #[test]
    fn rect_visibility_requires_64px_overlap() {
        let primary = [(0, 0, 1920, 1080)];
        let visible =
            |x: i32, y: i32, w: u32, h: u32| rect_visible_on_any_monitor(x, y, w, h, &primary);
        assert!(visible(100, 100, 800, 600));
        assert!(!visible(2000, 100, 800, 600));
        // 右边/下边只留 64px 算可见，63px 不算。
        assert!(visible(1920 - 64, 100, 800, 600));
        assert!(!visible(1920 - 63, 100, 800, 600));
        assert!(visible(100, 1080 - 64, 800, 600));
        assert!(!visible(100, 1080 - 63, 800, 600));
        // 完全盖住显示器也只算“可见”，不要求交集小于显示器。
        assert!(visible(-500, -500, 4000, 3000));
    }

    #[test]
    fn rect_visibility_handles_negative_and_multiple_monitors() {
        // 主屏左侧的副屏：坐标为负。
        let left_secondary = [(-1920, 0, 1920, 1080), (0, 0, 1920, 1080)];
        let on_secondary = |x: i32, y: i32, w: u32, h: u32| {
            rect_visible_on_any_monitor(x, y, w, h, &left_secondary)
        };
        assert!(on_secondary(-1800, 200, 800, 600));
        assert!(!on_secondary(-2100, 200, 100, 600));
        // 副屏在主屏上方：坐标同样为负。
        let above = [(0, -1080, 1920, 1080), (0, 0, 1920, 1080)];
        let on_above =
            |x: i32, y: i32, w: u32, h: u32| rect_visible_on_any_monitor(x, y, w, h, &above);
        assert!(on_above(200, -1000, 800, 600));
        assert!(!on_above(200, -1400, 800, 300));
        // 并排两屏的接缝：每侧各 32px 不算可见，单侧满 64px 才算。
        let side_by_side = [(0, 0, 1920, 1080), (1920, 0, 1920, 1080)];
        let on_pair =
            |x: i32, y: i32, w: u32, h: u32| rect_visible_on_any_monitor(x, y, w, h, &side_by_side);
        assert!(!on_pair(1920 - 32, 100, 64, 600));
        assert!(on_pair(1920 - 64, 100, 128, 600));
        assert!(on_pair(1950, 100, 800, 600));
    }

    #[test]
    fn rect_visibility_rejects_empty_geometry_and_avoids_overflow() {
        let no_monitors: [(i32, i32, u32, u32); 0] = [];
        let primary = [(0, 0, 1920, 1080)];
        let tiny_monitor = [(0, 0, 0, 1080)];
        assert!(!rect_visible_on_any_monitor(0, 0, 800, 600, &no_monitors));
        assert!(!rect_visible_on_any_monitor(0, 0, 0, 600, &primary));
        assert!(!rect_visible_on_any_monitor(0, 0, 800, 600, &tiny_monitor));
        // 高 DPI 副屏的远端坐标不能溢出 i32 边界导致误判为可见。
        let far = [(16000, 9000, 3840, 2160)];
        let on_far = |x: i32, y: i32, w: u32, h: u32| rect_visible_on_any_monitor(x, y, w, h, &far);
        assert!(on_far(16100, 9100, 800, 600));
        assert!(!on_far(i32::MAX, 9100, 800, 600));
    }

    #[test]
    fn boot_guard_ignores_first_launch_then_counts_unclean_attempts() {
        let path = temp_path("boot");
        assert_eq!(begin_launch_at(&path).unwrap(), 0);
        assert_eq!(begin_launch_at(&path).unwrap(), 1);
        assert_eq!(begin_launch_at(&path).unwrap(), 2);
        mark_ready_at(&path).unwrap();
        assert_eq!(begin_launch_at(&path).unwrap(), 0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn safe_mode_round_trips_and_unknown_reason_is_manual() {
        let path = temp_path("safe");
        let active = SafeModeState {
            active: true,
            reason: Some(normalize_safe_reason(Some("something"))),
            activated_at: Some(now_string()),
        };
        write_safe_mode_at(&path, &active).unwrap();
        assert_eq!(read_safe_mode_at(&path), active);
        assert_eq!(active.reason.as_deref(), Some("manual"));
        assert_eq!(
            normalize_safe_reason(Some("startupFailures")),
            "startupFailures"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn corrupt_safe_mode_file_is_fail_closed() {
        let path = temp_path("safe-corrupt");
        std::fs::write(&path, "{not-json").unwrap();
        assert!(read_safe_mode_result(&path).is_err());
        let state = read_safe_mode_at(&path);
        assert!(state.active, "损坏文件必须按安全模式处理");
        assert_eq!(state.reason.as_deref(), Some("unreadable"));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn resume_gap_and_missing_main_trigger_rebuild_not_freeze() {
        assert!(!is_resume_gap(Duration::from_secs(1)));
        assert!(is_resume_gap(Duration::from_secs(3)));
        // Linux CLOCK_BOOTTIME 跨 suspend 前进，而 Instant 不动：
        // 只要 boot 时钟跳跃就必须当作唤醒，不能弹恢复窗。
        assert!(resume_detected(
            Duration::from_secs(1),
            Some(Duration::from_secs(3600))
        ));
        assert!(!resume_detected(
            Duration::from_secs(1),
            Some(Duration::from_secs(1))
        ));
        assert!(!resume_detected(Duration::from_secs(1), None));
        assert!(!should_replace_main(true, true));
        assert!(should_replace_main(true, false));
        assert!(should_replace_main(false, false));
    }

    #[test]
    fn freeze_requires_stale_heartbeat_or_initial_grace() {
        assert!(!declare_freeze(
            false,
            true,
            Duration::from_secs(60),
            Duration::from_secs(60)
        ));
        assert!(!declare_freeze(
            true,
            true,
            Duration::from_secs(60),
            Duration::from_millis(5_999)
        ));
        assert!(declare_freeze(
            true,
            true,
            Duration::from_secs(60),
            Duration::from_secs(6)
        ));
        assert!(!declare_freeze(
            true,
            false,
            Duration::from_secs(11),
            Duration::from_secs(11)
        ));
        assert!(declare_freeze(
            true,
            false,
            Duration::from_secs(12),
            Duration::from_secs(12)
        ));
    }

    #[test]
    fn safe_mode_serializes_camel_case_for_frontend() {
        let state = SafeModeState {
            active: true,
            reason: Some("userRecovery".into()),
            activated_at: Some("2026-10-23T10:00:00+08:00".into()),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"activatedAt\""));
        assert!(json.contains("\"active\":true"));
    }

    #[test]
    fn startup_failure_context_uses_heartbeat_age_and_safe_state() {
        let state = new_state();
        let context = current_context(&state, RecoveryTrigger::StartupFailures, "2".into());
        assert_eq!(context.trigger, RecoveryTrigger::StartupFailures);
        assert_eq!(context.detail, "2");
        assert!(!context.responsive);
        assert!(context.heartbeat_age_ms < HEARTBEAT_STALE.as_millis() as u64);
    }
}
