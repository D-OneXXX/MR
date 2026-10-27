#!/usr/bin/env node
/**
 * 发布治理核心：Release Candidate（RC）记录与**审批绑定**校验。
 *
 * 设计目标（Phase 4）：
 * 1. 候选制品与审批必须绑定到「版本 + Commit + 制品 SHA-256 + 目标平台」，
 *    审批后替换制品必须被拒绝；
 * 2. 正式发布前必须有「干净 Windows VM 的真实安装/覆盖升级/数据完整性」回执，
 *    且回执必须指向同一份安装包摘要；
 * 3. Windows 与 Linux 通道互不通用：通道与平台不匹配一律拒绝；
 * 4. 全部校验都是纯函数，可离线执行、可单元测试（不依赖网络）。
 *
 * 本模块**不**创建/修改任何 GitHub 资源，也不读取或输出任何密钥内容。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RC_KIND = "manga-reader.release-candidate";
export const INSTALL_ATTESTATION_KIND = "manga-reader.install-verification";

/** 隔离演练标签：非正式版本号，只允许产出 Draft，绝不允许发布。 */
export const REHEARSAL_TAG_PATTERN = /^v0\.0\.0-rehearsal$/;

export const CHANNELS = {
  windows: {
    id: "windows",
    platform: "windows-x86_64",
    // 常规通道标签不带 Linux 后缀。
    tagPattern: /^v(\d+\.\d+\.\d+)$/,
    // 检查项名称与安装脚本实际产出的证据字段一致（唯一事实源）。
    // 后四项为 PDF 阅读 / 跨重启进度 / 备份恢复 / 数据库回滚，与 evidence.mjs 保持同步。
    requiredChecks: [
      "freshInstall",
      "upgrade",
      "dataIntegrity",
      "recovery",
      "pdfReading",
      "progressRestart",
      "backupRestore",
      "databaseRollback",
    ],
  },
  "linux-critical": {
    id: "linux-critical",
    platform: "linux-x86_64",
    // 高危补丁通道标签必须带 -linux-secN 后缀。
    tagPattern: /^v(\d+\.\d+\.\d+)-linux-sec(\d+)$/,
    requiredChecks: ["freshInstall", "upgrade", "dataIntegrity"],
  },
};

/** 治理文件（记录/摘要/安装验证回执/签名验证证据）：不是构建产物，不参与制品摘要比对。 */
export const GOVERNANCE_FILES = new Set([
  "rc-record.json",
  "rc-summary.md",
  "install-verification.json",
  "signature-verification.json",
]);

/**
 * 目录中参与制品摘要比对的文件名（排除治理文件），按名称排序。
 *
 * 候选工作流会在同一个 Draft 上重跑：治理文件（rc-record / rc-summary /
 * signature-verification / install-verification）可能已经存在，若把它们当成
 * 制品写进 RC 记录，下一次重跑就会因为记录里多出这些文件而失败。
 */
export function listCandidateArtifacts(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => !GOVERNANCE_FILES.has(name))
    .sort();
}

/** 从目录构造 RC 记录的制品清单（治理文件一律排除，重跑候选安全且幂等）。 */
export function collectCandidateArtifacts(dir) {
  return listCandidateArtifacts(dir).map((name) => {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile()) {
      throw new Error(`候选制品必须是普通文件：${name}`);
    }
    return { name, sha256: sha256File(full), size: stat.size };
  });
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const IMAGE_VERSION = /^\d{8}(\.\d+)+$/;
const RUN_ID = /^\d+$/;

/**
 * 干净环境 provenance 契约（与安装脚本 / 证据 schema 共用，唯一事实源）。
 *
 * - `github-actions`：必须能定位到**具体 workflow run**（repository/runId/runUrl 自洽），
 *   否则「干净 VM」只是一句无法核实的声明；
 * - `local-vm`：必须能定位到具体虚拟机镜像（hypervisor/vmId/imageSha256）。
 */
export function provenanceProblems(provenance, subject = "安装证据") {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return [
      `${subject}缺少可核实的运行来源（machine.provenance：github-actions 或 local-vm）`,
    ];
  }
  const problems = [];
  const nonEmpty = (value) => String(value ?? "").trim().length > 0;
  if (provenance.kind === "github-actions") {
    for (const key of [
      "repository",
      "runId",
      "runUrl",
      "runnerName",
      "imageOs",
      "imageVersion",
      "workflow",
      "actor",
    ]) {
      if (!nonEmpty(provenance[key])) {
        problems.push(`${subject}的 github-actions provenance 缺少 ${key}`);
      }
    }
    if (nonEmpty(provenance.runId) && !RUN_ID.test(String(provenance.runId))) {
      problems.push(`${subject}的 github-actions provenance runId 必须为纯数字`);
    }
    if (nonEmpty(provenance.repository) && nonEmpty(provenance.runId)) {
      const expectedUrl = `https://github.com/${provenance.repository}/actions/runs/${provenance.runId}`;
      if (String(provenance.runUrl) !== expectedUrl) {
        problems.push(
          `${subject}的 github-actions provenance runUrl 与 repository/runId 不一致（期望 ${expectedUrl}）`,
        );
      }
    }
    if (
      nonEmpty(provenance.imageVersion) &&
      !IMAGE_VERSION.test(String(provenance.imageVersion))
    ) {
      problems.push(
        `${subject}的 github-actions provenance imageVersion 必须形如 20261021.1.0（实际 ${provenance.imageVersion}）`,
      );
    }
  } else if (provenance.kind === "local-vm") {
    for (const key of ["hypervisor", "vmId"]) {
      if (!nonEmpty(provenance[key])) {
        problems.push(`${subject}的 local-vm provenance 缺少 ${key}`);
      }
    }
    if (!HEX64.test(String(provenance.imageSha256 || ""))) {
      problems.push(`${subject}的 local-vm provenance imageSha256 必须为 64 位十六进制`);
    }
    if (Number.isNaN(Date.parse(provenance.startedAt || ""))) {
      problems.push(`${subject}的 local-vm provenance startedAt 必须是合法时间`);
    }
  } else {
    problems.push(
      `${subject}的 machine.provenance.kind 非法：${String(provenance.kind)}（只接受 github-actions / local-vm）`,
    );
  }
  return problems;
}

/** 运行环境（干净环境声明 + 镜像标识 + provenance）统一校验。 */
export function machineEvidenceProblems(machine, subject = "安装证据") {
  const problems = [];
  if (!machine?.os) problems.push(`${subject}未记录运行环境（machine.os）`);
  // 干净环境是**发布强制条件**：共享宿主上的安装/升级回执不能满足发布门禁。
  if (machine?.cleanEnvironment !== true) {
    problems.push(
      `${subject}未声明干净环境（machine.cleanEnvironment 必须为 true；共享宿主上的验证不满足发布强制条件）`,
    );
  }
  if (!String(machine?.image || "").trim()) {
    problems.push(`${subject}未记录干净环境镜像标识（machine.image）`);
  }
  problems.push(...provenanceProblems(machine?.provenance, subject));
  return problems;
}

/**
 * 用户数据完整性快照（合成书库 + 阅读进度 + 真实 IPC 回读）。
 *
 * 只校验结构与自洽性：`books[0]` 必须被 `list_books` IPC 回读为同一本书、
 * 同一进度。任何一项对不上，说明「安装/升级后数据仍在」只是声明而非事实。
 */
export function libraryEvidenceProblems(library, subject = "安装证据") {
  if (!library || typeof library !== "object" || Array.isArray(library)) {
    return [
      `${subject}缺少用户数据完整性快照（library：quickCheck / schemaVersion / bookCount / readingLog / books / ipc / snapshotSha256）`,
    ];
  }
  const problems = [];
  if (library.quickCheck !== "ok") {
    problems.push(`${subject}的 library.quickCheck 必须为 ok（实际 ${String(library.quickCheck)}）`);
  }
  if (!Number.isInteger(library.schemaVersionBefore) || library.schemaVersionBefore < 1) {
    problems.push(`${subject}的 library.schemaVersionBefore 必须 ≥ 1`);
  }
  if (!Number.isInteger(library.schemaVersionAfter)) {
    problems.push(`${subject}的 library.schemaVersionAfter 缺失或非整数`);
  } else if (
    Number.isInteger(library.schemaVersionBefore) &&
    library.schemaVersionAfter < library.schemaVersionBefore
  ) {
    problems.push(
      `${subject}的 library.schemaVersionAfter（${library.schemaVersionAfter}）小于 schemaVersionBefore（${library.schemaVersionBefore}）`,
    );
  }
  if (!Number.isInteger(library.bookCount) || library.bookCount < 1) {
    problems.push(`${subject}的 library.bookCount 必须 ≥ 1`);
  }
  if (!Number.isInteger(library.readingLogRows) || library.readingLogRows < 1) {
    problems.push(`${subject}的 library.readingLogRows 必须 ≥ 1`);
  }
  if (!Number.isFinite(library.readingLogPages) || library.readingLogPages <= 0) {
    problems.push(`${subject}的 library.readingLogPages 必须 > 0`);
  }
  if (!HEX64.test(String(library.snapshotSha256 || ""))) {
    problems.push(`${subject}的 library.snapshotSha256 必须为 64 位十六进制`);
  }

  const books = Array.isArray(library.books) ? library.books : [];
  if (books.length === 0) {
    problems.push(`${subject}的 library.books 必须非空`);
  } else {
    if (!books.some((book) => Number.isFinite(book?.currentPage) && book.currentPage > 0)) {
      problems.push(`${subject}的 library.books 至少需要一本书 currentPage > 0`);
    }
    const first = books[0] || {};
    if (!String(first.id || "").trim()) {
      problems.push(`${subject}的 library.books[0] 缺少 id`);
    }
    const ipc = library.ipc;
    if (ipc?.ok !== true) {
      problems.push(`${subject}的 library.ipc.ok 必须为 true（安装后必须真实通过 IPC 回读书库）`);
    }
    if (ipc?.source !== "list_books") {
      problems.push(`${subject}的 library.ipc.source 必须为 list_books`);
    }
    if (String(ipc?.bookId ?? "") !== String(first.id ?? "")) {
      problems.push(`${subject}的 library.ipc.bookId 与 books[0].id 不一致`);
    }
    if (String(ipc?.title ?? "") !== String(first.title ?? "")) {
      problems.push(`${subject}的 library.ipc.title 与 books[0].title 不一致`);
    }
    if (Number(ipc?.currentPage) !== Number(first.currentPage)) {
      problems.push(`${subject}的 library.ipc.currentPage 与 books[0].currentPage 不一致`);
    }
    if (Number(ipc?.scrollPct) !== Number(first.scrollPct)) {
      problems.push(`${subject}的 library.ipc.scrollPct 与 books[0].scrollPct 不一致`);
    }
    if (Number(ipc?.bookCount) !== Number(library.bookCount)) {
      problems.push(`${subject}的 library.ipc.bookCount 与 library.bookCount 不一致`);
    }
  }
  return problems;
}

/**
 * 摘要与升级前版本的自洽性：`expectedArtifactSha256` 必须是本次安装包摘要，
 * 覆盖升级还必须记录上一个版本的版本号与安装包摘要。
 */
export function installIntegrityProblems(evidence, subject = "安装证据") {
  const problems = [];
  const expectedSha = String(evidence.expectedArtifactSha256 || "");
  if (!HEX64.test(expectedSha)) {
    problems.push(`${subject}缺少合法的 expectedArtifactSha256（64 位十六进制）`);
  } else if (expectedSha !== String(evidence.artifactSha256 || "")) {
    problems.push(
      `${subject}的 expectedArtifactSha256 与实际安装包摘要不一致（疑似换包）`,
    );
  }
  if (evidence.checks?.upgrade === "pass") {
    if (!SEMVER.test(String(evidence.previousVersion || ""))) {
      problems.push(`${subject}声明覆盖升级通过，但缺少合法的 previousVersion`);
    } else if (String(evidence.previousVersion) === String(evidence.version)) {
      problems.push(`${subject}的 previousVersion 不能等于当前版本（${evidence.version}）`);
    }
    if (!String(evidence.previousArtifactName || "").trim()) {
      problems.push(`${subject}声明覆盖升级通过，但缺少 previousArtifactName`);
    }
    if (!HEX64.test(String(evidence.previousArtifactSha256 || ""))) {
      problems.push(
        `${subject}声明覆盖升级通过，但 previousArtifactSha256 不是 64 位十六进制`,
      );
    }
  }
  return problems;
}

/** 文件摘要（SHA-256）。 */
export function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

/** 字节摘要（SHA-256）。 */
export function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** 从标签解析版本与通道。 */
export function parseTag(tag) {
  const value = String(tag || "").trim();
  if (REHEARSAL_TAG_PATTERN.test(value)) {
    return {
      channel: "windows",
      platform: CHANNELS.windows.platform,
      version: "0.0.0",
      tag: value,
      rehearsal: true,
      linuxSec: null,
    };
  }
  for (const channel of Object.values(CHANNELS)) {
    const match = value.match(channel.tagPattern);
    if (match) {
      return {
        channel: channel.id,
        platform: channel.platform,
        version: match[1],
        tag: value,
        linuxSec: match[2] ? Number(match[2]) : null,
      };
    }
  }
  return null;
}

/**
 * 构造 RC 记录（候选 job 在制品产出后调用）。
 * @param {object} input
 */
export function buildRcRecord(input) {
  const parsed = parseTag(input.tag);
  if (!parsed) {
    throw new Error(`标签不符合任何通道的命名约定：${input.tag}`);
  }
  if (!HEX40.test(String(input.commit || ""))) {
    throw new Error("commit 必须是 40 位十六进制");
  }
  if (!SEMVER.test(parsed.version)) {
    throw new Error(`版本号非法：${parsed.version}`);
  }
  const artifacts = (input.artifacts || []).map((item) => {
    if (!item.name || !HEX64.test(String(item.sha256 || ""))) {
      throw new Error(`制品缺少 name/sha256：${JSON.stringify(item)}`);
    }
    return {
      name: item.name,
      sha256: item.sha256,
      size: Number.isFinite(item.size) ? item.size : null,
    };
  });
  if (artifacts.length === 0) throw new Error("RC 记录必须至少包含一个制品");
  return {
    kind: RC_KIND,
    // 演练候选必须带标记：发布闸门据此无条件拒绝。
    rehearsal: parsed.rehearsal === true,
    rcId: `rc-${parsed.tag}-${String(input.commit).slice(0, 12)}`,
    version: parsed.version,
    tag: parsed.tag,
    commit: String(input.commit),
    channel: parsed.channel,
    platform: parsed.platform,
    qa: {
      workflow: input.qa?.workflow || "qa-full",
      runId: String(input.qa?.runId || ""),
      buildCommit: String(input.qa?.buildCommit || input.commit),
      artifact: input.qa?.artifact || null,
    },
    artifacts,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 校验 RC 记录本身（结构 + 内部一致性）。
 * @returns {string[]} 问题列表
 */
export function validateRcRecord(record) {
  const problems = [];
  if (!record || record.kind !== RC_KIND) {
    return ["RC 记录 kind 非法或缺失"];
  }
  const parsed = parseTag(record.tag);
  if (!parsed) problems.push(`标签不符合通道命名约定：${record.tag}`);
  if (!HEX40.test(String(record.commit || ""))) problems.push("commit 非法");
  if (!SEMVER.test(String(record.version || ""))) problems.push("version 非法");
  if (parsed) {
    if (parsed.version !== record.version) {
      problems.push(`版本与标签不一致：标签=${parsed.version} 记录=${record.version}`);
    }
    if (parsed.channel !== record.channel) {
      problems.push(`通道与标签不一致：标签=${parsed.channel} 记录=${record.channel}`);
    }
    if (parsed.platform !== record.platform) {
      problems.push(`平台与通道不一致：期望=${parsed.platform} 记录=${record.platform}`);
    }
  }
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    problems.push("RC 记录缺少制品清单");
  } else {
    const names = new Set();
    for (const item of record.artifacts) {
      if (!item.name) problems.push("制品缺少 name");
      if (!HEX64.test(String(item.sha256 || ""))) {
        problems.push(`制品 ${item.name} 缺少合法 sha256`);
      }
      if (names.has(item.name)) problems.push(`制品重名：${item.name}`);
      names.add(item.name);
    }
  }
  if (record.rehearsal === true) {
    if (!REHEARSAL_TAG_PATTERN.test(String(record.tag || ""))) {
      problems.push("演练记录必须使用隔离标签 v0.0.0-rehearsal");
    }
    if (record.version !== "0.0.0") {
      problems.push(`演练记录的版本必须为 0.0.0（当前 ${record.version}）`);
    }
  }
  const qa = record.qa || {};
  if (!qa.runId) problems.push("RC 记录缺少 QA runId");
  if (!HEX40.test(String(qa.buildCommit || ""))) problems.push("RC 记录缺少合法 QA buildCommit");
  if (qa.buildCommit && qa.buildCommit !== record.commit) {
    problems.push(`QA 证据 Commit 与候选 Commit 不一致：qa=${qa.buildCommit} rc=${record.commit}`);
  }
  return problems;
}

/**
 * 校验安装验证回执（干净 Windows VM 的真实安装/升级/回滚/数据完整性）。
 *
 * 回执结构与 `evidence.mjs` **完全一致**（唯一契约）：
 * `artifactName` / `artifactSha256` / `checks.{freshInstall,upgrade,dataIntegrity,recovery}`。
 * 两处曾各用一套字段名，导致发布工作流的第一道闸门对**脚本真实产出的回执**
 * 必然判「疑似审批后替换制品」——已统一。
 *
 * @returns {string[]} 问题列表
 */
export function validateInstallAttestation(attestation, expected) {
  const problems = [];
  if (!attestation || attestation.kind !== INSTALL_ATTESTATION_KIND) {
    return ["安装验证回执缺失或 kind 非法"];
  }
  if (attestation.verdict !== "PASS") {
    problems.push(`安装验证结论不是 PASS：${String(attestation.verdict)}`);
  }
  if (expected) {
    if (attestation.version !== expected.version) {
      problems.push(`回执版本与候选不一致：回执=${attestation.version} 候选=${expected.version}`);
    }
    if (attestation.commit !== expected.commit) {
      problems.push(`回执 Commit 与候选不一致：回执=${attestation.commit} 候选=${expected.commit}`);
    }
    if (attestation.platform !== expected.platform) {
      problems.push(`回执平台与候选不一致：回执=${attestation.platform} 候选=${expected.platform}`);
    }
    if (
      expected.installerSha256 &&
      String(attestation.artifactSha256 || "") !== expected.installerSha256
    ) {
      problems.push("回执指向的安装包摘要与候选制品不一致（疑似审批后替换制品）");
    }
  }
  if (!attestation.artifactName) {
    problems.push("安装验证回执缺少被安装制品名（artifactName）");
  }
  if (!HEX64.test(String(attestation.artifactSha256 || ""))) {
    problems.push("安装验证回执缺少被安装制品的 SHA-256（artifactSha256）");
  }
  const channelId = expected?.channel || "windows";
  const channel = CHANNELS[channelId] || null;
  const required = channel?.requiredChecks || ["freshInstall", "upgrade", "dataIntegrity", "recovery"];
  for (const key of required) {
    if (attestation.checks?.[key] !== "pass") {
      problems.push(`安装验证缺少通过项：${key}`);
    }
  }
  // 运行环境 / provenance / 摘要 / 升级前版本：与 evidence.mjs 共用同一套纯函数。
  problems.push(...machineEvidenceProblems(attestation.machine, "安装验证回执"));
  problems.push(...installIntegrityProblems(attestation, "安装验证回执"));
  // Windows 通道必须证明「安装/升级后用户数据仍在」：数据库自检、进度、真实 IPC 回读。
  if (channelId === "windows") {
    problems.push(...libraryEvidenceProblems(attestation.library, "安装验证回执"));
  }
  if (!attestation.verifiedAt || Number.isNaN(Date.parse(attestation.verifiedAt))) {
    problems.push("安装验证回执缺少合法时间");
  } else if (Date.parse(attestation.verifiedAt) > Date.now() + 60_000) {
    problems.push("安装验证回执时间在未来");
  }
  return problems;
}

/**
 * 发布前的**总闸**：RC 记录 + 实际制品摘要 + 安装验证回执 + 通道必须全部对齐。
 *
 * @param {object} input
 * @param {object} input.record RC 记录
 * @param {Map<string,string>} input.actualDigests 实际下载到的制品 → sha256
 * @param {object} input.attestation 安装验证回执
 * @param {string} input.channel 期望通道
 * @param {string} input.commit 期望 Commit
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyPublishPreconditions(input) {
  const problems = [];
  const record = input.record;
  problems.push(...validateRcRecord(record));
  if (problems.length) return { ok: false, problems };

  // 演练候选永远不是可发布对象（与版本/摘要无关）。
  if (record.rehearsal === true) {
    return {
      ok: false,
      problems: ["演练候选（v0.0.0-rehearsal）永远不得发布"],
    };
  }

  const expectedChannel = CHANNELS[input.channel];
  if (!expectedChannel) {
    return { ok: false, problems: [`未知通道：${input.channel}`] };
  }
  if (record.channel !== expectedChannel.id) {
    problems.push(
      `通道不匹配：期望=${expectedChannel.id} 记录=${record.channel}（禁止跨通道发布）`,
    );
  }
  if (record.platform !== expectedChannel.platform) {
    problems.push(`平台不匹配：期望=${expectedChannel.platform} 记录=${record.platform}`);
  }
  if (input.commit && record.commit !== input.commit) {
    problems.push(`Commit 不匹配：期望=${input.commit} 记录=${record.commit}`);
  }

  // 制品摘要必须与实际下载到的文件一致（审批后替换制品会被这里抓住）。
  const digests = new Map(
    [...(input.actualDigests || new Map())].filter(
      ([name]) => !GOVERNANCE_FILES.has(name),
    ),
  );
  for (const item of record.artifacts) {
    const actual = digests.get(item.name);
    if (actual === undefined) {
      problems.push(`候选制品缺失：${item.name}`);
    } else if (actual !== item.sha256) {
      problems.push(
        `候选制品摘要不一致（疑似审批后替换）：${item.name} 记录=${item.sha256} 实际=${actual}`,
      );
    }
  }
  for (const name of digests.keys()) {
    if (!record.artifacts.some((item) => item.name === name)) {
      problems.push(`出现记录之外的制品：${name}`);
    }
  }

  const installer = record.artifacts.find((item) =>
    /setup\.exe$|\.AppImage$|\.deb$|\.rpm$/.test(item.name),
  );
  problems.push(
    ...validateInstallAttestation(input.attestation, {
      version: record.version,
      commit: record.commit,
      platform: record.platform,
      channel: record.channel,
      installerSha256: installer?.sha256 || null,
    }),
  );

  return { ok: problems.length === 0, problems };
}

/** 生成人类可读的 RC 摘要（写进 Draft Release 正文，供审批人核对）。 */
export function renderRcSummary(record) {
  const lines = [
    "## Release Candidate 摘要（审批依据）",
    "",
    `- 候选：\`${record.rcId}\``,
    `- 版本：\`${record.version}\`（标签 \`${record.tag}\`）`,
    `- Commit：\`${record.commit}\``,
    `- 通道 / 平台：\`${record.channel}\` / \`${record.platform}\``,
    `- QA 证据：${record.qa.workflow} run \`${record.qa.runId}\`（buildCommit \`${record.qa.buildCommit}\`）`,
    "",
    "| 制品 | SHA-256 | 字节 |",
    "|---|---|---|",
    ...record.artifacts.map(
      (item) => `| \`${item.name}\` | \`${item.sha256}\` | ${item.size ?? "-"} |`,
    ),
    "",
    "> 审批前请核对上表摘要；审批后任何制品变化都会被发布前校验拒绝。",
  ];
  return lines.join("\n");
}

/** 读取并解析 JSON 文件。 */
export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** 列出目录下的文件摘要（用于把实际下载到的制品与记录比对）。 */
export function digestDirectory(dir) {
  const result = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.set(path.relative(dir, full).split(path.sep).join("/"), sha256File(full));
    }
  };
  walk(dir);
  return result;
}
