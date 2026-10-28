#!/usr/bin/env node
/**
 * 发布契约自检（不联网、不构建、不发布）：
 *
 * 1. 发行面静态契约：productName / identifier / NSIS 目标 / updater 端点 / 签名公钥 /
 *    Windows 与 Linux 通道的**独立性**（AGENTS.md §4.1）。
 * 2. Linux 高危补丁通道的公开更新清单契约（`scripts/make-linux-critical-manifest.mjs`）：
 *    清单结构、签名与 URL、以及三个失败分支（版本不匹配 / 缺签名 / 多个 AppImage）。
 *
 * 这些断言是「安装升级」链路上**可以在无 VM 环境真实执行**的部分；
 * 需要干净 Windows VM 的安装/覆盖/回滚步骤在 docs/dev/RELEASE.md 中标为 BLOCKED。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { verifyUpdaterManifest } from "./verify-updater-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const tauri = readJson("src-tauri/tauri.conf.json");
const linuxOverlay = readJson("src-tauri/tauri.linux.conf.json");

/* ------------------------------------------------------------------ */
/* 1. 发行面静态契约                                                  */
/* ------------------------------------------------------------------ */

test("发行面：产品标识与安装器目标固定", () => {
  assert.equal(tauri.productName, "MangaReader");
  assert.equal(tauri.identifier, "com.local.manga-reader");
  assert.equal(tauri.mainBinaryName, "manga-reader-tauri");
  // AGENTS.md §4.1：Windows 只发布 NSIS，禁止加入 msi。
  assert.deepEqual(tauri.bundle.targets, ["nsis", "deb", "rpm", "appimage"]);
  assert.ok(!tauri.bundle.targets.includes("msi"), "MSI 不得进入 bundle.targets");
  assert.equal(tauri.bundle.createUpdaterArtifacts, true);
});

test("发行面：NSIS 安装器行为固定（both / lzma / 六语选择器）", () => {
  const nsis = tauri.bundle.windows.nsis;
  assert.equal(nsis.installMode, "both");
  assert.equal(nsis.compression, "lzma");
  assert.equal(nsis.displayLanguageSelector, true);
  assert.deepEqual(nsis.languages, [
    "SimpChinese",
    "TradChinese",
    "English",
    "Spanish",
    "Japanese",
    "Korean",
  ]);
});

test("发行面：Updater 公钥存在且为 minisign 公钥", () => {
  const pubkey = tauri.plugins.updater.pubkey;
  assert.ok(pubkey && pubkey.length > 32, "updater.pubkey 不得为空");
  const decoded = Buffer.from(pubkey, "base64").toString("utf8");
  assert.match(decoded, /minisign public key/i, "pubkey 必须是 minisign 公钥");
});

test("发行面：Windows 与 Linux 更新通道彼此独立", () => {
  const windowsEndpoint = tauri.plugins.updater.endpoints[0];
  const linuxEndpoint = linuxOverlay.plugins.updater.endpoints[0];
  assert.match(windowsEndpoint, /releases\/latest\/download\/latest\.json$/);
  assert.match(
    linuxEndpoint,
    /releases\/latest\/download\/latest-linux-critical\.json$/,
  );
  assert.notEqual(
    windowsEndpoint,
    linuxEndpoint,
    "Linux 通道不得复用 Windows 的更新清单端点",
  );
  // Linux overlay 只产出 Linux 产物，且必须保留 Windows overlay 的三件套目标。
  assert.deepEqual(linuxOverlay.bundle.targets, ["deb", "rpm", "appimage"]);
  // overlay 不得覆盖签名公钥（否则两端签名会漂移）。
  assert.equal(linuxOverlay.plugins.updater.pubkey, undefined);
});

test("发行面：Updater 被动安装模式固定为 passive", () => {
  assert.equal(tauri.plugins.updater.windows.installMode, "passive");
});

/* ------------------------------------------------------------------ */
/* 2. Linux 高危补丁通道清单契约                                       */
/* ------------------------------------------------------------------ */

const manifestScript = path.join(root, "scripts", "make-linux-critical-manifest.mjs");

/** 构造一个临时的“已构建产物”根目录，脚本按 cwd 解析路径。 */
function makeBuildRoot({ version = "0.17.1", tag = "v0.17.1-linux-sec1" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-manifest-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "manga-reader-tauri", version }, null, 2),
  );
  const bundle = path.join(dir, "src-tauri", "target", "release", "bundle", "appimage");
  fs.mkdirSync(bundle, { recursive: true });
  return { dir, bundle, tag };
}

function runManifest(rootDir, env = {}) {
  return execFileSync(process.execPath, [manifestScript], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("清单契约：生成的 latest-linux-critical.json 结构完整且带签名", () => {
  const { dir, bundle, tag } = makeBuildRoot();
  const image = "manga-reader-tauri_0.17.1_amd64.AppImage";
  fs.writeFileSync(path.join(bundle, image), "fake-appimage");
  fs.writeFileSync(path.join(bundle, `${image}.sig`), "untrusted comment: signature\nRULEDATA\n");

  runManifest(dir, { RELEASE_TAG: tag, GITHUB_REPOSITORY: "D-OneXXX/Moyu" });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, "latest-linux-critical.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.17.1");
  assert.match(manifest.notes, /0\.17\.1-linux-sec1/);
  assert.ok(manifest.pub_date, "清单必须带 pub_date");
  const platform = manifest.platforms["linux-x86_64"];
  assert.ok(platform, "清单必须含 linux-x86_64 平台项");
  assert.match(platform.signature, /signature/);
  assert.equal(
    platform.url,
    `https://github.com/D-OneXXX/Moyu/releases/download/v0.17.1-linux-sec1/${image}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("清单契约：标签基础版本与 package.json 不一致时必须失败", () => {
  const { dir, bundle } = makeBuildRoot();
  const image = "manga-reader-tauri_0.17.1_amd64.AppImage";
  fs.writeFileSync(path.join(bundle, image), "fake-appimage");
  fs.writeFileSync(path.join(bundle, `${image}.sig`), "sig");
  assert.throws(
    () => runManifest(dir, { RELEASE_TAG: "v0.18.0-linux-sec1" }),
    /不一致/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("清单契约：缺少签名文件时必须失败（不得发布未签名清单）", () => {
  const { dir, bundle } = makeBuildRoot();
  const image = "manga-reader-tauri_0.17.1_amd64.AppImage";
  fs.writeFileSync(path.join(bundle, image), "fake-appimage");
  assert.throws(
    () => runManifest(dir, { RELEASE_TAG: "v0.17.1-linux-sec1" }),
    /签名/,
  );
  assert.ok(
    !fs.existsSync(path.join(bundle, "latest-linux-critical.json")),
    "失败时不得留下清单文件",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("清单契约：产物多于一个 AppImage 时必须失败", () => {
  const { dir, bundle } = makeBuildRoot();
  for (const name of ["a_0.17.1_amd64.AppImage", "b_0.17.1_amd64.AppImage"]) {
    fs.writeFileSync(path.join(bundle, name), "fake");
    fs.writeFileSync(path.join(bundle, `${name}.sig`), "sig");
  }
  assert.throws(
    () => runManifest(dir, { RELEASE_TAG: "v0.17.1-linux-sec1" }),
    /恰好 1 个/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Linux 0.18.0：latest-linux-critical.json 按候选版本生成（同端点/同签名）", () => {
  const { dir, bundle, tag } = makeBuildRoot({
    version: "0.18.0",
    tag: "v0.18.0-linux-sec1",
  });
  const image = "manga-reader-tauri_0.18.0_amd64.AppImage";
  fs.writeFileSync(path.join(bundle, image), "fake-appimage-0.18.0");
  fs.writeFileSync(
    path.join(bundle, `${image}.sig`),
    "untrusted comment: signature\nRULEDATA\n",
  );

  runManifest(dir, { RELEASE_TAG: tag, GITHUB_REPOSITORY: "D-OneXXX/Moyu" });

  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, "latest-linux-critical.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.18.0");
  assert.match(manifest.notes, /v0\.18\.0-linux-sec1/);
  // 只产出 Linux 平台项：不得混入 Windows 通道。
  assert.deepEqual(Object.keys(manifest.platforms), ["linux-x86_64"]);
  assert.equal(
    manifest.platforms["linux-x86_64"].url,
    `https://github.com/D-OneXXX/Moyu/releases/download/v0.18.0-linux-sec1/${image}`,
  );
  assert.deepEqual(
    verifyUpdaterManifest(manifest, {
      expectVersion: "0.18.0",
      requirePlatform: "linux-x86_64",
    }),
    [],
  );
  // 端点与签名公钥没有为新版本重新设计：Linux overlay 仍指向同一高危通道，
  // 且不覆盖 pubkey（继承 tauri.conf.json 的同一把 minisign 公钥）。
  assert.match(
    linuxOverlay.plugins.updater.endpoints[0],
    /releases\/latest\/download\/latest-linux-critical\.json$/,
  );
  assert.equal(linuxOverlay.plugins.updater.pubkey, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 3. 公开更新清单校验器                                               */
/* ------------------------------------------------------------------ */

const validManifest = {
  version: "0.17.1",
  notes: "Windows channel",
  pub_date: "2026-10-26T00:00:00.000Z",
  platforms: {
    "windows-x86_64": {
      signature: "untrusted comment: signature\nRULEDATA\n",
      url: "https://github.com/D-OneXXX/Moyu/releases/download/v0.17.1/MangaReader_0.17.1_x64-setup.exe",
    },
  },
};

test("清单校验器：合法清单必须通过", () => {
  assert.deepEqual(
    verifyUpdaterManifest(validManifest, {
      expectVersion: "0.17.1",
      requirePlatform: "windows-x86_64",
    }),
    [],
  );
});

test("清单校验器：缺失签名 / 非 https / 版本不符必须被拒绝", () => {
  const broken = {
    version: "0.17.1",
    pub_date: "2026-10-26T00:00:00.000Z",
    platforms: {
      "windows-x86_64": { signature: "", url: "http://example.invalid/app.exe" },
    },
  };
  const problems = verifyUpdaterManifest(broken, { expectVersion: "0.17.2" });
  assert.ok(
    problems.some((p) => p.includes("signature")),
    `必须报出签名缺失：${problems.join(" | ")}`,
  );
  assert.ok(problems.some((p) => p.includes("https")), "必须报出非 https 链接");
  assert.ok(problems.some((p) => p.includes("version")), "必须报出版本不一致");
});

test("清单校验器：缺少必需平台 / 非法版本 / 非法 pub_date 必须被拒绝", () => {
  const problems = verifyUpdaterManifest(
    {
      version: "not-a-version",
      pub_date: "昨天",
      platforms: { "linux-x86_64": { signature: "x", url: "https://example.invalid/a" } },
    },
    { requirePlatform: "windows-x86_64" },
  );
  assert.ok(problems.some((p) => p.includes("语义化版本")));
  assert.ok(problems.some((p) => p.includes("pub_date")));
  assert.ok(problems.some((p) => p.includes("windows-x86_64")));
});

test("清单校验器：签名文件内容必须与清单内签名一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-manifest-sig-"));
  const sigPath = path.join(dir, "app.exe.sig");
  fs.writeFileSync(sigPath, "untrusted comment: signature\nRULEDATA\n");
  const problems = verifyUpdaterManifest(validManifest, {
    expectedSignature: fs.readFileSync(sigPath, "utf8"),
  });
  assert.deepEqual(problems, []);
  const mismatched = verifyUpdaterManifest(validManifest, {
    expectedSignature: "different-signature",
  });
  assert.ok(mismatched.some((p) => p.includes("签名文件内容不一致")));
  fs.rmSync(dir, { recursive: true, force: true });
});
