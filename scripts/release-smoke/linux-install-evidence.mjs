#!/usr/bin/env node
/**
 * 把 Linux 干净环境安装验证的**真实运行结果**组装成发布门禁回执。
 *
 * 设计原则：
 * - 只接受已经执行完成的 harness 结果（每个结果文件必须 `ok:true`）；
 * - PDF 运行时结果必须 `verdict:"pass"`，且 CMap/字体探针成功、外网被拦截、
 *   内嵌脚本未执行、像素非空；
 * - provenance 只能来自 GitHub Actions 环境变量或显式传入的已核实参数，
 *   缺字段直接拒绝，不生成“看起来干净”的声明；
 * - 输出必须能通过 `validateInstallEvidence(channel=linux-critical)`。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { INSTALL_EVIDENCE_KIND, validateInstallEvidence } from "../release-governance/evidence.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`缺少${label}结果文件：${String(filePath)}`);
  }
  return readJson(filePath);
}

function requireOk(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(
      `${label}未通过：${result?.error || (result?.problems || []).join(" | ") || "ok!=true"}`,
    );
  }
}

/**
 * @param {object} input
 * @param {object} input.candidate prepare-candidate-linux 的输出
 * @param {string} input.previousVersion
 * @param {string} input.previousArtifactName
 * @param {string} input.previousArtifactSha256
 * @param {object} input.preUpgrade pre-upgrade 结果
 * @param {object} input.candidateRun candidate 结果
 * @param {object} input.restart restart 结果
 * @param {object} input.legacyRestore 旧版备份恢复结果
 * @param {object} input.newRestore 新版备份恢复结果
 * @param {object} input.newExport 新版备份导出结果
 * @param {object} input.pdfRuntime linux-pdf-runtime 结果
 * @param {object} input.machine {os,image,host,provenance}
 * @param {string} [input.verifiedAt]
 */
export function buildLinuxInstallEvidence(input) {
  const {
    candidate,
    previousVersion,
    previousArtifactName,
    previousArtifactSha256,
    preUpgrade,
    candidateRun,
    restart,
    legacyRestore,
    newRestore,
    newExport,
    pdfRuntime,
    machine,
  } = input;
  if (!candidate?.artifactName || !candidate?.artifactSha256) {
    throw new Error("候选绑定结果缺少 artifactName/artifactSha256");
  }
  requireOk(preUpgrade, "旧版本回读");
  requireOk(candidateRun, "候选版本回读");
  requireOk(restart, "重启后进度恢复");
  requireOk(legacyRestore, "旧版备份恢复");
  requireOk(newRestore, "新版备份恢复");
  requireOk(newExport, "新版备份导出");
  if (pdfRuntime?.verdict !== "pass") {
    throw new Error(`PDF 运行时未通过：${pdfRuntime?.verdict || "missing"}`);
  }
  for (const key of [
    "fontProbeOk",
    "cmapProbeOk",
    "externalBlocked",
    "pixelOk",
  ]) {
    if (pdfRuntime[key] !== true) throw new Error(`PDF 运行时缺少通过项：${key}`);
  }
  if (pdfRuntime.scriptExecuted !== false) {
    throw new Error("PDF 内嵌脚本被执行（安全红线）");
  }
  if (!/connect-src[^;]*'self'/i.test(String(pdfRuntime.runtimeCspPolicy || ""))) {
    throw new Error("PDF 运行时 CSP 的 connect-src 缺少 'self'");
  }
  if (candidateRun.formats?.pdf !== "pdf") {
    throw new Error("候选版本未能以 PDF 格式回读文档");
  }
  if (Number(restart.readback?.bookCount ?? 0) < 4) {
    throw new Error("重启后书库数量不足（PDF/zip/cbz 未保留）");
  }

  const stats = candidateRun.library || {};
  const schemaBefore = Number(
    input.schemaBefore ?? preUpgrade.previousSchemaVersion ?? stats.schemaVersionBefore ?? 0,
  );
  const schemaAfter = Number(stats.schemaVersion ?? stats.schemaVersionAfter ?? 0);
  if (!(schemaBefore >= 1) || !(schemaAfter >= schemaBefore)) {
    throw new Error(`schema 版本异常：before=${schemaBefore} after=${schemaAfter}`);
  }
  if (stats.quickCheck !== "ok") {
    throw new Error(`数据库 quick_check 未通过：${String(stats.quickCheck)}`);
  }
  if (!Array.isArray(stats.books) || stats.books.length === 0) {
    throw new Error("安装后书库为空");
  }
  const focus = stats.books[0];
  const ipc = candidateRun.ipc || {};
  if (ipc.ok !== true || String(ipc.bookId) !== String(focus.id)) {
    throw new Error("安装后 IPC 回读与数据库快照不一致");
  }
  if (Number(ipc.currentPage) !== Number(focus.currentPage)) {
    throw new Error("安装后 IPC 进度与数据库快照不一致");
  }

  const checks = {
    freshInstall: "pass",
    upgrade: "pass",
    dataIntegrity: "pass",
    pdfReading: "pass",
    progressRestart: "pass",
    backupRestore: "pass",
  };
  const evidence = {
    kind: INSTALL_EVIDENCE_KIND,
    verdict: "PASS",
    version: candidate.version,
    commit: candidate.commit,
    platform: "linux-x86_64",
    artifactName: candidate.artifactName,
    artifactSha256: candidate.artifactSha256,
    expectedArtifactSha256: candidate.artifactSha256,
    previousVersion,
    previousArtifactName,
    previousArtifactSha256,
    checks,
    library: {
      quickCheck: stats.quickCheck,
      schemaVersionBefore: schemaBefore,
      schemaVersionAfter: schemaAfter,
      bookCount: Number(stats.bookCount),
      readingLogRows: Number(stats.readingLogRows),
      readingLogPages: Number(stats.readingLogPages),
      books: stats.books.map((book) => ({
        id: book.id,
        title: book.title,
        pageCount: book.pageCount,
        currentPage: book.currentPage,
        scrollPct: book.scrollPct,
        removed: book.removed,
        sourceType: book.sourceType,
      })),
      ipc: {
        ok: true,
        source: ipc.source,
        bookId: ipc.bookId,
        title: ipc.title,
        currentPage: ipc.currentPage,
        scrollPct: ipc.scrollPct,
        bookCount: ipc.bookCount,
        checkedAt: ipc.checkedAt,
      },
      snapshotSha256: stats.snapshotSha256,
      verifiedAt: stats.verifiedAt,
    },
    machine,
    evidence: {
      previousBackupSha256: preUpgrade.backup?.sha256 ?? null,
      newBackupSha256: newExport.backup?.sha256 ?? null,
      legacyRestoredBooks: legacyRestore.imported?.books ?? null,
      newRestoredBooks: newRestore.imported?.books ?? null,
      pdfRuntime: {
        verdict: pdfRuntime.verdict,
        runtimeCspPolicy: pdfRuntime.runtimeCspPolicy,
        fontProbeOk: pdfRuntime.fontProbeOk,
        cmapProbeOk: pdfRuntime.cmapProbeOk,
        externalBlocked: pdfRuntime.externalBlocked,
        scriptExecuted: pdfRuntime.scriptExecuted,
        pixelOk: pdfRuntime.pixelOk,
      },
      formats: candidateRun.formats,
    },
    verifiedAt: input.verifiedAt || new Date().toISOString(),
  };

  const problems = validateInstallEvidence(evidence, {
    version: evidence.version,
    commit: evidence.commit,
    platform: evidence.platform,
    channel: "linux-critical",
    artifactName: evidence.artifactName,
    artifactSha256: evidence.artifactSha256,
    requiredChecks: Object.keys(checks),
  });
  if (problems.length) {
    throw new Error(`组装后的回执未通过证据契约：${problems.join(" | ")}`);
  }
  return evidence;
}

/** 从 GitHub Actions 环境构造 provenance；缺字段直接抛错。 */
export function provenanceFromEnvironment(env = process.env) {
  const fields = {
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    runnerName: env.RUNNER_NAME,
    imageOs: env.ImageOS,
    imageVersion: env.ImageVersion,
    workflow: env.GITHUB_WORKFLOW_REF,
    actor: env.GITHUB_ACTOR,
  };
  const missing = Object.entries(fields)
    .filter(([, value]) => !String(value ?? "").trim() || value.includes("undefined"))
    .map(([key]) => key);
  if (missing.length) throw new Error(`GitHub Actions provenance 缺少字段：${missing.join(", ")}`);
  return { kind: "github-actions", ...fields };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const key of [
    "candidate",
    "previous-version",
    "previous-artifact-name",
    "previous-artifact-sha256",
    "pre-upgrade",
    "candidate-run",
    "restart",
    "legacy-restore",
    "new-restore",
    "new-export",
    "pdf-runtime",
    "out",
  ]) {
    if (!args[key]) {
      console.error(`[linux-install-evidence] 缺少参数 --${key}`);
      return 2;
    }
  }
  try {
    const machine = {
      os: args.os || "Ubuntu 22.04 (GitHub Actions)",
      cleanEnvironment: true,
      image: args.image || `GitHub Actions ubuntu-22.04 ${process.env.ImageOS || ""} ${process.env.ImageVersion || ""}`.trim(),
      host: process.env.RUNNER_NAME || args.host || "",
      provenance: provenanceFromEnvironment(process.env),
    };
    const evidence = buildLinuxInstallEvidence({
      candidate: readJson(args.candidate),
      previousVersion: args["previous-version"],
      previousArtifactName: args["previous-artifact-name"],
      previousArtifactSha256: args["previous-artifact-sha256"],
      preUpgrade: requireFile(args["pre-upgrade"], "旧版本回读"),
      candidateRun: requireFile(args["candidate-run"], "候选版本回读"),
      restart: requireFile(args.restart, "重启恢复"),
      legacyRestore: requireFile(args["legacy-restore"], "旧版备份恢复"),
      newRestore: requireFile(args["new-restore"], "新版备份恢复"),
      newExport: requireFile(args["new-export"], "新版备份导出"),
      pdfRuntime: requireFile(args["pdf-runtime"], "Linux PDF 运行时"),
      machine,
    });
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(
      `[linux-install-evidence] PASS ${evidence.version}@${evidence.commit.slice(0, 12)} ` +
        `artifact=${evidence.artifactName}`,
    );
    return 0;
  } catch (error) {
    console.error(`[linux-install-evidence] FAIL ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}
