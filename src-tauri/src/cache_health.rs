//! 派生缓存写入健康度。
//!
//! 缓存写入失败不能拖垮阅读，但也不能永远静默。这里只维护一个进程级
//! 计数器；首次失败时写脱敏日志并向主窗 emit `cache-write-failed`，
//! 前端据此 toast。诊断包/内存统计读取同一个计数器。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

static FAILURES: AtomicU64 = AtomicU64::new(0);
static EVENT_SENT: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn app_slot() -> &'static Mutex<Option<AppHandle>> {
    APP.get_or_init(|| Mutex::new(None))
}

/// setup 完成后登记主窗句柄；事件只用于 UI 提示，不参与核心逻辑。
pub fn install(app: AppHandle) {
    *app_slot().lock() = Some(app);
}

pub fn failures() -> u64 {
    FAILURES.load(Ordering::Relaxed)
}

/// 记录一次缓存写入失败。首次失败时：
/// - 日志只写稳定码，不写路径/URL；
/// - 向主窗 emit 无敏感载荷的事件（只发一次，避免刷屏）。
pub fn record_failure() {
    let previous = FAILURES.fetch_add(1, Ordering::SeqCst);
    if previous != 0 {
        return;
    }
    crate::logging::log_error("cache", "缓存写入失败（cache-write-failed，详情已省略）");
    if EVENT_SENT.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(app) = app_slot().lock().as_ref() {
        let _ = app.emit("cache-write-failed", "cache-write-failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_counter_is_monotonic() {
        let before = failures();
        record_failure();
        assert!(failures() > before);
    }
}
