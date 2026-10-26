import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyProvenance } from "./verify-provenance.mjs";

const REPO = "D-OneXXX/MR";
const RUN_ID = "1234567890";
const VERIFIED_AT = "2026-10-26T12:40:00.000Z";

function evidence(overrides = {}) {
  return {
    kind: "manga-reader.install-verification",
    verdict: "PASS",
    version: "0.17.2",
    commit: "a".repeat(40),
    platform: "windows-x86_64",
    artifactName: "MangaReader_0.17.2_x64-setup.exe",
    artifactSha256: "b".repeat(64),
    verifiedAt: VERIFIED_AT,
    machine: {
      os: "Windows Server 2022",
      cleanEnvironment: true,
      image: "GitHub Actions windows-2022 20261021.1.0",
      provenance: {
        kind: "github-actions",
        repository: REPO,
        runId: RUN_ID,
        runUrl: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
        runnerName: "GitHub Actions 2",
        imageOs: "win22",
        imageVersion: "20261021.1.0",
        workflow: `${REPO}/.github/workflows/release-install-verify.yml@refs/heads/main`,
        actor: "D-OneXXX",
        runAttempt: "1",
        startedAt: "2026-10-26T12:35:00.000Z",
      },
    },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: Number(RUN_ID),
    repository: { full_name: REPO },
    path: ".github/workflows/release-install-verify.yml",
    html_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_branch: "main",
    actor: { login: "D-OneXXX" },
    run_started_at: "2026-10-26T12:35:00.000Z",
    updated_at: "2026-10-26T12:50:00.000Z",
    ...overrides,
  };
}

const options = { repository: REPO };

test("verifyProvenance：真实成功 run + 时间窗口内 → 通过", () => {
  const verdict = verifyProvenance(evidence(), run(), options);
  assert.equal(verdict.ok, true, verdict.problems.join(" | "));
  assert.equal(verdict.kind, "github-actions");
  assert.equal(verdict.manual, false);
});

test("verifyProvenance：runId 不一致 → 拒绝", () => {
  const verdict = verifyProvenance(evidence(), run({ id: 999 }), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("run id")));
});

test("verifyProvenance：run 失败 → 拒绝", () => {
  const verdict = verifyProvenance(evidence(), run({ conclusion: "failure" }), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("未成功")));
});

test("verifyProvenance：workflow 文件不符 → 拒绝", () => {
  const verdict = verifyProvenance(evidence(), run({ path: ".github/workflows/qa-full.yml" }), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("workflow")));
});

test("verifyProvenance：非 workflow_dispatch / 非 main → 拒绝", () => {
  const verdict = verifyProvenance(evidence(), run({ event: "push", head_branch: "feature" }), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("workflow_dispatch")));
  assert.ok(verdict.problems.some((problem) => problem.includes("main")));
});

test("verifyProvenance：证据时间不在 run 窗口 → 拒绝", () => {
  const verdict = verifyProvenance(
    evidence({ verifiedAt: "2026-10-26T13:30:00.000Z" }),
    run(),
    options,
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("执行窗口")));
});

test("verifyProvenance：runUrl 与 repository/runId 不一致 → 拒绝", () => {
  const bad = evidence();
  bad.machine.provenance.runUrl = "https://github.com/D-OneXXX/MR/actions/runs/999";
  const verdict = verifyProvenance(bad, run(), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("runUrl")));
});

test("verifyProvenance：actor / attempt 不一致 → 拒绝", () => {
  const bad = evidence();
  bad.machine.provenance.actor = "someone-else";
  bad.machine.provenance.runAttempt = "2";
  const verdict = verifyProvenance(bad, run(), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("actor")));
  assert.ok(verdict.problems.some((problem) => problem.includes("attempt")));
});

test("verifyProvenance：本地 VM 默认只要求人工核验", () => {
  const local = evidence();
  local.machine.provenance = {
    kind: "local-vm",
    hypervisor: "hyperv",
    vmId: "MR-RC-0172",
    imageSha256: "c".repeat(64),
    startedAt: "2026-10-26T12:00:00.000Z",
  };
  const verdict = verifyProvenance(local, null, options);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.manual, true);
});

test("verifyProvenance：正式发布要求 hosted 干净 VM → 本地 VM 被拒绝", () => {
  const local = evidence();
  local.machine.provenance = {
    kind: "local-vm",
    hypervisor: "hyperv",
    vmId: "MR-RC-0172",
    imageSha256: "c".repeat(64),
    startedAt: "2026-10-26T12:00:00.000Z",
  };
  const verdict = verifyProvenance(local, null, {
    ...options,
    requireGithubActions: true,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("GitHub-hosted")));
});

test("verifyProvenance：缺 provenance → 拒绝", () => {
  const bad = evidence();
  delete bad.machine.provenance;
  const verdict = verifyProvenance(bad, run(), options);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.includes("provenance")));
});
