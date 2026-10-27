#!/usr/bin/env node
/**
 * Linux PDF 运行时回归探针（WebKitGTK WebDriver）。
 *
 * 目的：在**真实 Linux WebKitGTK 运行时**里证明 PDF.js 的 CMap / 标准 14 字体
 * 资源能否通过生产 CSP。历史缺陷：页面 origin 是 `tauri://localhost`，而
 * `connect-src` 只有 `ipc:` 与 http(s) 变体、缺少 `'self'`，于是 PDF.js 在
 * Web Worker 里 `fetch("/pdf-assets/...")` 被 CSP 拦截，CJK CMap 与 Helvetica
 * 标准字体静默回退（渲染变丑，但不报错）。
 *
 * 为什么用「同源直取探针」而不是只读 Resource Timing：
 * PDF.js 的标准字体 / CMap 请求发生在 **worker** 内，按 Resource Timing 规范
 * 不会进入文档的 `performance.getEntriesByType("resource")`。因此本探针从
 * 同一个 `tauri://localhost` 文档、用同一个相对 URL 发起 fetch：
 *   - 请求被 CSP 拦截 ⇒ PDF.js 的 worker 请求同样被拦截（worker 继承
 *     文档 CSP；缺陷根因是 `connect-src` 缺 `'self'`）；
 *   - 请求成功、拿到字节 ⇒ 该 origin/path/directive 在运行时可用。
 * 同时仍会采集文档时间线（若 WebKit 把 worker 资源暴露出来，作为额外证据）。
 *
 * 运行时代拼接：WebDriver 会话创建后接管的是 wry 的 webview（`__TAURI_INTERNALS__`
 * 可用），但初始页面可能是 about:blank；本探针会显式导航到 `tauri://localhost/`
 * 并等待 SPA 挂载。这是 WebKitGTK 2.50 + Tauri 2 (wry 0.57) 实测必需的一步。
 *
 * 用法：
 *   node tests/qa/linux-pdf-runtime.mjs --binary <app> --port 9515 --out <json>
 *   node tests/qa/linux-pdf-runtime.mjs --binary <app> --out <json> --expect-csp-blocked
 *
 * 退出码：
 *   0  期望成立（修复后：全绿；--expect-csp-blocked：确实检测到缺陷）
 *   1  期望不成立
 *   2  探针自身失败（无法建会话、无法加载页面等）
 *
 * 只读使用 `tests/qa/lib/pdf-fixtures.mjs`；所有临时文件都在系统临时目录，
 * 数据目录 / 缓存 / WebKit profile 全部隔离，不触碰真实用户数据。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { makePdf } from "./lib/pdf-fixtures.mjs";

const HARNESS_VERSION = 1;
/** PDF.js 在 `useSystemFonts:false` 下为 Helvetica 请求的标准字体文件。 */
const STANDARD_FONT_FILE = "LiberationSans-Regular.ttf";
/** CFM 夹具使用的预定义 CMap（pdf.js 会请求同名 `.bcmap`）。 */
const CMAP_FILE = "UniGB-UCS2-H.bcmap";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    binary: "",
    port: 9515,
    out: "",
    expectCspBlocked: false,
    driver: process.env.MR_WEBKITWEBDRIVER || "/tmp/mr-webkit-driver/usr/bin/WebKitWebDriver",
    keepWork: false,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} 缺少参数`);
      return argv[i];
    };
    switch (arg) {
      case "--binary":
        out.binary = next();
        break;
      case "--port":
        out.port = Number(next());
        break;
      case "--out":
        out.out = next();
        break;
      case "--driver":
        out.driver = next();
        break;
      case "--timeout":
        out.timeoutMs = Number(next());
        break;
      case "--expect-csp-blocked":
        out.expectCspBlocked = true;
        break;
      case "--keep-work":
        out.keepWork = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!out.binary) throw new Error("缺少 --binary");
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error("--port 非法");
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      "用法: node tests/qa/linux-pdf-runtime.mjs --binary <path> [选项]",
      "",
      "  --binary <path>          被测 Tauri Linux 二进制（必需）",
      "  --port <n>               WebKitWebDriver 端口（默认 9515）",
      "  --out <json>             证据 JSON 输出路径（默认临时目录）",
      "  --driver <path>          WebKitWebDriver 路径（默认 /tmp/mr-webkit-driver/usr/bin/WebKitWebDriver）",
      "  --timeout <ms>           单个等待步骤上限（默认 180000）",
      "  --expect-csp-blocked     期望检测到「资源被 CSP 拦截」的缺陷（修复前二进制）",
      "  --keep-work              保留隔离数据目录（排障用）",
      "",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function basenameOf(value) {
  if (!value) return "";
  try {
    if (value.startsWith("data:")) return "data:";
    if (value.startsWith("blob:")) return "blob:";
    const url = new URL(value);
    const base = url.pathname.split("/").filter(Boolean).pop();
    return base || url.hostname || url.protocol;
  } catch {
    return "unknown";
  }
}

/** CSP 违规里不保留本机路径/查询串；tauri 源只保留 pathname。 */
function sanitizeUri(value) {
  if (!value) return "";
  if (value === "about:blank" || value === "inline" || value === "eval") return value;
  if (value.startsWith("data:")) return "data:";
  if (value.startsWith("blob:")) return "blob:";
  if (value.startsWith("tauri://localhost")) return sanitizeBlockedUri(value);
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return `file:${basenameOf(value)}`;
    const base = basenameOf(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/${base}`;
  } catch {
    return "unknown";
  }
}

/** 只保留 tauri://localhost 的 pathname，杜绝把用户主目录写进证据。 */
function sanitizeBlockedUri(value) {
  if (!value) return "";
  if (value.startsWith("tauri://localhost")) {
    try {
      return `tauri://localhost${new URL(value).pathname}`;
    } catch {
      return "tauri://localhost/…";
    }
  }
  return sanitizeUri(value);
}

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
    /* 非 JSON 错误页 */
  }
  return { status: res.status, json, text };
}

async function isDriverReady(port) {
  try {
    const res = await httpJson(port, "GET", "/status", null, 3000);
    return Boolean(res.json && res.json.value && res.json.value.ready);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 隔离目录与 WebDriver 进程                                            */
/* ------------------------------------------------------------------ */

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-linux-pdf-"));
  const dirs = {
    root,
    fixtures: path.join(root, "fixtures"),
    data: path.join(root, "data"),
    renderCache: path.join(root, "render_cache"),
    onlineCache: path.join(root, "online_cache"),
    xdgData: path.join(root, "xdg-data"),
    xdgCache: path.join(root, "xdg-cache"),
    xdgConfig: path.join(root, "xdg-config"),
    driverLog: path.join(root, "webkitwebdriver.log"),
  };
  for (const dir of [
    dirs.fixtures,
    dirs.data,
    dirs.renderCache,
    dirs.onlineCache,
    dirs.xdgData,
    dirs.xdgCache,
    dirs.xdgConfig,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

function spawnDriver({ driver, port, work }) {
  const log = fs.openSync(work.driverLog, "w");
  const env = {
    ...process.env,
    // wry 0.57：只有该环境变量为 true 才会 set_automation_allowed(true)。
    TAURI_WEBVIEW_AUTOMATION: "true",
    MR_DATA_DIR: work.data,
    MR_RENDER_CACHE_DIR: work.renderCache,
    MR_ONLINE_CACHE_DIR: work.onlineCache,
    XDG_DATA_HOME: work.xdgData,
    XDG_CACHE_HOME: work.xdgCache,
    XDG_CONFIG_HOME: work.xdgConfig,
    // WSLg / 无 GPU 环境下的稳定渲染路径；不改变产物行为。
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    GDK_BACKEND: process.env.GDK_BACKEND || "x11",
    NO_AT_BRIDGE: "1",
  };
  // WebKitWebDriver 只接受 `--port=<n>` / `-p <n>`；`--port <n>` 会打印用法并退出。
  const child = spawn(driver, [`--port=${port}`, "--host=local"], {
    env,
    stdio: ["ignore", log, log],
    detached: false,
  });
  child.on("error", () => {});
  return { child, log };
}

/* ------------------------------------------------------------------ */
/* 合成 PDF 夹具                                                       */
/* ------------------------------------------------------------------ */

/** 最小组装器：正确写 xref 偏移；对象按 1..N 编号。 */
function assemblePdf(objects) {
  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * 需要预定义 CMap 的 PDF：
 * - Type0 字体 + `/Encoding /UniGB-UCS2-H` + CIDFontType0 后代；
 * - 非内嵌 STSong-Light（CIDFont），所以 pdf.js 必须取 `cmaps/UniGB-UCS2-H.bcmap`；
 * - 页面内容用 UCS-2 大端写「中文」两个码位（4E2D 6587）。
 *
 * 期望资源请求（相对页面 origin）：
 *   /pdf-assets/cmaps/UniGB-UCS2-H.bcmap
 * 以及可能的 CID 字体回退标准字体（`/pdf-assets/standard_fonts/...`）。
 */
function makeCmapPdf() {
  const content = [
    "q",
    "0.97 0.97 0.99 rg",
    "0 0 595 842 re f",
    "Q",
    "BT",
    "/F1 40 Tf",
    "0.05 0.08 0.12 rg",
    "72 720 Td",
    "<4E2D6587> Tj",
    "ET",
  ].join("\n");
  const contentBytes = Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${contentBytes.length} >>\nstream\n`, "latin1"),
      contentBytes,
      Buffer.from("\nendstream", "latin1"),
    ]).toString("latin1"),
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
  ];
  return assemblePdf(objects);
}

function createFixtures(work) {
  const fonts = path.join(work.fixtures, "fonts-helvetica-4p.pdf");
  const cmap = path.join(work.fixtures, "cmap-unigb-1p.pdf");
  const script = path.join(work.fixtures, "doc-script-1p.pdf");
  fs.writeFileSync(fonts, makePdf({ pageCount: 4, label: "Moyu QA Linux" }));
  fs.writeFileSync(cmap, makeCmapPdf());
  fs.writeFileSync(script, makePdf({ pageCount: 1, label: "Moyu QA Script", withJavascript: true }));
  return { fonts, cmap, script };
}

/* ------------------------------------------------------------------ */
/* 页面内脚本                                                          */
/* ------------------------------------------------------------------ */

const INIT_SCRIPT = `
(() => {
  if (window.__mrHarness) return true;
  const state = {
    csp: [],
    alerts: 0,
    phase: "boot",
    policy: "",
    startedAt: performance.now(),
  };
  window.__mrHarness = state;
  document.addEventListener("securitypolicyviolation", (e) => {
    // originalPolicy 是运行时真正生效的策略（Linux 上 Tauri 以响应头下发，
    // 页面里没有 meta 标签），用它来证明 connect-src 的内容。
    if (!state.policy && e.originalPolicy) state.policy = e.originalPolicy;
    state.csp.push({
      directive: e.effectiveDirective || e.violatedDirective || "",
      blockedURI: e.blockedURI || "",
      disposition: e.disposition || "",
      phase: state.phase,
    });
  });
  const originalAlert = window.alert;
  window.alert = (message) => {
    state.alerts += 1;
    // 不真正弹模态框：WebDriver 会话会被 alert 阻塞。
    void message;
  };
  void originalAlert;
  return true;
})()
`;

const READ_CSP_META = `
return (() => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return meta ? meta.getAttribute("content") || "" : "";
})()
`;

const READ_STATE = `
return (() => {
  const root = document.querySelector("#root");
  const img = document.querySelector("img.reader-img[data-idx]");
  return {
    href: location.href,
    readyState: document.readyState,
    hasIpc: !!window.__TAURI_INTERNALS__,
    rootChildren: root ? root.children.length : -1,
    bodyLength: document.body ? document.body.innerHTML.length : 0,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    readerRoot: !!document.querySelector(".reader-root"),
    imgCount: document.querySelectorAll("img.reader-img[data-idx]").length,
    imgReady: !!(img && img.complete && img.naturalWidth > 0),
    imgPage: img ? Number(img.getAttribute("data-idx")) + 1 : 0,
    imgNaturalWidth: img ? img.naturalWidth : 0,
    imgSrcKind: img ? String(img.currentSrc || img.src).slice(0, 16) : "",
  };
})()
`;

const PIXEL_PROBE = `
return (() => {
  const img = document.querySelector("img.reader-img[data-idx]");
  if (!img || !img.complete || !img.naturalWidth) {
    return { ok: false, reason: "no-image" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { ok: false, reason: "no-2d-context" };
  try {
    ctx.drawImage(img, 0, 0, 48, 48);
    const data = ctx.getImageData(0, 0, 48, 48).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      min = Math.min(min, data[i], data[i + 1], data[i + 2]);
      max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    }
    return { ok: max - min > 8, range: max - min, naturalWidth: img.naturalWidth };
  } catch (err) {
    return { ok: false, reason: String(err && err.name ? err.name : err) };
  }
})()
`;

const IMPORT_SCRIPT = `
const done = arguments[arguments.length - 1];
const paths = arguments[0];
if (!window.__TAURI_INTERNALS__) {
  done({ ok: false, error: "no-tauri-ipc" });
} else {
  window.__TAURI_INTERNALS__.invoke("import_books", { paths })
    .then((result) => done({ ok: true, result }))
    .catch((error) => done({ ok: false, error: String(error) }));
}
`;

/** 同源直取：与 PDF.js 完全相同的 URL 与 directive（connect-src）。 */
const ASSET_PROBE_SCRIPT = `
const done = arguments[arguments.length - 1];
const url = arguments[0];
const started = performance.now();
fetch(url, { cache: "no-store" })
  .then(async (res) => {
    const buf = await res.arrayBuffer();
    done({ ok: res.ok, status: res.status, bytes: buf.byteLength, ms: Math.round(performance.now() - started) });
  })
  .catch((err) => done({ ok: false, error: String(err && err.name ? err.name : err), ms: Math.round(performance.now() - started) }));
`;

const EXTERNAL_FETCH_SCRIPT = `
const done = arguments[arguments.length - 1];
const url = arguments[0];
let settled = false;
const finish = (payload) => { if (!settled) { settled = true; done(payload); } };
setTimeout(() => finish({ outcome: "timeout" }), 8000);
fetch(url, { mode: "cors", cache: "no-store" })
  .then((res) => finish({ outcome: "resolved", status: res.status }))
  .catch((err) => finish({ outcome: "rejected", error: String(err && err.name ? err.name : err) }));
`;

/* ------------------------------------------------------------------ */
/* WebDriver 会话                                                      */
/* ------------------------------------------------------------------ */

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

  execAsync(script, args = [], timeoutMs = 60_000) {
    return this.request("POST", "/execute/async", { script, args }, timeoutMs);
  }

  async waitFor(label, predicateSource, timeoutMs, intervalMs = 150) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await this.exec(`return (${predicateSource});`);
      if (last) return true;
      await sleep(intervalMs);
    }
    throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
  }

  async navigate(url) {
    await this.request("POST", "/url", { url }, 60_000);
  }
}

async function createSession(port, binary, timeoutMs) {
  const option = { binary, args: ["--automation"] };
  const attempts = [
    { name: "webkitgtk:browserOptions(binary,args=[--automation])", caps: { "webkitgtk:browserOptions": option } },
    {
      name: "MiniBrowser + webkitgtk:browserOptions(binary,args=[--automation])",
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
      session.capability = `${attempt.name} → ${res.json.value.capabilities?.browserName || "?"} ${res.json.value.capabilities?.browserVersion || ""}`.trim();
      return session;
    }
    errors.push(`${attempt.name}: ${res.json?.value?.message || res.text.slice(0, 120)}`);
  }
  throw new Error(`无法建立 WebDriver 会话：${errors.join(" | ")}`);
}

/**
 * WebKitGTK 2.50 + wry：会话可能落在 about:blank 的页面；
 * 必须显式导航到 `tauri://localhost/` 并等待 SPA 挂载。
 */
async function attachAppPage(session, timeoutMs) {
  const handles = (await session.request("GET", "/window/handles")) || [];
  const hrefs = new Map();
  for (const handle of handles) {
    await session.request("POST", "/window", { handle });
    hrefs.set(handle, await session.exec("return location.href;"));
  }
  // 优先主页面（tauri://localhost/）；恢复窗（/recovery.html）不能作为驱动目标。
  let chosen = handles.find((h) => hrefs.get(h) === "tauri://localhost/") || null;
  if (!chosen) {
    chosen = handles.find((h) => {
      const href = hrefs.get(h);
      return typeof href === "string" && href.startsWith("tauri://localhost") && !href.includes("recovery");
    }) || null;
  }
  if (!chosen) {
    if (handles.length) {
      await session.request("POST", "/window", { handle: handles[0] });
      chosen = handles[0];
    }
    await session.navigate("tauri://localhost/");
  } else {
    // 上面的探测循环会把 current handle 留在最后一个窗口；必须在返回前
    // 重新切回选中的主页面，否则后续脚本会跑在 about:blank/旧窗口上。
    await session.request("POST", "/window", { handle: chosen });
  }
  // 给自动化窗口一个非零尺寸：PDF 渲染目标框按 innerWidth/innerHeight 计算。
  try {
    await session.request("POST", "/window/rect", { width: 1200, height: 800, x: 40, y: 40 });
  } catch {
    /* 某些窗口类型不允许设置 rect，忽略 */
  }
  await session.waitFor(
    "SPA 挂载",
    `!!window.__TAURI_INTERNALS__ && !!document.querySelector("#root") && document.querySelector("#root").children.length > 0`,
    timeoutMs,
    200,
  );
  return chosen || handles[0] || "current";
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 清掉上一次异常退出留下的同名应用进程（单实例插件会抢占 IPC）。 */
function killStaleInstances(binary) {
  const prefix = path.basename(binary).slice(0, 15);
  if (!prefix) return;
  for (const proc of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(proc)) continue;
    try {
      const name = fs.readFileSync(`/proc/${proc}/comm`, "utf8").trim();
      if (name.startsWith(prefix)) process.kill(Number(proc), "SIGTERM");
    } catch {
      /* 进程已退出或不属于当前用户 */
    }
  }
}

async function run(args, report) {
  const binary = path.resolve(args.binary);
  if (!fs.existsSync(binary)) throw new Error(`二进制不存在：${path.basename(binary)}`);
  if (!process.env.DISPLAY) throw new Error("缺少 DISPLAY（WSL2 需要 WSLg 的 :0）");

  const work = makeWorkspace();
  report.workDir = work.root;
  const fixtures = createFixtures(work);
  report.fixtures = {
    fonts: path.basename(fixtures.fonts),
    cmap: path.basename(fixtures.cmap),
    script: path.basename(fixtures.script),
  };

  let driverChild = null;
  let driverLog = null;
  let session = null;

  killStaleInstances(binary);
  await sleep(300);

  try {
    if (!(await isDriverReady(args.port))) {
      if (!fs.existsSync(args.driver)) {
        throw new Error(`WebKitWebDriver 不存在：${path.basename(args.driver)}（可用 --driver 指定）`);
      }
      const spawned = spawnDriver({ driver: args.driver, port: args.port, work });
      driverChild = spawned.child;
      driverLog = spawned.log;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !(await isDriverReady(args.port))) await sleep(200);
      if (!(await isDriverReady(args.port))) throw new Error("WebKitWebDriver 未在 15s 内就绪");
      report.driverSpawnedByHarness = true;
    } else {
      report.driverSpawnedByHarness = false;
    }
    report.webkitDriver = path.basename(args.driver);

    session = await createSession(args.port, binary, args.timeoutMs);
    report.capabilityUsed = session.capability;

    const handle = await attachAppPage(session, args.timeoutMs);
    report.pageHandle = handle;

    await session.request("POST", "/timeouts", { script: 180_000, pageLoad: 120_000, implicit: 0 });
    await session.exec(INIT_SCRIPT);

    const initial = await session.exec(READ_STATE);
    report.locationHref = sanitizeUri(initial.href);
    report.spaMounted = initial.rootChildren > 0;

    const cspMeta = (await session.exec(READ_CSP_META)) || "";
    report.cspMetaPresent = cspMeta.length > 0;

    // 1) 外部请求必须被 CSP 拦（修复前后都应成立）。
    await session.exec("window.__mrHarness.phase = 'external';");
    const external = await session.execAsync(EXTERNAL_FETCH_SCRIPT, ["https://example.com/mr-linux-pdf-runtime-probe"]);
    const externalViolations = await session.exec(
      "return window.__mrHarness.csp.splice(0).map((v) => ({...v}));",
    );
    report.externalProbe = external;
    report.cspViolations = (report.cspViolations || []).concat(externalViolations);
    report.externalBlocked = external?.outcome === "rejected" || (externalViolations || []).length > 0;

    // 2) 导入三份 PDF（全部位于数据目录之外）。
    await session.exec("window.__mrHarness.phase = 'import';");
    const imported = await session.execAsync(
      IMPORT_SCRIPT,
      [[fixtures.fonts, fixtures.cmap, fixtures.script]],
      180_000,
    );
    if (!imported?.ok) throw new Error(`import_books 失败：${imported?.error || "unknown"}`);
    const items = imported.result?.items || [];
    const byBase = new Map();
    for (const item of items) {
      byBase.set(path.basename(item.path || ""), item);
    }
    const idOf = (file) => {
      const item = byBase.get(path.basename(file));
      if (!item || !item.book || !item.book.id) {
        throw new Error(`导入未返回书 ID：${path.basename(file)}（status=${item?.status || "?"}）`);
      }
      return item.book.id;
    };
    report.importSummary = {
      added: imported.result?.added ?? 0,
      restored: imported.result?.restored ?? 0,
      skipped: imported.result?.skipped ?? 0,
      failed: imported.result?.failed ?? 0,
      statuses: items.map((i) => ({ file: path.basename(i.path || ""), status: i.status })),
    };

    const books = {
      fonts: idOf(fixtures.fonts),
      cmap: idOf(fixtures.cmap),
      script: idOf(fixtures.script),
    };

    const resourceBaseline = await session.exec(
      "return performance.getEntriesByType('resource').map((e) => e.name);",
    );
    const seenResources = [...resourceBaseline];

    const openBook = async (bookId, phase) => {
      // 回书库卸载 Reader，确保换书是全新挂载（Reader 的 open effect 依赖 bookId，
      // 但显式卸载能避免旧页 img 残留造成误判）。
      await session.exec(`window.__mrHarness.phase = ${JSON.stringify(phase)}; location.hash = "#/"; return true;`);
      await session.waitFor("回到书库", "!document.querySelector('.reader-root')", 15_000);
      await session.exec(
        `location.hash = "#/reader/" + ${JSON.stringify(encodeURIComponent(bookId))}; return location.hash;`,
      );
      await session.waitFor("阅读器挂载", "!!document.querySelector('.reader-root')", 60_000);
      await session.waitFor(
        "PDF 页渲染（naturalWidth>0）",
        `(() => { const img = document.querySelector("img.reader-img[data-idx]"); return !!(img && img.complete && img.naturalWidth > 0); })()`,
        60_000,
        200,
      );
      // 给 PDF.js 的 CMap/字体加载留出结算时间。
      await sleep(1500);
    };

    const phases = {};
    for (const [key, phase] of [
      ["fonts", "fonts"],
      ["cmap", "cmap"],
      ["script", "script"],
    ]) {
      const entry = {
        readerPage: 0,
        imgNaturalWidth: 0,
        imgCount: 0,
        pixel: { ok: false, reason: "not-probed" },
        alerts: 0,
        jsMarker: false,
        error: null,
      };
      try {
        await openBook(books[key], phase);
        const state = await session.exec(READ_STATE);
        entry.readerPage = state.imgPage;
        entry.imgNaturalWidth = state.imgNaturalWidth;
        entry.imgCount = state.imgCount;
        entry.pixel = await session.exec(PIXEL_PROBE);
      } catch (error) {
        // 单本书渲染失败不应吞掉探针结论（CSP 证据仍然有效）。
        entry.error = String(error && error.message ? error.message : error).slice(0, 240);
      }
      try {
        const snapshot = await session.exec(
          "return { csp: window.__mrHarness.csp.splice(0).map((v) => ({...v})), resources: performance.getEntriesByType('resource').map((e) => e.name), alerts: window.__mrHarness.alerts, jsMarker: window.__moyuQaJsExecuted === true };",
        );
        seenResources.push(...(snapshot.resources || []));
        report.cspViolations = (report.cspViolations || []).concat(snapshot.csp || []);
        entry.alerts = snapshot.alerts || 0;
        entry.jsMarker = snapshot.jsMarker === true;
      } catch {
        /* 页面已卸载 */
      }
      phases[key] = entry;
    }
    report.phases = phases;

    // 3) 同源直取探针：与 PDF.js worker 完全相同的 origin/path/directive。
    await session.exec("window.__mrHarness.phase = 'probe';");
    const probes = {
      standardFont: await session.execAsync(ASSET_PROBE_SCRIPT, [`/pdf-assets/standard_fonts/${STANDARD_FONT_FILE}`]),
      cmap: await session.execAsync(ASSET_PROBE_SCRIPT, [`/pdf-assets/cmaps/${CMAP_FILE}`]),
    };
    const probeViolations = await session.exec(
      "return window.__mrHarness.csp.splice(0).map((v) => ({...v}));",
    );
    report.cspViolations = (report.cspViolations || []).concat(probeViolations);
    report.assetProbes = probes;

    // 运行时生效策略：优先用 securitypolicyviolation.originalPolicy，
    // 其次才是 index.html 里的 meta（Linux 生产构建走响应头，meta 常常为空）。
    const runtimePolicy =
      (await session.exec("return window.__mrHarness.policy || '';")) || cspMeta || "";
    report.runtimeCspPolicy = runtimePolicy;
    report.cspPresent = Boolean(runtimePolicy) || (report.cspViolations || []).length > 0;
    report.cspDirectiveConnect = (runtimePolicy.match(/connect-src[^;]*/i) || [""])[0].trim();
    report.cspHasSelfInConnectSrc = /connect-src[^;]*'self'/i.test(runtimePolicy);
    report.cspHasTauriSchemeInConnectSrc = /connect-src[^;]*tauri:/i.test(runtimePolicy);

    // 汇总资源时间线（basename，去重，绝不写用户路径）。
    const allResources = [...new Set(seenResources.filter(Boolean))];
    const fontResources = allResources.filter((name) => /\/pdf-assets\/standard_fonts\//.test(name));
    const cmapResources = allResources.filter((name) => /\/pdf-assets\/cmaps\//.test(name));
    report.resourceNames = [...new Set(allResources.map(basenameOf))].sort().slice(0, 300);
    report.resourceTimelineCount = allResources.length;
    report.fontAssetsSeen = fontResources.length > 0;
    report.fontAssetFiles = fontResources.map(basenameOf);
    report.cmapAssetsSeen = cmapResources.length > 0;
    report.cmapAssetFiles = cmapResources.map(basenameOf);

    // 4) 结论字段。
    const violations = (report.cspViolations || []).map((v) => ({
      directive: v.directive || "",
      blockedURI: sanitizeBlockedUri(v.blockedURI || ""),
      disposition: v.disposition || "",
      phase: v.phase || "",
    }));
    report.cspViolations = violations;
    const localViolations = violations.filter(
      (v) =>
        /tauri:\/\/localhost/.test(v.blockedURI) ||
        /pdf-assets/.test(v.blockedURI) ||
        // WebKit 个别版本 blockedURI 为空：探针阶段的 connect-src 违规同样算数。
        (v.phase === "probe" && v.directive === "connect-src"),
    );
    report.localCspViolations = localViolations;
    // PDF.js 自己发出的资源请求（fonts/cmap/script 阶段），不含探针与外部请求。
    report.pdfjsAssetViolations = violations.filter(
      (v) => ["fonts", "cmap", "script"].includes(v.phase) && /pdf-assets/.test(v.blockedURI),
    );

    report.fontProbeOk = Boolean(probes.standardFont?.ok && probes.standardFont.bytes > 0);
    report.cmapProbeOk = Boolean(probes.cmap?.ok && probes.cmap.bytes > 0);
    report.cspViolationsForPdfAssets = localViolations.length > 0;
    report.externalBlocked = Boolean(report.externalBlocked);
    report.scriptExecuted = Object.values(phases).some((p) => p.jsMarker || p.alerts > 0);
    report.pixelOk = Object.values(phases).some((p) => p.pixel && p.pixel.ok);
    report.readerPage = phases.fonts?.readerPage || phases.cmap?.readerPage || 0;

    const reasons = [];
    if (args.expectCspBlocked) {
      // 缺陷模式：必须看到「资源取不到」或「tauri://localhost 被 CSP 拦」。
      const assetsMissing = !report.fontProbeOk || !report.cmapProbeOk;
      const pass = assetsMissing || report.cspViolationsForPdfAssets;
      if (!assetsMissing && !report.cspViolationsForPdfAssets) {
        reasons.push("未能复现 CSP 拦截：字体/CMap 探针成功且无 tauri://localhost 违规");
      }
      if (assetsMissing) reasons.push("PDF 资源探针被拒绝（预期缺陷）");
      if (report.cspViolationsForPdfAssets) reasons.push("观测到 pdf-assets 的 CSP 违规（预期缺陷）");
      report.verdict = pass ? "defect-detected" : "unexpected-pass";
      report.reasons = reasons;
      return pass;
    }

    if (!report.fontProbeOk) reasons.push(`标准字体探针失败：${JSON.stringify(probes.standardFont)}`);
    if (!report.cmapProbeOk) reasons.push(`CMap 探针失败：${JSON.stringify(probes.cmap)}`);
    if (report.cspViolationsForPdfAssets) reasons.push("存在 pdf-assets 的 CSP 违规");
    if (!report.pixelOk) reasons.push("阅读器页面像素探针失败（空白页）");
    if (!report.readerPage) reasons.push("阅读器未报告页码");
    if (report.scriptExecuted) reasons.push("PDF 内嵌脚本被执行（安全红线）");
    if (!report.externalBlocked) reasons.push("外部 fetch 未被拦截");
    const pass = reasons.length === 0;
    report.verdict = pass ? "pass" : "fail";
    report.reasons = reasons;
    return pass;
  } finally {
    if (session) {
      try {
        await session.request("DELETE", "", null, 20_000);
      } catch {
        /* 会话已随浏览器退出 */
      }
    }
    if (driverChild) {
      try {
        driverChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (driverLog !== null) {
      try {
        fs.closeSync(driverLog);
      } catch {
        /* ignore */
      }
    }
    // 兜底：清掉本次启动的残留应用进程。
    for (const proc of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(proc)) continue;
      try {
        const name = fs.readFileSync(`/proc/${proc}/comm`, "utf8").trim();
        if (name.startsWith(path.basename(binary).slice(0, 15))) {
          process.kill(Number(proc), "SIGTERM");
        }
      } catch {
        /* 进程已退出或无权限 */
      }
    }
    if (!args.keepWork) {
      try {
        fs.rmSync(work.root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
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
    printUsage();
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const report = {
    schema: HARNESS_VERSION,
    harness: "linux-pdf-runtime",
    startedAt,
    finishedAt: null,
    binary: path.basename(args.binary),
    expectCspBlocked: args.expectCspBlocked,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cspPresent: false,
    fontAssetsSeen: false,
    cmapAssetsSeen: false,
    cspViolations: [],
    externalBlocked: false,
    scriptExecuted: null,
    pixelOk: false,
    readerPage: 0,
    verdict: "harness-error",
  };

  let code = 2;
  try {
    const pass = await run(args, report);
    code = pass ? 0 : 1;
  } catch (error) {
    report.verdict = "harness-error";
    report.error = String(error && error.stack ? error.stack : error)
      .split("\n")
      .slice(0, 6)
      .join("\n");
    code = 2;
  } finally {
    report.finishedAt = new Date().toISOString();
    const out = args.out ? path.resolve(args.out) : path.join(os.tmpdir(), "mr-linux-pdf-runtime.json");
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      process.stderr.write(`无法写入 ${out}: ${error.message}\n`);
      code = 2;
    }
    process.stdout.write(
      [
        `verdict: ${report.verdict}`,
        `binary: ${report.binary}`,
        `capability: ${report.capabilityUsed || "-"}`,
        `csp present: ${report.cspPresent} (connect-src: ${report.cspDirectiveConnect || "?"})`,
        `font asset probe: ${report.fontProbeOk} | cmap probe: ${report.cmapProbeOk}`,
        `font resource timing: ${report.fontAssetsSeen} | cmap resource timing: ${report.cmapAssetsSeen}`,
        `csp violations (pdf-assets): ${report.cspViolationsForPdfAssets} | external blocked: ${report.externalBlocked}`,
        `reader page: ${report.readerPage} | pixel ok: ${report.pixelOk} | script executed: ${report.scriptExecuted}`,
        `evidence: ${out}`,
        ...(report.reasons && report.reasons.length ? [`reasons: ${report.reasons.join("; ")}`] : []),
        ...(report.error ? [`error: ${report.error.split("\n")[0]}`] : []),
      ].join("\n") + "\n",
    );
  }
  process.exit(code);
}

main();
