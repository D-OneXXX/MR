#!/usr/bin/env node
/**
 * 候选流程的 Release 存在性判定（fail closed）。
 *
 * 背景：`gh release view` 对「Release 不存在」「401」「403 限流」「5xx」「DNS 失败」
 * **都返回退出码 1**，旧守卫用 `if ! gh release view` 一律当成"不存在"，于是瞬时
 * API 故障会让候选流程继续构建，Windows 侧的 tauri-action 随后按 tag 更新已有
 * Release——这正是已发布资产被改写的那条路径。
 *
 * 规则：只有拿到**正向的 404 证据**才允许继续创建 Draft；其余一切失败都拒绝。
 *
 * 用法（工作流内）：
 *   gh release view "$TAG" --json isDraft --jq .isDraft >"$OUT" 2>"$ERR"; STATUS=$?
 *   node scripts/release-governance/release-guard.mjs \
 *     --status "$STATUS" --stdout-file "$OUT" --stderr-file "$ERR" --tag "$TAG"
 *
 * 退出码：0 = 可继续（missing / draft）；2 = 已公开发布；3 = 状态无法确认。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 只有这些状态允许候选流程继续。 */
export const CONTINUE_STATES = new Set(["missing", "draft"]);

export const GUARD_EXIT_CODES = { missing: 0, draft: 0, published: 2, unknown: 3 };

/** 明确说明「这不是 404」的模式：命中任意一条即拒绝，优先于 not-found 判定。 */
const DENY_PATTERNS = [
  { pattern: /HTTP 401|Bad credentials|Requires authentication/i, reason: "鉴权失败" },
  { pattern: /HTTP 403/i, reason: "权限不足或触发限流" },
  { pattern: /rate limit/i, reason: "API 限流" },
  { pattern: /HTTP 5\d\d|Internal Server Error|Bad Gateway|Service Unavailable/i, reason: "服务端错误" },
  {
    pattern: /EOF|timeout|timed out|no such host|dial tcp|connection refused|TLS handshake|network is unreachable/i,
    reason: "网络/DNS 失败",
  },
];

/** 正向 404 证据：gh 的 `release not found` 或通用 `HTTP 404`。 */
const NOT_FOUND_PATTERNS = [/release not found/i, /HTTP 404/i];

/**
 * @param {{status: number, stdout?: string, stderr?: string}} input
 * @returns {"missing"|"draft"|"published"|"unknown"}
 */
export function classifyReleaseView({ status, stdout = "", stderr = "" }) {
  const code = Number(status);
  const out = String(stdout ?? "").trim();
  const err = String(stderr ?? "").trim();

  if (code === 0) {
    // 成功时 stdout 只应包含 --jq 的值；任何多余内容都视为不可信。
    if (out === "true") return "draft";
    if (out === "false") return "published";
    return "unknown";
  }

  const diagnostics = `${out}\n${err}`.trim();
  if (diagnostics.length === 0) return "unknown";

  // 先排除 401/403/5xx/网络：即使文本里同时出现 not found 也不能当"不存在"。
  for (const { pattern } of DENY_PATTERNS) {
    if (pattern.test(diagnostics)) return "unknown";
  }
  for (const pattern of NOT_FOUND_PATTERNS) {
    if (pattern.test(diagnostics)) return "missing";
  }
  return "unknown";
}

function firstLine(text, limit = 160) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ? line.slice(0, limit) : "";
}

/**
 * 把判定结果转成「退出码 + 给工作流的 stdout 状态 + 给日志的说明」。
 * @param {{status: number, stdout?: string, stderr?: string, tag?: string}} input
 */
export function evaluateReleaseGuard({ status, stdout = "", stderr = "", tag = "" }) {
  const state = classifyReleaseView({ status, stdout, stderr });
  const label = tag ? `Release ${tag}` : "目标 Release";
  const exitCode = GUARD_EXIT_CODES[state];

  if (state === "published") {
    return { state, exitCode, message: `${label} 已经公开发布，候选流程拒绝改写它` };
  }
  if (state === "unknown") {
    const detail = firstLine(stderr) || firstLine(stdout) || "无诊断输出";
    return {
      state,
      exitCode,
      message: `${label} 的状态无法确认（gh 退出码 ${status}）：${detail}；已拒绝继续，请人工确认`,
    };
  }
  if (state === "draft") {
    return { state, exitCode, message: `Draft 已存在，复用：${tag || "目标 Release"}` };
  }
  return { state, exitCode, message: `确认 ${label} 不存在，候选流程将创建 Draft` };
}

function readFileOrEmpty(file) {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const status = Number(valueOf("--status"));
  if (!Number.isInteger(status)) {
    console.error("[release-guard] 缺少或非法的 --status");
    return 3;
  }

  const result = evaluateReleaseGuard({
    status,
    stdout: readFileOrEmpty(valueOf("--stdout-file")),
    stderr: readFileOrEmpty(valueOf("--stderr-file")),
    tag: valueOf("--tag") || "",
  });

  if (result.exitCode === 0) {
    // stdout 只放状态 token：工作流用 case "$STATE" 分支，多一行就会失配。
    process.stdout.write(`${result.state}\n`);
  }
  // 说明一律走 stderr：既能在日志里看到原因，也不会污染 stdout 的状态。
  console.error(`[release-guard] ${result.message}`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv);
}
