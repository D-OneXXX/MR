//! SQLite 书库（全新设计）：
//! - `books(id, path, title, page_count, current_page, updated_at)`
//! - `reading_log(date, pages)`：按日累计阅读页数（热力图/今日统计用）
//! - `settings(k, v)`：持久化前端设置（主题/缓存预算/目录/翻译服务）
//! - `trans_log(id, kind, ok, elapsed_ms, created_at)`：OCR/翻译调用日志（滚动保留 5000 条）
//!
//! `id` 为路径的 SHA-256 hex（稳定、可跨扫描复用，保留进度）。

use chrono::Local;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::source::BackendError;
use crate::{TransLogEntry, TransStats};

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
        CREATE TABLE IF NOT EXISTS reading_log(
            date TEXT NOT NULL,
            book_id TEXT NOT NULL DEFAULT '',
            pages INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(date, book_id)
        );
        CREATE TABLE IF NOT EXISTS settings(
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS app_meta(
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS trans_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            ok INTEGER NOT NULL DEFAULT 1,
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS trans_cache(
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL DEFAULT '',
            book_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS glossary(
            series_id TEXT NOT NULL,
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            PRIMARY KEY(series_id, src)
        );
        CREATE TABLE IF NOT EXISTS page_ocr(
            book_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            boxes TEXT NOT NULL DEFAULT '[]',
            texts TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(book_id, page)
        );
        CREATE TABLE IF NOT EXISTS batch_jobs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            book_title TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT 'queued',
            total_pages INTEGER NOT NULL DEFAULT 0,
            done_pages INTEGER NOT NULL DEFAULT 0,
            ok_pages INTEGER NOT NULL DEFAULT 0,
            fail_pages INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
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
    Ok(())
}

/// 旧库列迁移：
/// - reading_log(date PK) → (date, book_id)，旧数据并入 book_id=''（全局视图仍聚合）；
/// - books 加 removed 软删列、trans_cache 加 book_id 归属列（级联清理用）。
fn migrate_reading_log(conn: &Connection) -> Result<(), BackendError> {
    let has_book_id: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('reading_log') WHERE name='book_id'",
        [],
        |r| r.get(0),
    )?;
    if has_book_id > 0 {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE reading_log RENAME TO reading_log_legacy;
         CREATE TABLE reading_log(
             date TEXT NOT NULL,
             book_id TEXT NOT NULL DEFAULT '',
             pages INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY(date, book_id)
         );
         INSERT INTO reading_log(date, book_id, pages)
             SELECT date, '', pages FROM reading_log_legacy;
         DROP TABLE reading_log_legacy;",
    )?;
    Ok(())
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
    let cache_has_book: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('trans_cache') WHERE name='book_id'",
        [],
        |r| r.get(0),
    )?;
    if cache_has_book == 0 {
        conn.execute(
            "ALTER TABLE trans_cache ADD COLUMN book_id TEXT NOT NULL DEFAULT ''",
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

/// 清单变化时清掉该书的派生缓存（页 OCR 与翻译缓存）。
pub fn clear_book_derived(conn: &Connection, id: &str) -> Result<(), BackendError> {
    conn.execute("DELETE FROM page_ocr WHERE book_id=?1", params![id])?;
    conn.execute("DELETE FROM trans_cache WHERE book_id=?1", params![id])?;
    Ok(())
}

/// 是否存在 queued/running/paused 批量任务。
pub fn has_active_batch(conn: &Connection, book_id: &str) -> Result<bool, BackendError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM batch_jobs WHERE book_id=?1 AND state IN ('queued','running','paused')",
        params![book_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
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
    let prev: u32 = conn
        .query_row(
            "SELECT current_page FROM books WHERE id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v.max(0) as u32)
        .unwrap_or(0);
    let now = now_str();
    let pct_val = pct.unwrap_or(-1.0).clamp(-1.0, 1.0);
    conn.execute(
        "UPDATE books SET current_page=?1, scroll_pct=?2, updated_at=?3 WHERE id=?4",
        params![page as i64, pct_val, now, id],
    )?;
    if page > prev {
        let delta = (page - prev) as i64;
        let today = today_str();
        conn.execute(
            "INSERT INTO reading_log(date, book_id, pages) VALUES (?1, ?2, ?3)
             ON CONFLICT(date, book_id) DO UPDATE SET pages = pages + ?3",
            params![today, id, delta],
        )?;
    }
    Ok(())
}

/// 窗口起点（含当天）：days=1 → 只看今天；days=7 → 近 7 天。
fn cutoff_date(days: i64) -> String {
    let d = (days.max(1) - 1) as i64;
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

/// 逐日逐书阅读页数（堆叠趋势用）；排除迁移来的 book_id='' 全局旧史。日期升序。
pub fn reading_by_book(
    conn: &Connection,
    days: i64,
) -> Result<Vec<(String, String, u32)>, BackendError> {
    let cutoff = cutoff_date(days);
    let mut stmt = conn.prepare(
        "SELECT date, book_id, SUM(pages) FROM reading_log
         WHERE date>=?1 AND book_id<>'' GROUP BY date, book_id ORDER BY date",
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

/// 记一条 OCR/翻译调用日志(kind: "ocr" | "trans");只保留最近 5000 条。
pub fn log_trans(conn: &Connection, kind: &str, ok: bool, elapsed_ms: u64) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO trans_log(kind, ok, elapsed_ms, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![kind, ok as i64, elapsed_ms as i64, now_str()],
    )?;
    conn.execute(
        "DELETE FROM trans_log WHERE id <= (SELECT MAX(id) FROM trans_log) - 5000",
        [],
    )?;
    Ok(())
}

/// 聚合 OCR/翻译调用统计 + 最近 50 条(id 倒序)。
pub fn trans_stats(conn: &Connection) -> Result<TransStats, BackendError> {
    let agg = |kind: &str| -> Result<(u64, u64, f64), BackendError> {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(ok = 0), 0), COALESCE(AVG(elapsed_ms), 0.0)
             FROM trans_log WHERE kind = ?1",
            params![kind],
            |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(From::from)
    };
    let (ocr_calls, ocr_fail, ocr_avg_ms) = agg("ocr")?;
    let (trans_calls, trans_fail, trans_avg_ms) = agg("trans")?;
    let mut stmt = conn.prepare(
        "SELECT kind, ok, elapsed_ms, created_at FROM trans_log ORDER BY id DESC LIMIT 50",
    )?;
    let recent = stmt
        .query_map([], |r| {
            Ok(TransLogEntry {
                kind: r.get(0)?,
                ok: r.get::<_, i64>(1)? != 0,
                elapsed_ms: r.get::<_, i64>(2)? as u64,
                created_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(TransStats {
        ocr_calls,
        ocr_fail,
        ocr_avg_ms,
        trans_calls,
        trans_fail,
        trans_avg_ms,
        recent,
    })
}

/// 翻译缓存:键为 sha256(book_id|page|区域图哈希|目标语言)(工作台阶段接入)。
/// book_id 冗余入列，供删除源文件时级联清理。
pub fn cache_get(conn: &Connection, id: &str) -> Result<Option<String>, BackendError> {
    let v: Option<String> = conn
        .query_row("SELECT text FROM trans_cache WHERE id=?1", params![id], |r| r.get(0))
        .ok();
    Ok(v)
}

pub fn cache_put(
    conn: &Connection,
    id: &str,
    text: &str,
    book_id: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO trans_cache(id, text, book_id, created_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET text=excluded.text, book_id=excluded.book_id",
        params![id, text, book_id, now_str()],
    )?;
    Ok(())
}

// ---------- 书籍移除/删除（移除 ≠ 删除，两个独立动作） ----------

/// 移除（软删）：只从书库隐藏，源文件与阅读进度全部保留；重导入/重扫描自动恢复。
pub fn soft_remove_books(conn: &Connection, ids: &[String]) -> Result<usize, BackendError> {
    let mut n = 0;
    for id in ids {
        n += conn.execute("UPDATE books SET removed=1 WHERE id=?1", params![id])?;
    }
    Ok(n)
}

/// 删除（硬删）：级联清理该书全部记录（进度/页 OCR/批量任务/翻译缓存）。
/// 只清数据库；源文件与内存缓存由调用方处理。
pub fn hard_delete_books(conn: &Connection, ids: &[String]) -> Result<usize, BackendError> {
    let mut n = 0;
    for id in ids {
        conn.execute("DELETE FROM books WHERE id=?1", params![id])?;
        conn.execute("DELETE FROM reading_log WHERE book_id=?1", params![id])?;
        conn.execute("DELETE FROM page_ocr WHERE book_id=?1", params![id])?;
        conn.execute("DELETE FROM batch_jobs WHERE book_id=?1", params![id])?;
        conn.execute("DELETE FROM trans_cache WHERE book_id=?1", params![id])?;
        n += 1;
    }
    Ok(n)
}

/// 术语表:按系列维护人名/招式名,翻译时注入 prompt。
pub fn glossary_list(
    conn: &Connection,
    series_id: &str,
) -> Result<Vec<(String, String)>, BackendError> {
    let mut stmt =
        conn.prepare("SELECT src, dst FROM glossary WHERE series_id=?1 ORDER BY src")?;
    let rows = stmt
        .query_map(params![series_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn glossary_upsert(
    conn: &Connection,
    series_id: &str,
    src: &str,
    dst: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO glossary(series_id, src, dst) VALUES(?1, ?2, ?3)
         ON CONFLICT(series_id, src) DO UPDATE SET dst=excluded.dst",
        params![series_id, src, dst],
    )?;
    Ok(())
}

pub fn glossary_remove(
    conn: &Connection,
    series_id: &str,
    src: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "DELETE FROM glossary WHERE series_id=?1 AND src=?2",
        params![series_id, src],
    )?;
    Ok(())
}

// ---------- 页 OCR 存档(批量/工作台共用:翻过的页秒出) ----------

#[derive(Debug, Clone)]
pub struct PageOcrRow {
    pub width: u32,
    pub height: u32,
    pub boxes: String,
    pub texts: String,
}

/// 存/覆盖一页的检测框与 OCR 文本(JSON)。
pub fn save_page_ocr(
    conn: &Connection,
    book_id: &str,
    page: u32,
    width: u32,
    height: u32,
    boxes_json: &str,
    texts_json: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "INSERT INTO page_ocr(book_id, page, width, height, boxes, texts, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(book_id, page) DO UPDATE SET
           width=excluded.width, height=excluded.height,
           boxes=excluded.boxes, texts=excluded.texts, updated_at=excluded.updated_at",
        params![book_id, page, width, height, boxes_json, texts_json, now_str()],
    )?;
    Ok(())
}

pub fn get_page_ocr(
    conn: &Connection,
    book_id: &str,
    page: u32,
) -> Result<Option<PageOcrRow>, BackendError> {
    let row = conn
        .query_row(
            "SELECT width, height, boxes, texts FROM page_ocr WHERE book_id=?1 AND page=?2",
            params![book_id, page],
            |r| {
                Ok(PageOcrRow {
                    width: r.get::<_, i64>(0)? as u32,
                    height: r.get::<_, i64>(1)? as u32,
                    boxes: r.get(2)?,
                    texts: r.get(3)?,
                })
            },
        )
        .ok();
    Ok(row)
}

// ---------- 批量预翻译队列 ----------

#[derive(Debug, Clone)]
pub struct BatchJobRow {
    pub id: i64,
    pub book_id: String,
    pub book_title: String,
    pub state: String,
    pub total_pages: u32,
    pub done_pages: u32,
    pub ok_pages: u32,
    pub fail_pages: u32,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

const BATCH_ACTIVE: &str = "('queued','running','paused')";

/// 入队:该书已有 queued/running/paused 任务则直接返回它(幂等)。
pub fn batch_create(
    conn: &Connection,
    book_id: &str,
    book_title: &str,
    total_pages: u32,
) -> Result<i64, BackendError> {
    if let Some(row) = conn
        .query_row(
            &format!(
                "SELECT id FROM batch_jobs WHERE book_id=?1 AND state IN {BATCH_ACTIVE} ORDER BY id DESC LIMIT 1"
            ),
            params![book_id],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    {
        return Ok(row);
    }
    conn.execute(
        "INSERT INTO batch_jobs(book_id, book_title, state, total_pages, created_at, updated_at)
         VALUES(?1, ?2, 'queued', ?3, ?4, ?4)",
        params![book_id, book_title, total_pages, now_str()],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<BatchJobRow> {
    Ok(BatchJobRow {
        id: r.get(0)?,
        book_id: r.get(1)?,
        book_title: r.get(2)?,
        state: r.get(3)?,
        total_pages: r.get::<_, i64>(4)? as u32,
        done_pages: r.get::<_, i64>(5)? as u32,
        ok_pages: r.get::<_, i64>(6)? as u32,
        fail_pages: r.get::<_, i64>(7)? as u32,
        last_error: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

const BATCH_COLS: &str =
    "id, book_id, book_title, state, total_pages, done_pages, ok_pages, fail_pages, last_error, created_at, updated_at";

pub fn batch_get(conn: &Connection, id: i64) -> Result<Option<BatchJobRow>, BackendError> {
    let row = conn
        .query_row(
            &format!("SELECT {BATCH_COLS} FROM batch_jobs WHERE id=?1"),
            params![id],
            row_to_job,
        )
        .ok();
    Ok(row)
}

pub fn batch_list(conn: &Connection, limit: i64) -> Result<Vec<BatchJobRow>, BackendError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BATCH_COLS} FROM batch_jobs ORDER BY id DESC LIMIT ?1"
    ))?;
    let rows = stmt
        .query_map(params![limit], row_to_job)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// worker 取下一个排队任务(id 升序 FIFO)。
pub fn batch_next_queued(conn: &Connection) -> Result<Option<BatchJobRow>, BackendError> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {BATCH_COLS} FROM batch_jobs WHERE state='queued' ORDER BY id ASC LIMIT 1"
            ),
            [],
            row_to_job,
        )
        .ok();
    Ok(row)
}

/// 状态迁移(queued/running/paused/done/done_errors/failed/cancelled),刷新 updated_at。
pub fn batch_set_state(
    conn: &Connection,
    id: i64,
    state: &str,
    last_error: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "UPDATE batch_jobs SET state=?2, last_error=?3, updated_at=?4 WHERE id=?1",
        params![id, state, last_error, now_str()],
    )?;
    Ok(())
}

/// 进度计数更新(worker 每处理一页调用)。
pub fn batch_progress(
    conn: &Connection,
    id: i64,
    done_pages: u32,
    ok_pages: u32,
    fail_pages: u32,
    last_error: &str,
) -> Result<(), BackendError> {
    conn.execute(
        "UPDATE batch_jobs SET done_pages=?2, ok_pages=?3, fail_pages=?4, last_error=?5, updated_at=?6 WHERE id=?1",
        params![id, done_pages, ok_pages, fail_pages, last_error, now_str()],
    )?;
    Ok(())
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

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn trans_log_roundtrip_and_stats() {
        let conn = mem();
        log_trans(&conn, "ocr", true, 120).unwrap();
        log_trans(&conn, "ocr", false, 80).unwrap();
        log_trans(&conn, "trans", true, 900).unwrap();

        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 2);
        assert_eq!(s.ocr_fail, 1);
        assert_eq!(s.ocr_avg_ms, 100.0);
        assert_eq!(s.trans_calls, 1);
        assert_eq!(s.trans_fail, 0);
        assert_eq!(s.trans_avg_ms, 900.0);

        // recent 按 id 倒序,最近一条在前。
        assert_eq!(s.recent.len(), 3);
        assert_eq!(s.recent[0].kind, "trans");
        assert!(s.recent[0].ok);
        assert_eq!(s.recent[0].elapsed_ms, 900);
        assert!(!s.recent[1].ok);
        assert_eq!(s.recent[2].kind, "ocr");
        assert!(!s.recent[2].created_at.is_empty());
    }

    #[test]
    fn trans_stats_empty_and_limit() {
        let conn = mem();
        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 0);
        assert_eq!(s.ocr_avg_ms, 0.0);
        assert!(s.recent.is_empty());

        for i in 0..60 {
            log_trans(&conn, "ocr", true, i as u64).unwrap();
        }
        let s = trans_stats(&conn).unwrap();
        assert_eq!(s.ocr_calls, 60);
        assert_eq!(s.recent.len(), 50, "recent 只保留最近 50 条");
        assert_eq!(s.recent[0].elapsed_ms, 59);
    }

    #[test]
    fn trans_cache_roundtrip() {
        let conn = mem();
        assert_eq!(cache_get(&conn, "k1").unwrap(), None);
        cache_put(&conn, "k1", "你好", "b1").unwrap();
        cache_put(&conn, "k1", "覆盖后", "b1").unwrap();
        assert_eq!(cache_get(&conn, "k1").unwrap().as_deref(), Some("覆盖后"));
        cache_put(&conn, "k2", "别的书", "b2").unwrap();
        assert_eq!(cache_get(&conn, "k2").unwrap().as_deref(), Some("别的书"));
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
        cache_put(&conn, "k1", "译文", "b1").unwrap();
        save_page_ocr(&conn, "b1", 0, 100, 100, "[]", "[]").unwrap();
        batch_create(&conn, "b1", "第一卷", 30).unwrap();
        // 别的书不受影响。
        upsert_book(&conn, "b2", "p/b2", "第二卷", 10).unwrap();
        cache_put(&conn, "k2", "b2 译文", "b2").unwrap();

        let n = hard_delete_books(&conn, &["b1".into()]).unwrap();
        assert_eq!(n, 1);
        assert!(get_book(&conn, "b1").unwrap().is_none());
        assert!(list_books(&conn, None).unwrap().iter().all(|b| b.id == "b2"));
        // 进度/缓存/页 OCR/批量任务全部级联清理。
        assert_eq!(reading_log_days(&conn, Some("b1"), 7).unwrap().len(), 0);
        assert_eq!(cache_get(&conn, "k1").unwrap(), None);
        assert!(get_page_ocr(&conn, "b1", 0).unwrap().is_none());
        assert!(batch_list(&conn, 10).unwrap().iter().all(|j| j.book_id == "b2"));
        // b2 的记录原样。
        assert_eq!(cache_get(&conn, "k2").unwrap().as_deref(), Some("b2 译文"));
    }

    #[test]
    fn glossary_upsert_list_remove() {
        let conn = mem();
        glossary_upsert(&conn, "series-a", "ナルト", "鸣人").unwrap();
        glossary_upsert(&conn, "series-a", "サスケ", "佐助").unwrap();
        glossary_upsert(&conn, "series-a", "ナルト", "漩涡鸣人").unwrap(); // 覆盖
        glossary_upsert(&conn, "series-b", "ルフィ", "路飞").unwrap();

        let a = glossary_list(&conn, "series-a").unwrap();
        assert_eq!(a, vec![("サスケ".into(), "佐助".into()), ("ナルト".into(), "漩涡鸣人".into())]);
        assert_eq!(glossary_list(&conn, "series-b").unwrap().len(), 1);
        assert!(glossary_list(&conn, "nope").unwrap().is_empty());

        glossary_remove(&conn, "series-a", "サスケ").unwrap();
        assert_eq!(glossary_list(&conn, "series-a").unwrap().len(), 1);
    }

    #[test]
    fn page_ocr_roundtrip() {
        let conn = mem();
        assert!(get_page_ocr(&conn, "b1", 0).unwrap().is_none());
        save_page_ocr(&conn, "b1", 0, 1600, 2400, r#"[{"x":1}]"#, r#"["あ"]"#).unwrap();
        save_page_ocr(&conn, "b1", 0, 1600, 2400, r#"[{"x":2}]"#, r#"["い"]"#).unwrap(); // 覆盖
        let row = get_page_ocr(&conn, "b1", 0).unwrap().unwrap();
        assert_eq!((row.width, row.height), (1600, 2400));
        assert_eq!(row.boxes, r#"[{"x":2}]"#);
        assert_eq!(row.texts, r#"["い"]"#);
        assert!(get_page_ocr(&conn, "b1", 1).unwrap().is_none());
    }

    #[test]
    fn batch_job_lifecycle() {
        let conn = mem();
        let id = batch_create(&conn, "b1", "第一卷", 10).unwrap();
        // 同书幂等:active 任务存在时不再新建。
        assert_eq!(batch_create(&conn, "b1", "第一卷", 10).unwrap(), id);

        batch_set_state(&conn, id, "running", "").unwrap();
        batch_progress(&conn, id, 3, 2, 1, "第3页失败").unwrap();
        let j = batch_get(&conn, id).unwrap().unwrap();
        assert_eq!(j.state, "running");
        assert_eq!((j.done_pages, j.ok_pages, j.fail_pages), (3, 2, 1));
        assert_eq!(j.last_error, "第3页失败");

        // FIFO:先入队先跑;paused 不参与取队。
        let id2 = batch_create(&conn, "b2", "第二卷", 5).unwrap();
        batch_set_state(&conn, id, "paused", "").unwrap();
        let next = batch_next_queued(&conn).unwrap().unwrap();
        assert_eq!(next.id, id2);
        batch_set_state(&conn, id, "queued", "").unwrap();
        assert_eq!(batch_next_queued(&conn).unwrap().unwrap().id, id);

        // 终态后可重新入队(新任务)。
        batch_set_state(&conn, id, "done", "").unwrap();
        assert_ne!(batch_create(&conn, "b1", "第一卷", 10).unwrap(), id);
        assert_eq!(batch_list(&conn, 10).unwrap().len(), 3);
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
    fn clear_derived_and_active_batch() {
        let conn = mem();
        upsert_online_book(&conn, "o1", "http://x/a", "A", 2, "generic_manga", "{}").unwrap();
        save_page_ocr(&conn, "o1", 0, 10, 10, "[]", "[]").unwrap();
        cache_put(&conn, "k", "t", "o1").unwrap();
        assert!(has_active_batch(&conn, "o1").unwrap() == false);
        clear_book_derived(&conn, "o1").unwrap();
        assert!(get_page_ocr(&conn, "o1", 0).unwrap().is_none());
        assert!(cache_get(&conn, "k").unwrap().is_none());

        let id = batch_create(&conn, "o1", "A", 2).unwrap();
        batch_set_state(&conn, id, "running", "").unwrap();
        assert!(has_active_batch(&conn, "o1").unwrap());
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
}

