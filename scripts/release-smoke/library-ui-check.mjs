#!/usr/bin/env node
/**
 * 安装后真实 IPC 回读校验：通过 WebView2 CDP 调用应用自己的 `list_books`，
 * 确认升级/回滚后的用户书库与阅读进度不是「只存在于 SQLite 文件里」，
 * 而是能被**已安装的应用**读取出来。
 *
 * 该脚本只连接已在运行的发布版应用，不启动 Vite、不启动应用、不修改数据库。
 * 安装脚本负责启动/关闭应用并传入 CDP 端口。
 *
 * 用法：
 *   node scripts/release-smoke/library-ui-check.mjs \
 *     --port 9333 --fixture fixture.json --out ipc.json
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { connectMain, waitForTarget } from "../../tests/qa/lib/cdp.mjs";
import { invoke, waitForApp } from "../../tests/qa/lib/app.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateListBooks(books, fixture) {
  const problems = [];
  const list = Array.isArray(books) ? books : [];
  const book = list.find((entry) => entry?.id === fixture.bookId);
  if (!book) {
    problems.push(`list_books 中找不到书 ${fixture.bookId}`);
  } else {
    if (String(book.title) !== String(fixture.title)) {
      problems.push(`list_books 标题不一致：期望 ${fixture.title}，实际 ${book.title}`);
    }
    if (Number(book.currentPage) !== Number(fixture.currentPage)) {
      problems.push(
        `list_books 阅读进度不一致：期望 ${fixture.currentPage}，实际 ${book.currentPage}`,
      );
    }
    const scrollPct = Number(book.scrollPct ?? book.scroll_pct);
    if (Math.abs(scrollPct - Number(fixture.scrollPct)) > 1e-9) {
      problems.push(
        `list_books 条漫偏移不一致：期望 ${fixture.scrollPct}，实际 ${book.scrollPct}`,
      );
    }
  }
  if (list.length !== Number(fixture.bookCount)) {
    problems.push(`list_books 书数不一致：期望 ${fixture.bookCount}，实际 ${list.length}`);
  }
  const result = {
    ok: problems.length === 0,
    source: "list_books",
    bookId: book?.id ?? null,
    title: book?.title ?? null,
    currentPage: Number(book?.currentPage ?? NaN),
    scrollPct: Number(book?.scrollPct ?? book?.scroll_pct ?? NaN),
    bookCount: list.length,
    checkedAt: new Date().toISOString(),
    problems,
  };
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

function writeResult(outPath, result) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = Number(args.port || 9333);
  const fixturePath = args.fixture;
  const outPath = args.out || "";
  const timeoutMs = Number(args.timeout || 90_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[library-ui-check] 非法 CDP 端口：${args.port}`);
    return 2;
  }
  if (!fixturePath || !fs.existsSync(fixturePath)) {
    console.error(`[library-ui-check] 找不到 fixture：${fixturePath}`);
    return 2;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  let page = null;
  try {
    await waitForTarget(port, () => true, { timeout: timeoutMs });
    page = await connectMain(port);
    await waitForApp(page, Math.min(timeoutMs, 60_000));

    const deadline = Date.now() + timeoutMs;
    let lastBooks = [];
    let lastError = null;
    let result = null;
    while (Date.now() < deadline) {
      try {
        lastBooks = await invoke(page, "list_books", { query: null });
        result = validateListBooks(lastBooks, fixture);
        if (result.ok) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    if (!result || !result.ok) {
      const failure = result || {
        ok: false,
        source: "list_books",
        bookId: null,
        title: null,
        currentPage: NaN,
        scrollPct: NaN,
        bookCount: Array.isArray(lastBooks) ? lastBooks.length : 0,
        checkedAt: new Date().toISOString(),
        problems: [
          lastError
            ? `list_books 调用失败：${lastError.message}`
            : "list_books 未在超时内回读到 fixture 书库",
        ],
      };
      writeResult(outPath, failure);
      console.error(`[library-ui-check] FAIL ${JSON.stringify(failure)}`);
      return 1;
    }
    writeResult(outPath, result);
    console.log(
      `[library-ui-check] OK book=${result.bookId} page=${result.currentPage} scroll=${result.scrollPct} count=${result.bookCount}`,
    );
    return 0;
  } catch (error) {
    const failure = {
      ok: false,
      source: "list_books",
      bookId: null,
      title: null,
      currentPage: NaN,
      scrollPct: NaN,
      bookCount: 0,
      checkedAt: new Date().toISOString(),
      problems: [`CDP/IPC 校验异常：${error.message}`],
    };
    writeResult(outPath, failure);
    console.error(`[library-ui-check] FAIL ${JSON.stringify(failure)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = await main();
}
