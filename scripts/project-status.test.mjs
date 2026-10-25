import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMaintenancePhase,
  compareSemver,
  parseRepoFromRemote,
  protectionBranchName,
  renderStatusSnapshot,
  summarizeWorkingTree,
} from "./project-status.mjs";

function baseSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-10-26T00:00:00.000Z",
    repo: {
      branch: "main",
      headSha: "f1093a11ae68c08c625d48b0a3ee710bd2017421",
      headShort: "f1093a1",
      headSubject: "fix(privacy): test",
      headDate: "2026-10-25T10:33:44Z",
      workingTree: { dirty: false, staged: 0, modified: 0, untracked: 0 },
      localBranches: ["main"],
      worktrees: ["C:/Users/example/manga-reader-tauri"],
    },
    version: {
      packageVersion: "0.17.1",
      latestReleaseVersion: "0.17.1",
      latestReleaseTag: "v0.17.1-linux-sec1",
      headAheadOfLatestRelease: 3,
      sameVersionAsRelease: true,
    },
    phase: {
      code: "development-same-version",
      label: "开发中（与最新发布同版本）",
      reason: "HEAD 领先最新发布 3 个提交，但版本号未变化。",
    },
    github: {
      available: true,
      error: null,
      issues: [],
      prs: [],
      releases: [],
      runs: [],
      checkRuns: [
        { name: "Windows check", status: "completed", conclusion: "success" },
      ],
      branchProtection: {
        available: true,
        enforceAdmins: false,
        requiredChecks: ["Windows check", "Linux check"],
        requiredReviews: false,
        allowForcePushes: false,
        allowDeletions: false,
      },
      environments: { available: true, names: [] },
    },
    blockers: [],
    nextTask: null,
    ...overrides,
  };
}

test("compareSemver orders patch, minor and major versions", () => {
  assert.equal(compareSemver("0.17.1", "0.17.1"), 0);
  assert.equal(compareSemver("0.17.2", "0.17.1"), 1);
  assert.equal(compareSemver("0.16.9", "0.17.0"), -1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
});

test("classifyMaintenancePhase flags development on an already released version", () => {
  const phase = classifyMaintenancePhase({
    packageVersion: "0.17.1",
    latestReleaseVersion: "0.17.1",
    headAhead: 6,
    releaseBlockers: 0,
  });
  assert.equal(phase.code, "development-same-version");
  assert.match(phase.reason, /6/);
});

test("classifyMaintenancePhase treats release blockers as the dominant state", () => {
  const phase = classifyMaintenancePhase({
    packageVersion: "0.17.1",
    latestReleaseVersion: "0.17.1",
    headAhead: 6,
    releaseBlockers: 2,
  });
  assert.equal(phase.code, "release-blocked");
});

test("classifyMaintenancePhase reports a stable release when HEAD is the release commit", () => {
  const phase = classifyMaintenancePhase({
    packageVersion: "0.17.2",
    latestReleaseVersion: "0.17.2",
    headAhead: 0,
    releaseBlockers: 0,
  });
  assert.equal(phase.code, "released-stable");
});

test("renderStatusSnapshot degrades to UNKNOWN when GitHub is unavailable", () => {
  const snapshot = baseSnapshot({
    github: {
      available: false,
      error: "gh is not authenticated",
      issues: [],
      prs: [],
      releases: [],
      runs: [],
      checkRuns: [],
      branchProtection: { available: false },
      environments: { available: false, names: [] },
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /GitHub 数据：UNKNOWN/);
  assert.match(markdown, /gh is not authenticated/);
  assert.match(markdown, /enforce_admins=UNKNOWN/);
});

test("renderStatusSnapshot shows blockers, next task and gate drift", () => {
  const snapshot = baseSnapshot({
    blockers: [
      { number: 12, title: "Updater regression", labels: ["severity:p1", "status:blocked"] },
    ],
    nextTask: { number: 12, title: "Updater regression" },
    github: {
      ...baseSnapshot().github,
      issues: [
        {
          number: 12,
          title: "Updater regression",
          labels: [{ name: "severity:p1" }, { name: "status:blocked" }],
          assignees: [{ login: "D-OneXXX" }],
          updatedAt: "2026-10-25T10:00:00Z",
          url: "https://github.com/D-OneXXX/MR/issues/12",
        },
      ],
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /#12/);
  assert.match(markdown, /Updater regression/);
  assert.match(markdown, /enforce_admins=false/);
  assert.match(markdown, /发布审批环境：未配置/);
  assert.match(markdown, /下一步任务/);
});

test("renderStatusSnapshot never prints an absolute local worktree path", () => {
  const markdown = renderStatusSnapshot(baseSnapshot());
  assert.doesNotMatch(markdown, /C:\\Users\\/);
});

test("renderStatusSnapshot separates GitHub status lists from the check table", () => {
  const markdown = renderStatusSnapshot(baseSnapshot());
  assert.match(markdown, /- GitHub 数据：可用\n\n\| 检查 \|/);
  assert.match(markdown, /- 发布审批环境：未配置\n\n## 4\. 活跃 Issue/);
});

test("renderStatusSnapshot marks required and non-required check runs", () => {
  const base = baseSnapshot();
  const snapshot = baseSnapshot({
    github: {
      ...base.github,
      checkRuns: [
        { name: "Windows check", status: "completed", conclusion: "success" },
        { name: "Dependabot", status: "completed", conclusion: "failure" },
      ],
      branchProtection: {
        ...base.github.branchProtection,
        requiredChecks: ["Windows check"],
      },
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /\| Windows check \| 是 \| completed \| success \|/);
  assert.match(markdown, /\| Dependabot \| 否 \| completed \| failure \|/);
});

test("renderStatusSnapshot marks check scope UNKNOWN when protection is unavailable", () => {
  const base = baseSnapshot();
  const snapshot = baseSnapshot({
    github: {
      ...base.github,
      checkRuns: [
        { name: "Windows check", status: "completed", conclusion: "success" },
      ],
      branchProtection: { available: false },
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /\| Windows check \| UNKNOWN \| completed \| success \|/);
});

test("renderStatusSnapshot marks issue-derived state UNKNOWN when issue data is unavailable", () => {
  const snapshot = baseSnapshot({
    github: {
      ...baseSnapshot().github,
      issuesAvailable: false,
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /## 4\. 活跃 Issue\n\nUNKNOWN/);
  assert.match(markdown, /### 阻塞项\n\nUNKNOWN/);
  assert.match(markdown, /### 下一步任务\n\nUNKNOWN/);
});

test("renderStatusSnapshot surfaces partial GitHub errors without hiding available data", () => {
  const snapshot = baseSnapshot({
    github: {
      ...baseSnapshot().github,
      error: "releases API partial failure",
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(markdown, /GitHub 警告：releases API partial failure/);
  assert.match(markdown, /## 4\. 活跃 Issue\n\n无开放 Issue/);
});

test("parseRepoFromRemote supports HTTPS and SSH GitHub remotes", () => {
  assert.deepEqual(parseRepoFromRemote("https://github.com/D-OneXXX/MR.git"), {
    owner: "D-OneXXX",
    name: "MR",
  });
  assert.deepEqual(parseRepoFromRemote("git@github.com:D-OneXXX/MR.git"), {
    owner: "D-OneXXX",
    name: "MR",
  });
  assert.equal(parseRepoFromRemote("https://example.com/not-github.git"), null);
});

test("summarizeWorkingTree counts staged, modified and untracked files without double counting", () => {
  assert.deepEqual(
    summarizeWorkingTree({
      stagedFiles: ["a.ts"],
      modifiedFiles: ["b.ts", "c.ts"],
      untrackedFiles: ["d.ts"],
    }),
    { dirty: true, staged: 1, modified: 2, untracked: 1 },
  );
  assert.deepEqual(summarizeWorkingTree({}), {
    dirty: false,
    staged: 0,
    modified: 0,
    untracked: 0,
  });
});

test("renderStatusSnapshot shows Windows and Linux channel baselines independently", () => {
  const snapshot = baseSnapshot({
    version: {
      ...baseSnapshot().version,
      windowsReleaseTag: "v0.17.1",
      windowsReleaseVersion: "0.17.1",
      windowsHeadAhead: 6,
      linuxReleaseTag: "v0.17.1-linux-sec1",
      linuxReleaseVersion: "0.17.1",
      linuxHeadAhead: 3,
    },
  });
  const markdown = renderStatusSnapshot(snapshot);
  assert.match(
    markdown,
    /最新 Windows Release \| `v0\.17\.1`（0\.17\.1）；HEAD 领先 6 个提交/,
  );
  assert.match(
    markdown,
    /最新 Linux critical Release \| `v0\.17\.1-linux-sec1`（0\.17\.1）；HEAD 领先 3 个提交/,
  );
});

test("protectionBranchName checks the default branch instead of a feature branch", () => {
  assert.equal(
    protectionBranchName({ defaultBranch: "main", currentBranch: "chore/13-phase-1-governance" }),
    "main",
  );
  assert.equal(protectionBranchName({ currentBranch: "main" }), "main");
  assert.equal(protectionBranchName({}), "main");
});

test("renderStatusSnapshot surfaces governance warnings instead of implying all clear", () => {
  const markdown = renderStatusSnapshot(baseSnapshot());
  assert.match(markdown, /### 治理告警/);
  assert.match(markdown, /管理员可绕过分支保护/);
  assert.match(markdown, /未配置发布审批环境/);
  assert.match(markdown, /下一次发布前必须 bump/);
});
