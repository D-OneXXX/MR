#!/usr/bin/env node
/**
 * 发布证据（evidence）契约：把「签名验证」与「真实安装/升级验证」变成
 * **机器可判定**的发布前置条件。
 *
 * 强制语义（缺一即拒绝发布）：
 * - 证据必须存在，且是本模块认识的 kind；
 * - 证据必须绑定：版本、Commit、目标平台、**被验证制品的 SHA-256**；
 * - 证据的结论必须是 PASS；
 * - 证据不得过期（默认 30 天），也不得来自未来；
 * - 签名证据必须锚定到**仓库当前配置的 updater 公钥**（公钥 ID 一致），
 * 避免「用另一把钥匙签的」证据蒙混过关；
 * - 安装证据必须来自**可核实的干净环境**：`machine.cleanEnvironment === true`、
 *   镜像标识非空，且 `machine.provenance` 指向具体的 GitHub Actions run 或本机 VM
 *   （`cleanEnvironment` 本身只是一句声明，不足以作为发布依据）；
 * - Windows 通道还必须证明安装/升级后用户数据仍在：数据库 `quick_check`、schema 版本、
 *   合成书库与阅读进度，以及经真实 IPC `list_books` 回读的一致性；
 * - 演练候选（rehearsal）永远不可发布。
 *
 * 本模块是纯函数：不联网、不读密钥、不改任何远端状态。
 */
import {
  REHEARSAL_TAG_PATTERN,
  installIntegrityProblems,
  libraryEvidenceProblems,
  machineEvidenceProblems,
} from "./rc-record.mjs";

export const SIGNATURE_EVIDENCE_KIND = "manga-reader.signature-verification";
export const INSTALL_EVIDENCE_KIND = "manga-reader.install-verification";

/** 证据默认有效期（天）。过期即拒绝发布。 */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** 各通道必须完成的安装/升级验证项。 */
export const CHANNEL_REQUIRED_CHECKS = {
  // Windows 通道除安装/升级/数据完整性/回滚外，还必须证明 PDF 阅读、跨重启进度、
  // 备份导出/恢复（含旧版备份迁移）与数据库快照回滚全部通过。
  windows: [
    "freshInstall",
    "upgrade",
    "dataIntegrity",
    "recovery",
    "pdfReading",
    "progressRestart",
    "backupRestore",
    "databaseRollback",
  ],
  "linux-critical": ["freshInstall", "upgrade", "dataIntegrity"],
};

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const KEY_ID = /^[0-9A-F]{16}$/;

/** 从 minisign 公钥文本里取 key ID（公钥是公开信息，允许出现在证据与日志里）。 */
export function publicKeyId(publicKeyText) {
  const match = String(publicKeyText || "").match(
    /minisign public key:\s*([0-9A-Fa-f]{16})/,
  );
  return match ? match[1].toUpperCase() : null;
}

function baseProblems(kind, evidence) {
  if (!evidence || typeof evidence !== "object") {
    return ["证据缺失或不是 JSON 对象"];
  }
  if (evidence.kind !== kind) {
    return [`证据 kind 非法：期望 ${kind}，实际 ${String(evidence.kind)}`];
  }
  if (evidence.verdict !== "PASS") {
    return [`证据结论不是 PASS：${String(evidence.verdict)}`];
  }
  return [];
}

/**
 * 校验签名验证证据。
 * @param {object} evidence
 * @param {object} expected { version, commit, platform, artifactName, artifactSha256, publicKeyId, maxAgeDays, now }
 */
export function validateSignatureEvidence(evidence, expected = {}) {
  const problems = baseProblems(SIGNATURE_EVIDENCE_KIND, evidence);
  if (problems.length) return problems;

  if (!SEMVER.test(String(evidence.version || ""))) problems.push("证据版本非法");
  if (!HEX40.test(String(evidence.commit || ""))) problems.push("证据 Commit 非法");
  if (!HEX64.test(String(evidence.artifactSha256 || ""))) {
    problems.push("证据未记录被验证制品的 SHA-256");
  }
  if (!evidence.artifactName) problems.push("证据未记录被验证制品名");
  if (!evidence.verifiedBy) problems.push("证据未记录验证工具（verifiedBy）");
  if (!KEY_ID.test(String(evidence.publicKeyId || ""))) {
    problems.push("证据未锚定 updater 公钥 ID");
  }
  if (Number.isNaN(Date.parse(evidence.verifiedAt || ""))) {
    problems.push("证据缺少合法时间");
  }

  if (expected.version && evidence.version !== expected.version) {
    problems.push(`证据版本与候选不一致：证据=${evidence.version} 候选=${expected.version}`);
  }
  if (expected.commit && evidence.commit !== expected.commit) {
    problems.push(`证据 Commit 与候选不一致：证据=${evidence.commit} 候选=${expected.commit}`);
  }
  if (expected.platform && evidence.platform !== expected.platform) {
    problems.push(`证据平台与候选不一致：证据=${evidence.platform} 候选=${expected.platform}`);
  }
  if (expected.artifactName && evidence.artifactName !== expected.artifactName) {
    problems.push(`证据制品名与候选不一致：证据=${evidence.artifactName} 候选=${expected.artifactName}`);
  }
  if (
    expected.artifactSha256 &&
    evidence.artifactSha256 !== expected.artifactSha256
  ) {
    problems.push("证据指向的制品摘要与候选制品不一致（疑似审批后替换制品）");
  }
  if (
    expected.publicKeyId &&
    String(evidence.publicKeyId).toUpperCase() !== String(expected.publicKeyId).toUpperCase()
  ) {
    problems.push(
      `证据锚定的公钥与仓库当前配置的 updater 公钥不一致：证据=${evidence.publicKeyId} 配置=${expected.publicKeyId}`,
    );
  }
  problems.push(...freshnessProblems(evidence, expected));
  return problems;
}

/**
 * 校验安装/升级验证证据（干净环境里的真实安装、覆盖升级、数据完整性）。
 * @param {object} evidence
 * @param {object} expected { version, commit, platform, artifactName, artifactSha256, maxAgeDays, now, requiredChecks }
 */
export function validateInstallEvidence(evidence, expected = {}) {
  const problems = baseProblems(INSTALL_EVIDENCE_KIND, evidence);
  if (problems.length) return problems;

  if (!SEMVER.test(String(evidence.version || ""))) problems.push("证据版本非法");
  if (!HEX40.test(String(evidence.commit || ""))) problems.push("证据 Commit 非法");
  if (!HEX64.test(String(evidence.artifactSha256 || ""))) {
    problems.push("证据未记录被安装制品的 SHA-256");
  }
  if (!evidence.artifactName) problems.push("证据未记录被安装制品名");

  // 干净环境不再是「一句声明」：必须能核实到具体镜像与运行来源（provenance）。
  problems.push(...machineEvidenceProblems(evidence.machine, "安装证据"));
  // expectedArtifactSha256 必须与真实安装包摘要一致；覆盖升级必须记录升级前身份。
  problems.push(...installIntegrityProblems(evidence, "安装证据"));
  // Windows 通道必须证明安装/升级后用户数据仍在（数据库自检 + 进度 + 真实 IPC 回读）。
  if ((expected.channel || "windows") === "windows") {
    problems.push(...libraryEvidenceProblems(evidence.library, "安装证据"));
  }

  const required =
    expected.requiredChecks ||
    CHANNEL_REQUIRED_CHECKS[expected.channel] ||
    CHANNEL_REQUIRED_CHECKS.windows;
  const checks = evidence.checks || {};
  for (const key of required) {
    if (checks[key] !== "pass") {
      problems.push(`安装验证缺少通过项：${key}`);
    }
  }

  if (expected.version && evidence.version !== expected.version) {
    problems.push(`证据版本与候选不一致：证据=${evidence.version} 候选=${expected.version}`);
  }
  if (expected.commit && evidence.commit !== expected.commit) {
    problems.push(`证据 Commit 与候选不一致：证据=${evidence.commit} 候选=${expected.commit}`);
  }
  if (expected.platform && evidence.platform !== expected.platform) {
    problems.push(`证据平台与候选不一致：证据=${evidence.platform} 候选=${expected.platform}`);
  }
  if (
    expected.artifactName &&
    evidence.artifactName !== expected.artifactName
  ) {
    problems.push(`证据制品名与候选不一致：证据=${evidence.artifactName} 候选=${expected.artifactName}`);
  }
  if (
    expected.artifactSha256 &&
    evidence.artifactSha256 !== expected.artifactSha256
  ) {
    problems.push("证据指向的安装包摘要与候选制品不一致（疑似审批后替换制品）");
  }
  problems.push(...freshnessProblems(evidence, expected));
  return problems;
}

/** 证据时效：不得过期、不得来自未来。 */
export function freshnessProblems(evidence, expected = {}) {
  const problems = [];
  const at = Date.parse(evidence.verifiedAt || "");
  if (Number.isNaN(at)) return problems; // 时间问题已在上层报过
  const now = expected.now ? Date.parse(expected.now) : Date.now();
  const maxAgeDays = expected.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (at > now + 60_000) {
    problems.push("证据时间在未来");
    return problems;
  }
  const ageDays = (now - at) / (24 * 60 * 60 * 1000);
  if (ageDays > maxAgeDays) {
    problems.push(
      `证据已过期（${ageDays.toFixed(1)} 天 > ${maxAgeDays} 天）：必须针对本次候选重新验证`,
    );
  }
  return problems;
}

/**
 * 发布前的证据总闸。
 *
 * @param {object} input
 * @param {object} input.record RC 记录
 * @param {Map<string,string>} input.digests 实际制品摘要
 * @param {object} input.signatureEvidence 签名验证证据
 * @param {object} input.installEvidence 安装/升级验证证据
 * @param {string} input.channel 通道
 * @param {string} input.commit 候选 Commit
 * @param {string} input.publicKeyId 仓库当前配置的 updater 公钥 ID
 * @param {string} input.artifactName 被验证/被安装的主制品名
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyReleaseEvidence(input) {
  const problems = [];
  const record = input.record || {};
  if (record.rehearsal === true) {
    return { ok: false, problems: ["演练候选永远不得发布"] };
  }
  if (REHEARSAL_TAG_PATTERN.test(String(record.tag || ""))) {
    return { ok: false, problems: ["演练候选永远不得发布"] };
  }

  const digests = input.digests || new Map();
  const artifactName =
    input.artifactName ||
    (record.artifacts || []).find((item) =>
      /setup\.exe$|\.AppImage$|\.deb$|\.rpm$/.test(item.name),
    )?.name;
  if (!artifactName) {
    return { ok: false, problems: ["候选记录里找不到可验证的主制品"] };
  }
  const artifactSha256 = digests.get(artifactName);
  if (!artifactSha256) {
    return {
      ok: false,
      problems: [`候选制品缺失（无法验签）：${artifactName}`],
    };
  }
  const recordEntry = (record.artifacts || []).find(
    (item) => item.name === artifactName,
  );
  if (recordEntry && recordEntry.sha256 !== artifactSha256) {
    return {
      ok: false,
      problems: [`候选制品摘要不一致（疑似审批后替换）：${artifactName}`],
    };
  }

  const expected = {
    version: record.version,
    commit: input.commit || record.commit,
    platform: record.platform,
    channel: input.channel,
    artifactName,
    artifactSha256,
    maxAgeDays: input.maxAgeDays,
    now: input.now,
  };

  problems.push(
    ...validateSignatureEvidence(input.signatureEvidence, {
      ...expected,
      publicKeyId: input.publicKeyId,
    }),
  );
  problems.push(
    ...validateInstallEvidence(input.installEvidence, {
      ...expected,
      requiredChecks: input.requiredChecks,
    }),
  );
  return { ok: problems.length === 0, problems };
}
