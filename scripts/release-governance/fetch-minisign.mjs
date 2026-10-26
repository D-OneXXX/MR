#!/usr/bin/env node
/**
 * 获取**官方 minisign**（jedisct1/minisign）并按仓库内固定摘要校验后解压到本地工具目录。
 *
 * 供应链约束：
 * - 只从官方 GitHub Release 下载；
 * - 下载后必须与 `scripts/release-governance/minisign.digests.json` 里固定的
 *   SHA-256 一致，否则**拒绝使用**（fail closed）；
 * - 解压到 `tools/minisign/`（本地工具目录，不入库）。
 *
 * 用法：node scripts/release-governance/fetch-minisign.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const DIGESTS_FILE = path.join(here, "minisign.digests.json");

export function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function pickTarget() {
  if (process.platform === "win32") return "win64";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export async function fetchMinisign({ rootDir = root, target = pickTarget() } = {}) {
  const digests = JSON.parse(fs.readFileSync(DIGESTS_FILE, "utf8"));
  const entry = digests[target];
  if (!entry) throw new Error(`未登记的 minisign 目标：${target}`);
  const toolsDir = path.join(rootDir, "tools", "minisign");
  fs.mkdirSync(toolsDir, { recursive: true });

  const archive = path.join(os.tmpdir(), `minisign-${target}-${entry.sha256.slice(0, 8)}`);
  const response = await fetch(entry.url);
  if (!response.ok) {
    throw new Error(`下载 minisign 失败：${response.status} ${entry.url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(archive, bytes);
  const actual = sha256File(archive);
  if (actual !== entry.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(
      `minisign 摘要不匹配：期望 ${entry.sha256} 实际 ${actual}（拒绝使用）`,
    );
  }

  if (target === "win64") {
    spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force '${archive}' '${toolsDir}'`,
    ], { stdio: "inherit" });
  } else {
    spawnSync("tar", ["-xzf", archive, "-C", toolsDir], { stdio: "inherit" });
  }
  fs.rmSync(archive, { force: true });

  const candidates = [
    path.join(toolsDir, "minisign-win64", "x86_64", "minisign.exe"),
    path.join(toolsDir, "minisign-win64", "x86_64", "minisign"),
    path.join(toolsDir, "minisign-linux", "x86_64", "minisign"),
    path.join(toolsDir, "minisign-macos", "minisign"),
    path.join(toolsDir, "minisign.exe"),
    path.join(toolsDir, "minisign"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("minisign 解压后未找到可执行文件");
}

async function main() {
  try {
    const binary = await fetchMinisign();
    const version = spawnSync(binary, ["-v"], { encoding: "utf8" });
    console.log(`[minisign] 已安装：${binary}（${(version.stdout || "").trim()}）`);
  } catch (error) {
    console.error(`[minisign] 获取失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
