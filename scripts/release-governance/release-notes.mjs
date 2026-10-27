#!/usr/bin/env node
/**
 * 发布说明解析：`workflow_dispatch` 的 `release_notes` 为空或纯空白时，
 * 回落到既有 Draft 占位文案；否则原样（统一换行）作为 Release body。
 *
 * 输出写成 GitHub Actions step output（多行分隔符格式），由
 * `tauri-action` 的 `releaseBody` 直接消费。这样多行说明不会经过 YAML
 * 块标量或表达式拼接，避免缩进/引号被改写。
 *
 * 不写文件、不联网、不读取或输出任何密钥。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RELEASE_BODY = [
  "Release Candidate（**Draft，未公开**）。",
  "审批通过后由 release-publish 工作流校验绑定并发布。",
  "RC 记录（版本 / Commit / 制品 SHA-256 / 平台）见资产 rc-record.json。",
].join("\n");

/** 空/纯空白 → 占位文案；否则保留用户提供的多行正文（CRLF/CR 归一为 LF）。 */
export function resolveReleaseBody(notes) {
  const value = String(notes ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return value.length > 0 ? value : DEFAULT_RELEASE_BODY;
}

/**
 * 渲染成 GITHUB_OUTPUT 的多行 step output。分隔符随机生成并确认正文里
 * 不存在，避免用户说明恰好包含分隔符时截断输出。
 */
export function renderGithubOutput(body, key = "body") {
  let delimiter = `MR_RELEASE_BODY_${crypto.randomBytes(8).toString("hex")}`;
  while (String(body).includes(delimiter)) {
    delimiter = `MR_RELEASE_BODY_${crypto.randomBytes(8).toString("hex")}`;
  }
  return `${key}<<${delimiter}\n${String(body)}\n${delimiter}\n`;
}

/** 追加到 GITHUB_OUTPUT；没有该文件（本地调试）时退回 stdout。 */
export function writeReleaseBody(notes, { outputPath = process.env.GITHUB_OUTPUT } = {}) {
  const body = resolveReleaseBody(notes);
  const rendered = renderGithubOutput(body);
  if (outputPath) {
    fs.appendFileSync(outputPath, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
  return body;
}

function main() {
  const body = writeReleaseBody(process.env.RELEASE_NOTES);
  console.log(`[release-notes] 已写入 releaseBody（${body.split("\n").length} 行）`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
