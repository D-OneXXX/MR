#!/usr/bin/env node
/**
 * 从 Draft 资产目录里**唯一地**解析一个文件（安装包、签名文件等）。
 *
 * 背景：publish 工作流原先用 `INSTALLER="$(ls draft-assets/*.exe | head -1)"`，
 * 在 `set -euo pipefail` 下 `ls` 无匹配会直接以非零退出——后面的空串判断根本执行不到，
 * 用户只看到 `ls: cannot access` 这样的原始报错。改成显式计数后：
 *   0 个命中 → 失败并说明缺什么；
 *   多个命中 → 失败并说明有歧义（避免验签对象被随意挑一个）。
 *
 * 用法：
 *   node scripts/release-governance/resolve-draft-asset.mjs \
 *     --dir draft-assets --pattern '*.exe' --label 安装包
 *
 * 退出码：0 = 唯一命中（stdout 输出该文件路径）；2 = 未命中 / 命中不唯一 / 目录不可读。
 */
import fs from "node:fs";
import path from "node:path";

/** 把 shell 风格的 glob 转成锚定的正则（只支持 `*` 与 `?`，其余按字面量处理）。 */
export function globToRegExp(pattern) {
  let source = "";
  for (const char of String(pattern)) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * @param {{dir: string, pattern: string, label?: string}} options
 * @returns {{ok: true, file: string} | {ok: false, reason: string, matches?: string[]}}
 */
export function resolveDraftAsset({ dir, pattern, label = "资产" }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: `无法读取资产目录 ${dir}：${error.code ?? error.message}` };
  }

  const matcher = globToRegExp(pattern);
  const matches = entries
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();

  if (matches.length === 0) {
    return { ok: false, reason: `Draft 缺少${label}（${dir} 下匹配 ${pattern} 无结果）` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `Draft 存在 ${matches.length} 个${label}（匹配 ${pattern}），无法确定验签对象：${matches.join("、")}`,
      matches,
    };
  }
  return { ok: true, file: matches[0] };
}

function main(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length) {
      console.error(`[resolve-draft-asset] ${name} 需要一个值`);
      process.exit(2);
    }
    return args[index + 1];
  };

  const dir = valueOf("--dir");
  const pattern = valueOf("--pattern");
  const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "资产";

  const result = resolveDraftAsset({ dir, pattern, label });
  if (!result.ok) {
    console.error(`[resolve-draft-asset] ${result.reason}：拒绝发布`);
    return 2;
  }
  process.stdout.write(`${result.file}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv);
}
