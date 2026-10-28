import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLinuxInstallEvidence,
  provenanceFromEnvironment,
} from "./linux-install-evidence.mjs";

const COMMIT = "a".repeat(40);
const DEB_SHA = "b".repeat(64);
const PREV_SHA = "c".repeat(64);
const SNAPSHOT = "d".repeat(64);
const BOOK_ID = "e".repeat(64);

const provenance = {
  kind: "github-actions",
  repository: "D-OneXXX/MR",
  runId: "1234567890",
  runUrl: "https://github.com/D-OneXXX/MR/actions/runs/1234567890",
  runnerName: "GitHub Actions 1",
  imageOs: "ubuntu22",
  imageVersion: "20261021.1.0",
  workflow: "D-OneXXX/MR/.github/workflows/release-install-verify-linux.yml@refs/heads/main",
  actor: "D-OneXXX",
};

function makeInput(overrides = {}) {
  const library = {
    quickCheck: "ok",
    schemaVersion: 2,
    bookCount: 4,
    readingLogRows: 2,
    readingLogPages: 3,
    books: [
      {
        id: BOOK_ID,
        title: "Release Smoke Book",
        pageCount: 3,
        currentPage: 2,
        scrollPct: 0.5,
        removed: 0,
        sourceType: "local",
      },
    ],
    snapshotSha256: SNAPSHOT,
    verifiedAt: new Date().toISOString(),
  };
  return {
    candidate: {
      version: "0.18.0",
      commit: COMMIT,
      artifactName: "MangaReader_0.18.0_amd64.deb",
      artifactSha256: DEB_SHA,
    },
    previousVersion: "0.17.1",
    previousArtifactName: "MangaReader_0.17.1_amd64.deb",
    previousArtifactSha256: PREV_SHA,
    preUpgrade: { ok: true, previousSchemaVersion: 1, backup: { sha256: "1".repeat(64) } },
    candidateRun: {
      ok: true,
      formats: { folder: "image", zip: "image", cbz: "image", pdf: "pdf" },
      library,
      ipc: {
        ok: true,
        source: "list_books",
        bookId: BOOK_ID,
        title: "Release Smoke Book",
        currentPage: 2,
        scrollPct: 0.5,
        bookCount: 4,
        checkedAt: new Date().toISOString(),
      },
    },
    restart: { ok: true, readback: { bookCount: 4 } },
    legacyRestore: { ok: true, imported: { books: 1 } },
    newRestore: { ok: true, imported: { books: 4 } },
    newExport: { ok: true, backup: { sha256: "2".repeat(64) } },
    pdfRuntime: {
      verdict: "pass",
      runtimeCspPolicy:
        "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://tauri.localhost https://tauri.localhost",
      fontProbeOk: true,
      cmapProbeOk: true,
      externalBlocked: true,
      scriptExecuted: false,
      pixelOk: true,
    },
    machine: {
      os: "Ubuntu 22.04 (GitHub Actions)",
      cleanEnvironment: true,
      image: "GitHub Actions ubuntu-22.04 ubuntu22 20261021.1.0",
      host: "GitHub Actions 1",
      provenance,
    },
    ...overrides,
  };
}

test("linux-install-evidence：完整真实结果 → PASS 且六项检查齐全", () => {
  const evidence = buildLinuxInstallEvidence(makeInput());
  assert.equal(evidence.kind, "manga-reader.install-verification");
  assert.equal(evidence.verdict, "PASS");
  assert.equal(evidence.platform, "linux-x86_64");
  assert.deepEqual(evidence.checks, {
    freshInstall: "pass",
    upgrade: "pass",
    dataIntegrity: "pass",
    pdfReading: "pass",
    progressRestart: "pass",
    backupRestore: "pass",
  });
  assert.equal(evidence.library.schemaVersionBefore, 1);
  assert.equal(evidence.library.schemaVersionAfter, 2);
  assert.equal(evidence.artifactName, "MangaReader_0.18.0_amd64.deb");
});

test("linux-install-evidence：PDF 嵌入脚本被执行 → 拒绝", () => {
  const input = makeInput();
  input.pdfRuntime = { ...input.pdfRuntime, scriptExecuted: true };
  assert.throws(() => buildLinuxInstallEvidence(input), /内嵌脚本/);
});

test("linux-install-evidence：外部请求未被拦截 → 拒绝", () => {
  const input = makeInput();
  input.pdfRuntime = { ...input.pdfRuntime, externalBlocked: false };
  assert.throws(() => buildLinuxInstallEvidence(input), /externalBlocked/);
});

test("linux-install-evidence：CSP 缺少 connect-src 'self' → 拒绝", () => {
  const input = makeInput();
  input.pdfRuntime = { ...input.pdfRuntime, runtimeCspPolicy: "default-src 'self'" };
  assert.throws(() => buildLinuxInstallEvidence(input), /connect-src/);
});

test("linux-install-evidence：schema 降级 → 拒绝", () => {
  const input = makeInput();
  input.preUpgrade = { ...input.preUpgrade, previousSchemaVersion: 2 };
  input.candidateRun.library = { ...input.candidateRun.library, schemaVersion: 1 };
  assert.throws(() => buildLinuxInstallEvidence(input), /schema 版本异常/);
});

test("linux-install-evidence：IPC 与数据库快照不一致 → 拒绝", () => {
  const input = makeInput();
  input.candidateRun.ipc = { ...input.candidateRun.ipc, currentPage: 1 };
  assert.throws(() => buildLinuxInstallEvidence(input), /IPC 进度/);
});

test("linux-install-evidence：恢复结果失败 → 拒绝", () => {
  const input = makeInput();
  input.newRestore = { ok: false, error: "restore failed" };
  assert.throws(() => buildLinuxInstallEvidence(input), /新版备份恢复/);
});

test("provenanceFromEnvironment：缺 run 字段 → 拒绝", () => {
  assert.throws(() => provenanceFromEnvironment({ GITHUB_REPOSITORY: "D-OneXXX/MR" }), /provenance/);
});
