import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
// @ts-expect-error type error without @types/node package
import { execFileSync } from "node:child_process";
// @ts-expect-error type error without @types/node package
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/**
 * PDF.js 静态资源（cmaps / standard_fonts）。
 *
 * PDF.js 需要按 URL 前缀拉取 CMap 与标准字体表；这些文件随 npm 依赖分发，
 * 既有构建不会自动拷贝。开发期用中间件直接从 node_modules 供给，
 * 构建期在 bundle 落盘后复制到 `dist/pdf-assets/`，保证生产包完全离线。
 *
 * 只暴露 cmaps 与 standard_fonts：wasm（openjpeg/jbig2/qcms）与 quickjs-eval
 * 沙箱不随附——wasm 需要放宽 CSP 的 'wasm-unsafe-eval'，且 PDF 内嵌脚本
 * 沙箱与「不执行文档脚本」的安全要求冲突。
 */
const PDF_ASSET_URL_PREFIX = "/pdf-assets";
const PDF_ASSET_DIRS: readonly string[] = ["cmaps", "standard_fonts"];

const MIME_BY_EXT: Record<string, string> = {
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function pdfAssetsPlugin(): Plugin {
  const sourceRoot = fileURLToPath(
    new URL("./node_modules/pdfjs-dist", import.meta.url),
  );
  return {
    name: "moyu:pdf-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? "";
        if (!rawUrl.startsWith(`${PDF_ASSET_URL_PREFIX}/`)) {
          next();
          return;
        }
        // 去掉查询串（?v=… 之类），只保留资源相对路径。
        const requestPath = decodeURIComponent(
          rawUrl.slice(PDF_ASSET_URL_PREFIX.length + 1).split("?")[0] ?? "",
        );
        const target = resolve(sourceRoot, requestPath);
        // 只允许读取 pdfjs-dist 目录内的受控子目录，杜绝路径穿越。
        // 注意：不能用字符串前缀比较——Windows 上 resolve() 产出的是反斜杠路径，
        // 与硬编码的 "/" 前缀永远匹配不上（会让 /pdf-assets/** 全部 404）。
        const rel = relative(sourceRoot, target);
        const allowed =
          !!rel &&
          !rel.startsWith("..") &&
          !isAbsolute(rel) &&
          PDF_ASSET_DIRS.includes(rel.split(sep)[0] ?? "");
        if (!allowed || !existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          MIME_BY_EXT[extname(target)] ?? "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(target));
      });
    },
    closeBundle() {
      const outDir = fileURLToPath(new URL("./dist", import.meta.url));
      for (const dir of PDF_ASSET_DIRS) {
        const from = resolve(sourceRoot, dir);
        if (!existsSync(from)) continue;
        cpSync(from, resolve(outDir, "pdf-assets", dir), { recursive: true });
      }
    },
  };
}

function projectVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("package.json version is required");
  }
  return manifest.version;
}

function buildCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        encoding: "utf8",
      },
    ).trim();
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "local";
  }
}

const appVersion = projectVersion();
const gitCommit = buildCommit();

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_COMMIT__: JSON.stringify(gitCommit),
  },
  // Tailwind v4 走 Vite 插件；v3 页面用工具类，旧页面继续用 ui.css 的类。
  plugins: [react(), tailwindcss(), pdfAssetsPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        recovery: fileURLToPath(new URL("./recovery.html", import.meta.url)),
        // Web Access 独立入口（W2 / BLK-2 验证原型）。
        // 刻意与桌面入口分离：不共享 Provider 栈，不引入任何 Tauri IPC 依赖。
        web: fileURLToPath(new URL("./web.html", import.meta.url)),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: [
        "**/src-tauri/**",
        "**/tests/qa/artifacts/**",
        "**/tests/qa/fixtures/**",
      ],
    },
  },
}));
