//! SQLite 书库（全新设计）：
//! - `books(id, path, title, page_count, current_page, updated_at)`
//! - `reading_log(date, pages)`：按日累计阅读页数（热力图/今日统计用）
//! - `settings(k, v)`：持久化前端设置（主题/缓存预算/目录/在线源）
//!
//! `id` 为路径的 SHA-256 hex（稳定、可跨扫描复用，保留进度）。

use std::path::Path;
use std::time::Duration;

use chrono::Local;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::source::BackendError;

/// 写锁等待上限：并发扫描/阅读写入时最多排队 5 秒，超出才报 `database is locked`。
pub(crate) const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// 统一连接配置（所有生产入口共用，规则唯一）：
/// - `busy_timeout` 先设置，后续 PRAGMA 切换也能等待锁；
/// - `journal_mode=WAL` 是持久化库属性；内存库返回 `"memory"`，不视为错误；
/// - `synchronous=NORMAL` 在 WAL 下兼顾安全与吞吐；
/// - `foreign_keys=ON` 让级联删除/约束真实生效。
pub(crate) fn configure(conn: &Connection) -> Result<(), BackendError> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// 打开生产库的唯一入口：`Connection::open` + [`configure`]。
pub(crate) fn open(path: impl AsRef<Path>) -> Result<Connection, BackendError> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// 启动自检：`quick_check` 必须返回 ok。比完整 integrity_check 快，
/// 足以在打开/迁移后捕获损坏页、截断库与结构异常。
pub fn quick_check(conn: &Connection) -> Result<(), BackendError> {
    let result: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(BackendError::Db(format!("quick_check 未通过：{result}")))
    }
}

pub fn book_id_for_path(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    hex::encode(h.finalize())
}

pub fn today_str() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_str() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn init_schema(conn: &Connection) -> Result<(), BackendError> {
    // 任何入口（生产 open / 测试内存库）在第一条 SQL 前都完成并发加固。
    configure(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS books(
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            current_page INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT '',
            removed INTEGER NOT NULL DEFAULT 0,
            scroll_pct REAL NOT NULL DEFAULT -1,
            source_type TEXT NOT NULL DEFAULT 'local',
            meta_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS source_stats(
            book_id TEXT PRIMARY KEY
                REFERENCES books(id) ON DELETE CASCADE ON UPDATE CASCADE,
            mtime INTEGER NOT NULL DEFAULT 0,
            size INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reading_log(
            date TEXT NOT NULL,
            book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
            pages INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings(
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS app_meta(
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS online_filter_profiles(
            host TEXT PRIMARY KEY,
            main_selector TEXT,
            cdn_pattern TEXT,
            width_min INTEGER,
            width_max INTEGER,
            aspect_max REAL,
            uses INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS online_filter_rules(
            id TEXT PRIMARY KEY,
            host TEXT NOT NULL,
            action TEXT NOT NULL,
            source TEXT NOT NULL,
            pattern_json TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            hits INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_online_filter_rules_host
            ON online_filter_rules(host);
        CREATE TABLE IF NOT EXISTS online_filter_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host TEXT NOT NULL,
            book_id TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL,
            action TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            width INTEGER,
            height INTEGER,
            sha256 TEXT,
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_online_filter_events_book
            ON online_filter_events(book_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_online_filter_events_unique
            ON online_filter_events(book_id, url, action);",
    )?;
    migrate_reading_log(conn)?;
    migrate_book_columns(conn)?;
    migrate_reading_log_foreign_key(conn)?;
    // 索引必须在旧表形态迁移完成后再建（旧 reading_log 可能还没有 book_id，
    // 旧 books 可能还没有 removed）。
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_log_book_date
             ON reading_log(date, COALESCE(book_id, ''));
         CREATE INDEX IF NOT EXISTS idx_books_list
             ON books(removed, updated_at DESC);",
    )?;
    Ok(())
}

/// 旧库列迁移：
/// - reading_log(date PK) → (date, book_id)，旧数据并入 book_id=''（全局视图仍聚合）；
/// - books 加 removed / scroll_pct / source_type / meta_json 列。
fn table_exists(conn: &Connection, name: &str) -> Result<bool, BackendError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

fn create_reading_log(conn: &Connection) -> Result<(), BackendError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reading_log(
             date TEXT NOT NULL,
             book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
             pages INTEGER NOT NULL DEFAULT 0
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_reading_log_book_date
             ON reading_log(date, COALESCE(book_id, ''));",
    )?;
    Ok(())
}

/// 旧库迁移必须在单事务内完成：rename 后崩溃不能留下半个库。
/// 同时能恢复上次崩在 rename/merge 之间留下的 `reading_log_legacy`。
fn migrate_reading_log(conn: &Connection) -> Result<(), BackendError> {
    let new_exists = table_exists(conn, "reading_log")?;
    let legacy_exists = table_exists(conn, "reading_log_legacy")?;
    let has_book_id: i64 = if new_exists {
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('reading_log') WHERE name='book_id'",
            [],
            |r| r.get(0),
        )?
    } else {
        0
    };
    if new_exists && has_book_id > 0 && !legacy_exists {
        return Ok(());
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let migrated = (|| -> Result<(), BackendError> {
        if !new_exists {
            create_reading_log(conn)?;
        }
        if legacy_exists {
            // 崩溃恢复：旧表已 rename，但新表/合并未完成。
            conn.execute(
                "INSERT OR IGNORE INTO reading_log(date, book_id, pages)
                 SELECT date, NULL, pages FROM reading_log_legacy",
                [],
            )?;
            conn.execute("DROP TABLE reading_log_legacy", [])?;
        } else if new_exists && has_book_id == 0 {
            // 正常旧库：先 rename，再建新表、合并、删旧表。
            conn.execute("ALTER TABLE reading_log RENAME TO reading_log_legacy", [])?;
            create_reading_log(conn)?;
            conn.execute(
                "INSERT OR IGNORE INTO reading_log(date, book_id, pages)
                 SELECT date, NULL, pages FROM reading_log_legacy",
                [],
            )?;
            conn.execute("DROP TABLE reading_log_legacy", [])?;
        }
        Ok(())
    })();

    match migrated {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn reading_log_has_books_fk(conn: &Connection) -> Result<bool, BackendError> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_list('reading_log')")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let table: String = row.get(2)?;
        if table == "books" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 给 reading_log 补 books 外键（可空 book_id 承载旧全局历史）。
///
/// - 全局旧史 `book_id=''` 迁移为 NULL（外键忽略 NULL）；
/// - 真实但已不存在的 book_id 视为孤儿并清掉；
/// - 表达式唯一索引保证 `(date, COALESCE(book_id,''))` 唯一；
/// - 单事务重建，失败回滚。
fn migrate_reading_log_foreign_key(conn: &Connection) -> Result<(), BackendError> {
    if reading_log_has_books_fk(conn)? {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let migrated = (|| -> Result<(), BackendError> {
        conn.execute("ALTER TABLE reading_log RENAME TO reading_log_old_fk", [])?;
        create_reading_log(conn)?;
        conn.execute(
            "INSERT INTO reading_log(date, book_id, pages)
             SELECT date, NULLIF(book_id, ''), pages
             FROM reading_log_old_fk
             WHERE book_id = '' OR book_id IN (SELECT id FROM books)",
            [],
        )?;
        conn.execute("DROP TABLE reading_log_old_fk", [])?;
        Ok(())
    })();
    match migrated {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 无则加列（SQLite ALTER ADD 带默认值，老行自动取默认）。
fn migrate_book_columns(conn: &Connection) -> Result<(), BackendError> {
    let books_has_removed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='removed'",
        [],
        |r| r.get(0),
    )?;
    if books_has_removed == 0 {
        conn.execute("ALTER TABLE books ADD COLUMN removed INTEGER NOT NULL DEFAULT 0", [])?;
    }
    let books_has_pct: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='scroll_pct'",
        [],
        |r| r.get(0),
    )?;
    if books_has_pct == 0 {
        // 条漫模式：滚动偏移百分比（-1 = 尚无条漫阅读记录/分页模式）。
        conn.execute(
            "ALTER TABLE books ADD COLUMN scroll_pct REAL NOT NULL DEFAULT -1",
            [],
        )?;
    }
    let books_has_source: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='source_type'",
        [],
        |r| r.get(0),
    )?;
    if books_has_source == 0 {
        conn.execute(
            "ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'",
            [],
        )?;
    }
    let books_has_meta: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='meta_json'",
        [],
        |r| r.get(0),
    )?;
    if books_has_meta == 0 {
        conn.execute(
            "ALTER TABLE books ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'",
            [],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct BookRow {
    pub id: String,
    pub path: String,
    pub title: String,
    pub page_count: u32,
    pub current_page: u32,
    pub updated_at: String,
    pub scroll_pct: f64,
    pub source_type: String,
    pub meta_json: String,
}

fn row_to_book(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookRow> {
    Ok(BookRow {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        page_count: row.get::<_, i64>(3).map(|v| v.max(0) as u32)?,
        current_page: row.get::<_, i64>(4).map(|v| v.max(0) as u32)?,
        updated_at: row.get(5)?,
        scroll_pct: row.get::<_, f64>(6).unwrap_or(-1.0),
        source_type: row.get(7)?,
        meta_json: row.get(8)?,
    })
}

/// 入库/刷新：重导入（同路径）把软删的书恢复（removed=0），进度字段不动（续读）。
pub fn upsert_book(
    conn: &Connection,
    id: &str,
    path: &str,
    title: &str,
    page_count: u32,
) -> Result<(), BackendError> {
    let now = now_str();
    conn.execute(
        "INSERT INTO books(id, path, title, page_count, updated_at, source_type, meta_json)
         VALUES (?1, ?2, ?3, ?4, ?5, 'local', '{}')
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, title=excluded.title,
            page_count=excluded.page_count, updated_at=excluded.updated_at,
            removed=0, source_type='local', meta_json='{}'",
        params![id, path, title, page_count as i64, now],
    )?;
    Ok(())
}

/// 在线书入库/恢复：保留进度与条漫偏移；页数缩小时钳制 current_page。
pub fn upsert_online_book(
    conn: &Connection,
    id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    source_type: &str,
    meta_json: &str,
) -> Result<(), BackendError> {
    let now = now_str();
    conn.execute(
        "INSERT INTO books(id, path, title, page_count, updated_at, source_type, meta_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, title=excluded.title,
            page_count=excluded.page_count, updated_at=excluded.updated_at,
            removed=0, source_type=excluded.source_type, meta_json=excluded.meta_json,
            current_page=MIN(books.current_page, excluded.page_count - 1)",
        params![id, path, title, page_count as i64, now, source_type, meta_json],
    )?;
    Ok(())
}

/// 无损重定位：把一本书从旧 id/path 迁到新 id/path（单事务）。
///
/// - 保留 `scroll_pct` / `updated_at` / `source_type` / `meta_json`，清 `removed`；
/// - `current_page` 按新页数钳制（`MIN(current_page, page_count-1)`）；
/// - 阅读历史随书迁移：同日冲突取 `MAX(existing, migrated)`，绝不丢既有记录；
/// - 过滤事件尽力迁移（唯一索引冲突忽略），不阻断主流程。
pub fn relocate_book(
    conn: &Connection,
    old_id: &str,
    new_id: &str,
    path: &str,
    title: &str,
    page_count: u32,
) -> Result<BookRow, BackendError> {
    let tx = conn.unchecked_transaction()?;
    // id 变更会短暂让 reading_log 旧子行指向不存在的父行；延迟到事务提交
    // 前校验，等下面把子行合并/迁移到新 id 后再统一验证。
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    let updated = tx.execute(
        "UPDATE books SET id=?2, path=?3, title=?4, page_count=?5,
            current_page=MIN(current_page, MAX(?5 - 1, 0)), removed=0
         WHERE id=?1",
        params![old_id, new_id, path, title, page_count as i64],
    )?;
    if updated == 0 {
        return Err(BackendError::Msg("书籍不存在".into()));
    }
    if old_id != new_id {
        // 先合并进新 id（同日取 MAX），再删旧行；顺序不能反，否则丢历史。
        tx.execute(
            "INSERT INTO reading_log(date, book_id, pages)
             SELECT date, ?2, pages FROM reading_log WHERE book_id=?1
             ON CONFLICT DO UPDATE
                SET pages=MAX(reading_log.pages, excluded.pages)",
            params![old_id, new_id],
        )?;
        tx.execute("DELETE FROM reading_log WHERE book_id=?1", params![old_id])?;
        // 唯一索引 (book_id, url, action) 冲突时跳过该条，绝不阻断重定位。
        let _ = tx.execute(
            "UPDATE OR IGNORE online_filter_events SET book_id=?2 WHERE book_id=?1",
            params![old_id, new_id],
        );
    }
    tx.commit()?;
    get_book(conn, new_id)?.ok_or_else(|| BackendError::Msg("重定位后回读失败".into()))
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<BookRow>, BackendError> {
    let mut stmt = conn.prepare(
        "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json FROM books WHERE id=?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        Ok(Some(row_to_book(r)?))
    } else {
        Ok(None)
    }
}

/// 压缩包源文件的增量扫描指纹（修改时间秒 + 字节数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceStamp {
    pub mtime: i64,
    pub size: i64,
}

pub fn source_stamp(conn: &Connection, book_id: &str) -> Result<Option<SourceStamp>, BackendError> {
    let mut stmt = conn.prepare("SELECT mtime, size FROM source_stats WHERE book_id=?1")?;
    let mut rows = stmt.query(params![book_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SourceStamp {
            mtime: row.get(0)?,
            size: row.get(1)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn set_source_stamp(
    conn: &Connection,
    book_id: &str,
    stamp: SourceStamp,
) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO source_stats(book_id, mtime, size) VALUES (?1, ?2, ?3)
         ON CONFLICT(book_id) DO UPDATE SET
            mtime=excluded.mtime, size=excluded.size",
        params![book_id, stamp.mtime, stamp.size],
    )?;
    Ok(())
}

pub fn clear_source_stamp(conn: &Connection, book_id: &str) -> Result<(), BackendError> {
    conn.execute("DELETE FROM source_stats WHERE book_id=?1", params![book_id])?;
    Ok(())
}

/// 该书是否处于软删（移除）状态；不存在返回 false。
pub fn book_is_removed(conn: &Connection, id: &str) -> Result<bool, BackendError> {
    let removed: Option<i64> = conn
        .query_row("SELECT removed FROM books WHERE id=?1", params![id], |r| r.get(0))
        .ok();
    Ok(removed.unwrap_or(0) != 0)
}

/// 书库列表（不含已移除的软删书）。
pub fn list_books(conn: &Connection, query: Option<&str>) -> Result<Vec<BookRow>, BackendError> {
    let (sql, param): (&str, Option<String>) = match query {
        Some(q) if !q.trim().is_empty() => (
            "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json FROM books
             WHERE removed=0 AND (title LIKE ?1 OR path LIKE ?1) ORDER BY updated_at DESC",
            Some(format!("%{}%", q.trim())),
        ),
        _ => (
            "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json FROM books
             WHERE removed=0 ORDER BY updated_at DESC",
            None,
        ),
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = match param {
        Some(p) => stmt.query_map(params![p], row_to_book)?,
        None => stmt.query_map([], row_to_book)?,
    };
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 设置进度并把"前进页数"计入当日 `reading_log`（只增不减，避免回翻刷榜）。
/// `pct`：条漫模式的滚动偏移百分比（0.0..1.0）；分页模式传 None（清为 -1）。
pub fn set_progress(conn: &Connection, id: &str, page: u32, pct: Option<f64>) -> Result<(), BackendError> {
    let tx = conn.unchecked_transaction()?;
    let prev: u32 = tx
        .query_row(
            "SELECT current_page FROM books WHERE id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u32)
        .unwrap_or(0);
    let now = now_str();
    let pct_val = pct.unwrap_or(-1.0).clamp(-1.0, 1.0);
    tx.execute(
        "UPDATE books SET current_page=?1, scroll_pct=?2, updated_at=?3 WHERE id=?4",
        params![page as i64, pct_val, now, id],
    )?;
    if page > prev {
        let delta = (page - prev) as i64;
        let today = today_str();
        // reading_log 的唯一约束是表达式索引 (date, COALESCE(book_id,''))，
        // 不能用 (date, book_id) 作为 conflict target；无目标 UPSERT 对所有
        // 唯一冲突生效。页面只增不减，直接累加。
        tx.execute(
            "INSERT INTO reading_log(date, book_id, pages) VALUES (?1, ?2, ?3)
             ON CONFLICT DO UPDATE SET pages = reading_log.pages + excluded.pages",
            params![today, id, delta],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 窗口起点（含当天）：days=1 → 只看今天；days=7 → 近 7 天。
fn cutoff_date(days: i64) -> String {
    let d = days.max(1) - 1;
    (Local::now() - chrono::Duration::days(d))
        .format("%Y-%m-%d")
        .to_string()
}

/// 全局逐日阅读页数（聚合所有书 + 旧的全局历史），日期升序。
pub fn heatmap(conn: &Connection, days: i64) -> Result<Vec<(String, u32)>, BackendError> {
    let cutoff = cutoff_date(days);
    let mut stmt = conn.prepare(
        "SELECT date, SUM(pages) FROM reading_log
         WHERE date >= ?1 GROUP BY date ORDER BY date DESC",
    )?;
    let rows = stmt.query_map(params![cutoff], |r| {
        let date: String = r.get(0)?;
        let pages: i64 = r.get(1)?;
        Ok((date, pages.max(0) as u32))
    })?;
    let mut out: Vec<(String, u32)> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    out.reverse();
    Ok(out)
}

/// 逐日阅读页数：`book_id=None` 全局（含旧史），`Some(id)` 只看该书。日期升序。
pub fn reading_log_days(
    conn: &Connection,
    book_id: Option<&str>,
    days: i64,
) -> Result<Vec<(String, u32)>, BackendError> {
    let cutoff = cutoff_date(days);
    let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<(String, u32)> {
        let date: String = r.get(0)?;
        let pages: i64 = r.get(1)?;
        Ok((date, pages.max(0) as u32))
    };
    let mut out = match book_id {
        Some(b) => {
            let mut stmt = conn.prepare(
                "SELECT date, SUM(pages) FROM reading_log
                 WHERE book_id=?1 AND date>=?2 GROUP BY date ORDER BY date DESC",
            )?;
            let rows = stmt
                .query_map(params![b, cutoff], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT date, SUM(pages) FROM reading_log
                 WHERE date>=?1 GROUP BY date ORDER BY date DESC",
            )?;
            let rows = stmt
                .query_map(params![cutoff], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
    };
    out.reverse();
    Ok(out)
}

/// 逐日逐书阅读页数（堆叠趋势用）；排除迁移来的 NULL 全局旧史。日期升序。
pub fn reading_by_book(
    conn: &Connection,
    days: i64,
) -> Result<Vec<(String, String, u32)>, BackendError> {
    let cutoff = cutoff_date(days);
    let mut stmt = conn.prepare(
        "SELECT date, book_id, SUM(pages) FROM reading_log
         WHERE date>=?1 AND book_id IS NOT NULL AND book_id<>''
         GROUP BY date, book_id ORDER BY date",
    )?;
    let rows = stmt.query_map(params![cutoff], |r| {
        let date: String = r.get(0)?;
        let book_id: String = r.get(1)?;
        let pages: i64 = r.get(2)?;
        Ok((date, book_id, pages.max(0) as u32))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn today_pages(conn: &Connection) -> Result<u32, BackendError> {
    let today = today_str();
    let v: i64 = conn.query_row(
        "SELECT COALESCE(SUM(pages), 0) FROM reading_log WHERE date=?1",
        params![today],
        |r| r.get(0),
    )?;
    Ok(v.max(0) as u32)
}

pub fn get_setting(conn: &Connection, k: &str) -> Result<Option<String>, BackendError> {
    let v: Option<String> = conn
        .query_row("SELECT v FROM settings WHERE k=?1", params![k], |r| r.get(0))
        .ok();
    Ok(v)
}

pub fn set_setting(conn: &Connection, k: &str, v: &str) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO settings(k, v) VALUES (?1, ?2)
         ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        params![k, v],
    )?;
    Ok(())
}

/// Internal app metadata (not user settings): schema/compatibility markers.
pub fn get_meta(conn: &Connection, k: &str) -> Result<Option<String>, BackendError> {
    let value: Option<String> = conn
        .query_row("SELECT v FROM app_meta WHERE k=?1", params![k], |r| r.get(0))
        .ok();
    Ok(value)
}

pub fn set_meta(conn: &Connection, k: &str, v: &str) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO app_meta(k, v) VALUES (?1, ?2)
         ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        params![k, v],
    )?;
    Ok(())
}

// ---------- 书籍移除/删除（移除 ≠ 删除，两个独立动作） ----------

/// 移除（软删）：只从书库隐藏，源文件与阅读进度全部保留；重导入/重扫描自动恢复。
pub fn soft_remove_books(conn: &Connection, ids: &[String]) -> Result<usize, BackendError> {
    let tx = conn.unchecked_transaction()?;
    let mut n = 0;
    for id in ids {
        n += tx.execute("UPDATE books SET removed=1 WHERE id=?1", params![id])?;
    }
    tx.commit()?;
    Ok(n)
}

/// 删除（硬删）：级联清理该书全部记录（进度/页 OCR/批量任务/翻译缓存）。
/// 只清数据库；源文件与内存缓存由调用方处理。
pub fn hard_delete_books(conn: &Connection, ids: &[String]) -> Result<usize, BackendError> {
    let tx = conn.unchecked_transaction()?;
    let mut n = 0;
    for id in ids {
        // 外键 ON DELETE CASCADE 会清理 reading_log；显式 DELETE 兼容旧库。
        tx.execute("DELETE FROM reading_log WHERE book_id=?1", params![id])?;
        tx.execute("DELETE FROM books WHERE id=?1", params![id])?;
        n += 1;
    }
    tx.commit()?;
    Ok(n)
}

// ---------- 在线图片提纯：站点档案 / 用户规则 / 事件 ----------

use crate::online::filter::{
    FilterAction, FilterRule, FilterStats, RulePattern, RuleSource, SiteProfile,
};

fn rule_action_str(action: FilterAction) -> &'static str {
    match action {
        FilterAction::Block => "block",
        FilterAction::Allow => "allow",
    }
}

fn rule_source_str(source: RuleSource) -> &'static str {
    match source {
        RuleSource::User => "user",
        RuleSource::Learned => "learned",
        RuleSource::Imported => "imported",
    }
}

fn parse_action(value: &str) -> FilterAction {
    match value {
        "allow" => FilterAction::Allow,
        _ => FilterAction::Block,
    }
}

fn parse_source(value: &str) -> RuleSource {
    match value {
        "user" => RuleSource::User,
        "imported" => RuleSource::Imported,
        _ => RuleSource::Learned,
    }
}

/// 写入/更新站点档案（按 host 唯一）。
pub fn upsert_filter_profile(conn: &Connection, profile: &SiteProfile) -> Result<(), BackendError> {
    let host = profile.host.trim();
    if host.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO online_filter_profiles(
            host, main_selector, cdn_pattern, width_min, width_max, aspect_max, uses, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(host) DO UPDATE SET
            main_selector=excluded.main_selector,
            cdn_pattern=excluded.cdn_pattern,
            width_min=excluded.width_min,
            width_max=excluded.width_max,
            aspect_max=excluded.aspect_max,
            uses=excluded.uses,
            updated_at=excluded.updated_at",
        params![
            host,
            profile.main_selector,
            profile.cdn_pattern,
            profile.width_min.map(|v| v as i64),
            profile.width_max.map(|v| v as i64),
            profile.aspect_max.map(|v| v as f64),
            profile.uses as i64,
            if profile.updated_at.is_empty() {
                now_str()
            } else {
                profile.updated_at.clone()
            },
        ],
    )?;
    Ok(())
}

pub fn get_filter_profile(
    conn: &Connection,
    host: &str,
) -> Result<Option<SiteProfile>, BackendError> {
    let mut stmt = conn.prepare(
        "SELECT host, main_selector, cdn_pattern, width_min, width_max, aspect_max, uses, updated_at
         FROM online_filter_profiles WHERE host=?1",
    )?;
    let mut rows = stmt.query(params![host])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(SiteProfile {
        host: row.get(0)?,
        main_selector: row.get(1)?,
        cdn_pattern: row.get(2)?,
        width_min: row.get::<_, Option<i64>>(3)?.map(|v| v.max(0) as u32),
        width_max: row.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u32),
        aspect_max: row.get::<_, Option<f64>>(5)?.map(|v| v as f32),
        uses: row.get::<_, i64>(6)?.max(0) as u64,
        updated_at: row.get(7)?,
    }))
}

pub fn list_filter_profiles(conn: &Connection) -> Result<Vec<SiteProfile>, BackendError> {
    let mut stmt = conn.prepare(
        "SELECT host, main_selector, cdn_pattern, width_min, width_max, aspect_max, uses, updated_at
         FROM online_filter_profiles ORDER BY updated_at DESC, host",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SiteProfile {
            host: row.get(0)?,
            main_selector: row.get(1)?,
            cdn_pattern: row.get(2)?,
            width_min: row.get::<_, Option<i64>>(3)?.map(|v| v.max(0) as u32),
            width_max: row.get::<_, Option<i64>>(4)?.map(|v| v.max(0) as u32),
            aspect_max: row.get::<_, Option<f64>>(5)?.map(|v| v as f32),
            uses: row.get::<_, i64>(6)?.max(0) as u64,
            updated_at: row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_filter_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<FilterRule>> {
    let pattern_json: String = row.get(4)?;
    let Ok(pattern) = serde_json::from_str::<RulePattern>(&pattern_json) else {
        return Ok(None);
    };
    Ok(Some(FilterRule {
        id: row.get(0)?,
        host: row.get(1)?,
        action: parse_action(&row.get::<_, String>(2)?),
        source: parse_source(&row.get::<_, String>(3)?),
        pattern,
        reason: row.get(5)?,
        created_at: row.get(6)?,
        hits: row.get::<_, i64>(7)?.max(0) as u64,
    }))
}

pub fn list_filter_rules(conn: &Connection) -> Result<Vec<FilterRule>, BackendError> {
    let mut stmt = conn.prepare(
        "SELECT id, host, action, source, pattern_json, reason, created_at, hits
         FROM online_filter_rules ORDER BY created_at DESC, id",
    )?;
    let rows = stmt.query_map([], row_to_filter_rule)?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(rule) = row? {
            out.push(rule);
        }
    }
    Ok(out)
}

pub fn rules_for_host(conn: &Connection, host: &str) -> Result<Vec<FilterRule>, BackendError> {
    let mut stmt = conn.prepare(
        "SELECT id, host, action, source, pattern_json, reason, created_at, hits
         FROM online_filter_rules WHERE host=?1 ORDER BY created_at DESC, id",
    )?;
    let rows = stmt.query_map(params![host], row_to_filter_rule)?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(rule) = row? {
            out.push(rule);
        }
    }
    Ok(out)
}

pub fn upsert_filter_rule(conn: &Connection, rule: &FilterRule) -> Result<(), BackendError> {
    let pattern = serde_json::to_string(&rule.pattern)
        .map_err(|e| BackendError::Db(format!("过滤规则序列化失败：{e}")))?;
    conn.execute(
        "INSERT INTO online_filter_rules(
            id, host, action, source, pattern_json, reason, created_at, hits
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            host=excluded.host, action=excluded.action, source=excluded.source,
            pattern_json=excluded.pattern_json, reason=excluded.reason,
            created_at=excluded.created_at, hits=excluded.hits",
        params![
            rule.id,
            rule.host,
            rule_action_str(rule.action),
            rule_source_str(rule.source),
            pattern,
            rule.reason,
            if rule.created_at.is_empty() {
                now_str()
            } else {
                rule.created_at.clone()
            },
            rule.hits as i64,
        ],
    )?;
    Ok(())
}

pub fn delete_filter_rule(conn: &Connection, id: &str) -> Result<(), BackendError> {
    conn.execute("DELETE FROM online_filter_rules WHERE id=?1", params![id])?;
    Ok(())
}

pub fn delete_filter_rules(conn: &Connection, ids: &[String]) -> Result<(), BackendError> {
    if ids.is_empty() {
        return Ok(());
    }
    for id in ids {
        delete_filter_rule(conn, id)?;
    }
    Ok(())
}

/// 重置本地自学习：规则、站点档案与事件全部清空（不影响书库/阅读进度）。
pub fn clear_filter_learning(conn: &Connection) -> Result<(), BackendError> {
    conn.execute_batch(
        "DELETE FROM online_filter_rules;
         DELETE FROM online_filter_profiles;
         DELETE FROM online_filter_events;",
    )?;
    Ok(())
}

/// 记录一次过滤/恢复事件；URL 必须是已脱敏的 host+path。
#[allow(clippy::too_many_arguments)]
pub fn record_filter_event(
    conn: &Connection,
    host: &str,
    book_id: &str,
    url: &str,
    action: &str,
    reason: &str,
    width: Option<u32>,
    height: Option<u32>,
    sha256: Option<&str>,
) -> Result<(), BackendError> {
    conn.execute(
        "INSERT OR IGNORE INTO online_filter_events(
            host, book_id, url, action, reason, width, height, sha256, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            host,
            book_id,
            url,
            action,
            reason,
            width.map(|v| v as i64),
            height.map(|v| v as i64),
            sha256,
            now_str(),
        ],
    )?;
    conn.execute(
        "DELETE FROM online_filter_events WHERE id <= (
            SELECT MAX(id) FROM online_filter_events
         ) - 10000",
        [],
    )?;
    Ok(())
}

pub fn filter_stats(conn: &Connection) -> Result<FilterStats, BackendError> {
    let profiles: i64 =
        conn.query_row("SELECT COUNT(*) FROM online_filter_profiles", [], |r| r.get(0))?;
    let rules: i64 =
        conn.query_row("SELECT COUNT(*) FROM online_filter_rules", [], |r| r.get(0))?;
    let blocked: i64 = conn.query_row(
        "SELECT COUNT(*) FROM online_filter_events WHERE action='blocked'",
        [],
        |r| r.get(0),
    )?;
    let restored: i64 = conn.query_row(
        "SELECT COUNT(*) FROM online_filter_events WHERE action='restored'",
        [],
        |r| r.get(0),
    )?;
    let last_updated: Option<String> = conn
        .query_row(
            "SELECT MAX(t) FROM (
                SELECT MAX(updated_at) AS t FROM online_filter_profiles
                UNION ALL SELECT MAX(created_at) FROM online_filter_rules
                UNION ALL SELECT MAX(created_at) FROM online_filter_events
             )",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(FilterStats {
        site_profiles: profiles.max(0) as u32,
        rules: rules.max(0) as u32,
        blocked_total: blocked.max(0) as u64,
        restored_total: restored.max(0) as u64,
        last_updated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    /// 唯一临时库路径（进程号 + 纳秒），测试结束连同 -wal/-shm 一起删除。
    fn unique_temp_db(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("系统时钟早于 UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!("mr-db-{tag}-{}-{nanos}.db", std::process::id()))
    }

    fn cleanup_db_files(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut raw = path.as_os_str().to_owned();
            raw.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(raw));
        }
    }

    #[test]
    fn configure_sets_wal_busy_timeout_and_foreign_keys() {
        let path = unique_temp_db("config");
        {
            let conn = open(&path).expect("打开临时库");
            init_schema(&conn).expect("建表");
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode.to_ascii_lowercase(), "wal", "生产库必须落盘为 WAL");
            let busy: i64 = conn
                .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .unwrap();
            assert_eq!(busy, BUSY_TIMEOUT.as_millis() as i64);
            let fk: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap();
            assert_eq!(fk, 1);
        }
        cleanup_db_files(&path);
    }

    #[test]
    fn quick_check_accepts_a_valid_database() {
        let conn = mem();
        assert!(quick_check(&conn).is_ok());
    }

    #[test]
    fn busy_timeout_lets_second_writer_wait_instead_of_failing() {
        let path = unique_temp_db("busy");
        {
            let setup = open(&path).expect("打开临时库");
            setup
                .execute_batch("CREATE TABLE busy_probe(id INTEGER PRIMARY KEY, v TEXT);")
                .unwrap();
        }
        let writer = open(&path).expect("打开持锁连接");
        writer
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO busy_probe(v) VALUES('first');")
            .unwrap();

        let waiter_path = path.clone();
        let waiter = std::thread::spawn(move || {
            let conn = open(&waiter_path).expect("打开等待连接");
            let started = std::time::Instant::now();
            conn.execute("INSERT INTO busy_probe(v) VALUES('second')", [])
                .expect("busy_timeout 内应等待成功，而不是 database is locked");
            started.elapsed()
        });

        // 持锁 200ms，逼迫第二个连接进入 busy_timeout 等待。
        std::thread::sleep(Duration::from_millis(200));
        writer.execute_batch("COMMIT;").unwrap();
        let waited = waiter.join().expect("等待线程不应 panic");
        assert!(
            waited >= Duration::from_millis(100),
            "第二个写入应真实等待持锁事务，而非立即失败：{waited:?}"
        );
        let count: i64 = writer
            .query_row("SELECT COUNT(*) FROM busy_probe", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "两个连接的写入都必须落盘");
        drop(writer);
        cleanup_db_files(&path);
    }

    #[test]
    fn soft_remove_then_reimport_restores_progress() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "第一卷", 30).unwrap();
        set_progress(&conn, "b1", 12, None).unwrap();

        // 移除：列表不再显示，进度记录仍在。
        assert_eq!(soft_remove_books(&conn, &["b1".into()]).unwrap(), 1);
        assert!(list_books(&conn, None).unwrap().is_empty());
        assert_eq!(get_book(&conn, "b1").unwrap().unwrap().current_page, 12);

        // 重导入（同路径）：恢复且续读进度原样保留。
        upsert_book(&conn, "b1", "p/b1", "第一卷", 30).unwrap();
        let b = get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(b.current_page, 12);
        assert_eq!(list_books(&conn, None).unwrap().len(), 1);
    }

    #[test]
    fn hard_delete_cascades_all_records() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "第一卷", 30).unwrap();
        set_progress(&conn, "b1", 5, None).unwrap();
        // 别的书不受影响。
        upsert_book(&conn, "b2", "p/b2", "第二卷", 10).unwrap();

        let n = hard_delete_books(&conn, &["b1".into()]).unwrap();
        assert_eq!(n, 1);
        assert!(get_book(&conn, "b1").unwrap().is_none());
        assert!(list_books(&conn, None).unwrap().iter().all(|b| b.id == "b2"));
        // 阅读进度记录级联清理。
        assert_eq!(reading_log_days(&conn, Some("b1"), 7).unwrap().len(), 0);
    }

    #[test]
    fn reading_log_migration_preserves_history() {
        // 模拟旧版库:老形状 reading_log + 历史,init_schema 应迁移且数据保全。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE reading_log(date TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0);
             INSERT INTO reading_log(date, pages) VALUES ('2026-10-01', 12), ('2026-10-02', 30);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        // 全局视图聚合旧史。
        let days = reading_log_days(&conn, None, 30).unwrap();
        assert_eq!(
            days,
            vec![("2026-10-01".into(), 12), ("2026-10-02".into(), 30)]
        );
        // 旧史无按书归属,按书视图为空。
        assert!(reading_log_days(&conn, Some("b1"), 30).unwrap().is_empty());
        // 堆叠趋势排除全局旧史。
        assert!(reading_by_book(&conn, 30).unwrap().is_empty());
    }

    #[test]
    fn reading_log_migration_recovers_legacy_after_crash() {
        // 模拟上次崩在 rename 之后：只剩 reading_log_legacy，没有新表。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE reading_log_legacy(
                 date TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO reading_log_legacy(date, pages) VALUES ('2026-10-03', 7);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(
            reading_log_days(&conn, None, 30).unwrap(),
            vec![("2026-10-03".into(), 7)]
        );
        assert!(!table_exists(&conn, "reading_log_legacy").unwrap());
    }

    #[test]
    fn reading_log_foreign_key_migration_backfills_and_drops_orphans() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "第一卷", 10).unwrap();
        // 回退成 0.17.0 之前的 reading_log 形态，模拟待迁移旧库。
        conn.execute_batch(
            "DROP INDEX idx_reading_log_book_date;
             ALTER TABLE reading_log RENAME TO reading_log_before_fk;
             CREATE TABLE reading_log(
                 date TEXT NOT NULL,
                 book_id TEXT NOT NULL DEFAULT '',
                 pages INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(date, book_id)
             );
             INSERT INTO reading_log(date, book_id, pages) VALUES
                 ('2026-10-01', '', 12),
                 ('2026-10-02', 'b1', 5),
                 ('2026-10-03', 'ghost', 3);
             DROP TABLE reading_log_before_fk;",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        // 全局旧史迁为 NULL；孤儿 ghost 被丢弃；真实书保留。
        let global: Option<String> = conn
            .query_row(
                "SELECT book_id FROM reading_log WHERE date='2026-10-01'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(global.is_none(), "book_id='' 必须迁移为 NULL");
        let orphan: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reading_log WHERE book_id='ghost'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0, "不存在的 book_id 必须按孤儿清理");
        assert_eq!(
            reading_log_days(&conn, Some("b1"), 30).unwrap(),
            vec![("2026-10-02".into(), 5)]
        );

        // 可空外键真实生效：未知 book_id 写入被拒绝。
        assert!(conn
            .execute(
                "INSERT INTO reading_log(date, book_id, pages) VALUES ('2026-10-04', 'ghost', 1)",
                [],
            )
            .is_err());
        // 表达式唯一索引覆盖全局 NULL 行（SQLite 普通唯一索引不会约束 NULL）。
        assert!(conn
            .execute(
                "INSERT INTO reading_log(date, book_id, pages) VALUES ('2026-10-01', NULL, 1)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO reading_log(date, book_id, pages) VALUES ('2026-10-02', 'b1', 1)",
                [],
            )
            .is_err());
    }

    #[test]
    fn set_progress_rolls_back_when_reading_log_write_fails() {
        let conn = mem();
        // 不存在的书：books 更新命中 0 行，reading_log 插入被外键拒绝；
        // 整个事务必须回滚，不能留下孤儿阅读记录。
        assert!(set_progress(&conn, "missing", 5, None).is_err());
        assert_eq!(today_pages(&conn).unwrap(), 0);
        assert!(reading_log_days(&conn, Some("missing"), 7)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reading_log_per_book_accounting() {
        let conn = mem();
        for id in ["b1", "b2"] {
            conn.execute(
                "INSERT INTO books(id, path, title) VALUES (?1, ?2, ?3)",
                params![id, format!("p/{id}"), id],
            )
            .unwrap();
        }
        set_progress(&conn, "b1", 5, None).unwrap();
        set_progress(&conn, "b1", 9, None).unwrap(); // b1 再 +4
        set_progress(&conn, "b2", 3, None).unwrap();
        set_progress(&conn, "b1", 2, None).unwrap(); // 回翻不计
        assert_eq!(today_pages(&conn).unwrap(), 12);
        assert_eq!(
            reading_log_days(&conn, Some("b1"), 1).unwrap(),
            vec![(today_str(), 9)]
        );
        assert_eq!(heatmap(&conn, 7).unwrap(), vec![(today_str(), 12)]);
        let by_book = reading_by_book(&conn, 7).unwrap();
        assert_eq!(by_book.len(), 2, "逐日逐书:两条(b1/b2),无全局行");
    }

    #[test]
    fn online_columns_migrate_and_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(
                id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 0, current_page INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO books(id,path,title,page_count,current_page) VALUES('b1','p/b1','旧书',10,2);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        let old = get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(old.source_type, "local");
        assert_eq!(old.meta_json, "{}");

        let meta = r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg"}]}"#;
        upsert_online_book(&conn, "o1", "http://x/list.json", "在线", 3, "generic_manga", meta)
            .unwrap();
        let row = get_book(&conn, "o1").unwrap().unwrap();
        assert_eq!(row.source_type, "generic_manga");
        assert_eq!(row.meta_json, meta);
        assert_eq!(row.page_count, 3);
    }

    #[test]
    fn online_upsert_restores_and_clamps_progress() {
        let conn = mem();
        upsert_online_book(&conn, "o1", "http://x/a", "A", 5, "generic_manga", "{}").unwrap();
        set_progress(&conn, "o1", 4, None).unwrap();
        soft_remove_books(&conn, &["o1".into()]).unwrap();
        upsert_online_book(&conn, "o1", "http://x/a", "A2", 2, "generic_manga", "{}").unwrap();
        let row = get_book(&conn, "o1").unwrap().unwrap();
        assert_eq!(row.title, "A2");
        assert_eq!(row.page_count, 2);
        assert_eq!(row.current_page, 1);
        assert_eq!(row.source_type, "generic_manga");
        assert!(list_books(&conn, None).unwrap().iter().any(|b| b.id == "o1"));
    }


    #[test]
    fn filter_profiles_rules_and_events_roundtrip() {
        let conn = mem();
        let profile = SiteProfile {
            host: "example.com".into(),
            main_selector: Some(".reader".into()),
            cdn_pattern: Some("https://example.com/ch#/#.jpg".into()),
            width_min: Some(700),
            width_max: Some(1000),
            aspect_max: Some(2.8),
            uses: 2,
            updated_at: "2026-10-23 10:00:00".into(),
        };
        upsert_filter_profile(&conn, &profile).unwrap();
        let loaded = get_filter_profile(&conn, "example.com").unwrap().unwrap();
        assert_eq!(loaded, profile);
        assert_eq!(list_filter_profiles(&conn).unwrap().len(), 1);

        let rule = FilterRule {
            id: "r1".into(),
            host: "example.com".into(),
            action: FilterAction::Block,
            source: RuleSource::User,
            pattern: RulePattern::UrlTemplate {
                template: "https://example.com/extras/#.png".into(),
            },
            reason: "user".into(),
            created_at: "2026-10-23 10:00:00".into(),
            hits: 0,
        };
        upsert_filter_rule(&conn, &rule).unwrap();
        assert_eq!(rules_for_host(&conn, "example.com").unwrap(), vec![rule]);

        record_filter_event(
            &conn,
            "example.com",
            "book",
            "https://example.com/extras/1.png",
            "blocked",
            "user",
            Some(800),
            Some(1200),
            None,
        )
        .unwrap();
        // 唯一索引：同一本书/URL/动作只计一次。
        record_filter_event(
            &conn,
            "example.com",
            "book",
            "https://example.com/extras/1.png",
            "blocked",
            "user",
            Some(800),
            Some(1200),
            None,
        )
        .unwrap();
        record_filter_event(
            &conn,
            "example.com",
            "book",
            "https://example.com/extras/1.png",
            "restored",
            "user",
            Some(800),
            Some(1200),
            None,
        )
        .unwrap();
        let stats = filter_stats(&conn).unwrap();
        assert_eq!(stats.site_profiles, 1);
        assert_eq!(stats.rules, 1);
        assert_eq!(stats.blocked_total, 1);
        assert_eq!(stats.restored_total, 1);
        assert!(stats.last_updated.is_some());

        clear_filter_learning(&conn).unwrap();
        let stats = filter_stats(&conn).unwrap();
        assert_eq!(stats.site_profiles, 0);
        assert_eq!(stats.rules, 0);
        assert_eq!(stats.blocked_total, 0);
    }

    // ---------- 无损重定位 ----------

    #[test]
    fn relocate_book_moves_id_and_keeps_progress_and_history() {
        let conn = mem();
        upsert_book(&conn, "old", "p/old", "第一卷", 30).unwrap();
        set_progress(&conn, "old", 15, Some(0.5)).unwrap();
        let history = reading_log_days(&conn, Some("old"), 7).unwrap();
        assert_eq!(history, vec![(today_str(), 15)]);

        let row = relocate_book(&conn, "old", "new", "q/新书.cbz", "新书", 30).unwrap();
        assert_eq!(row.id, "new");
        assert_eq!(row.path, "q/新书.cbz");
        assert_eq!(row.title, "新书");
        assert_eq!(row.current_page, 15, "重定位不得丢阅读进度");
        assert_eq!(row.scroll_pct, 0.5, "条漫滚动偏移同样保留");
        assert_eq!(row.source_type, "local");
        assert!(get_book(&conn, "old").unwrap().is_none(), "旧 id 必须消失");
        assert_eq!(
            reading_log_days(&conn, Some("new"), 7).unwrap(),
            history,
            "阅读历史必须随书迁移"
        );
        assert!(
            reading_log_days(&conn, Some("old"), 7).unwrap().is_empty(),
            "旧 id 的历史不得残留"
        );
    }

    #[test]
    fn relocate_book_merges_history_and_clamps_progress() {
        let conn = mem();
        upsert_book(&conn, "old", "p/old", "旧", 30).unwrap();
        set_progress(&conn, "old", 15, None).unwrap();
        // 目标 id 同日已有 3 页（测试仅在 FK 关闭时造这条“未来书”记录）：
        // 迁移会先更新 books id，再合并 reading_log，随后 FK 重新成立。
        conn.execute("PRAGMA foreign_keys=OFF", []).unwrap();
        conn.execute(
            "INSERT INTO reading_log(date, book_id, pages) VALUES (?1, 'new', 3)",
            params![today_str()],
        )
        .unwrap();
        conn.execute("PRAGMA foreign_keys=ON", []).unwrap();

        let row = relocate_book(&conn, "old", "new", "p/new", "新", 5).unwrap();
        assert_eq!(row.page_count, 5);
        assert_eq!(row.current_page, 4, "页数缩小时 current_page 必须被钳制");
        assert_eq!(
            reading_log_days(&conn, Some("new"), 7).unwrap(),
            vec![(today_str(), 15)],
            "同日冲突应合并为 MAX(existing, migrated)"
        );
        assert!(reading_log_days(&conn, Some("old"), 7).unwrap().is_empty());
    }

    #[test]
    fn relocate_book_rejects_unknown_id() {
        let conn = mem();
        assert!(relocate_book(&conn, "missing", "x", "p/x", "X", 3).is_err());
        // 失败事务不得留下半迁移的新行。
        assert!(get_book(&conn, "x").unwrap().is_none());
    }
}

