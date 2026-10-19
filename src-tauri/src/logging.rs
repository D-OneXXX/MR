//! 轻量错误日志：追加写本地文件，供"解码失败"等静默问题留痕。
//! 位置：`<数据目录>/logs/app.log`；失败静默（日志永远不能拖垮主流程）。

use std::io::Write;
use std::path::PathBuf;

use parking_lot::Mutex;

static LOG_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 初始化日志路径（应用 setup 时调用一次）。
pub fn init(dir: PathBuf) {
    if std::fs::create_dir_all(&dir).is_ok() {
        *LOG_FILE.lock() = Some(dir.join("app.log"));
    }
}

/// 追加一行错误：`[时间] [scope] message`。
pub fn log_error(scope: &str, message: &str) {
    let path_guard = LOG_FILE.lock();
    let Some(path) = path_guard.as_ref() else { return };
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = writeln!(f, "[{ts}] [{scope}] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_lines() {
        let dir = std::env::temp_dir().join(format!("mr-log-{}", std::process::id()));
        init(dir.clone());
        log_error("test", "第一条");
        log_error("test", "第二条");
        let content = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(content.contains("第一条") && content.contains("第二条"));
        assert!(content.matches("[test]").count() >= 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}
