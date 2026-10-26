/**
 * 发布治理单元测试：RC 记录、安装验证回执与发布前闸门。
 * 全部离线执行（不联网、不触碰 GitHub、不接触密钥）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildRcRecord,
  CHANNELS,
  parseTag,
  renderRcSummary,
  sha256Bytes,
  validateInstallAttestation,
  validateRcRecord,
  verifyPublishPreconditions,
} from "./rc-record.mjs";
import { runVerification } from "./verify-draft.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const INSTALLER = Buffer.from("installer-bytes");
const INSTALLER_SHA = sha256Bytes(INSTALLER);

function makeRecord(overrides = {}) {
  return buildRcRecord({
    tag: "v0.17.2",
    commit: COMMIT,
    qa: { runId: "42", buildCommit: COMMIT },
    artifacts: [{ name: "app-setup.exe", sha256: INSTALLER_SHA, size: INSTALLER.length }],
    ...overrides,
  });
}

function makeAttestation(overrides = {}) {
  return {
    kind: "manga-reader.install-verification",
    version: "0.17.2",
    commit: COMMIT,
    platform: "windows-x86_64",
    installer: { name: "app-setup.exe", sha256: INSTALLER_SHA },
    verdict: "PASS",
    checks: { install: "pass", upgrade: "pass", rollback: "pass", dataIntegrity: "pass" },
    machine: { os: "Windows Server 2022", cleanEnvironment: true, image: "windows-2022-clean" },
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("parseTag：常规与 Linux 高危通道互不串台", () => {
  assert.equal(parseTag("v0.17.2")?.channel, "windows");
  assert.equal(parseTag("v0.17.2")?.platform, "windows-x86_64");
  assert.equal(parseTag("v0.17.2-linux-sec1")?.channel, "linux-critical");
  assert.equal(parseTag("v0.17.2-linux-sec1")?.platform, "linux-x86_64");
  assert.equal(parseTag("v0.17.2-linux-sec1")?.version, "0.17.2");
  assert.equal(parseTag("v0.17.2-rc1"), null);
  assert.equal(parseTag("0.17.2"), null);
});

test("buildRcRecord：拒绝非法标签 / 非法 Commit / 空制品", () => {
  assert.throws(() => buildRcRecord({ tag: "v0.17.2-rc1", commit: COMMIT, artifacts: [] }), /命名约定/);
  assert.throws(() => buildRcRecord({ tag: "v0.17.2", commit: "short", artifacts: [] }), /commit/);
  assert.throws(() => buildRcRecord({ tag: "v0.17.2", commit: COMMIT, artifacts: [] }), /至少包含一个制品/);
});

test("validateRcRecord：QA 证据 Commit 必须与候选 Commit 一致", () => {
  const record = makeRecord();
  assert.deepEqual(validateRcRecord(record), []);
  const mismatched = makeRecord({
    qa: { runId: "42", buildCommit: "f".repeat(40) },
  });
  assert.ok(
    validateRcRecord(mismatched).some((p) => p.includes("QA 证据 Commit 与候选 Commit 不一致")),
  );
});

test("validateInstallAttestation：必须 PASS 且四项检查齐全", () => {
  assert.deepEqual(validateInstallAttestation(makeAttestation(), null), []);
  const notPass = validateInstallAttestation(makeAttestation({ verdict: "FAIL" }), null);
  assert.ok(notPass.some((p) => p.includes("不是 PASS")));
  const missing = validateInstallAttestation(
    makeAttestation({ checks: { install: "pass" } }),
    null,
  );
  assert.ok(missing.some((p) => p.includes("upgrade")));
});

test("validateInstallAttestation：未声明干净环境 → 拒绝", () => {
  const dirty = validateInstallAttestation(
    makeAttestation({
      machine: { os: "Windows 11", image: "shared-workstation", cleanEnvironment: false },
    }),
    null,
  );
  assert.ok(dirty.some((p) => p.includes("干净环境")));
  const noImage = validateInstallAttestation(
    makeAttestation({
      machine: { os: "Windows Server 2022", cleanEnvironment: true, image: "" },
    }),
    null,
  );
  assert.ok(noImage.some((p) => p.includes("镜像")));
});

test("verifyPublishPreconditions：制品被替换 → 拒绝", () => {
  const record = makeRecord();
  const ok = verifyPublishPreconditions({
    record,
    actualDigests: new Map([["app-setup.exe", INSTALLER_SHA]]),
    attestation: makeAttestation(),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(ok.ok, true, ok.problems.join(" | "));

  const tampered = verifyPublishPreconditions({
    record,
    actualDigests: new Map([["app-setup.exe", sha256Bytes(Buffer.from("other"))]]),
    attestation: makeAttestation(),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some((p) => p.includes("疑似审批后替换")));
});

test("verifyPublishPreconditions：跨通道 / 缺回执 → 拒绝", () => {
  const linuxRecord = buildRcRecord({
    tag: "v0.17.2-linux-sec1",
    commit: COMMIT,
    qa: { runId: "42", buildCommit: COMMIT },
    artifacts: [{ name: "app.AppImage", sha256: INSTALLER_SHA }],
  });
  const cross = verifyPublishPreconditions({
    record: linuxRecord,
    actualDigests: new Map([["app.AppImage", INSTALLER_SHA]]),
    attestation: makeAttestation({ platform: "linux-x86_64" }),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(cross.ok, false);
  assert.ok(cross.problems.some((p) => p.includes("通道不匹配")));

  const missing = verifyPublishPreconditions({
    record: makeRecord(),
    actualDigests: new Map([["app-setup.exe", INSTALLER_SHA]]),
    attestation: null,
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((p) => p.includes("安装验证回执缺失")));
});

test("verifyPublishPreconditions：额外出现记录之外的制品 → 拒绝", () => {
  const verdict = verifyPublishPreconditions({
    record: makeRecord(),
    actualDigests: new Map([
      ["app-setup.exe", INSTALLER_SHA],
      ["surprise.exe", INSTALLER_SHA],
    ]),
    attestation: makeAttestation(),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("记录之外的制品")));
});

test("renderRcSummary：审批依据必须包含版本 / Commit / 摘要", () => {
  const summary = renderRcSummary(makeRecord());
  assert.ok(summary.includes("0.17.2"));
  assert.ok(summary.includes(COMMIT));
  assert.ok(summary.includes(INSTALLER_SHA));
});

test("runVerification：本地目录校验（通过 / 摘要不符）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-verify-"));
  fs.writeFileSync(path.join(dir, "app-setup.exe"), INSTALLER);
  const record = makeRecord();
  const ok = runVerification({
    record,
    assetsDir: dir,
    attestation: makeAttestation(),
    tag: "v0.17.2",
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(ok.ok, true, ok.problems.join(" | "));

  fs.writeFileSync(path.join(dir, "app-setup.exe"), Buffer.from("tampered"));
  const bad = runVerification({
    record,
    assetsDir: dir,
    attestation: makeAttestation(),
    tag: "v0.17.2",
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("疑似审批后替换")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("通道定义互不重叠（平台键各自独立）", () => {
  assert.notEqual(CHANNELS.windows.platform, CHANNELS["linux-critical"].platform);
});

test("parseTag：隔离演练标签被识别为 rehearsal 且不可发布", () => {
  const parsed = parseTag("v0.0.0-rehearsal");
  assert.equal(parsed?.rehearsal, true);
  assert.equal(parsed?.version, "0.0.0");
  assert.equal(parsed?.channel, "windows");

  const record = buildRcRecord({
    tag: "v0.0.0-rehearsal",
    commit: COMMIT,
    qa: { runId: "42", buildCommit: COMMIT },
    artifacts: [{ name: "rehearsal-app-setup.exe", sha256: INSTALLER_SHA }],
  });
  assert.equal(record.rehearsal, true);
  assert.deepEqual(validateRcRecord(record), []);

  const verdict = verifyPublishPreconditions({
    record,
    actualDigests: new Map([["rehearsal-app-setup.exe", INSTALLER_SHA]]),
    attestation: makeAttestation({ version: "0.0.0" }),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("演练候选")));
});

test("治理文件（记录/摘要/安装回执）不参与制品摘要比对", () => {
  const record = makeRecord();
  const verdict = verifyPublishPreconditions({
    record,
    actualDigests: new Map([
      ["app-setup.exe", INSTALLER_SHA],
      ["rc-record.json", "c".repeat(64)],
      ["rc-summary.md", "d".repeat(64)],
      ["install-verification.json", "e".repeat(64)],
    ]),
    attestation: makeAttestation(),
    channel: "windows",
    commit: COMMIT,
  });
  assert.equal(verdict.ok, true, verdict.problems.join(" | "));
});
