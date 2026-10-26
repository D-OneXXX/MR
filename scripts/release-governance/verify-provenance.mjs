#!/usr/bin/env node
/**
 * 在线核验安装证据的 GitHub Actions provenance：
 * - 证据里的 runId / runUrl 必须指向**本仓库**的一次真实 workflow run；
 * - run 必须已成功完成、由 workflow_dispatch 触发、跑在 main 上；
 * - 证据的 verifiedAt 必须落在 run 的执行时间窗口内；
 * - 本地 VM 证据无法在线核验，默认只打印人工核验要求；正式 Windows 发布使用
 *   `--require-github-actions` 强制要求 hosted 干净 VM。
 *
 * 本脚本只读 GitHub API，不修改任何远端状态；绝不打印 token。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_WORKFLOW = ".github/workflows/release-install-verify.yml";

function normalizeWorkflowPath(value) {
  return String(value || "").replace(/^\/+/, "");
}

export function verifyProvenance(
  evidence,
  run,
  {
    repository,
    expectedWorkflow = DEFAULT_WORKFLOW,
    requireGithubActions = false,
    maxSkewMinutes = 10,
  } = {},
) {
  const problems = [];
  const provenance = evidence?.machine?.provenance;
  if (!provenance || typeof provenance !== "object") {
    return {
      ok: false,
      kind: null,
      manual: false,
      problems: ["安装证据缺少 machine.provenance，无法核验干净环境来源"],
    };
  }
  if (provenance.kind === "local-vm") {
    if (requireGithubActions) {
      return {
        ok: false,
        kind: "local-vm",
        manual: true,
        problems: [
          "本地 VM 证据无法由 GitHub API 在线核验；当前发布要求 GitHub-hosted 干净 VM",
        ],
      };
    }
    return {
      ok: true,
      kind: "local-vm",
      manual: true,
      problems: [],
    };
  }
  if (provenance.kind !== "github-actions") {
    return {
      ok: false,
      kind: String(provenance.kind),
      manual: false,
      problems: [`machine.provenance.kind 非法：${String(provenance.kind)}`],
    };
  }

  const runId = String(provenance.runId || "");
  if (!/^\d+$/.test(runId)) problems.push("provenance.runId 必须为纯数字");
  if (!repository) problems.push("未提供仓库标识（--repo owner/name）");
  if (provenance.repository !== repository) {
    problems.push(
      `provenance.repository 与核验仓库不一致：证据=${provenance.repository} 期望=${repository}`,
    );
  }
  const expectedUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (provenance.runUrl !== expectedUrl) {
    problems.push(`provenance.runUrl 与 repository/runId 不一致：期望 ${expectedUrl}`);
  }
  if (!run || typeof run !== "object") {
    problems.push("GitHub API 未返回 run 对象");
    return { ok: false, kind: "github-actions", manual: false, problems };
  }
  if (String(run.id) !== runId) {
    problems.push(`GitHub run id 与证据不一致：API=${run.id} 证据=${runId}`);
  }
  if (run.html_url && provenance.runUrl !== run.html_url) {
    problems.push(
      `provenance.runUrl 与 GitHub run 的 html_url 不一致：API=${run.html_url} 证据=${provenance.runUrl}`,
    );
  }
  if (run.repository?.full_name && run.repository.full_name !== repository) {
    problems.push(
      `GitHub run 所属仓库与证据不一致：API=${run.repository.full_name} 证据=${repository}`,
    );
  }
  const actualPath = normalizeWorkflowPath(run.path);
  const expectedPath = normalizeWorkflowPath(expectedWorkflow);
  if (actualPath !== expectedPath) {
    problems.push(`GitHub run 的 workflow 不是预期文件：API=${actualPath} 期望=${expectedPath}`);
  }
  if (provenance.workflow && !String(provenance.workflow).includes(expectedPath)) {
    problems.push("provenance.workflow 未指向预期 workflow 文件");
  }
  if (run.event !== "workflow_dispatch") {
    problems.push(`GitHub run 不是 workflow_dispatch：${String(run.event)}`);
  }
  if (run.status !== "completed") {
    problems.push(`GitHub run 尚未完成：${String(run.status)}`);
  }
  if (run.conclusion !== "success") {
    problems.push(`GitHub run 未成功：${String(run.conclusion)}`);
  }
  if (run.head_branch !== "main") {
    problems.push(`GitHub run 不在 main 上：${String(run.head_branch)}`);
  }
  if (
    provenance.runAttempt &&
    run.run_attempt !== undefined &&
    String(run.run_attempt) !== String(provenance.runAttempt)
  ) {
    problems.push(
      `GitHub run attempt 与证据不一致：API=${run.run_attempt} 证据=${provenance.runAttempt}`,
    );
  }
  if (run.actor?.login && provenance.actor !== run.actor.login) {
    problems.push(
      `GitHub run actor 与证据不一致：API=${run.actor.login} 证据=${provenance.actor}`,
    );
  }
  const evidenceAt = Date.parse(evidence.verifiedAt || "");
  const startedAt = Date.parse(run.run_started_at || "");
  const updatedAt = Date.parse(run.updated_at || "");
  if (Number.isNaN(evidenceAt)) {
    problems.push("安装证据缺少合法的 verifiedAt");
  } else if (Number.isNaN(startedAt) || Number.isNaN(updatedAt)) {
    problems.push("GitHub run 缺少合法的 run_started_at/updated_at");
  } else {
    const skew = Math.max(0, Number(maxSkewMinutes) || 0) * 60_000;
    if (evidenceAt < startedAt - skew || evidenceAt > updatedAt + skew) {
      problems.push(
        `安装证据时间不在 GitHub run 执行窗口内：证据=${evidence.verifiedAt} run=${run.run_started_at}..${run.updated_at}`,
      );
    }
  }
  return {
    ok: problems.length === 0,
    kind: "github-actions",
    manual: false,
    problems,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export async function fetchRun({ repository, runId, token, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "manga-reader-release-gate",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.evidence) {
    console.error("[provenance] 缺少 --evidence <install-verification.json>");
    return 2;
  }
  if (!fs.existsSync(args.evidence)) {
    console.error(`[provenance] 找不到证据：${args.evidence}`);
    return 2;
  }
  const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
  const repository = args.repo || process.env.GITHUB_REPOSITORY || "";
  const expectedWorkflow = args["expected-workflow"] || DEFAULT_WORKFLOW;
  const requireGithubActions = Boolean(args["require-github-actions"]);
  const provenance = evidence?.machine?.provenance;
  const runId = String(provenance?.runId || "");
  const token = args["github-token"] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

  if (provenance?.kind === "local-vm") {
    const verdict = verifyProvenance(evidence, null, {
      repository,
      expectedWorkflow,
      requireGithubActions,
    });
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    }
    if (!verdict.ok) {
      console.error("[provenance] 拒绝：");
      for (const problem of verdict.problems) console.error(`  - ${problem}`);
      return 1;
    }
    console.log("[provenance] 本地 VM 证据：需要人工核验镜像 SHA-256 与运行日志（未在线核验）");
    return 0;
  }

  if (!token) {
    console.error("[provenance] 在线核验 GitHub Actions 证据需要 GH_TOKEN/GITHUB_TOKEN");
    return 2;
  }
  let run = null;
  try {
    run = await fetchRun({ repository, runId, token });
  } catch (error) {
    console.error(`[provenance] 无法读取 GitHub run：${error.message}`);
    return 1;
  }
  const verdict = verifyProvenance(evidence, run, {
    repository,
    expectedWorkflow,
    requireGithubActions,
  });
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }
  if (!verdict.ok) {
    console.error("[provenance] 拒绝：");
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `[provenance] OK run=${runId} image=${provenance.imageOs}/${provenance.imageVersion} url=${provenance.runUrl}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = await main();
}
