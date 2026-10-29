import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateGate } from "./qa-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "qa-gate.mjs");

const validIssue = (overrides = {}) => ({
  id: "pdf:worker-network-observed",
  severity: "P2",
  status: "accepted-test-defect",
  scope: "测试观测机制问题，不影响功能",
  evidence: "run 123、基线同样失败",
  owner: "D-OneXXX",
  reviewBy: "2099-01-01",
  blocksRelease: false,
  ...overrides,
});

const P2 = { id: "pdf:worker-network-observed", severity: "P2" };

test("无缺陷：放行", () => {
  const result = evaluateGate([], { issues: [] }, { today: "2026-10-29" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("未登记的 P2：阻断", () => {
  const result = evaluateGate([P2], { issues: [] }, { today: "2026-10-29" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /未登记的缺陷：pdf:worker-network-observed/);
});

test("已登记且信息完整、未过期：放行并提示", () => {
  const result = evaluateGate([P2], { issues: [validIssue()] }, { today: "2026-10-29" });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.match(result.notes.join("\n"), /已豁免 pdf:worker-network-observed/);
});

test("豁免缺字段：阻断，并指出缺什么", () => {
  for (const field of ["scope", "evidence", "owner", "reviewBy"]) {
    const issue = validIssue({ [field]: "" });
    const result = evaluateGate([P2], { issues: [issue] }, { today: "2026-10-29" });
    assert.equal(result.ok, false, `缺少 ${field} 时必须阻断`);
    assert.match(result.errors.join("\n"), new RegExp(`缺少 .*${field}`));
  }
});

test("豁免过期：阻断，要求重新评估", () => {
  const issue = validIssue({ reviewBy: "2026-10-01" });
  const result = evaluateGate([P2], { issues: [issue] }, { today: "2026-10-29" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /豁免已过期/);
});

test("P0 与 P1 永远不得豁免：即使登记了也阻断", () => {
  for (const severity of ["P0", "P1"]) {
    const id = severity === "P0" ? "chaos:freeze-suite" : "pdf:backup-roundtrip";
    const result = evaluateGate(
      [{ id, severity }],
      { issues: [validIssue({ id, severity })] },
      { today: "2026-10-29" },
    );
    assert.equal(result.ok, false, `${severity} 不得放行`);
    assert.match(result.errors.join("\n"), new RegExp(`${severity} 缺陷不得豁免`));
  }
});

test("登记了但本次未复现：放行并提示可移除", () => {
  const result = evaluateGate([], { issues: [validIssue()] }, { today: "2026-10-29" });
  assert.equal(result.ok, true);
  assert.match(result.notes.join("\n"), /本次未复现/);
});

test("缺陷缺 id：阻断（不可静默跳过）", () => {
  const result = evaluateGate([{ severity: "P2" }], { issues: [] }, { today: "2026-10-29" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /缺少 id/);
});

test("CLI：正常报告放行（退出码 0），报告缺失阻断（退出码 1）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-qa-gate-"));
  const registry = path.join(dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ issues: [validIssue()] }));
  const report = path.join(dir, "latest.json");
  fs.writeFileSync(report, JSON.stringify({ buildCommit: "abc", checks: [], defects: [P2] }));

  const ok = spawnSync(process.execPath, [script, "--report", report, "--registry", registry, "--today", "2026-10-29"], {
    encoding: "utf8",
  });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /结论：放行/);

  const missing = spawnSync(process.execPath, [script, "--report", path.join(dir, "nope.json"), "--registry", registry], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /无法读取 QA 报告/);
});
