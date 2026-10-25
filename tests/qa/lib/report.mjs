import fs from "node:fs";
import path from "node:path";

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];

export function createReport({ root, artifactDir, appVersion, buildCommit }) {
  return {
    schema: 1,
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    root,
    artifactDir,
    appVersion,
    buildCommit,
    checks: [],
    defects: [],
    notes: [],
  };
}

export function record(report, check) {
  const entry = {
    id: check.id,
    suite: check.suite,
    layer: check.layer || "integration",
    title: check.title,
    status: check.pass ? "pass" : "fail",
    severity: check.pass ? null : check.severity || "P2",
    details: check.details ?? "",
    location: check.location ?? "",
    repro: check.repro ?? "",
    expected: check.expected ?? "",
    actual: check.actual ?? "",
    rootCause: check.rootCause ?? "",
    fix: check.fix ?? "",
    evidence: check.evidence ?? null,
  };
  report.checks.push(entry);
  if (!check.pass) report.defects.push(entry);
  return entry;
}

export function ok(report, meta) {
  return record(report, { ...meta, pass: true });
}

export function fail(report, meta) {
  return record(report, { ...meta, pass: false });
}

export function note(report, text) {
  report.notes.push(text);
}

export function summarize(report) {
  const total = report.checks.length;
  const passed = report.checks.filter((check) => check.status === "pass").length;
  const failed = total - passed;
  const coverage = [...new Set(report.checks.map((check) => check.layer))];
  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      report.defects.filter((defect) => defect.severity === severity).length,
    ]),
  );
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : (passed / total) * 100,
    coverage,
    bySeverity,
  };
}

export function writeJsonReport(report, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
}

function issueBlock(issue, index) {
  return [
    `### ${issue.severity} · ${issue.id} — ${issue.title}`,
    "",
    `- **精确位置**：\`${issue.location || "未定位"}\``,
    `- **复现路径**：\`${issue.repro || issue.details || "见自动化用例"}\``,
    `- **预期行为**：${issue.expected || "符合需求规范"}`,
    `- **实际错误行为**：${issue.actual || issue.details || "断言失败"}`,
    `- **直指根因与修复方案**：${issue.rootCause || issue.details || "见证据"}${
      issue.fix ? `\n  修复建议：${issue.fix}` : ""
    }`,
    "",
  ].join("\n");
}

export function writeMarkdownReport(report, file, kb = null) {
  const summary = summarize(report);
  const blocking = report.defects
    .filter((issue) => issue.severity === "P0" || issue.severity === "P1")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const cosmetic = report.defects
    .filter((issue) => issue.severity === "P2" || issue.severity === "P3")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staticOpen = (kb?.backlog || []).filter((issue) => issue.status === "open");
  const staticBlocking = staticOpen
    .filter((issue) => issue.severity === "P0" || issue.severity === "P1")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staticCosmetic = staticOpen
    .filter((issue) => issue.severity === "P2" || issue.severity === "P3")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const staticBySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      staticOpen.filter((issue) => issue.severity === severity).length,
    ]),
  );
  const lines = [
    "# MangaReader QA 审计报告",
    "",
    `- 运行编号：${report.runId}`,
    `- 版本：v${report.appVersion} (${report.buildCommit})`,
    `- 应用数据：隔离目录；未触碰现有用户数据`,
    `- 开始/结束：${report.startedAt} / ${report.finishedAt || "进行中"}`,
    "",
    "## 1. 测试总览",
    "",
    `- 通过率：**${summary.passed}/${summary.total}（${summary.passRate.toFixed(1)}%）**`,
    `- 覆盖层级：${summary.coverage.join(" / ") || "无"}`,
    `- 运行时缺陷：P0=${summary.bySeverity.P0} · P1=${summary.bySeverity.P1} · P2=${summary.bySeverity.P2} · P3=${summary.bySeverity.P3}`,
    `- 静态审计 backlog：${staticOpen.length} 条（P0=${staticBySeverity.P0} · P1=${staticBySeverity.P1} · P2=${staticBySeverity.P2} · P3=${staticBySeverity.P3}，尚未全部自动化）`,
    `- 回归用例：${report.knowledgeBase?.regressions ?? 0} 条记忆，新增 ${report.knowledgeBase?.newRegressions ?? 0} 条`,
    "",
    "## 2. 阻塞与严重缺陷直指（P0 / P1）",
    "",
    "### 自动化运行",
    "",
    blocking.length ? blocking.map(issueBlock).join("\n") : "未发现 P0 / P1 缺陷。",
    "",
    ...(staticBlocking.length
      ? [
          "### 静态审计确认（尚未形成自动化断言）",
          "",
          staticBlocking.map(issueBlock).join("\n"),
          "",
        ]
      : []),
    "## 3. 视觉排版与交互瑕疵（P2 / P3）",
    "",
    cosmetic.length ? cosmetic.map(issueBlock).join("\n") : "未发现运行时 P2 / P3 缺陷。",
    "",
    ...(staticCosmetic.length
      ? [
          "### 静态审计 backlog（P2 / P3）",
          "",
          staticCosmetic.map(issueBlock).join("\n"),
          "",
        ]
      : []),
    "## 4. 测试记忆库更新记录",
    "",
    report.knowledgeBase?.added?.length
      ? report.knowledgeBase.added.map((entry) => `- ${entry}`).join("\n")
      : "- 本次没有新增回归模式。",
    "",
    "## 附：失败用例明细",
    "",
    report.defects.length
      ? report.defects
          .map(
            (issue) =>
              `- [${issue.severity}] ${issue.id} / ${issue.suite} — ${issue.title}${
                issue.location ? ` @ ${issue.location}` : ""
              }`,
          )
          .join("\n")
      : "- 无",
    "",
  ];
  if (report.notes.length) {
    lines.push("## 附：环境与执行备注", "", ...report.notes.map((text) => `- ${text}`), "");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

export function loadKnowledgeBase(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      schema: 1,
      updatedAt: null,
      regressions: [],
      defects: [],
    };
  }
}

export function updateKnowledgeBase(kb, report) {
  const added = [];
  const byTest = new Map((kb.regressions || []).map((entry) => [entry.testId, entry]));
  const defectByTest = new Map((kb.defects || []).map((entry) => [entry.testId, entry]));
  for (const defect of report.defects) {
    if (!byTest.has(defect.id)) {
      const regression = {
        id: `REG-${defect.id}`,
        testId: defect.id,
        area: defect.suite,
        trigger: defect.repro || defect.details || defect.title,
        addedAt: new Date().toISOString(),
        source: "qa-run",
      };
      kb.regressions.push(regression);
      byTest.set(defect.id, regression);
      added.push(`新增 ${regression.id}（${defect.title}）`);
    }
    if (!defectByTest.has(defect.id)) {
      const entry = {
        id: defect.id,
        testId: defect.id,
        title: defect.title,
        severity: defect.severity,
        status: "open",
        location: defect.location,
        trigger: defect.repro || defect.details || defect.title,
        expected: defect.expected,
        actual: defect.actual,
        rootCause: defect.rootCause,
        fix: defect.fix,
        firstSeen: report.runId,
        lastSeen: report.runId,
      };
      kb.defects.push(entry);
      defectByTest.set(defect.id, entry);
    } else {
      const entry = defectByTest.get(defect.id);
      entry.lastSeen = report.runId;
      entry.severity = defect.severity;
      entry.location = defect.location || entry.location;
    }
  }
  kb.updatedAt = new Date().toISOString();
  kb.schema = kb.schema || 1;
  kb.regressions = kb.regressions || [];
  kb.defects = kb.defects || [];
  report.knowledgeBase = {
    regressions: kb.regressions.length,
    newRegressions: added.length,
    added,
  };
  return kb;
}
