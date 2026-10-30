//! Web Access 进度接口的**契约**（W5）。
//!
//! 本模块**不实现 HTTP**：它只把"数据层结果 ⇄ 接口响应"的映射、客户端恢复规则、
//! 以及"每个动作允许触碰哪些列"的白名单钉死并测掉。
//!
//! 为什么要先有它：HTTP 层（W7）最容易走偏的是**语义**而不是语法——
//! 状态码映射、rev 交接的 off-by-one、409 之后自动重试、
//! 「打开」误改进度三列。这四条都很难靠"读一遍代码"发现，但都能被测试钉死。
//!
//! 规范来源：本模块是 `WEB_ACCESS_API.md` §4.13 / §4.14 / §4.15 的**可执行副本**。
//! W7 的路由层**必须**直接使用 [`progress_response`] / [`next_action`]，
//! 不得另写一套映射——否则契约就退化成没人看的文档。

use std::collections::BTreeSet;

use crate::db::{BookRow, ProgressOutcome};

/// 接口状态（与未来 HTTP 状态码一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressStatus {
    /// 已写入（或本来就已是目标状态）。
    Ok,
    /// 版本过期：**未写入任何东西**。
    Conflict,
    /// 书不存在。
    NotFound,
}

impl ProgressStatus {
    /// 对应的 HTTP 状态码。
    pub fn http_status(self) -> u16 {
        match self {
            ProgressStatus::Ok => 200,
            ProgressStatus::Conflict => 409,
            ProgressStatus::NotFound => 404,
        }
    }
}

/// 稳定错误码（与 `WEB_ACCESS_API.md` §4.13 的 `error.code` 一致）。
pub const ERROR_PROGRESS_CONFLICT: &str = "progress-conflict";
pub const ERROR_BOOK_NOT_FOUND: &str = "book-not-found";

/// 接口响应体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressBody {
    /// 已写入：`rev` 是**操作后**的版本号。
    /// 客户端下一次写入必须用它当 `baseRev`（不是 `baseRev + 1` 的猜测）。
    Applied { rev: i64 },
    /// 版本过期：客户端必须 GET 重新读取后再决定，**不得自动重试**。
    Conflict {
        code: &'static str,
        current_page: u32,
        current_rev: i64,
    },
    /// 书不存在。
    NotFound { code: &'static str },
}

/// 把数据层结果映射成接口响应。
pub fn progress_response(outcome: &ProgressOutcome) -> (ProgressStatus, ProgressBody) {
    match outcome {
        ProgressOutcome::Applied { rev } => {
            (ProgressStatus::Ok, ProgressBody::Applied { rev: *rev })
        }
        ProgressOutcome::Conflict {
            current_page,
            current_rev,
        } => (
            ProgressStatus::Conflict,
            ProgressBody::Conflict {
                code: ERROR_PROGRESS_CONFLICT,
                current_page: *current_page,
                current_rev: *current_rev,
            },
        ),
        ProgressOutcome::NotFound => (
            ProgressStatus::NotFound,
            ProgressBody::NotFound {
                code: ERROR_BOOK_NOT_FOUND,
            },
        ),
    }
}

/// 客户端在收到某个响应后**允许**的动作（契约的一部分）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextAction {
    /// 已达成目标：用响应里的 `rev` 作为下一次写入的 `baseRev`。
    Continue { next_base_rev: i64 },
    /// 版本过期：必须 GET 重新读取，再由用户决定。
    /// **禁止自动重试**——自动重试等价于强制覆盖（`WEB_ACCESS_API.md` §4.13 第 4 条）。
    RefetchThenDecide,
    /// 书不存在：停止。
    Stop,
}

/// 客户端在收到某个响应后应当采取的动作。
pub fn next_action(body: &ProgressBody) -> NextAction {
    match body {
        ProgressBody::Applied { rev } => NextAction::Continue {
            next_base_rev: *rev,
        },
        ProgressBody::Conflict { .. } => NextAction::RefetchThenDecide,
        ProgressBody::NotFound { .. } => NextAction::Stop,
    }
}

/// 进度接口的两个动作（BLK-4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressAction {
    /// 打开：只写 `last_opened_at`。
    Opened,
    /// 进度写入（CAS）。
    Write { page: u32, base_rev: i64 },
}

/// 该动作**允许**触碰的列（白名单，上界）。
///
/// 白名单是**上界**而非等式：一个动作可能合法地什么都不写
/// （例如 no-op 写入、同一秒内写入相同时间戳）。
/// 契约保证的是：**实际改动 ⊆ 白名单**。
pub fn touched_columns(action: &ProgressAction) -> &'static [&'static str] {
    match action {
        ProgressAction::Opened => &["last_opened_at"],
        ProgressAction::Write { .. } => &[
            "current_page",
            "scroll_pct",
            "updated_at",
            "progress_rev",
            "reading_log",
        ],
    }
}

/// 数据库**实际**改动的列集合（用于与白名单对照）。
///
/// `reading_log` 用当日累计页数的差值判定——它是独立表，不在 `books` 行里。
pub fn observed_changes(
    before: &BookRow,
    after: &BookRow,
    log_before: i64,
    log_after: i64,
) -> BTreeSet<&'static str> {
    let mut changed = BTreeSet::new();
    if before.current_page != after.current_page {
        changed.insert("current_page");
    }
    if before.scroll_pct.to_bits() != after.scroll_pct.to_bits() {
        changed.insert("scroll_pct");
    }
    if before.updated_at != after.updated_at {
        changed.insert("updated_at");
    }
    if before.progress_rev != after.progress_rev {
        changed.insert("progress_rev");
    }
    if before.last_opened_at != after.last_opened_at {
        changed.insert("last_opened_at");
    }
    if log_before != log_after {
        changed.insert("reading_log");
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        get_book, init_schema, set_progress, set_progress_cas, touch_opened, upsert_book,
    };
    use rusqlite::Connection;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn log_total(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(pages),0) FROM reading_log WHERE book_id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 钉住两个时间戳与 rev：秒级精度下，靠时间戳差分判"有没有写过"会漏判。
    fn pin(conn: &Connection, id: &str) {
        conn.execute(
            "UPDATE books SET last_opened_at='1999-01-01 00:00:00',
                updated_at='1999-01-01 00:00:00' WHERE id=?1",
            rusqlite::params![id],
        )
        .unwrap();
    }

    fn allowed(action: &ProgressAction) -> BTreeSet<&'static str> {
        touched_columns(action).iter().copied().collect()
    }

    /// 映射必须是全的且稳定的：每个数据层结果都有唯一确定的响应。
    #[test]
    fn mapping_is_total_and_stable() {
        let applied = progress_response(&ProgressOutcome::Applied { rev: 7 });
        assert_eq!(applied.0, ProgressStatus::Ok);
        assert_eq!(applied.0.http_status(), 200);
        assert_eq!(applied.1, ProgressBody::Applied { rev: 7 });

        let conflict = progress_response(&ProgressOutcome::Conflict {
            current_page: 12,
            current_rev: 9,
        });
        assert_eq!(conflict.0, ProgressStatus::Conflict);
        assert_eq!(conflict.0.http_status(), 409);
        assert_eq!(
            conflict.1,
            ProgressBody::Conflict {
                code: ERROR_PROGRESS_CONFLICT,
                current_page: 12,
                current_rev: 9,
            }
        );

        let missing = progress_response(&ProgressOutcome::NotFound);
        assert_eq!(missing.0, ProgressStatus::NotFound);
        assert_eq!(missing.0.http_status(), 404);
        assert_eq!(
            missing.1,
            ProgressBody::NotFound {
                code: ERROR_BOOK_NOT_FOUND
            }
        );
    }

    /// rev 交接：下一次写入必须用**响应里返回的** rev，不是 `base_rev + 1` 的猜测。
    #[test]
    fn next_action_after_applied_uses_the_returned_rev() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        let base = get_book(&conn, "b1").unwrap().unwrap().progress_rev;

        let outcome = set_progress_cas(&conn, "b1", 5, None, base).unwrap();
        let (_, body) = progress_response(&outcome);
        let NextAction::Continue { next_base_rev } = next_action(&body) else {
            panic!("成功写入后必须是 Continue");
        };
        assert_eq!(
            next_base_rev,
            base + 1,
            "next_base_rev 必须是响应返回的 rev，不能是客户端自己猜的"
        );

        // 用返回的 rev 继续写 ⇒ 成功
        let second = set_progress_cas(&conn, "b1", 7, None, next_base_rev).unwrap();
        assert!(
            matches!(second, ProgressOutcome::Applied { .. }),
            "用返回的 rev 继续写必须成功：{second:?}"
        );
    }

    /// 409 之后必须 GET 重新读取再决定——**不是自动重试**。
    #[test]
    fn next_action_after_conflict_requires_refetch_not_retry() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        let base = get_book(&conn, "b1").unwrap().unwrap().progress_rev;
        set_progress_cas(&conn, "b1", 5, None, base).unwrap();

        // 客户端仍拿着过期的 base ⇒ 冲突
        let stale = set_progress_cas(&conn, "b1", 9, None, base).unwrap();
        let (status, body) = progress_response(&stale);
        assert_eq!(status, ProgressStatus::Conflict);
        assert_eq!(
            next_action(&body),
            NextAction::RefetchThenDecide,
            "冲突后的动作必须是重新读取后由用户决定，不允许自动重试"
        );
    }

    /// 404 ⇒ 停止。
    #[test]
    fn next_action_after_not_found_stops() {
        let (_, body) = progress_response(&ProgressOutcome::NotFound);
        assert_eq!(next_action(&body), NextAction::Stop);
    }

    /// 重放同一个 base_rev ⇒ 冲突，且库状态**逐项未变**。
    #[test]
    fn replay_is_conflict_and_changes_nothing() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        let base = get_book(&conn, "b1").unwrap().unwrap().progress_rev;
        set_progress_cas(&conn, "b1", 5, None, base).unwrap();

        pin(&conn, "b1");
        let before = get_book(&conn, "b1").unwrap().unwrap();
        let log_before = log_total(&conn, "b1");

        let replay = set_progress_cas(&conn, "b1", 9, None, base).unwrap();
        let (status, _) = progress_response(&replay);
        assert_eq!(status, ProgressStatus::Conflict);

        let after = get_book(&conn, "b1").unwrap().unwrap();
        let log_after = log_total(&conn, "b1");
        let observed = observed_changes(&before, &after, log_before, log_after);
        assert!(
            observed.is_empty(),
            "冲突必须**什么都没写**，实际改动：{observed:?}"
        );
    }

    /// 「打开」的写足迹：只碰 `last_opened_at`。
    #[test]
    fn opened_action_touches_only_last_opened_at() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        pin(&conn, "b1");
        let before = get_book(&conn, "b1").unwrap().unwrap();
        let log_before = log_total(&conn, "b1");

        touch_opened(&conn, "b1").unwrap();

        let after = get_book(&conn, "b1").unwrap().unwrap();
        let log_after = log_total(&conn, "b1");
        let observed = observed_changes(&before, &after, log_before, log_after);
        assert!(
            observed.is_subset(&allowed(&ProgressAction::Opened)),
            "打开不得触碰进度三列或阅读历史，实际改动：{observed:?}"
        );
        assert!(
            observed.contains("last_opened_at"),
            "打开必须写 last_opened_at，实际改动：{observed:?}"
        );
    }

    /// 「进度写入」的写足迹：绝不碰 `last_opened_at`。
    #[test]
    fn write_action_never_touches_last_opened_at() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        let before = get_book(&conn, "b1").unwrap().unwrap();
        let log_before = log_total(&conn, "b1");
        let base = before.progress_rev;

        set_progress_cas(&conn, "b1", 5, None, base).unwrap();

        let after = get_book(&conn, "b1").unwrap().unwrap();
        let log_after = log_total(&conn, "b1");
        let observed = observed_changes(&before, &after, log_before, log_after);
        assert!(
            observed.is_subset(&allowed(&ProgressAction::Write {
                page: 5,
                base_rev: base
            })),
            "进度写入不得触碰 last_opened_at，实际改动：{observed:?}"
        );
        assert!(
            !observed.contains("last_opened_at"),
            "进度写入绝不允许改 last_opened_at，实际改动：{observed:?}"
        );
    }

    /// no-op 写入：一个列都不许碰。
    #[test]
    fn noop_write_touches_nothing() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        set_progress(&conn, "b1", 4, None).unwrap();
        let base = get_book(&conn, "b1").unwrap().unwrap().progress_rev;
        pin(&conn, "b1");
        let before = get_book(&conn, "b1").unwrap().unwrap();
        let log_before = log_total(&conn, "b1");

        // 目标状态与库中相同 ⇒ no-op
        let outcome = set_progress_cas(&conn, "b1", 4, None, base).unwrap();
        assert!(matches!(outcome, ProgressOutcome::Applied { .. }));

        let after = get_book(&conn, "b1").unwrap().unwrap();
        let log_after = log_total(&conn, "b1");
        let observed = observed_changes(&before, &after, log_before, log_after);
        assert!(
            observed.is_empty(),
            "no-op 写入一个列都不许碰，实际改动：{observed:?}"
        );
    }

    /// 404 不得凭空创建书行。
    #[test]
    fn not_found_creates_nothing() {
        let conn = mem();
        let outcome = set_progress_cas(&conn, "缺失", 1, None, 0).unwrap();
        let (status, _) = progress_response(&outcome);
        assert_eq!(status, ProgressStatus::NotFound);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "不得凭空创建书行");
    }
}
