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
