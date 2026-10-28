#!/usr/bin/env node
/**
 * 生成 Linux 高危补丁通道的 updater 清单 latest-linux-critical.json。
 *
 * 输入（环境变量 / 文件系统）：
 * - RELEASE_TAG：发布的标签（如 v0.17.1-linux-sec1）；缺省时读 GITHUB_REF_NAME。
 * - GITHUB_REPOSITORY：owner/repo（Actions 自带）；缺省回落 D-OneXXX/Moyu。
 * - src-tauri/target/release/bundle/appimage/*.AppImage 与同名 .AppImage.sig
 *   （`createUpdaterArtifacts: true` + TAURI_SIGNING_PRIVATE_KEY 的产物）。
 *
 * 输出：src-tauri/target/release/bundle/appimage/latest-linux-critical.json
 * 版本号取 package.json（updater 按语义版本比较，忽略标签的 -linux-sec 后缀）。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const appImageDir = path.join(root, "src-tauri", "target", "release", "bundle", "appimage");

const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || "";
const repo = process.env.GITHUB_REPOSITORY || "D-OneXXX/Moyu";
if (!tag) {
  console.error("[linux-critical-manifest] 缺少 RELEASE_TAG / GITHUB_REF_NAME");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const base = tag.replace(/-linux-sec.*$/, "");
if (`v${pkg.version}` !== base) {
  console.error(
    `[linux-critical-manifest] 标签基础版本 ${base} 与 package.json v${pkg.version} 不一致`,
  );
  process.exit(1);
}

if (!fs.existsSync(appImageDir)) {
  console.error(`[linux-critical-manifest] 找不到构建产物目录 ${appImageDir}`);
  process.exit(1);
}

const appImages = fs
  .readdirSync(appImageDir)
  .filter((name) => name.endsWith(".AppImage"));
if (appImages.length !== 1) {
  console.error(
    `[linux-critical-manifest] 期望恰好 1 个 AppImage，实际 ${appImages.length} 个：${appImages.join(", ")}`,
  );
  process.exit(1);
}

const appImage = appImages[0];
const sigPath = path.join(appImageDir, `${appImage}.sig`);
if (!fs.existsSync(sigPath)) {
  console.error(
    `[linux-critical-manifest] 缺少签名文件 ${appImage}.sig（需要 TAURI_SIGNING_PRIVATE_KEY 构建）`,
  );
  process.exit(1);
}
const signature = fs.readFileSync(sigPath, "utf8").trim();

const manifest = {
  version: pkg.version,
  notes: `Linux 长期稳定分支高危安全/崩溃修复补丁（${tag}）。`,
  pub_date: new Date().toISOString(),
  platforms: {
    "linux-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(appImage)}`,
    },
  },
};

const outPath = path.join(appImageDir, "latest-linux-critical.json");
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[linux-critical-manifest] 已生成 ${path.relative(root, outPath)}（${appImage}）`);
