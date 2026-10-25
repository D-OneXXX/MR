//! 轻量错误日志：追加写本地文件，供"解码失败"等静默问题留痕。
//! 位置：`<数据目录>/logs/app.log`；失败静默（日志永远不能拖垮主流程）。
//!
//! 同时在进程内保留一个有界环形缓冲，仅用于用户主动打开的本地诊断包；
//! 该缓冲绝不联网、绝不写入数据库。

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::Serialize;

const MEMORY_LIMIT: usize = 200;
const MAX_MESSAGE_CHARS: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: String,
    pub scope: String,
    pub message: String,
}

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn ring() -> &'static Mutex<VecDeque<LogEntry>> {
    static RING: OnceLock<Mutex<VecDeque<LogEntry>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(MEMORY_LIMIT)))
}

/// 初始化日志路径（应用 setup 时调用一次）。
pub fn init(dir: PathBuf) {
    if std::fs::create_dir_all(&dir).is_ok() {
        *LOG_FILE.lock() = Some(dir.join("app.log"));
    }
}

/// 追加一行错误：`[时间] [scope] message`，并写入内存环形缓冲。
pub fn log_error(scope: &str, message: &str) {
    let now = chrono::Local::now();
    let at = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
    let message: String = message.chars().take(MAX_MESSAGE_CHARS).collect();
    let scope: String = scope.chars().take(80).collect();

    let path_guard = LOG_FILE.lock();
    if let Some(path) = path_guard.as_ref() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                f,
                "[{}] [{}] {}",
                now.format("%Y-%m-%d %H:%M:%S"),
                scope,
                message
            );
        }
    }
    drop(path_guard);

    let mut entries = ring().lock();
    if entries.len() >= MEMORY_LIMIT {
        entries.pop_front();
    }
    entries.push_back(LogEntry { at, scope, message });
}

/// Oldest-to-newest recent entries, bounded by both `limit` and the ring cap.
pub fn recent_logs(limit: usize) -> Vec<LogEntry> {
    if limit == 0 {
        return Vec::new();
    }
    let entries = ring().lock();
    entries
        .iter()
        .skip(entries.len().saturating_sub(limit))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // `LOG_FILE` is process-global by design; these two tests must not swap it
    // while the other is writing/reading, or `cargo test` becomes flaky.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mr-log-{}-{tag}-{nanos}", std::process::id()))
    }

    #[test]
    fn appends_lines() {
        let _guard = TEST_LOCK.lock();
        let dir = unique_dir("file");
        init(dir.clone());
        log_error("test", "第一条");
        log_error("test", "第二条");
        let content = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(content.contains("第一条") && content.contains("第二条"));
        assert!(content.matches("[test]").count() >= 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn memory_ring_returns_recent_entries_and_is_bounded() {
        let _guard = TEST_LOCK.lock();
        init(unique_dir("ring"));
        for index in 0..(MEMORY_LIMIT + 5) {
            log_error("ring-test", &format!("entry-{index}"));
        }
        let entries = recent_logs(3);
        assert_eq!(entries.len(), 3);
        assert!(entries[2]
            .message
            .ends_with(&format!("entry-{}", MEMORY_LIMIT + 4)));
        assert_eq!(entries[2].scope, "ring-test");
        assert!(recent_logs(10_000).len() <= MEMORY_LIMIT);
    }
}
