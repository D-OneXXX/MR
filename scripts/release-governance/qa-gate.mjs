#!/usr/bin/env node
/**
 * L2 全量 QA 合并门禁：把 QA 报告与"已知问题登记表"对照，决定是否放行。
 *
 * 规则（与工程治理约定一致）：
 * - P0 / P1 **永远不得豁免**——登记了也判失败；
 * - P2 / P3 必须在登记表里有条目，且具备 id / scope（影响范围）/ evidence（证据）/
 *   owner（责任人）/ reviewBy（复查日期）；
 * - 豁免过期（reviewBy < 今天）判失败，强制重新评估；
 * - 登记了但本次未复现 → 只提示，不失败；
 * - 报告缺失 / 无法解析 → 判失败（宁可挡住，不可放行一个没有证据的合并）。
 *
 * 用法：
 *   node scripts/release-governance/qa-gate.mjs \
 *     --report <latest.json> \
 *     [--registry scripts/release-governance/qa-known-issues.json] \
 *     [--today YYYY-MM-DD]
 *
 * 退出码：0 放行；1 阻断。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NEVER_WAIVABLE = new Set(["P0", "P1"]);
export const REQUIRED_FIELDS = ["id", "scope", "evidence", "owner", "reviewBy"];

/** 归一化缺陷：报告里 defects 的字段可能大小写不一。 */
function normalizeDefect(defect) {
  return {
    id: String(defect.id ?? "").trim(),
    severity: String(defect.severity ?? "").trim().toUpperCase(),
  };
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 纯逻辑：给定缺陷列表与登记表，返回判定结果。
 * @returns {{ ok: boolean, errors: string[], notes: string[], waivers: object[] }}
 */
export function evaluateGate(defects, registry, { today = todayIso() } = {}) {
  const errors = [];
  const notes = [];
  const waivers = [];
  const issues = Array.isArray(registry?.issues) ? registry.issues : [];
  const byId = new Map(issues.map((issue) => [String(issue.id ?? "").trim(), issue]));

  const seen = new Set();
  for (const raw of defects) {
    const { id, severity } = normalizeDefect(raw);
    if (!id) {
      errors.push(`存在缺少 id 的缺陷：${JSON.stringify(raw).slice(0, 120)}`);
      continue;
    }
    seen.add(id);

    if (NEVER_WAIVABLE.has(severity)) {
      errors.push(`${severity} 缺陷不得豁免：${id}（P0/P1 必须修复后才能合并）`);
      continue;
    }

    const issue = byId.get(id);
    if (!issue) {
      errors.push(`未登记的缺陷：${id}（${severity || "未知等级"}）——要么修掉，要么在 qa-known-issues.json 里登记并说明影响范围、证据、责任人、复查日期`);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((field) => !String(issue[field] ?? "").trim());
    if (missing.length > 0) {
      errors.push(`豁免信息不完整：${id} 缺少 ${missing.join(" / ")}`);
      continue;
    }

    if (String(issue.reviewBy) < today) {
      errors.push(`豁免已过期：${id} 的复查日期 ${issue.reviewBy} 早于 ${today}——请重新评估（修复、续期并更新证据，或升级为发布阻断项）`);
      continue;
    }

    if (issue.status && issue.status !== "accepted-test-defect" && issue.status !== "accepted-known-issue") {
      errors.push(`豁免状态不可用：${id} 的 status=${issue.status}`);
      continue;
    }

    waivers.push(issue);
    notes.push(
      `已豁免 ${id}（${severity}）：${String(issue.scope).slice(0, 80)}…；复查日期 ${issue.reviewBy}` +
        (issue.blocksRelease ? "；**发布验收仍需单独结论**" : ""),
    );
  }

  for (const issue of issues) {
    const id = String(issue.id ?? "").trim();
    if (id && !seen.has(id)) {
      notes.push(`登记的已知问题本次未复现：${id}（可考虑从登记表移除）`);
    }
  }

  return { ok: errors.length === 0, errors, notes, waivers };
}

function main(argv) {
  const args = argv.slice(2);
  const readArg = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const reportPath = readArg("--report");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const registryPath = readArg("--registry", path.join(here, "qa-known-issues.json"));
  const today = readArg("--today", todayIso());

  if (!reportPath) {
    console.error("[qa-gate] 缺少 --report <latest.json>");
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`[qa-gate] 无法读取 QA 报告 ${reportPath}：${error.message}`);
    process.exitCode = 1;
    return;
  }

  let registry = { issues: [] };
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    console.error(`[qa-gate] 无法读取登记表 ${registryPath}：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const defects = Array.isArray(report.defects) ? report.defects : [];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const result = evaluateGate(defects, registry, { today });

  console.log(`[qa-gate] 报告：${reportPath}`);
  console.log(`[qa-gate] 构建：${report.buildCommit ?? "UNKNOWN"}｜检查 ${checks.length} 项｜缺陷 ${defects.length} 项｜判定日期 ${today}`);
  for (const note of result.notes) console.log(`[qa-gate] 提示：${note}`);
  for (const error of result.errors) console.error(`[qa-gate] 阻断：${error}`);
  console.log(`[qa-gate] 结论：${result.ok ? "放行（未豁免缺陷为 0）" : "阻断"}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv);
}
