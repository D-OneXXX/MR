//! 批量预翻译队列:整话(整本书)后台跑 检测 → OCR → 翻译(带缓存),
//! 进度写 SQLite `batch_jobs`,书库看板/工作台轮询展示;支持暂停/继续/取消。
//! worker 常驻:循环取 queued 任务;每页处理前重读任务状态,暂停/取消即时生效。
//! 已有页 OCR 存档(page_ocr)的页直接跳过模型,重跑/续跑都是增量。

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::State;

use crate::commands::{blocking, err};
use crate::db::{self, BatchJobRow};
use crate::sidecar::{self, DetectBox};
use crate::state::AppState;
use crate::workbench::{load_page_png_for_book, translate_texts_cached};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJobDto {
    pub id: i64,
    pub book_id: String,
    pub book_title: String,
    pub state: String,
    pub total_pages: u32,
    pub done_pages: u32,
    pub ok_pages: u32,
    pub fail_pages: u32,
    pub last_error: String,
}

impl From<BatchJobRow> for BatchJobDto {
    fn from(r: BatchJobRow) -> Self {
        Self {
            id: r.id,
            book_id: r.book_id,
            book_title: r.book_title,
            state: r.state,
            total_pages: r.total_pages,
            done_pages: r.done_pages,
            ok_pages: r.ok_pages,
            fail_pages: r.fail_pages,
            last_error: r.last_error,
        }
    }
}

/// 常驻 worker:取 queued 任务逐个跑;空转时 2.5s 轮询一次(异步睡眠,不占线程)。
pub fn spawn_worker(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let next = state
                .db
                .with(|conn| db::batch_next_queued(conn).map_err(err))
                .ok()
                .flatten();
            match next {
                None => tokio::time::sleep(Duration::from_millis(2500)).await,
                Some(job) => run_job(&state, job).await,
            }
        }
    });
}

async fn run_job(st: &Arc<AppState>, job: BatchJobRow) {
    // 只校验书籍存在；页面读取按 bookId 走统一源（本地/在线共用）。
    match st.db.with(|conn| db::get_book(conn, &job.book_id).map_err(err)) {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = st.db.with(|conn| {
                db::batch_set_state(conn, job.id, "failed", "书籍不存在(可能已被移除)").map_err(err)
            });
            return;
        }
        Err(e) => {
            let _ = st
                .db
                .with(|conn| db::batch_set_state(conn, job.id, "failed", &e).map_err(err));
            return;
        }
    };
    let _ = st.db.with(|conn| {
        db::batch_set_state(conn, job.id, "running", "").map_err(err)
    });

    let total = job.total_pages;
    let mut done = job.done_pages.min(total);
    let mut ok = job.ok_pages;
    let mut fail = job.fail_pages;
    let mut last_err = String::new();

    while done < total {
        // 每页前重读状态:paused/cancelled 等外部迁移立即生效。
        let cur = st
            .db
            .with(|conn| db::batch_get(conn, job.id).map_err(err))
            .ok()
            .flatten();
        match cur {
            Some(j) if j.state == "running" => {}
            _ => return, // 暂停/取消/被移除:留在当前状态,等 resume 重新入队
        }

        match process_page(st, &job.book_id, done).await {
            Ok(_) => {
                ok += 1;
                last_err.clear();
            }
            Err(e) => {
                fail += 1;
                last_err = e;
            }
        }
        done += 1;
        let _ = st.db.with(|conn| {
            db::batch_progress(conn, job.id, done, ok, fail, &last_err).map_err(err)
        });

        // 服务不可达短路:开头连续 3 页全失败 → 整任务标 failed,别空转几百页。
        if fail >= 3 && ok == 0 && done < total {
            let _ = st.db.with(|conn| {
                db::batch_set_state(conn, job.id, "failed", &last_err).map_err(err)
            });
            return;
        }
        // 让出运行时,避免高频页连续占死异步线程。
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    let final_state = if fail > 0 { "done_errors" } else { "done" };
    let _ = st.db.with(|conn| {
        db::batch_set_state(conn, job.id, final_state, &last_err).map_err(err)
    });
}

/// 一页全流程:已有存档则只补翻译(缓存秒出);否则 检测→OCR→存档→翻译。
async fn process_page(
    st: &Arc<AppState>,
    book_id: &str,
    index: u32,
) -> Result<(u32, u32), String> {
    let stored = st
        .db
        .with(|conn| db::get_page_ocr(conn, book_id, index).map_err(err))?;
    let (width, height, texts) = match stored {
        Some(row) => {
            let texts: Vec<String> = serde_json::from_str(&row.texts).unwrap_or_default();
            (row.width, row.height, texts)
        }
        None => {
            let st2 = Arc::clone(st);
            let bid = book_id.to_string();
            let page = blocking(move || load_page_png_for_book(&st2, &bid, index)).await?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&page.png);
            let (endpoint, timeout) = {
                let s = st.settings.lock().clone();
                (s.sidecar_endpoint, s.sidecar_timeout_s)
            };
            let client = st.http.clone();
            let boxes: Vec<DetectBox> =
                sidecar::detect(&client, endpoint.trim(), &b64, timeout).await?;
            let texts: Vec<String> = if boxes.is_empty() {
                Vec::new()
            } else {
                sidecar::ocr_boxes(&client, endpoint.trim(), &b64, &boxes, timeout)
                    .await?
                    .into_iter()
                    .map(|r| r.text)
                    .collect()
            };
            let boxes_json = serde_json::to_string(&boxes).map_err(err)?;
            let texts_json = serde_json::to_string(&texts).map_err(err)?;
            let (bw, bh) = (page.width, page.height);
            let bid = book_id.to_string();
            st.db.with(move |conn| {
                db::save_page_ocr(conn, &bid, index, bw, bh, &boxes_json, &texts_json)
                    .map_err(err)
            })?;
            (page.width, page.height, texts)
        }
    };
    if !texts.is_empty() {
        translate_texts_cached(st, book_id, index, &texts).await?;
    }
    Ok((width, height))
}

// ---------- commands ----------

#[tauri::command]
pub async fn batch_enqueue(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<BatchJobDto, String> {
    let row = state
        .db
        .with(|conn| db::get_book(conn, &book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    let id = state.db.with(|conn| {
        db::batch_create(conn, &book_id, &row.title, row.page_count).map_err(err)
    })?;
    let job = state
        .db
        .with(|conn| db::batch_get(conn, id).map_err(err))?
        .ok_or_else(|| "任务创建失败".to_string())?;
    Ok(job.into())
}

#[tauri::command]
pub async fn batch_pause(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<(), String> {
    transition_active(&state, &book_id, "paused")
}

#[tauri::command]
pub async fn batch_resume(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<(), String> {
    transition_active(&state, &book_id, "queued")
}

#[tauri::command]
pub async fn batch_cancel(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<(), String> {
    transition_active(&state, &book_id, "cancelled")
}

/// 仅对 queued/running/paused 任务做状态迁移(终态不动)。
fn transition_active(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
    new_state: &str,
) -> Result<(), String> {
    state.db.with(|conn| {
        let jobs = db::batch_list(conn, 200).map_err(err)?;
        for j in jobs {
            if j.book_id == book_id && matches!(j.state.as_str(), "queued" | "running" | "paused") {
                db::batch_set_state(conn, j.id, new_state, "").map_err(err)?;
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn batch_list(state: State<'_, Arc<AppState>>) -> Result<Vec<BatchJobDto>, String> {
    let jobs = state.db.with(|conn| db::batch_list(conn, 50).map_err(err))?;
    Ok(jobs.into_iter().map(Into::into).collect())
}
