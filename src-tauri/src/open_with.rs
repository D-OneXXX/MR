//! 系统文件关联 / 命令行直开。
//!
//! - 首次启动：setup 阶段解析 `std::env::args_os()`，导入后把请求放进
//!   [`AppState`] 的内存队列，并发送一个无载荷的 `open-with-pending` 事件；
//! - 二次启动：`tauri-plugin-single-instance` 回调唤醒主窗口，再走同一套
//!   解析/导入/入队流程；
//! - 前端通过 `take_pending_open` 逐条消费，事件只作为“有新请求”的唤醒
//!   信号，重复事件不会重复打开同一本书。
//!
//! 合规约束：路径只在本机内存/前端之间传递，日志绝不记录完整路径或书名。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::{BookInfo, ImportItemResult};

/// 一次文件关联/命令行直开请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithRequest {
    /// 本次命令行携带的合法路径（已过滤 exe/参数/不支持文件）。
    pub paths: Vec<String>,
    /// added + restored 的条目数。
    pub imported: u32,
    /// failed 的条目数。
    pub failed: u32,
    /// 第一本成功导入/恢复的书；前端直接打开它。
    pub book: Option<BookInfo>,
    /// 稳定的错误码（前端本地化），例如 `import-failed`。
    pub error_code: Option<String>,
}

/// 从命令行参数中提取可打开路径。
///
/// - 跳过 argv[0]（可执行文件自身）；
/// - 跳过空串与以 `-` 开头的开关参数；
/// - 只接受**已存在的目录**或扩展名为 `.zip` / `.cbz` 的文件；
/// - Windows 路径大小写不敏感去重，保留首次出现顺序。
pub fn extract_paths(argv: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (index, raw) in argv.into_iter().enumerate() {
        if index == 0 {
            continue;
        }
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let path = Path::new(trimmed);
        let supported =
            path.is_dir() || (path.is_file() && crate::source::is_archive_path(path));
        if !supported {
            continue;
        }
        let key = trimmed.replace('/', "\\").to_ascii_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn build_request(paths: Vec<String>, items: Vec<ImportItemResult>) -> OpenWithRequest {
    let mut imported = 0u32;
    let mut failed = 0u32;
    let mut book = None;
    for item in items {
        match item.status.as_str() {
            "added" | "restored" => {
                imported = imported.saturating_add(1);
                if book.is_none() {
                    book = item.book;
                }
            }
            "failed" => failed = failed.saturating_add(1),
            _ => {}
        }
    }
    let error_code = if book.is_none() {
        Some("import-failed".to_string())
    } else {
        None
    };
    OpenWithRequest {
        paths,
        imported,
        failed,
        book,
        error_code,
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn import_into_request(db_path: PathBuf, paths: Vec<String>) -> OpenWithRequest {
    if db_path.as_os_str().is_empty() {
        crate::logging::log_error("open_with", "数据库路径尚未初始化，无法导入启动文件");
        return OpenWithRequest {
            paths,
            imported: 0,
            failed: 1,
            book: None,
            error_code: Some("import-failed".to_string()),
        };
    }
    match crate::commands::import_blocking(db_path, paths.clone()) {
        Ok(items) => build_request(paths, items),
        Err(error) => {
            // 错误文本可能含本地路径，只记录动作，不落详情。
            let _ = error;
            crate::logging::log_error("open_with", "导入启动路径失败（详情已省略）");
            OpenWithRequest {
                paths,
                imported: 0,
                failed: 1,
                book: None,
                error_code: Some("import-failed".to_string()),
            }
        }
    }
}

/// 处理一次启动/二次启动的参数。
///
/// 首次启动与二次启动共用：合法路径在后台线程导入，完成后入队并 ping 前端。
/// 没有合法路径时只聚焦主窗口（例如用户直接再次运行 exe）。
pub fn handle_launch(app: &AppHandle, argv: Vec<String>) {
    focus_main(app);
    let paths = extract_paths(argv);
    if paths.is_empty() {
        return;
    }
    let state = match app.try_state::<Arc<AppState>>() {
        Some(state) => state.inner().clone(),
        None => {
            crate::logging::log_error("open_with", "setup 尚未完成，忽略本次启动路径");
            return;
        }
    };
    let db_path = state.db_path();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let request = import_into_request(db_path, paths);
        state.push_open_request(request);
        if let Err(error) = app_handle.emit("open-with-pending", ()) {
            crate::logging::log_error(
                "open_with",
                &format!("发送打开请求失败：{error}"),
            );
        }
    });
}

/// 前端挂载时/收到 `open-with-pending` 后消费请求。
#[tauri::command]
pub fn take_pending_open(state: State<'_, Arc<AppState>>) -> Option<OpenWithRequest> {
    state.take_open_request()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mr-open-with-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn extract_paths_skips_flags_missing_and_unsupported_files() {
        let dir = unique_dir("filter");
        let archive = dir.join("book.cbz");
        std::fs::write(&archive, b"cbz").unwrap();
        let upper = dir.join("BOOK.ZIP");
        std::fs::write(&upper, b"zip").unwrap();
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"text").unwrap();
        let missing = dir.join("missing.cbz");
        let folder = dir.join("pages");
        std::fs::create_dir_all(&folder).unwrap();

        let argv = vec![
            "C:\\App\\MangaReader.exe".to_string(),
            "--flag".to_string(),
            "".to_string(),
            text.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            archive.to_string_lossy().into_owned(),
            upper.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            archive.to_string_lossy().into_owned(),
        ];
        let paths = extract_paths(argv);
        assert_eq!(paths.len(), 3, "zip/cbz/目录各一条，重复项被去掉：{paths:?}");
        assert_eq!(paths[0], archive.to_string_lossy());
        assert_eq!(paths[1], upper.to_string_lossy());
        assert_eq!(paths[2], folder.to_string_lossy());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_request_picks_first_successful_book() {
        let book = |id: &str| BookInfo {
            id: id.to_string(),
            title: id.to_string(),
            path: format!("p/{id}"),
            page_count: 3,
            current_page: 0,
            updated_at: String::new(),
            scroll_pct: -1.0,
            source_type: "local".into(),
            webtoon_ready: true,
            series_id: None,
            series_title: None,
            chapter_index: None,
            next_url: None,
            missing: false,
        };
        let items = vec![
            ImportItemResult {
                path: "a".into(),
                status: "failed".into(),
                message: "x".into(),
                book: None,
            },
            ImportItemResult {
                path: "b".into(),
                status: "added".into(),
                message: "x".into(),
                book: Some(book("b1")),
            },
            ImportItemResult {
                path: "c".into(),
                status: "restored".into(),
                message: "x".into(),
                book: Some(book("b2")),
            },
        ];
        let request = build_request(vec!["a".into(), "b".into(), "c".into()], items);
        assert_eq!(request.imported, 2);
        assert_eq!(request.failed, 1);
        assert_eq!(request.book.as_ref().map(|b| b.id.as_str()), Some("b1"));
        assert!(request.error_code.is_none());
    }
}
