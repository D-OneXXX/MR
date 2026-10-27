import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  CHANNEL_REQUIRED_CHECKS,
  INSTALL_EVIDENCE_KIND,
  validateInstallEvidence,
} from "../release-governance/evidence.mjs";
import {
  LEGACY_CURRENT_PAGE,
  LEGACY_PAGE_COUNT,
  LEGACY_READING_LOG,
  PDF_CHECKS,
  buildLegacyBackup,
  jpegDimensions,
  makePdfChecks,
  readZipEntries,
  restoreDatabase,
  snapshotCredentialProblems,
  snapshotDatabase,
} from "./pdf-release-check.mjs";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "pdf-release-check.mjs",
);

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mr-pdf-release-${label}-`));
}

function withDatabase(dbPath, fn, { readOnly = false } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** 应用 v2 形态的最小库（books 带 format 列，user_version=2）。 */
function createAppDb(dbPath, { pdfBook = true } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
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
        meta_json TEXT NOT NULL DEFAULT '{}',
        format TEXT NOT NULL DEFAULT 'image'
      );
      CREATE TABLE reading_log(
        date TEXT NOT NULL,
        book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
        pages INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_reading_log_book_date
        ON reading_log(date, COALESCE(book_id, ''));
      CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '');
      CREATE TABLE online_filter_profiles(
        host TEXT PRIMARY KEY, main_selector TEXT, cdn_pattern TEXT,
        width_min INTEGER, width_max INTEGER, aspect_max REAL,
        uses INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE online_filter_rules(
        id TEXT PRIMARY KEY, host TEXT NOT NULL, action TEXT NOT NULL,
        source TEXT NOT NULL, pattern_json TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
        hits INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 2;
    `);
    db.prepare("INSERT INTO settings(k, v) VALUES ('theme', 'light')").run();
    db.prepare(
      `INSERT INTO books(id, path, title, page_count, current_page, updated_at,
                         removed, scroll_pct, source_type, meta_json, format)
       VALUES ('pdf-book', '/books/release-smoke.pdf', 'Release Smoke PDF', 4, 2,
               '2026-01-02 00:00:00', 0, -1, 'local', '{}', 'pdf')`,
    ).run();
    db.prepare(
      "INSERT INTO reading_log(date, book_id, pages) VALUES ('2026-01-02', 'pdf-book', 3)",
    ).run();
    if (!pdfBook) {
      db.prepare(
        `INSERT INTO books(id, path, title, page_count, current_page, updated_at,
                           removed, scroll_pct, source_type, meta_json, format)
         VALUES ('img-book', '/books/one', 'Image Book', 10, 1,
                 '2026-01-02 00:00:00', 0, -1, 'local', '{}', 'image')`,
      ).run();
    }
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* a) 旧版 .mrbackup：真实 zip、books 无 format 列、manifest 合法       */
/* ------------------------------------------------------------------ */

test("legacy-backup：真实 zip + 旧 schema（无 format 列，user_version=1）", () => {
  const dir = tempDir("legacy");
  const out = path.join(dir, "legacy.mrbackup");
  const workDir = path.join(dir, "book-source");
  const built = buildLegacyBackup({ out, workDir });

  assert.match(built.bookId, /^[0-9a-f]{64}$/);
  assert.equal(built.schemaVersion, 1);
  assert.equal(built.quickCheck, "ok");
  assert.equal(built.bookColumnsHaveFormat, false);
  assert.equal(built.currentPage, LEGACY_CURRENT_PAGE);
  assert.equal(fs.existsSync(path.join(workDir, "legacy-smoke.cbz")), true);

  const entries = readZipEntries(fs.readFileSync(out));
  assert.deepEqual([...entries.keys()].sort(), ["library.db", "manifest.json"]);
  const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  assert.equal(manifest.format, "mangareader-backup");
  assert.equal(manifest.schema, 1);
  assert.match(manifest.appVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.counts, {
    books: 1,
    readingDays: LEGACY_READING_LOG.length,
    rules: 0,
    profiles: 0,
  });
  assert.ok(manifest.excludes.includes("online_headers"));

  const snapshotPath = path.join(dir, "embedded.db");
  fs.writeFileSync(snapshotPath, entries.get("library.db"));
  const snapshot = withDatabase(snapshotPath, (db) => {
    const columns = db
      .prepare("PRAGMA table_info(books)")
      .all()
      .map((row) => row.name);
    const quickCheck = db.prepare("PRAGMA quick_check").get().quick_check;
    const schema = db.prepare("PRAGMA user_version").get().user_version;
    const book = db
      .prepare("SELECT id, title, page_count, current_page FROM books")
      .get();
    const log = db
      .prepare("SELECT COUNT(*) AS rows, SUM(pages) AS pages FROM reading_log")
      .get();
    return { columns, quickCheck, schema, book, log };
  }, { readOnly: true });
  assert.equal(snapshot.columns.includes("format"), false, "旧备份不得含 format 列");
  assert.equal(String(snapshot.quickCheck).toLowerCase(), "ok");
  assert.equal(Number(snapshot.schema), 1);
  assert.equal(snapshot.book.id, built.bookId);
  assert.equal(Number(snapshot.book.page_count), LEGACY_PAGE_COUNT);
  assert.equal(Number(snapshot.book.current_page), LEGACY_CURRENT_PAGE);
  assert.equal(Number(snapshot.log.rows), LEGACY_READING_LOG.length);
  assert.equal(
    Number(snapshot.log.pages),
    LEGACY_READING_LOG.reduce((sum, entry) => sum + entry.pages, 0),
  );
});

/* ------------------------------------------------------------------ */
/* b) 快照 / 回滚：行与完整性逐字节保留，旧 -wal/-shm 被清理            */
/* ------------------------------------------------------------------ */

test("db-snapshot / db-restore：回滚保留行、进度与逐字节完整性", () => {
  const dir = tempDir("snapshot");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  createAppDb(path.join(dataDir, "library.db"));
  const snapshotPath = path.join(dir, "v2-snapshot.db");

  const snapshot = snapshotDatabase({ dataDir, out: snapshotPath });
  assert.equal(snapshot.quickCheck, "ok");
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.bookCount, 1);
  assert.match(snapshot.snapshotSha256, /^[0-9a-f]{64}$/);

  // 模拟回滚期间被旧版本改动/丢失数据，并留下陈旧的 WAL 边车。
  withDatabase(path.join(dataDir, "library.db"), (db) => {
    db.prepare("DELETE FROM books").run();
    db.prepare("DELETE FROM reading_log").run();
  });
  fs.writeFileSync(path.join(dataDir, "library.db-wal"), Buffer.from("stale-wal"));
  fs.writeFileSync(path.join(dataDir, "library.db-shm"), Buffer.from("stale-shm"));

  const restored = restoreDatabase({
    dataDir,
    snapshot: snapshotPath,
    bookId: "pdf-book",
    expectCurrentPage: 2,
  });
  assert.equal(restored.byteIdentical, true);
  assert.equal(restored.restoredSha256, snapshot.snapshotSha256);
  assert.equal(restored.quickCheck, "ok");
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.bookCount, 1);
  assert.equal(restored.book.format, "pdf");
  assert.equal(restored.book.currentPage, 2);
  assert.deepEqual(restored.removedSidecars, ["wal", "shm"]);
  assert.equal(fs.existsSync(path.join(dataDir, "library.db-wal")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "library.db-shm")), false);

  const row = withDatabase(
    path.join(dataDir, "library.db"),
    (db) => db.prepare("SELECT id, current_page FROM books").get(),
    { readOnly: true },
  );
  assert.equal(row.id, "pdf-book");
  assert.equal(Number(row.current_page), 2);
});

test("db-restore：快照损坏时拒绝回滚且不改动活库", () => {
  const dir = tempDir("snapshot-bad");
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  createAppDb(path.join(dataDir, "library.db"));
  const before = fs.readFileSync(path.join(dataDir, "library.db"));
  const broken = path.join(dir, "broken.db");
  fs.writeFileSync(broken, Buffer.from("not a sqlite database"));
  assert.throws(() => restoreDatabase({ dataDir, snapshot: broken }));
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "library.db")), before);
});

/* ------------------------------------------------------------------ */
/* c) 备份净化：残留 online_headers 必须被内容检查拒绝                  */
/* ------------------------------------------------------------------ */

test("备份内容检查：含 online_headers 的快照被拒绝，净化快照通过", () => {
  const dir = tempDir("credentials");
  const dirty = path.join(dir, "dirty.db");
  createAppDb(dirty);
  withDatabase(dirty, (db) => {
    db.exec(
      "CREATE TABLE online_filter_events(host TEXT, book_id TEXT, url TEXT, action TEXT, source TEXT)",
    );
    db.prepare("INSERT INTO settings(k, v) VALUES ('online_headers', 'Cookie: secret=1')").run();
    db.prepare("INSERT INTO settings(k, v) VALUES ('online_proxy', 'socks5://127.0.0.1:1')").run();
    db.prepare(
      "INSERT INTO online_filter_events(host, book_id, url, action, source) VALUES ('a', 'b', 'u', 'x', 'y')",
    ).run();
  });
  const dirtyProblems = snapshotCredentialProblems(dirty);
  assert.ok(dirtyProblems.some((problem) => problem.includes("online_headers")));
  assert.ok(dirtyProblems.some((problem) => problem.includes("online_proxy")));
  assert.ok(dirtyProblems.some((problem) => problem.includes("online_filter_events")));

  const clean = path.join(dir, "clean.db");
  createAppDb(clean);
  assert.deepEqual(snapshotCredentialProblems(clean), []);
});

/* ------------------------------------------------------------------ */
/* d) 证据形状：四项新检查进入 Windows 门禁                              */
/* ------------------------------------------------------------------ */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ARTIFACT_SHA = "a".repeat(64);
const PREVIOUS_SHA = "b".repeat(64);
const BOOK_ID = "1".repeat(64);

function makeInstallEvidence(checks) {
  return {
    kind: INSTALL_EVIDENCE_KIND,
    verdict: "PASS",
    version: "0.18.0",
    commit: COMMIT,
    platform: "windows-x86_64",
    artifactName: "MangaReader_0.18.0_x64-setup.exe",
    artifactSha256: ARTIFACT_SHA,
    expectedArtifactSha256: ARTIFACT_SHA,
    previousVersion: "0.17.2",
    previousArtifactName: "MangaReader_0.17.2_x64-setup.exe",
    previousArtifactSha256: PREVIOUS_SHA,
    checks,
    library: {
      quickCheck: "ok",
      schemaVersionBefore: 1,
      schemaVersionAfter: 2,
      bookCount: 1,
      readingLogRows: 2,
      readingLogPages: 3,
      books: [
        {
          id: BOOK_ID,
          title: "Release Smoke Book",
          pageCount: 3,
          currentPage: 2,
          scrollPct: 0.5,
          removed: 0,
          sourceType: "local",
        },
      ],
      ipc: {
        ok: true,
        source: "list_books",
        bookId: BOOK_ID,
        title: "Release Smoke Book",
        currentPage: 2,
        scrollPct: 0.5,
        bookCount: 1,
      },
      snapshotSha256: "c".repeat(64),
    },
    machine: {
      os: "Microsoft Windows Server 2022 Datacenter",
      cleanEnvironment: true,
      image: "GitHub Actions windows-2022 20261021.1.0",
      host: "RUNNER-01",
      provenance: {
        kind: "github-actions",
        repository: "D-OneXXX/MR",
        runId: "1234567890",
        runUrl: "https://github.com/D-OneXXX/MR/actions/runs/1234567890",
        runnerName: "RUNNER-01",
        imageOs: "win22",
        imageVersion: "20261021.1.0",
        workflow: "D-OneXXX/MR/.github/workflows/release-install-verify.yml@refs/heads/main",
        actor: "D-OneXXX",
        runAttempt: "1",
        startedAt: "2026-10-27T00:00:00.000Z",
      },
    },
    verifiedAt: "2026-10-27T00:00:00.000Z",
  };
}

test("证据形状：windows 必须包含 8 项检查（含四项新检查）", () => {
  const required = CHANNEL_REQUIRED_CHECKS.windows;
  for (const key of [
    "freshInstall",
    "upgrade",
    "dataIntegrity",
    "recovery",
    ...PDF_CHECKS,
  ]) {
    assert.ok(required.includes(key), `windows 门禁缺少 ${key}`);
  }
  assert.equal(required.length, 8);

  const checks = makePdfChecks({
    pdfReading: true,
    progressRestart: true,
    backupRestore: true,
    databaseRollback: true,
  });
  assert.deepEqual(checks, {
    pdfReading: "pass",
    progressRestart: "pass",
    backupRestore: "pass",
    databaseRollback: "pass",
  });
  // 未运行 / 未通过的断言绝不能产出 pass。
  assert.deepEqual(makePdfChecks({ pdfReading: true }), {
    pdfReading: "pass",
    progressRestart: "fail",
    backupRestore: "fail",
    databaseRollback: "fail",
  });
  assert.deepEqual(makePdfChecks(), {
    pdfReading: "fail",
    progressRestart: "fail",
    backupRestore: "fail",
    databaseRollback: "fail",
  });
});

test("证据门禁：8 项齐备通过，缺任一新检查被拒绝", () => {
  const expected = { channel: "windows", now: "2026-10-27T00:00:00.000Z" };
  const complete = {
    freshInstall: "pass",
    upgrade: "pass",
    dataIntegrity: "pass",
    recovery: "pass",
    ...makePdfChecks({
      pdfReading: true,
      progressRestart: true,
      backupRestore: true,
      databaseRollback: true,
    }),
  };
  assert.deepEqual(validateInstallEvidence(makeInstallEvidence(complete), expected), []);

  for (const key of PDF_CHECKS) {
    const checks = { ...complete };
    delete checks[key];
    const problems = validateInstallEvidence(makeInstallEvidence(checks), expected);
    assert.ok(
      problems.some((problem) => problem.includes(key)),
      `缺少 ${key} 必须被拒绝：${problems.join(" | ")}`,
    );
  }

  // 新检查为 fail 同样拒绝（不能把“没跑”当成通过）。
  const failed = { ...complete, backupRestore: "fail" };
  assert.ok(
    validateInstallEvidence(makeInstallEvidence(failed), expected).some((problem) =>
      problem.includes("backupRestore"),
    ),
  );
});

/* ------------------------------------------------------------------ */
/* e) 失败路径必须非零退出并写出 ok=false 证据                          */
/* ------------------------------------------------------------------ */

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

test("失败路径：缺库 / 缺参数 / 未知子命令都必须非零退出", () => {
  const dir = tempDir("cli");
  const emptyData = path.join(dir, "empty-data");
  fs.mkdirSync(emptyData, { recursive: true });

  const dbOut = path.join(dir, "db.json");
  const dbResult = runCli([
    "db",
    "--data-dir",
    emptyData,
    "--book-id",
    "f".repeat(64),
    "--out",
    dbOut,
  ]);
  assert.notEqual(dbResult.status, 0);
  assert.equal(dbResult.status, 2, dbResult.stderr);
  const dbEvidence = JSON.parse(fs.readFileSync(dbOut, "utf8"));
  assert.equal(dbEvidence.ok, false);
  assert.ok(dbEvidence.problems.includes("db-missing"));

  const snapshotEvidence = path.join(dir, "snapshot.json");
  const snapshotResult = runCli([
    "db-snapshot",
    "--data-dir",
    emptyData,
    "--out",
    path.join(dir, "snapshot.db"),
    "--evidence",
    snapshotEvidence,
  ]);
  assert.notEqual(snapshotResult.status, 0);
  const snapshotPayload = JSON.parse(fs.readFileSync(snapshotEvidence, "utf8"));
  assert.equal(snapshotPayload.ok, false);
  assert.ok(snapshotPayload.problems.some((problem) => problem.includes("db-snapshot-failed")));

  const legacyResult = runCli(["legacy-backup", "--out", path.join(dir, "legacy.mrbackup")]);
  assert.equal(legacyResult.status, 2, "缺 --work-dir 必须是参数错误");

  const unknown = runCli(["not-a-command"]);
  assert.equal(unknown.status, 2);
});

test("jpegDimensions：合法最小 JPEG 头可解析，非 JPEG 返回 null", () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
    0x03, 0x11, 0x01, // SOF0：16x32
  ]);
  assert.deepEqual(jpegDimensions(jpeg), { width: 32, height: 16 });
  assert.equal(jpegDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
});
