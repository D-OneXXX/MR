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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portOpen(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureVite(root) {
  if (await portOpen("http://127.0.0.1:1420/")) return null;
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", "1420", "--strictPort"],
    {
      cwd: root,
      env: process.env,
      stdio: "ignore",
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await portOpen("http://127.0.0.1:1420/")) return child;
    await sleep(250);
  }
  throw new Error("Vite 开发服务器启动超时");
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

export async function waitForApp(page) {
  await page.waitFor(
    "document.readyState === 'complete' && !!window.__TAURI_INTERNALS__",
    { timeout: 30_000, label: "main window ready" },
  );
}

export async function startQaApp({
  root,
  artifactDir,
  dataDir,
  fixtures,
  cdpPort = 9334,
  telegramTestOrigin = null,
}) {
  const vite = await ensureVite(root);
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
      WEBVIEW2_USER_DATA_FOLDER: webviewDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      QA_CDP_PORT: String(cdpPort),
      ...(telegramTestOrigin
        ? { MR_TELEGRAM_TEST_ORIGIN: telegramTestOrigin }
        : {}),
    },
    stdio: ["ignore", out, out],
    detached: process.platform !== "win32",
    windowsHide: false,
  });

  await waitForTarget(cdpPort, () => true, { timeout: 45_000 });
  let page = await connectMain(cdpPort);
  await waitForApp(page);

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
  if (Array.isArray(preexisting) && preexisting.length > 0) {
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
    async reconnectMain() {
      await page.close().catch(() => {});
      page = await connectResponsiveMain(cdpPort);
      await waitForApp(page);
      context.page = page;
      return page;
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
