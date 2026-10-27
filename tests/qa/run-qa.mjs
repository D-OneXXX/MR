#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startQaApp } from "./lib/app.mjs";
import { createQaFixtures } from "./lib/fixtures.mjs";
import { startOnlineFixture } from "./lib/online-fixture.mjs";
import {
  createReport,
  fail,
  loadKnowledgeBase,
  note,
  record,
  summarize,
  updateKnowledgeBase,
  writeJsonReport,
  writeMarkdownReport,
} from "./lib/report.mjs";
import { runStaticSuite } from "./suites/static.mjs";
import { runVisualSuite } from "./suites/visual.mjs";
import { runReaderSuite } from "./suites/reader.mjs";
import { runPdfSuite } from "./suites/pdf.mjs";
import { runOnlineSuite } from "./suites/online.mjs";
import { runCacheSuite } from "./suites/cache.mjs";
import { runPrivacySuite } from "./suites/privacy.mjs";
import { runChaosSuite } from "./suites/chaos.mjs";
import { runArchitectureSuite } from "./suites/architecture.mjs";

const QA_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(QA_ROOT, "..", "..");
const ARTIFACT_ROOT = path.join(QA_ROOT, "artifacts", "current");
const FIXTURE_ROOT = path.join(QA_ROOT, "fixtures", "library");
const DATA_DIR = path.join(ARTIFACT_ROOT, "data");
// 混沌套件单独重启一份干净应用：前面的压测/缓存/恢复回归会累积
// WebView 进程状态，混沌再在同一个实例上冻结主线程容易偶发 CDP 超时。
const CHAOS_DATA_DIR = path.join(ARTIFACT_ROOT, "data-chaos");
const REPORTS_DIR = path.join(QA_ROOT, "reports");
const KB_PATH = path.join(QA_ROOT, "qa-knowledge-base.json");
const CDP_PORT = Number(process.env.QA_CDP_PORT || "9334");
const KEEP_DATA = process.argv.includes("--keep-data");
const ONLY = process.argv.find((arg) => arg.startsWith("--suite="))?.split("=")[1];
/** --suite=a,b 可一次跑多个套件（同一应用实例），用于跨套件串扰排查。 */
const ONLY_LIST = ONLY ? ONLY.split(",").map((name) => name.trim()).filter(Boolean) : null;
/** 需要拉起隔离应用（而不是只跑静态检查）的 suite 白名单。 */
const E2E_SUITES = new Set([
  "visual",
  "reader",
  "pdf",
  "online",
  "cache",
  "privacy",
  "chaos",
  "architecture",
]);

function latestGitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "local";
  }
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function cleanArtifacts() {
  fs.rmSync(ARTIFACT_ROOT, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function buildCheck(report) {
  try {
    execFileSync(process.execPath, ["scripts/version-check.mjs", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    okInfra(report, "qa:version-gate", "版本门禁通过");
  } catch (error) {
    fail(report, {
      id: "qa:version-gate",
      suite: "static",
      layer: "build",
      title: "版本门禁失败，QA 运行中止",
      severity: "P0",
      details: error.stdout || error.message,
      location: "scripts/version-check.mjs",
      rootCause: "三端版本不一致",
      fix: "npm run version:sync",
    });
  }
  try {
    execFileSync(process.execPath, ["--test", "scripts/version.test.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    okInfra(report, "qa:version-tests", "版本门禁自测通过");
  } catch (error) {
    fail(report, {
      id: "qa:version-tests",
      suite: "static",
      layer: "unit",
      title: "版本门禁自测失败",
      severity: "P1",
      details: error.stdout || error.message,
      location: "scripts/version.test.mjs",
    });
  }
}

function okInfra(report, id, title) {
  record(report, {
    id,
    suite: "static",
    layer: "unit",
    title,
    pass: true,
  });
}

/**
 * 把工作区重置失败记录成该套件的基础设施缺陷。
 *
 * `ctx.resetWorkspace()` 失败时会往 `ctx.resetFailures` 留档，因此即便某个套件
 * 用 `.catch(() => {})` 把异常吞了，这里也能把它捞出来——重置失败绝不能静默。
 */
const resetFailureCounts = new Map();

function recordResetFailures(report, ctx, suiteId) {
  const pending = Array.isArray(ctx?.resetFailures) ? ctx.resetFailures.splice(0) : [];
  pending.forEach((failure) => {
    const seen = (resetFailureCounts.get(suiteId) ?? 0) + 1;
    resetFailureCounts.set(suiteId, seen);
    const id =
      seen === 1
        ? `qa:workspace-reset:${suiteId}`
        : `qa:workspace-reset:${suiteId}#${seen}`;
    fail(report, {
      id,
      suite: suiteId,
      layer: "infrastructure",
      title: `工作区重置失败：套件 ${suiteId} 可能运行在脏状态`,
      severity: "P2",
      details: failure.stack || failure.message,
      location: "tests/qa/lib/app.mjs",
      rootCause: "页面重载后主窗口未恢复，或阅读器在卸载时崩溃",
      fix: "修复重置流程后重跑；若同一套件反复重置失败，按 P1 升级处理",
    });
    note(
      report,
      `工作区重置失败（${suiteId}）：${failure.message}；该套件继续执行，结果需结合这条缺陷判读。`,
    );
  });
}

async function runOne(report, ctx, suite) {
  try {
    await suite.run(ctx, report);
  } catch (error) {
    fail(report, {
      id: `${suite.id}:crashed`,
      suite: suite.id,
      layer: "infrastructure",
      title: `${suite.title} 执行中断`,
      severity: "P0",
      details: error.stack || error.message,
      location: `tests/qa/suites/${suite.id}.mjs`,
      rootCause: "测试基础设施或应用崩溃",
      fix: "修复异常后重跑；如应用泄漏则按 P0 处理",
    });
  }
}

async function main() {
  cleanArtifacts();
  const report = createReport({
    root: ROOT,
    artifactDir: ARTIFACT_ROOT,
    appVersion: version(),
    buildCommit: latestGitCommit(),
  });
  note(report, "QA 运行器：isolated CDP harness");
  note(report, `CDP 端口：${CDP_PORT}；隔离数据：${DATA_DIR}`);

  buildCheck(report);

  const staticResult = { id: "static", title: "静态与版本红线", run: runStaticSuite };
  await runOne(report, { root: ROOT, artifactDir: ARTIFACT_ROOT }, staticResult);

  if (ONLY_LIST && !ONLY_LIST.some((name) => E2E_SUITES.has(name))) {
    finalize(report);
    return;
  }

  const fixtures = createQaFixtures(FIXTURE_ROOT);
  let ctx = null;
  let onlineFixture = null;
  try {
    // Start before the app so the debug-only Telegram origin override can be
    // injected into the app environment. Production builds ignore it.
    onlineFixture = await startOnlineFixture();
    ctx = await startQaApp({
      root: ROOT,
      artifactDir: ARTIFACT_ROOT,
      dataDir: DATA_DIR,
      fixtures,
      cdpPort: CDP_PORT,
      telegramTestOrigin: onlineFixture.origin,
    });
    ctx.onlineFixture = onlineFixture;
    const suites = [
      { id: "visual", title: "双主题与六语种排版", run: runVisualSuite },
      { id: "reader", title: "阅读器与条漫压测", run: runReaderSuite },
      { id: "pdf", title: "PDF 渲染、进度与安全策略", run: runPdfSuite },
      { id: "online", title: "在线直读与噪音过滤", run: runOnlineSuite },
      { id: "cache", title: "磁盘缓存上限与清理隔离", run: runCacheSuite },
      { id: "privacy", title: "隐私脱敏与版本展示", run: runPrivacySuite },
      {
        id: "architecture",
        title:
          "架构宪法回归（路由兜底 / 存储清洗 / 快捷键隔离 / 超高条漫逻辑页 / 设置 5 分区与深链 / 后置 i18n）",
        run: runArchitectureSuite,
      },
    ].filter((suite) => !ONLY_LIST || ONLY_LIST.includes(suite.id));
    for (const suite of suites) {
      console.log(`[qa] running ${suite.id} — ${suite.title}`);
      // 每个套件开始前重置工作区页签：阅读页签有数量上限，上一个套件开满页签会让
      // 下一个套件的路由跳转被「回退到上一个页签」静默拒绝。
      //
      // 重置失败必须**显式记录**成该套件的基础设施缺陷，不能静默吞掉：
      // 吞掉既会让套件在脏状态（页签没清干净）下跑出误导性结果，也会掩盖
      // 「阅读器卸载即崩溃」这类真实缺陷。但它不能中断整轮 QA，所以只记录不抛出。
      try {
        await ctx.resetWorkspace();
      } catch (error) {
        note(
          report,
          `工作区重置失败（${suite.id}）：${error.message}；该套件继续执行，结果需结合这条缺陷判读。`,
        );
      }
      recordResetFailures(report, ctx, suite.id);
      await runOne(report, ctx, suite);
      // 套件内部自己调用 resetWorkspace 时可能仍把异常吞掉：
      // 这里再扫一次兜底记录，确保重置失败不会从报告里消失。
      recordResetFailures(report, ctx, suite.id);
    }

    // 混沌套件最后在**全新应用实例 + 独立数据目录**上运行：它会冻结
    // 主线程并重建窗口，既不能污染后续套件，也不应继承前面压测留下的
    // 半僵死 WebView 状态（否则偶发 CDP Runtime.evaluate 超时）。
    if (!ONLY_LIST || ONLY_LIST.includes("chaos")) {
      // 换实例前把旧实例残留的重置失败记录捞干净，别随实例一起丢掉。
      recordResetFailures(report, ctx, "chaos");
      await ctx.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
      ctx = await startQaApp({
        root: ROOT,
        artifactDir: ARTIFACT_ROOT,
        dataDir: CHAOS_DATA_DIR,
        fixtures,
        cdpPort: CDP_PORT,
        telegramTestOrigin: onlineFixture.origin,
      });
      ctx.onlineFixture = onlineFixture;
      console.log("[qa] running chaos — 混沌、安全模式与恢复（独立实例）");
      await runOne(report, ctx, {
        id: "chaos",
        title: "混沌、安全模式与恢复",
        run: runChaosSuite,
      });
      // 混沌套件内部也会重置工作区：失败同样要落到报告里。
      recordResetFailures(report, ctx, "chaos");
    }
  } catch (error) {
    fail(report, {
      id: "qa:app-bootstrap",
      suite: "infrastructure",
      layer: "infrastructure",
      title: "QA 隔离应用启动失败",
      severity: "P0",
      details: error.stack || error.message,
      location: "tests/qa/lib/app.mjs",
      rootCause: "二进制缺失、Vite/CDP 不可用或夹具导入失败",
      fix: "确保 cargo build 与 Vite 正常后重试",
    });
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (onlineFixture) {
      await onlineFixture.close().catch(() => {});
    }
    if (!KEEP_DATA) {
      for (const target of [DATA_DIR, CHAOS_DATA_DIR, FIXTURE_ROOT]) {
        try {
          fs.rmSync(target, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          });
        } catch (error) {
          note(
            report,
            `清理隔离数据失败（不影响审计结论）：${path.relative(ROOT, target)}: ${error.message}`,
          );
        }
      }
    }
  }

  finalize(report);
}

function redactLocalPaths(value) {
  if (typeof value === "string") {
    const hostname = os.hostname();
    return value
      .split(ROOT.replace(/\\/g, "/"))
      .join("<repo>")
      .split(ROOT)
      .join("<repo>")
      .split(hostname)
      .join("<host>")
      .replace(/file:\/\/\/[A-Za-z]:\/Users\/[^/\s]+\//g, "file:///<user>/")
      .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\/g, "C:\\Users\\<user>\\");
  }
  if (Array.isArray(value)) return value.map((item) => redactLocalPaths(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactLocalPaths(item)]),
    );
  }
  return value;
}

function finalize(report) {
  report.finishedAt = new Date().toISOString();
  const kb = loadKnowledgeBase(KB_PATH);
  updateKnowledgeBase(kb, report);
  fs.writeFileSync(KB_PATH, JSON.stringify(redactLocalPaths(kb), null, 2), "utf8");
  report.staticAudit = (kb.backlog || []).filter((entry) => entry.status === "open");
  const jsonPath = path.join(REPORTS_DIR, "latest.json");
  const mdPath = path.join(REPORTS_DIR, "latest.md");
  writeJsonReport(report, jsonPath);
  writeMarkdownReport(report, mdPath, kb);
  const summary = summarize(report);
  console.log("");
  console.log("================ Moyu QA ================");
  console.log(
    `版本 v${report.appVersion} @ ${report.buildCommit} | 通过 ${summary.passed}/${summary.total} (${summary.passRate.toFixed(1)}%)`,
  );
  console.log(
    `缺陷 P0=${summary.bySeverity.P0} P1=${summary.bySeverity.P1} P2=${summary.bySeverity.P2} P3=${summary.bySeverity.P3}`,
  );
  console.log(`报告：${mdPath}`);
  console.log(`JSON：${jsonPath}`);
  console.log(`截图：${path.join(ARTIFACT_ROOT, "screens")}`);
  for (const defect of report.defects) {
    console.log(`- [${defect.severity}] ${defect.id} ${defect.title} ${defect.location ? `@ ${defect.location}` : ""}`);
  }
  console.log("===============================================");
  if (summary.bySeverity.P0 > 0 || summary.bySeverity.P1 > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
