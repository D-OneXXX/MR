#!/usr/bin/env node
/**
 * Linux 干净环境安装验证的候选输入绑定。
 *
 * 与 Windows 的 `prepare-candidate.mjs` 同职责、同严格度：从 Draft 的
 * `rc-record.json` 出发，校验 tag / Commit / 版本 / 通道 / 平台以及每个制品的
 * 名称、大小与 SHA-256，并确定**安装验证回执必须绑定的主制品**（deb）。
 *
 * 为什么主制品固定为 deb：Linux 发布通道以 deb/rpm 系统安装、AppImage 便携运行；
 * 安装验证实际执行的是 `apt-get install ./*.deb`，发布前另用 AppImage 验签。
 * 主制品不能依赖目录字母序（rpm 会排在 deb 之前），否则回执会绑定到未安装的包。
 *
 * 用法：
 *   node scripts/release-smoke/prepare-candidate-linux.mjs \
 *     --record candidate/rc-record.json --assets-dir candidate \
 *     --tag v0.18.0-linux-sec1 --expected-commit <40-hex> --out candidate-meta/candidate.json
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { sha256File } from "./prepare-candidate.mjs";

export { sha256File };

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const LINUX_TAG = /^v(\d+\.\d+\.\d+)-linux-sec(\d+)$/;
const MANIFEST = "latest-linux-critical.json";

function problemsForArtifact(artifact, assetsDir) {
  const problems = [];
  if (!artifact || typeof artifact !== "object") return ["RC 记录包含空的制品项"];
  if (!artifact.name) return ["RC 记录中的制品缺少 name"];
  const file = path.join(assetsDir, artifact.name);
  if (!fs.existsSync(file)) return [`Draft 缺少制品文件：${artifact.name}`];
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

function exactlyOne(artifacts, pattern, label) {
  const matches = artifacts.filter(
    (item) => typeof item?.name === "string" && pattern.test(item.name),
  );
  return {
    item: matches.length === 1 ? matches[0] : null,
    problem:
      matches.length === 1
        ? null
        : `RC 记录必须且只能包含一个 ${label}，实际 ${matches.length}`,
  };
}

/**
 * @returns {{ok:boolean, problems:string[], candidate:object|null}}
 */
export function validateLinuxCandidateInput({
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
  const tagMatch = String(tag || "").match(LINUX_TAG);
  if (!tagMatch) {
    problems.push(`候选标签必须是 vX.Y.Z-linux-secN：${String(tag)}`);
  }
  if (record.tag !== tag) {
    problems.push(`RC 记录 tag 与请求不一致：记录=${record.tag} 请求=${tag}`);
  }
  if (record.channel !== "linux-critical") {
    problems.push(`RC 记录通道必须是 linux-critical：${String(record.channel)}`);
  }
  if (record.platform !== "linux-x86_64") {
    problems.push(`RC 记录平台必须是 linux-x86_64：${String(record.platform)}`);
  }
  if (!SEMVER.test(String(record.version || ""))) {
    problems.push(`RC 记录版本非法：${String(record.version)}`);
  } else {
    if (tagMatch && tagMatch[1] !== record.version) {
      problems.push(`标签基础版本与记录不一致：标签=${tagMatch[1]} 记录=${record.version}`);
    }
    if (String(tag) !== `v${record.version}-linux-sec${tagMatch?.[2] ?? "?"}`) {
      problems.push(`标签与版本不一致：${tag} vs v${record.version}-linux-secN`);
    }
  }
  const commit = String(record.commit || "");
  if (!HEX40.test(commit)) problems.push(`RC 记录 Commit 非法：${commit}`);
  const expected = String(expectedCommit || "");
  if (!HEX40.test(expected)) {
    problems.push(`--expected-commit 非法：${expected}`);
  } else if (commit !== expected) {
    problems.push(`RC 记录 Commit 与标签 Commit 不一致：记录=${commit} 标签=${expected}`);
  }

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  if (artifacts.length === 0) problems.push("RC 记录没有任何制品");

  const deb = exactlyOne(artifacts, /\.deb$/i, "deb 系统安装包");
  const rpm = exactlyOne(artifacts, /\.rpm$/i, "rpm 系统安装包");
  const appImage = exactlyOne(artifacts, /\.AppImage$/i, "AppImage 便携包");
  if (deb.problem) problems.push(deb.problem);
  if (rpm.problem) problems.push(rpm.problem);
  if (appImage.problem) problems.push(appImage.problem);

  const signature = appImage.item
    ? artifacts.find((item) => item?.name === `${appImage.item.name}.sig`) || null
    : null;
  if (!signature) problems.push("RC 记录缺少 AppImage 对应的 .sig 制品");

  const manifest = artifacts.find((item) => item?.name === MANIFEST) || null;
  if (!manifest) problems.push(`RC 记录缺少 ${MANIFEST} 更新清单`);

  for (const artifact of artifacts) {
    problems.push(...problemsForArtifact(artifact, assetsDir));
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
      // 安装验证实际安装的主制品。
      artifactName: deb.item.name,
      artifactSha256: String(deb.item.sha256).toLowerCase(),
      artifactSize: Number(deb.item.size),
      appImageName: appImage.item.name,
      appImageSha256: String(appImage.item.sha256).toLowerCase(),
      rpmName: rpm.item.name,
      rpmSha256: String(rpm.item.sha256).toLowerCase(),
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
      console.error(`[prepare-candidate-linux] 缺少参数 --${key}`);
      return 2;
    }
  }
  if (!fs.existsSync(args.record)) {
    console.error(`[prepare-candidate-linux] 找不到 RC 记录：${args.record}`);
    return 2;
  }
  if (!fs.existsSync(args["assets-dir"])) {
    console.error(`[prepare-candidate-linux] 找不到资产目录：${args["assets-dir"]}`);
    return 2;
  }
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(args.record, "utf8"));
  } catch (error) {
    console.error(`[prepare-candidate-linux] RC 记录不是合法 JSON：${error.message}`);
    return 2;
  }
  const result = validateLinuxCandidateInput({
    record,
    recordPath: args.record,
    assetsDir: args["assets-dir"],
    tag: args.tag,
    expectedCommit: args["expected-commit"],
  });
  if (!result.ok) {
    console.error("[prepare-candidate-linux] 候选输入绑定失败（拒绝安装）：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    return 1;
  }
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  }
  console.log(
    `[prepare-candidate-linux] OK ${result.candidate.tag}@${result.candidate.commit.slice(0, 12)} ` +
      `installer=${result.candidate.artifactName} sha256=${result.candidate.artifactSha256}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}
