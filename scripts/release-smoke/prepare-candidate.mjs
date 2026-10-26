#!/usr/bin/env node
/**
 * 干净 VM 安装验证的候选输入绑定：
 * 从 Draft 的 `rc-record.json` 出发，校验 tag / Commit / 版本 / 每个制品
 * （安装包、签名、更新清单）的名称、大小与 SHA-256，输出一个供安装脚本使用
 * 的 `candidate.json`。任何一项不一致即拒绝，绝不“先装了再说”。
 *
 * 用法：
 *   node scripts/release-smoke/prepare-candidate.mjs \
 *     --record candidate/rc-record.json --assets-dir candidate \
 *     --tag v0.17.2 --expected-commit <40-hex> --out candidate/candidate.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const TAG = /^v\d+\.\d+\.\d+$/;

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function problemsForArtifact(record, artifact, assetsDir) {
  const problems = [];
  if (!artifact || typeof artifact !== "object") return ["RC 记录包含空的制品项"];
  if (!artifact.name) return ["RC 记录中的制品缺少 name"];
  const file = path.join(assetsDir, artifact.name);
  if (!fs.existsSync(file)) {
    return [`Draft 缺少制品文件：${artifact.name}`];
  }
  const actualSha = sha256File(file);
  const actualSize = fs.statSync(file).size;
  if (!HEX64.test(String(artifact.sha256 || ""))) {
    problems.push(`RC 记录的 ${artifact.name} 缺少合法 sha256`);
  } else if (actualSha !== String(artifact.sha256).toLowerCase()) {
    problems.push(
      `制品 SHA-256 与 RC 记录不一致：${artifact.name} 记录=${artifact.sha256} 实际=${actualSha}`,
    );
  }
  if (Number(artifact.size) !== actualSize) {
    problems.push(
      `制品大小与 RC 记录不一致：${artifact.name} 记录=${artifact.size} 实际=${actualSize}`,
    );
  }
  return problems;
}

/**
 * @returns {{ok:boolean, problems:string[], candidate:object|null}}
 */
export function validateCandidateInput({
  record,
  recordPath,
  assetsDir,
  tag,
  expectedCommit,
}) {
  const problems = [];
  if (!record || typeof record !== "object") {
    return { ok: false, problems: ["RC 记录缺失或不是 JSON 对象"], candidate: null };
  }
  if (record.kind !== "manga-reader.release-candidate") {
    problems.push(`RC 记录 kind 非法：${String(record.kind)}`);
  }
  if (record.rehearsal !== false) {
    problems.push("演练候选（rehearsal）不得用于正式安装验证");
  }
  if (!TAG.test(String(tag || ""))) {
    problems.push(`候选标签非法：${String(tag)}`);
  }
  if (record.tag !== tag) {
    problems.push(`RC 记录 tag 与请求不一致：记录=${record.tag} 请求=${tag}`);
  }
  if (record.channel !== "windows") {
    problems.push(`RC 记录通道必须是 windows：${String(record.channel)}`);
  }
  if (record.platform !== "windows-x86_64") {
    problems.push(`RC 记录平台必须是 windows-x86_64：${String(record.platform)}`);
  }
  if (!SEMVER.test(String(record.version || ""))) {
    problems.push(`RC 记录版本非法：${String(record.version)}`);
  } else if (String(tag) !== `v${record.version}`) {
    problems.push(`标签与版本不一致：${tag} vs v${record.version}`);
  }
  const commit = String(record.commit || "");
  if (!HEX40.test(commit)) {
    problems.push(`RC 记录 Commit 非法：${commit}`);
  }
  const expected = String(expectedCommit || "");
  if (!HEX40.test(expected)) {
    problems.push(`--expected-commit 非法：${expected}`);
  } else if (commit !== expected) {
    problems.push(`RC 记录 Commit 与标签 Commit 不一致：记录=${commit} 标签=${expected}`);
  }

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  if (artifacts.length === 0) {
    problems.push("RC 记录没有任何制品");
  }
  const installerArtifacts = artifacts.filter(
    (artifact) =>
      typeof artifact?.name === "string" &&
      /\.exe$/i.test(artifact.name) &&
      !/\.sig$/i.test(artifact.name),
  );
  if (installerArtifacts.length !== 1) {
    problems.push(
      `RC 记录必须且只能包含一个 Windows 安装包，实际 ${installerArtifacts.length}`,
    );
  }
  const installer = installerArtifacts[0] || null;
  const signature = installer
    ? artifacts.find((artifact) => artifact?.name === `${installer.name}.sig`)
    : null;
  if (!signature) {
    problems.push("RC 记录缺少安装包对应的 .sig 制品");
  }
  const manifest = artifacts.find((artifact) => artifact?.name === "latest.json") || null;
  if (!manifest) {
    problems.push("RC 记录缺少 latest.json 更新清单");
  }

  for (const artifact of artifacts) {
    problems.push(...problemsForArtifact(record, artifact, assetsDir));
  }
  if (problems.length > 0) {
    return { ok: false, problems, candidate: null };
  }

  const recordSha256 = recordPath && fs.existsSync(recordPath) ? sha256File(recordPath) : "";
  if (!HEX64.test(recordSha256)) {
    problems.push(`RC 记录文件本身缺少可计算的 SHA-256：${recordPath}`);
    return { ok: false, problems, candidate: null };
  }
  return {
    ok: true,
    problems: [],
    candidate: {
      version: record.version,
      commit: record.commit,
      tag: record.tag,
      artifactName: installer.name,
      artifactSha256: String(installer.sha256).toLowerCase(),
      artifactSize: Number(installer.size),
      signatureName: signature.name,
      signatureSha256: String(signature.sha256).toLowerCase(),
      manifestName: manifest.name,
      manifestSha256: String(manifest.sha256).toLowerCase(),
      recordSha256,
      assetsDir: path.resolve(assetsDir),
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const key of ["record", "assets-dir", "tag", "expected-commit"]) {
    if (!args[key]) {
      console.error(`[prepare-candidate] 缺少参数 --${key}`);
      return 2;
    }
  }
  if (!fs.existsSync(args.record)) {
    console.error(`[prepare-candidate] 找不到 RC 记录：${args.record}`);
    return 2;
  }
  if (!fs.existsSync(args["assets-dir"])) {
    console.error(`[prepare-candidate] 找不到资产目录：${args["assets-dir"]}`);
    return 2;
  }
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(args.record, "utf8"));
  } catch (error) {
    console.error(`[prepare-candidate] RC 记录不是合法 JSON：${error.message}`);
    return 2;
  }
  const result = validateCandidateInput({
    record,
    recordPath: args.record,
    assetsDir: args["assets-dir"],
    tag: args.tag,
    expectedCommit: args["expected-commit"],
  });
  if (!result.ok) {
    console.error("[prepare-candidate] 候选输入绑定失败（拒绝安装）：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  }
  console.log(
    `[prepare-candidate] OK ${result.candidate.tag}@${result.candidate.commit.slice(0, 12)} ` +
      `installer=${result.candidate.artifactName} sha256=${result.candidate.artifactSha256}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
