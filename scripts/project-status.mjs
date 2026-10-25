#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "docs", "PROJECT_STATE.md");

export function compareSemver(left, right) {
  const parse = (value) => {
    const match = String(value || "")
      .trim()
      .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) {
      throw new Error(`invalid semantic version: ${value}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

export function classifyMaintenancePhase({
  packageVersion,
  latestReleaseVersion,
  headAhead,
  releaseBlockers,
}) {
  const blockerCount = Array.isArray(releaseBlockers)
    ? releaseBlockers.length
    : Number(releaseBlockers || 0);
  if (blockerCount > 0) {
    return {
      code: "release-blocked",
      label: "发布被阻塞",
      reason: `存在 ${blockerCount} 个阻塞项，不能进入发布候选。`,
    };
  }
  if (!latestReleaseVersion) {
    return {
      code: "pre-release",
      label: "尚未发布",
      reason: "没有可读取的最新 Release，当前处于首次发布或发布数据不可用状态。",
    };
  }
  const comparison = compareSemver(packageVersion, latestReleaseVersion);
  if (comparison < 0) {
    return {
      code: "version-regression",
      label: "版本号低于最新发布",
      reason: `package.json 为 ${packageVersion}，低于最新 Release ${latestReleaseVersion}。`,
    };
  }
  if (comparison > 0) {
    return {
      code: "release-preparation",
      label: "发布准备中",
      reason: `package.json 已提升到 ${packageVersion}，最新公开 Release 为 ${latestReleaseVersion}。`,
    };
  }
  if (!Number.isFinite(Number(headAhead))) {
    return {
      code: "unknown",
      label: "UNKNOWN",
      reason: "无法比较 HEAD 与最新 Release 的提交距离。",
    };
  }
  if (Number(headAhead) > 0) {
    return {
      code: "development-same-version",
      label: "开发中（与最新发布同版本）",
      reason: `HEAD 领先最新发布 ${headAhead} 个提交，但版本号仍为 ${packageVersion}。下一次发布前必须 bump。`,
    };
  }
  return {
    code: "released-stable",
    label: "已发布稳定",
    reason: `HEAD 与最新 Release ${latestReleaseVersion} 版本一致，且没有领先提交。`,
  };
}

export function parseRepoFromRemote(remote) {
  const value = String(remote || "").trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return { owner: match[1], name: match[2] };
    }
  }
  return null;
}

export function protectionBranchName({ defaultBranch, currentBranch } = {}) {
  return defaultBranch || currentBranch || "main";
}

export function summarizeWorkingTree({
  stagedFiles = [],
  modifiedFiles = [],
  untrackedFiles = [],
} = {}) {
  const staged = Array.isArray(stagedFiles) ? stagedFiles.length : 0;
  const modified = Array.isArray(modifiedFiles) ? modifiedFiles.length : 0;
  const untracked = Array.isArray(untrackedFiles) ? untrackedFiles.length : 0;
  return {
    dirty: staged + modified + untracked > 0,
    staged,
    modified,
    untracked,
  };
}

function mdCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeInline(value) {
  return String(value ?? "").replaceAll("`", "'").trim();
}

function labelNames(issue) {
  return (issue.labels || []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function statusLabel(issue) {
  return labelNames(issue).find((name) => name.startsWith("status:")) || "—";
}

function severityLabel(issue) {
  return labelNames(issue).find((name) => name.startsWith("severity:")) || "—";
}

function severityRank(issue) {
  const severity = severityLabel(issue);
  return severity === "—" ? 99 : Number(severity.split(":")[1] || 99);
}

function renderChecks(github) {
  if (!github.available) {
    return "- HEAD CI：UNKNOWN（GitHub 数据不可用）";
  }
  if (github.checksAvailable === false) {
    return "- HEAD CI：UNKNOWN（check-run 数据不可用）";
  }
  if (!github.checkRuns || github.checkRuns.length === 0) {
    return "- HEAD CI：UNKNOWN（没有 check-run 数据）";
  }
  const protection = github.branchProtection;
  const scopeKnown = Boolean(
    protection?.available && protection.protected !== false,
  );
  const required = new Set(protection?.requiredChecks || []);
  const lines = [
    "| 检查 | 必需 | 状态 | 结论 |",
    "|---|---|---|---|",
  ];
  for (const check of github.checkRuns) {
    const scope = scopeKnown
      ? required.has(check.name)
        ? "是"
        : "否"
      : "UNKNOWN";
    lines.push(
      `| ${mdCell(check.name)} | ${scope} | ${mdCell(check.status)} | ${mdCell(check.conclusion || "—")} |`,
    );
  }
  return lines.join("\n");
}

function renderBranchProtection(github) {
  const protection = github.branchProtection;
  if (!github.available || !protection || protection.available === false) {
    return "- 分支保护：UNKNOWN（enforce_admins=UNKNOWN）";
  }
  if (protection.protected === false) {
    return "- 分支保护：未启用（enforce_admins=UNKNOWN）";
  }
  const checks = (protection.requiredChecks || []).join(", ") || "无";
  const reviews = protection.requiredReviews ? "必需" : "非必需";
  const force = protection.allowForcePushes === null ? "UNKNOWN" : protection.allowForcePushes ? "允许" : "禁止";
  const deletion = protection.allowDeletions === null ? "UNKNOWN" : protection.allowDeletions ? "允许" : "禁止";
  return [
    `- 分支保护：enforce_admins=${protection.enforceAdmins === null ? "UNKNOWN" : protection.enforceAdmins}`,
    `- required checks：${mdCell(checks)}`,
    `- required reviews：${reviews}`,
    `- force push：${force}；deletion：${deletion}`,
  ].join("\n");
}

function renderEnvironments(github) {
  if (!github.available || !github.environments || github.environments.available === false) {
    return "- 发布审批环境：UNKNOWN";
  }
  if (!github.environments.names || github.environments.names.length === 0) {
    return "- 发布审批环境：未配置";
  }
  return `- 发布审批环境：${github.environments.names.map(escapeInline).join(", ")}`;
}

function renderIssues(github) {
  if (!github.available || github.issuesAvailable === false) {
    return "UNKNOWN（Issue 数据不可用）";
  }
  if (!github.issues || github.issues.length === 0) {
    return "无开放 Issue。";
  }
  const lines = [
    "| # | 标题 | 状态 | 严重度 | 负责人 |",
    "|---|---|---|---|---|",
  ];
  for (const issue of github.issues) {
    const assignee = (issue.assignees || []).map((item) => item.login).join(", ") || "—";
    lines.push(
      `| #${issue.number} | ${mdCell(issue.title)} | ${mdCell(statusLabel(issue))} | ${mdCell(severityLabel(issue))} | ${mdCell(assignee)} |`,
    );
  }
  return lines.join("\n");
}

function renderPrs(github) {
  if (!github.available || github.prsAvailable === false) {
    return "UNKNOWN（PR 数据不可用）";
  }
  if (!github.prs || github.prs.length === 0) {
    return "无开放 PR。";
  }
  const lines = [
    "| # | 标题 | 分支 | 状态 |",
    "|---|---|---|---|",
  ];
  for (const pr of github.prs) {
    lines.push(
      `| #${pr.number} | ${mdCell(pr.title)} | ${mdCell(pr.headRefName)} | ${pr.isDraft ? "Draft" : "Open"} |`,
    );
  }
  return lines.join("\n");
}

function renderRuns(github) {
  if (!github.available || github.runsAvailable === false) {
    return "UNKNOWN（CI 数据不可用）";
  }
  if (!github.runs || github.runs.length === 0) {
    return "无 CI 数据。";
  }
  const lines = [
    "| Workflow | 事件 | 分支 | 状态 | 结论 |",
    "|---|---|---|---|---|",
  ];
  for (const run of github.runs) {
    lines.push(
      `| ${mdCell(run.name)} | ${mdCell(run.event)} | ${mdCell(run.headBranch)} | ${mdCell(run.status)} | ${mdCell(run.conclusion || "—")} |`,
    );
  }
  return lines.join("\n");
}

function renderReleases(github) {
  if (!github.available || github.releasesAvailable === false) {
    return "UNKNOWN（Release 数据不可用）";
  }
  if (!github.releases || github.releases.length === 0) {
    return "无 Release 数据。";
  }
  const lines = [
    "| Tag | 名称 | 类型 | 发布时间 |",
    "|---|---|---|---|",
  ];
  for (const release of github.releases) {
    const kind = release.isDraft ? "Draft" : release.isPrerelease ? "Prerelease" : "Published";
    lines.push(
      `| ${mdCell(release.tagName)} | ${mdCell(release.name)} | ${kind} | ${mdCell(release.publishedAt)} |`,
    );
  }
  return lines.join("\n");
}

function renderWorktrees(worktrees) {
  if (!worktrees || worktrees.length === 0) {
    return "无已注册 Worktree。";
  }
  return worktrees
    .map((worktree) => {
      const rawPath = typeof worktree === "string" ? worktree : worktree.path;
      const branch = typeof worktree === "string" ? "UNKNOWN" : worktree.branch || "detached";
      return `\`${escapeInline(path.basename(rawPath))}\`（${escapeInline(branch)}）`;
    })
    .join(", ");
}

export function renderStatusSnapshot(snapshot) {
  const github = snapshot.github || {
    available: false,
    error: "无 GitHub 数据",
    issues: [],
    prs: [],
    releases: [],
    runs: [],
    checkRuns: [],
    branchProtection: { available: false },
    environments: { available: false, names: [] },
  };
  const version = snapshot.version || {};
  const repo = snapshot.repo || {};
  const worktree = repo.workingTree || {};
  const phase = snapshot.phase || { label: "UNKNOWN", reason: "无阶段数据" };
  const githubLine = github.available
    ? "- GitHub 数据：可用"
    : `- GitHub 数据：UNKNOWN（${escapeInline(github.error || "未提供原因")}）`;
  const githubWarning =
    github.available && github.error
      ? `\n- GitHub 警告：${escapeInline(github.error)}`
      : "";

  const blockers = snapshot.blockers || [];
  const aheadText = (value) =>
    Number.isFinite(Number(value)) ? `${value} 个提交` : "UNKNOWN";
  const channelRows = [
    version.windowsReleaseTag
      ? `| 最新 Windows Release | \`${version.windowsReleaseTag}\`（${version.windowsReleaseVersion || "UNKNOWN"}）；HEAD 领先 ${aheadText(version.windowsHeadAhead)} |`
      : "",
    version.linuxReleaseTag
      ? `| 最新 Linux critical Release | \`${version.linuxReleaseTag}\`（${version.linuxReleaseVersion || "UNKNOWN"}）；HEAD 领先 ${aheadText(version.linuxHeadAhead)} |`
      : "",
  ].filter(Boolean);
  const channelBlock = channelRows.length ? `${channelRows.join("\n")}\n` : "";
  const blockersText =
    !github.available || github.issuesAvailable === false
      ? "UNKNOWN（Issue 数据不可用）"
      : blockers.length === 0
        ? "无已知阻塞项。"
        : blockers
            .map(
              (issue) =>
                `- #${issue.number} ${escapeInline(issue.title)}（${labelNames(issue)
                  .filter((name) => name.startsWith("status:") || name === "release:blocker")
                  .join(", ") || "—"}）`,
            )
            .join("\n");
  const nextTask =
    !github.available || github.issuesAvailable === false
      ? "UNKNOWN（Issue 数据不可用）"
      : snapshot.nextTask
        ? `#${snapshot.nextTask.number} ${escapeInline(snapshot.nextTask.title)}`
        : "无开放 Issue；由维护者选择下一任务。";

  const governanceWarnings = [];
  if (!github.available) {
    governanceWarnings.push("GitHub 数据不可用：Issue/PR/CI/Release 为 UNKNOWN。");
  } else {
    const protection = github.branchProtection;
    if (!protection || protection.available === false) {
      governanceWarnings.push("分支保护状态为 UNKNOWN。");
    } else if (protection.protected === false) {
      governanceWarnings.push(
        `${github.defaultBranch || "main"} 未启用分支保护。`,
      );
    } else if (protection.enforceAdmins === false) {
      governanceWarnings.push("管理员可绕过分支保护（enforce_admins=false）。");
    }
    if (!github.environments || github.environments.available === false) {
      governanceWarnings.push("发布审批环境 UNKNOWN。");
    } else if ((github.environments.names || []).length === 0) {
      governanceWarnings.push("未配置发布审批环境；Phase 1–3 禁止推送发布 Tag。");
    }
    if (github.releasesAvailable === false) {
      governanceWarnings.push("Release 数据不可用；不得据此判断版本已同步。");
    }
  }
  if (phase.code === "development-same-version") {
    governanceWarnings.push("最新版本已发布但 HEAD 仍有未发布提交；下一次发布前必须 bump。");
  }
  if (
    Number.isFinite(Number(version.windowsHeadAhead)) &&
    Number(version.windowsHeadAhead) > 0
  ) {
    governanceWarnings.push(
      `Windows 常规通道落后 HEAD ${version.windowsHeadAhead} 个提交。`,
    );
  }
  if (
    Number.isFinite(Number(version.linuxHeadAhead)) &&
    Number(version.linuxHeadAhead) > 0
  ) {
    governanceWarnings.push(
      `Linux critical 通道落后 HEAD ${version.linuxHeadAhead} 个提交。`,
    );
  }
  const governanceText =
    governanceWarnings.length === 0
      ? "无治理告警。"
      : governanceWarnings.map((warning) => `- ${warning}`).join("\n");

  return `# MangaReader 项目状态

> 生成时间：${snapshot.generatedAt || "UNKNOWN"}
> 本文件由 \`npm run status\` 生成，请勿手工编辑。
> \`UNKNOWN\` 表示当前环境无法验证，不代表正常。

## 1. 版本与维护阶段

| 项目 | 值 |
|---|---|
| package.json | \`${version.packageVersion || "UNKNOWN"}\` |
| 最新 Release | \`${version.latestReleaseTag || "UNKNOWN"}\`（${version.latestReleaseVersion || "UNKNOWN"}） |
${channelBlock}| HEAD 距最新 Release | ${Number.isFinite(Number(version.headAheadOfLatestRelease)) ? `${version.headAheadOfLatestRelease} 个提交` : "UNKNOWN"} |
| 当前阶段 | ${phase.label} |
| 判定依据 | ${phase.reason} |

## 2. 仓库与工作区

| 项目 | 值 |
|---|---|
| 分支 | \`${repo.branch || "UNKNOWN"}\` |
| HEAD | \`${repo.headShort || "UNKNOWN"}\` |
| 提交 | ${repo.headSubject || "UNKNOWN"} |
| 提交时间 | ${repo.headDate || "UNKNOWN"} |
| 工作区 | ${worktree.dirty ? `有改动（staged=${worktree.staged || 0}, modified=${worktree.modified || 0}, untracked=${worktree.untracked || 0}）` : "干净"} |
| 本地分支 | ${(repo.localBranches || []).map((name) => `\`${escapeInline(name)}\``).join(", ") || "UNKNOWN"} |
| 已注册 Worktree | ${renderWorktrees(repo.worktrees)} |

## 3. 质量门禁

${githubLine}${githubWarning}

${renderChecks(github)}

${renderBranchProtection(github)}

${renderEnvironments(github)}

## 4. 活跃 Issue

${renderIssues(github)}

## 5. 开放 PR

${renderPrs(github)}

## 6. 最近 CI

${renderRuns(github)}

## 7. 最近 Release

${renderReleases(github)}

## 8. 阻塞项与下一步

### 治理告警

${governanceText}

### 阻塞项

${blockersText}

### 下一步任务

${nextTask}

## 9. 恢复检查清单

1. 运行 \`npm run status\` 刷新本文件。
2. 阅读 \`AGENTS.md\` 与 \`docs/ENGINEERING_WORKFLOW.md\`。
3. 运行 \`git status --short\` 与 \`git worktree list\`，确认没有覆盖他人修改。
4. 在 GitHub Issue 中确认认领、分支和 One Writer 归属。
5. 检查 HEAD CI、最新 Release 与阻塞项，再开始修改。
`;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function git(args) {
  const result = run("git", args);
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function sanitizeError(value) {
  const text = String(value || "").trim();
  return text.replaceAll(repoRoot, "<repo>").replace(/\s+/g, " ").slice(0, 400);
}

function ghApi(endpoint) {
  const result = run("gh", [
    "api",
    endpoint,
    "--header",
    "Accept: application/vnd.github+json",
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: sanitizeError(result.stderr || result.stdout),
    };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      error: `invalid GitHub JSON: ${sanitizeError(error.message)}`,
    };
  }
}

function parseWorktrees(text) {
  if (!text) return [];
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const headLine = lines.find((line) => line.startsWith("HEAD "));
      return {
        path: worktreeLine ? worktreeLine.slice("worktree ".length) : "",
        branch: branchLine ? branchLine.slice("branch ".length).replace(/^refs\/heads\//, "") : "detached",
        head: headLine ? headLine.slice("HEAD ".length) : "",
      };
    })
    .filter((worktree) => worktree.path);
}

function nameList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean);
}

function baseVersionFromTag(tag) {
  const match = String(tag || "").match(/^v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function headAheadForTag(tag) {
  if (!tag) return null;
  const count = git(["rev-list", "--count", `${tag}..HEAD`]);
  return count === null ? null : Number(count);
}

function mapIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    labels: (issue.labels || []).map((label) => ({ name: label.name })),
    assignees: (issue.assignees || []).map((assignee) => ({ login: assignee.login })),
    updatedAt: issue.updated_at,
    url: issue.html_url,
  };
}

function mapRelease(release) {
  return {
    tagName: release.tag_name,
    name: release.name || release.tag_name,
    isDraft: Boolean(release.draft),
    isPrerelease: Boolean(release.prerelease),
    publishedAt: release.published_at,
    url: release.html_url,
  };
}

function mapRun(run) {
  return {
    databaseId: run.id,
    name: run.name,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    url: run.html_url,
  };
}

function collectSnapshot() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "UNKNOWN";
  const headSha = git(["rev-parse", "HEAD"]);
  const headShort = headSha ? headSha.slice(0, 12) : "UNKNOWN";
  const headSubject = git(["log", "-1", "--format=%s"]) || "UNKNOWN";
  const headDate = git(["log", "-1", "--format=%cI"]) || "UNKNOWN";
  const workingTree = summarizeWorkingTree({
    stagedFiles: nameList(git(["diff", "--cached", "--name-only"])),
    modifiedFiles: nameList(git(["diff", "--name-only"])),
    untrackedFiles: nameList(
      git(["ls-files", "--others", "--exclude-standard"]),
    ),
  });
  const localBranches = (git(["branch", "--format=%(refname:short)"]) || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"]) || "");
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;

  const repoFromEnv = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY.split("/")
    : null;
  const repo =
    repoFromEnv && repoFromEnv.length === 2
      ? { owner: repoFromEnv[0], name: repoFromEnv[1] }
      : parseRepoFromRemote(git(["remote", "get-url", "origin"]));

  const github = {
    available: false,
    error: null,
    defaultBranch: null,
    issuesAvailable: false,
    prsAvailable: false,
    releasesAvailable: false,
    runsAvailable: false,
    checksAvailable: false,
    issues: [],
    prs: [],
    releases: [],
    runs: [],
    checkRuns: [],
    branchProtection: { available: false },
    environments: { available: false, names: [] },
  };
  let latestRelease = null;
  let latestReleaseVersion = null;
  let headAhead = null;

  if (!repo) {
    github.error = "无法从 origin 解析 GitHub owner/repo";
  } else {
    const auth = run("gh", ["auth", "status"]);
    if (auth.status !== 0) {
      github.error = `gh 未登录或不可用：${sanitizeError(auth.stderr || auth.stdout)}`;
    } else {
      github.available = true;
      const base = `repos/${repo.owner}/${repo.name}`;
      const repoInfo = ghApi(base);
      const defaultBranch = repoInfo.ok ? repoInfo.data.default_branch : "main";
      github.defaultBranch = defaultBranch;
      const latest = ghApi(`${base}/releases/latest`);
      if (latest.ok) {
        latestRelease = mapRelease(latest.data);
        latestReleaseVersion = baseVersionFromTag(latestRelease.tagName);
      } else if (!/404|not found/i.test(latest.error)) {
        github.error = `读取最新 Release 失败：${latest.error}`;
      }

      const releases = ghApi(`${base}/releases?per_page=5`);
      if (releases.ok) {
        github.releases = releases.data.map(mapRelease);
        github.releasesAvailable = true;
      }

      const issues = ghApi(`${base}/issues?state=open&per_page=100`);
      if (issues.ok) {
        github.issues = issues.data
          .filter((item) => !item.pull_request)
          .map(mapIssue);
        github.issuesAvailable = true;
      }

      const prs = ghApi(`${base}/pulls?state=open&per_page=50`);
      if (prs.ok) {
        github.prs = prs.data.map((pr) => ({
          number: pr.number,
          title: pr.title,
          headRefName: pr.head?.ref || "",
          isDraft: Boolean(pr.draft),
          url: pr.html_url,
        }));
        github.prsAvailable = true;
      }

      const runs = ghApi(`${base}/actions/runs?per_page=5`);
      if (runs.ok) {
        github.runs = (runs.data.workflow_runs || []).map(mapRun);
        github.runsAvailable = true;
      }

      if (headSha) {
        const checks = ghApi(`${base}/commits/${headSha}/check-runs`);
        if (checks.ok) {
          github.checkRuns = (checks.data.check_runs || []).map((check) => ({
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
          }));
          github.checksAvailable = true;
        }
      }

      const protection = ghApi(
        `${base}/branches/${encodeURIComponent(
          protectionBranchName({ defaultBranch, currentBranch: branch }),
        )}/protection`,
      );
      if (protection.ok) {
        const required = protection.data.required_status_checks;
        github.branchProtection = {
          available: true,
          protected: true,
          enforceAdmins: protection.data.enforce_admins?.enabled ?? null,
          requiredChecks:
            required?.contexts ||
            (required?.checks || []).map((check) => check.context),
          requiredReviews: Boolean(protection.data.required_pull_request_reviews),
          allowForcePushes: protection.data.allow_force_pushes?.enabled ?? null,
          allowDeletions: protection.data.allow_deletions?.enabled ?? null,
        };
      } else if (/404|not found/i.test(protection.error)) {
        github.branchProtection = {
          available: true,
          protected: false,
          enforceAdmins: null,
          requiredChecks: [],
          requiredReviews: false,
          allowForcePushes: null,
          allowDeletions: null,
        };
      }

      const environments = ghApi(`${base}/environments`);
      if (environments.ok) {
        github.environments = {
          available: true,
          names: (environments.data.environments || []).map((env) => env.name),
        };
      }

      if (latestRelease?.tagName) {
        headAhead = headAheadForTag(latestRelease.tagName);
      }
    }
  }

  const blockers = github.issues.filter((issue) =>
    labelNames(issue).some(
      (name) => name === "release:blocker" || name === "status:blocked",
    ),
  );
  const publishedReleases = github.releases.filter(
    (release) => !release.isDraft && !release.isPrerelease,
  );
  const windowsRelease = publishedReleases.find(
    (release) => !release.tagName.includes("-linux"),
  );
  const linuxRelease = publishedReleases.find((release) =>
    release.tagName.includes("-linux"),
  );
  const inProgress = github.issues.find((issue) =>
    labelNames(issue).includes("status:in-progress"),
  );
  const nextIssue =
    inProgress ||
    [...github.issues].sort((a, b) => severityRank(a) - severityRank(b))[0] ||
    null;
  const phase = classifyMaintenancePhase({
    packageVersion,
    latestReleaseVersion,
    headAhead,
    releaseBlockers: blockers.length,
  });

  return {
    generatedAt: new Date().toISOString(),
    repo: {
      branch,
      headSha,
      headShort,
      headSubject,
      headDate,
      workingTree,
      localBranches,
      worktrees,
    },
    version: {
      packageVersion,
      latestReleaseVersion,
      latestReleaseTag: latestRelease?.tagName || null,
      headAheadOfLatestRelease: headAhead,
      sameVersionAsRelease:
        latestReleaseVersion === null
          ? null
          : packageVersion === latestReleaseVersion,
      windowsReleaseTag: windowsRelease?.tagName || null,
      windowsReleaseVersion: windowsRelease
        ? baseVersionFromTag(windowsRelease.tagName)
        : null,
      windowsHeadAhead: headAheadForTag(windowsRelease?.tagName),
      linuxReleaseTag: linuxRelease?.tagName || null,
      linuxReleaseVersion: linuxRelease
        ? baseVersionFromTag(linuxRelease.tagName)
        : null,
      linuxHeadAhead: headAheadForTag(linuxRelease?.tagName),
    },
    phase,
    github,
    blockers,
    nextTask: nextIssue ? { number: nextIssue.number, title: nextIssue.title } : null,
  };
}

function usage() {
  console.log(`Usage: node scripts/project-status.mjs [--stdout|--json]

  default   Write docs/PROJECT_STATE.md.
  --stdout  Print the Markdown snapshot instead of writing.
  --json    Print the raw snapshot as JSON.

The script is read-only against Git and GitHub. Missing GitHub access is rendered as UNKNOWN.`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const snapshot = collectSnapshot();
  if (args.includes("--json")) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const markdown = renderStatusSnapshot(snapshot);
  if (args.includes("--stdout")) {
    process.stdout.write(markdown);
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, "utf8");
  console.log(`[status] wrote ${path.relative(repoRoot, outputPath)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[status] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
