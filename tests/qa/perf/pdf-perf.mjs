#!/usr/bin/env node
/**
 * PDF 性能测量（PDF-4）。
 *
 * 目标：用**可重复**的方式测出代表性指标，并把环境、文档大小与页数一起记录，
 * 避免给出「通用性能保证」这种无法验证的结论。
 *
 * 覆盖（字段名必须与实际测量一致；报告里的 `metricSemantics` 是唯一权威）：
 * - openMs            导航到阅读器路由 → 阅读器根节点出现
 * - firstPageMs       导航 → 第一页解码完成（含 PDF 解析）
 * - navigationMs[]    按下翻页键 → 目标页解码完成
 * - zoomMs            点击放大 → 页面变换更新
 * - pageCount         **真实页数**（阅读器 HUD 页码计数器；PDF 刚入库时 SQLite 里是 0）
 * - coverGenerateMs   封面生成（渲染首页 + 写回后端）
 * - coverWriteBackMs  put_pdf_thumbnail 的 IPC 往返耗时
 * - rendererHeapUsedBytes  WebView **渲染进程** JS 堆（CDP Performance.getMetrics）
 * - rustProcessRssMb       Rust 主进程 RSS（**不含** WebView 渲染进程）
 *
 * 两条硬规则：
 * 1. 每个数字都来自真实测量，禁止硬编码或编造；测不到就写 null 并说明原因。
 * 2. 名字必须说清楚「测的是什么」：例如 RSS 不含渲染进程，就不能叫「渲染进程内存」。
 *
 * 用法：node tests/qa/perf/pdf-perf.mjs
 * 前置：已执行 cargo build（QA 需要 src-tauri/target/debug 下的二进制）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startQaApp } from "../lib/app.mjs";
import { connectResponsiveMain } from "../lib/cdp.mjs";
import { createPdfFixtures } from "../lib/pdf-fixtures.mjs";

const QA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(QA_ROOT, "..", "..");
const ARTIFACT_ROOT = path.join(QA_ROOT, "artifacts", "perf");
const FIXTURE_ROOT = path.join(ARTIFACT_ROOT, "pdf-fixtures");
const DATA_DIR = path.join(ARTIFACT_ROOT, "data");
const REPORT_PATH = path.join(QA_ROOT, "reports", "pdf-perf.json");
const CDP_PORT = Number(process.env.QA_CDP_PORT || "9336");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 阅读器页面状态快照：就绪标志、已解码页数、当前页、HUD 页码计数器。 */
const PAGE_STATE = `(() => {
  const imgs = [...document.querySelectorAll("img.reader-img[data-idx]")];
  return {
    ready: !!document.querySelector(".reader-root"),
    loaded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
    index: imgs.length ? Number(imgs[0].getAttribute("data-idx")) : -1,
    label: (() => {
      for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
        const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) return text;
      }
      return null;
    })(),
    transform: document.querySelector(".reader-pages")?.style.transform || "",
  };
})()`;

/**
 * invoke 记录器：包装 `window.__TAURI_INTERNALS__.invoke`，记录
 * `get_thumbnail` / `put_pdf_thumbnail` 的调用时刻、目标书与结果。
 *
 * 这是 QA 侧的事务性观测：只读地旁路观察应用自己的调用序列，
 * 不改应用代码，也不改变调用语义（参数原样透传、异常原样抛出）。
 */
const INSTALL_INVOKE_RECORDER = `(() => {
  try {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return false;
    if (window.__moyuPerfRecorderInstalled) return true;
    const events = [];
    const original = internals.invoke;
    internals.invoke = async function (...callArgs) {
      const cmd = callArgs[0];
      const args = callArgs[1];
      const tracked = cmd === "get_thumbnail" || cmd === "put_pdf_thumbnail";
      const t0 = performance.now();
      try {
        const value = await original.apply(internals, callArgs);
        if (tracked) {
          events.push({
            cmd,
            bookId: args && args.bookId ? args.bookId : null,
            ok: true,
            t0,
            t1: performance.now(),
          });
        }
        return value;
      } catch (error) {
        if (tracked) {
          events.push({
            cmd,
            bookId: args && args.bookId ? args.bookId : null,
            ok: false,
            error: String(error),
            t0,
            t1: performance.now(),
          });
        }
        throw error;
      }
    };
    window.__moyuPerfEvents = events;
    window.__moyuPerfRecorderInstalled = true;
    return true;
  } catch (error) {
    // 记录器装不上（例如 internals 被冻结）：其余测量照常，只是少了写回耗时。
    return false;
  }
})()`;

const READ_INVOKE_EVENTS = `(() => (Array.isArray(window.__moyuPerfEvents) ? window.__moyuPerfEvents.slice() : []))()`;

const CLEAR_INVOKE_EVENTS = `(() => {
  if (Array.isArray(window.__moyuPerfEvents)) window.__moyuPerfEvents.length = 0;
  return true;
})()`;

/**
 * 直接调用前端的封面生成函数并计时。
 *
 * 走的是应用自己的实现（`ensurePdfCover`：渲染首页 → `put_pdf_thumbnail` 写回），
 * 因此测到的是真实封面生成成本，而不是「轮询间隔」。
 */
const GENERATE_COVER = `(async (bookId) => {
  const specifiers = ["/src/features/pdf/index.ts", "/src/features/pdf/cover.ts"];
  const errors = [];
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const fn = mod && mod.ensurePdfCover;
      if (typeof fn !== "function") {
        errors.push(specifier + "：没有 ensurePdfCover 导出");
        continue;
      }
      const t0 = performance.now();
      const dataUrl = await fn(bookId, 256);
      const t1 = performance.now();
      if (typeof dataUrl !== "string" || !dataUrl) {
        errors.push(specifier + "：封面生成返回空");
        continue;
      }
      const comma = dataUrl.indexOf(",");
      const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
      return {
        ms: t1 - t0,
        dataUrlChars: dataUrl.length,
        bytes: Math.floor((payload.length * 3) / 4) - padding,
        specifier,
      };
    } catch (error) {
      errors.push(specifier + "：" + String(error && error.message ? error.message : error));
    }
  }
  return { error: errors.join(" | ") };
})`;

async function waitFor(page, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      // 页面重载/重连期间求值会失败：继续等，不要把瞬时错误当成测量失败。
      lastError = error;
    }
    await sleep(60);
  }
  if (lastError) {
    console.warn(`[perf] 等待条件超时（最后一次错误）：${lastError.message}`);
  }
  return false;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 解析 HUD 页码计数器（"3/120" / "3 / 120"）→ { current, total }。 */
function parsePageLabel(label) {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(label ?? "").trim());
  if (!match) return null;
  return { current: Number(match[1]), total: Number(match[2]) };
}

/** 等应用就绪（Tauri IPC 注入完成）。 */
async function waitAppReady(page, timeout = 30_000) {
  return waitFor(
    page,
    async () =>
      (await page.eval(
        `document.readyState === "complete" && !!window.__TAURI_INTERNALS__`,
      )) === true,
    timeout,
  );
}

/**
 * 重载页面并等应用重新就绪。
 *
 * 重载是必要的：PDF 文档句柄住在**前端模块级 LRU 缓存**里，只有新建 JS 上下文
 * 才能让下一次打开回到真正的「冷文档」状态（否则打开耗时会被上一轮测量污染）。
 * `__moyuPerfReloadMark` 用来确认重载真的发生了（而不是 reload 调用被吞掉）。
 *
 * 重载可能让旧的 CDP 连接失效：短时等待不成就重新连接一次，并把新连接写回
 * `session.page`（调用方必须从 session 取当前 page，不能缓存旧引用）。
 */
async function reloadApp(session) {
  const page = session.page;
  await page
    .eval(
      `window.__moyuPerfReloadMark = 1; setTimeout(() => location.reload(), 60); true`,
    )
    .catch(() => {});
  const reloaded = await waitFor(
    page,
    async () => (await page.eval(`!window.__moyuPerfReloadMark`)) === true,
    15_000,
  );
  if (!reloaded) throw new Error("页面重载未生效（reload 标记仍在）");
  if (!(await waitAppReady(page, 6000))) {
    session.page = await connectResponsiveMain(session.cdpPort);
    if (!(await waitAppReady(session.page))) {
      throw new Error("重载后应用未就绪");
    }
  }
  await sleep(500);
}

async function installRecorder(page) {
  return (await page.eval(INSTALL_INVOKE_RECORDER)) === true;
}

async function readRecorder(page) {
  const events = await page.eval(READ_INVOKE_EVENTS);
  return Array.isArray(events) ? events : [];
}

async function clearRecorder(page) {
  await page.eval(CLEAR_INVOKE_EVENTS);
}

/** 渲染进程 JS 堆（字节）：反映 WebView 渲染侧的真实占用。 */
async function rendererHeapBytes(page) {
  try {
    await page.send("Performance.enable");
    const metrics = await page.send("Performance.getMetrics");
    const entry = (metrics?.metrics ?? []).find(
      (item) => item.name === "JSHeapUsedSize",
    );
    return entry ? Number(entry.value) : null;
  } catch {
    return null;
  }
}

/** 尽力触发一次 GC，让各次采样可比（失败不影响测量本身）。 */
async function collectGarbage(page) {
  try {
    await page.send("HeapProfiler.enable");
    await page.send("HeapProfiler.collectGarbage");
  } catch {
    /* 可选能力：拿不到就照常采样 */
  }
}

/**
 * Rust 主进程 RSS（MB）。
 *
 * 注意：`get_memory_stats` 走 `sysinfo` 统计的是**本进程**，**不含** WebView
 * 渲染进程，所以它不能用来判断「渲染侧是否被释放」。
 */
async function rustProcessRssMb(page) {
  try {
    const stats = await page.eval(
      `window.__TAURI_INTERNALS__.invoke("get_memory_stats")`,
    );
    const value = Number(stats?.processMb);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 后端是否已经能提供封面（读 L2 缓存命中即说明封面已生成），
 * 顺带量出封面本身的字节数（base64 解码后的真实长度）。
 */
async function coverInfo(page, bookId) {
  const empty = { readable: false, dataUrlChars: null, bytes: null };
  try {
    const cover = await page.eval(
      `(async () => {
        try {
          const img = await window.__TAURI_INTERNALS__.invoke("get_thumbnail", { bookId: ${JSON.stringify(
            bookId,
          )}, maxSize: 256 });
          return { ok: true, dataUrl: img && img.dataUrl ? String(img.dataUrl) : null };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()`,
    );
    const dataUrl = cover?.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl) return empty;
    const comma = dataUrl.indexOf(",");
    const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return {
      readable: true,
      dataUrlChars: dataUrl.length,
      bytes: Math.floor((payload.length * 3) / 4) - padding,
    };
  } catch {
    return empty;
  }
}

/** 把目标书的卡片滚到视口里（IntersectionObserver 才会触发封面生成）。 */
async function scrollCardIntoView(page, book) {
  const fragment = path.basename(book.path).replace(/\.pdf$/i, "");
  await page
    .eval(
      `(() => {
        const cards = [...document.querySelectorAll('[role="button"]')];
        const card = cards.find((el) => (el.textContent || "").includes(${JSON.stringify(
          fragment,
        )}));
        if (card) card.scrollIntoView({ block: "center" });
        return true;
      })()`,
    )
    .catch(() => {});
}

/**
 * 兜底测量：经**应用自己的书库卡片路径**观测封面生成。
 *
 * 做法：清掉封面缓存 → 换路由让书库卡片重新挂载 → IntersectionObserver 触发
 * `get_thumbnail`（返回 `pdf-cover-missing`）→ 应用调用 `ensurePdfCover` 生成并
 * `put_pdf_thumbnail` 写回。用 invoke 记录器掐出这两个时刻之间的真实耗时。
 *
 * 局限：书库里其它 PDF 的封面也会一起排队重建，因此该数字含封面队列排队时间
 * （报告里会写明口径）。
 */
async function measureCoverViaLibrary(page, book) {
  await clearRecorder(page);
  await page
    .eval(`window.__TAURI_INTERNALS__.invoke("clear_thumbnail_cache")`)
    .catch(() => {});
  await page.eval("location.hash = '#/settings'; true").catch(() => {});
  await sleep(400);
  await page.eval("location.hash = '#/'; true").catch(() => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await scrollCardIntoView(page, book);
    const events = await readRecorder(page);
    const miss = events.find(
      (event) =>
        event.cmd === "get_thumbnail" &&
        event.ok === false &&
        String(event.error || "").includes("pdf-cover-missing") &&
        event.bookId === book.id,
    );
    const write = events.find(
      (event) =>
        event.cmd === "put_pdf_thumbnail" &&
        event.ok === true &&
        event.bookId === book.id &&
        (!miss || event.t0 >= miss.t1),
    );
    if (miss && write) {
      return {
        ms: Math.round(write.t0 - miss.t1),
        writeBackMs: Math.round(write.t1 - write.t0),
        scope:
          "经书库卡片路径观测：从应用拿到 pdf-cover-missing 到 put_pdf_thumbnail 写回开始（含封面串行队列排队与首页渲染）",
      };
    }
    await sleep(40);
  }
  return { error: "等待封面生成事件超时" };
}

/** 单个文档的测量流程。 */
async function measureDocument(session, book, label) {
  const result = {
    label,
    title: book.title,
    fileBytes: fs.statSync(book.path).size,
    /** 真实页数：来自阅读器 HUD 页码计数器（PDF 入库时后端页数是 0）。 */
    pageCount: null,
    pageCountSource: null,
    /** 入库后 SQLite 里的 `books.page_count`（PDF 首次打开前恒为 0）。 */
    dbPageCountBeforeOpen: Number(book.pageCount) || 0,
    /** 阅读器打开后回写进 SQLite 的真实页数。 */
    dbPageCountAfterOpen: null,
    openMs: null,
    firstPageMs: null,
    navigationMs: [],
    zoomMs: null,
    /** 封面生成耗时（含 PDF 解析 + 首页渲染 + 写回后端）。 */
    coverGenerateMs: null,
    coverGenerateScope: "",
    coverWriteBackMs: null,
    coverBytes: null,
    coverDataUrlChars: null,
    coverReadable: null,
    /** 渲染进程 JS 堆（字节）：beforeOpen / inReader / afterClose / 差值。 */
    rendererHeapUsedBytes: {
      beforeOpen: null,
      inReader: null,
      afterClose: null,
      deltaAfterClose: null,
    },
    /** Rust 主进程 RSS（MB）：**不含** WebView 渲染进程。 */
    rustProcessRssMb: {
      beforeOpen: null,
      inReader: null,
      afterClose: null,
    },
  };

  /* ---------- 1) 封面生成（冷文档） ---------- */
  // 必须排在阅读器测量之前：封面生成会把文档解析进前端 LRU 缓存，
  // 复用同一份缓存会让后面的「首次打开」数字偏乐观。
  await reloadApp(session);
  const coverPage = session.page;
  await installRecorder(coverPage);
  await clearRecorder(coverPage);
  const cover = await coverPage.eval(
    `${GENERATE_COVER}(${JSON.stringify(book.id)})`,
  );
  const coverEvents = await readRecorder(coverPage);
  const write = coverEvents.find(
    (event) =>
      event.cmd === "put_pdf_thumbnail" &&
      event.ok === true &&
      event.bookId === book.id,
  );
  if (cover && typeof cover.ms === "number") {
    result.coverGenerateMs = Math.round(cover.ms);
    result.coverGenerateScope =
      "冷文档：PDF 解析 + 首页渲染(256px) + put_pdf_thumbnail 写回（前端 ensurePdfCover 计时）";
    result.coverDataUrlChars = cover.dataUrlChars ?? null;
    result.coverBytes = cover.bytes ?? null;
  } else {
    // 直接调用前端模块不可用时，退回「观测应用自己的封面生成路径」。
    const fallback = await measureCoverViaLibrary(coverPage, book);
    if (typeof fallback.ms === "number") {
      result.coverGenerateMs = fallback.ms;
      result.coverGenerateScope = fallback.scope;
      result.coverWriteBackMs = fallback.writeBackMs ?? null;
    } else {
      result.coverGenerateMs = null;
      result.coverGenerateScope = `未测到：${cover?.error ?? "未知原因"}`;
    }
  }
  if (result.coverWriteBackMs === null && write) {
    result.coverWriteBackMs = Math.round(write.t1 - write.t0);
  }
  const coverStat = await coverInfo(coverPage, book.id);
  result.coverReadable = coverStat.readable;
  if (result.coverBytes === null) result.coverBytes = coverStat.bytes;
  if (result.coverDataUrlChars === null) {
    result.coverDataUrlChars = coverStat.dataUrlChars;
  }

  /* ---------- 2) 阅读器（冷文档） ---------- */
  // 再重载一次：把封面生成留下的 LRU 缓存清掉，阅读器的首次打开才是真的冷启动。
  await reloadApp(session);
  const page = session.page;
  await installRecorder(page);

  await collectGarbage(page);
  result.rendererHeapUsedBytes.beforeOpen = await rendererHeapBytes(page);
  result.rustProcessRssMb.beforeOpen = await rustProcessRssMb(page);

  const started = Date.now();
  await page.eval(
    `location.hash = ${JSON.stringify(`#/reader/${encodeURIComponent(book.id)}`)}; true`,
  );
  const ready = await waitFor(
    page,
    async () => (await page.eval(PAGE_STATE)).ready === true,
    30_000,
  );
  result.openMs = ready ? Date.now() - started : null;

  const painted = await waitFor(
    page,
    async () => (await page.eval(PAGE_STATE)).loaded > 0,
    60_000,
  );
  result.firstPageMs = painted ? Date.now() - started : null;

  // 真实页数：HUD 页码计数器显示的是 pdf.js 解析出的总页数（"3/120"）。
  const labelFound = await waitFor(
    page,
    async () => parsePageLabel((await page.eval(PAGE_STATE)).label) !== null,
    30_000,
  );
  if (labelFound) {
    const parsed = parsePageLabel((await page.eval(PAGE_STATE)).label);
    result.pageCount = parsed.total;
    result.pageCountSource = "reader-hud";
  }

  // 后端回写的页数（阅读器解析完成后调用 set_book_page_count）。
  try {
    const books = await page.eval(
      `window.__TAURI_INTERNALS__.invoke("list_books", { query: null })`,
    );
    const row = (Array.isArray(books) ? books : []).find(
      (entry) => entry.id === book.id,
    );
    result.dbPageCountAfterOpen = row ? Number(row.pageCount) || 0 : null;
  } catch {
    result.dbPageCountAfterOpen = null;
  }

  // 翻页延迟：连续翻 5 次，每次等到目标页解码完成。
  // 阅读方向决定「下一页」是哪个方向键（RTL 默认 ArrowLeft = 下一页）。
  const dir = await page.eval(`localStorage.getItem("mr-reader-dir") || "rtl"`);
  const forwardKey = dir === "ltr" ? "ArrowRight" : "ArrowLeft";
  for (let step = 0; step < 5; step += 1) {
    const before = await page.eval(PAGE_STATE);
    const navStarted = Date.now();
    await page.key(forwardKey);
    const moved = await waitFor(
      page,
      async () => {
        const state = await page.eval(PAGE_STATE);
        return state.loaded > 0 && state.index !== before.index;
      },
      20_000,
    );
    result.navigationMs.push(moved ? Date.now() - navStarted : null);
  }

  // 缩放响应：点 HUD 的放大按钮（阅读器没有绑定 +/- 快捷键）。
  const beforeZoom = await page.eval(PAGE_STATE);
  const zoomStarted = Date.now();
  await page.eval(`(() => {
    const button = document.querySelector('[data-testid="reader-zoom-in"]');
    if (button) button.click();
    return true;
  })()`);
  const zoomed = await waitFor(
    page,
    async () => (await page.eval(PAGE_STATE)).transform !== beforeZoom.transform,
    10_000,
  );
  result.zoomMs = zoomed ? Date.now() - zoomStarted : null;

  // 阅读器打开时的渲染侧占用。
  await collectGarbage(page);
  result.rendererHeapUsedBytes.inReader = await rendererHeapBytes(page);
  result.rustProcessRssMb.inReader = await rustProcessRssMb(page);

  /* ---------- 3) 关闭阅读器后的回收 ---------- */
  await page.eval("location.hash = '#/'; true");
  await sleep(1500);
  await collectGarbage(page);
  result.rendererHeapUsedBytes.afterClose = await rendererHeapBytes(page);
  result.rustProcessRssMb.afterClose = await rustProcessRssMb(page);
  if (
    result.rendererHeapUsedBytes.afterClose !== null &&
    result.rendererHeapUsedBytes.beforeOpen !== null
  ) {
    result.rendererHeapUsedBytes.deltaAfterClose =
      result.rendererHeapUsedBytes.afterClose -
      result.rendererHeapUsedBytes.beforeOpen;
  }

  return result;
}

function environment() {
  const cpus = os.cpus();
  return {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
  };
}

async function main() {
  // 隔离数据目录必须每次清空：QA 启动器拒绝复用已有书的目录。
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 8 });
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  fs.mkdirSync(path.join(QA_ROOT, "reports"), { recursive: true });
  const fixtures = createPdfFixtures(FIXTURE_ROOT);
  const ctx = await startQaApp({
    root: ROOT,
    artifactDir: ARTIFACT_ROOT,
    dataDir: DATA_DIR,
    fixtures: { importOrder: [], expected: {} },
    cdpPort: CDP_PORT,
  });
  const page = ctx.page;
  /** 当前可用的 CDP 连接：页面重载后可能被替换，必须从这里取。 */
  const session = { page, cdpPort: ctx.cdpPort };
  const measurements = [];
  // 记录 WebView2 / Chromium 版本：渲染性能与它强相关。
  const userAgent = await page.eval("navigator.userAgent").catch(() => "");
  try {
    const targets = [
      [fixtures.validFile, "valid-4p"],
      [fixtures.manyPagesFile, "many-120p"],
      [fixtures.largeFile, "large-6mb"],
    ];
    for (const [file, label] of targets) {
      await page.eval(
        `window.__TAURI_INTERNALS__.invoke("import_books", { paths: [${JSON.stringify(
          file,
        )}] })`,
      );
    }
    await page.eval("setTimeout(() => location.reload(), 60); true");
    await sleep(1500);
    await waitAppReady(page);
    const books = await page.eval(
      `window.__TAURI_INTERNALS__.invoke("list_books", { query: null })`,
    );
    const list = Array.isArray(books) ? books : [];
    // 等书库把封面生成完（封面是串行队列）：否则后面的打开耗时会被并发的
    // pdf.js 解析抢占 CPU，测出来的数字没有可比性。
    for (const entry of list) {
      await waitFor(
        page,
        async () => (await coverInfo(page, entry.id)).readable,
        60_000,
      );
    }
    for (const [file, label] of targets) {
      const book = list.find((entry) => entry.path === file);
      if (!book) {
        measurements.push({ label, error: "未入库" });
        continue;
      }
      const measured = await measureDocument(session, book, label);
      measurements.push(measured);
      console.log(
        `[perf] ${label}: open=${measured.openMs}ms firstPage=${measured.firstPageMs}ms ` +
          `navMedian=${median(measured.navigationMs.filter((v) => v !== null))}ms ` +
          `zoom=${measured.zoomMs}ms pages=${measured.pageCount} ` +
          `cover=${measured.coverGenerateMs}ms heapDelta=${measured.rendererHeapUsedBytes.deltaAfterClose}`,
      );
    }
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: { ...environment(), userAgent },
    metricSemantics: {
      openMs:
        "导航到 #/reader/<id> → 页面出现 .reader-root 的耗时（阅读器壳体就绪）",
      firstPageMs:
        "导航到 #/reader/<id> → 第一页图片解码完成的耗时（含 PDF 解析）",
      navigationMs:
        "按下翻页键 → 目标页解码完成的耗时（每次翻页一条）",
      zoomMs: "点击 HUD 放大按钮 → .reader-pages 的 transform 变化的耗时",
      pageCount:
        "真实页数：取自阅读器 HUD 页码计数器（pdf.js 解析结果），不是 SQLite 里的 0",
      dbPageCountBeforeOpen:
        "导入后、首次打开前 SQLite 里 books.page_count 的值（PDF 恒为 0）",
      dbPageCountAfterOpen:
        "阅读器解析完成后回写进 SQLite 的 books.page_count",
      coverGenerateMs:
        "封面生成耗时：前端 ensurePdfCover（冷文档：PDF 解析 + 首页渲染 256px + 写回后端）",
      coverWriteBackMs: "put_pdf_thumbnail 的 IPC 往返耗时（后端写回路径）",
      coverBytes: "生成封面的二进制字节数（base64 解码后的真实长度）",
      coverDataUrlChars: "封面 data URL 的字符串长度",
      rendererHeapUsedBytes:
        "WebView **渲染进程** 的 JS 堆占用（CDP Performance.getMetrics → JSHeapUsedSize）",
      rustProcessRssMb:
        "Rust 主进程 RSS（MB，来自 get_memory_stats；**不含** WebView 渲染进程）",
      "rendererHeapUsedBytes.deltaAfterClose":
        "关闭阅读器后的渲染进程 JS 堆 − 打开前的渲染进程 JS 堆（渲染侧是否真的释放）",
    },
    measurements,
    note:
      "测量在隔离数据目录与本机 debug 构建上进行；数值仅代表该环境，不代表通用性能保证。" +
      "封面生成与阅读器打开分别测，两次之间重载页面以保证 PDF 文档是冷状态（前端 LRU 缓存被清空）。",
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`[perf] 报告：${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
