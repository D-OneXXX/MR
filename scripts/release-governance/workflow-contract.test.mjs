import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
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

test("release-candidate：候选阶段产出并回填 signature-verification.json", () => {
  const source = workflow("release-candidate.yml");
  const rc = source.indexOf("Build and upload RC record");
  const verify = source.indexOf("Verify candidate signature");
  assert.ok(rc >= 0, "缺少 RC 记录步骤");
  assert.ok(verify > rc, "签名验证必须位于 RC 记录之后");
  for (const marker of [
    "scripts/release-governance/fetch-minisign.mjs",
    "scripts/release-governance/verify-signature.mjs",
    "mr-signature-evidence",
    "configured.pub",
    "--platform windows-x86_64",
    '--out "$EVIDENCE_DIR/signature-verification.json"',
    'gh release upload "$TAG" "$EVIDENCE_DIR/signature-verification.json" --clobber',
  ]) {
    assert.ok(source.includes(marker), `缺少签名证据标记：${marker}`);
  }
  // 公钥必须从仓库当前 tauri.conf.json 派生，而不是外部输入。
  assert.ok(source.includes("src-tauri/tauri.conf.json"));
  assert.ok(source.includes("plugins.updater.pubkey"));
  assert.ok(source.includes("contents: write"));
  assert.ok(!source.includes("permissions: write-all"));
});

test("release-candidate：release_notes 输入为空时回落占位文案，多行走 step output", () => {
  const source = workflow("release-candidate.yml");
  const notes = inputBlock(source, "release_notes");
  assert.match(notes, /required:\s*false/);
  assert.match(notes, /type:\s*string/);
  assert.ok(source.includes("scripts/release-governance/release-notes.mjs"));
  assert.ok(source.includes("releaseBody: ${{ steps.notes.outputs.body }}"));
  assert.ok(source.includes("RELEASE_NOTES: ${{ inputs.release_notes }}"));
});

test("release-install-verify：previous_tag/previous_version 无版本默认值且失败关闭", () => {
  const source = workflow("release-install-verify.yml");
  for (const name of ["tag", "previous_tag", "previous_version"]) {
    const block = inputBlock(source, name);
    assert.match(block, /required:\s*true/, `${name} 必须必填`);
    assert.ok(!/^\s*default:/m.test(block), `${name} 不得有版本特定默认值`);
  }
  for (const marker of [
    'if [ "$PREVIOUS_TAG" = "$TAG" ]',
    "'^0\\.[0-9]+\\.[0-9]+$'",
    'if [ "v${PREVIOUS_VERSION}" != "$PREVIOUS_TAG" ]',
    "MangaReader_${PREVIOUS_VERSION}_x64-setup.exe",
  ]) {
    assert.ok(source.includes(marker), `缺少升级基线校验：${marker}`);
  }
  const validate = source.indexOf("Validate previous release inputs");
  const download = source.indexOf("Download previous installer");
  assert.ok(validate >= 0 && validate < download, "基线校验必须先于下载旧安装包");
});

test("release-install-verify：只回填通过总闸且哈希一致的那一份安装证据", () => {
  const source = workflow("release-install-verify.yml");
  for (const marker of [
    "Attach verified install evidence to Draft",
    'BEFORE="$(sha256 "$SRC")"',
    'AFTER="$(sha256 "$STAGE/install-verification.json")"',
    'if [ "$BEFORE" != "$AFTER" ]',
    'gh release upload "$TAG" "$STAGE/install-verification.json" --clobber',
  ]) {
    assert.ok(source.includes(marker), `缺少证据回填标记：${marker}`);
  }
  const uploads = [...source.matchAll(/^\s+gh release upload/gm)];
  assert.equal(uploads.length, 1, "只允许一次 gh release upload");
  assert.ok(!/gh release\s+(edit|delete)/.test(source), "不得修改/删除 Release");
  // 回填必须在证据总闸之后。
  const gate = source.indexOf("verify-evidence.mjs");
  const attach = source.indexOf("Attach verified install evidence to Draft");
  assert.ok(gate >= 0 && attach > gate, "回填必须位于 verify-evidence 之后");
});

test("候选容器：RC 记录排除治理文件（Windows 与 Linux 一致）", () => {
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const source = workflow(name);
    assert.ok(source.includes("collectCandidateArtifacts"), `${name} 必须使用统一制品收集器`);
    assert.ok(!source.includes('n !== "rc-record.json"'), `${name} 仍只排除单一治理文件`);
  }
});

test("发布接力：只从已公开且非预发布的 Release 携带另一通道清单", () => {
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    assert.ok(
      source.includes("select(.draft == false and .prerelease == false)"),
      `${name} 的清单接力必须排除 Draft / 预发布`,
    );
    assert.ok(!source.includes("--jq '.[].tag_name'"), `${name} 仍会从 Draft 接力清单`);
  }
});

test("候选通道：已公开的 Release 不得被候选流程覆盖（Windows 与 Linux 一致）", () => {
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const source = workflow(name);
    assert.ok(
      source.includes('gh release view "$TAG" --json isDraft'),
      `${name} 必须先判定目标 Release 是否仍是 Draft`,
    );
  }
  // Windows 候选由 tauri-action 承担「创建/更新 Release」，目标 tag 已是公开
  // Release 时它会直接改写已发布资产，因此必须显式失败关闭。
  const windows = workflow("release-candidate.yml");
  assert.ok(
    windows.includes("Refuse to touch a published release"),
    "release-candidate.yml 必须显式拒绝改写已公开发布的 Release",
  );
  assert.ok(
    /已经公开发布[\s\S]{0,400}exit 1/.test(windows),
    "release-candidate.yml 的拒绝分支必须失败关闭（exit 1）",
  );
});

test("发布通道：干净环境证据必须来自 GitHub-hosted（Windows 与 Linux 一致）", () => {
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    const verifyAt = source.indexOf("verify-provenance.mjs");
    assert.ok(verifyAt >= 0, `${name} 必须在线核验安装证据 provenance`);
    assert.ok(
      source.slice(verifyAt, verifyAt + 400).includes("--require-github-actions"),
      `${name} 的 provenance 核验必须要求 GitHub-hosted 干净环境，不得接受自述的本地 VM`,
    );
  }
});
