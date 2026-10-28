import fs from "node:fs";
import path from "node:path";
import { invoke, invokeSafe } from "../lib/app.mjs";
import { CdpPage } from "../lib/cdp.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const PAGE_COUNTER = `(() => {
  for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) return text;
  }
  return null;
})()`;

const READER_STATE = `(() => {
  const imgs = [...document.querySelectorAll("img.reader-img[data-idx]")];
  // 文档级错误卡（PDF 打开失败）带稳定码；逐页失败态在 .reader-cell 里、没有稳定码。
  const errorCard = document.querySelector(".reader-err[data-error-code]");
  const cellErrors = [...document.querySelectorAll(".reader-cell .reader-err")];
  return {
    root: !!document.querySelector(".reader-root"),
    hash: location.hash,
    images: imgs.length,
    loaded: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
    indexes: imgs.map((img) => Number(img.getAttribute("data-idx"))),
    label: (() => {
      for (const el of document.querySelectorAll("[data-reader-hud] .mono")) {
        const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (/^\\d+\\s*\\/\\s*\\d+$/.test(text)) return text;
      }
      return null;
    })(),
    error: (() => {
      const err = document.querySelector(".reader-err");
      return err ? (err.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200) : null;
    })(),
    // 稳定错误码（pdf-encrypted / pdf-not-valid / ...）；没有错误卡时为 null。
    errorCode: errorCard ? errorCard.getAttribute("data-error-code") : null,
    // 逐页失败态（渲染期失败）：页面格里的 .reader-err。
    pageFailures: cellErrors.length,
    cells: document.querySelectorAll(".reader-cell").length,
    transform: (() => {
      const pages = document.querySelector(".reader-pages");
      return pages ? (pages.style.transform || "") : "";
    })(),
  };
})()`;

/**
 * 同时最多持有的 PDF 文档数（对应 `src/features/pdf/document.ts` 的
 * `PDF_MAX_OPEN_DOCUMENTS`）。超出时按 LRU 淘汰并真正终止 worker。
 */
const PDF_MAX_OPEN_DOCUMENTS = 4;

/**
 * 允许的跨源白名单。
 *
 * 只有 Tauri 自身的 IPC 通道算「应用内通信」，不是文档内容发起的网络请求。
 * 注意：比较必须用**精确 origin**（见 `classifyRequest`），不能用 startsWith。
 */
const ALLOWED_FOREIGN_ORIGINS = [
  "http://ipc.localhost",
  "https://ipc.localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageNumbers(label) {
  const match = String(label || "").match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { page: Number(match[1]), total: Number(match[2]) } : null;
}

/** 等待阅读器渲染出至少一张已解码的页面图。 */
async function waitForRenderedPage(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.eval(READER_STATE);
    if (state.loaded > 0) return state;
    if (state.error) return state;
    await sleep(250);
  }
  return page.eval(READER_STATE);
}

/**
 * 「下一页」方向键。
 *
 * 阅读器方向是 RTL（日式）还是 LTR 决定了左右键的含义：
 * RTL 下 ArrowLeft = 下一页，LTR 下 ArrowRight = 下一页。
 * 测试必须跟随真实方向，不能假定某个固定按键。
 */
async function nextKey(page) {
  const dir = await page.eval(`localStorage.getItem("mr-reader-dir") || "rtl"`);
  return dir === "ltr" ? "ArrowRight" : "ArrowLeft";
}

async function prevKey(page) {
  const dir = await page.eval(`localStorage.getItem("mr-reader-dir") || "rtl"`);
  return dir === "ltr" ? "ArrowLeft" : "ArrowRight";
}

/** 等待页码指示达到目标页（1 基）。 */
async function waitForPage(page, target, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.eval(READER_STATE);
    const numbers = pageNumbers(state.label);
    if (numbers && numbers.page === target && state.loaded > 0) return state;
    await sleep(200);
  }
  return page.eval(READER_STATE);
}

/** 打开阅读器并等待阅读器根节点出现（路由/首帧可能比 hash 变化晚）。 */
async function openReader(page, id, timeout = 25_000) {
  await page.eval(
    `location.hash = ${JSON.stringify(`#/reader/${encodeURIComponent(id)}`)}; true`,
  );
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hasRoot = await page
      .eval("!!document.querySelector('.reader-root')")
      .catch(() => false);
    if (hasRoot) return true;
    await sleep(250);
  }
  return false;
}

/**
 * worker target（pdf.js 的 worker 是应用唯一的 Web Worker）。
 *
 * 开发态下 Vite 的 `?worker` 产物 URL 形如
 * `/src/features/pdf/pdf.worker.min.mjs?worker_file&type=module`，
 * 生产态是带哈希的静态资源；两种都含 pdf/worker 字样。
 */
function isPdfWorkerTarget(target) {
  if (!target) return false;
  if (target.type !== "worker" && target.type !== "shared_worker") return false;
  return /pdf|worker/i.test(String(target.url || ""));
}

/**
 * 判断一个请求 URL 是否越界（第三方源）。
 *
 * 关键点：必须按**精确 origin** 比较 —— 用 startsWith 会把
 * `http://ipc.localhost.evil.tld/` 这类域名一起放行。
 *
 * @param {string} url 请求 URL
 * @param {string} appOrigin 应用自身 origin
 */
function classifyRequest(url, appOrigin) {
  const raw = String(url ?? "");
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, origin: null, reason: "无法解析的请求 URL" };
  }
  // data:/blob: 是本地资源，devtools: 是调试协议，都不是网络请求。
  if (
    parsed.protocol === "data:" ||
    parsed.protocol === "blob:" ||
    parsed.protocol === "devtools:"
  ) {
    return {
      allowed: true,
      origin: parsed.origin,
      reason: `允许的协议 ${parsed.protocol}`,
    };
  }
  if (appOrigin && parsed.origin === appOrigin) {
    return { allowed: true, origin: parsed.origin, reason: "应用自身源" };
  }
  if (ALLOWED_FOREIGN_ORIGINS.includes(parsed.origin)) {
    return { allowed: true, origin: parsed.origin, reason: "Tauri IPC 源" };
  }
  return { allowed: false, origin: parsed.origin, reason: "第三方源" };
}

/**
 * CDP 级网络观察器。
 *
 * 只看主线程的 `performance.getEntriesByType("resource")` 是不够的：
 * pdf.js 的 **worker** 里发起的 fetch 根本不会出现在主线程的资源计时里，
 * 于是「文档触发了外部请求」这类断言可能空过。
 *
 * 因此这里在 CDP 层开启 Network 域：
 * - 主页面 target：收集 `Network.requestWillBeSent`；
 * - pdf.js worker target：另开一条 WebSocket 连接，同样开启 Network 域。
 *
 * worker target 没有 Page 域，`CdpPage.connect` 会在 `open()` 的
 * `Page.enable` 上抛错；此时退化为「容忍 open 失败」的连接方式
 * （WebSocket 已连上、事件分发已装好，Network 域照常可用）。
 */
class NetworkObserver {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {{url:string, source:string}[]} */
    this.requests = [];
    /** @type {Map<string, CdpPage>} */
    this.workers = new Map();
    /** @type {{id:string,url:string,networkEnabled:boolean,connectError:string|null,networkError:string|null}[]} */
    this.workerInfo = [];
    this.mainEnabled = false;
    this.mainError = null;
    this.running = false;
    this.pollPromise = null;
  }

  async start() {
    const page = this.ctx.page;
    // 先订阅再开域，避免漏掉第一批事件。
    this.mainUnsub = page.on("Network.requestWillBeSent", (params) => {
      this.requests.push({
        url: String(params?.request?.url ?? ""),
        source: "main",
      });
    });
    try {
      await page.send("Network.enable");
      this.mainEnabled = true;
    } catch (error) {
      this.mainError = String(error?.message ?? error);
    }
    this.running = true;
    this.pollPromise = this.#pollWorkers();
  }

  /** 轮询 CDP target，把新出现的 pdf.js worker 挂上 Network 域。 */
  async #pollWorkers() {
    while (this.running) {
      try {
        const targets = await this.ctx.targets();
        for (const target of targets) {
          if (!isPdfWorkerTarget(target)) continue;
          if (this.workers.has(target.id)) continue;
          await this.#attachWorker(target);
        }
      } catch {
        /* 轮询失败不影响主流程 */
      }
      await sleep(150);
    }
  }

  async #attachWorker(target) {
    let workerPage = null;
    let connectError = null;
    try {
      workerPage = await CdpPage.connect(target, this.ctx.cdpPort);
    } catch (error) {
      connectError = String(error?.message ?? error);
      // worker target 不支持 Page 域：connect() 失败，但 socket 与事件分发已就绪。
      workerPage = new CdpPage(target, this.ctx.cdpPort);
      try {
        await workerPage.open();
      } catch (openError) {
        connectError = `${connectError} / ${String(openError?.message ?? openError)}`;
      }
    }
    workerPage.on("Network.requestWillBeSent", (params) => {
      this.requests.push({
        url: String(params?.request?.url ?? ""),
        source: `worker:${target.id}`,
      });
    });
    let networkEnabled = false;
    let networkError = null;
    try {
      await workerPage.send("Network.enable");
      networkEnabled = true;
    } catch (error) {
      networkError = String(error?.message ?? error);
    }
    this.workers.set(target.id, workerPage);
    this.workerInfo.push({
      id: target.id,
      url: String(target.url || ""),
      networkEnabled,
      connectError,
      networkError,
    });
  }

  /** 等待至少挂上一个 pdf worker target。 */
  async waitForWorker(timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.workerInfo.length > 0) return true;
      await sleep(150);
    }
    return this.workerInfo.length > 0;
  }

  /** 当前已观察到的请求条数（用作时间窗口的游标）。 */
  mark() {
    return this.requests.length;
  }

  /** 某个游标之后新增的请求。 */
  since(mark) {
    return this.requests.slice(mark);
  }

  /** 已挂上的 worker 里实际观察到的请求数。 */
  workerRequestCount() {
    return this.requests.filter((entry) =>
      entry.source.startsWith("worker:"),
    ).length;
  }

  async stop() {
    this.running = false;
    await this.pollPromise?.catch(() => {});
    try {
      this.mainUnsub?.();
    } catch {
      /* ignore */
    }
    for (const workerPage of this.workers.values()) {
      await workerPage.close().catch(() => {});
    }
    this.workers.clear();
  }
}

/**
 * 收集页面未捕获异常（`Runtime.exceptionThrown`）。
 *
 * 「受控失败」的定义之一就是**不得**冒出未捕获异常。
 */
function watchUncaughtExceptions(page) {
  const exceptions = [];
  const unsubscribe = page.on("Runtime.exceptionThrown", (params) => {
    const details = params?.exceptionDetails ?? {};
    exceptions.push(
      String(
        details.exception?.description ||
          details.text ||
          details.exception?.value ||
          "未捕获异常",
      ).slice(0, 300),
    );
  });
  return { exceptions, unsubscribe };
}

export async function runPdfSuite(ctx, report) {
  let page = ctx.page;
  const pdfFixtures = ctx.fixtures.pdf;
  if (!pdfFixtures) {
    fail(report, {
      id: "pdf:fixture-missing",
      suite: "pdf",
      layer: "infrastructure",
      title: "PDF 夹具缺失，无法执行 PDF 套件",
      severity: "P0",
      details: "ctx.fixtures.pdf 缺失",
      location: "tests/qa/lib/fixtures.mjs",
    });
    return;
  }

  const books = await invoke(page, "list_books", { query: null });
  const byName = (fragment) =>
    books.find(
      (book) =>
        book.title.includes(fragment) ||
        book.path.toLowerCase().includes(fragment.toLowerCase()),
    );

  const valid = byName("qa-valid.pdf");
  const encrypted = byName("qa-encrypted.pdf");
  const scripted = byName("qa-javascript.pdf");
  const external = byName("qa-external.pdf");
  const truncated = byName("qa-truncated.pdf");

  /* ---------- 1) 书库集成：格式元数据 ---------- */
  if (!valid) {
    fail(report, {
      id: "pdf:library-import",
      suite: "pdf",
      layer: "integration",
      title: "合法 PDF 未入库",
      severity: "P1",
      details: "list_books 中找不到 qa-valid.pdf",
      location: "src-tauri/src/commands.rs: import_books",
      expected: "format=pdf 的书出现在书库",
      actual: "书库中不存在该 PDF",
    });
    return;
  }
  if (valid.format !== "pdf") {
    fail(report, {
      id: "pdf:library-format",
      suite: "pdf",
      layer: "integration",
      title: "PDF 的格式元数据不是 pdf",
      severity: "P1",
      details: `format=${valid.format}`,
      location: "src-tauri/src/db.rs",
      expected: "format=pdf",
      actual: String(valid.format),
    });
  } else {
    ok(report, {
      id: "pdf:library-format",
      suite: "pdf",
      layer: "integration",
      title: "PDF 以 format=pdf 入库且可区分于图片书",
      details: `title=${valid.title}`,
    });
  }

  /* ---------- 2) 导入阶段必须拒绝「不是 PDF」的文件 ---------- */
  // 策略：导入期只做「扩展名 + %PDF- 文件头」校验（后端不解析 PDF 结构），
  // 因此空文件 / 错签名 / 错扩展名必须被拒；结构损坏但文件头合法的文档会入库，
  // 由渲染期的受控错误兜底（见 pdf:malformed-controlled-error）。
  // 这三类夹具不进入全局导入序列（那会污染「每个导入路径都应入库」的不变式），
  // 由本套件单独导入并断言失败。
  const rejectedFiles = [
    ["qa-empty.pdf", pdfFixtures.emptyFile],
    ["qa-bad-magic.pdf", pdfFixtures.badMagicFile],
    ["qa-wrong-extension.txt", pdfFixtures.wrongExtFile],
  ];
  const rejectionErrors = [];
  for (const [name, file] of rejectedFiles) {
    const result = await invokeSafe(page, "import_books", { paths: [file] });
    const failed =
      result.ok === false ||
      (result.ok === true &&
        (result.value?.failed === 1 ||
          (result.value?.items ?? []).some((item) => item.status === "failed")));
    if (!failed) rejectionErrors.push(`${name} 未按失败处理`);
  }
  const booksAfterReject = await invokeSafe(page, "list_books", { query: null });
  const listAfterReject = Array.isArray(booksAfterReject.value)
    ? booksAfterReject.value
    : [];
  const leaked = rejectedFiles
    .filter(([name]) =>
      listAfterReject.some(
        (book) =>
          book.title.includes(name) ||
          book.path.toLowerCase().includes(name.toLowerCase()),
      ),
    )
    .map(([name]) => name);
  const rejectProblems = [...rejectionErrors, ...leaked.map((n) => `${n} 仍留在书库`)];
  if (rejectProblems.length) {
    fail(report, {
      id: "pdf:import-rejects-invalid",
      suite: "pdf",
      layer: "integration",
      title: "非 PDF 文件被错误入库",
      severity: "P1",
      details: rejectProblems.join(" | "),
      location: "src-tauri/src/source.rs: validate_pdf_document",
      expected: "空文件 / 错签名 / 错扩展名都不得进入书库",
      actual: rejectProblems.join(" | "),
    });
  } else {
    ok(report, {
      id: "pdf:import-rejects-invalid",
      suite: "pdf",
      layer: "integration",
      title: "空文件、错签名与错扩展名在导入阶段被拒绝",
      details: rejectedFiles.map(([name]) => name).join(", "),
    });
  }

  /* ---------- 3) 打开与渲染 ---------- */
  await openReader(page, valid.id);
  const first = await waitForRenderedPage(page);
  if (!first.root || first.loaded < 1) {
    fail(report, {
      id: "pdf:render",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 打开后未渲染出页面",
      severity: "P0",
      details: JSON.stringify(first),
      location: "src/features/pdf/* / src/pages/Reader.tsx",
      expected: "至少 1 张已解码的页面图",
      actual: JSON.stringify(first),
    });
    return;
  }
  ok(report, {
    id: "pdf:render",
    suite: "pdf",
    layer: "e2e",
    title: "PDF 打开并渲染出页面",
    details: `indexes=${JSON.stringify(first.indexes)} label=${first.label}`,
  });

  /* ---------- 4) 页码指示与总页数 ---------- */
  const counter = pageNumbers(first.label);
  if (!counter || counter.total !== pdfFixtures.expected.validPages) {
    fail(report, {
      id: "pdf:page-count",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 总页数与实际不符",
      severity: "P1",
      details: JSON.stringify({ label: first.label, counter }),
      location: "src/pages/Reader.tsx",
      expected: `总页数 ${pdfFixtures.expected.validPages}`,
      actual: String(first.label),
    });
  } else {
    ok(report, {
      id: "pdf:page-count",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 页码指示正确",
      details: String(first.label),
    });
  }

  /* ---------- 5) 上一页 / 下一页 ---------- */
  const forward = await nextKey(page);
  const backward = await prevKey(page);
  await page.key(forward);
  const second = await waitForPage(page, 2);
  if (pageNumbers(second.label)?.page !== 2 || !second.indexes.includes(1)) {
    fail(report, {
      id: "pdf:navigation",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 下一页不可用",
      severity: "P1",
      details: JSON.stringify({ key: forward, state: second }),
      location: "src/pages/Reader.tsx",
      expected: "页码变为 2/4 且渲染第 2 页",
      actual: JSON.stringify(second),
    });
  } else {
    ok(report, {
      id: "pdf:navigation",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 翻页正常",
      details: `label=${second.label} key=${forward}`,
    });
  }

  await page.key(backward);
  const back = await waitForPage(page, 1);
  if (pageNumbers(back.label)?.page !== 1) {
    fail(report, {
      id: "pdf:navigation-back",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 上一页不可用",
      severity: "P1",
      details: JSON.stringify({ key: backward, state: back }),
      location: "src/pages/Reader.tsx",
      expected: "页码回到 1/4",
      actual: JSON.stringify(back),
    });
  } else {
    ok(report, {
      id: "pdf:navigation-back",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 上一页正常",
      details: `label=${back.label} key=${backward}`,
    });
  }

  /* ---------- 6) 缩放 ---------- */
  const beforeZoom = (await page.eval(READER_STATE)).transform;
  const zoomClicked = await page.eval(`(() => {
    const button = document.querySelector('[data-testid="reader-zoom-in"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  const afterZoom = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const state = await page.eval(READER_STATE);
      if (state.transform !== beforeZoom.transform) return state;
      await sleep(150);
    }
    return page.eval(READER_STATE);
  })();
  const zoomChanged =
    zoomClicked && beforeZoom !== afterZoom.transform && /scale\(/.test(afterZoom.transform);
  if (!zoomChanged) {
    fail(report, {
      id: "pdf:zoom",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 缩放未生效",
      severity: "P1",
      details: JSON.stringify({ zoomClicked, beforeZoom, afterZoom: afterZoom.transform }),
      location: "src/pages/Reader.tsx",
      expected: "缩放后容器 transform 改变",
      actual: JSON.stringify({ beforeZoom, afterZoom: afterZoom.transform }),
    });
  } else {
    ok(report, {
      id: "pdf:zoom",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 缩放生效",
      details: afterZoom.transform,
    });
  }

  /* ---------- 7) 快速翻页不得显示过期页面 ---------- */
  await page.eval(`(async () => {
    for (let i = 0; i < 12; i += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(
        forward,
      )}, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return true;
  })()`);
  await sleep(1200);
  const afterRapid = await waitForRenderedPage(page);
  const rapidCounter = pageNumbers(afterRapid.label);
  const rapidOk =
    rapidCounter?.page === pdfFixtures.expected.validPages &&
    afterRapid.indexes.includes(pdfFixtures.expected.validPages - 1) &&
    afterRapid.loaded > 0;
  if (!rapidOk) {
    fail(report, {
      id: "pdf:rapid-navigation",
      suite: "pdf",
      layer: "e2e",
      title: "快速翻页后显示了过期页面",
      severity: "P1",
      details: JSON.stringify(afterRapid),
      location: "src/features/pdf/render.ts",
      expected: `停留在最后一页（第 ${pdfFixtures.expected.validPages} 页）且该页已解码`,
      actual: JSON.stringify(afterRapid),
    });
  } else {
    ok(report, {
      id: "pdf:rapid-navigation",
      suite: "pdf",
      layer: "e2e",
      title: "快速翻页后停在正确页面",
      details: `label=${afterRapid.label}`,
    });
  }

  /* ---------- 8) 适配模式：整页 / 整宽 ---------- */
  await openReader(page, valid.id);
  await waitForRenderedPage(page);
  const fitBefore = await page.eval(`(() => {
    const img = document.querySelector("img.reader-img");
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), fitWidth: img.classList.contains("reader-img-pdf-width") };
  })()`);
  // 「更多 → 阅读设置」弹层里的 PDF 适配组。
  const opened = await page.eval(`(() => {
    const more = document.querySelector('[data-testid="reader-more-open"]');
    if (!more) return false;
    more.click();
    return true;
  })()`);
  await sleep(400);
  const settingsOpened = await page.eval(`(() => {
    const button = document.querySelector('[data-testid="reader-settings-open"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(500);
  const fitClicked = await page.eval(`(() => {
    const button = document.querySelector('[data-testid="reader-pdf-fit-width"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1500);
  const fitAfter = await page.eval(`(() => {
    const img = document.querySelector("img.reader-img");
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      fitWidth: img.classList.contains("reader-img-pdf-width"),
    };
  })()`);
  const fitOk =
    opened &&
    settingsOpened &&
    fitClicked &&
    fitAfter !== null &&
    fitBefore !== null &&
    fitAfter.fitWidth === true &&
    fitAfter.height > fitBefore.height;
  if (!fitOk) {
    fail(report, {
      id: "pdf:fit-mode",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 适应宽度模式未生效",
      severity: "P1",
      details: JSON.stringify({ opened, settingsOpened, fitClicked, fitBefore, fitAfter }),
      location: "src/pages/Reader.tsx / src/components/Reader.css",
      expected: "切到整宽后页面高度大于整页模式（整页被高度约束、整宽溢出画布）",
      actual: JSON.stringify({ fitBefore, fitAfter }),
    });
  } else {
    ok(report, {
      id: "pdf:fit-mode",
      suite: "pdf",
      layer: "e2e",
      title: "PDF 整页 / 整宽适配模式可切换",
      details: `整页=${fitBefore?.width}x${fitBefore?.height} → 整宽=${fitAfter?.width}x${fitAfter?.height}`,
    });
  }
  // 复位成整页，避免影响后续用例。
  await page.eval(`(() => {
    const button = document.querySelector('[data-testid="reader-pdf-fit-page"]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(800);

  /* ---------- 9) 进度持久化与恢复（关闭阅读器后重新打开） ---------- */
  // 深链跳到第 3 页 → 关闭阅读器 → 重新打开 → 必须停回第 3 页。
  // 深链只在 Reader 挂载时生效，所以必须先离开阅读器再进。
  await ctx.goto("#/");
  await sleep(500);
  await page.eval(
    `location.hash = ${JSON.stringify(
      `#/reader/${encodeURIComponent(valid.id)}?page=3`,
    )}; true`,
  );
  await sleep(1200);
  const atThird = await waitForPage(page, 3);
  if (pageNumbers(atThird.label)?.page !== 3) {
    fail(report, {
      id: "pdf:progress-navigate",
      suite: "pdf",
      layer: "e2e",
      title: "无法翻到第 3 页（进度用例前置失败）",
      severity: "P1",
      details: JSON.stringify(atThird),
      location: "src/pages/Reader.tsx",
      expected: "第 3 页",
      actual: JSON.stringify(atThird),
    });
  } else {
    // 关闭阅读器（回书库）→ 阅读器卸载时立即落盘进度。
    await ctx.goto("#/");
    await sleep(900);
    await ctx.goto(`#/reader/${encodeURIComponent(valid.id)}`);
    const restored = await waitForRenderedPage(page);
    const restoredCounter = pageNumbers(restored.label);
    if (restoredCounter?.page !== 3) {
      fail(report, {
        id: "pdf:progress-restore",
        suite: "pdf",
        layer: "e2e",
        title: "PDF 阅读位置未恢复",
        severity: "P1",
        details: JSON.stringify(restored),
        location: "src/pages/Reader.tsx",
        expected: "重新打开后停在第 3 页",
        actual: JSON.stringify(restored),
      });
    } else {
      ok(report, {
        id: "pdf:progress-restore",
        suite: "pdf",
        layer: "e2e",
        title: "PDF 阅读位置可恢复（关闭后重新打开）",
        details: `label=${restored.label}`,
      });
    }
  }

  // 后端进度也必须落库（不只停留在内存快照），而且页码必须**等于**阅读器所在页。
  //
  // 坐标系：后端 `books.current_page` 是 0 基页索引（与 `applyRestore` 里的
  // `safePage` 同一坐标系），界面页码是 1 基 → 期望落库值 = 界面页码 - 1。
  // 进度写入有 500ms 防抖，因此这里在 ~3s 内轮询，等落盘稳定后再断言。
  const currentState = await page.eval(READER_STATE);
  const currentCounter = pageNumbers(currentState.label);
  const expectedStoredPage = currentCounter ? currentCounter.page - 1 : -1;
  let storedPage = -1;
  let storedProbe = null;
  if (expectedStoredPage >= 0) {
    const progressDeadline = Date.now() + 3000;
    while (Date.now() < progressDeadline) {
      storedProbe = await invokeSafe(page, "get_book", { bookId: valid.id });
      storedPage =
        storedProbe.ok && storedProbe.value
          ? Number(
              storedProbe.value.currentPage ?? storedProbe.value.current_page ?? -1,
            )
          : -1;
      if (storedPage === expectedStoredPage) break;
      await sleep(300);
    }
  }
  if (expectedStoredPage < 0) {
    fail(report, {
      id: "pdf:progress-persisted",
      suite: "pdf",
      layer: "integration",
      title: "无法确定阅读器当前页码，进度落库无法核对",
      severity: "P1",
      details: JSON.stringify(currentState),
      location: "src/pages/Reader.tsx",
      expected: "阅读器页码可读（1 基）",
      actual: String(currentState.label),
    });
  } else if (storedPage !== expectedStoredPage) {
    fail(report, {
      id: "pdf:progress-persisted",
      suite: "pdf",
      layer: "integration",
      title: "PDF 阅读进度页码与阅读器所在页不一致",
      severity: "P1",
      details: JSON.stringify({
        readerLabel: currentState.label,
        expectedStoredPage,
        storedPage,
        probe: storedProbe?.ok ? storedProbe.value : storedProbe?.error,
      }).slice(0, 400),
      location: "src-tauri/src/db.rs: set_progress",
      expected: `books.current_page=${expectedStoredPage}（0 基页索引）`,
      actual: `books.current_page=${storedPage}`,
    });
  } else {
    ok(report, {
      id: "pdf:progress-persisted",
      suite: "pdf",
      layer: "integration",
      title: "PDF 阅读进度已写入数据库且页码与阅读器一致",
      details: `reader=${currentState.label} current_page=${storedPage}（0 基）`,
    });
  }

  /* ---------- 10) 加密文档：受控错误（稳定码 pdf-encrypted） ---------- */
  if (!encrypted) {
    note(report, "加密 PDF 未入库，跳过加密用例（可能导入期已拒绝）");
  } else {
    await openReader(page, encrypted.id);
    await sleep(3000);
    const encState = await page.eval(READER_STATE);
    // 必须断言**具体稳定码**：只断言「出了某个错」无法区分「按策略拒绝了加密文档」
    // 与「碰巧报了别的错」。
    const encOk =
      encState.root &&
      encState.loaded === 0 &&
      encState.errorCode === "pdf-encrypted";
    if (!encOk) {
      fail(report, {
        id: "pdf:encrypted-controlled-error",
        suite: "pdf",
        layer: "e2e",
        title: "加密 PDF 未产生受控错误（稳定码不是 pdf-encrypted）",
        severity: "P1",
        details: JSON.stringify(encState),
        location: "src/features/pdf/document.ts / src/features/pdf/errors.ts",
        expected: "稳定码 pdf-encrypted 且不渲染任何页面",
        actual: `errorCode=${String(encState.errorCode)} loaded=${encState.loaded}`,
      });
    } else {
      ok(report, {
        id: "pdf:encrypted-controlled-error",
        suite: "pdf",
        layer: "e2e",
        title: "加密 PDF 产生受控错误（不弹口令、不落盘口令）",
        details: `errorCode=${encState.errorCode} text=${encState.error ?? ""}`,
      });
    }
  }

  /* ---------- 11) 结构损坏文档：受控错误（稳定码 pdf-not-valid） ---------- */
  if (!truncated) {
    note(report, "截断 PDF 未入库，跳过损坏文档用例");
  } else {
    await openReader(page, truncated.id);
    await sleep(3000);
    const badState = await page.eval(READER_STATE);
    const badOk =
      badState.root &&
      badState.loaded === 0 &&
      badState.errorCode === "pdf-not-valid";
    if (!badOk) {
      fail(report, {
        id: "pdf:malformed-controlled-error",
        suite: "pdf",
        layer: "e2e",
        title: "截断 PDF 未产生受控错误（稳定码不是 pdf-not-valid）",
        severity: "P1",
        details: JSON.stringify(badState),
        location: "src/features/pdf/document.ts / src/features/pdf/errors.ts",
        expected: "稳定码 pdf-not-valid 且不渲染任何页面",
        actual: `errorCode=${String(badState.errorCode)} loaded=${badState.loaded}`,
      });
    } else {
      ok(report, {
        id: "pdf:malformed-controlled-error",
        suite: "pdf",
        layer: "e2e",
        title: "截断 PDF 产生受控错误（不崩溃、不白屏）",
        details: `errorCode=${badState.errorCode} text=${badState.error ?? ""}`,
      });
    }
  }

  /* ---------- 12) 文档内嵌脚本不得被执行 ---------- */
  // 架构声明（PDF-4）：应用**不携带脚本沙箱** —— 随包发布的 pdf.js 产物里
  // 没有 quickjs-eval（由 tests/qa/lib/pdf-fixtures.test.mjs 的单测钉死），
  // 应用也从不在 getDocument 时开启脚本执行、不调用 doc.getJSActions()。
  // 因此「文档脚本无法被执行」是架构保证，而不是运行期开关。
  note(
    report,
    "PDF-4 架构声明：未打包 quickjs-eval 脚本沙箱，且应用不执行文档脚本（见 pdf-fixtures.test.mjs 单测）",
  );
  // 探针（三重）：
  // 1) 拦掉 alert/confirm/prompt —— PDF.js 的 app.alert 一旦被执行必然弹框；
  // 2) 夹具里的动作体带全局标记 —— 执行过就一定会留下 window.__moyuQaJsExecuted；
  // 3) 路由仍在阅读器上 —— 脚本若导航走了会暴露。
  const probeReady = await page
    .eval(`(() => {
      const w = window;
      w.__moyuQaJsExecuted = false;
      w.__moyuQaDialogs = [];
      if (!w.__moyuQaProbeInstalled) {
        w.__moyuQaProbeInstalled = true;
        for (const name of ["alert", "confirm", "prompt"]) {
          const original = w[name];
          w["__moyuQaOriginal_" + name] = original;
          w[name] = function (...args) {
            w.__moyuQaDialogs.push(name + ":" + args.map(String).join(","));
            return undefined;
          };
        }
      }
      return true;
    })()`)
    .catch(() => false);
  if (!scripted) {
    note(report, "含 JavaScript 的 PDF 未入库，跳过脚本执行用例");
  } else if (!probeReady) {
    fail(report, {
      id: "pdf:no-document-script-execution",
      suite: "pdf",
      layer: "e2e",
      title: "无法安装脚本执行探针，脚本安全性未被验证",
      severity: "P1",
      details: "页面里无法注入 alert/confirm/prompt 探针",
      location: "tests/qa/suites/pdf.mjs",
      expected: "探针可注入",
      actual: "注入失败",
    });
  } else {
    await openReader(page, scripted.id);
    await sleep(3000);
    const scriptState = await waitForRenderedPage(page);
    const scriptProbe = await page.eval(`(() => ({
      jsExecuted: window.__moyuQaJsExecuted === true,
      dialogs: Array.isArray(window.__moyuQaDialogs) ? window.__moyuQaDialogs.slice() : [],
      hash: location.hash,
      href: location.href,
      origin: location.origin,
    }))()`);
    const onReaderRoute =
      scriptProbe.hash.startsWith("#/reader/") &&
      scriptProbe.hash.includes(encodeURIComponent(scripted.id));
    const scriptOk =
      scriptState.root &&
      scriptState.loaded > 0 &&
      scriptProbe.jsExecuted === false &&
      scriptProbe.dialogs.length === 0 &&
      onReaderRoute;
    if (!scriptOk) {
      fail(report, {
        id: "pdf:no-document-script-execution",
        suite: "pdf",
        layer: "e2e",
        title: "PDF 内嵌脚本被执行了（或阅读器未正常打开该文档）",
        severity: "P1",
        details: JSON.stringify({ scriptProbe, loaded: scriptState.loaded }),
        location: "src/features/pdf/document.ts / src/pages/Reader.tsx",
        expected: "不弹框、不执行脚本体、不发生导航，且文档仍可正常阅读",
        actual: `jsExecuted=${scriptProbe.jsExecuted} dialogs=${scriptProbe.dialogs.length} hash=${scriptProbe.hash}`,
      });
    } else {
      ok(report, {
        id: "pdf:no-document-script-execution",
        suite: "pdf",
        layer: "e2e",
        title: "PDF 内嵌 JavaScript 未被执行（不弹框、不建全局变量、不导航）",
        details: `dialogs=${scriptProbe.dialogs.length} jsExecuted=${scriptProbe.jsExecuted} hash=${scriptProbe.hash}`,
      });
    }
    // 还原被探针替换的原生函数，避免影响后续用例。
    await page
      .eval(`(() => {
        const w = window;
        for (const name of ["alert", "confirm", "prompt"]) {
          const original = w["__moyuQaOriginal_" + name];
          if (typeof original === "function") w[name] = original;
          delete w["__moyuQaOriginal_" + name];
        }
        delete w.__moyuQaProbeInstalled;
        return true;
      })()`)
      .catch(() => {});
  }

  /* ---------- 13) 外部资源不得发起请求（CDP 级观察，含 worker） ---------- */
  // 打开多本新书之前先清空工作区页签（MAX_READER_TABS = 5），
  // 否则超限时工作区会回退到上一个页签，量到的就不是被测文档。
  await ctx.resetWorkspace().catch(() => {});
  page = ctx.page;
  const observer = new NetworkObserver(ctx);
  await observer.start();
  const appOrigin = await page.eval("location.origin").catch(() => "");
  for (const [book, label] of [
    [scripted, "javascript"],
    [external, "external"],
  ]) {
    if (!book) {
      note(report, `${label} PDF 未入库，跳过外部请求用例`);
      continue;
    }
    const mark = observer.mark();
    await openReader(page, book.id);
    await sleep(2500);
    const state = await waitForRenderedPage(page);
    // worker 是打开文档时才创建的：等它挂上 Network 域再收网。
    await observer.waitForWorker(5000);
    const observed = observer.since(mark);
    const violations = [];
    for (const entry of observed) {
      const verdict = classifyRequest(entry.url, appOrigin);
      if (!verdict.allowed) {
        violations.push(`${entry.source} → ${entry.url}（${verdict.origin}）`);
      }
    }
    if (violations.length) {
      fail(report, {
        id: `pdf:no-external-request:${label}`,
        suite: "pdf",
        layer: "e2e",
        title: "PDF 触发了外部网络请求",
        severity: "P0",
        details: violations.join(" | "),
        location: "src/features/pdf/document.ts",
        expected: "主线程与 pdf.js worker 都不得发起跨源请求",
        actual: violations.join(" | "),
      });
    } else {
      ok(report, {
        id: `pdf:no-external-request:${label}`,
        suite: "pdf",
        layer: "e2e",
        title: `含${label}动作的 PDF 未触发外部请求`,
        details: `observed=${observed.length} loaded=${state.loaded} origin=${appOrigin}`,
      });
    }
  }
  await observer.stop();

  // 观察本身必须有效：一条请求都没看到 ⇒ 「没有外部请求」无法证伪。
  // 这里按整段观察期统计（而不是单个夹具窗口）：SPA 里打开第二本书时
  // 可能一个请求都不产生，那属于正常现象，不代表观察失效。
  const totalObserved = observer.requests.length;
  if (totalObserved === 0) {
    fail(report, {
      id: "pdf:network-observation-active",
      suite: "pdf",
      layer: "e2e",
      title: "CDP 网络观察未捕获到任何请求，无法证伪「没有外部请求」",
      severity: "P2",
      details: JSON.stringify({
        mainEnabled: observer.mainEnabled,
        mainError: observer.mainError,
        workers: observer.workerInfo,
      }).slice(0, 400),
      location: "tests/qa/suites/pdf.mjs: NetworkObserver",
      expected: "Network.requestWillBeSent 至少被触发一次",
      actual: "0 条请求",
    });
  } else {
    ok(report, {
      id: "pdf:network-observation-active",
      suite: "pdf",
      layer: "e2e",
      title: "CDP 网络观察有效（已捕获请求）",
      details: `observed=${totalObserved} mainEnabled=${observer.mainEnabled} workers=${observer.workerInfo.length}`,
    });
  }

  // worker 侧观察能力本身也要有结论（否则「worker 没被看到」会被静默吞掉）。
  const workerAttached = observer.workerInfo.length > 0;
  const workerNetworkOn = observer.workerInfo.filter(
    (entry) => entry.networkEnabled,
  ).length;
  if (!workerAttached) {
    note(
      report,
      "PDF 套件诊断：未在 CDP target 列表里找到 pdf.js worker（type=worker），worker 侧网络观察未生效",
    );
    fail(report, {
      id: "pdf:worker-network-observed",
      suite: "pdf",
      layer: "e2e",
      title: "未能对 pdf.js worker 开启 CDP Network 域",
      severity: "P2",
      details: `workerTargets=0 mainNetworkEnabled=${observer.mainEnabled} mainError=${observer.mainError ?? ""}`,
      location: "tests/qa/suites/pdf.mjs: NetworkObserver",
      expected: "找到 pdf.js worker target 并开启 Network 域",
      actual: "worker target 未出现",
    });
  } else {
    const workerRequests = observer.workerRequestCount();
    if (workerNetworkOn === 0) {
      fail(report, {
        id: "pdf:worker-network-observed",
        suite: "pdf",
        layer: "e2e",
        title: "pdf.js worker 的 CDP Network 域开启失败",
        severity: "P2",
        details: JSON.stringify(observer.workerInfo).slice(0, 400),
        location: "tests/qa/suites/pdf.mjs: NetworkObserver",
        expected: "worker target 上 Network.enable 成功",
        actual: "Network.enable 失败",
      });
    } else {
      ok(report, {
        id: "pdf:worker-network-observed",
        suite: "pdf",
        layer: "e2e",
        title: "pdf.js worker 的请求已在 CDP 层被观察",
        details: `workers=${observer.workerInfo.length} workerRequests=${workerRequests} urls=${observer.workerInfo
          .map((entry) => entry.url)
          .join(",")
          .slice(0, 200)}`,
      });
    }
  }

  /* ---------- 14) 封面生成与缓存 ---------- */
  // 封面由书库卡片按需生成（BookCard → ensurePdfCover → put_pdf_thumbnail）。
  // 先把 PDF 卡片滚进视口，再断言后端缓存里有封面。
  await ctx.goto("#/");
  await page.waitFor("!!document.querySelector('main')", {
    timeout: 10_000,
    label: "library shell",
  });
  await page.eval(`(() => {
    const cards = [...document.querySelectorAll('[role="button"]')];
    const card = cards.find((el) => (el.textContent || "").includes("qa-valid"));
    if (card) card.scrollIntoView({ block: "center" });
    return !!card;
  })()`);
  const coverDeadline = Date.now() + 40_000;
  let cover = null;
  while (Date.now() < coverDeadline) {
    cover = await invokeSafe(page, "get_thumbnail", {
      bookId: valid.id,
      maxSize: 256,
    });
    if (cover.ok) break;
    await sleep(500);
  }
  const coverOk =
    cover?.ok &&
    typeof cover.value?.dataUrl === "string" &&
    cover.value.dataUrl.startsWith("data:image/") &&
    cover.value.dataUrl.length > 512;
  if (!coverOk) {
    fail(report, {
      id: "pdf:cover",
      suite: "pdf",
      layer: "integration",
      title: "PDF 封面未生成或未缓存",
      severity: "P1",
      details: JSON.stringify(cover ?? {}).slice(0, 300),
      location: "src/components/BookCard.tsx / src-tauri/src/commands.rs",
      expected: "get_thumbnail 返回 PDF 首页封面 data URL",
      actual: cover?.ok ? "封面为空" : String(cover?.error),
    });
  } else {
    ok(report, {
      id: "pdf:cover",
      suite: "pdf",
      layer: "integration",
      title: "PDF 封面可生成并复用",
      details: `bytes≈${cover.value.dataUrl.length}`,
    });
  }

  /* ---------- 15) 对抗性文档矩阵：异常尺寸 / 渲染失败 / 大文档 / 高页数 ---------- */
  // 打开多本新书之前先清空工作区页签（MAX_READER_TABS = 5），
  // 否则超限时工作区会回退到上一个页签，量到的就不是被测文档。
  await ctx.resetWorkspace().catch(() => {});
  page = ctx.page;
  // 每个文档都必须落到「可读」或「受控失败」两种结局之一；
  // 白屏、崩溃、无响应都不接受。
  const matrix = [
    ["odd-wide", pdfFixtures.oddWideFile],
    ["odd-tall", pdfFixtures.oddTallFile],
    // 损坏图像：PDF.js 会跳过这张图、页面照常渲染（优雅降级），
    // 因此它属于「可读」结局，渲染期失败由 qa-render-fail.pdf 承担。
    ["broken-image", pdfFixtures.brokenImageFile],
    ["large-6mb", pdfFixtures.largeFile],
    ["many-pages", pdfFixtures.manyPagesFile],
  ];
  const matrixProblems = [];
  const matrixRows = [];
  for (const [label, file] of matrix) {
    const imported = await invokeSafe(page, "import_books", { paths: [file] });
    const bookId =
      imported.ok && imported.value?.items?.[0]?.book?.id
        ? imported.value.items[0].book.id
        : null;
    if (!bookId) {
      matrixProblems.push(`${label} 未能入库`);
      continue;
    }
    const rootReady = await openReader(page, bookId, 40_000);
    const state = await waitForRenderedPage(page, 40_000);
    const settled = rootReady && (state.loaded > 0 || state.error !== null);
    matrixRows.push(
      `${label}: loaded=${state.loaded} error=${state.error ? "yes" : "no"}`,
    );
    if (!settled) {
      matrixProblems.push(
        `${label} 既未渲染也未进入受控失败态（root=${rootReady}）`,
      );
    }
  }
  if (matrixProblems.length) {
    fail(report, {
      id: "pdf:adversarial-matrix",
      suite: "pdf",
      layer: "e2e",
      title: "对抗性文档未落到可读/受控失败结局",
      severity: "P1",
      details: matrixProblems.join(" | ") + " | " + matrixRows.join(" | "),
      location: "src/features/pdf/*",
      expected: "每个文档都可读或给出受控错误",
      actual: matrixProblems.join(" | "),
    });
  } else {
    ok(report, {
      id: "pdf:adversarial-matrix",
      suite: "pdf",
      layer: "e2e",
      title: "异常尺寸 / 渲染失败 / 大文档 / 高页数文档全部落到受控结局",
      details: matrixRows.join(" | "),
    });
  }

  /* ---------- 16) 渲染期失败：必须落到受控结局（不是白屏、不是未捕获异常） ---------- */
  // 夹具 qa-render-fail.pdf：页面对象不是字典（而是流）、页面内容流是乱码。
  // 实测（pdfjs-dist 6.4.299，data 与 range 两种加载模式一致）：
  // 文档能打开，但 `doc.getPage(1)` 抛
  // "Page dictionary kid reference points to wrong type of object."
  // → 应用的渲染管线必然失败 → 必须给出**可见的失败态**。
  const renderFailImport = await invokeSafe(page, "import_books", {
    paths: [pdfFixtures.renderFailFile],
  });
  const renderFailId =
    renderFailImport.ok && renderFailImport.value?.items?.[0]?.book?.id
      ? renderFailImport.value.items[0].book.id
      : null;
  if (!renderFailId) {
    fail(report, {
      id: "pdf:render-failure-controlled",
      suite: "pdf",
      layer: "e2e",
      title: "渲染期失败夹具未能入库",
      severity: "P1",
      details: JSON.stringify(renderFailImport).slice(0, 300),
      location: "tests/qa/lib/pdf-fixtures.mjs",
      expected: "qa-render-fail.pdf 可导入",
      actual: "导入失败",
    });
  } else {
    await ctx.resetWorkspace().catch(() => {});
    page = ctx.page;
    const watcher = watchUncaughtExceptions(page);
    const rootReady = await openReader(page, renderFailId, 30_000);
    // 高负载 runner 上 PDF.js worker 初始化 + getPage 失败可能超过固定 4s；
    // 用有界条件等待替代固定 sleep，避免把「慢」误判为「白屏」。
    // 断言不变：最终仍必须出现错误卡或逐页失败态；不能因为残留图片
    // （loaded>0，例如上一本文档尚未卸载）就提前结束等待。
    let failState = await page.eval(READER_STATE);
    const failDeadline = Date.now() + 20_000;
    while (
      Date.now() < failDeadline &&
      failState.errorCode === null &&
      failState.pageFailures === 0
    ) {
      await sleep(250);
      failState = await page.eval(READER_STATE);
    }
    watcher.unsubscribe();
    const openDocs = await page
      .eval("globalThis.__moyuPdf?.openDocumentCount?.() ?? null")
      .catch(() => null);
    const controlled =
      failState.errorCode !== null || failState.pageFailures > 0;
    const renderFailProblems = [];
    if (!rootReady || !failState.root) {
      renderFailProblems.push("阅读器根节点缺失（白屏）");
    }
    if (!controlled) {
      renderFailProblems.push(
        "既没有文档级错误卡，也没有逐页失败态（不可见的失败）",
      );
    }
    if (watcher.exceptions.length > 0) {
      renderFailProblems.push(
        `出现未捕获异常：${watcher.exceptions.join(" | ")}`,
      );
    }
    if (renderFailProblems.length) {
      fail(report, {
        id: "pdf:render-failure-controlled",
        suite: "pdf",
        layer: "e2e",
        title: "渲染期失败没有落到受控结局",
        severity: "P1",
        details: JSON.stringify({
          rootReady,
          errorCode: failState.errorCode,
          pageFailures: failState.pageFailures,
          loaded: failState.loaded,
          cells: failState.cells,
          images: failState.images,
          label: failState.label,
          hash: failState.hash,
          openDocuments: openDocs,
          exceptions: watcher.exceptions,
        }).slice(0, 900),
        location: "src/features/pdf/render.ts / src/pages/Reader.tsx",
        expected: "显示错误卡或逐页失败态，且无未捕获异常",
        actual: renderFailProblems.join(" | "),
      });
    } else {
      ok(report, {
        id: "pdf:render-failure-controlled",
        suite: "pdf",
        layer: "e2e",
        title: "渲染期失败落到受控结局（错误卡/逐页失败态，无白屏、无未捕获异常）",
        details: `errorCode=${String(failState.errorCode)} pageFailures=${failState.pageFailures} loaded=${failState.loaded}`,
      });
    }
  }

  /* ---------- 17) 源文件消失：受控失败，不得白屏 ---------- */
  // 打开多本新书之前先清空工作区页签（MAX_READER_TABS = 5），
  // 否则超限时工作区会回退到上一个页签，量到的就不是被测文档。
  await ctx.resetWorkspace().catch(() => {});
  page = ctx.page;
  // 阶段 A：文件在**打开前**消失 → 必须给出「找不到文件」的受控错误；
  // 阶段 B：文件在**阅读中**消失 → 已解析进内存的内容可以继续读，
  //         若需要新的字节区间则失败，但两种结局都不允许崩溃/白屏。
  const vanishingFile = path.join(ctx.artifactDir, "qa-vanishing.pdf");
  try {
    fs.copyFileSync(pdfFixtures.validFile, vanishingFile);
    const imported = await invokeSafe(page, "import_books", {
      paths: [vanishingFile],
    });
    // import_books 返回 ImportResult：{ items: [{ path, status, book }], ... }
    const vanishingId =
      imported.ok && imported.value?.items?.[0]?.book?.id
        ? imported.value.items[0].book.id
        : null;
    if (!vanishingId) {
      fail(report, {
        id: "pdf:vanishing-source",
        suite: "pdf",
        layer: "e2e",
        title: "消失源文件夹具未能入库",
        severity: "P1",
        details: JSON.stringify(imported).slice(0, 300),
        location: "tests/qa/suites/pdf.mjs",
      });
    } else {
      // 阶段 A：先删文件再打开。
      fs.rmSync(vanishingFile, { force: true });
      const rootReady = await openReader(page, vanishingId, 20_000);
      await sleep(2500);
      const missingState = await page.eval(READER_STATE);
      const missingOk =
        rootReady && missingState.loaded === 0 && missingState.error !== null;
      if (!missingOk) {
        fail(report, {
          id: "pdf:vanishing-source-missing",
          suite: "pdf",
          layer: "e2e",
          title: "源文件缺失时未给出受控错误",
          severity: "P1",
          details: JSON.stringify({ rootReady, missingState }),
          location: "src/features/pdf/document.ts",
          expected: "阅读器仍在且显示受控错误，不渲染任何页面",
          actual: JSON.stringify(missingState),
        });
      } else {
        ok(report, {
          id: "pdf:vanishing-source-missing",
          suite: "pdf",
          layer: "e2e",
          title: "源文件缺失时给出受控错误（不崩溃、不白屏）",
          details: missingState.error,
        });
      }

      // 阶段 B：阅读期间删除源文件。
      const secondFile = path.join(ctx.artifactDir, "qa-vanishing-2.pdf");
      fs.copyFileSync(pdfFixtures.validFile, secondFile);
      const imported2 = await invokeSafe(page, "import_books", {
        paths: [secondFile],
      });
      const secondId =
        imported2.ok && imported2.value?.items?.[0]?.book?.id
          ? imported2.value.items[0].book.id
          : null;
      if (secondId) {
        await openReader(page, secondId, 20_000);
        await waitForRenderedPage(page);
        fs.rmSync(secondFile, { force: true });
        const forwardKey = await nextKey(page);
        await page.key(forwardKey);
        await sleep(2000);
        const duringState = await page.eval(READER_STATE);
        const duringOk =
          duringState.root === true &&
          (duringState.loaded > 0 || duringState.error !== null);
        if (!duringOk) {
          fail(report, {
            id: "pdf:vanishing-source-during",
            suite: "pdf",
            layer: "e2e",
            title: "阅读期间源文件消失后未落到受控结局",
            severity: "P1",
            details: JSON.stringify(duringState),
            location: "src/features/pdf/transport.ts / src/pages/Reader.tsx",
            expected: "继续可读或给出可见失败态，阅读器根节点仍在",
            actual: JSON.stringify(duringState),
          });
        } else {
          ok(report, {
            id: "pdf:vanishing-source-during",
            suite: "pdf",
            layer: "e2e",
            title: "阅读期间源文件消失后落到受控结局（不崩溃、不白屏）",
            details: `loaded=${duringState.loaded} error=${duringState.error ? "yes" : "no"}`,
          });
        }
      }
      fs.rmSync(secondFile, { force: true });
    }
  } catch (error) {
    fail(report, {
      id: "pdf:vanishing-source",
      suite: "pdf",
      layer: "e2e",
      title: "源文件消失用例执行异常",
      severity: "P1",
      details: String(error),
      location: "tests/qa/suites/pdf.mjs",
    });
  } finally {
    fs.rmSync(vanishingFile, { force: true });
  }

  /* ---------- 18) 资源回收：堆不无界增长 + 同时打开的文档数有上限 ---------- */
  // 打开多本新书之前先清空工作区页签（MAX_READER_TABS = 5），
  // 否则超限时工作区会回退到上一个页签，量到的就不是被测文档。
  await ctx.resetWorkspace().catch(() => {});
  page = ctx.page;
  // 用 WebView 渲染进程的 JS 堆作为证据：连续打开/关闭 PDF 阅读器若干轮后，
  // 堆占用不得无界增长（渲染任务、画布与 pdf.js 文档都必须被释放）。
  const heapOf = async () => {
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
  };
  await ctx.goto("#/");
  await sleep(1200);
  const heapBefore = await heapOf();
  const cycles = 5;
  for (let index = 0; index < cycles; index += 1) {
    await page.eval(
      `location.hash = ${JSON.stringify(
        `#/reader/${encodeURIComponent(valid.id)}`,
      )}; true`,
    );
    await sleep(1800);
    await page.eval("location.hash = '#/'; true");
    await sleep(700);
  }
  await sleep(1500);
  const heapAfter = await heapOf();
  const heapDeltaMb =
    heapBefore !== null && heapAfter !== null
      ? Math.round((heapAfter - heapBefore) / 1024 / 1024)
      : null;
  // 阈值：5 轮开关后堆增量不得超过 80MB（远大于正常抖动，又足以抓住无界增长）。
  // 指标拿不到时**不得**当成通过：无法观测就等于无法证明。
  if (heapDeltaMb === null) {
    fail(report, {
      id: "pdf:resource-cleanup",
      suite: "pdf",
      layer: "stress",
      title: "PDF 资源回收指标不可用，无法证明没有内存泄漏",
      severity: "P2",
      details: JSON.stringify({ heapBefore, heapAfter, cycles }),
      location: "tests/qa/suites/pdf.mjs: CDP Performance.getMetrics",
      expected: "拿到 JSHeapUsedSize 并证明 5 轮开关后增量 ≤ 80MB",
      actual: `JSHeapUsedSize 不可用（before=${heapBefore} after=${heapAfter}）`,
    });
    note(
      report,
      "PDF 套件诊断：CDP Performance.getMetrics 不可用，pdf:resource-cleanup 按失败记账（不视为通过）",
    );
  } else if (heapDeltaMb > 80) {
    fail(report, {
      id: "pdf:resource-cleanup",
      suite: "pdf",
      layer: "stress",
      title: "反复开关 PDF 阅读器后内存无界增长",
      severity: "P1",
      details: JSON.stringify({ heapBefore, heapAfter, heapDeltaMb, cycles }),
      location: "src/features/pdf/document.ts",
      expected: "5 轮开关后 JS 堆增量 ≤ 80MB",
      actual: `${heapDeltaMb}MB`,
    });
  } else {
    ok(report, {
      id: "pdf:resource-cleanup",
      suite: "pdf",
      layer: "stress",
      title: "反复开关 PDF 阅读器未出现内存无界增长",
      details: `cycles=${cycles} heapDelta=${heapDeltaMb}MB`,
    });
  }

  // LRU 上限：同时最多持有 PDF_MAX_OPEN_DOCUMENTS 份文档（超限按 LRU 淘汰，
  // 并真正终止对应 worker）。这里连续打开**超过上限**的不同 PDF，
  // 断言同时打开的文档数始终不超过上限。
  const lruCandidates = [
    ["lru-valid", pdfFixtures.validFile],
    ["lru-odd-wide", pdfFixtures.oddWideFile],
    ["lru-odd-tall", pdfFixtures.oddTallFile],
    ["lru-broken-image", pdfFixtures.brokenImageFile],
    ["lru-render-fail", pdfFixtures.renderFailFile],
  ];
  const lruBooks = [];
  for (const [label, file] of lruCandidates) {
    const imported = await invokeSafe(page, "import_books", { paths: [file] });
    const bookId =
      imported.ok && imported.value?.items?.[0]?.book?.id
        ? imported.value.items[0].book.id
        : null;
    if (!bookId) {
      lruBooks.push({ label, bookId: null });
      continue;
    }
    lruBooks.push({ label, bookId });
  }
  const readOpenDocumentCount = async (timeout = 5000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await page
        .eval(`(() => {
          const hook = globalThis.__moyuPdf;
          if (!hook || typeof hook.openDocumentCount !== "function") return null;
          return hook.openDocumentCount();
        })()`)
        .catch(() => null);
      if (last !== null) return last;
      await sleep(200);
    }
    return last;
  };
  const lruRows = [];
  const lruProblems = [];
  let lruBoundViolated = false;
  for (const entry of lruBooks) {
    if (!entry.bookId) {
      lruProblems.push(`${entry.label} 未能入库`);
      continue;
    }
    await openReader(page, entry.bookId, 30_000);
    await sleep(1200);
    const count = await readOpenDocumentCount();
    lruRows.push(`${entry.label}=${count === null ? "unavailable" : count}`);
    if (count === null) {
      lruProblems.push(
        `${entry.label}: 读不到 PDF 文档计数（开发期诊断钩子不可用）`,
      );
      continue;
    }
    if (count > PDF_MAX_OPEN_DOCUMENTS) {
      lruBoundViolated = true;
      lruProblems.push(
        `${entry.label}: 同时打开的文档数 ${count} 超过上限 ${PDF_MAX_OPEN_DOCUMENTS}`,
      );
    }
  }
  if (lruBooks.filter((entry) => entry.bookId).length <= PDF_MAX_OPEN_DOCUMENTS) {
    lruProblems.push(
      `只打开了 ${lruBooks.length} 本 PDF，未超过上限 ${PDF_MAX_OPEN_DOCUMENTS}，LRU 淘汰路径未被覆盖`,
    );
  }
  if (lruProblems.length) {
    fail(report, {
      id: "pdf:open-document-lru",
      suite: "pdf",
      layer: "stress",
      title: lruBoundViolated
        ? "同时打开的 PDF 文档数没有守住上限"
        : "PDF 文档数上限无法被验证",
      // 真的超限是 P1；只是观测不到（覆盖缺口）是 P2。
      severity: lruBoundViolated ? "P1" : "P2",
      details: `${lruProblems.join(" | ")} | ${lruRows.join(" | ")}`,
      location: "src/features/pdf/document.ts: evictOverflow",
      expected: `同时打开的文档数 ≤ ${PDF_MAX_OPEN_DOCUMENTS}`,
      actual: lruRows.join(" | "),
    });
  } else {
    ok(report, {
      id: "pdf:open-document-lru",
      suite: "pdf",
      layer: "stress",
      title: "同时打开的 PDF 文档数始终不超过 LRU 上限",
      details: `${lruRows.join(" | ")}（上限 ${PDF_MAX_OPEN_DOCUMENTS}）`,
    });
  }

  /* ---------- 19) 既有漫画阅读不受影响 ---------- */
  // 打开多本新书之前先清空工作区页签（MAX_READER_TABS = 5），
  // 否则超限时工作区会回退到上一个页签，量到的就不是被测文档。
  await ctx.resetWorkspace().catch(() => {});
  page = ctx.page;
  // 放在备份/恢复之前：恢复会替换数据库文件 afterwards 的书库状态可能变化。
  const local = books.find((book) => book.title.includes("QA Local Folder"));
  if (!local) {
    fail(report, {
      id: "pdf:no-regression",
      suite: "pdf",
      layer: "integration",
      title: "本地文件夹夹具缺失，无法验证回归",
      severity: "P1",
      details: "书库中找不到 QA Local Folder",
      location: "tests/qa/lib/fixtures.mjs",
    });
  } else {
    // 用 eval 直接改 hash 并回读实际值：路由若把 URL 规范化（例如去掉 ?page=），
    // 等「完全相等」会超时；这里以「读到阅读器根节点」为准。
    await page.eval(
      `location.hash = ${JSON.stringify(
        `#/reader/${encodeURIComponent(local.id)}`,
      )}; true`,
    );
    await sleep(800);
    const hashNow = await page.eval("location.hash");
    let hasRoot = true;
    try {
      await page.waitFor("!!document.querySelector('.reader-root')", {
        timeout: 10_000,
        label: "manga reader root",
      });
    } catch {
      hasRoot = false;
    }
    const manga = await waitForRenderedPage(page);
    if (!hasRoot || !manga.root || manga.loaded < 1) {
      fail(report, {
        id: "pdf:no-regression",
        suite: "pdf",
        layer: "e2e",
        title: "PDF 改造后图片漫画阅读失效",
        severity: "P0",
        details: JSON.stringify({ hashNow, hasRoot, manga }),
        location: "src/pages/Reader.tsx",
        expected: "文件夹漫画仍可逐页渲染",
        actual: JSON.stringify({ hashNow, hasRoot, manga }),
      });
    } else {
      ok(report, {
        id: "pdf:no-regression",
        suite: "pdf",
        layer: "e2e",
        title: "图片漫画阅读未受影响",
        details: `label=${manga.label}`,
      });
    }
  }

  /* ---------- 20) 备份/恢复保留 PDF 格式与进度 ---------- */
  // 诊断：收尾时记录安全模式与路由状态（供跨套件串扰排查）。
  const tailSafeMode = await invokeSafe(page, "get_safe_mode_state");
  const tailHash = await page.eval("location.hash").catch(() => "<unavailable>");
  note(
    report,
    `PDF 套件收尾诊断：safe_mode=${JSON.stringify(tailSafeMode)} hash=${tailHash}`,
  );

  const backupFile = path.join(ctx.artifactDir, "pdf-backup.mrbackup");
  const exported = await invokeSafe(page, "export_backup", {
    destPath: backupFile,
    preferencesJson: null,
  });
  if (!exported.ok) {
    fail(report, {
      id: "pdf:backup-export",
      suite: "pdf",
      layer: "integration",
      title: "含 PDF 的书库无法导出备份",
      severity: "P1",
      details: String(exported.error),
      location: "src-tauri/src/backup.rs",
      expected: "导出成功",
      actual: String(exported.error),
    });
  } else {
    // 恢复契约：备份里存在当前不可达的书路径时，后端要求显式确认
    // （错误前缀 restore-skipped-books:<n>），确认之前不发生任何写入。
    // 夹具必须走完「被拒 → 数据未被改动 → 显式确认 → 恢复成功 → 快照可用」，
    // 否则测的就不是产品真实契约。
    const libraryProjection = (value) =>
      (Array.isArray(value) ? value : [])
        .map((book) => ({
          id: book.id,
          format: book.format,
          path: book.path,
          currentPage: Number(book.currentPage),
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const beforeRestore = await invokeSafe(page, "list_books", { query: null });
    const refused = await invokeSafe(page, "import_backup", {
      sourcePath: backupFile,
    });
    const refusalReason = String(refused.error || "");
    const needsConfirmation = refusalReason.includes("restore-skipped-books:");

    if (!refused.ok && !needsConfirmation) {
      fail(report, {
        id: "pdf:backup-restore",
        suite: "pdf",
        layer: "integration",
        title: "备份恢复失败且原因不是「需要确认」",
        severity: "P1",
        details: refusalReason.slice(0, 300),
        location: "src-tauri/src/backup.rs",
        expected: "要么成功，要么要求显式确认",
        actual: refusalReason.slice(0, 200),
      });
    }

    if (needsConfirmation) {
      // 1) 被拒时原有书库数据不得被改动。
      const afterRefusal = await invokeSafe(page, "list_books", { query: null });
      const before = JSON.stringify(libraryProjection(beforeRestore.value));
      const after = JSON.stringify(libraryProjection(afterRefusal.value));
      if (before !== after) {
        fail(report, {
          id: "pdf:backup-no-write-on-refusal",
          suite: "pdf",
          layer: "integration",
          title: "恢复被拒绝后原有书库数据仍被改动",
          severity: "P1",
          details: JSON.stringify({ before, after }).slice(0, 400),
          location: "src-tauri/src/backup.rs",
          expected: "拒绝时不写入任何数据",
          actual: "拒绝后书库投影发生变化",
        });
      } else {
        ok(report, {
          id: "pdf:backup-no-write-on-refusal",
          suite: "pdf",
          layer: "integration",
          title: "恢复被拒后未写入任何数据",
          details: refusalReason.slice(0, 160),
        });
      }
    }

    // 2) 显式确认后重试（本环境没有不可达书籍时，第一次已直接成功）。
    const restored = needsConfirmation
      ? await invokeSafe(page, "import_backup", {
          sourcePath: backupFile,
          allowSkipped: true,
        })
      : refused;
    const booksAfter = await invokeSafe(page, "list_books", { query: null });
    const list = Array.isArray(booksAfter.value) ? booksAfter.value : [];
    const same = list.find((book) => book.id === valid.id);
    const okRestore =
      restored.ok &&
      same !== undefined &&
      same.format === "pdf" &&
      Number(same.currentPage) === storedPage;
    if (!okRestore) {
      fail(report, {
        id: "pdf:backup-roundtrip",
        suite: "pdf",
        layer: "integration",
        title: "备份恢复后 PDF 格式或进度丢失",
        severity: "P1",
        details: JSON.stringify({
          restored: restored.ok ? restored.value : restored.error,
          same: same ?? null,
          expectedCurrentPage: storedPage,
        }).slice(0, 400),
        location: "src-tauri/src/backup.rs",
        expected: "format=pdf 且 current_page 不变",
        actual: same ? `format=${same.format}, current_page=${same.currentPage}` : "书已消失",
      });
    } else {
      ok(report, {
        id: "pdf:backup-roundtrip",
        suite: "pdf",
        layer: "integration",
        title: "备份恢复保留 PDF 格式与阅读进度",
        details: `format=${same.format}, current_page=${same.currentPage}`,
      });
    }

    // 3) 恢复前快照必须真实存在且可用于恢复（它是唯一的回滚依据）。
    const restoreValue = restored?.value ?? null;
    const snapshotPath =
      (restoreValue && (restoreValue.pre_restore_snapshot || restoreValue.preRestoreSnapshot)) ||
      null;
    if (!snapshotPath) {
      fail(report, {
        id: "pdf:backup-snapshot-missing",
        suite: "pdf",
        layer: "integration",
        title: "恢复后没有返回恢复前快照",
        severity: "P1",
        details: JSON.stringify(restoreValue ?? null).slice(0, 300),
        location: "src-tauri/src/backup.rs",
        expected: "返回 pre_restore_snapshot 路径",
        actual: "未返回",
      });
    } else {
      const exists = fs.existsSync(snapshotPath);
      let isSqlite = false;
      let hasLibrarySchema = false;
      if (exists) {
        const raw = fs.readFileSync(snapshotPath);
        isSqlite = raw.subarray(0, 16).toString("latin1").startsWith("SQLite format 3");
        hasLibrarySchema = raw.toString("latin1").includes("books");
      }
      if (!exists || !isSqlite || !hasLibrarySchema) {
        fail(report, {
          id: "pdf:backup-snapshot-invalid",
          suite: "pdf",
          layer: "integration",
          title: "恢复前快照不是可用的书库快照",
          severity: "P1",
          details: JSON.stringify({
            snapshotPath,
            exists,
            isSqlite,
            hasLibrarySchema,
          }).slice(0, 300),
          location: "src-tauri/src/backup.rs",
          expected: "快照存在且是含 books 表的 SQLite 库",
          actual: `exists=${exists} sqlite=${isSqlite} books=${hasLibrarySchema}`,
        });
      } else {
        ok(report, {
          id: "pdf:backup-snapshot-usable",
          suite: "pdf",
          layer: "integration",
          title: "恢复前快照存在且可作为回滚依据",
          details: `snapshot=${snapshotPath}`,
        });
      }
    }
  }
}
