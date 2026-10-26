#!/usr/bin/env node
/**
 * 公开更新清单校验器（不联网、不下载、不发布）。
 *
 * 用途：Windows 通道的 `latest.json` 由 tauri-action 生成，Linux 通道的
 * `latest-linux-critical.json` 由 `scripts/make-linux-critical-manifest.mjs` 生成。
 * 两者都是**公开可下载**的更新契约：一旦结构不对，客户端会静默拿不到更新，
 * 或者更糟——把损坏的签名写进安装流程。本脚本把结构约束写成可执行门禁。
 *
 * 用法：
 *   node scripts/verify-updater-manifest.mjs <manifest.json> \
 *     [--expect-version 0.17.2] [--require-platform windows-x86_64] \
 *     [--signature-file <path>] [--expect-signature-file <path>]
 *
 * 退出码：0 = 通过；1 = 校验失败（逐条打印原因）。
 */
import fs from "node:fs";
import path from "node:path";

/** 语义化版本（updater 按此比较）。 */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {unknown} manifest 解析后的清单对象
 * @param {object} [options]
 * @param {string} [options.expectVersion] 期望的 version
 * @param {string} [options.requirePlatform] 必须存在的平台键
 * @param {string} [options.expectedSignature] 期望的签名文本（与清单内比对）
 * @returns {string[]} 问题列表（空数组表示通过）
 */
export function verifyUpdaterManifest(manifest, options = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["清单必须是 JSON 对象"];
  }
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    problems.push(`version 缺失或不是语义化版本：${String(manifest.version)}`);
  } else if (options.expectVersion && manifest.version !== options.expectVersion) {
    problems.push(
      `version=${manifest.version} 与期望 ${options.expectVersion} 不一致`,
    );
  }
  if (typeof manifest.pub_date !== "string" || Number.isNaN(Date.parse(manifest.pub_date))) {
    problems.push(`pub_date 缺失或不是合法时间：${String(manifest.pub_date)}`);
  }
  if (
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Array.isArray(manifest.platforms) ||
    Object.keys(manifest.platforms).length === 0
  ) {
    problems.push("platforms 必须是非空对象");
    return problems;
  }
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!entry || typeof entry !== "object") {
      problems.push(`platforms.${platform} 必须是对象`);
      continue;
    }
    if (typeof entry.signature !== "string" || entry.signature.trim().length === 0) {
      problems.push(`platforms.${platform}.signature 缺失（未签名更新不得发布）`);
    }
    if (typeof entry.url !== "string" || !/^https:\/\//.test(entry.url)) {
      problems.push(`platforms.${platform}.url 必须是 https 链接`);
    }
    if (
      options.expectedSignature &&
      entry.signature &&
      entry.signature.trim() !== options.expectedSignature.trim()
    ) {
      problems.push(`platforms.${platform}.signature 与签名文件内容不一致`);
    }
  }
  if (
    options.requirePlatform &&
    !Object.prototype.hasOwnProperty.call(
      manifest.platforms,
      options.requirePlatform,
    )
  ) {
    problems.push(`缺少平台条目：${options.requirePlatform}`);
  }
  return problems;
}

function parseArgs(argv) {
  const args = { file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect-version") args.expectVersion = argv[++index];
    else if (arg === "--require-platform") args.requirePlatform = argv[++index];
    else if (arg === "--signature-file") args.signatureFile = argv[++index];
    else if (!arg.startsWith("--") && !args.file) args.file = arg;
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.file) {
    console.error(
      "用法：node scripts/verify-updater-manifest.mjs <manifest.json> [--expect-version X.Y.Z] [--require-platform windows-x86_64] [--signature-file <path>]",
    );
    return 2;
  }
  if (!fs.existsSync(args.file)) {
    console.error(`[updater-manifest] 找不到清单：${args.file}`);
    return 1;
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(args.file, "utf8"));
  } catch (error) {
    console.error(`[updater-manifest] 清单不是合法 JSON：${error.message}`);
    return 1;
  }
  let expectedSignature = null;
  if (args.signatureFile) {
    if (!fs.existsSync(args.signatureFile)) {
      console.error(`[updater-manifest] 找不到签名文件：${args.signatureFile}`);
      return 1;
    }
    expectedSignature = fs.readFileSync(args.signatureFile, "utf8").trim();
  }
  const problems = verifyUpdaterManifest(manifest, {
    expectVersion: args.expectVersion,
    requirePlatform: args.requirePlatform,
    expectedSignature,
  });
  if (problems.length) {
    console.error(`[updater-manifest] 校验失败（${path.basename(args.file)}）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `[updater-manifest] OK ${path.basename(args.file)}：version=${manifest.version} platforms=${Object.keys(manifest.platforms).join(",")}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
