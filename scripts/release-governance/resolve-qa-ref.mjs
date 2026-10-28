#!/usr/bin/env node
/**
 * 解析 qa-full 的 `ref` 输入：分支名 / 标签名 / 完整 Commit SHA。
 *
 * 契约（与 Issue 的验收条件一一对应）：
 * - 只接受**能唯一解析**的引用；解析不出来就明确失败（退出码 2），
 *   **绝不**回退到默认分支——否则 QA 报告会带着 main 的提交冒充用户要的证据；
 * - 输出的 `ref` 是交给 checkout 的值，`sha` 是被解析出来的**真实提交**；
 * - 调用方必须用检出的实际 HEAD 覆盖这个 sha（见工作流的 "Resolve source commit"），
 *   确保报告里的 head_sha 对应实际检出的提交，而不是用户输入的字符串。
 *
 * 用法：
 *   node scripts/release-governance/resolve-qa-ref.mjs <requested-ref> [--remote <name|url>]
 *
 * 成功时 stdout 输出 JSON：
 *   { "requested": "...", "kind": "branch|tag|commit", "ref": "...", "sha": "..." }
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,39}$/;

export class RefResolutionError extends Error {}

/** git 适配器：只暴露解析需要的三个查询。 */
function makeGit(remote) {
  // 注意：`git ls-remote` 的选项必须放在 remote **之前**，否则会被当成 pattern 过滤。
  const run = (flags, patterns = []) =>
    execFileSync("git", ["ls-remote", ...flags, remote, ...patterns], { encoding: "utf8" });
  return {
    heads: (pattern) => parseLsRemote(run(["--heads"], pattern ? [pattern] : [])),
    tags: (pattern) => parseLsRemote(run(["--tags"], pattern ? [pattern] : [])),
    all: () => parseLsRemote(run([])),
    /** 远端是否确实存在这个提交（fetch --dry-run 不会真正下载对象）。 */
    hasCommit: (sha) => {
      try {
        execFileSync("git", ["fetch", "--dry-run", "--no-tags", remote, sha], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, detail: "" };
      } catch (error) {
        const detail = String(error?.stderr || error?.message || "").trim();
        return { ok: false, detail };
      }
    },
  };
}

function parseLsRemote(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, ref] = line.split(/\s+/);
    // 剥离 `^{}` 形式的 peeled tag，只保留真正的引用。
    if (ref.endsWith("^{}")) continue;
    out.push({ sha, ref });
  }
  return out;
}

/**
 * 纯逻辑部分：把用户输入分类。
 * 返回 { kind: "commit" | "short-commit" | "name", value }
 */
export function classifyRequested(requested) {
  const value = String(requested ?? "").trim();
  if (!value) {
    throw new RefResolutionError("引用为空：请提供分支名、标签名或完整 Commit SHA");
  }
  if (FULL_SHA.test(value)) {
    return { kind: "commit", value };
  }
  if (SHORT_SHA.test(value)) {
    return { kind: "short-commit", value };
  }
  return { kind: "name", value };
}

/**
 * 解析引用。git 适配器可注入，便于测试。
 * 返回 { requested, kind, ref, sha }。
 */
export function resolveRef(requested, git) {
  const input = String(requested ?? "").trim();
  const classified = classifyRequested(requested);

  if (classified.kind === "commit") {
    // 完整 SHA：先确认远端确实有这个提交，再交给 checkout 直接检出。
    const probe = git.hasCommit(classified.value);
    if (!probe.ok) {
      throw new RefResolutionError(
        `远端不存在提交 "${classified.value}"${probe.detail ? `：${probe.detail.split("\n")[0]}` : ""}`,
      );
    }
    return {
      requested: input,
      kind: "commit",
      ref: classified.value,
      sha: classified.value,
    };
  }

  if (classified.kind === "short-commit") {
    // 短 SHA：只接受能唯一匹配某个分支/标签端点的情况，否则要求给完整 SHA。
    const tips = [...git.heads(""), ...git.tags("")];
    const matches = tips.filter((tip) => tip.sha.startsWith(classified.value));
    const unique = [...new Map(matches.map((m) => [m.sha, m])).values()];
    if (unique.length === 0) {
      throw new RefResolutionError(
        `无法解析短 SHA "${input}"：它不是任何分支或标签的端点，请提供完整 40 位 Commit SHA`,
      );
    }
    if (unique.length > 1) {
      throw new RefResolutionError(
        `短 SHA "${input}" 匹配到多个提交（${unique
          .map((m) => m.sha.slice(0, 12))
          .join(" / ")}），请提供完整 40 位 Commit SHA`,
      );
    }
    return {
      requested: input,
      kind: "commit",
      ref: unique[0].sha,
      sha: unique[0].sha,
    };
  }

  // 分支名 / 标签名。必须**精确**匹配同名引用：
  // `git ls-remote --heads origin x` 也会匹配 refs/heads/feature/x，
  // 所以这里按完整 ref 名再过滤一次。
  const name = classified.value.replace(/^refs\/(heads|tags)\//, "");
  const headRef = `refs/heads/${name}`;
  const heads = git.heads(name).filter((hit) => hit.ref === headRef);
  if (heads.length > 0) {
    return { requested: input, kind: "branch", ref: headRef, sha: heads[0].sha };
  }
  const tagRef = `refs/tags/${name}`;
  const tags = git.tags(name).filter((hit) => hit.ref === tagRef);
  if (tags.length > 0) {
    return { requested: input, kind: "tag", ref: tagRef, sha: tags[0].sha };
  }
  throw new RefResolutionError(
    `无法解析引用 "${input}"：远端既没有分支 ${headRef}，也没有标签 ${tagRef}。请确认名称，或改用完整 40 位 Commit SHA`,
  );
}

function main(argv) {
  const args = argv.slice(2);
  const remoteIndex = args.indexOf("--remote");
  const remote = remoteIndex >= 0 ? args[remoteIndex + 1] : "origin";
  const requested = args[0];
  try {
    const resolved = resolveRef(requested, makeGit(remote));
    process.stdout.write(`${JSON.stringify(resolved)}\n`);
  } catch (error) {
    if (error instanceof RefResolutionError) {
      process.stderr.write(`[resolve-qa-ref] ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv);
}
