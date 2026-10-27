import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  sha256File,
  validateLinuxCandidateInput,
} from "./prepare-candidate-linux.mjs";

const COMMIT = "a".repeat(40);
const VERSION = "0.18.0";
const TAG = "v0.18.0-linux-sec1";
const FILES = {
  "MangaReader_0.18.0_amd64.deb": Buffer.from("deb-bytes"),
  "MangaReader-0.18.0-1.x86_64.rpm": Buffer.from("rpm-bytes"),
  "MangaReader_0.18.0_amd64.AppImage": Buffer.from("appimage-bytes"),
  "MangaReader_0.18.0_amd64.AppImage.sig": Buffer.from("signature-bytes"),
  "latest-linux-critical.json": Buffer.from('{"version":"0.18.0"}'),
};

function makeAssetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-prepare-linux-"));
  for (const [name, bytes] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

function makeRecord(dir, overrides = {}) {
  const record = {
    kind: "manga-reader.release-candidate",
    rehearsal: false,
    rcId: `rc-${TAG}-${COMMIT.slice(0, 12)}`,
    version: VERSION,
    tag: TAG,
    commit: COMMIT,
    channel: "linux-critical",
    platform: "linux-x86_64",
    qa: { workflow: "qa-full", runId: "1", buildCommit: COMMIT },
    artifacts: Object.keys(FILES)
      .sort()
      .map((name) => ({
        name,
        sha256: sha256File(path.join(dir, name)),
        size: FILES[name].length,
      })),
    createdAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
  const recordPath = path.join(dir, "rc-record.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, recordPath };
}

function validate(dir, record, recordPath, overrides = {}) {
  return validateLinuxCandidateInput({
    record,
    recordPath,
    assetsDir: dir,
    tag: TAG,
    expectedCommit: COMMIT,
    ...overrides,
  });
}

test("prepare-candidate-linux：合法 RC + 五种制品 → 绑定成功且主制品为 deb", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, true, result.problems.join(" | "));
  assert.equal(result.candidate.version, VERSION);
  assert.equal(result.candidate.commit, COMMIT);
  assert.equal(result.candidate.artifactName, "MangaReader_0.18.0_amd64.deb");
  assert.equal(result.candidate.signatureName, "MangaReader_0.18.0_amd64.AppImage.sig");
  assert.equal(result.candidate.appImageName, "MangaReader_0.18.0_amd64.AppImage");
  assert.equal(result.candidate.rpmName, "MangaReader-0.18.0-1.x86_64.rpm");
  assert.equal(result.candidate.manifestName, "latest-linux-critical.json");
  assert.equal(result.candidate.recordSha256, sha256File(recordPath));
});

test("prepare-candidate-linux：Windows 记录 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir, {
    channel: "windows",
    platform: "windows-x86_64",
    tag: "v0.18.0",
  });
  const result = validate(dir, record, recordPath, { tag: "v0.18.0" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("通道必须是")));
});

test("prepare-candidate-linux：标签缺少 -linux-secN → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir, { tag: "v0.18.0" });
  const result = validate(dir, record, recordPath, { tag: "v0.18.0" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("标签")));
});

test("prepare-candidate-linux：缺 deb → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  fs.unlinkSync(path.join(dir, "MangaReader_0.18.0_amd64.deb"));
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(".deb")));
});

test("prepare-candidate-linux：缺 AppImage 签名 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts = record.artifacts.filter((item) => !item.name.endsWith(".sig"));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(".sig")));
});

test("prepare-candidate-linux：缺 latest-linux-critical.json → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts = record.artifacts.filter(
    (item) => item.name !== "latest-linux-critical.json",
  );
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("latest-linux-critical")));
});

test("prepare-candidate-linux：制品摘要被篡改 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  record.artifacts.find((item) => item.name.endsWith(".deb")).sha256 = "f".repeat(64);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("SHA-256 与 RC 记录不一致")));
});

test("prepare-candidate-linux：Commit 与标签不一致 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  const result = validate(dir, record, recordPath, { expectedCommit: "b".repeat(40) });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("Commit 与标签")));
});

test("prepare-candidate-linux：演练候选 → 拒绝", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir, { rehearsal: true });
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("演练")));
});

test("prepare-candidate-linux：治理文件不参与候选绑定", () => {
  const dir = makeAssetDir();
  const { record, recordPath } = makeRecord(dir);
  for (const name of ["rc-summary.md", "signature-verification.json", "install-verification.json"]) {
    fs.writeFileSync(path.join(dir, name), `${name}-bytes`);
  }
  const result = validate(dir, record, recordPath);
  assert.equal(result.ok, true, result.problems.join(" | "));
  assert.equal(result.candidate.artifactName, "MangaReader_0.18.0_amd64.deb");
});
