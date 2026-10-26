#!/usr/bin/env node
/**
 * 用**官方 minisign** 验证候选制品签名，并产出可审计的签名验证证据。
 *
 * 失败即失败（fail closed）：找不到 minisign、验签不通过、参数缺失 → 非零退出，
 * **不产出**证据文件。发布工作流据此拒绝发布。
 *
 * 用法：
 *   node scripts/release-governance/verify-signature.mjs \
 *     --artifact <installer> --signature <sig> --public-key <pub> \
 *     --version 0.17.2 --commit <40-hex> --platform windows-x86_64 \
 *     --out signature-verification.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { publicKeyId, SIGNATURE_EVIDENCE_KIND } from "./evidence.mjs";

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

/** 定位 minisign：环境变量 → PATH → 仓库内 tools/。找不到就返回 null。 */
export function findMinisign(root = process.cwd()) {
  const candidates = [];
  if (process.env.MR_MINISIGN_BIN) candidates.push(process.env.MR_MINISIGN_BIN);
  candidates.push(
    path.join(root, "tools", "minisign", "minisign.exe"),
    path.join(root, "tools", "minisign", "minisign"),
  );
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const probe = spawnSync("minisign", ["-v"], { encoding: "utf8" });
  if (probe.status === 0) return "minisign";
  return null;
}

export function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const key of ["artifact", "signature", "public-key", "version", "commit", "platform", "out"]) {
    if (!args[key]) {
      console.error(`[signature-verify] 缺少参数 --${key}`);
      return 2;
    }
  }
  for (const key of ["artifact", "signature", "public-key"]) {
    if (!fs.existsSync(args[key])) {
      console.error(`[signature-verify] 文件不存在：${args[key]}`);
      return 1;
    }
  }

  const minisign = findMinisign();
  if (!minisign) {
    console.error(
      "[signature-verify] 找不到 minisign（官方签名验证工具）：拒绝出具签名验证证据",
    );
    return 1;
  }

  // 临时目录里放还原后的 minisign 文本签名（Tauri/rsign 存的是 base64 包装）。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mr-sigverify-"));
  const sigText = path.join(work, "artifact.sig");
  try {
    const raw = fs.readFileSync(args.signature, "utf8").trim();
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    fs.writeFileSync(sigText, decoded.includes("untrusted comment") ? decoded : raw);
  } catch {
    fs.writeFileSync(sigText, fs.readFileSync(args.signature, "utf8"));
  }

  const run = spawnSync(
    minisign,
    ["-V", "-p", args["public-key"], "-m", args.artifact, "-x", sigText],
    { encoding: "utf8" },
  );
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const verified = run.status === 0 && /verified/i.test(output);
  if (!verified) {
    console.error("[signature-verify] 验签未通过：");
    console.error(output.trim().split("\n").slice(0, 6).join("\n"));
    fs.rmSync(work, { recursive: true, force: true });
    return 1;
  }

  const pubText = fs.readFileSync(args["public-key"], "utf8");
  const evidence = {
    kind: SIGNATURE_EVIDENCE_KIND,
    verdict: "PASS",
    version: args.version,
    commit: args.commit,
    platform: args.platform,
    artifactName: path.basename(args.artifact),
    artifactSha256: sha256File(args.artifact),
    publicKeyId: publicKeyId(pubText),
    verifiedBy: `minisign ${(spawnSync(minisign, ["-v"], { encoding: "utf8" }).stdout || "").trim() || "minisign"}`,
    verifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(
    `[signature-verify] OK ${evidence.artifactName} sha256=${evidence.artifactSha256.slice(0, 16)}… pubkeyId=${evidence.publicKeyId}`,
  );
  fs.rmSync(work, { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
