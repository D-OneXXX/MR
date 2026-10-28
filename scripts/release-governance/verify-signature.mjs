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

/**
 * 官方包同时提供多种架构。选错架构会静默拿到"跑不起来"的可执行文件
 * （spawnSync 失败且无输出），因此选择必须满足：
 *   1) 只看 `tools/minisign` **之内**的路径段，绝不匹配绝对路径（临时目录名里
 *      出现 `x64` 曾导致 aarch64 被判成宿主架构）；
 *   2) 以 `process.arch` 为主判据，而不是猜测目录名；
 *   3) 找不到宿主架构对应二进制时**返回 null**（调用方 fail closed），
 *      不回退到异架构可执行文件。
 */
const HOST_ARCH_TAGS = { x64: "x86_64", arm64: "aarch64" };
const ARCH_ALIASES = {
  x86_64: ["x86_64", "x64", "amd64"],
  aarch64: ["aarch64", "arm64"],
};

export function hostArchTag(arch = process.arch) {
  return HOST_ARCH_TAGS[arch] ?? null;
}

/** 从相对 `tools/minisign` 的路径段里识别架构；无架构标记返回 null。 */
export function archTagOf(relativePath) {
  const segments = String(relativePath)
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const segment of segments) {
    for (const [tag, aliases] of Object.entries(ARCH_ALIASES)) {
      if (aliases.includes(segment)) return tag;
    }
  }
  return null;
}

/** 同架构多个候选时，优先与本机平台匹配的目录（win64 / linux）。 */
function platformRank(relativePath, platform = process.platform) {
  const rel = relativePath.toLowerCase();
  if (platform === "win32") return rel.includes("win") ? 0 : 1;
  if (platform === "linux") return rel.includes("linux") ? 0 : 1;
  return 0;
}

/**
 * 定位 minisign：环境变量 → 仓库内 tools/（递归，兼容官方包的嵌套解压布局，
 * 且**必须匹配宿主架构**）→ PATH。找不到或无法唯一确定就返回 null。
 */
export function findMinisign(root = process.cwd(), { arch = process.arch, platform = process.platform } = {}) {
  const explicit = process.env.MR_MINISIGN_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const base = path.join(root, "tools", "minisign");
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^minisign(\.exe)?$/i.test(entry.name)) found.add(full);
    }
  };
  walk(base, 0);
  // 扁平布局（解压到 tools/minisign 根）也要覆盖。
  for (const flat of ["minisign.exe", "minisign"]) found.add(path.join(base, flat));

  const hostTag = hostArchTag(arch);
  const host = [];
  const neutral = [];
  const foreign = [];
  for (const candidate of found) {
    if (!fs.existsSync(candidate)) continue;
    const rel = path.relative(base, candidate);
    const tag = archTagOf(rel);
    if (!tag) neutral.push(candidate);
    else if (tag === hostTag) host.push(candidate);
    else foreign.push(candidate);
  }

  const uniqueBest = (list) => {
    if (list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) =>
        platformRank(path.relative(base, a), platform) -
          platformRank(path.relative(base, b), platform) || a.localeCompare(b),
    );
    const best = sorted[0];
    const bestRank = platformRank(path.relative(base, best), platform);
    const sameRank = list.filter(
      (item) => platformRank(path.relative(base, item), platform) === bestRank,
    );
    return sameRank.length === 1 ? best : null;
  };

  if (hostTag) {
    if (host.length > 0) return uniqueBest(host);
    // 没有宿主架构的二进制：只有"完全没有异架构候选"时才接受无架构标记的扁平路径。
    if (foreign.length === 0) return uniqueBest(neutral);
    return null;
  }

  // 未知宿主架构：只在候选唯一且没有架构冲突时接受。
  if (foreign.length === 0) {
    const picked = uniqueBest(neutral);
    if (picked) return picked;
  }

  // tools/ 里完全没有候选时，最后才尝试 PATH（仍要求可执行）。
  if (found.size === 0) {
    const probe = spawnSync("minisign", ["-v"], { encoding: "utf8" });
    if (probe.status === 0) return "minisign";
  }
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
    if (run.error) console.error(`  工具无法执行：${run.error.message}`);
    if (output.trim()) console.error(output.trim().split("\n").slice(0, 6).join("\n"));
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
