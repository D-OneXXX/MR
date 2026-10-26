#!/usr/bin/env node
/**
 * 发布前闸门：校验 Draft 里的 RC 记录、实际制品摘要与安装验证回执是否完全对齐。
 *
 * 只读本地文件 + 只读远端对象（可选），**不发布、不修改任何 Release**。
 * 任一不一致即以非零码退出，由发布工作流据此阻断发布。
 *
 * 用法：
 *   node scripts/release-governance/verify-draft.mjs \
 *     --tag v0.17.2 --channel windows --commit <40-hex> \
 *     --record <rc-record.json> --assets-dir <dir> \
 *     --attestation <install-verification.json> \
 *     [--manifest <latest.json>] [--platform windows-x86_64]
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  digestDirectory,
  parseTag,
  readJsonFile,
  validateRcRecord,
  verifyPublishPreconditions,
} from "./rc-record.mjs";
import { verifyUpdaterManifest } from "../verify-updater-manifest.mjs";

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

export function runVerification({ record, assetsDir, attestation, tag, channel, commit, manifest, platform }) {
  const problems = [];
  const parsed = parseTag(tag);
  if (!parsed) problems.push(`标签不符合通道命名约定：${tag}`);
  else {
    if (channel && parsed.channel !== channel) {
      problems.push(`标签通道与工作流通道不一致：标签=${parsed.channel} 工作流=${channel}`);
    }
    if (channel && !CHANNELS[channel]) problems.push(`未知通道：${channel}`);
  }

  const recordProblems = validateRcRecord(record);
  problems.push(...recordProblems);

  const digests = assetsDir && fs.existsSync(assetsDir) ? digestDirectory(assetsDir) : new Map();
  if (!assetsDir || !fs.existsSync(assetsDir)) {
    problems.push(`制品目录不存在：${assetsDir}`);
  }

  const verdict = verifyPublishPreconditions({
    record,
    actualDigests: digests,
    attestation,
    channel,
    commit,
  });
  problems.push(...verdict.problems);

  if (manifest) {
    const manifestProblems = verifyUpdaterManifest(manifest, {
      expectVersion: record?.version,
      requirePlatform: platform || CHANNELS[channel]?.platform,
    });
    problems.push(...manifestProblems);
  }

  return { ok: problems.length === 0, problems };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const required = ["tag", "channel", "commit", "record", "assets-dir", "attestation"];
  for (const key of required) {
    if (!args[key]) {
      console.error(`[publish-gate] 缺少参数 --${key}`);
      return 2;
    }
  }
  if (!fs.existsSync(args.record)) {
    console.error(`[publish-gate] 找不到 RC 记录：${args.record}`);
    return 1;
  }
  if (!fs.existsSync(args.attestation)) {
    console.error(`[publish-gate] 找不到安装验证回执：${args.attestation}`);
    return 1;
  }
  const record = readJsonFile(args.record);
  const attestation = readJsonFile(args.attestation);
  const manifest = args.manifest && fs.existsSync(args.manifest) ? readJsonFile(args.manifest) : null;
  const result = runVerification({
    record,
    assetsDir: args["assets-dir"],
    attestation,
    tag: args.tag,
    channel: args.channel,
    commit: args.commit,
    manifest,
    platform: args.platform,
  });
  if (!result.ok) {
    console.error("[publish-gate] 发布前校验失败：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `[publish-gate] OK ${record.rcId}：版本=${record.version} 通道=${record.channel} 平台=${record.platform} 制品=${record.artifacts.length}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
