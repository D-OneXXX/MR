#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ISSUE_REFERENCE_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:s|erences?)?)\s*:?\s*#(\d+)\b/gi;

const BRANCH_PATTERN = /^(fix|feat|hotfix|chore)\/(\d+)-[a-z0-9][a-z0-9-]*$/;

const SECTION_PATTERNS = {
  "验证": [/^验证$/, /^tests?$/i, /^verification$/i],
  "数据与隐私": [/^数据(与|和)隐私$/, /^数据影响$/, /^data\s*(and|&)?\s*privacy$/i, /^data\s*impact$/i],
  "发布影响": [/^发布影响$/, /^release\s*impact$/i],
};

export function parseIssueReferences(body) {
  const references = new Set();
  for (const match of String(body || "").matchAll(ISSUE_REFERENCE_PATTERN)) {
    references.add(Number(match[1]));
  }
  return [...references];
}

export function isAutomationPr({ authorLogin, headRefName } = {}) {
  const login = String(authorLogin || "").toLowerCase();
  const branch = String(headRefName || "").toLowerCase();
  return (
    branch.startsWith("dependabot/") ||
    branch.startsWith("renovate/") ||
    login.includes("dependabot") ||
    login.includes("renovate") ||
    login.endsWith("[bot]")
  );
}

function sectionContent(body, patterns) {
  const headings = [...String(body || "").matchAll(/^##\s+(.+?)\s*$/gm)];
  for (const [index, heading] of headings.entries()) {
    const title = heading[1].trim();
    if (!patterns.some((pattern) => pattern.test(title))) continue;
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : body.length;
    const content = body
      .slice(start, end)
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (content) return true;
  }
  return false;
}

export function validatePrMetadata(metadata) {
  if (isAutomationPr(metadata)) return [];

  const errors = [];
  if (metadata.baseRefName !== "main") {
    errors.push(`base-branch: PR 必须指向 main，当前为 ${metadata.baseRefName || "UNKNOWN"}`);
  }
  if (!String(metadata.title || "").trim()) {
    errors.push("title: PR 标题不能为空");
  }

  const branch = String(metadata.headRefName || "");
  const branchMatch = branch.match(BRANCH_PATTERN);
  if (!branchMatch) {
    errors.push(
      "branch-name: 分支必须形如 fix|feat|hotfix|chore/<issue>-<slug>，例如 chore/19-pr-governance",
    );
  }

  const references = parseIssueReferences(metadata.body);
  if (references.length === 0) {
    errors.push("issue-link: PR 正文必须包含 Closes/Fixes/Resolves/Refs #<issue>");
  } else if (branchMatch && !references.includes(Number(branchMatch[2]))) {
    errors.push(
      `branch-issue-mismatch: 分支编号 #${branchMatch[2]} 不在关联 Issue ${references
        .map((number) => `#${number}`)
        .join(", ")} 中`,
    );
  }

  for (const [name, patterns] of Object.entries(SECTION_PATTERNS)) {
    if (!sectionContent(metadata.body, patterns)) {
      errors.push(`section:${name}: PR 缺少非空的「${name}」段落`);
    }
  }

  return errors;
}

function readEvent(eventPath) {
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    throw new Error("GitHub event 不含 pull_request payload");
  }
  return {
    authorLogin: pullRequest.user?.login || "",
    headRefName: pullRequest.head?.ref || "",
    baseRefName: pullRequest.base?.ref || "",
    title: pullRequest.title || "",
    body: pullRequest.body || "",
    isDraft: Boolean(pullRequest.draft),
  };
}

function usage() {
  console.log(`Usage: node scripts/pr-governance.mjs [--event path]

Reads GITHUB_EVENT_PATH (or --event) and validates PR metadata only.
No network access, no pull-request code execution.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const eventIndex = args.indexOf("--event");
  const eventPath =
    eventIndex >= 0 ? args[eventIndex + 1] : process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("缺少 GITHUB_EVENT_PATH；本地测试请传 --event");
  }

  const metadata = readEvent(eventPath);
  const errors = validatePrMetadata(metadata);
  if (isAutomationPr(metadata)) {
    console.log(`[pr-governance] SKIP automation PR (${metadata.headRefName})`);
    return;
  }
  if (errors.length) {
    for (const error of errors) {
      console.error(`[pr-governance] ERROR ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[pr-governance] OK ${metadata.headRefName} -> ${metadata.baseRefName}: ${metadata.title}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[pr-governance] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
