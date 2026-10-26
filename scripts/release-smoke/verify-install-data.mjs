#!/usr/bin/env node
/**
 * 安装/升级后的**数据完整性**核验：在隔离数据目录里用指定二进制启动应用，
 * 写入（或读回）一本书的阅读进度，验证升级前后 SQLite 数据与进度是否完好。
 *
 * 两种模式：
 * - `--mode seed`：导入夹具书籍 → 把第一本书的进度设为 `--expect-page` → 退出；
 * - `--mode verify`：读回第一本书的进度，与 `--expect-page` 比对（不一致即失败）。
 *
 * 全程使用隔离的 MR_DATA_DIR / MR_RENDER_CACHE_DIR / MR_ONLINE_CACHE_DIR，
 * 不触碰真实用户数据。
 *
 * 用法：
 *   node scripts/release-smoke/verify-install-data.mjs --app-bin <exe> --data-dir <dir> \
 *     --mode seed --expect-page 3
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startQaApp, invoke } from "../../tests/qa/lib/app.mjs";
import { createQaFixtures } from "../../tests/qa/lib/fixtures.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export async function verifyInstallData({ appBin, dataDir, mode, expectPage, cdpPort = 9350, fixtureRoot }) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const artifactDir = path.join(dataDir, "_qa-artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  const fixtures = createQaFixtures(fixtureRoot || path.join(os.tmpdir(), "mr-install-fixtures"));
  // 让 QA harness 启动**被验证的那个二进制**（例如刚安装/升级后的程序）。
  if (appBin) {
    process.env.QA_APP_BIN = appBin;
  }

  const ctx = await startQaApp({
    root,
    artifactDir,
    dataDir,
    fixtures,
    cdpPort,
    // 读回既有书库（升级/恢复核验），不导入夹具。
    allowExistingBooks: mode === "verify",
  });
  try {
    const books = await invoke(ctx.page, "list_books", { query: null });
    if (!Array.isArray(books) || books.length === 0) {
      throw new Error("隔离数据目录里没有可用书籍（夹具导入失败）");
    }
    const book = books.find((item) => item.title.includes("QA Local Folder")) || books[0];
    if (mode === "seed") {
      await invoke(ctx.page, "set_progress", {
        bookId: book.id,
        page: expectPage,
        scrollPct: 0.42,
      });
      const after = await invoke(ctx.page, "get_book", { bookId: book.id });
      if (Number(after.currentPage) !== Number(expectPage)) {
        throw new Error(`写入进度失败：期望 ${expectPage}，实际 ${after.currentPage}`);
      }
      return { ok: true, bookId: book.id, title: book.title, currentPage: after.currentPage };
    }
    const current = await invoke(ctx.page, "get_book", { bookId: book.id });
    const booksAfter = await invoke(ctx.page, "list_books", { query: null });
    const ok =
      Number(current.currentPage) === Number(expectPage) &&
      Array.isArray(booksAfter) &&
      booksAfter.length === books.length;
    return {
      ok,
      bookId: book.id,
      title: book.title,
      currentPage: current.currentPage,
      expectedPage: Number(expectPage),
      bookCount: Array.isArray(booksAfter) ? booksAfter.length : -1,
      expectedBookCount: books.length,
    };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["app-bin", "data-dir", "mode"]) {
    if (!args[key]) {
      console.error(`[install-data] 缺少参数 --${key}`);
      process.exitCode = 2;
      return;
    }
  }
  const result = await verifyInstallData({
    appBin: args["app-bin"],
    dataDir: args["data-dir"],
    mode: args.mode,
    expectPage: Number(args["expect-page"] ?? 0),
    cdpPort: Number(args["cdp-port"] ?? 9350),
  });
  if (!result.ok) {
    console.error(`[install-data] 数据完整性核验失败：${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[install-data] OK ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
