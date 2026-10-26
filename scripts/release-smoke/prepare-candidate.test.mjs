import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sha256File, validateCandidateInput } from "./prepare-candidate.mjs";

const COMMIT = "a".repeat(40);
const VERSION = "0.17.2";
const TAG = "v0.17.2";
const INSTALLER = Buffer.from("candidate-installer-bytes");
const SIGNATURE = Buffer.from("candidate-signature-bytes");
const MANIFEST = Buffer.from('{"version":"0.17.2"}');

function makeAssetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-prepare-candidate-"));
  const files = {
    "MangaReader_0.17.2_x64-setup.exe": INSTALLER,
    "MangaReader_0.17.2_x64-setup.exe.sig": SIGNATURE,
    "latest.json": MANIFEST,
  };
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

function makeRecord(dir, overrides = {}) {
  const record = {
    kind: "manga-reader.release-candidate",
    rehearsal: false,
    rcId: "rc-v0.17.2-test",
    version: VERSION,
    tag: TAG,
    commit: COMMIT,
    channel: "windows",
    platform: "windows-x86_64",
    qa: { workflow: "qa-full", runId: "1", buildCommit: COMMIT },
    artifacts: [
      {
        name: "MangaReader_0.17.2_x64-setup.exe",
        sha256: sha256File(path.join(dir, "MangaReader_0.17.2_x64-setup.exe")),
        size: INSTALLER.length,
      },
      {
        name: "MangaReader_0.17.2_x64-setup.exe.sig",
        sha256: sha256File(path.join(dir, "MangaReader_0.17.2_x64-setup.exe.sig")),
        size: SIGNATURE.length,
      },
      {
        name: "latest.json",
        sha256: sha256File(path.join(dir, "latest.json")),
        size: MANIFEST.length,
      },
    ],
    createdAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
  const recordPath = path.join(dir, "rc-record.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, recordPath };
}

function validate(dir, record, recordPath, overrides = {}) {
  return validateCandidateInput({
    record,
    recordPath,
    assetsDir: dir,
    tag: TAG,
    expectedCommit: COMMIT,
    ...overrides,
  });
}

test("prepare-candidate：合法 RC 记录 + 三个制品 → 绑定成功", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, true, result.problems.join(" | "));
  assert.equal(result.candidate.version, VERSION);
  assert.equal(result.candidate.commit, COMMIT);
  assert.equal(result.candidate.artifactName, "MangaReader_0.17.2_x64-setup.exe");
  assert.equal(result.candidate.signatureName, "MangaReader_0.17.2_x64-setup.exe.sig");
  assert.equal(result.candidate.recordSha256, sha256File(recordPath));
});

test("prepare-candidate：Commit 与标签不一致 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  const result = validate(dir, record, recordPath, { expectedCommit: "b".repeat(40) });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("Commit 与标签")));
});

test("prepare-candidate：安装包摘要与记录不一致 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts[0].sha256 = "f".repeat(64);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("SHA-256 与 RC 记录不一致")));
});

test("prepare-candidate：演练候选 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir, { rehearsal: true });
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("演练")));
});

test("prepare-candidate：缺少签名制品 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts = record.artifacts.filter((artifact) => !artifact.name.endsWith(".sig"));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(".sig")));
});

test("prepare-candidate：缺少 latest.json → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts = record.artifacts.filter((artifact) => artifact.name !== "latest.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("latest.json")));
});

test("prepare-candidate：资产目录缺文件 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  fs.unlinkSync(path.join(dir, "MangaReader_0.17.2_x64-setup.exe"));
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("缺少制品文件")));
});

test("prepare-candidate：标签与版本不一致 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir, { tag: "v0.17.3" });
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("tag 与请求不一致")));
});
