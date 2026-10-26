#!/usr/bin/env node
/**
 * 发布链路**隔离演练**（不联网、不创建任何 GitHub 资源、不接触密钥）。
 *
 * 目的：在没有真实 Environment 审批、没有真实 Draft 的情况下，用进程内的假后端
 * 把 Phase 4 的发布状态机跑通，并断言「不该发生的路径一定不会发生」：
 *
 *  A. RC → Draft：候选只落成 **Draft**，不会直接变公开 Release；
 *  B. 审批绑定：审批令牌绑定「版本 + Commit + 制品 SHA-256 + 平台」，
 *     审批后替换制品 / 换版本 / 换平台 / 缺安装验证回执 → 一律拒绝发布；
 *  C. 失败恢复：发布中途失败时 Draft 保留、可安全重试，不产生重复 Release；
 *  D. 并发控制：同一「通道 + 标签」同时只允许一个发布在途；
 *  E. 更新清单安全：跨通道端点、未签名清单、清单结构非法 → 一律拒绝；
 *  F. 跨通道误发布：用 Windows 发布流程去发 Linux 标签 → 拒绝。
 *
 * 用法：node scripts/release-governance/rehearse.mjs [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHANNELS,
  buildRcRecord,
  parseTag,
  renderRcSummary,
  sha256Bytes,
  validateRcRecord,
  verifyPublishPreconditions,
} from "./rc-record.mjs";
import { verifyUpdaterManifest } from "../verify-updater-manifest.mjs";
import {
  INSTALL_EVIDENCE_KIND,
  SIGNATURE_EVIDENCE_KIND,
  verifyReleaseEvidence,
} from "./evidence.mjs";

const results = [];
let failures = 0;

function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail || "" });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* 假后端：Draft / 发布 / 并发锁                                      */
/* ------------------------------------------------------------------ */

class FakeReleaseStore {
  constructor() {
    this.drafts = new Map();
    this.published = new Map();
    this.locks = new Set();
    this.publishCalls = 0;
  }

  createDraft(record, assets) {
    if (this.drafts.has(record.tag) || this.published.has(record.tag)) {
      throw new Error(`Draft 已存在：${record.tag}`);
    }
    this.drafts.set(record.tag, { record, assets: new Map(assets), body: renderRcSummary(record) });
    return this.drafts.get(record.tag);
  }

  getDraft(tag) {
    return this.drafts.get(tag) || null;
  }

  /** 并发锁：同一 channel+tag 同时只允许一个发布在途。 */
  acquireLock(channel, tag) {
    const key = `${channel}:${tag}`;
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  releaseLock(channel, tag) {
    this.locks.delete(`${channel}:${tag}`);
  }

  publishDraft(tag, approval) {
    this.publishCalls += 1;
    const draft = this.drafts.get(tag);
    if (!draft) throw new Error(`没有可发布的 Draft：${tag}`);
    const digests = new Map();
    for (const [name, bytes] of draft.assets) digests.set(name, sha256Bytes(bytes));
    const verdict = verifyPublishPreconditions({
      record: draft.record,
      actualDigests: digests,
      attestation: approval?.attestation ?? null,
      channel: approval?.channel ?? draft.record.channel,
      commit: approval?.commit ?? draft.record.commit,
    });
    if (!verdict.ok) {
      throw new Error(`发布前校验拒绝：${verdict.problems.join(" | ")}`);
    }
    this.published.set(tag, draft);
    this.drafts.delete(tag);
    return draft;
  }
}

function makeAttestation(record, installerSha256, overrides = {}) {
  return {
    kind: "manga-reader.install-verification",
    version: record.version,
    commit: record.commit,
    platform: record.platform,
    installer: { name: "setup.exe", sha256: installerSha256 },
    verdict: "PASS",
    checks: { install: "pass", upgrade: "pass", rollback: "pass", dataIntegrity: "pass" },
    machine: { os: "Windows Server 2022", cleanEnvironment: true, image: "rehearsal-vm" },
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeArtifacts() {
  const installer = Buffer.from("fake-nsis-installer-binary");
  const manifest = Buffer.from(
    JSON.stringify({
      version: "0.17.2",
      pub_date: new Date().toISOString(),
      platforms: { "windows-x86_64": { signature: "sig", url: "https://example.invalid/a.exe" } },
    }),
  );
  return [
    { name: "MangaReader_0.17.2_x64-setup.exe", bytes: installer },
    { name: "latest.json", bytes: manifest },
  ];
}

function expectThrow(id, fn, expectText) {
  let text = "";
  try {
    const verdict = fn();
    // 校验函数返回 {ok:false, problems}；抛异常的路径（如发布动作）也算拒绝。
    if (verdict && typeof verdict === "object" && verdict.ok === false) {
      text = (verdict.problems || []).join(" | ");
    } else {
      check(id, false, "本应被拒绝，却成功了");
      return;
    }
  } catch (error) {
    text = String(error.message || error);
  }
  check(id, text.includes(expectText), text.slice(0, 160));
}

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

const store = new FakeReleaseStore();
const tag = "v0.17.2";
const parsed = parseTag(tag);
const commit = "a".repeat(40);
const artifacts = makeArtifacts();
const record = buildRcRecord({
  tag,
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: artifacts.map((item) => ({
    name: item.name,
    sha256: sha256Bytes(item.bytes),
    size: item.bytes.length,
  })),
});

// A. RC → Draft
check("A1 RC 记录结构合法", validateRcRecord(record).length === 0, validateRcRecord(record).join(" | "));
const draft = store.createDraft(
  record,
  artifacts.map((item) => [item.name, item.bytes]),
);
check("A2 候选只落成 Draft，未公开", store.drafts.has(tag) && !store.published.has(tag));
check("A3 Draft 正文包含审批依据（版本/Commit/摘要）", draft.body.includes(record.commit) && draft.body.includes(record.artifacts[0].sha256));

// B. 审批绑定
const installerSha = sha256Bytes(artifacts[0].bytes);
const goodApproval = {
  channel: "windows",
  commit,
  attestation: makeAttestation(record, installerSha),
};
expectThrow("B1 缺安装验证回执 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: null }), "安装验证回执缺失");
expectThrow("B2 安装回执指向不同安装包 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, "b".repeat(64)) }), "摘要与候选制品不一致");
expectThrow("B3 版本不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, installerSha, { version: "0.17.1" }) }), "回执版本与候选不一致");
expectThrow("B4 Commit 不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, commit: "b".repeat(40) }), "Commit 不匹配");
expectThrow("B5 平台不一致 → 拒绝发布", () => store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, installerSha, { platform: "linux-x86_64" }) }), "回执平台与候选不一致");
expectThrow("B6 审批后替换制品 → 拒绝发布", () => {
  const draft2 = store.getDraft(tag);
  draft2.assets.set(artifacts[0].name, Buffer.from("tampered-binary"));
  store.publishDraft(tag, goodApproval);
}, "摘要不一致");
check("B7 篡改后仍无公开 Release", !store.published.has(tag));

// C. 失败恢复：模拟传输失败后重试
const draft3 = store.getDraft(tag);
draft3.assets.set(artifacts[0].name, artifacts[0].bytes);
let failedOnce = false;
try {
  store.publishDraft(tag, { ...goodApproval, attestation: makeAttestation(record, "c".repeat(64)) });
} catch {
  failedOnce = true;
}
check("C1 失败后 Draft 仍保留（可重试）", failedOnce && store.drafts.has(tag) && !store.published.has(tag));
const published = store.publishDraft(tag, goodApproval);
check("C2 重试成功且只产生一个 Release", store.published.size === 1 && published.record.rcId === record.rcId);

// D. 并发控制
const lockA = store.acquireLock("windows", tag);
const lockB = store.acquireLock("windows", tag);
check("D1 同一通道+标签的第二个发布被拒", lockA && !lockB);
store.releaseLock("windows", tag);
check("D2 释放后可再次获取锁", store.acquireLock("windows", tag));
store.releaseLock("windows", tag);

// E. 更新清单安全
const manifestProblems = verifyUpdaterManifest(
  {
    version: "0.17.2",
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature: "", url: "http://example.invalid/a.exe" } },
  },
  { expectVersion: "0.17.2", requirePlatform: "windows-x86_64" },
);
check("E1 未签名/非 https 清单被拒", manifestProblems.length >= 2, manifestProblems.join(" | "));
const wrongChannel = verifyUpdaterManifest(
  {
    version: "0.17.2",
    pub_date: new Date().toISOString(),
    platforms: { "linux-x86_64": { signature: "sig", url: "https://example.invalid/a" } },
  },
  { requirePlatform: "windows-x86_64" },
);
check("E2 清单缺少本通道平台项被拒", wrongChannel.some((p) => p.includes("windows-x86_64")));
check(
  "E3 通道端点互相独立",
  CHANNELS.windows.platform !== CHANNELS["linux-critical"].platform,
  `${CHANNELS.windows.platform} vs ${CHANNELS["linux-critical"].platform}`,
);

// F. 跨通道误发布
const linuxRecord = buildRcRecord({
  tag: "v0.17.2-linux-sec1",
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [{ name: "app.AppImage", sha256: sha256Bytes(Buffer.from("appimage")) }],
});
expectThrow(
  "F1 用 Windows 流程发 Linux 标签 → 拒绝",
  () =>
    verifyPublishPreconditions({
      record: linuxRecord,
      actualDigests: new Map([["app.AppImage", sha256Bytes(Buffer.from("appimage"))]]),
      attestation: makeAttestation(linuxRecord, sha256Bytes(Buffer.from("appimage")), { platform: "linux-x86_64" }),
      channel: "windows",
      commit,
    }),
  "通道不匹配",
);
expectThrow(
  "F2 Linux 流程缺少对应平台回执 → 拒绝",
  () =>
    verifyPublishPreconditions({
      record: linuxRecord,
      actualDigests: new Map([["app.AppImage", sha256Bytes(Buffer.from("appimage"))]]),
      attestation: makeAttestation(linuxRecord, sha256Bytes(Buffer.from("appimage")), { platform: "windows-x86_64" }),
      channel: "linux-critical",
      commit,
    }),
  "回执平台与候选不一致",
);

// H. 演练候选不得发布
const rehearsalRecord = buildRcRecord({
  tag: "v0.0.0-rehearsal",
  commit,
  qa: { runId: "42", buildCommit: commit },
  artifacts: [{ name: "rehearsal-app-setup.exe", sha256: sha256Bytes(Buffer.from("rehearsal")) }],
});
expectThrow(
  "H1 演练候选（v0.0.0-rehearsal）→ 无条件拒绝发布",
  () =>
    verifyPublishPreconditions({
      record: rehearsalRecord,
      actualDigests: new Map([["rehearsal-app-setup.exe", sha256Bytes(Buffer.from("rehearsal"))]]),
      attestation: makeAttestation(rehearsalRecord, sha256Bytes(Buffer.from("rehearsal")), {
        version: "0.0.0",
      }),
      channel: "windows",
      commit,
    }),
  "演练候选",
);

// I. 发布证据门禁（签名验证 + 真实安装/升级验证）
const gateRecord = buildRcRecord({
  tag: "v0.17.2",
  commit,
  qa: { runId: "1234567890", buildCommit: commit },
  artifacts: [
    { name: "MangaReader_0.17.2_x64-setup.exe", sha256: sha256Bytes(Buffer.from("installer")), size: 9 },
  ],
});
const gateDigest = sha256Bytes(Buffer.from("installer"));
const gateDigests = new Map([["MangaReader_0.17.2_x64-setup.exe", gateDigest]]);
const gateExpected = {
  version: "0.17.2",
  commit,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: gateDigest,
  publicKeyId: "67CB304460E08E4A",
  now: new Date().toISOString(),
};
const gateSignature = {
  kind: SIGNATURE_EVIDENCE_KIND,
  verdict: "PASS",
  version: gateExpected.version,
  commit,
  platform: gateExpected.platform,
  artifactName: gateExpected.artifactName,
  artifactSha256: gateDigest,
  publicKeyId: gateExpected.publicKeyId,
  verifiedBy: "minisign 0.12",
  verifiedAt: new Date().toISOString(),
};
const gateInstall = {
  kind: INSTALL_EVIDENCE_KIND,
  verdict: "PASS",
  version: gateExpected.version,
  commit,
  platform: gateExpected.platform,
  artifactName: gateExpected.artifactName,
  artifactSha256: gateDigest,
  checks: { freshInstall: "pass", upgrade: "pass", dataIntegrity: "pass", recovery: "pass" },
  machine: { os: "Windows Server 2022", cleanEnvironment: true, image: "rehearsal-clean-vm" },
  verifiedAt: new Date().toISOString(),
};
const gate = (overrides = {}) =>
  verifyReleaseEvidence({
    record: gateRecord,
    digests: gateDigests,
    signatureEvidence: gateSignature,
    installEvidence: gateInstall,
    channel: "windows",
    commit,
    publicKeyId: gateExpected.publicKeyId,
    now: gateExpected.now,
    ...overrides,
  });
check("I1 证据齐备且绑定一致 → 放行", gate().ok, gate().problems.join(" | "));
check("I2 缺安装/升级验证证据 → 拒绝", !gate({ installEvidence: null }).ok);
check("I3 缺签名验证证据 → 拒绝", !gate({ signatureEvidence: null }).ok);
check(
  "I4 证据过期 → 拒绝",
  !gate({
    signatureEvidence: { ...gateSignature, verifiedAt: "2020-01-01T00:00:00.000Z" },
    installEvidence: { ...gateInstall, verifiedAt: "2020-01-01T00:00:00.000Z" },
  }).ok,
);
check(
  "I5 证据 Commit 与候选不一致 → 拒绝",
  !gate({ signatureEvidence: { ...gateSignature, commit: "f".repeat(40) } }).ok,
);
check(
  "I6 审批后替换制品 → 拒绝",
  !gate({ digests: new Map([["MangaReader_0.17.2_x64-setup.exe", sha256Bytes(Buffer.from("other"))]]) }).ok,
);
check(
  "I7 证据锚定的公钥与配置不一致 → 拒绝",
  !gate({ publicKeyId: "0000000000000000" }).ok,
);
check(
  "I8 安装证据未声明干净环境 → 拒绝",
  !gate({
    installEvidence: {
      ...gateInstall,
      machine: { os: "Windows 11", image: "shared-workstation", cleanEnvironment: false },
    },
  }).ok,
);

// G. 标签命名约束
check("G1 常规通道拒绝 linux 后缀标签", parseTag("v0.17.2-linux-sec1")?.channel === "linux-critical");
check("G2 常规通道标签解析正确", parseTag("v0.17.2")?.channel === "windows");
check("G3 非法标签被拒", parseTag("v0.17.2-rc1") === null);

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

const summary = {
  total: results.length,
  passed: results.length - failures,
  failed: failures,
  scenarios: ["A 候选→Draft", "B 审批绑定", "C 失败恢复", "D 并发控制", "E 清单安全", "F 跨通道", "G 标签约束", "H 演练不可发布", "I 证据门禁"],
};
console.log("");
console.log("=== 发布链路隔离演练 ===");
console.log(`场景：${summary.scenarios.join(" / ")}`);
console.log(`通过：${summary.passed}/${summary.total}；失败：${summary.failed}`);

if (process.argv.includes("--json")) {
  const outDir = process.env.REHEARSAL_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "mr-rehearsal-"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "rehearsal.json"),
    JSON.stringify({ summary, results }, null, 2),
    "utf8",
  );
  console.log(`报告：${path.join(outDir, "rehearsal.json")}`);
}

process.exitCode = failures === 0 ? 0 : 1;
