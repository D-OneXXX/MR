import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  connectMain,
  connectResponsiveMain,
  listTargets,
  waitForTarget,
} from "./cdp.mjs";
import { shouldRetryCdp } from "./reliability.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** dev server 探测地址：Vite 实际监听 127.0.0.1，而 debug 应用按 devUrl 访问
 * localhost；CI runner 上 localhost 可能解析到 ::1，两个地址都要探。 */
const DEV_URLS = ["http://127.0.0.1:1420/", "http://localhost:1420/"];

/** 读取日志文件尾部若干行，用于把失败原因直接写进 CI 日志。 */
function tailFile(file, lines = 20) {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch {
    return "(日志不可读)";
  }
}

async function portOpen(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function anyDevServerUp() {
  for (const url of DEV_URLS) {
    if (await portOpen(url)) return true;
  }
  return false;
}

async function ensureVite(root, artifactDir) {
  if (await anyDevServerUp()) return null;
  fs.mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "vite.log");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "1420", "--strictPort"],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    },
  );
  // 冷启动 runner 上 npm + Vite 首启可能明显慢于开发机，给足余量；
  // 超时或提前退出时把 Vite 日志尾部带进错误信息，便于直接定位。
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Vite 开发服务器提前退出（code ${child.exitCode}）：\n${tailFile(logPath)}`,
      );
    }
    if (await anyDevServerUp()) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      return child;
    }
    await sleep(250);
  }
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }
  killTree(child);
  throw new Error(`Vite 开发服务器启动超时：\n${tailFile(logPath)}`);
}

function binaryPath(root) {
  const explicit = process.env.QA_APP_BIN;
  const candidate =
    explicit ||
    path.join(
      root,
      "src-tauri",
      "target",
      "debug",
      process.platform === "win32" ? "manga-reader-tauri.exe" : "manga-reader-tauri",
    );
  if (!fs.existsSync(candidate)) {
    throw new Error(`找不到 ${candidate}，请先执行 cargo build`);
  }
  return candidate;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

function privacyPolicyVersion(root) {
  const source = fs.readFileSync(
    path.join(root, "src", "components", "privacy", "PrivacyDialog.tsx"),
    "utf8",
  );
  const match = source.match(/PRIVACY_POLICY_VERSION\s*=\s*"([^"]+)"/);
  return match?.[1] ?? "2026-10";
}

function packageMajor(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version.split(".")[0];
}

function stringifyForScript(value) {
  return JSON.stringify(JSON.stringify(value));
}

export async function invoke(page, command, args = {}) {
  return page.eval(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
}

export async function invokeSafe(page, command, args = {}) {
  return page.eval(`(async () => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) };
    } catch (error) {
      return { ok: false, error: typeof error === "string" ? error : String(error) };
    }
  })()`);
}

export async function waitForApp(page, timeout = 30_000) {
  await page.waitFor(
    "document.readyState === 'complete' && !!window.__TAURI_INTERNALS__",
    { timeout, label: "main window ready" },
  );
}

/** 连接主窗并等到 Tauri IPC 就绪。
 *
 * debug 构建从 `devUrl`（http://localhost:1420）加载前端，Vite 只监听
 * 127.0.0.1；CI runner 上 localhost 可能解析到 ::1，页面会空白、
 * `__TAURI_INTERNALS__` 永不注入。这里在初次等待失败后逐个回退候选地址，
 * 避免把「地址解析差异」误判成「应用起不来」。
 */
async function connectReadyApp(cdpPort) {
  let page = await connectMain(cdpPort);
  try {
    await waitForApp(page, 60_000);
    return page;
  } catch (firstError) {
    for (const url of DEV_URLS) {
      await page
        .eval(`setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 60); true`)
        .catch(() => {});
      await sleep(1500);
      page = await connectMain(cdpPort);
      try {
        await waitForApp(page, 30_000);
        return page;
      } catch {
        /* 继续尝试下一个候选地址 */
      }
    }
    throw firstError;
  }
}

export async function startQaApp({
  root,
  artifactDir,
  dataDir,
  fixtures,
  cdpPort = 9334,
  telegramTestOrigin = null,
  // 升级/恢复核验用：允许数据目录里已经有书（我们要读的就是那份既有书库）。
  // 默认 false —— 常规 QA 仍然禁止复用脏目录，避免污染用户书库。
  allowExistingBooks = false,
}) {
  const vite = await ensureVite(root, artifactDir);
  if (await portOpen(`http://127.0.0.1:${cdpPort}/json/version`)) {
    throw new Error(
      `CDP 端口 ${cdpPort} 已被占用；拒绝连接未知实例，请先结束旧 QA 进程或指定 QA_CDP_PORT`,
    );
  }
  const appBin = binaryPath(root);
  const webviewDir = path.join(dataDir, "webview");
  fs.mkdirSync(webviewDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "render_cache"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });

  const out = fs.openSync(path.join(artifactDir, "qa-app.log"), "a");
  const app = spawn(appBin, [], {
    cwd: path.join(root, "src-tauri"),
    env: {
      ...process.env,
      MR_DATA_DIR: dataDir,
      MR_RENDER_CACHE_DIR: path.join(dataDir, "render_cache"),
      MR_ONLINE_CACHE_DIR: path.join(dataDir, "online_cache"),
      // QA 在线夹具运行在 127.0.0.1；只对 debug 构建生效，release 永远拒绝回环。
      MR_ALLOW_LOOPBACK_ONLINE: "1",
      WEBVIEW2_USER_DATA_FOLDER: webviewDir,
      // CI 的窗口可能不在前台；关闭渲染器/定时器/遮挡节流，避免滚动挂载
      // 窗口和恢复窗在后台被降频，导致切片只加载 1 张或 CDP 短暂无响应。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${cdpPort}` +
        " --disable-background-timer-throttling" +
        " --disable-renderer-backgrounding" +
        " --disable-backgrounding-occluded-windows",
      QA_CDP_PORT: String(cdpPort),
      ...(telegramTestOrigin
        ? { MR_TELEGRAM_TEST_ORIGIN: telegramTestOrigin }
        : {}),
    },
    stdio: ["ignore", out, out],
    detached: process.platform !== "win32",
    windowsHide: false,
  });

  try {
    return await runQaSession({
      app,
      out,
      appBin,
      vite,
      root,
      artifactDir,
      dataDir,
      fixtures,
      cdpPort,
      allowExistingBooks,
    });
  } catch (error) {
    // 启动失败必须回收子进程：残留的 app / Vite 句柄会让 node 永不退出，
    // CI 上表现为整个 step 挂到超时，重试也永远不会执行。
    killTree(app);
    if (vite) killTree(vite);
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
    const detail =
      `隔离应用启动失败：${error.message}\n` +
      `--- 应用日志尾部 ---\n${tailFile(path.join(artifactDir, "qa-app.log"))}`;
    console.error(`[qa] ${detail}`);
    throw new Error(detail, { cause: error });
  }
}

async function runQaSession({
  app,
  out,
  appBin,
  vite,
  root,
  artifactDir,
  dataDir,
  fixtures,
  cdpPort,
  allowExistingBooks = false,
}) {
  await waitForTarget(cdpPort, () => true, { timeout: 90_000 });
  let page = await connectReadyApp(cdpPort);

  // Prevent the first-run privacy dialog from covering the deterministic
  // test surface. This mirrors the product's own acknowledgement token.
  const ack = `${privacyPolicyVersion(root)}:${packageMajor(root)}`;
  await page.eval(`(() => {
    localStorage.setItem("mr-privacy-ack", ${JSON.stringify(ack)});
    localStorage.setItem("mr-theme", "light");
    localStorage.setItem("mr-locale", "zh-CN");
    return true;
  })()`);
  await page.eval("setTimeout(() => location.reload(), 60); true");
  await sleep(1200);
  page = await connectResponsiveMain(cdpPort);
  await waitForApp(page);
  await page.waitFor("!!document.querySelector('main') || !!document.querySelector('.reader-root')", {
    timeout: 20_000,
    label: "app shell",
  });

  const preexisting = await invoke(page, "list_books", { query: null });
  if (!allowExistingBooks && Array.isArray(preexisting) && preexisting.length > 0) {
    throw new Error(
      `隔离数据目录在导入前已有 ${preexisting.length} 本书；目标实例可能不是本次启动的 QA 应用，已中止以免污染用户书库`,
    );
  }

  const imported = [];
  for (const fixturePath of fixtures.importOrder) {
    try {
      const result = await invoke(page, "import_books", { paths: [fixturePath] });
      imported.push({ path: fixturePath, result });
    } catch (error) {
      imported.push({ path: fixturePath, result: null, error: String(error) });
    }
  }
  await page.eval("setTimeout(() => location.reload(), 60); true");
  await sleep(1200);
  page = await connectResponsiveMain(cdpPort);
  await waitForApp(page);
  const books = await invoke(page, "list_books", { query: null });

  const context = {
    root,
    artifactDir,
    dataDir,
    fixtures,
    cdpPort,
    appProcess: app,
    appBin,
    page,
    imported,
    books,
    async reconnectMain(maxAttempts = 3) {
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await page.close().catch(() => {});
        try {
          page = await connectResponsiveMain(cdpPort);
          await waitForApp(page);
          context.page = page;
          return page;
        } catch (error) {
          lastError = error;
          if (!shouldRetryCdp({ attempt, maxAttempts, error })) throw error;
          await sleep(1500 * attempt);
        }
      }
      throw lastError ?? new Error("主窗口重连失败");
    },
    async goto(hash) {
      await page.navigateHash(hash);
      await page.waitFor(
        `location.hash === ${JSON.stringify(hash)}`,
        { timeout: 5000, label: `hash ${hash}` },
      );
      await sleep(250);
    },
    async targets() {
      return listTargets(cdpPort);
    },
    async setLocale(locale) {
      await page.eval(
        `localStorage.setItem("mr-locale", ${JSON.stringify(locale)}); setTimeout(() => location.reload(), 60); true`,
      );
      await sleep(1000);
      page = await connectResponsiveMain(cdpPort);
      await waitForApp(page);
      context.page = page;
      await page.waitFor(`document.documentElement.lang === ${JSON.stringify(locale)}`, {
        timeout: 5000,
        label: `locale ${locale}`,
      });
    },
    async setTheme(theme) {
      await page.eval(
        `localStorage.setItem("mr-theme", ${JSON.stringify(theme)}); setTimeout(() => location.reload(), 60); true`,
      );
      await sleep(1000);
      page = await connectResponsiveMain(cdpPort);
      await waitForApp(page);
      context.page = page;
      await page.waitFor(
        `document.documentElement.dataset.theme === ${JSON.stringify(theme === "system" ? (await page.eval("matchMedia('(prefers-color-scheme: dark)').matches") ? "dark" : "light") : theme)}`,
        { timeout: 5000, label: `theme ${theme}` },
      );
    },
    async close() {
      killTree(app);
      try {
        fs.closeSync(out);
      } catch {
        /* ignore */
      }
      if (vite) killTree(vite);
    },
    stringifyForScript,
  };
  return context;
}

export function findBook(books, fragment) {
  return books.find(
    (book) =>
      book.title.includes(fragment) ||
      book.path.toLowerCase().includes(String(fragment).toLowerCase()),
  );
}

export async function enableOnline(page) {
  const settings = await invoke(page, "get_settings");
  const next = { ...settings, experimentalOnline: true, onlineProxy: "" };
  await invoke(page, "set_settings", { settings: next });
  await page.eval(`localStorage.setItem("mr-exp-online", "1"); true`);
  return next;
}
