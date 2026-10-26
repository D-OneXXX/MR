#!/usr/bin/env node
/**
 * 发布证据总闸：签名验证 + 真实安装/升级验证缺一不可，且必须与候选绑定。
 *
 * 只读本地文件（RC 记录、Draft 资产、证据 JSON、公钥），**不发布、不改远端**。
 * 任一不一致 → 非零退出并逐条打印原因，由发布工作流据此拒绝发布。
 *
 * 用法：
 *   node scripts/release-governance/verify-evidence.mjs \
 *     --record rc-record.json --assets-dir <dir> \
 *     --signature-evidence signature-verification.json \
 *     --install-evidence install-verification.json \
 *     --public-key configured.pub --channel windows --commit <40-hex>
 */
import fs from "node:fs";
import path from "node:path";
import { digestDirectory, readJsonFile } from "./rc-record.mjs";
import { publicKeyId, verifyReleaseEvidence } from "./evidence.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function runGate({ record, digests, signatureEvidence, installEvidence, channel, commit, publicKeyId: keyId, maxAgeDays, now, requiredChecks }) {
  return verifyReleaseEvidence({
    record,
    digests,
    signatureEvidence,
    installEvidence,
    channel,
    commit,
    publicKeyId: keyId,
    maxAgeDays,
    now,
    requiredChecks,
  });
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const key of ["record", "assets-dir", "signature-evidence", "install-evidence", "public-key", "channel", "commit"]) {
    if (!args[key]) {
      console.error(`[evidence-gate] 缺少参数 --${key}`);
      return 2;
    }
  }
  for (const key of ["record", "signature-evidence", "install-evidence", "public-key"]) {
    if (!fs.existsSync(args[key])) {
      console.error(`[evidence-gate] 缺少必需证据文件：${args[key]}（发布被拒绝）`);
      return 1;
    }
  }
  if (!fs.existsSync(args["assets-dir"])) {
    console.error(`[evidence-gate] 制品目录不存在：${args["assets-dir"]}`);
    return 1;
  }

  const record = readJsonFile(args.record);
  const digests = digestDirectory(args["assets-dir"]);
  const signatureEvidence = readJsonFile(args["signature-evidence"]);
  const installEvidence = readJsonFile(args["install-evidence"]);
  const keyId = publicKeyId(fs.readFileSync(args["public-key"], "utf8"));

  const verdict = runGate({
    record,
    digests,
    signatureEvidence,
    installEvidence,
    channel: args.channel,
    commit: args.commit,
    publicKeyId: keyId,
    maxAgeDays: args["max-age-days"] ? Number(args["max-age-days"]) : undefined,
  });
  if (!verdict.ok) {
    console.error("[evidence-gate] 发布证据校验失败（拒绝发布）：");
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `[evidence-gate] OK：签名验证与安装/升级验证证据齐备且与候选绑定（版本=${record.version} 通道=${record.channel} 平台=${record.platform}）`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
