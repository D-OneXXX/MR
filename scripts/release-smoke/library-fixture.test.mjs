import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  bookIdForPath,
  buildFixture,
  seedLibrary,
  verifyLibrary,
} from "./library-fixture.mjs";

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mr-fixture-${label}-`));
}

/** 应用真实 schema 的最小等价形态（列与唯一索引与 db.rs 一致）。 */
function createAppSchema(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "library.db"));
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
      book_id TEXT REFERENCES books(id) ON DELETE CASCADE,
      pages INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_reading_log_book_date
      ON reading_log(date, COALESCE(book_id, ''));
    PRAGMA user_version = 1;
  `);
  db.close();
}

function withDatabase(dataDir, fn) {
  const db = new DatabaseSync(path.join(dataDir, "library.db"));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test("seed → verify：合成 3 页书、进度 2/0.5、两条 reading_log 共 3 页", async () => {
  const dataDir = tempDir("ok");
  createAppSchema(dataDir);
  const fixturePath = path.join(dataDir, "fixture.json");

  const seeded = await seedLibrary({ dataDir, fixturePath, waitMs: 5000 });
  const fixture = buildFixture(dataDir);
  assert.equal(seeded.bookId, bookIdForPath(path.resolve(dataDir, "release-smoke", "book")));
  assert.equal(fs.existsSync(fixturePath), true);
  for (const name of fixture.files) {
    const file = path.join(fixture.bookPath, name);
    assert.equal(fs.existsSync(file), true, `缺少合成页：${file}`);
    assert.ok(fs.statSync(file).size > 50, "合成 PNG 不得为空");
  }

  const verified = verifyLibrary({ dataDir, fixturePath, schemaVersionBefore: 1 });
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));
  assert.equal(verified.quickCheck, "ok");
  assert.equal(verified.schemaVersionBefore, 1);
  assert.equal(verified.schemaVersionAfter, 1);
  assert.equal(verified.bookCount, 1);
  assert.equal(verified.readingLogRows, 2);
  assert.equal(verified.readingLogPages, 3);
  assert.equal(verified.books.length, 1);
  assert.equal(verified.books[0].id, fixture.bookId);
  assert.equal(verified.books[0].title, "Release Smoke Book");
  assert.equal(verified.books[0].pageCount, 3);
  assert.equal(verified.books[0].currentPage, 2);
  assert.equal(verified.books[0].scrollPct, 0.5);
  assert.equal(verified.books[0].removed, 0);
  assert.equal(verified.books[0].sourceType, "local");
  assert.match(verified.snapshotSha256, /^[0-9a-f]{64}$/);

  // 快照必须可重复：同一状态二次核验摘要一致。
  const again = verifyLibrary({ dataDir, fixturePath, schemaVersionBefore: 1 });
  assert.equal(again.snapshotSha256, verified.snapshotSha256);
});

test("缺表超时：应用尚未创建 schema 时 seed 不得自行建表", async () => {
  const dataDir = tempDir("missing");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "library.db"));
  db.exec("CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')");
  db.close();
  const fixturePath = path.join(dataDir, "fixture.json");

  await assert.rejects(
    () => seedLibrary({ dataDir, fixturePath, waitMs: 400, intervalMs: 50 }),
    /等待应用创建 books\/reading_log 超时/,
  );
  withDatabase(dataDir, (conn) => {
    const tables = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ["settings"], "seed 不得创建应用 schema");
  });
});

test("进度被改：verify 必须失败并指出 current_page", async () => {
  const dataDir = tempDir("progress");
  createAppSchema(dataDir);
  const fixturePath = path.join(dataDir, "fixture.json");
  const seeded = await seedLibrary({ dataDir, fixturePath, waitMs: 5000 });
  withDatabase(dataDir, (db) => {
    db.prepare("UPDATE books SET current_page = 1 WHERE id = ?").run(seeded.bookId);
  });
  const verified = verifyLibrary({ dataDir, fixturePath, schemaVersionBefore: 1 });
  assert.equal(verified.ok, false);
  assert.ok(
    verified.problems.some((problem) => problem.includes("阅读进度被改")),
    JSON.stringify(verified.problems),
  );
});

test("reading_log 丢失：verify 必须失败并指出行数/页数", async () => {
  const dataDir = tempDir("log");
  createAppSchema(dataDir);
  const fixturePath = path.join(dataDir, "fixture.json");
  const seeded = await seedLibrary({ dataDir, fixturePath, waitMs: 5000 });
  withDatabase(dataDir, (db) => {
    db.prepare("DELETE FROM reading_log WHERE book_id = ?").run(seeded.bookId);
  });
  const verified = verifyLibrary({ dataDir, fixturePath, schemaVersionBefore: 1 });
  assert.equal(verified.ok, false);
  assert.ok(
    verified.problems.some((problem) => problem.includes("reading_log 行数不符")),
    JSON.stringify(verified.problems),
  );
});

test("schema 降级：user_version 回退时 verify 必须失败", async () => {
  const dataDir = tempDir("schema");
  createAppSchema(dataDir);
  const fixturePath = path.join(dataDir, "fixture.json");
  await seedLibrary({ dataDir, fixturePath, waitMs: 5000 });
  withDatabase(dataDir, (db) => {
    db.exec("PRAGMA user_version = 0");
  });
  const verified = verifyLibrary({ dataDir, fixturePath, schemaVersionBefore: 1 });
  assert.equal(verified.ok, false);
  assert.ok(
    verified.problems.some((problem) => problem.includes("schema 版本降级")),
    JSON.stringify(verified.problems),
  );
});
