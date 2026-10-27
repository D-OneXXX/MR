#!/usr/bin/env node
/**
 * Linux 干净环境安装验证运行时（WebKitGTK WebDriver + 真实 IPC）。
 *
 * 与 Windows 的 `windows-install-upgrade.ps1` 对应：本脚本只做**被测二进制**
 * 的真实运行验证，不安装包、不签名、不联网。
 *
 * 覆盖：
 * - `seed`：首次启动创建 app schema → 写入合成旧书库（folder）与阅读进度；
 * - `pre-upgrade`：用旧版本二进制回读旧书库，并导出旧版 `.mrbackup`；
 * - `candidate`：用候选版本回读旧数据，导入 zip / cbz / PDF，写入 PDF 进度；
 * - `restart`：**新进程**回读 PDF 进度（跨进程恢复）；
 * - `export`：候选版本导出新版 `.mrbackup`；
 * - `restore`：全新 profile 导入旧版/新版备份并回读。
 *
 * 所有数据目录、缓存与 WebKit profile 都是隔离的；不触碰真实用户数据。
 * 证据只记录 basename / 摘要，不写用户主目录。
 *
 * 用法（需要 `node --experimental-sqlite`，WebKitWebDriver 与 X server）：
 *   node --experimental-sqlite scripts/release-smoke/linux-install-check.mjs \
 *     --binary /usr/bin/manga-reader-tauri --data-dir /tmp/mr-data \
 *     --work-dir /tmp/mr-work --mode candidate --out candidate.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { makePng, seedLibrary } from "./library-fixture.mjs";
import { writeStoredZip } from "./pdf-release-check.mjs";
import { makePdf } from "../../tests/qa/lib/pdf-fixtures.mjs";

const HARNESS_VERSION = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 纯函数：结果校验与证据统计                                          */
/* ------------------------------------------------------------------ */

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * 校验 list_books / get_book 的回读结果。
 * @param {Array} books list_books 返回
 * @param {object} expected { fixtureBookId, fixtureTitle, fixturePage, pdfBookId, pdfPage, minBooks }
 */
export function validateReadback(books, expected = {}) {
  const problems = [];
  const list = Array.isArray(books) ? books : [];
  const find = (id) => list.find((item) => String(item?.id) === String(id));
  if (expected.minBooks != null && list.length < Number(expected.minBooks)) {
    problems.push(`list_books 数量不足：期望 ≥${expected.minBooks}，实际 ${list.length}`);
  }
  if (expected.fixtureBookId) {
    const fixture = find(expected.fixtureBookId);
    if (!fixture) {
      problems.push(`list_books 找不到旧书库夹具 ${expected.fixtureBookId}`);
    } else {
      if (expected.fixtureTitle && String(fixture.title) !== String(expected.fixtureTitle)) {
        problems.push(`旧书库标题不一致：期望 ${expected.fixtureTitle}，实际 ${fixture.title}`);
      }
      if (
        expected.fixturePage != null &&
        Number(fixture.currentPage) !== Number(expected.fixturePage)
      ) {
        problems.push(
          `旧书库进度丢失：期望 ${expected.fixturePage}，实际 ${fixture.currentPage}`,
        );
      }
    }
  }
  if (expected.pdfBookId) {
    const pdf = find(expected.pdfBookId);
    if (!pdf) {
      problems.push(`list_books 找不到 PDF 书 ${expected.pdfBookId}`);
    } else if (expected.pdfPage != null && Number(pdf.currentPage) !== Number(expected.pdfPage)) {
      problems.push(`PDF 进度未恢复：期望 ${expected.pdfPage}，实际 ${pdf.currentPage}`);
    }
  }
  return { ok: problems.length === 0, bookCount: list.length, problems };
}

/** 读取应用关闭后的 SQLite 自检数据（只读）。 */
export function readLibraryStats(dataDir, focusBookId = null) {
  const dbPath = path.join(path.resolve(dataDir), "library.db");
  if (!fs.existsSync(dbPath)) {
    return { ok: false, quickCheck: "missing", problems: [`找不到 library.db`] };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const quick = db.prepare("PRAGMA quick_check").get();
    const quickCheck = String(quick?.quick_check ?? "unknown").toLowerCase();
    const schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    const bookCount = Number(db.prepare("SELECT COUNT(*) AS n FROM books").get()?.n ?? 0);
    const readingLogRows = Number(
      db.prepare("SELECT COUNT(*) AS n FROM reading_log").get()?.n ?? 0,
    );
    const readingLogPages = Number(
      db.prepare("SELECT COALESCE(SUM(pages), 0) AS n FROM reading_log").get()?.n ?? 0,
    );
    const rows = db
      .prepare(
        `SELECT id, title, page_count, current_page, scroll_pct, removed, source_type
         FROM books ORDER BY updated_at DESC, id ASC`,
      )
      .all();
    const books = rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      pageCount: Number(row.page_count),
      currentPage: Number(row.current_page),
      scrollPct: Number(row.scroll_pct),
      removed: Number(row.removed),
      sourceType: String(row.source_type),
    }));
    if (focusBookId) {
      const index = books.findIndex((book) => book.id === String(focusBookId));
      if (index > 0) books.unshift(...books.splice(index, 1));
    }
    const payload = { bookCount, readingLogRows, readingLogPages, schemaVersion, books };
    return {
      ok: quickCheck === "ok" && bookCount > 0,
      quickCheck,
      schemaVersion,
      bookCount,
      readingLogRows,
      readingLogPages,
      books,
      snapshotSha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

/** 生成 Linux 安装验证运行时所需的合成夹具（全部位于数据目录之外）。 */
export function createLinuxFixtures(workDir) {
  const root = path.resolve(workDir);
  fs.mkdirSync(root, { recursive: true });
  const png = makePng(1);
  const pages = [1, 2, 3].map((index) => ({
    name: `${index}.png`,
    data: png,
  }));
  const folder = path.join(root, "fixture-folder");
  fs.mkdirSync(folder, { recursive: true });
  for (const page of pages) fs.writeFileSync(path.join(folder, page.name), page.data);
  const zip = path.join(root, "fixture-archive.zip");
  fs.writeFileSync(zip, writeStoredZip(pages));
  const cbz = path.join(root, "fixture-archive.cbz");
  fs.writeFileSync(cbz, writeStoredZip(pages));
  const pdf = path.join(root, "fixture-document.pdf");
  fs.writeFileSync(pdf, makePdf({ pageCount: 4, label: "Linux Release Smoke" }));
  return { root, folder, zip, cbz, pdf };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    binary: "",
    dataDir: "",
    workDir: "",
    mode: "",
    out: "",
    backup: "",
    driver: process.env.MR_WEBKITWEBDRIVER || "/usr/bin/WebKitWebDriver",
    port: 9515,
    timeoutMs: 120_000,
    fixtureBookId: "",
    pdfBookId: "",
    schemaBefore: null,
    expectBooks: null,
    expectPdf: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少参数`);
      return argv[index];
    };
    switch (arg) {
      case "--binary":
        out.binary = next();
        break;
      case "--data-dir":
        out.dataDir = next();
        break;
      case "--work-dir":
        out.workDir = next();
        break;
      case "--mode":
        out.mode = next();
        break;
      case "--out":
        out.out = next();
        break;
      case "--backup":
        out.backup = next();
        break;
      case "--driver":
        out.driver = next();
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--timeout":
        out.timeoutMs = Number(next());
        break;
      case "--fixture-book-id":
        out.fixtureBookId = next();
        break;
      case "--pdf-book-id":
        out.pdfBookId = next();
        break;
      case "--schema-before":
        out.schemaBefore = Number(next());
        break;
      case "--expect-books":
        out.expectBooks = Number(next());
        break;
      case "--expect-pdf":
        out.expectPdf = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "用法: node --experimental-sqlite scripts/release-smoke/linux-install-check.mjs --binary <path> --data-dir <dir> --work-dir <dir> --mode <mode> --out <json>",
            "mode: seed | pre-upgrade | candidate | restart | export | restore",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!out.binary) throw new Error("缺少 --binary");
  if (!out.dataDir) throw new Error("缺少 --data-dir");
  if (!out.workDir) throw new Error("缺少 --work-dir");
  if (!out.mode) throw new Error("缺少 --mode");
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error("--port 非法");
  return out;
}

/* ------------------------------------------------------------------ */
/* WebKitWebDriver                                                     */
/* ------------------------------------------------------------------ */

async function httpJson(port, method, pathname, body, timeoutMs = 60_000) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json, text };
}

class Session {
  constructor(port, id) {
    this.port = port;
    this.id = id;
    this.capability = "";
  }

  async request(method, suffix, body, timeoutMs) {
    const res = await httpJson(this.port, method, `/session/${this.id}${suffix}`, body, timeoutMs);
    if (res.status >= 400) {
      const message = res.json?.value?.message || res.text.slice(0, 300);
      throw new Error(`WebDriver ${method} ${suffix} → ${res.status}: ${message}`);
    }
    return res.json ? res.json.value : null;
  }

  exec(script, args = []) {
    return this.request("POST", "/execute/sync", { script, args });
  }

  execAsync(script, args = [], timeoutMs = 120_000) {
    return this.request("POST", "/execute/async", { script, args }, timeoutMs);
  }

  async waitFor(label, predicateSource, timeoutMs, intervalMs = 200) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.exec(`return (${predicateSource});`)) return true;
      await sleep(intervalMs);
    }
    throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
  }
}

async function createSession(port, binary, timeoutMs) {
  const option = { binary, args: ["--automation"] };
  const attempts = [
    {
      name: "webkitgtk:browserOptions",
      caps: { "webkitgtk:browserOptions": option },
    },
    {
      name: "MiniBrowser + webkitgtk:browserOptions",
      caps: { browserName: "MiniBrowser", "webkitgtk:browserOptions": option },
    },
  ];
  const errors = [];
  for (const attempt of attempts) {
    const res = await httpJson(
      port,
      "POST",
      "/session",
      { capabilities: { alwaysMatch: attempt.caps } },
      timeoutMs,
    );
    if (res.status < 400 && res.json?.value?.sessionId) {
      const session = new Session(port, res.json.value.sessionId);
      session.capability = `${attempt.name} → ${res.json.value.capabilities?.browserName || "?"}`;
      return session;
    }
    errors.push(`${attempt.name}: ${res.json?.value?.message || res.text.slice(0, 120)}`);
  }
  throw new Error(`无法建立 WebDriver 会话：${errors.join(" | ")}`);
}

async function attachAppPage(session, timeoutMs) {
  const handles = (await session.request("GET", "/window/handles")) || [];
  const hrefs = new Map();
  for (const handle of handles) {
    await session.request("POST", "/window", { handle });
    hrefs.set(handle, await session.exec("return location.href;"));
  }
  let chosen =
    handles.find((handle) => hrefs.get(handle) === "tauri://localhost/") ||
    handles.find((handle) => {
      const href = hrefs.get(handle);
      return typeof href === "string" && href.startsWith("tauri://localhost") && !href.includes("recovery");
    });
  if (!chosen) {
    if (handles.length) {
      await session.request("POST", "/window", { handle: handles[0] });
      chosen = handles[0];
    }
    await session.request("POST", "/url", { url: "tauri://localhost/" }, 60_000);
  } else {
    await session.request("POST", "/window", { handle: chosen });
  }
  try {
    await session.request("POST", "/window/rect", {
      width: 1200,
      height: 800,
      x: 40,
      y: 40,
    });
  } catch {
    /* some window types refuse resize */
  }
  await session.waitFor(
    "SPA 挂载",
    `!!window.__TAURI_INTERNALS__ && !!document.querySelector("#root") && document.querySelector("#root").children.length > 0`,
    timeoutMs,
  );
  return chosen;
}

function spawnDriver({ driver, port, work, dataDir }) {
  const logPath = path.join(work, `webkitwebdriver-${port}.log`);
  const log = fs.openSync(logPath, "w");
  const env = {
    ...process.env,
    TAURI_WEBVIEW_AUTOMATION: "true",
    MR_DATA_DIR: path.resolve(dataDir),
    MR_RENDER_CACHE_DIR: path.join(work, "render_cache"),
    MR_ONLINE_CACHE_DIR: path.join(work, "online_cache"),
    XDG_DATA_HOME: path.join(work, "xdg-data"),
    XDG_CACHE_HOME: path.join(work, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(work, "xdg-config"),
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    GDK_BACKEND: process.env.GDK_BACKEND || "x11",
    NO_AT_BRIDGE: "1",
  };
  for (const dir of ["render_cache", "online_cache", "xdg-data", "xdg-cache", "xdg-config"]) {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
  }
  const child = spawn(driver, [`--port=${port}`, "--host=local"], {
    env,
    stdio: ["ignore", log, log],
    detached: false,
  });
  child.on("error", () => {});
  return { child, log, logPath };
}

async function waitForDriver(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpJson(port, "GET", "/status", null, 2000);
      if (res.json?.value?.ready) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

function killStaleInstances(binary) {
  const prefix = path.basename(binary).slice(0, 15);
  if (!prefix) return;
  for (const proc of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(proc)) continue;
    try {
      const name = fs.readFileSync(`/proc/${proc}/comm`, "utf8").trim();
      if (name.startsWith(prefix)) process.kill(Number(proc), "SIGTERM");
    } catch {
      /* process gone */
    }
  }
}

async function waitForAppExit(binary, timeoutMs = 15_000) {
  const prefix = path.basename(binary).slice(0, 15);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = false;
    for (const proc of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(proc)) continue;
      try {
        if (fs.readFileSync(`/proc/${proc}/comm`, "utf8").trim().startsWith(prefix)) {
          alive = true;
          break;
        }
      } catch {
        /* gone */
      }
    }
    if (!alive) return true;
    await sleep(200);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

const INVOKE = `
const done = arguments[arguments.length - 1];
const command = arguments[0];
const payload = arguments[1] || {};
if (!window.__TAURI_INTERNALS__) {
  done({ ok: false, error: "no-tauri-ipc" });
} else {
  window.__TAURI_INTERNALS__.invoke(command, payload)
    .then((result) => done({ ok: true, result }))
    .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
}
`;

async function invokeIpc(session, command, payload = {}) {
  const result = await session.execAsync(INVOKE, [command, payload]);
  if (!result?.ok) throw new Error(`${command} 失败：${result?.error || "unknown"}`);
  return result.result;
}

async function openApp(args, report) {
  const binary = path.resolve(args.binary);
  if (!fs.existsSync(binary)) throw new Error(`二进制不存在：${path.basename(binary)}`);
  if (!process.env.DISPLAY) throw new Error("缺少 DISPLAY（CI 需 xvfb-run）");
  fs.mkdirSync(args.dataDir, { recursive: true });
  fs.mkdirSync(args.workDir, { recursive: true });
  killStaleInstances(binary);
  await sleep(300);
  if (!fs.existsSync(args.driver)) throw new Error(`WebKitWebDriver 不存在：${args.driver}`);
  const spawned = spawnDriver({
    driver: args.driver,
    port: args.port,
    work: args.workDir,
    dataDir: args.dataDir,
  });
  if (!(await waitForDriver(args.port))) throw new Error("WebKitWebDriver 未在 20s 内就绪");
  const session = await createSession(args.port, binary, args.timeoutMs);
  report.capabilityUsed = session.capability;
  await attachAppPage(session, args.timeoutMs);
  await session.request("POST", "/timeouts", {
    script: 180_000,
    pageLoad: 120_000,
    implicit: 0,
  });
  return { session, spawned };
}

function closeApp({ session, spawned }, binary) {
  if (session) {
    // 在 finally 里等待 DELETE 会拖住主流程；这里只做尽力关闭。
    void session.request("DELETE", "", null, 20_000).catch(() => {});
  }
  if (spawned?.child) {
    try {
      spawned.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (spawned?.log != null) {
    try {
      fs.closeSync(spawned.log);
    } catch {
      /* ignore */
    }
  }
  killStaleInstances(binary);
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

async function modeSeed(args, report) {
  // 1) 首次启动让应用创建 schema；立即关闭后再写夹具（避免与 WAL 抢锁）。
  let opened = await openApp(args, report);
  const info = await invokeIpc(opened.session, "get_app_info");
  report.appVersion = info?.version ?? null;
  closeApp(opened, args.binary);
  if (!(await waitForAppExit(args.binary))) {
    throw new Error("旧版本应用未在 15s 内退出，拒绝在运行中的库上写夹具");
  }

  // 2) 写入合成旧书库（folder 3 页 + 进度 + reading_log）。
  const seeded = await seedLibrary({
    dataDir: args.dataDir,
    fixturePath: path.join(args.workDir, "fixture.json"),
  });
  const stats = readLibraryStats(args.dataDir, seeded.bookId);
  report.fixture = {
    bookId: seeded.bookId,
    title: "Release Smoke Book",
    currentPage: 2,
    schemaVersion: seeded.schemaVersion,
  };
  report.library = stats;
  report.ok = seeded.ok && stats.ok;
  if (!report.ok) throw new Error("旧书库夹具写入失败");
}

async function modePreUpgrade(args, report) {
  const opened = await openApp(args, report);
  try {
    const books = await invokeIpc(opened.session, "list_books", { query: null });
    const check = validateReadback(books, {
      fixtureBookId: args.fixtureBookId,
      fixtureTitle: "Release Smoke Book",
      fixturePage: 2,
      minBooks: 1,
    });
    report.readback = check;
    report.bookCount = check.bookCount;
    if (!check.ok) throw new Error(check.problems.join(" | "));
    if (args.backup) {
      fs.mkdirSync(path.dirname(path.resolve(args.backup)), { recursive: true });
      await invokeIpc(opened.session, "export_backup", {
        destPath: path.resolve(args.backup),
        preferencesJson: null,
      });
    }
  } finally {
    closeApp(opened, args.binary);
  }
  await sleep(1500);
  report.library = readLibraryStats(args.dataDir, args.fixtureBookId);
  report.previousSchemaVersion = report.library.schemaVersion;
  if (args.backup) {
    if (!fs.existsSync(args.backup)) throw new Error("旧版备份文件未生成");
    report.backup = {
      name: path.basename(args.backup),
      size: fs.statSync(args.backup).size,
      sha256: sha256File(args.backup),
    };
  }
  report.ok = true;
}

async function modeCandidate(args, report) {
  const fixtures = createLinuxFixtures(args.workDir);
  const opened = await openApp(args, report);
  let pdfBookId = null;
  try {
    const before = await invokeIpc(opened.session, "list_books", { query: null });
    const readback = validateReadback(before, {
      fixtureBookId: args.fixtureBookId,
      fixtureTitle: "Release Smoke Book",
      fixturePage: 2,
      minBooks: 1,
    });
    report.readbackBefore = readback;
    if (!readback.ok) throw new Error(readback.problems.join(" | "));

    const imported = await invokeIpc(opened.session, "import_books", {
      paths: [fixtures.zip, fixtures.cbz, fixtures.pdf],
    });
    const items = imported?.items || [];
    if (Number(imported?.failed || 0) > 0) {
      throw new Error(`导入失败 ${imported.failed} 项`);
    }
    const byName = new Map();
    for (const item of items) byName.set(path.basename(item.path || ""), item);
    const idOf = (file) => {
      const item = byName.get(path.basename(file));
      if (!item?.book?.id) {
        throw new Error(`导入未返回书 ID：${path.basename(file)}（status=${item?.status || "?"}）`);
      }
      return item.book.id;
    };
    const zipId = idOf(fixtures.zip);
    const cbzId = idOf(fixtures.cbz);
    pdfBookId = idOf(fixtures.pdf);
    report.imported = { added: imported.added ?? 0, failed: imported.failed ?? 0 };

    const formats = {};
    for (const [key, id] of [
      ["folder", args.fixtureBookId],
      ["zip", zipId],
      ["cbz", cbzId],
      ["pdf", pdfBookId],
    ]) {
      const book = await invokeIpc(opened.session, "get_book", { bookId: id });
      formats[key] = book?.format ?? null;
      if (key === "pdf") {
        if (book?.format !== "pdf") throw new Error(`PDF 书 format=${String(book?.format)}`);
        // PDF 入库时 page_count 有意保持 0（页数由 PDF.js 打开时解析）；
        // 真正的页数/渲染断言由 linux-pdf-runtime.mjs 覆盖。
      }
    }
    report.formats = formats;
    // 文件夹 / ZIP / CBZ 都属于图片书源（format=image），PDF 独立为 format=pdf；
    // 这里验证既有格式没有被 PDF 引入改变。
    if (formats.folder !== "image" || formats.zip !== "image" || formats.cbz !== "image") {
      throw new Error(`既有格式回读异常：${JSON.stringify(formats)}`);
    }
    // 真正的取页读取（不是只看 format）：确认三种既有书源仍能解码首页。
    const reads = {};
    for (const [key, id] of [
      ["folder", args.fixtureBookId],
      ["zip", zipId],
      ["cbz", cbzId],
    ]) {
      const page = await invokeIpc(opened.session, "get_page", {
        bookId: id,
        index: 0,
        maxWidth: 640,
        maxHeight: 960,
      });
      const dataUrl = String(page?.dataUrl || "");
      reads[key] = {
        ok: dataUrl.startsWith("data:image/"),
        width: Number(page?.width ?? 0),
        height: Number(page?.height ?? 0),
        origWidth: Number(page?.origWidth ?? 0),
      };
      if (!reads[key].ok || reads[key].origWidth < 1) {
        throw new Error(`既有格式取页失败：${key}`);
      }
    }
    report.reads = reads;

    // PDF 进度：与 Windows 夹具一致使用 0 基 current_page=2（UI 显示第 3 页）。
    await invokeIpc(opened.session, "set_progress", {
      bookId: pdfBookId,
      page: 2,
      scrollPct: 0,
    });
    const pdfBook = await invokeIpc(opened.session, "get_book", { bookId: pdfBookId });
    report.pdf = { bookId: pdfBookId, currentPage: Number(pdfBook.currentPage) };
    if (report.pdf.currentPage !== 2) throw new Error("PDF 进度写入失败");
    const after = await invokeIpc(opened.session, "list_books", { query: null });
    const afterCheck = validateReadback(after, {
      fixtureBookId: args.fixtureBookId,
      pdfBookId,
      fixturePage: 2,
      pdfPage: 2,
      minBooks: 4,
    });
    report.readbackAfter = afterCheck;
    if (!afterCheck.ok) throw new Error(afterCheck.problems.join(" | "));
    const fixture = after.find((book) => String(book.id) === String(args.fixtureBookId));
    report.ipc = {
      ok: true,
      source: "list_books",
      bookId: String(fixture?.id ?? ""),
      title: String(fixture?.title ?? ""),
      currentPage: Number(fixture?.currentPage ?? NaN),
      scrollPct: Number(fixture?.scrollPct ?? NaN),
      bookCount: after.length,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    closeApp(opened, args.binary);
  }
  await sleep(1500);
  const stats = readLibraryStats(args.dataDir, args.fixtureBookId);
  stats.schemaVersionBefore = args.schemaBefore ?? 1;
  report.library = stats;
  report.pdfBookId = pdfBookId;
  report.ok = stats.ok;
  if (!stats.ok) throw new Error(`数据库自检失败：${stats.quickCheck}`);
}

async function modeRestart(args, report) {
  const opened = await openApp(args, report);
  try {
    const books = await invokeIpc(opened.session, "list_books", { query: null });
    const check = validateReadback(books, {
      fixtureBookId: args.fixtureBookId,
      pdfBookId: args.pdfBookId,
      fixturePage: 2,
      pdfPage: 2,
      minBooks: 4,
    });
    report.readback = check;
    report.bookCount = check.bookCount;
    if (!check.ok) throw new Error(check.problems.join(" | "));
  } finally {
    closeApp(opened, args.binary);
  }
  await sleep(1000);
  report.library = readLibraryStats(args.dataDir, args.fixtureBookId);
  report.ok = true;
}

async function modeExport(args, report) {
  if (!args.backup) throw new Error("export 模式需要 --backup");
  const opened = await openApp(args, report);
  try {
    fs.mkdirSync(path.dirname(path.resolve(args.backup)), { recursive: true });
    await invokeIpc(opened.session, "export_backup", {
      destPath: path.resolve(args.backup),
      preferencesJson: null,
    });
  } finally {
    closeApp(opened, args.binary);
  }
  await sleep(1000);
  if (!fs.existsSync(args.backup)) throw new Error("新版备份文件未生成");
  report.backup = {
    name: path.basename(args.backup),
    size: fs.statSync(args.backup).size,
    sha256: sha256File(args.backup),
  };
  report.ok = true;
}

async function modeRestore(args, report) {
  if (!args.backup) throw new Error("restore 模式需要 --backup");
  if (!fs.existsSync(args.backup)) throw new Error(`备份文件不存在：${path.basename(args.backup)}`);
  const opened = await openApp(args, report);
  try {
    const imported = await invokeIpc(opened.session, "import_backup", {
      sourcePath: path.resolve(args.backup),
    });
    report.imported = {
      books: Number(imported?.books ?? 0),
      readingDays: Number(imported?.readingDays ?? 0),
    };
    if (report.imported.books < 1) throw new Error("恢复后书库为空");
    const books = await invokeIpc(opened.session, "list_books", { query: null });
    report.bookCount = books.length;
    if (args.expectBooks != null && books.length < args.expectBooks) {
      throw new Error(`恢复后书数不足：期望 ≥${args.expectBooks}，实际 ${books.length}`);
    }
    if (args.expectPdf) {
      const pdf = books.find((book) => book.format === "pdf");
      if (!pdf) throw new Error("恢复后找不到 PDF 书");
      if (Number(pdf.currentPage) !== 2) {
        throw new Error(`恢复后 PDF 进度不一致：${pdf.currentPage}`);
      }
      report.pdf = { bookId: pdf.id, currentPage: Number(pdf.currentPage) };
    }
  } finally {
    closeApp(opened, args.binary);
  }
  await sleep(1000);
  report.library = readLibraryStats(args.dataDir, null);
  report.ok = true;
}

async function run(args, report) {
  switch (args.mode) {
    case "seed":
      await modeSeed(args, report);
      break;
    case "pre-upgrade":
      await modePreUpgrade(args, report);
      break;
    case "candidate":
      await modeCandidate(args, report);
      break;
    case "restart":
      await modeRestart(args, report);
      break;
    case "export":
      await modeExport(args, report);
      break;
    case "restore":
      await modeRestore(args, report);
      break;
    default:
      throw new Error(`未知模式：${args.mode}`);
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const report = {
    schema: HARNESS_VERSION,
    harness: "linux-install-check",
    mode: args.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    binary: path.basename(args.binary),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ok: false,
  };
  let code = 1;
  try {
    await run(args, report);
    code = report.ok ? 0 : 1;
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.stack ? error.stack : error)
      .split("\n")
      .slice(0, 6)
      .join("\n");
    code = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    const out = args.out ? path.resolve(args.out) : path.join(args.workDir, `${args.mode}.json`);
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      process.stderr.write(`无法写入 ${out}: ${error.message}\n`);
      code = 1;
    }
    process.stdout.write(
      [
        `mode: ${report.mode} | ok: ${report.ok}`,
        `binary: ${report.binary}`,
        ...(report.error ? [`error: ${report.error.split("\n")[0]}`] : []),
      ].join("\n") + "\n",
    );
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
