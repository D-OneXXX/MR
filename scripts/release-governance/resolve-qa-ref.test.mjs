import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolve-qa-ref.mjs",
);

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "qa",
      GIT_AUTHOR_EMAIL: "qa@example.invalid",
      GIT_COMMITTER_NAME: "qa",
      GIT_COMMITTER_EMAIL: "qa@example.invalid",
    },
  });

/** 造一个带分支、标签与多个提交的临时远端仓库。 */
function makeRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-qa-ref-"));
  const repo = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  git(dir, "init", "--bare", "-b", "main", repo);
  git(work, "init", "-b", "main", work);
  git(work, "remote", "add", "origin", repo);
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "first");
  const mainSha = git(work, "rev-parse", "HEAD").trim();
  git(work, "tag", "v1.2.3");

  git(work, "checkout", "-b", "feature/x");
  fs.writeFileSync(path.join(work, "b.txt"), "b\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "feature");
  const featureSha = git(work, "rev-parse", "HEAD").trim();
  git(work, "push", "origin", "feature/x", "v1.2.3");

  git(work, "checkout", "main");
  fs.writeFileSync(path.join(work, "c.txt"), "c\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "second");
  const mainTip = git(work, "rev-parse", "HEAD").trim();
  git(work, "push", "origin", "main");

  // 一个**未推送**的提交：它不是任何分支/标签的端点，短 SHA 必须无法解析。
  fs.writeFileSync(path.join(work, "d.txt"), "d\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "unpushed");
  const unpushedSha = git(work, "rev-parse", "HEAD").trim();

  return { dir, repo, mainSha, mainTip, featureSha, unpushedSha };
}

function runResolver(remote, requested) {
  const result = spawnSync(
    process.execPath,
    [script, requested, "--remote", remote],
    { encoding: "utf8" },
  );
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const remote = makeRemote();

test("有效分支名：解析为分支，且 sha 是该分支的真实端点", () => {
  const result = runResolver(remote.repo, "main");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.kind, "branch");
  assert.equal(result.json.ref, "refs/heads/main");
  assert.equal(result.json.sha, remote.mainTip);
});

test("有效标签名：解析为标签，且 sha 是该标签的真实提交", () => {
  const result = runResolver(remote.repo, "v1.2.3");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.kind, "tag");
  assert.equal(result.json.ref, "refs/tags/v1.2.3");
  // 标签打在 main 的首个提交上，不是 feature 分支的提交。
  assert.equal(result.json.sha, remote.mainSha);
});

test("完整 Commit SHA：解析为提交，不被当作分支名", () => {
  const result = runResolver(remote.repo, remote.featureSha);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.kind, "commit");
  assert.equal(result.json.ref, remote.featureSha);
  assert.equal(result.json.sha, remote.featureSha);
  assert.notEqual(result.json.sha, remote.mainTip);
});

test("不存在的完整 SHA：明确失败，不回退到默认分支", () => {
  const missing = "0".repeat(39) + "1";
  const result = runResolver(remote.repo, missing);
  assert.equal(result.code, 2, `期望退出码 2，实际 ${result.code}：${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /远端不存在提交/);
  assert.equal(result.json, null);
});

test("无效引用：明确失败，不产出任何 sha", () => {
  const result = runResolver(remote.repo, "no-such-thing");
  assert.equal(result.code, 2, `期望退出码 2，实际 ${result.code}`);
  assert.match(result.stderr, /无法解析引用/);
  assert.equal(result.json, null);
});

test("空引用：明确失败", () => {
  const result = runResolver(remote.repo, "");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /引用为空/);
});

test("短 SHA：唯一匹配时解析为提交；不是端点或过短时明确失败", () => {
  // 唯一匹配某个分支端点 → 解析为提交。
  const unique = runResolver(remote.repo, remote.featureSha.slice(0, 10));
  assert.equal(unique.code, 0, unique.stderr);
  assert.equal(unique.json.kind, "commit");
  assert.equal(unique.json.sha, remote.featureSha);

  // 不是任何端点的短 SHA → 明确失败，并要求给完整 SHA（不得猜）。
  const notTip = runResolver(remote.repo, remote.unpushedSha.slice(0, 10));
  assert.equal(notTip.code, 2, `期望退出码 2，实际 ${notTip.code}`);
  assert.match(notTip.stderr, /短 SHA/);
  assert.equal(notTip.json, null);

  // 少于 7 位的十六进制不是合法短 SHA → 按名称解析并明确失败。
  const tooShort = runResolver(remote.repo, "a8ce");
  assert.equal(tooShort.code, 2);
  assert.match(tooShort.stderr, /无法解析引用/);
  assert.equal(tooShort.json, null);
});

test("任何失败都不得静默回退到默认分支的提交", () => {
  for (const bad of ["no-such-thing", "0".repeat(40), ""]) {
    const result = runResolver(remote.repo, bad);
    assert.notEqual(result.code, 0, `输入 "${bad}" 不应成功`);
    assert.equal(result.json, null, `输入 "${bad}" 不应产出 sha`);
    assert.doesNotMatch(result.stdout, new RegExp(remote.mainTip), "失败时不得输出默认分支的 sha");
  }
});
