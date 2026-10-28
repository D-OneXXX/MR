// 工作流契约测试共享助手（归属 PR A；PR B 的发布说明契约测试也复用它）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const workflow = (name) =>
  fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");

function inputBlock(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.startsWith("      ") && line.trim() === `${name}:`,
  );
  assert.ok(start >= 0, `缺少 workflow_dispatch 输入 ${name}`);
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^      [a-z_]+:$/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join("\n");
}

/**
 * 把 workflow 拆成步骤（name / if / run）。只做结构解析，不做文本搜索：
 * 后续断言基于「谁产出 draft-assets/、谁消费它、各自被什么条件门控」。
 */
export function parseSteps(source) {
  const lines = source.split(/\r?\n/);
  const steps = [];
  let current = null;
  let inRun = false;
  for (const line of lines) {
    const start = line.match(/^ {6}- name: (.+?)\s*$/);
    if (start) {
      if (current) steps.push(current);
      current = { name: start[1], if: "", run: "" };
      inRun = false;
      continue;
    }
    if (!current) continue;
    const maybeIf = line.match(/^ {8}if: (.+?)\s*$/);
    if (maybeIf && !inRun) {
      current.if = maybeIf[1];
      continue;
    }
    if (/^ {8}run: \|/.test(line)) {
      inRun = true;
      continue;
    }
    if (inRun) {
      if (line.trim() === "") current.run += "\n";
      else if (/^ {10,}/.test(line)) current.run += line.slice(10) + "\n";
      else inRun = false;
    }
  }
  if (current) steps.push(current);
  return steps;
}

export { root, workflow, inputBlock };
