#!/usr/bin/env node
/**
 * 发布门禁用的 **PDF / 备份恢复 / 数据库回滚** 真实链路校验。
 *
 * 与 `library-ui-check.mjs` 一样：脚本只连接**已安装并在运行**的发布版应用，
 * 不启动 Vite、不启动应用、不伪造数据；所有结论都来自真实 CDP 求值 + 真实
 * Tauri IPC（`import_books` / `list_books` / `get_book` / `export_backup` /
 * `import_backup`），只有明确标注的步骤才读写 SQLite（且必须在应用关闭后）。
 *
 * 子命令（由 `windows-install-upgrade.ps1` 编排）：
 *   ui             --port <p> --data-dir <fixture工作目录> --render-cache <dir> --out <json>
 *                  导入 4 页合成 PDF → 阅读器渲染（非空白像素断言）→ 真键盘翻到第 3 页
 *                  → 真实按钮缩放 +25% → 书库封面 <img> 与封面缓存文件。
 *   db             --data-dir <应用数据目录> --book-id <id> --expect-page 3 --expect-count 4 --out <json>
 *                  应用关闭后只读打开 library.db：format=pdf / page_count / current_page /
 *                  quick_check / user_version=2 / 封面缓存 JPEG 合法性 / 凭据残留。
 *   restart        --port <p> --book-id <id> --expect-page 3 --out <json>
 *                  真实进程重启后打开阅读器：恢复页码仍为 3 且画布已解码。
 *   backup-export  --port <p> --dest <path> --book-id <id> --out <json>
 *                  export_backup → 校验 .mrbackup 条目、manifest、快照库里的 PDF 书与进度，
 *                  并断言快照不含 online_headers 等凭据。
 *   backup-restore --port <p> --data-dir <隔离数据目录> --source <path>
 *                  --expect-book-id <id> --out <json>
 *                  在**另一个**隔离 profile 里 import_backup 并回读 PDF 书与进度。
 *   legacy-backup  --out <path> --work-dir <dir> [--evidence <json>]
 *                  生成 PDF-1 之前形态（books 无 format 列、user_version=1）的合法
 *                  .mrbackup：真实 zip + 合法 manifest（计数/表/列与 backup.rs 一致）。
 *   verify-legacy  --port <p> --data-dir <dir> --source <path> --book-id <id> --out <json>
 *                  在**另一个**隔离 profile 里恢复旧备份：图片书与进度保留、
 *                  quick_check 通过、user_version 升到 2、format 落回 image。
 *   db-snapshot    --data-dir <dir> --out <snapshot.db> [--evidence <json>]
 *                  VACUUM INTO 安全快照（应用关闭时）。
 *   db-restore     --data-dir <dir> --snapshot <snapshot.db> [--book-id <id>]
 *                  [--expect-current-page 2] [--evidence <json>]
 *                  处理 -wal/-shm 后原子回滚，并做逐字节完整性校验。
 *   rollback-compat --port <p> --data-dir <dir> --out <json>
 *                  旧版本（0.17.2）已安装并运行：list_books 必须返回数组不抛错，
 *                  且 v2 库 user_version 仍为 2、quick_check 通过。
 *
 * 坐标说明（与产品一致，**不得**臆造）：`books.current_page` 是 0 基页索引
 * （见 `src/features/pdf/../pages/Reader.tsx` 的 `applyRestore` 与
 * `tests/qa/suites/pdf.mjs` 的进度断言）。因此 `--expect-page 3` 表示
 * **阅读器第 3 页**，落库值为 `3 - 1 = 2`；证据里同时给出
 * `readerPage`（1 基）与 `storedCurrentPage`（0 基）。
 *
 * 数据目录语义：
 * - `ui` 的 `--data-dir` 是**夹具工作目录**，必须在应用 MR_DATA_DIR 之外：
 *   产品的本地书源安全策略会拒绝读取应用数据/缓存目录内的 PDF
 *   （`src-tauri/src/commands.rs: is_safe_library_source_path`），
 *   把夹具放进应用数据目录会让每个 PDF 断言都变成 `pdf-source-not-allowed`。
 * - 其余子命令的 `--data-dir` 都是应用的隔离数据目录（与安装脚本的
 *   MR_DATA_DIR 一致）。
 *
 * 证据安全：所有 JSON 证据与日志只出现书 ID、计数、哈希与稳定错误码，
 * 绝不写入绝对路径 / Cookie / Token / 签名材料。
 *
 * 退出码：0 = 全部断言通过；1 = 断言失败；2 = 参数/环境错误。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CdpPage, waitForTarget } from "../../tests/qa/lib/cdp.mjs";
import { invoke, invokeSafe, waitForApp } from "../../tests/qa/lib/app.mjs";
import { makePdf } from "../../tests/qa/lib/pdf-fixtures.mjs";
import {
  bookIdForPath,
  makePng,
  sha256Bytes,
  sha256File,
  writeJsonFile,
} from "./library-fixture.mjs";
import { isMainTarget } from "./library-ui-check.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const RESULT_KIND = "manga-reader.pdf-release-check";
/** 合成 PDF 页数（与 ui / db 断言一致）。 */
export const PDF_PAGE_COUNT = 4;
/** 阅读器目标页（1 基）。落库 current_page = 2。 */
export const TARGET_READER_PAGE = 3;
/** 后端 `db::SCHEMA_VERSION`（PDF-1 起为 2）。 */
export const SCHEMA_VERSION = 2;
export const BACKUP_FORMAT = "mangareader-backup";
export const BACKUP_SCHEMA = 1;
/** 与 `src-tauri/src/pdf.rs::PDF_COVER_EDGE` 一致。 */
export const PDF_COVER_EDGE = 256;
/** 与 `src-tauri/src/pdf.rs::MAX_PDF_COVER_BYTES / MAX_PDF_COVER_EDGE` 一致。 */
export const MAX_PDF_COVER_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_COVER_EDGE = 4096;
export const LEGACY_APP_VERSION = "0.17.2";
export const LEGACY_BOOK_TITLE = "Legacy Smoke Book";
export const LEGACY_PAGE_COUNT = 20;
export const LEGACY_CURRENT_PAGE = 12;
/** 书库卡片定位片段：书名来自文件名 stem（commands.rs::title_for），即 "release-smoke"。 */
export const PDF_TITLE_FRAGMENT = "release-smoke";
export const LEGACY_READING_LOG = [
  { date: "2026-01-01", pages: 5 },
  { date: "2026-01-02", pages: 7 },
];

/** 新增的四项发布门禁检查名（与安装脚本 / evidence.mjs 保持一致）。 */
export const PDF_CHECKS = [
  "pdfReading",
  "progressRestart",
  "backupRestore",
  "databaseRollback",
];

/** 备份快照允许保留的 settings 键（与 `backup.rs::BACKUP_SETTING_KEYS` 一致）。 */
export const BACKUP_SETTING_KEYS = new Set([
  "theme",
  "cache_budget_mb",
  "disk_cache_budget_mb",
  "library_dir",
  "experimental_webtoon",
]);

/** 备份 manifest 必须排除的资产（与 `backup.rs::EXCLUDED_ASSETS` 一致）。 */
export const BACKUP_EXCLUDES = [
  "caches",
  "online_headers",
  "online_filter_events",
  "app_meta",
  "unapproved_settings",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 错误与参数                                                          */
/* ------------------------------------------------------------------ */

/**
 * 只保留稳定错误码：产品错误形如「……（pdf-not-valid）」，Node 错误带 `code`。
 * 证据与日志绝不能出现绝对路径 / 书名，因此不返回原始 message。
 */
export function safeErrorCode(error) {
  const text = String(error?.message ?? error ?? "");
  const stable = text.match(/（([a-z0-9]+(?:-[a-z0-9]+)*)）/);
  if (stable) return stable[1];
  const nodeCode = error?.code;
  if (typeof nodeCode === "string" && /^[A-Za-z0-9_]+$/.test(nodeCode)) {
    return nodeCode.toLowerCase();
  }
  return "unexpected-error";
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

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 证据落盘：`ok` 只在 `problems` 为空时为 true。 */
function emit(result, evidencePath) {
  result.ok = (result.problems ?? []).length === 0;
  const payload = { kind: RESULT_KIND, checkedAt: new Date().toISOString(), ...result };
  if (evidencePath) writeJsonFile(evidencePath, payload);
  const label = payload.command || "unknown";
  if (payload.ok) {
    console.log(`[pdf-release-check] ${label} OK`);
  } else {
    console.error(`[pdf-release-check] ${label} FAIL（${payload.problems.length} 项）`);
    for (const problem of payload.problems) console.error(`  - ${problem}`);
  }
  return payload.ok ? 0 : 1;
}

function usageError(result, evidencePath, code) {
  result.problems.push(code);
  result.ok = false;
  if (evidencePath) {
    writeJsonFile(evidencePath, {
      kind: RESULT_KIND,
      checkedAt: new Date().toISOString(),
      ...result,
      ok: false,
    });
  }
  console.error(`[pdf-release-check] ${result.command || "unknown"} 参数错误：${code}`);
  return 2;
}

/* ------------------------------------------------------------------ */
/* ZIP（.mrbackup 与 .cbz）：只依赖内置 zlib                          */
/* ------------------------------------------------------------------ */

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

/** 生成 store（不压缩）zip：条目名不允许含路径分隔符（与 backup.rs 的条目契约一致）。 */
export function writeStoredZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/**
 * 读取 zip（支持 stored / deflate），并逐个条目校验 CRC。
 * 结构来自中央目录（Rust zip 写入的本地头可能带 data descriptor，不可依赖）。
 */
export function readZipEntries(buffer) {
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= stop; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip-eocd-missing（zip-eocd-missing）");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buffer.length) throw new Error("zip-central-out-of-range（zip-central-out-of-range）");
  const entries = new Map();
  let cursor = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("zip-central-corrupt（zip-central-corrupt）");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("zip-local-corrupt（zip-local-corrupt）");
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) {
      throw new Error("zip-entry-out-of-range（zip-entry-out-of-range）");
    }
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`zip-method-unsupported（zip-method-${method}）`);
    }
    if (crc32(data) !== crc) throw new Error(`zip-crc-mismatch（zip-crc-${name}）`);
    entries.set(name, data);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* 图像头解析                                                          */
/* ------------------------------------------------------------------ */

/** JPEG 尺寸（SOF0..SOF15，跳过 DHT/DAC/RST）；不是 JPEG 返回 null。 */
export function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let index = 2;
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = bytes[index + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    if (index + 4 > bytes.length) break;
    const segment = bytes.readUInt16BE(index + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: bytes.readUInt16BE(index + 5),
        width: bytes.readUInt16BE(index + 7),
      };
    }
    index += 2 + segment;
  }
  return null;
}

export function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/* ------------------------------------------------------------------ */
/* SQLite 读取辅助                                                     */
/* ------------------------------------------------------------------ */

function openReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
  } catch {
    /* 只读连接不支持时忽略 */
  }
  return db;
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return Number(row?.n ?? 0) > 0;
}

function tableColumns(db, name) {
  return db
    .prepare(`PRAGMA table_info(${name})`)
    .all()
    .map((row) => String(row.name));
}

function quickCheckOf(db) {
  const row = db.prepare("PRAGMA quick_check").get();
  const value = row?.quick_check ?? Object.values(row ?? {})[0] ?? "unknown";
  return String(value).toLowerCase();
}

function userVersionOf(db) {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

/** 读取一本书（legacy 库没有 format 列时返回 image 语义）。 */
export function readBookRow(db, bookId) {
  const hasFormat = tableColumns(db, "books").includes("format");
  const columns = [
    "id",
    "path",
    "title",
    "page_count",
    "current_page",
    "removed",
    "source_type",
    ...(hasFormat ? ["format"] : []),
  ];
  const row = db
    .prepare(`SELECT ${columns.join(", ")} FROM books WHERE id = ?`)
    .get(bookId);
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    pageCount: Number(row.page_count),
    currentPage: Number(row.current_page),
    removed: Number(row.removed),
    sourceType: String(row.source_type),
    format: hasFormat ? String(row.format) : "image",
    hasFormatColumn: hasFormat,
  };
}

function readingLogOf(db, bookId) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(pages), 0) AS pages FROM reading_log WHERE book_id = ?",
    )
    .get(bookId);
  return { rows: Number(row?.rows ?? 0), pages: Number(row?.pages ?? 0) };
}

/**
 * PDF 封面缓存校验：固定键 `<bookId>/000000@256x256.jpg`（见 render_cache.rs）。
 * 写回路径只接受 JPEG（pdf.rs::validate_pdf_cover），因此这里要求 FF D8 FF。
 */
export function coverCacheState(renderCacheDir, bookId) {
  const problems = [];
  const file = path.join(renderCacheDir, bookId, `000000@${PDF_COVER_EDGE}x${PDF_COVER_EDGE}.jpg`);
  if (!fs.existsSync(file)) {
    return { problems: ["cover-cache-missing"], sha256: null, bytes: null, width: null, height: null };
  }
  const data = fs.readFileSync(file);
  const state = {
    problems,
    sha256: sha256Bytes(data),
    bytes: data.length,
    width: null,
    height: null,
  };
  if (data.length > MAX_PDF_COVER_BYTES) problems.push("cover-cache-too-large");
  if (!isJpeg(data)) {
    problems.push("cover-cache-not-jpeg");
    return state;
  }
  const dims = jpegDimensions(data);
  if (!dims) {
    problems.push("cover-cache-jpeg-header-invalid");
    return state;
  }
  state.width = dims.width;
  state.height = dims.height;
  if (dims.width > MAX_PDF_COVER_EDGE || dims.height > MAX_PDF_COVER_EDGE) {
    problems.push("cover-cache-dimensions");
  }
  return state;
}

/**
 * 备份快照的凭据残留检查（**严格**：只允许 settings 白名单键）。
 * 与 backup.rs::sanitize_snapshot 的净化结果一一对应。
 */
export function snapshotCredentialProblems(dbPath) {
  const problems = [];
  const db = openReadOnly(dbPath);
  try {
    if (tableExists(db, "settings")) {
      for (const row of db.prepare("SELECT k FROM settings").all()) {
        const key = String(row.k);
        if (!BACKUP_SETTING_KEYS.has(key)) {
          problems.push(`settings 残留非白名单键：${key}`);
        }
      }
    }
    if (tableExists(db, "online_filter_events")) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM online_filter_events").get();
      if (Number(row?.n ?? 0) > 0) problems.push("online_filter_events 残留事件行");
    }
    if (tableExists(db, "app_meta")) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM app_meta").get();
      if (Number(row?.n ?? 0) > 0) problems.push("app_meta 残留内部标记");
    }
  } finally {
    db.close();
  }
  // VACUUM 会把删除页重写掉：快照字节里不得再出现凭据键名。
  const raw = fs.readFileSync(dbPath);
  if (raw.includes(Buffer.from("online_headers", "latin1"))) {
    problems.push("快照字节残留 online_headers 字样");
  }
  return problems;
}

/** 活库凭据检查（较宽松：只要求没有非空 online_headers）。 */
export function liveCredentialProblems(db) {
  const problems = [];
  if (!tableExists(db, "settings")) return problems;
  const row = db.prepare("SELECT v FROM settings WHERE k = 'online_headers'").get();
  if (row && String(row.v ?? "").trim() !== "") {
    problems.push("活库 settings.online_headers 非空");
  }
  if (tableExists(db, "online_filter_events")) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM online_filter_events").get();
    if (Number(count?.n ?? 0) > 0) problems.push("活库 online_filter_events 非空");
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* 数据库快照 / 回滚                                                   */
/* ------------------------------------------------------------------ */

/** VACUUM INTO 快照（应用必须已关闭；不复制 -wal 残页，快照自洽）。 */
export function snapshotDatabase({ dataDir, out }) {
  const dbPath = path.join(dataDir, "library.db");
  if (!fs.existsSync(dbPath)) throw new Error("library.db 不存在（db-missing）");
  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  const check = openReadOnly(target);
  let quickCheck;
  let schemaVersion;
  let bookCount;
  try {
    quickCheck = quickCheckOf(check);
    schemaVersion = userVersionOf(check);
    bookCount = Number(check.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0);
  } finally {
    check.close();
  }
  return {
    snapshotSha256: sha256File(target),
    quickCheck,
    schemaVersion,
    bookCount,
  };
}

/** 读取快照自检（回滚前 / 回滚后都可用）。 */
export function inspectSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) throw new Error("快照不存在（snapshot-missing）");
  const db = openReadOnly(snapshotPath);
  try {
    return {
      quickCheck: quickCheckOf(db),
      schemaVersion: userVersionOf(db),
      bookCount: Number(db.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0),
    };
  } finally {
    db.close();
  }
}

/**
 * 回滚：先删 -wal/-shm/-journal，再用同目录 rename 原子替换。
 * 失败时不触碰 lo 活库（删边车是唯一的前置动作，且应用已关闭）。
 */
export function restoreDatabase({ dataDir, snapshot, bookId = null, expectCurrentPage = null }) {
  const inspected = inspectSnapshot(snapshot);
  if (inspected.quickCheck !== "ok") throw new Error("快照 quick_check 未通过（snapshot-corrupt）");
  if (inspected.schemaVersion < 1) throw new Error("快照 schema 非法（snapshot-schema-invalid）");

  const dbPath = path.join(dataDir, "library.db");
  fs.mkdirSync(dataDir, { recursive: true });
  const removedSidecars = [];
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.rmSync(sidecar, { force: true });
      removedSidecars.push(suffix.replace("-", ""));
    }
  }
  const staged = `${dbPath}.restore-${process.pid}-${Date.now()}`;
  fs.copyFileSync(snapshot, staged);
  try {
    fs.renameSync(staged, dbPath);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }

  const snapshotSha256 = sha256File(snapshot);
  const restoredSha256 = sha256File(dbPath);
  const db = openReadOnly(dbPath);
  try {
    const quickCheck = quickCheckOf(db);
    const schemaVersion = userVersionOf(db);
    const bookCount = Number(db.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0);
    let book = null;
    if (bookId) {
      book = readBookRow(db, bookId);
      if (!book) throw new Error("回滚后找不到目标书（book-missing）");
      if (book.format !== "pdf") throw new Error("回滚后目标书不是 PDF（book-format-changed）");
      if (expectCurrentPage !== null && book.currentPage !== Number(expectCurrentPage)) {
        throw new Error("回滚后阅读进度丢失（book-progress-changed）");
      }
    }
    return {
      snapshotSha256,
      restoredSha256,
      byteIdentical: snapshotSha256 === restoredSha256,
      quickCheck,
      schemaVersion,
      bookCount,
      removedSidecars,
      book,
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 旧版 .mrbackup 生成（PDF-1 之前形态）                               */
/* ------------------------------------------------------------------ */

function createLegacySchema(db) {
  db.exec(`
    CREATE TABLE books(
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
    CREATE TABLE reading_log(
      date TEXT NOT NULL,
      book_id TEXT NOT NULL DEFAULT '',
      pages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(date, book_id)
    );
    CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');
    CREATE TABLE online_filter_profiles(
      host TEXT PRIMARY KEY,
      main_selector TEXT,
      cdn_pattern TEXT,
      width_min INTEGER,
      width_max INTEGER,
      aspect_max REAL,
      uses INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE online_filter_rules(
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      action TEXT NOT NULL,
      source TEXT NOT NULL,
      pattern_json TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      hits INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 1;
  `);
}

/**
 * 生成合法的旧版备份：
 * - books 表**没有** format 列（PDF-1 之前的形态）；
 * - user_version = 1；
 * - manifest 是 camelCase 的 `format/schema/appVersion/createdAt/counts/excludes`，
 *   counts 必须与库内真实行数完全一致（backup.rs 会逐字段比对）。
 *
 * .cbz 书源必须是真实压缩包且位于应用数据目录之外：恢复时 backup.rs 会校验
 * 路径存在、是书源、且不在敏感目录内。
 */
export function buildLegacyBackup({ out, workDir }) {
  if (!out || !workDir) throw new Error("legacy-backup 需要 out 与 work-dir（missing-argument）");
  const resolvedWork = path.resolve(workDir);
  fs.mkdirSync(resolvedWork, { recursive: true });
  const bookPath = path.join(resolvedWork, "legacy-smoke.cbz");
  const cbz = writeStoredZip([{ name: "1.png", data: makePng(1) }]);
  fs.writeFileSync(bookPath, cbz);
  const bookId = bookIdForPath(bookPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-pdf-legacy-"));
  const dbPath = path.join(tempDir, "library.db");
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA journal_mode=DELETE");
      createLegacySchema(db);
      db.prepare(
        `INSERT INTO books(id, path, title, page_count, current_page, updated_at,
                           removed, scroll_pct, source_type, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, -1, 'local', '{}')`,
      ).run(
        bookId,
        bookPath,
        LEGACY_BOOK_TITLE,
        LEGACY_PAGE_COUNT,
        LEGACY_CURRENT_PAGE,
        "2026-01-02 03:04:05",
      );
      const insertLog = db.prepare(
        "INSERT INTO reading_log(date, book_id, pages) VALUES (?, ?, ?)",
      );
      for (const entry of LEGACY_READING_LOG) insertLog.run(entry.date, bookId, entry.pages);
      db.prepare("INSERT INTO settings(k, v) VALUES ('theme', 'light')").run();
    } finally {
      db.close();
    }

    const check = openReadOnly(dbPath);
    let counts;
    let quickCheck;
    let schemaVersion;
    let columns;
    try {
      counts = {
        books: Number(check.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0),
        readingDays: Number(check.prepare("SELECT COUNT(*) AS n FROM reading_log").get()?.n ?? 0),
        rules: Number(
          check.prepare("SELECT COUNT(*) AS n FROM online_filter_rules").get()?.n ?? 0,
        ),
        profiles: Number(
          check.prepare("SELECT COUNT(*) AS n FROM online_filter_profiles").get()?.n ?? 0,
        ),
      };
      quickCheck = quickCheckOf(check);
      schemaVersion = userVersionOf(check);
      columns = tableColumns(check, "books");
    } finally {
      check.close();
    }
    if (schemaVersion !== 1) throw new Error("旧版备份 user_version 必须是 1（legacy-schema）");
    if (columns.includes("format")) throw new Error("旧版备份 books 不得含 format 列（legacy-schema）");

    const manifest = {
      format: BACKUP_FORMAT,
      schema: BACKUP_SCHEMA,
      appVersion: LEGACY_APP_VERSION,
      createdAt: "2026-01-02 03:04:05",
      counts,
      excludes: BACKUP_EXCLUDES,
    };
    const archive = writeStoredZip([
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
      { name: "library.db", data: fs.readFileSync(dbPath) },
    ]);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, archive);
    return {
      bookId,
      manifest,
      quickCheck,
      schemaVersion,
      bookColumnsHaveFormat: columns.includes("format"),
      pageCount: LEGACY_PAGE_COUNT,
      currentPage: LEGACY_CURRENT_PAGE,
      readingLogRows: LEGACY_READING_LOG.length,
      readingLogPages: LEGACY_READING_LOG.reduce((sum, entry) => sum + entry.pages, 0),
      sha256: sha256Bytes(archive),
      bytes: archive.length,
      outName: path.basename(out),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* CDP / 阅读器交互                                                    */
/* ------------------------------------------------------------------ */

async function connectRelease(port, timeoutMs = 90_000) {
  const target = await waitForTarget(port, isMainTarget, { timeout: timeoutMs });
  const page = await CdpPage.connect(target, port);
  await waitForApp(page, Math.min(timeoutMs, 60_000));
  return page;
}

function privacyAckToken(appVersion = null) {
  try {
    const dialog = fs.readFileSync(
      path.join(REPO_ROOT, "src", "components", "privacy", "PrivacyDialog.tsx"),
      "utf8",
    );
    const version = dialog.match(/PRIVACY_POLICY_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? "2026-10";
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const reported = appVersion || String(pkg.version);
    return `${version}:${reported.split(".")[0] || "0"}`;
  } catch {
    return `2026-10:${String(appVersion || "0").split(".")[0] || "0"}`;
  }
}

/**
 * 首次运行的数据边界声明是模态层：同一次运行里先写入产品自己的确认标记再重载，
 * 避免后续真实点击被遮挡（与 tests/qa/lib/app.mjs 的既有做法一致）。
 * 主版本取自**运行中的应用**（get_app_info），不假定仓库 package.json 与安装包一致。
 */
async function acknowledgePrivacy(page, port) {
  const info = await invokeSafe(page, "get_app_info");
  const appVersion = info.ok && info.value?.version ? String(info.value.version) : null;
  const token = privacyAckToken(appVersion || null);
  const needed = await page
    .eval(`localStorage.getItem("mr-privacy-ack") !== ${JSON.stringify(token)}`)
    .catch(() => false);
  if (!needed) return page;
  await page.eval(
    `(() => { localStorage.setItem("mr-privacy-ack", ${JSON.stringify(token)}); return true; })()`,
  );
  await page.eval("setTimeout(() => location.reload(), 60); true");
  await sleep(1200);
  await page.close().catch(() => {});
  return connectRelease(port);
}

async function focusBody(page) {
  await page
    .eval(
      `(() => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        if (document.body && document.body.focus) document.body.focus();
        return true;
      })()`,
    )
    .catch(() => {});
}

async function nextKey(page) {
  const dir = await page.eval(`localStorage.getItem("mr-reader-dir") || "rtl"`);
  return dir === "ltr" ? "ArrowRight" : "ArrowLeft";
}

async function readerState(page) {
  return page.eval(`(() => {
    const imgs = [...document.querySelectorAll("img.reader-img[data-idx]")];
    const errorCard = document.querySelector(".reader-err[data-error-code]");
    let label = null;
    for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) { label = text; break; }
    }
    const pages = document.querySelector(".reader-pages");
    return {
      root: !!document.querySelector(".reader-root"),
      loaded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
      indexes: imgs.map((img) => Number(img.getAttribute("data-idx"))),
      label,
      errorCode: errorCard ? errorCard.getAttribute("data-error-code") : null,
      pageFailures: document.querySelectorAll(".reader-cell .reader-err").length,
      transform: pages ? (pages.style.transform || "") : "",
    };
  })()`);
}

/**
 * 非空白像素断言：把已解码的阅读页画到 48x48 画布上，要求亮度动态范围 > 8。
 * 纯白 / 纯黑 / 未绘制都会得到 min == max，因此这是「真的画出来了」的证据。
 */
async function pixelProbe(page) {
  return page.eval(`(() => {
    try {
      const img = document.querySelector("img.reader-img[data-idx]");
      if (!img || !img.complete || img.naturalWidth === 0) {
        return { ok: false, reason: "image-not-decoded" };
      }
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 48;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { ok: false, reason: "canvas-unavailable" };
      ctx.drawImage(img, 0, 0, 48, 48);
      const data = ctx.getImageData(0, 0, 48, 48).data;
      let min = 255;
      let max = 0;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (value < min) min = value;
        if (value > max) max = value;
        sum += value;
      }
      return {
        ok: max - min > 8,
        reason: max - min > 8 ? null : "blank",
        min: Math.round(min),
        max: Math.round(max),
        mean: Math.round(sum / (data.length / 4)),
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    } catch {
      return { ok: false, reason: "canvas-tainted" };
    }
  })()`);
}

async function waitForDecodedPage(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let state = null;
  let probe = null;
  while (Date.now() < deadline) {
    state = await readerState(page);
    if (state.errorCode) {
      return { ok: false, reason: `reader-error:${state.errorCode}`, state, probe };
    }
    if (state.loaded > 0) {
      probe = await pixelProbe(page);
      if (probe.ok) return { ok: true, state, probe };
    }
    await sleep(250);
  }
  return { ok: false, reason: state?.loaded ? "blank" : "not-rendered", state, probe };
}

function pageNumbers(label) {
  const match = String(label || "").match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { page: Number(match[1]), total: Number(match[2]) } : null;
}

async function openReader(page, bookId, timeout = 30_000) {
  await page.eval(
    `location.hash = ${JSON.stringify(`#/reader/${encodeURIComponent(bookId)}`)}; true`,
  );
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.eval("!!document.querySelector('.reader-root')").catch(() => false)) {
      await sleep(300);
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForReaderPage(page, target, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await readerState(page);
    const counter = pageNumbers(state.label);
    if (counter?.page === target && state.loaded > 0) return state;
    await sleep(200);
  }
  return state ?? (await readerState(page));
}

async function waitForStoredPage(page, bookId, expected, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await invokeSafe(page, "get_book", { bookId });
    last = probe.ok ? Number(probe.value?.currentPage ?? -1) : -1;
    if (last === expected) return last;
    await sleep(300);
  }
  return last;
}

async function waitForPageCount(page, bookId, expected, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await invokeSafe(page, "get_book", { bookId });
    last = probe.ok ? Number(probe.value?.pageCount ?? -1) : -1;
    if (last === expected) return last;
    await sleep(300);
  }
  return last;
}

/**
 * 唤醒阅读器 HUD（真实指针移动）。
 *
 * HUD 会在数秒无操作后隐藏（`hidden` 属性 → display:none），此时
 * `CdpPage.click` 的可见性判定会拒绝点击。翻页后等落库可能超过隐藏窗口，
 * 因此缩放前必须先移动指针并等按钮真正可见。
 */
async function wakeReaderHud(page, timeout = 5_000) {
  await page
    .send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 320, y: 240, button: "none", buttons: 0 })
    .catch(() => {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visible = await page
      .eval(`(() => {
        const button = document.querySelector('[data-testid="reader-zoom-in"]');
        if (!button) return false;
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`)
      .catch(() => false);
    if (visible) return true;
    await sleep(150);
  }
  return false;
}

async function waitForZoom(page, expected, timeout = 10_000) {
  const pattern = new RegExp(`scale\\(${String(expected).replace(".", "\\.")}\\)`);
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.eval(`(() => {
      const pages = document.querySelector(".reader-pages");
      let zoomText = null;
      for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
        const text = (el.textContent || "").trim();
        if (/^\\d+%$/.test(text)) { zoomText = text; break; }
      }
      return {
        transform: pages ? (pages.style.transform || "") : "",
        zoomText,
        zoomInVisible: !!document.querySelector('[data-testid="reader-zoom-in"]'),
      };
    })()`);
    if (pattern.test(last.transform)) return { ok: true, ...last };
    await sleep(150);
  }
  return { ok: false, ...(last ?? { transform: "", zoomText: null }) };
}

async function scrollCoverCardIntoView(page, titleFragment, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page
      .eval(`(() => {
        const cards = [...document.querySelectorAll('[role="button"]')];
        const card = cards.find((el) =>
          ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).includes(${JSON.stringify(titleFragment)}),
        );
        if (!card) return false;
        card.scrollIntoView({ block: "center" });
        return true;
      })()`)
      .catch(() => false);
    if (found) return true;
    await sleep(250);
  }
  return false;
}

/**
 * 书库封面三连断言：DOM `<img src="data:image/...">`、`get_thumbnail` 可回读、
 * 磁盘缓存文件是合法 JPEG。三者缺一不可（不能只凭其中一项就认为封面可用）。
 */
async function waitForCover(page, { bookId, titleFragment, renderCacheDir, timeout = 45_000 }) {
  const deadline = Date.now() + timeout;
  let domOk = false;
  let ipcOk = false;
  let cache = { problems: ["cover-cache-missing"] };
  while (Date.now() < deadline) {
    if (!domOk) {
      domOk = await page
        .eval(`(() => {
          const cards = [...document.querySelectorAll('[role="button"]')];
          const card = cards.find((el) =>
            ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).includes(${JSON.stringify(titleFragment)}),
          );
          if (!card) return false;
          const img = card.querySelector("img");
          const src = img ? String(img.getAttribute("src") || "") : "";
          return src.startsWith("data:image/");
        })()`)
        .catch(() => false);
    }
    if (!ipcOk) {
      const thumb = await invokeSafe(page, "get_thumbnail", { bookId, maxSize: 256 });
      ipcOk = Boolean(
        thumb.ok && typeof thumb.value?.dataUrl === "string" && thumb.value.dataUrl.startsWith("data:image/"),
      );
    }
    cache = coverCacheState(renderCacheDir, bookId);
    if (domOk && ipcOk && cache.problems.length === 0) break;
    await sleep(400);
  }
  return { domOk, ipcOk, cache };
}

/* ------------------------------------------------------------------ */
/* 子命令                                                              */
/* ------------------------------------------------------------------ */

async function cmdUi(args) {
  const port = numberArg(args.port, 9333);
  const workDir = args["data-dir"] || args["work-dir"];
  const renderCacheDir = args["render-cache"];
  const evidencePath = args.out;
  const result = {
    command: "ui",
    problems: [],
    bookId: null,
    format: null,
    pageCount: 0,
    readerPage: null,
    /** 落库的阅读进度（0 基，与 list_books.currentPage 同一语义）。 */
    currentPage: null,
    storedCurrentPage: null,
    zoom: null,
    zoomText: null,
    pixelProbe: null,
    coverDomOk: false,
    coverIpcOk: false,
    coverSha256: null,
    coverBytes: null,
    coverWidth: null,
    coverHeight: null,
  };
  if (!workDir || workDir === true) return usageError(result, evidencePath, "missing-data-dir");
  if (!renderCacheDir || renderCacheDir === true) {
    return usageError(result, evidencePath, "missing-render-cache");
  }
  let page = null;
  try {
    const fixtureDir = path.resolve(workDir, "pdf-fixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    const pdfPath = path.join(fixtureDir, "release-smoke.pdf");
    fs.writeFileSync(pdfPath, makePdf({ pageCount: PDF_PAGE_COUNT, label: "Release Smoke PDF" }));
    const expectedId = bookIdForPath(pdfPath);

    page = await connectRelease(port);
    page = await acknowledgePrivacy(page, port);

    const imported = await invoke(page, "import_books", { paths: [pdfPath] });
    const items = Array.isArray(imported?.items) ? imported.items : [];
    const item = items.find((entry) => entry?.book?.id === expectedId) ?? items[0] ?? null;
    const book = item?.book ?? null;
    if (!book) {
      result.problems.push("import-failed");
      return emit(result, evidencePath);
    }
    result.bookId = book.id;
    result.format = book.format ?? null;
    if (book.id !== expectedId) result.problems.push("book-id-not-sha256-path");
    if (book.format !== "pdf") result.problems.push(`format-not-pdf:${String(book.format)}`);

    if (!(await openReader(page, book.id))) {
      result.problems.push("reader-root-missing");
      return emit(result, evidencePath);
    }
    const decoded = await waitForDecodedPage(page, 40_000);
    result.pixelProbe = decoded.probe ?? null;
    if (!decoded.ok) result.problems.push(`render:${decoded.reason}`);

    const counted = await waitForPageCount(page, book.id, PDF_PAGE_COUNT, 20_000);
    result.pageCount = counted;
    if (counted !== PDF_PAGE_COUNT) result.problems.push(`page-count:${String(counted)}`);

    const first = await readerState(page);
    if (pageNumbers(first.label)?.page !== 1) {
      result.problems.push(`start-page:${String(first.label)}`);
    }

    // 真键盘翻页：第 1 页 → 第 3 页（方向随 mr-reader-dir）。
    await focusBody(page);
    const forward = await nextKey(page);
    await page.key(forward);
    await sleep(350);
    await page.key(forward);
    const third = await waitForReaderPage(page, TARGET_READER_PAGE, 20_000);
    result.readerPage = pageNumbers(third.label)?.page ?? null;
    if (result.readerPage !== TARGET_READER_PAGE) {
      result.problems.push(`page-nav:${String(third.label)}`);
    }
    if (!third.indexes.includes(TARGET_READER_PAGE - 1)) {
      result.problems.push("page3-not-rendered");
    }
    const thirdProbe = await pixelProbe(page);
    if (!thirdProbe.ok) result.problems.push(`page3:${thirdProbe.reason ?? "blank"}`);

    // 进度必须先落库（500ms 防抖），否则后续进程重启断言没有意义。
    const stored = await waitForStoredPage(page, book.id, TARGET_READER_PAGE - 1, 8_000);
    result.storedCurrentPage = stored;
    result.currentPage = stored;
    if (stored !== TARGET_READER_PAGE - 1) {
      result.problems.push(`progress:${String(stored)}`);
    }

    // 真实按钮缩放：HUD 的 zoom-in 每次 +25%。
    if (!(await wakeReaderHud(page))) {
      result.problems.push("zoom-button-hidden");
    } else {
      await page.click('[data-testid="reader-zoom-in"]');
    }
    const zoomed = await waitForZoom(page, 1.25, 10_000);
    result.zoom = zoomed.ok ? 1.25 : null;
    result.zoomText = zoomed.zoomText ?? null;
    if (!zoomed.ok) result.problems.push("zoom-not-applied");
    if (zoomed.zoomText && zoomed.zoomText !== "125%") {
      result.problems.push(`zoom-hud:${zoomed.zoomText}`);
    }

    // 书库封面：PDF 没有首页图，封面由前端渲染首页后经 put_pdf_thumbnail 落盘。
    await page.eval(`location.hash = "#/"; true`);
    await page
      .waitFor("!!document.querySelector('main')", { timeout: 15_000, label: "library shell" })
      .catch(() => {});
    const cardVisible = await scrollCoverCardIntoView(page, PDF_TITLE_FRAGMENT);
    if (!cardVisible) result.problems.push("cover-card-missing");
    const cover = await waitForCover(page, {
      bookId: book.id,
      titleFragment: PDF_TITLE_FRAGMENT,
      renderCacheDir: path.resolve(renderCacheDir),
      timeout: 45_000,
    });
    result.coverDomOk = cover.domOk;
    result.coverIpcOk = cover.ipcOk;
    result.coverSha256 = cover.cache.sha256 ?? null;
    result.coverBytes = cover.cache.bytes ?? null;
    result.coverWidth = cover.cache.width ?? null;
    result.coverHeight = cover.cache.height ?? null;
    if (!cover.domOk) result.problems.push("cover-dom-missing");
    if (!cover.ipcOk) result.problems.push("cover-ipc-missing");
    for (const problem of cover.cache.problems) result.problems.push(problem);
  } catch (error) {
    result.problems.push(`ui-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
  }
  return emit(result, evidencePath);
}

async function cmdDb(args) {
  const dataDir = args["data-dir"];
  const bookId = args["book-id"];
  const evidencePath = args.out;
  const expectPage = numberArg(args["expect-page"], TARGET_READER_PAGE);
  const expectCount = numberArg(args["expect-count"], PDF_PAGE_COUNT);
  const renderCacheDir = args["render-cache"] || path.join(String(dataDir || ""), "render_cache");
  const result = {
    command: "db",
    problems: [],
    bookId: bookId ?? null,
    format: null,
    pageCount: null,
    storedCurrentPage: null,
    readerPage: expectPage,
    schemaVersion: null,
    quickCheck: null,
    readingLogRows: null,
    readingLogPages: null,
    coverSha256: null,
    coverBytes: null,
    coverWidth: null,
    coverHeight: null,
  };
  if (!dataDir || dataDir === true) return usageError(result, evidencePath, "missing-data-dir");
  if (!bookId || bookId === true) return usageError(result, evidencePath, "missing-book-id");
  const dbPath = path.join(String(dataDir), "library.db");
  if (!fs.existsSync(dbPath)) return usageError(result, evidencePath, "db-missing");
  let db = null;
  try {
    db = openReadOnly(dbPath);
    result.quickCheck = quickCheckOf(db);
    if (result.quickCheck !== "ok") result.problems.push(`quick-check:${result.quickCheck}`);
    result.schemaVersion = userVersionOf(db);
    if (result.schemaVersion !== SCHEMA_VERSION) {
      result.problems.push(`schema-version:${result.schemaVersion}`);
    }
    const book = readBookRow(db, bookId);
    if (!book) {
      result.problems.push("book-missing");
    } else {
      result.format = book.format;
      result.pageCount = book.pageCount;
      result.storedCurrentPage = book.currentPage;
      if (!book.hasFormatColumn) result.problems.push("format-column-missing");
      if (book.format !== "pdf") result.problems.push(`format:${book.format}`);
      if (book.pageCount !== expectCount) result.problems.push(`page-count:${book.pageCount}`);
      // --expect-page 是阅读器 1 基页码；落库是 0 基（产品既有坐标系）。
      if (book.currentPage !== expectPage - 1) {
        result.problems.push(`current-page:${book.currentPage}`);
      }
      const log = readingLogOf(db, bookId);
      result.readingLogRows = log.rows;
      result.readingLogPages = log.pages;
      if (log.rows < 1 || log.pages < 1) result.problems.push("reading-log-empty");
    }
    for (const problem of liveCredentialProblems(db)) result.problems.push(problem);
  } catch (error) {
    result.problems.push(`db-read-failed:${safeErrorCode(error)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  try {
    const cover = coverCacheState(renderCacheDir, bookId);
    result.coverSha256 = cover.sha256;
    result.coverBytes = cover.bytes;
    result.coverWidth = cover.width;
    result.coverHeight = cover.height;
    for (const problem of cover.problems) result.problems.push(problem);
  } catch (error) {
    result.problems.push(`cover-read-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdRestart(args) {
  const port = numberArg(args.port, 9333);
  const bookId = args["book-id"];
  const expectPage = numberArg(args["expect-page"], TARGET_READER_PAGE);
  const evidencePath = args.out;
  const result = {
    command: "restart",
    problems: [],
    bookId: bookId ?? null,
    format: null,
    pageCount: null,
    storedCurrentPage: null,
    readerPage: null,
    pixelProbe: null,
  };
  if (!bookId || bookId === true) return usageError(result, evidencePath, "missing-book-id");
  let page = null;
  try {
    page = await connectRelease(port);
    page = await acknowledgePrivacy(page, port);

    const book = await invoke(page, "get_book", { bookId });
    result.format = book?.format ?? null;
    result.pageCount = Number(book?.pageCount ?? -1);
    result.storedCurrentPage = Number(book?.currentPage ?? -1);
    if (result.format !== "pdf") result.problems.push(`format:${String(result.format)}`);
    if (result.pageCount !== PDF_PAGE_COUNT) result.problems.push(`page-count:${result.pageCount}`);
    if (result.storedCurrentPage !== expectPage - 1) {
      result.problems.push(`stored-page:${result.storedCurrentPage}`);
    }

    if (!(await openReader(page, bookId))) {
      result.problems.push("reader-root-missing");
      return emit(result, evidencePath);
    }
    const decoded = await waitForDecodedPage(page, 40_000);
    result.pixelProbe = decoded.probe ?? null;
    if (!decoded.ok) result.problems.push(`render:${decoded.reason}`);
    const restored = await waitForReaderPage(page, expectPage, 20_000);
    result.readerPage = pageNumbers(restored.label)?.page ?? null;
    if (result.readerPage !== expectPage) result.problems.push(`restored-page:${String(restored.label)}`);
  } catch (error) {
    result.problems.push(`restart-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
  }
  return emit(result, evidencePath);
}

async function cmdBackupExport(args) {
  const port = numberArg(args.port, 9333);
  const dest = args.dest;
  const bookId = args["book-id"] || null;
  const expectedPage = numberArg(args["expect-page"], TARGET_READER_PAGE) - 1;
  const evidencePath = args.out;
  const result = {
    command: "backup-export",
    problems: [],
    entryNames: [],
    manifestFormat: null,
    manifestSchema: null,
    manifestCounts: null,
    bookId: bookId,
    format: null,
    storedCurrentPage: null,
    pageCount: null,
    snapshotSha256: null,
    snapshotBytes: null,
    snapshotQuickCheck: null,
    snapshotSchemaVersion: null,
  };
  if (!dest || dest === true) return usageError(result, evidencePath, "missing-dest");
  let page = null;
  let tempDir = null;
  try {
    page = await connectRelease(port);
    page = await acknowledgePrivacy(page, port);
    const exported = await invoke(page, "export_backup", { destPath: dest, preferencesJson: null });
    result.snapshotBytes = Number(exported?.bytes ?? 0);
    const archive = fs.readFileSync(dest);
    const entries = readZipEntries(archive);
    result.entryNames = [...entries.keys()].sort();
    for (const name of ["manifest.json", "library.db"]) {
      if (!entries.has(name)) result.problems.push(`missing-entry:${name}`);
    }
    const unexpected = result.entryNames.filter(
      (name) => !["manifest.json", "library.db", "preferences.json"].includes(name),
    );
    for (const name of unexpected) result.problems.push(`unexpected-entry:${name}`);
    if (result.problems.length === 0) {
      const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
      result.manifestFormat = manifest.format ?? null;
      result.manifestSchema = Number(manifest.schema ?? 0);
      result.manifestCounts = manifest.counts ?? null;
      if (manifest.format !== BACKUP_FORMAT) result.problems.push("manifest-format");
      if (!(Number(manifest.schema) >= BACKUP_SCHEMA)) result.problems.push("manifest-schema");
      if (!Array.isArray(manifest.excludes) || !manifest.excludes.includes("online_headers")) {
        result.problems.push("manifest-excludes");
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-pdf-backup-"));
      const snapshotPath = path.join(tempDir, "library.db");
      fs.writeFileSync(snapshotPath, entries.get("library.db"));
      result.snapshotSha256 = sha256File(snapshotPath);
      const db = openReadOnly(snapshotPath);
      try {
        result.snapshotQuickCheck = quickCheckOf(db);
        result.snapshotSchemaVersion = userVersionOf(db);
        if (result.snapshotQuickCheck !== "ok") result.problems.push("snapshot-quick-check");
        if (result.snapshotSchemaVersion !== SCHEMA_VERSION) result.problems.push("snapshot-schema");
        const booksCount = Number(db.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0);
        if (Number(manifest.counts?.books ?? -1) !== booksCount) {
          result.problems.push("manifest-counts");
        }
        const targetId =
          bookId ?? db.prepare("SELECT id FROM books WHERE format = 'pdf' LIMIT 1").get()?.id ?? null;
        const book = targetId ? readBookRow(db, String(targetId)) : null;
        if (!book) {
          result.problems.push("snapshot-pdf-book-missing");
        } else {
          result.bookId = book.id;
          result.format = book.format;
          result.storedCurrentPage = book.currentPage;
          result.pageCount = book.pageCount;
          if (book.format !== "pdf") result.problems.push(`format:${book.format}`);
          if (book.currentPage !== expectedPage) {
            result.problems.push(`current-page:${book.currentPage}`);
          }
          if (book.pageCount !== PDF_PAGE_COUNT) result.problems.push(`page-count:${book.pageCount}`);
        }
      } finally {
        db.close();
      }
      for (const problem of snapshotCredentialProblems(snapshotPath)) {
        result.problems.push(problem);
      }
    }
  } catch (error) {
    result.problems.push(`backup-export-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return emit(result, evidencePath);
}

async function cmdBackupRestore(args) {
  const port = numberArg(args.port, 9333);
  const dataDir = args["data-dir"];
  const source = args.source;
  const expectedBookId = args["expect-book-id"];
  const expectedPage = numberArg(args["expect-current-page"], TARGET_READER_PAGE - 1);
  const evidencePath = args.out;
  const result = {
    command: "backup-restore",
    problems: [],
    bookId: expectedBookId ?? null,
    format: null,
    pageCount: null,
    storedCurrentPage: null,
    bookCount: null,
    schemaVersion: null,
    quickCheck: null,
    importedBooks: null,
    readingDays: null,
  };
  if (!dataDir || dataDir === true) return usageError(result, evidencePath, "missing-data-dir");
  if (!source || source === true) return usageError(result, evidencePath, "missing-source");
  if (!expectedBookId || expectedBookId === true) {
    return usageError(result, evidencePath, "missing-expect-book-id");
  }
  let page = null;
  try {
    page = await connectRelease(port);
    page = await acknowledgePrivacy(page, port);
    const restored = await invoke(page, "import_backup", { sourcePath: source });
    result.importedBooks = Number(restored?.books ?? 0);
    result.readingDays = Number(restored?.readingDays ?? 0);
    const books = await invoke(page, "list_books", { query: null });
    const list = Array.isArray(books) ? books : [];
    result.bookCount = list.length;
    const book = list.find((entry) => entry?.id === expectedBookId);
    if (!book) {
      result.problems.push("book-missing");
    } else {
      result.format = book.format ?? null;
      result.pageCount = Number(book.pageCount ?? 0);
      result.storedCurrentPage = Number(book.currentPage ?? -1);
      if (book.format !== "pdf") result.problems.push(`format:${String(book.format)}`);
      if (result.pageCount !== PDF_PAGE_COUNT) result.problems.push(`page-count:${result.pageCount}`);
      if (result.storedCurrentPage !== expectedPage) {
        result.problems.push(`current-page:${result.storedCurrentPage}`);
      }
    }
  } catch (error) {
    result.problems.push(`backup-restore-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
  }
  try {
    const db = openReadOnly(path.join(String(dataDir), "library.db"));
    try {
      result.quickCheck = quickCheckOf(db);
      result.schemaVersion = userVersionOf(db);
      if (result.quickCheck !== "ok") result.problems.push("quick-check");
      if (result.schemaVersion !== SCHEMA_VERSION) result.problems.push("schema-version");
    } finally {
      db.close();
    }
  } catch (error) {
    result.problems.push(`db-read-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdLegacyBackup(args) {
  const evidencePath = args.evidence;
  const result = { command: "legacy-backup", problems: [] };
  if (!args.out || args.out === true) return usageError(result, evidencePath, "missing-out");
  if (!args["work-dir"] || args["work-dir"] === true) {
    return usageError(result, evidencePath, "missing-work-dir");
  }
  try {
    const built = buildLegacyBackup({ out: args.out, workDir: args["work-dir"] });
    Object.assign(result, built);
    if (built.quickCheck !== "ok") result.problems.push(`quick-check:${built.quickCheck}`);
    if (built.schemaVersion !== 1) result.problems.push(`schema-version:${built.schemaVersion}`);
    if (built.bookColumnsHaveFormat) result.problems.push("legacy-format-column-present");
    // 生成物必须能按 backup.rs 的契约读回（zip 结构 + CRC + 清单计数）。
    const entries = readZipEntries(fs.readFileSync(args.out));
    if (!entries.has("manifest.json") || !entries.has("library.db")) {
      result.problems.push("legacy-archive-entries");
    }
    if (result.problems.length === 0) {
      const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
      if (manifest.format !== BACKUP_FORMAT) result.problems.push("legacy-manifest-format");
      if (Number(manifest.schema) !== BACKUP_SCHEMA) result.problems.push("legacy-manifest-schema");
      if (Number(manifest.counts?.books ?? -1) !== 1) result.problems.push("legacy-manifest-books");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-pdf-legacy-verify-"));
      try {
        const snapshotPath = path.join(tempDir, "library.db");
        fs.writeFileSync(snapshotPath, entries.get("library.db"));
        const db = openReadOnly(snapshotPath);
        try {
          if (tableColumns(db, "books").includes("format")) {
            result.problems.push("legacy-format-column-present");
          }
          if (quickCheckOf(db) !== "ok") result.problems.push("legacy-quick-check");
          if (userVersionOf(db) !== 1) result.problems.push("legacy-user-version");
          const book = readBookRow(db, built.bookId);
          if (!book) result.problems.push("legacy-book-missing");
          else if (book.currentPage !== LEGACY_CURRENT_PAGE) result.problems.push("legacy-progress");
        } finally {
          db.close();
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    result.problems.push(`legacy-backup-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdVerifyLegacy(args) {
  const port = numberArg(args.port, 9333);
  const dataDir = args["data-dir"];
  const source = args.source;
  const bookId = args["book-id"];
  const expectedPage = numberArg(args["expect-current-page"], LEGACY_CURRENT_PAGE);
  const expectedCount = numberArg(args["expect-count"], LEGACY_PAGE_COUNT);
  const evidencePath = args.out;
  const result = {
    command: "verify-legacy",
    problems: [],
    bookId: bookId ?? null,
    format: null,
    pageCount: null,
    storedCurrentPage: null,
    schemaVersion: null,
    quickCheck: null,
    formatColumnPresent: null,
    readingLogRows: null,
    readingLogPages: null,
    theme: null,
    skippedBooks: null,
  };
  if (!dataDir || dataDir === true) return usageError(result, evidencePath, "missing-data-dir");
  if (!source || source === true) return usageError(result, evidencePath, "missing-source");
  if (!bookId || bookId === true) return usageError(result, evidencePath, "missing-book-id");
  let page = null;
  try {
    page = await connectRelease(port);
    page = await acknowledgePrivacy(page, port);
    const restored = await invoke(page, "import_backup", { sourcePath: source });
    result.skippedBooks = Array.isArray(restored?.skippedBooks) ? restored.skippedBooks.length : null;
    if (result.skippedBooks !== 0) result.problems.push(`skipped-books:${result.skippedBooks}`);
    const books = await invoke(page, "list_books", { query: null });
    const list = Array.isArray(books) ? books : [];
    const book = list.find((entry) => entry?.id === bookId);
    if (!book) {
      result.problems.push("book-missing");
    } else {
      result.format = book.format ?? null;
      result.pageCount = Number(book.pageCount ?? 0);
      result.storedCurrentPage = Number(book.currentPage ?? -1);
      // 旧备份没有 format 列：恢复后必须落到活库默认值 image。
      if (book.format !== "image") result.problems.push(`format:${String(book.format)}`);
      if (result.pageCount !== expectedCount) result.problems.push(`page-count:${result.pageCount}`);
      if (result.storedCurrentPage !== expectedPage) {
        result.problems.push(`current-page:${result.storedCurrentPage}`);
      }
    }
  } catch (error) {
    result.problems.push(`verify-legacy-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
  }
  try {
    const db = openReadOnly(path.join(String(dataDir), "library.db"));
    try {
      result.quickCheck = quickCheckOf(db);
      result.schemaVersion = userVersionOf(db);
      result.formatColumnPresent = tableColumns(db, "books").includes("format");
      if (result.quickCheck !== "ok") result.problems.push("quick-check");
      if (result.schemaVersion !== SCHEMA_VERSION) {
        result.problems.push(`schema-version:${result.schemaVersion}`);
      }
      if (!result.formatColumnPresent) result.problems.push("format-column-missing");
      const log = readingLogOf(db, bookId);
      result.readingLogRows = log.rows;
      result.readingLogPages = log.pages;
      if (log.rows !== LEGACY_READING_LOG.length) result.problems.push(`reading-log-rows:${log.rows}`);
      const expectedPages = LEGACY_READING_LOG.reduce((sum, entry) => sum + entry.pages, 0);
      if (log.pages !== expectedPages) result.problems.push(`reading-log-pages:${log.pages}`);
      const theme = db.prepare("SELECT v FROM settings WHERE k = 'theme'").get();
      result.theme = theme ? String(theme.v) : null;
      if (result.theme !== "light") result.problems.push("settings-not-restored");
    } finally {
      db.close();
    }
  } catch (error) {
    result.problems.push(`db-read-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdDbSnapshot(args) {
  const evidencePath = args.evidence;
  const result = { command: "db-snapshot", problems: [] };
  if (!args["data-dir"] || args["data-dir"] === true) {
    return usageError(result, evidencePath, "missing-data-dir");
  }
  if (!args.out || args.out === true) return usageError(result, evidencePath, "missing-out");
  try {
    const snapshot = snapshotDatabase({ dataDir: args["data-dir"], out: args.out });
    Object.assign(result, snapshot);
    if (snapshot.quickCheck !== "ok") result.problems.push(`quick-check:${snapshot.quickCheck}`);
    if (snapshot.schemaVersion !== SCHEMA_VERSION) {
      result.problems.push(`schema-version:${snapshot.schemaVersion}`);
    }
    if (!(snapshot.bookCount >= 1)) result.problems.push("book-count");
  } catch (error) {
    result.problems.push(`db-snapshot-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdDbRestore(args) {
  const evidencePath = args.evidence;
  const result = { command: "db-restore", problems: [] };
  if (!args["data-dir"] || args["data-dir"] === true) {
    return usageError(result, evidencePath, "missing-data-dir");
  }
  if (!args.snapshot || args.snapshot === true) {
    return usageError(result, evidencePath, "missing-snapshot");
  }
  try {
    const restored = restoreDatabase({
      dataDir: args["data-dir"],
      snapshot: args.snapshot,
      bookId: args["book-id"] || null,
      expectCurrentPage: args["expect-current-page"] ? Number(args["expect-current-page"]) : null,
    });
    Object.assign(result, restored);
    if (!restored.byteIdentical) result.problems.push("byte-integrity");
    if (restored.quickCheck !== "ok") result.problems.push(`quick-check:${restored.quickCheck}`);
    if (restored.schemaVersion !== SCHEMA_VERSION) {
      result.problems.push(`schema-version:${restored.schemaVersion}`);
    }
  } catch (error) {
    result.problems.push(`db-restore-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

async function cmdRollbackCompat(args) {
  const port = numberArg(args.port, 9333);
  const dataDir = args["data-dir"];
  const evidencePath = args.out;
  const result = {
    command: "rollback-compat",
    problems: [],
    bookCount: null,
    pdfBooks: null,
    schemaVersion: null,
    quickCheck: null,
    listBooksThrew: false,
  };
  if (!dataDir || dataDir === true) return usageError(result, evidencePath, "missing-data-dir");
  let page = null;
  try {
    page = await connectRelease(port, 90_000);
    const probe = await invokeSafe(page, "list_books", { query: null });
    if (!probe.ok) {
      result.listBooksThrew = true;
      result.problems.push(`list-books-threw:${safeErrorCode(probe.error)}`);
    } else if (!Array.isArray(probe.value)) {
      result.problems.push("list-books-not-array");
    } else {
      result.bookCount = probe.value.length;
      // 旧版本可能不认识 format 字段：只在存在该字段时统计。
      result.pdfBooks = probe.value.filter((entry) => entry?.format === "pdf").length;
    }
  } catch (error) {
    result.problems.push(`rollback-compat-failed:${safeErrorCode(error)}`);
  } finally {
    await page?.close().catch(() => {});
  }
  try {
    const db = openReadOnly(path.join(String(dataDir), "library.db"));
    try {
      result.quickCheck = quickCheckOf(db);
      result.schemaVersion = userVersionOf(db);
      // 旧版本绝不能把 v2 库降级：user_version 必须仍是 2。
      if (result.schemaVersion !== SCHEMA_VERSION) {
        result.problems.push(`schema-version:${result.schemaVersion}`);
      }
      if (result.quickCheck !== "ok") result.problems.push(`quick-check:${result.quickCheck}`);
    } finally {
      db.close();
    }
  } catch (error) {
    result.problems.push(`db-read-failed:${safeErrorCode(error)}`);
  }
  return emit(result, evidencePath);
}

/**
 * 证据形状契约：四项检查只允许 pass/fail，且 `pass` 必须来自实际通过的断言。
 * 安装脚本按同一规则组装 `checks.{pdfReading,progressRestart,backupRestore,databaseRollback}`。
 */
export function makePdfChecks(values = {}) {
  const checks = {};
  for (const key of PDF_CHECKS) checks[key] = values[key] === true ? "pass" : "fail";
  return checks;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case "ui":
      return cmdUi(args);
    case "db":
      return cmdDb(args);
    case "restart":
      return cmdRestart(args);
    case "backup-export":
      return cmdBackupExport(args);
    case "backup-restore":
      return cmdBackupRestore(args);
    case "legacy-backup":
      return cmdLegacyBackup(args);
    case "verify-legacy":
      return cmdVerifyLegacy(args);
    case "db-snapshot":
      return cmdDbSnapshot(args);
    case "db-restore":
      return cmdDbRestore(args);
    case "rollback-compat":
      return cmdRollbackCompat(args);
    default:
      console.error(
        "用法：pdf-release-check.mjs ui|db|restart|backup-export|backup-restore|legacy-backup|verify-legacy|db-snapshot|db-restore|rollback-compat …（见文件头）",
      );
      return 2;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  // 结果文件已写盘；显式退出，避免 CDP 句柄拖住安装脚本。
  process.exit(await main());
}
