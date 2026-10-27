/**
 * 发布证据门禁单元测试：缺证据 / 过期 / 版本不一致 / 制品被换 / 公钥不匹配 / 演练候选
 * 都必须**拒绝**发布；干净环境必须是**可核实的 provenance**，Windows 通道还必须
 * 证明安装/升级后用户数据仍在（数据库自检 + 进度 + IPC 回读）。齐备且绑定一致才放行。
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
const PREVIOUS_SHA = "b".repeat(64);
const BOOK_ID = "1".repeat(64);
const SNAPSHOT_SHA = "c".repeat(64);
const KEY_ID = "67CB304460E08E4A";
const NOW = "2026-10-27T00:00:00.000Z";

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

/** 合法的新证据结构（canonical）：干净 GitHub-hosted runner + 合成书库 + IPC 回读。 */
function makeInstallEvidence(overrides = {}) {
  return {
    kind: INSTALL_EVIDENCE_KIND,
    verdict: "PASS",
    version: "0.17.2",
    commit: COMMIT,
    platform: "windows-x86_64",
    artifactName: "MangaReader_0.17.2_x64-setup.exe",
    artifactSha256: ARTIFACT_SHA,
    expectedArtifactSha256: ARTIFACT_SHA,
    previousVersion: "0.17.1",
    previousArtifactName: "MangaReader_0.17.1_x64-setup.exe",
    previousArtifactSha256: PREVIOUS_SHA,
    checks: {
      freshInstall: "pass",
      upgrade: "pass",
      dataIntegrity: "pass",
      recovery: "pass",
      pdfReading: "pass",
      progressRestart: "pass",
      backupRestore: "pass",
      databaseRollback: "pass",
    },
    library: {
      quickCheck: "ok",
      schemaVersionBefore: 1,
      schemaVersionAfter: 1,
      bookCount: 1,
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
      ipc: {
        ok: true,
        source: "list_books",
        bookId: BOOK_ID,
        title: "Release Smoke Book",
        currentPage: 2,
        scrollPct: 0.5,
        bookCount: 1,
        checkedAt: "2026-10-26T00:10:00.000Z",
      },
      snapshotSha256: SNAPSHOT_SHA,
      verifiedAt: "2026-10-26T00:10:00.000Z",
    },
    machine: {
      os: "Microsoft Windows Server 2022 Datacenter",
      cleanEnvironment: true,
      image: "GitHub Actions windows-2022 20261021.1.0",
      host: "RUNNER-01",
      provenance: {
        kind: "github-actions",
        repository: "D-OneXXX/MR",
        runId: "1234567890",
        runUrl: "https://github.com/D-OneXXX/MR/actions/runs/1234567890",
        runnerName: "RUNNER-01",
        imageOs: "win22",
        imageVersion: "20261021.1.0",
        workflow:
          "D-OneXXX/MR/.github/workflows/release-install-verify.yml@refs/heads/main",
        actor: "D-OneXXX",
        runAttempt: "1",
        startedAt: "2026-10-26T00:00:00.000Z",
      },
    },
    verifiedAt: "2026-10-26T00:10:00.000Z",
    ...overrides,
  };
}

function withProvenance(provenance) {
  const evidence = makeInstallEvidence();
  evidence.machine = { ...evidence.machine, provenance };
  return evidence;
}

function withLibrary(patch) {
  const evidence = makeInstallEvidence();
  evidence.library = { ...evidence.library, ...patch };
  return evidence;
}

const installEvidence = makeInstallEvidence();

const expected = {
  version: "0.17.2",
  commit: COMMIT,
  platform: "windows-x86_64",
  artifactName: "MangaReader_0.17.2_x64-setup.exe",
  artifactSha256: ARTIFACT_SHA,
  publicKeyId: KEY_ID,
  channel: "windows",
  now: NOW,
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

test("安装证据：合法新证据 → 通过", () => {
  assert.deepEqual(validateInstallEvidence(installEvidence, expected), []);
  // local-vm provenance 同样合法（人工核验镜像 SHA 与日志由 verify-provenance 负责）。
  const localVm = withProvenance({
    kind: "local-vm",
    hypervisor: "hyperv",
    vmId: "vm-77-clean",
    imageSha256: "d".repeat(64),
    imagePath: "D:/vm/win2022-clean.vhdx",
    startedAt: "2026-10-26T00:00:00.000Z",
  });
  assert.deepEqual(validateInstallEvidence(localVm, expected), []);
});

test("安装证据：缺少任一检查项 → 拒绝", () => {
  for (const key of [
    "freshInstall",
    "upgrade",
    "dataIntegrity",
    "recovery",
    "pdfReading",
    "progressRestart",
    "backupRestore",
    "databaseRollback",
  ]) {
    const checks = { ...installEvidence.checks };
    delete checks[key];
    const problems = validateInstallEvidence({ ...installEvidence, checks }, expected);
    assert.ok(
      problems.some((p) => p.includes(key)),
      `${key} 缺失必须被拒绝`,
    );
  }
});

test("安装证据：PDF / 进度重启 / 备份恢复 / 数据库回滚是新门禁项", () => {
  // 四项新检查只允许 pass/fail；任何非 pass（含缺失、fail、其它值）都必须拒绝。
  for (const key of ["pdfReading", "progressRestart", "backupRestore", "databaseRollback"]) {
    for (const value of [undefined, "fail", "skipped", true]) {
      const checks = { ...installEvidence.checks, [key]: value };
      if (value === undefined) delete checks[key];
      const problems = validateInstallEvidence({ ...installEvidence, checks }, expected);
      assert.ok(
        problems.some((p) => p.includes(key)),
        `${key}=${String(value)} 必须被拒绝`,
      );
    }
  }
  // 八项全 pass 仍必须放行（不误伤完整证据）。
  assert.deepEqual(validateInstallEvidence(installEvidence, expected), []);
});

test("安装证据：旧共享宿主回执（clean=false、无 provenance/library）→ 拒绝", () => {
  const legacy = makeInstallEvidence();
  delete legacy.library;
  delete legacy.expectedArtifactSha256;
  delete legacy.previousVersion;
  delete legacy.previousArtifactName;
  delete legacy.previousArtifactSha256;
  legacy.machine = {
    os: "Windows 11",
    image: "shared-workstation",
    cleanEnvironment: false,
  };
  const problems = validateInstallEvidence(legacy, expected);
  assert.ok(problems.some((p) => p.includes("干净环境")));
  assert.ok(problems.some((p) => p.includes("provenance")));
  assert.ok(problems.some((p) => p.includes("library")));
});

test("安装证据：未声明干净环境 / 镜像为空 → 拒绝", () => {
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
  const withoutImage = validateInstallEvidence(
    {
      ...installEvidence,
      machine: { ...installEvidence.machine, image: "  " },
    },
    expected,
  );
  assert.ok(withoutImage.some((p) => p.includes("镜像")));
});

test("安装证据：github-actions provenance 缺 runUrl/runId/imageVersion → 拒绝", () => {
  for (const key of ["runUrl", "runId", "imageVersion", "repository", "runnerName", "actor"]) {
    const provenance = { ...installEvidence.machine.provenance };
    delete provenance[key];
    const problems = validateInstallEvidence(withProvenance(provenance), expected);
    assert.ok(
      problems.some((p) => p.includes(key)),
      `缺少 provenance.${key} 必须被拒绝`,
    );
  }
  const badImageVersion = validateInstallEvidence(
    withProvenance({
      ...installEvidence.machine.provenance,
      imageVersion: "2026-10-21",
    }),
    expected,
  );
  assert.ok(badImageVersion.some((p) => p.includes("imageVersion")));
});

test("安装证据：runUrl 与 repository/runId 不一致 → 拒绝", () => {
  const problems = validateInstallEvidence(
    withProvenance({
      ...installEvidence.machine.provenance,
      runUrl: "https://github.com/D-OneXXX/MR/actions/runs/9999999999",
    }),
    expected,
  );
  assert.ok(problems.some((p) => p.includes("runUrl")));
});

test("安装证据：local-vm provenance 缺 hypervisor/vmId/imageSha256 → 拒绝", () => {
  for (const key of ["hypervisor", "vmId", "imageSha256"]) {
    const provenance = {
      kind: "local-vm",
      hypervisor: "hyperv",
      vmId: "vm-77-clean",
      imageSha256: "d".repeat(64),
      startedAt: "2026-10-26T00:00:00.000Z",
    };
    delete provenance[key];
    const problems = validateInstallEvidence(withProvenance(provenance), expected);
    assert.ok(
      problems.some((p) => p.includes(key)),
      `local-vm 缺少 ${key} 必须被拒绝`,
    );
  }
  const badKind = validateInstallEvidence(
    withProvenance({ kind: "manual", operator: "someone" }),
    expected,
  );
  assert.ok(badKind.some((p) => p.includes("provenance.kind")));
});

test("安装证据：expectedArtifactSha256 必须是 64 hex 且等于 artifactSha256", () => {
  const missing = makeInstallEvidence();
  delete missing.expectedArtifactSha256;
  assert.ok(
    validateInstallEvidence(missing, expected).some((p) => p.includes("expectedArtifactSha256")),
  );
  const short = validateInstallEvidence(
    { ...installEvidence, expectedArtifactSha256: "abc" },
    expected,
  );
  assert.ok(short.some((p) => p.includes("expectedArtifactSha256")));
  const mismatched = validateInstallEvidence(
    { ...installEvidence, expectedArtifactSha256: "e".repeat(64) },
    expected,
  );
  assert.ok(mismatched.some((p) => p.includes("expectedArtifactSha256")));
});

test("安装证据：library 缺 quickCheck/books/readingLogPages → 拒绝", () => {
  for (const key of ["quickCheck", "books", "readingLogPages", "snapshotSha256", "ipc"]) {
    const evidence = makeInstallEvidence();
    delete evidence.library[key];
    const problems = validateInstallEvidence(evidence, expected);
    assert.ok(
      problems.some((p) => p.includes(key)),
      `library 缺少 ${key} 必须被拒绝`,
    );
  }
  const noProgress = validateInstallEvidence(
    withLibrary({
      books: [
        {
          id: BOOK_ID,
          title: "Release Smoke Book",
          pageCount: 3,
          currentPage: 0,
          scrollPct: 0,
          removed: 0,
          sourceType: "local",
        },
      ],
    }),
    expected,
  );
  assert.ok(noProgress.some((p) => p.includes("currentPage")));
  const badReadingLog = validateInstallEvidence(
    withLibrary({ readingLogRows: 0, readingLogPages: 0 }),
    expected,
  );
  assert.ok(badReadingLog.some((p) => p.includes("readingLogRows")));
  assert.ok(badReadingLog.some((p) => p.includes("readingLogPages")));
});

test("安装证据：books 与 ipc 的 currentPage 不一致 → 拒绝", () => {
  const evidence = makeInstallEvidence();
  evidence.library = {
    ...evidence.library,
    ipc: { ...evidence.library.ipc, currentPage: 1 },
  };
  const problems = validateInstallEvidence(evidence, expected);
  assert.ok(problems.some((p) => p.includes("ipc.currentPage")));

  const wrongIpcSource = withLibrary({
    ipc: { ...installEvidence.library.ipc, source: "get_book" },
  });
  assert.ok(
    validateInstallEvidence(wrongIpcSource, expected).some((p) => p.includes("ipc.source")),
  );
  const wrongBookCount = withLibrary({
    ipc: { ...installEvidence.library.ipc, bookCount: 2 },
  });
  assert.ok(
    validateInstallEvidence(wrongBookCount, expected).some((p) => p.includes("ipc.bookCount")),
  );
});

test("安装证据：upgrade=pass 但缺 previousVersion/previousArtifactSha256 → 拒绝", () => {
  const noPrevious = makeInstallEvidence();
  delete noPrevious.previousVersion;
  delete noPrevious.previousArtifactName;
  delete noPrevious.previousArtifactSha256;
  const problems = validateInstallEvidence(noPrevious, expected);
  assert.ok(problems.some((p) => p.includes("previousVersion")));
  assert.ok(problems.some((p) => p.includes("previousArtifactName")));
  assert.ok(problems.some((p) => p.includes("previousArtifactSha256")));

  const sameVersion = validateInstallEvidence(
    { ...installEvidence, previousVersion: "0.17.2" },
    expected,
  );
  assert.ok(sameVersion.some((p) => p.includes("previousVersion")));

  const notSemver = validateInstallEvidence(
    { ...installEvidence, previousVersion: "v0.17.1" },
    expected,
  );
  assert.ok(notSemver.some((p) => p.includes("previousVersion")));
});

test("安装证据：linux-critical 不强制 library，但必须有 PDF/进度/备份与 provenance", () => {
  const linux = makeInstallEvidence({
    platform: "linux-x86_64",
    artifactName: "MangaReader_0.17.2_amd64.AppImage",
    checks: {
      freshInstall: "pass",
      upgrade: "pass",
      dataIntegrity: "pass",
      pdfReading: "pass",
      progressRestart: "pass",
      backupRestore: "pass",
    },
    machine: {
      ...installEvidence.machine,
      os: "Ubuntu 22.04",
      image: "GitHub Actions ubuntu-22.04 20261021.1.0",
    },
  });
  delete linux.library;
  const linuxExpected = {
    ...expected,
    platform: "linux-x86_64",
    artifactName: "MangaReader_0.17.2_amd64.AppImage",
    channel: "linux-critical",
  };
  assert.deepEqual(validateInstallEvidence(linux, linuxExpected), []);
  const missingPdf = {
    ...linux,
    checks: { ...linux.checks, pdfReading: "fail" },
  };
  assert.ok(
    validateInstallEvidence(missingPdf, linuxExpected).some((p) => p.includes("pdfReading")),
  );
  const noProvenance = { ...linux, machine: { ...linux.machine } };
  delete noProvenance.machine.provenance;
  assert.ok(
    validateInstallEvidence(noProvenance, linuxExpected).some((p) => p.includes("provenance")),
  );
});

test("总闸：Linux 签名绑定 AppImage、安装绑定 deb → 放行", () => {
  const appImage = "MangaReader_0.18.0_amd64.AppImage";
  const deb = "MangaReader_0.18.0_amd64.deb";
  const appSha = "d".repeat(64);
  const debSha = "e".repeat(64);
  const linuxRecord = {
    ...record,
    version: "0.18.0",
    tag: "v0.18.0-linux-sec1",
    channel: "linux-critical",
    platform: "linux-x86_64",
    artifacts: [
      { name: "MangaReader-0.18.0-1.x86_64.rpm", sha256: "f".repeat(64), size: 1 },
      { name: appImage, sha256: appSha, size: 1 },
      { name: `${appImage}.sig`, sha256: "1".repeat(64), size: 1 },
      { name: deb, sha256: debSha, size: 1 },
    ],
  };
  const linuxSignature = {
    ...signatureEvidence,
    version: "0.18.0",
    platform: "linux-x86_64",
    artifactName: appImage,
    artifactSha256: appSha,
  };
  const linuxInstall = makeInstallEvidence({
    version: "0.18.0",
    platform: "linux-x86_64",
    artifactName: deb,
    artifactSha256: debSha,
    expectedArtifactSha256: debSha,
    checks: {
      freshInstall: "pass",
      upgrade: "pass",
      dataIntegrity: "pass",
      pdfReading: "pass",
      progressRestart: "pass",
      backupRestore: "pass",
    },
    machine: {
      ...installEvidence.machine,
      os: "Ubuntu 22.04",
      image: "GitHub Actions ubuntu-22.04 20261021.1.0",
    },
  });
  const digests = new Map([
    ["MangaReader-0.18.0-1.x86_64.rpm", "f".repeat(64)],
    [appImage, appSha],
    [`${appImage}.sig`, "1".repeat(64)],
    [deb, debSha],
  ]);
  const verdict = verifyReleaseEvidence({
    record: linuxRecord,
    digests,
    signatureEvidence: linuxSignature,
    installEvidence: linuxInstall,
    channel: "linux-critical",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: NOW,
  });
  assert.equal(verdict.ok, true, verdict.problems.join(" | "));

  const misbound = verifyReleaseEvidence({
    record: linuxRecord,
    digests,
    signatureEvidence: { ...linuxSignature, artifactName: deb, artifactSha256: debSha },
    installEvidence: linuxInstall,
    channel: "linux-critical",
    commit: COMMIT,
    publicKeyId: KEY_ID,
    now: NOW,
  });
  assert.equal(misbound.ok, false);
  assert.ok(misbound.problems.some((p) => p.includes("制品名")));
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
    now: NOW,
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
    now: NOW,
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
    now: NOW,
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
    now: NOW,
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
    now: NOW,
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
