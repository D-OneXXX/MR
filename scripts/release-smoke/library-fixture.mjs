#!/usr/bin/env node
/**
 * 发布冒烟用的**合成书库夹具**：在隔离数据目录的 `library.db` 里写入
 * 一本 3 页本地书 + 阅读进度 + 两条 reading_log，并在升级/回滚后核验
 * 这些数据逐字节可重建（snapshotSha256）。
 *
 * 为什么直接写 SQLite 而不是走 UI 导入：
 * - 升级/回滚验证关心的是「旧版本写下的用户数据能否被新版本原样读出」，
 *   导入 UI 的可用性由 QA harness 覆盖，这里要的是确定性；
 * - 应用关闭后再写库，因此不会与运行中的进程抢锁；`books` / `reading_log`
 *   的 schema 完全由已安装的应用创建，本脚本**绝不**自行建 app schema。
 *
 * 用法：
 *   node --experimental-sqlite scripts/release-smoke/library-fixture.mjs seed \
 *     --data-dir <隔离数据目录> --fixture <fixture.json> [--out seed.json]
 *
 *   node --experimental-sqlite scripts/release-smoke/library-fixture.mjs verify \
 *     --data-dir <隔离数据目录> --fixture <fixture.json> --out verify.json \
 *     [--schema-version-before <升级前 user_version>]
 *
 * 退出码：0 = ok，1 = 校验失败，2 = 参数/环境错误。
 *
 * 契约（与发布门禁一致）：
 * - book id = sha256(绝对路径)，与 Rust `db::book_id_for_path` 一致；
 * - currentPage=2 / pageCount=3 / scrollPct=0.5；
 * - reading_log 两行不同日期，pages 合计 3；
 * - verify 必须做 `PRAGMA quick_check`、按 id 查询、reading_log 聚合、
 *   bookCount、schemaVersion、books 快照与 snapshotSha256。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export const FIXTURE_KIND = "manga-reader.library-fixture";

export const DEFAULT_TITLE = "Release Smoke Book";
export const DEFAULT_PAGE_COUNT = 3;
export const DEFAULT_CURRENT_PAGE = 2;
export const DEFAULT_SCROLL_PCT = 0.5;
export const DEFAULT_DATES = ["2026-01-01", "2026-01-02"];
export const DEFAULT_LOG_PAGES = [1, 2]; // 合计 3 页，两行日期不同
export const DEFAULT_UPDATED_AT = "2026-01-02 03:04:05";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

/** 与 Rust `db::book_id_for_path` 完全一致：对入库路径字符串做 sha256。 */
export function bookIdForPath(absolutePath) {
  return sha256Bytes(Buffer.from(String(absolutePath), "utf8"));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/** 最小的合法 1x1 不透明 PNG（由应用自身的图片解码器判定有效性）。 */
export function makePng(size = 1) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`PNG 边长非法：${size}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let row = 0; row < size; row += 1) {
    const offset = row * (1 + size * 3);
    raw[offset] = 0; // filter: none
    for (let column = 0; column < size; column += 1) {
      const pixel = offset + 1 + column * 3;
      raw[pixel] = 0x38;
      raw[pixel + 1] = 0xa8;
      raw[pixel + 2] = 0xf8;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function fixtureBookDir(dataDir) {
  return path.resolve(dataDir, "release-smoke", "book");
}

export function buildFixture(dataDir) {
  const bookPath = fixtureBookDir(dataDir);
  return {
    kind: FIXTURE_KIND,
    bookId: bookIdForPath(bookPath),
    bookPath,
    title: DEFAULT_TITLE,
    pageCount: DEFAULT_PAGE_COUNT,
    currentPage: DEFAULT_CURRENT_PAGE,
    scrollPct: DEFAULT_SCROLL_PCT,
    bookCount: 1,
    sourceType: "local",
    removed: 0,
    updatedAt: DEFAULT_UPDATED_AT,
    readingLogRows: DEFAULT_DATES.length,
    readingLogPages: DEFAULT_LOG_PAGES.reduce((sum, value) => sum + value, 0),
    readingLog: DEFAULT_DATES.map((date, index) => ({
      date,
      pages: DEFAULT_LOG_PAGES[index],
    })),
    files: ["1.png", "2.png", "3.png"],
  };
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeFixtureFile(fixturePath, fixture) {
  writeJsonFile(fixturePath, fixture);
}

export function readFixtureFile(fixturePath) {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function openDatabase(dbPath, { readOnly = false } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=5000");
  } catch {
    /* 只读连接不支持该 PRAGMA 时忽略 */
  }
  return db;
}

function hasAppTables(db) {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('books','reading_log')",
    )
    .all();
  const names = new Set(rows.map((row) => row.name));
  return names.has("books") && names.has("reading_log");
}

/** 轮询等待已安装应用创建 `books` / `reading_log`；绝不自行建表。 */
export async function waitForAppSchema(dbPath, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(dbPath)) {
      let db = null;
      try {
        db = openDatabase(dbPath, { readOnly: true });
        if (hasAppTables(db)) return true;
      } catch (error) {
        lastError = error;
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `等待应用创建 books/reading_log 超时（${timeoutMs}ms）：${dbPath}` +
      (lastError ? `；最后错误：${lastError.message}` : ""),
  );
}

function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/**
 * 写入合成书库。
 * @param {object} options
 * @param {string} options.dataDir 隔离数据目录（应用关闭状态）
 * @param {string} [options.fixturePath] 写入 fixture.json 的路径
 * @param {number} [options.waitMs] 等待应用 schema 的上限
 */
export async function seedLibrary({
  dataDir,
  fixturePath,
  waitMs = 30_000,
  intervalMs = 250,
} = {}) {
  if (!dataDir) throw new Error("seedLibrary 需要 dataDir");
  const resolvedDataDir = path.resolve(dataDir);
  fs.mkdirSync(resolvedDataDir, { recursive: true });
  const fixture = buildFixture(resolvedDataDir);
  const bookDir = fixture.bookPath;
  fs.mkdirSync(bookDir, { recursive: true });
  const png = makePng(1);
  for (const name of fixture.files) {
    fs.writeFileSync(path.join(bookDir, name), png);
  }

  const dbPath = path.join(resolvedDataDir, "library.db");
  await waitForAppSchema(dbPath, { timeoutMs: waitMs, intervalMs });

  const db = openDatabase(dbPath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      // 幂等：重复 seed 时把同一本书重置为夹具值。
      db.prepare("DELETE FROM reading_log WHERE book_id = ?").run(fixture.bookId);
      db.prepare(
        `INSERT INTO books(id, path, title, page_count, current_page, updated_at,
                          removed, scroll_pct, source_type, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path,
           title=excluded.title,
           page_count=excluded.page_count,
           current_page=excluded.current_page,
           updated_at=excluded.updated_at,
           removed=excluded.removed,
           scroll_pct=excluded.scroll_pct,
           source_type=excluded.source_type`,
      ).run(
        fixture.bookId,
        fixture.bookPath,
        fixture.title,
        fixture.pageCount,
        fixture.currentPage,
        fixture.updatedAt,
        fixture.removed,
        fixture.scrollPct,
        fixture.sourceType,
      );
      const insertLog = db.prepare(
        "INSERT INTO reading_log(date, book_id, pages) VALUES (?, ?, ?)",
      );
      for (const entry of fixture.readingLog) {
        insertLog.run(entry.date, fixture.bookId, entry.pages);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
    const schemaVersion = readUserVersion(db);
    if (schemaVersion < 1) {
      throw new Error(`应用 schema 版本非法（PRAGMA user_version=${schemaVersion}）`);
    }
    const result = {
      ok: true,
      bookId: fixture.bookId,
      bookPath: fixture.bookPath,
      schemaVersion,
      bookCount: fixture.bookCount,
      readingLogRows: fixture.readingLogRows,
      readingLogPages: fixture.readingLogPages,
      seededAt: new Date().toISOString(),
      fixturePath: fixturePath ? path.resolve(fixturePath) : null,
    };
    if (fixturePath) writeFixtureFile(fixturePath, fixture);
    return result;
  } finally {
    db.close();
  }
}

function snapshotPayload({ bookCount, readingLogRows, readingLogPages, schemaVersion, books }) {
  return {
    bookCount,
    readingLogRows,
    readingLogPages,
    schemaVersion,
    books,
  };
}

/**
 * 核验合成书库：quick_check + 按 id 查询 + reading_log 聚合 + schema 版本 + 快照。
 * 任何一项不匹配都会写入 `problems` 并返回 ok=false（CLI 退出码 1）。
 */
export function verifyLibrary({
  dataDir,
  fixturePath,
  fixture: fixtureOverride,
  schemaVersionBefore = null,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir || ".");
  const fixture = fixtureOverride || readFixtureFile(fixturePath);
  const dbPath = path.join(resolvedDataDir, "library.db");
  const problems = [];
  const result = {
    ok: false,
    dataDir: resolvedDataDir,
    quickCheck: "missing",
    schemaVersion: 0,
    schemaVersionBefore:
      schemaVersionBefore === null || schemaVersionBefore === undefined
        ? null
        : Number(schemaVersionBefore),
    schemaVersionAfter: 0,
    bookCount: 0,
    readingLogRows: 0,
    readingLogPages: 0,
    books: [],
    snapshotSha256: null,
    verifiedAt: new Date().toISOString(),
    problems,
  };

  if (!fs.existsSync(dbPath)) {
    problems.push(`找不到 library.db：${dbPath}`);
    return result;
  }

  let db = null;
  try {
    db = openDatabase(dbPath, { readOnly: true });
    const quick = db.prepare("PRAGMA quick_check").get();
    result.quickCheck = String(quick?.quick_check ?? "unknown").toLowerCase();
    if (result.quickCheck !== "ok") {
      problems.push(`quick_check 未通过：${result.quickCheck}`);
    }

    const schemaVersion = readUserVersion(db);
    result.schemaVersion = schemaVersion;
    result.schemaVersionAfter = schemaVersion;
    if (schemaVersion < 1) {
      problems.push(`schema 版本非法（user_version=${schemaVersion}）`);
    }
    if (result.schemaVersionBefore !== null && schemaVersion < result.schemaVersionBefore) {
      problems.push(
        `schema 版本降级：升级前=${result.schemaVersionBefore} 当前=${schemaVersion}`,
      );
    }

    const book = db
      .prepare(
        `SELECT id, path, title, page_count, current_page, scroll_pct,
                removed, source_type
           FROM books WHERE id = ?`,
      )
      .get(fixture.bookId);
    if (!book) {
      problems.push(`按 id 找不到书：${fixture.bookId}`);
    } else {
      const mapped = {
        id: book.id,
        title: book.title,
        pageCount: Number(book.page_count),
        currentPage: Number(book.current_page),
        scrollPct: Number(book.scroll_pct),
        removed: Number(book.removed),
        sourceType: book.source_type,
      };
      if (mapped.title !== fixture.title) {
        problems.push(`标题被改：期望 ${fixture.title}，实际 ${mapped.title}`);
      }
      if (mapped.pageCount !== fixture.pageCount) {
        problems.push(`页数被改：期望 ${fixture.pageCount}，实际 ${mapped.pageCount}`);
      }
      if (mapped.currentPage !== fixture.currentPage) {
        problems.push(`阅读进度被改：期望 ${fixture.currentPage}，实际 ${mapped.currentPage}`);
      }
      if (Math.abs(mapped.scrollPct - fixture.scrollPct) > 1e-9) {
        problems.push(`条漫偏移被改：期望 ${fixture.scrollPct}，实际 ${mapped.scrollPct}`);
      }
      if (mapped.removed !== fixture.removed) {
        problems.push(`removed 被改：期望 ${fixture.removed}，实际 ${mapped.removed}`);
      }
      if (mapped.sourceType !== fixture.sourceType) {
        problems.push(`source_type 被改：期望 ${fixture.sourceType}，实际 ${mapped.sourceType}`);
      }
      if (String(book.path) !== fixture.bookPath) {
        problems.push(`书路径被改：期望 ${fixture.bookPath}，实际 ${book.path}`);
      }
      result.books = [mapped];
    }

    const aggregate = db
      .prepare(
        "SELECT COUNT(*) AS rows, COALESCE(SUM(pages),0) AS pages FROM reading_log WHERE book_id = ?",
      )
      .get(fixture.bookId);
    result.readingLogRows = Number(aggregate?.rows ?? 0);
    result.readingLogPages = Number(aggregate?.pages ?? 0);
    if (result.readingLogRows !== fixture.readingLogRows) {
      problems.push(
        `reading_log 行数不符：期望 ${fixture.readingLogRows}，实际 ${result.readingLogRows}`,
      );
    }
    if (result.readingLogPages !== fixture.readingLogPages) {
      problems.push(
        `reading_log 页数不符：期望 ${fixture.readingLogPages}，实际 ${result.readingLogPages}`,
      );
    }
    if (Array.isArray(fixture.readingLog)) {
      for (const expected of fixture.readingLog) {
        const row = db
          .prepare("SELECT pages FROM reading_log WHERE book_id = ? AND date = ?")
          .get(fixture.bookId, expected.date);
        if (!row || Number(row.pages) !== Number(expected.pages)) {
          problems.push(
            `reading_log(${expected.date}) 不符：期望 ${expected.pages}，实际 ${
              row ? row.pages : "缺失"
            }`,
          );
        }
      }
    }

    const countRow = db.prepare("SELECT COUNT(*) AS count FROM books WHERE removed = 0").get();
    result.bookCount = Number(countRow?.count ?? 0);
    if (result.bookCount !== fixture.bookCount) {
      problems.push(`bookCount 不符：期望 ${fixture.bookCount}，实际 ${result.bookCount}`);
    }

    const payload = snapshotPayload(result);
    result.snapshotSha256 = sha256Bytes(Buffer.from(JSON.stringify(payload), "utf8"));
  } catch (error) {
    problems.push(`读取书库失败：${error.message}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }

  result.ok = problems.length === 0;
  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const dataDir = args["data-dir"];
  const fixturePath = args.fixture;
  if (!command || !dataDir || !fixturePath) {
    console.error(
      "用法：library-fixture.mjs seed|verify --data-dir <dir> --fixture <json> [--out <json>]",
    );
    return 2;
  }
  try {
    if (command === "seed") {
      const result = await seedLibrary({
        dataDir,
        fixturePath,
        waitMs: args["wait-ms"] ? Number(args["wait-ms"]) : 30_000,
      });
      if (args.out) writeJsonFile(args.out, result);
      console.log(`[library-fixture] seed OK ${JSON.stringify(result)}`);
      return 0;
    }
    if (command === "verify") {
      const result = verifyLibrary({
        dataDir,
        fixturePath,
        schemaVersionBefore: args["schema-version-before"]
          ? Number(args["schema-version-before"])
          : null,
      });
      if (args.out) writeJsonFile(args.out, result);
      if (!result.ok) {
        console.error(`[library-fixture] verify FAIL ${JSON.stringify(result, null, 2)}`);
        return 1;
      }
      console.log(
        `[library-fixture] verify OK snapshot=${result.snapshotSha256} books=${result.bookCount} log=${result.readingLogRows}/${result.readingLogPages} schema=${result.schemaVersion}`,
      );
      return 0;
    }
    console.error(`未知子命令：${command}`);
    return 2;
  } catch (error) {
    console.error(`[library-fixture] ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = await main();
}
