/**
 * 发布证据门禁单元测试：缺证据 / 过期 / 版本不一致 / 制品被换 / 公钥不匹配 / 演练候选
 * 都必须**拒绝**发布；齐备且绑定一致才放行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTALL_EVIDENCE_KIND,
  SIGNATURE_EVIDENCE_KIND,
  publicKeyId,
  validateInstallEvidence,
  validateSignatureEvidence,
  verifyReleaseEvidence,
} from "./evidence.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ARTIFACT_SHA = "a".repeat(64);
const KEY_ID = "67CB304460E08E4A";

const record = {
  kind: "manga-reader.release-candidate",
  rehearsal: false,
  version: "0.17.2",
  tag: "v0.17.2",
  commit: COMMIT,
  channel: "windows",
  platform: "windows-x86_64",
  qa: { workflow: "qa-full", runId: "1", buildCommit: COMMIT },
  artifacts: [{ name: "MangaReader_0.17.2_x64-setup.exe", sha256: ARTIFACT_SHA, size: 1 }],
  createdAt: "2026-10-26T00:00:00.000Z",
};

const signatureEvidence = {
  kind: SIGNATURE_EVIDENCE_KIND,
  verdict: "PASS",
  version: "0.17.2",
  commit: COMMIT,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: ARTIFACT_SHA,
  publicKeyId: KEY_ID,
  verifiedBy: "minisign 0.12",
  verifiedAt: "2026-10-26T00:00:00.000Z",
};

const installEvidence = {
  kind: INSTALL_EVIDENCE_KIND,
  verdict: "PASS",
  version: "0.17.2",
  commit: COMMIT,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: ARTIFACT_SHA,
  checks: {
    freshInstall: "pass",
    upgrade: "pass",
    dataIntegrity: "pass",
    recovery: "pass",
  },
  machine: {
    os: "Windows Server 2022",
    // 干净环境声明：共享宿主上的验证不满足发布强制条件。
    cleanEnvironment: true,
    image: "windows-2022-clean",
  },
  verifiedAt: "2026-10-26T00:00:00.000Z",
};

const expected = {
  version: "0.17.2",
  commit: COMMIT,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: ARTIFACT_SHA,
  publicKeyId: KEY_ID,
  channel: "windows",
  now: "2026-10-27T00:00:00.000Z",
};

test("publicKeyId：从 minisign 公钥文本取 key ID", () => {
  const text = "untrusted comment: minisign public key: 67CB304460E08E4A\nRWS...==\n";
  assert.equal(publicKeyId(text), "67CB304460E08E4A");
  assert.equal(publicKeyId("nope"), null);
});

test("签名证据：齐备且绑定一致 → 通过", () => {
  assert.deepEqual(validateSignatureEvidence(signatureEvidence, expected), []);
});

test("签名证据：缺失 / 非 PASS / 公钥不匹配 → 拒绝", () => {
  assert.ok(validateSignatureEvidence(null, expected).length > 0);
  assert.ok(
    validateSignatureEvidence({ ...signatureEvidence, verdict: "FAIL" }, expected).some((p) =>
      p.includes("不是 PASS"),
    ),
  );
  assert.ok(
    validateSignatureEvidence(
      { ...signatureEvidence, publicKeyId: "0000000000000000" },
      expected,
    ).some((p) => p.includes("公钥")),
  );
});

test("安装证据：缺少任一检查项 → 拒绝", () => {
  for (const key of ["freshInstall", "upgrade", "dataIntegrity", "recovery"]) {
    const checks = { ...installEvidence.checks };
    delete checks[key];
    const problems = validateInstallEvidence({ ...installEvidence, checks }, expected);
    assert.ok(
      problems.some((p) => p.includes(key)),
      `${key} 缺失必须被拒绝`,
    );
  }
});

test("安装证据：未声明干净环境 → 拒绝（共享宿主不满足发布强制条件）", () => {
  const withoutFlag = validateInstallEvidence(
    {
      ...installEvidence,
      machine: { os: "Windows Server 2022", image: "windows-2022-clean" },
    },
    expected,
  );
  assert.ok(
    withoutFlag.some((p) => p.includes("干净环境")),
    "缺少 machine.cleanEnvironment 声明必须被拒绝",
  );
  const explicitlyDirty = validateInstallEvidence(
    {
      ...installEvidence,
      machine: { ...installEvidence.machine, cleanEnvironment: false },
    },
    expected,
  );
  assert.ok(explicitlyDirty.some((p) => p.includes("干净环境")));
});

test("安装证据：干净环境必须记录镜像标识", () => {
  const withoutImage = validateInstallEvidence(
    {
      ...installEvidence,
      machine: { ...installEvidence.machine, image: "  " },
    },
    expected,
  );
  assert.ok(
    withoutImage.some((p) => p.includes("镜像")),
    "缺少 machine.image 必须被拒绝",
  );
});

test("总闸：证据齐备且绑定一致 → 放行", () => {
  const verdict = verifyReleaseEvidence({
    record,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    signatureEvidence,
    installEvidence,
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(verdict.ok, true, verdict.problems.join(" | "));
});

test("总闸：安装证据来自共享宿主（未声明干净环境）→ 拒绝", () => {
  const verdict = verifyReleaseEvidence({
    record,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    signatureEvidence,
    installEvidence: {
      ...installEvidence,
      machine: { os: "Windows 11", image: "shared-workstation", cleanEnvironment: false },
    },
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("干净环境")));
});

test("总闸：缺安装证据 / 缺签名证据 → 拒绝", () => {
  const base = {
    record,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: "2026-10-27T00:00:00.000Z",
  };
  const noInstall = verifyReleaseEvidence({ ...base, signatureEvidence, installEvidence: null });
  assert.equal(noInstall.ok, false);
  const noSignature = verifyReleaseEvidence({ ...base, signatureEvidence: null, installEvidence });
  assert.equal(noSignature.ok, false);
});

test("总闸：证据过期 → 拒绝", () => {
  const verdict = verifyReleaseEvidence({
    record,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    signatureEvidence: { ...signatureEvidence, verifiedAt: "2026-01-01T00:00:00.000Z" },
    installEvidence: { ...installEvidence, verifiedAt: "2026-01-01T00:00:00.000Z" },
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("过期")));
});

test("总闸：版本 / Commit / 平台 / 制品摘要不一致 → 拒绝", () => {
  const base = {
    record,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: "2026-10-27T00:00:00.000Z",
  };
  const wrongVersion = verifyReleaseEvidence({
    ...base,
    signatureEvidence: { ...signatureEvidence, version: "0.17.1" },
    installEvidence,
  });
  assert.ok(wrongVersion.problems.some((p) => p.includes("版本")));
  const wrongCommit = verifyReleaseEvidence({
    ...base,
    signatureEvidence: { ...signatureEvidence, commit: "f".repeat(40) },
    installEvidence,
  });
  assert.ok(wrongCommit.problems.some((p) => p.includes("Commit")));
  const wrongPlatform = verifyReleaseEvidence({
    ...base,
    signatureEvidence: { ...signatureEvidence, platform: "linux-x86_64" },
    installEvidence,
  });
  assert.ok(wrongPlatform.problems.some((p) => p.includes("平台")));
  const swapped = verifyReleaseEvidence({
    ...base,
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", "b".repeat(64)]]),
    signatureEvidence,
    installEvidence,
  });
  assert.ok(swapped.problems.some((p) => p.includes("摘要")));
});

test("总闸：演练候选 → 无条件拒绝", () => {
  const verdict = verifyReleaseEvidence({
    record: { ...record, rehearsal: true, tag: "v0.0.0-rehearsal" },
    digests: new Map([["MangaReader_0.17.2_x64-setup.exe", ARTIFACT_SHA]]),
    signatureEvidence,
    installEvidence,
    channel: "windows",
    commit: COMMIT,
    publicKeyId: KEY_ID,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("演练")));
});
