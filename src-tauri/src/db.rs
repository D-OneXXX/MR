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

/// 路径身份键：Windows 统一分隔符、去掉尾部分隔符并忽略大小写；
/// Unix 只去掉多余尾部 `/`（反斜杠是合法文件名字符）。
pub fn normalize_path_identity(path: &str) -> String {
    let mut value = path.trim().to_string();
    #[cfg(windows)]
    {
        value = value.replace('/', "\\");
        while value.len() > 3 && value.ends_with('\\') {
            value.pop();
        }
        value = value.to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    {
        while value.len() > 1 && value.ends_with('/') {
            value.pop();
        }
    }
    value
}

/// 按路径找已入库的 id：先走精确 sha256，再按平台身份键兜底。
/// 只为本地书使用；在线 URL 仍走规范化 URL 的精确 id。
pub fn find_book_id_by_path(conn: &Connection, path: &str) -> Result<Option<String>, BackendError> {
    let exact = book_id_for_path(path);
    if get_book(conn, &exact)?.is_some() {
        return Ok(Some(exact));
    }
    let identity = normalize_path_identity(path);
    let mut stmt = conn.prepare("SELECT id, path FROM books")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, stored) = row?;
        if normalize_path_identity(&stored) == identity {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// 书库 schema 版本（`PRAGMA user_version`）。
///
/// 1 = 0.17.0 起：reading_log 可空外键 + 表达式唯一索引 + source_stats。
/// 2 = PDF-1：books.format 记录书籍来源格式（image / pdf），增量 ALTER，老库默认 image。
/// 只增不减；前向库（更高版本）保持原值，绝不降级。
pub const SCHEMA_VERSION: i32 = 2;

/// 书籍来源格式：图片（目录 / `.zip` / `.cbz` / 在线书）。
pub const BOOK_FORMAT_IMAGE: &str = "image";
/// 书籍来源格式：PDF 文件（PDF-1：仅导入与格式识别，尚无渲染器）。
pub const BOOK_FORMAT_PDF: &str = "pdf";

pub fn schema_version(conn: &Connection) -> Result<i32, BackendError> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
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
            meta_json TEXT NOT NULL DEFAULT '{}',
            format TEXT NOT NULL DEFAULT 'image'
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
    if schema_version(conn)? < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

/// 退出前把 WAL 合并回主库并截断，避免 `library.db-wal` 长期膨胀。
/// `busy=1` 表示仍有读者；退出路径忽略错误，下次启动会继续 checkpoint。
pub fn wal_checkpoint(conn: &Connection) -> Result<(), BackendError> {
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err(BackendError::Msg("WAL checkpoint busy".into()));
    }
    Ok(())
}

/// 旧库列迁移：
/// - reading_log(date PK) → (date, book_id)，旧数据并入 book_id=''（全局视图仍聚合）；
/// - books 加 removed / scroll_pct / source_type / meta_json / format 列。
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
        conn.execute(
            "ALTER TABLE books ADD COLUMN removed INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
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
    // PDF-1：记录书籍来源格式（image / pdf）。老库一律按 image 处理。
    let books_has_format: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='format'",
        [],
        |r| r.get(0),
    )?;
    if books_has_format == 0 {
        conn.execute(
            "ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'image'",
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
    /// 来源格式：`image`（目录/压缩包/在线）或 `pdf`（PDF-1）。
    pub format: String,
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
        // 老库迁移后 format 必有值；仍容忍 NULL/缺失，避免历史脏行读崩。
        format: row
            .get::<_, Option<String>>(9)?
            .unwrap_or_else(|| BOOK_FORMAT_IMAGE.to_string()),
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
    upsert_book_with_format(conn, id, path, title, page_count, BOOK_FORMAT_IMAGE)
}

/// 入库/刷新（带来源格式）：PDF-1 引入。
///
/// - `format` 在插入与冲突更新时都会落库（`format=excluded.format`），
///   重导入同一路径不会把 PDF 静默降级回 `image`；
/// - 进度字段（`current_page` / `scroll_pct`）不参与更新，续读不受影响。
pub fn upsert_book_with_format(
    conn: &Connection,
    id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    format: &str,
) -> Result<(), BackendError> {
    let now = now_str();
    conn.execute(
        "INSERT INTO books(id, path, title, page_count, updated_at, source_type, meta_json, format)
         VALUES (?1, ?2, ?3, ?4, ?5, 'local', '{}', ?6)
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, title=excluded.title,
            page_count=excluded.page_count, updated_at=excluded.updated_at,
            removed=0, source_type='local', meta_json='{}',
            format=excluded.format",
        params![id, path, title, page_count as i64, now, format],
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
        params![
            id,
            path,
            title,
            page_count as i64,
            now,
            source_type,
            meta_json
        ],
    )?;
    Ok(())
}

/// 无损重定位：把一本书从旧 id/path 迁到新 id/path（单事务）。
///
/// - 保留 `scroll_pct` / `updated_at` / `source_type` / `meta_json` / `format`，清 `removed`；
/// - `current_page` 按新页数钳制（`MIN(current_page, page_count-1)`）；
///   **页数未知（`page_count == 0`，PDF 重定位恒如此）时保持原值不动**，
///   否则一次「文件搬家」就会把阅读进度清零；
/// - 阅读历史随书迁移：同日冲突取 `SUM(existing, migrated)`，两段阅读都保留；
/// - 过滤事件尽力迁移（唯一索引冲突忽略），不阻断主流程。
pub fn relocate_book(
    conn: &Connection,
    old_id: &str,
    new_id: &str,
    path: &str,
    title: &str,
    page_count: u32,
) -> Result<BookRow, BackendError> {
    relocate_book_inner(conn, old_id, new_id, path, title, page_count, None)
}

/// 无损重定位（可改写来源格式）：PDF-1 引入。
///
/// 与 [`relocate_book`] 的唯一差别：事务内的 UPDATE 会写入新的 `format`
/// （例如重定位到 `.pdf` 时写 `pdf`）。进度与阅读历史的保留语义完全一致。
pub fn relocate_book_with_format(
    conn: &Connection,
    old_id: &str,
    new_id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    format: &str,
) -> Result<BookRow, BackendError> {
    relocate_book_inner(conn, old_id, new_id, path, title, page_count, Some(format))
}

fn relocate_book_inner(
    conn: &Connection,
    old_id: &str,
    new_id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    format: Option<&str>,
) -> Result<BookRow, BackendError> {
    let tx = conn.unchecked_transaction()?;
    // id 变更会短暂让 reading_log 旧子行指向不存在的父行；延迟到事务提交
    // 前校验，等下面把子行合并/迁移到新 id 后再统一验证。
    tx.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    // format=None 时**不碰** format 列：沿用原书的来源格式，绝不静默重置。
    //
    // 页数语义（两个分支一致）：
    // - `?5 > 0`（页数已知）：写入新页数，并把 current_page 钳到 `?5 - 1`；
    // - `?5 = 0`（页数未知，PDF 重定位恒如此）：**原样保留** page_count 与
    //   current_page。旧实现无条件写 `MIN(current_page, MAX(?5-1,0))`，
    //   在页数未知时等于把阅读进度清零——一次「文件搬家」就会毁掉 PDF 的
    //   阅读位置（AGENTS.md §5「失效路径无损重定位」）。
    let updated = match format {
        Some(format) => tx.execute(
            "UPDATE books SET id=?2, path=?3, title=?4,
                page_count=CASE WHEN ?5 > 0 THEN ?5 ELSE page_count END,
                current_page=CASE WHEN ?5 > 0 THEN MIN(current_page, ?5 - 1) ELSE current_page END,
                removed=0, format=?6
             WHERE id=?1",
            params![old_id, new_id, path, title, page_count as i64, format],
        )?,
        None => tx.execute(
            "UPDATE books SET id=?2, path=?3, title=?4,
                page_count=CASE WHEN ?5 > 0 THEN ?5 ELSE page_count END,
                current_page=CASE WHEN ?5 > 0 THEN MIN(current_page, ?5 - 1) ELSE current_page END,
                removed=0
             WHERE id=?1",
            params![old_id, new_id, path, title, page_count as i64],
        )?,
    };
    if updated == 0 {
        return Err(BackendError::Msg("书籍不存在".into()));
    }
    if old_id != new_id {
        // 先合并进新 id（同日求和），再删旧行；顺序不能反，否则丢历史。
        // 两个 id 代表同一本实体书的两次登记，页数应相加而不是取最大值。
        tx.execute(
            "INSERT INTO reading_log(date, book_id, pages)
             SELECT date, ?2, pages FROM reading_log WHERE book_id=?1
             ON CONFLICT DO UPDATE
                SET pages=reading_log.pages + excluded.pages",
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
        "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json, format FROM books WHERE id=?1",
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
    conn.execute(
        "DELETE FROM source_stats WHERE book_id=?1",
        params![book_id],
    )?;
    Ok(())
}

/// 该书是否处于软删（移除）状态；不存在返回 false。
pub fn book_is_removed(conn: &Connection, id: &str) -> Result<bool, BackendError> {
    let removed: Option<i64> = conn
        .query_row("SELECT removed FROM books WHERE id=?1", params![id], |r| {
            r.get(0)
        })
        .ok();
    Ok(removed.unwrap_or(0) != 0)
}

/// 书库列表（不含已移除的软删书）。
pub fn list_books(conn: &Connection, query: Option<&str>) -> Result<Vec<BookRow>, BackendError> {
    let (sql, param): (&str, Option<String>) = match query {
        Some(q) if !q.trim().is_empty() => (
            "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json, format FROM books
             WHERE removed=0 AND (title LIKE ?1 OR path LIKE ?1) ORDER BY updated_at DESC",
            Some(format!("%{}%", q.trim())),
        ),
        _ => (
            "SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json, format FROM books
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
///
/// **no-op 短路（W2）**：被持久化的进度字段只有 `current_page` 与 `scroll_pct`。
/// 两者都没变时直接返回——不执行 UPDATE、不刷新 `updated_at`、不写 `reading_log`。
/// 桌面阅读器在分页模式下会每 500 ms 提交一次**相同**进度（W1 实测 2.00 Hz），
/// 这些空转写既刷新 `updated_at`（影响"最近阅读"排序与恢复位置仲裁），
/// 又会让后续基于版本号的乐观并发抖动。
/// 行不存在时不短路，保留既有错误语义（`page=0` 静默命中 0 行、`page>0` 外键失败）。
pub fn set_progress(
    conn: &Connection,
    id: &str,
    page: u32,
    pct: Option<f64>,
) -> Result<(), BackendError> {
    let tx = conn.unchecked_transaction()?;
    let pct_val = pct.unwrap_or(-1.0).clamp(-1.0, 1.0);
    // 一次性读出两个被持久化的进度字段；行不存在时为 None。
    let prev: Option<(i64, f64)> = tx
        .query_row(
            "SELECT current_page, scroll_pct FROM books WHERE id=?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)),
        )
        .ok();
    if let Some((prev_page, prev_pct)) = prev {
        // 位级比较：写入值与读回值同为 IEEE754 double，往返精确；
        // 位比较也避免"极小差值"被误判成"没变"。
        if prev_page.max(0) as u32 == page && prev_pct.to_bits() == pct_val.to_bits() {
            tx.commit()?;
            return Ok(());
        }
    }
    let prev_page = prev.map(|(p, _)| p.max(0) as u32).unwrap_or(0);
    let now = now_str();
    tx.execute(
        "UPDATE books SET current_page=?1, scroll_pct=?2, updated_at=?3 WHERE id=?4",
        params![page as i64, pct_val, now, id],
    )?;
    if page > prev_page {
        let delta = (page - prev_page) as i64;
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

/// 只更新 `books.page_count`（PDF-2）：其余列一个都不动。
///
/// 用途：前端 PDF.js 解析出真实页数后回写（PDF 导入时页数留 0）。
/// 刻意**不**触碰 `id` / `path` / `format` / `current_page` / `scroll_pct` /
/// `updated_at`：页数变化不得影响阅读进度，也不得把书从书库里「改头换面」。
pub fn set_book_page_count(
    conn: &Connection,
    id: &str,
    page_count: u32,
) -> Result<(), BackendError> {
    let updated = conn.execute(
        "UPDATE books SET page_count=?2 WHERE id=?1",
        params![id, page_count as i64],
    )?;
    if updated == 0 {
        return Err(BackendError::Msg("书籍不存在".into()));
    }
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
        .query_row("SELECT v FROM settings WHERE k=?1", params![k], |r| {
            r.get(0)
        })
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
        .query_row("SELECT v FROM app_meta WHERE k=?1", params![k], |r| {
            r.get(0)
        })
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
    let profiles: i64 = conn.query_row("SELECT COUNT(*) FROM online_filter_profiles", [], |r| {
        r.get(0)
    })?;
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
    fn path_identity_dedupes_platform_variants() {
        let conn = mem();
        upsert_book(&conn, "id", "C:/Books/A.cbz", "A", 1).unwrap();
        // 精确路径永远命中。
        assert_eq!(
            find_book_id_by_path(&conn, "C:/Books/A.cbz").unwrap(),
            Some("id".to_string())
        );
        #[cfg(windows)]
        {
            assert_eq!(
                find_book_id_by_path(&conn, r"c:\books\a.cbz").unwrap(),
                Some("id".to_string()),
                "Windows 分隔符/大小写变体必须复用同一本书"
            );
            assert_eq!(
                find_book_id_by_path(&conn, r"C:\BOOKS\A.cbz\").unwrap(),
                Some("id".to_string())
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(
                find_book_id_by_path(&conn, r"C:\Books\A.cbz").unwrap(),
                None,
                "Unix 反斜杠是合法文件名字符，不能归一化"
            );
        }
        #[cfg(unix)]
        {
            assert_eq!(
                find_book_id_by_path(&conn, "C:/Books/A.cbz/").unwrap(),
                Some("id".to_string()),
                "Unix 尾部分隔符应忽略"
            );
        }
    }

    #[test]
    fn schema_version_is_recorded_and_wal_checkpoint_truncates() {
        let path = unique_temp_db("schema-version");
        {
            let conn = open(&path).expect("打开临时库");
            init_schema(&conn).expect("建表");
            assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
            upsert_book(&conn, "b1", "p/b1", "第一卷", 10).unwrap();
            set_progress(&conn, "b1", 3, None).unwrap();
            wal_checkpoint(&conn).expect("checkpoint");
            let wal = path.with_extension("db-wal");
            let len = std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0);
            assert_eq!(len, 0, "TRUNCATE 后 WAL 必须为空或已删除");
            // 幂等：重复 init 不降级，也不重复迁移。
            init_schema(&conn).expect("重复建表");
            assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        }
        let conn = open(&path).expect("重开临时库");
        assert_eq!(get_book(&conn, "b1").unwrap().unwrap().current_page, 3);
        drop(conn);
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
        assert!(list_books(&conn, None)
            .unwrap()
            .iter()
            .all(|b| b.id == "b2"));
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

        let meta =
            r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg"}]}"#;
        upsert_online_book(
            &conn,
            "o1",
            "http://x/list.json",
            "在线",
            3,
            "generic_manga",
            meta,
        )
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
        assert!(list_books(&conn, None)
            .unwrap()
            .iter()
            .any(|b| b.id == "o1"));
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
            vec![(today_str(), 18)],
            "同日冲突应合并为 SUM(existing, migrated)"
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

    /// 页数未知（`page_count == 0`）时重定位**不得**清零页数与阅读进度。
    ///
    /// PDF 重定位恒传 `page_count = 0`（后端不解析 PDF 页数），
    /// 旧实现无条件写 `MIN(current_page, MAX(0-1,0))` = 0，
    /// 等于一次「文件搬家」就毁掉 PDF 的阅读位置（AGENTS.md §5）。
    #[test]
    fn relocate_book_keeps_progress_when_page_count_is_unknown() {
        let conn = mem();
        // Some(format) 分支：PDF 重定位。
        upsert_book_with_format(&conn, "old", "p/old.pdf", "旧 PDF", 42, BOOK_FORMAT_PDF).unwrap();
        set_progress(&conn, "old", 37, None).unwrap();

        let row = relocate_book_with_format(
            &conn,
            "old",
            "new",
            "q/新书.pdf",
            "新书",
            0,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        assert_eq!(row.page_count, 42, "页数未知时不得把 page_count 清零");
        assert_eq!(row.current_page, 37, "页数未知时不得把阅读进度清零");
        assert_eq!(row.format, BOOK_FORMAT_PDF);

        // None 分支：普通书重定位（页数同样未知）也必须保留进度。
        upsert_book(&conn, "b1", "p/b1", "普通书", 30).unwrap();
        set_progress(&conn, "b1", 12, None).unwrap();
        let row = relocate_book(&conn, "b1", "b2", "q/新书.cbz", "新书", 0).unwrap();
        assert_eq!(row.page_count, 30, "页数未知时不得把 page_count 清零");
        assert_eq!(row.current_page, 12, "页数未知时不得把阅读进度清零");
    }

    /// 页数已知时钳制语义保持不变（图片书 37 → 9）。
    #[test]
    fn relocate_book_still_clamps_progress_when_page_count_is_known() {
        let conn = mem();
        upsert_book(&conn, "old", "p/old", "旧书", 42).unwrap();
        set_progress(&conn, "old", 37, None).unwrap();

        let row = relocate_book(&conn, "old", "new", "q/新书.cbz", "新书", 10).unwrap();
        assert_eq!(row.page_count, 10, "页数已知时必须写入新页数");
        assert_eq!(row.current_page, 9, "页数缩小时 current_page 必须被钳制");

        // PDF 分支同样保持钳制语义。
        upsert_book_with_format(&conn, "p1", "p/p1.pdf", "旧 PDF", 42, BOOK_FORMAT_PDF).unwrap();
        set_progress(&conn, "p1", 37, None).unwrap();
        let row =
            relocate_book_with_format(&conn, "p1", "p2", "q/新书.pdf", "新书", 10, BOOK_FORMAT_PDF)
                .unwrap();
        assert_eq!(row.page_count, 10);
        assert_eq!(row.current_page, 9, "页数已知时仍必须钳制到最后一页");
    }

    /* ---------------- 跨版本数据兼容（升级 / 回滚安全性） ---------------- */

    /// 造一个「旧版本留下的」书库文件：books 缺列、reading_log 是 (date) 主键形态、
    /// 没有在线相关表、user_version = 1。
    fn legacy_library_file(path: &Path) {
        let conn = Connection::open(path).expect("创建旧库");
        conn.execute_batch(
            "CREATE TABLE books(
                 id TEXT PRIMARY KEY,
                 path TEXT NOT NULL UNIQUE,
                 title TEXT NOT NULL,
                 page_count INTEGER NOT NULL DEFAULT 0,
                 current_page INTEGER NOT NULL DEFAULT 0,
                 updated_at TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE reading_log(
                 date TEXT PRIMARY KEY,
                 pages INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');
             CREATE TABLE app_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');
             INSERT INTO books(id, path, title, page_count, current_page, updated_at)
                 VALUES('legacy-1', 'C:/Books/Legacy.cbz', '旧书', 12, 5, '2026-01-01');
             INSERT INTO reading_log(date, pages) VALUES('2026-01-01', 7);
             INSERT INTO settings(k, v) VALUES('theme', 'dark');
             PRAGMA user_version = 1;",
        )
        .expect("写入旧库结构");
    }

    /// 升级路径：旧库文件必须被**无损**升级到当前 schema。
    #[test]
    fn legacy_library_file_migrates_without_data_loss() {
        let path = unique_temp_db("legacy-upgrade");
        legacy_library_file(&path);
        {
            // 生产入口：open（并发加固）+ init_schema（迁移）。
            let conn = open(&path).expect("打开旧库");
            init_schema(&conn).expect("迁移旧库");
            assert_eq!(
                schema_version(&conn).unwrap(),
                SCHEMA_VERSION,
                "迁移后 user_version 必须等于当前 schema 版本"
            );
            let row = get_book(&conn, "legacy-1").unwrap().expect("旧书仍在");
            assert_eq!(row.path, "C:/Books/Legacy.cbz");
            assert_eq!(row.page_count, 12);
            assert_eq!(row.current_page, 5, "阅读进度不得在迁移中丢失");
            let removed: i64 = conn
                .query_row("SELECT removed FROM books WHERE id='legacy-1'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(removed, 0, "新增列必须取默认值");
            assert!((row.scroll_pct - (-1.0)).abs() < f64::EPSILON);
            assert_eq!(row.source_type, "local");
            assert_eq!(row.meta_json, "{}");
            assert_eq!(
                row.format, BOOK_FORMAT_IMAGE,
                "PDF-1 之前的老库必须按 image 处理"
            );
            // 旧 reading_log(date) 必须保留：迁移前没有 book_id 的历史落在
            // NULL 桶里（AGENTS.md §5：可空外键承载迁移前全局旧史）。
            let legacy_history: (Option<String>, i64) = conn
                .query_row(
                    "SELECT book_id, pages FROM reading_log WHERE date='2026-01-01'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                legacy_history,
                (None, 7),
                "旧阅读历史必须保留，且 book_id 保持 NULL（全局旧史桶）"
            );
            let global_days = reading_log_days(&conn, None, 3650).unwrap();
            assert!(
                global_days
                    .iter()
                    .any(|(date, pages)| date == "2026-01-01" && *pages == 7),
                "迁移前旧史必须仍能在全局统计里查到：{global_days:?}"
            );
            assert_eq!(
                get_setting(&conn, "theme").unwrap().as_deref(),
                Some("dark")
            );
            assert!(quick_check(&conn).is_ok(), "迁移后必须通过 quick_check");
            // 新增的唯一索引必须生效：(date, COALESCE(book_id,'')) 唯一。
            let dup = conn.execute(
                "INSERT INTO reading_log(date, book_id, pages) VALUES('2026-01-01', NULL, 1)",
                [],
            );
            assert!(dup.is_err(), "迁移后同日重复记录必须被唯一索引拒绝");
        }
        // 再次打开仍然是同一份数据（幂等迁移）。
        let conn = open(&path).expect("重开旧库");
        init_schema(&conn).expect("重复迁移");
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        assert!(get_book(&conn, "legacy-1").unwrap().is_some());
        drop(conn);
        cleanup_db_files(&path);
    }

    /// 回滚安全性：库文件来自**更新的版本**时，旧版应用不得降级 schema，
    /// 也不得损坏数据（只读兼容，交由用户升级处理）。
    #[test]
    fn newer_schema_version_is_not_downgraded() {
        let path = unique_temp_db("future-version");
        {
            let conn = open(&path).expect("打开临时库");
            init_schema(&conn).expect("建表");
            upsert_book(&conn, "b1", "p/b1", "第一卷", 10).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5)
                .unwrap();
        }
        {
            let conn = open(&path).expect("重开临时库");
            init_schema(&conn).expect("迁移");
            assert_eq!(
                schema_version(&conn).unwrap(),
                SCHEMA_VERSION + 5,
                "不得把更高版本的库降级写回旧 schema 版本"
            );
            assert!(
                get_book(&conn, "b1").unwrap().is_some(),
                "更高版本库里的书不得丢失"
            );
            assert!(quick_check(&conn).is_ok());
        }
        cleanup_db_files(&path);
    }

    /* ---------------- PDF-1：books.format（来源格式） ---------------- */

    /// 旧库（books 表没有 format 列）必须被增量迁移：
    /// 新列存在、旧行取默认值 image、进度与阅读历史一点不动。
    #[test]
    fn legacy_books_without_format_column_is_migrated_and_keeps_progress() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 0,
                current_page INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE reading_log(
                date TEXT NOT NULL,
                book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
                pages INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO books(id, path, title, page_count, current_page, updated_at)
                VALUES('legacy-1', 'C:/Books/Legacy.cbz', '旧书', 12, 5, '2026-01-01');
            INSERT INTO reading_log(date, book_id, pages) VALUES('2026-01-01', 'legacy-1', 7);
            PRAGMA user_version = 1;",
        )
        .unwrap();

        init_schema(&conn).expect("迁移旧库");

        // format 列必须被补上。
        let format_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='format'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(format_columns, 1, "init_schema 必须为旧库补上 format 列");

        // 旧行按默认值读回，且原有字段一个都不能变。
        let row = get_book(&conn, "legacy-1").unwrap().expect("旧书仍在");
        assert_eq!(row.format, BOOK_FORMAT_IMAGE, "老库一律按 image 处理");
        assert_eq!(row.page_count, 12);
        assert_eq!(row.current_page, 5, "阅读进度不得在迁移中丢失");
        assert!((row.scroll_pct - (-1.0)).abs() < f64::EPSILON);
        assert_eq!(row.source_type, "local");
        assert_eq!(row.meta_json, "{}");
        assert_eq!(
            reading_log_days(&conn, Some("legacy-1"), 3650).unwrap(),
            vec![("2026-01-01".into(), 7)],
            "阅读历史不得受迁移影响"
        );
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
    }

    /// `upsert_book_with_format` 落库 format；冲突更新保留 format（不降级）。
    #[test]
    fn upsert_book_with_format_persists_format_on_insert_and_conflict() {
        let conn = mem();
        upsert_book_with_format(
            &conn,
            "p1",
            "C:/Books/Comic.pdf",
            "Comic",
            0,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        assert_eq!(
            get_book(&conn, "p1").unwrap().unwrap().format,
            BOOK_FORMAT_PDF,
            "PDF 书必须落库 format=pdf"
        );

        // 同 id/path 重导入（PDF 导入路径）：format 不得被静默降级成 image。
        upsert_book_with_format(
            &conn,
            "p1",
            "C:/Books/Comic.pdf",
            "Comic 修订",
            0,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        let row = get_book(&conn, "p1").unwrap().unwrap();
        assert_eq!(row.format, BOOK_FORMAT_PDF);
        assert_eq!(row.title, "Comic 修订");
    }

    /// 普通 `upsert_book` 固定写 image（图片书导入路径的既有语义）。
    #[test]
    fn plain_upsert_book_writes_image_format() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "第一卷", 10).unwrap();
        assert_eq!(
            get_book(&conn, "b1").unwrap().unwrap().format,
            BOOK_FORMAT_IMAGE
        );
        // 覆盖同一 id 时按 upsert_book 的语义写回 image；PDF 导入必须走
        // upsert_book_with_format，否则会被降级。
        upsert_book_with_format(
            &conn,
            "p1",
            "C:/Books/Comic.pdf",
            "Comic",
            0,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        upsert_book(&conn, "p1", "C:/Books/Comic.pdf", "Comic", 0).unwrap();
        assert_eq!(
            get_book(&conn, "p1").unwrap().unwrap().format,
            BOOK_FORMAT_IMAGE
        );
    }

    /// 列表与单本读取都必须带上 format（SELECT 列序与 row_to_book 一致）。
    #[test]
    fn list_books_exposes_format_column() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "第一卷", 10).unwrap();
        upsert_book_with_format(&conn, "p2", "p/b2.pdf", "第二卷", 0, BOOK_FORMAT_PDF).unwrap();
        let books = list_books(&conn, None).unwrap();
        assert_eq!(books.len(), 2);
        let formats: Vec<String> = books.iter().map(|b| b.format.clone()).collect();
        assert!(formats.contains(&BOOK_FORMAT_IMAGE.to_string()));
        assert!(formats.contains(&BOOK_FORMAT_PDF.to_string()));
    }

    /// 重定位不得重置 format（进度保留的同时，来源格式也要保留）。
    #[test]
    fn relocate_book_preserves_format() {
        let conn = mem();
        upsert_book_with_format(&conn, "old", "p/old.pdf", "旧书", 10, BOOK_FORMAT_PDF).unwrap();
        set_progress(&conn, "old", 3, None).unwrap();
        let row = relocate_book(&conn, "old", "new", "q/新书.pdf", "新书", 10).unwrap();
        assert_eq!(row.format, BOOK_FORMAT_PDF, "重定位不得重置 format");
        assert_eq!(row.current_page, 3, "重定位不得丢阅读进度");
    }

    /// 重定位到 PDF 时允许改写 format；进度与历史照旧保留。
    #[test]
    fn relocate_book_with_format_writes_new_format() {
        let conn = mem();
        upsert_book(&conn, "old", "p/old", "旧书", 10).unwrap();
        set_progress(&conn, "old", 4, None).unwrap();
        let row = relocate_book_with_format(
            &conn,
            "old",
            "new",
            "q/新书.pdf",
            "新书",
            10,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        assert_eq!(row.format, BOOK_FORMAT_PDF);
        assert_eq!(row.current_page, 4, "改写 format 不得丢阅读进度");
        assert_eq!(
            reading_log_days(&conn, Some("new"), 7).unwrap(),
            vec![(today_str(), 4)],
            "改写 format 不得丢阅读历史"
        );
    }

    /// schema 版本：PDF-1 起必须是 2；v1 库升级后 user_version 变成 2。
    #[test]
    fn schema_version_is_two_and_v1_database_is_upgraded() {
        assert_eq!(SCHEMA_VERSION, 2, "PDF-1 起 schema 版本必须是 2");
        let path = unique_temp_db("schema-v2");
        {
            let conn = open(&path).expect("打开临时库");
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        {
            let conn = open(&path).expect("重开临时库");
            init_schema(&conn).expect("迁移");
            assert_eq!(
                schema_version(&conn).unwrap(),
                2,
                "v1 库升级后 user_version 必须变成 2"
            );
            // 幂等：重复 init 不得改写版本。
            init_schema(&conn).expect("重复迁移");
            assert_eq!(schema_version(&conn).unwrap(), 2);
        }
        cleanup_db_files(&path);
    }

    /* ---------------- PDF-2：books.page_count 回写 ---------------- */

    /// `set_book_page_count` 只改 `page_count`：id / path / format / 进度 /
    /// 滚动偏移 / updated_at 一律保持原值（PDF-2：前端 PDF.js 解析出页数后回写）。
    #[test]
    fn set_book_page_count_only_touches_page_count() {
        let conn = mem();
        upsert_book_with_format(
            &conn,
            "p1",
            "C:/Books/Comic.pdf",
            "Comic",
            0,
            BOOK_FORMAT_PDF,
        )
        .unwrap();
        set_progress(&conn, "p1", 0, None).unwrap();
        // 固定 updated_at，便于断言「不被改动」。
        conn.execute(
            "UPDATE books SET updated_at='2026-01-01 00:00:00', scroll_pct=0.25 WHERE id='p1'",
            [],
        )
        .unwrap();

        let before = get_book(&conn, "p1").unwrap().expect("PDF 书存在");
        set_book_page_count(&conn, "p1", 42).unwrap();
        let after = get_book(&conn, "p1").unwrap().expect("PDF 书仍在");

        assert_eq!(after.page_count, 42, "页数必须被写入");
        assert_eq!(after.id, before.id, "id 不得改变");
        assert_eq!(after.path, before.path, "path 不得改变");
        assert_eq!(after.title, before.title, "title 不得改变");
        assert_eq!(after.format, before.format, "format 不得改变");
        assert_eq!(after.current_page, before.current_page, "阅读进度不得改变");
        assert_eq!(after.scroll_pct, before.scroll_pct, "滚动偏移不得改变");
        assert_eq!(after.updated_at, before.updated_at, "updated_at 不得改变");
        assert_eq!(after.source_type, before.source_type, "来源类型不得改变");

        // 不存在的书 → 报错，不静默成功。
        assert!(set_book_page_count(&conn, "missing", 3).is_err());
    }

    /// 页数回写不得影响阅读历史与其它书。
    #[test]
    fn set_book_page_count_does_not_touch_reading_history() {
        let conn = mem();
        upsert_book_with_format(&conn, "p1", "p/1.pdf", "一", 0, BOOK_FORMAT_PDF).unwrap();
        upsert_book(&conn, "b2", "p/b2", "二", 10).unwrap();
        set_progress(&conn, "p1", 0, None).unwrap();
        set_progress(&conn, "b2", 4, None).unwrap();

        set_book_page_count(&conn, "p1", 7).unwrap();

        assert_eq!(
            get_book(&conn, "p1").unwrap().unwrap().page_count,
            7,
            "PDF 页数必须落库"
        );
        assert_eq!(
            get_book(&conn, "b2").unwrap().unwrap().page_count,
            10,
            "其它书的页数不得被影响"
        );
        assert!(
            reading_log_days(&conn, Some("p1"), 7).unwrap().is_empty(),
            "页数回写不得凭空写出阅读历史"
        );
        assert_eq!(
            reading_log_days(&conn, Some("b2"), 7).unwrap(),
            vec![(today_str(), 4)],
            "其它书的阅读历史不得被影响"
        );
    }

    // ── W2：set_progress 的 no-op 短路回归 ──────────────────────────────
    //
    // 背景：桌面阅读器在分页模式下每 500 ms 提交一次相同进度（W1 实测 2.00 Hz）。
    // 短路要求"两个被持久化的进度字段都没变"时不写库。
    //
    // 断言主仪器是**哨兵时间戳**：`updated_at` 只可能被 `set_progress` 的 UPDATE
    // 改写，所以把它钉成一个不可能与真实时间相等的值，就能直接判定"有没有发生
    // UPDATE"。这比计数接口更可靠——`updated_at` 只有秒级精度，靠时间戳差分
    // 判"写没写"会漏判；而 rusqlite 0.31 也没有 `total_changes()`。

    const SENTINEL_TS: &str = "1999-01-01 00:00:00";

    /// 取书当前的 (current_page, scroll_pct, updated_at)。
    fn progress_row(conn: &Connection, id: &str) -> (i64, f64, String) {
        conn.query_row(
            "SELECT current_page, scroll_pct, updated_at FROM books WHERE id=?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .expect("读取进度行")
    }

    /// 把 `updated_at` 钉成哨兵值；之后它若发生变化，即说明发生了 UPDATE。
    fn pin_timestamp(conn: &Connection, id: &str) {
        conn.execute(
            "UPDATE books SET updated_at=?2 WHERE id=?1",
            params![id, SENTINEL_TS],
        )
        .expect("钉住时间戳");
    }

    /// 某书的阅读历史累计页数。
    fn reading_log_total(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(pages),0) FROM reading_log WHERE book_id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .expect("读取阅读历史")
    }

    /// T1：相同进度不重复写库。
    #[test]
    fn set_progress_does_not_write_when_nothing_changed() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        set_progress(&conn, "b1", 7, None).unwrap();
        let (page, pct, _) = progress_row(&conn, "b1");

        pin_timestamp(&conn, "b1");
        set_progress(&conn, "b1", 7, None).unwrap();
        set_progress(&conn, "b1", 7, None).unwrap();

        let (page2, pct2, updated_at2) = progress_row(&conn, "b1");
        assert_eq!(
            updated_at2, SENTINEL_TS,
            "相同进度不得写库（哨兵时间戳未被覆盖即证明没有 UPDATE）"
        );
        assert_eq!((page2, pct2), (page, pct), "进度值不得被改动");
    }

    /// T2：进度真的变化时照常写入。
    #[test]
    fn set_progress_writes_when_progress_changes() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        pin_timestamp(&conn, "b1");

        set_progress(&conn, "b1", 7, None).unwrap();

        let (page, pct, updated_at) = progress_row(&conn, "b1");
        assert_eq!(page, 7, "页码必须落库");
        assert_eq!(pct, -1.0, "分页模式必须把条漫百分比清为 -1");
        assert_ne!(updated_at, SENTINEL_TS, "真实变化必须写库并刷新 updated_at");
    }

    /// T3：`updated_at` 只在真实变化时更新（含"仅百分比变化"这一路）。
    #[test]
    fn set_progress_refreshes_timestamp_only_on_real_change() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
        set_progress(&conn, "b1", 7, Some(0.25)).unwrap();

        // 同页、同百分比 → 不得写库。
        pin_timestamp(&conn, "b1");
        set_progress(&conn, "b1", 7, Some(0.25)).unwrap();
        assert_eq!(
            progress_row(&conn, "b1").2,
            SENTINEL_TS,
            "百分比未变时不得写库"
        );

        // 仅百分比变化 → 必须写库（页码不动）。
        set_progress(&conn, "b1", 7, Some(0.5)).unwrap();
        let (page, pct, updated_at) = progress_row(&conn, "b1");
        assert_eq!(page, 7, "页码不得被百分比写入改动");
        assert!((pct - 0.5).abs() < 1e-9, "百分比必须落库");
        assert_ne!(updated_at, SENTINEL_TS, "百分比变化必须写库");
    }

    /// T4：`reading_log` 语义保持不变（前进 +1 / 回翻 +0 / 重复 +0 / 跳页记差值）。
    #[test]
    fn set_progress_keeps_reading_log_semantics() {
        let conn = mem();
        upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();

        set_progress(&conn, "b1", 1, None).unwrap();
        assert_eq!(reading_log_total(&conn, "b1"), 1, "前进一页必须记 +1");

        set_progress(&conn, "b1", 0, None).unwrap();
        assert_eq!(reading_log_total(&conn, "b1"), 1, "回翻不得计入历史");

        set_progress(&conn, "b1", 0, None).unwrap();
        assert_eq!(reading_log_total(&conn, "b1"), 1, "同页重复写不得计入历史");

        set_progress(&conn, "b1", 5, None).unwrap();
        assert_eq!(reading_log_total(&conn, "b1"), 6, "跳页必须记差值");
    }

    /// 行不存在时不得短路：既有分裂语义原样保留。
    #[test]
    fn set_progress_keeps_missing_book_semantics() {
        let conn = mem();
        // page=0：UPDATE 命中 0 行且不写历史 → 静默成功（既有行为）。
        set_progress(&conn, "missing", 0, None).unwrap();
        // page>0：reading_log 外键失败 → 报错（既有行为）。
        assert!(
            set_progress(&conn, "missing", 1, None).is_err(),
            "不存在的书 + page>0 必须报错"
        );
    }

    /// T6：SQLite 完整性正常。
    #[test]
    fn set_progress_keeps_database_integrity() {
        let path = unique_temp_db("noop-integrity");
        {
            let conn = open(&path).expect("打开临时库");
            init_schema(&conn).expect("建表");
            upsert_book(&conn, "b1", "p/b1", "书", 30).unwrap();
            for page in 0..6u32 {
                set_progress(&conn, "b1", page, None).unwrap();
                set_progress(&conn, "b1", page, None).unwrap();
            }
            let check: String = conn
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .expect("quick_check");
            assert_eq!(check, "ok", "quick_check 必须通过");
        }
        cleanup_db_files(&path);
    }
}
