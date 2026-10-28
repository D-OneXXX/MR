import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_RELEASE_BODY,
  renderGithubOutput,
  resolveReleaseBody,
  writeReleaseBody,
} from "./release-notes.mjs";

/** 解析单条多行 GITHUB_OUTPUT，验证分隔符格式可被 Actions 还原。 */
function parseBodyOutput(text) {
  const lines = text.split("\n");
  assert.match(lines[0], /^body<<.+$/);
  const delimiter = lines[0].slice("body<<".length);
  const end = lines.lastIndexOf(delimiter);
  assert.ok(end > 0, "缺少结束分隔符");
  return lines.slice(1, end).join("\n");
}

test("release-notes：空输入 / 纯空白回落占位文案", () => {
  for (const value of [undefined, "", "   ", "\r\n\t "]) {
    assert.equal(resolveReleaseBody(value), DEFAULT_RELEASE_BODY);
  }
  assert.match(DEFAULT_RELEASE_BODY, /Draft/);
  assert.match(DEFAULT_RELEASE_BODY, /rc-record\.json/);
});

test("release-notes：多行输入原样保留（不经过 YAML 块标量）", () => {
  const notes = "## Moyu 0.18.0\n\n- PDF 阅读\n- 数据库自检\n\n> 升级前请备份";
  assert.equal(resolveReleaseBody(notes), notes);
  const rendered = renderGithubOutput(notes);
  assert.equal(parseBodyOutput(rendered), notes);
});

test("release-notes：CRLF 归一为 LF，特殊字符不被解释", () => {
  const notes = "第一行\r\n第二行 ${{ secrets.TOKEN }} %PATH% \"quoted\" `tick`";
  const expected = "第一行\n第二行 ${{ secrets.TOKEN }} %PATH% \"quoted\" `tick`";
  assert.equal(resolveReleaseBody(notes), expected);
  assert.equal(parseBodyOutput(renderGithubOutput(resolveReleaseBody(notes))), expected);
});

test("release-notes：writeReleaseBody 追加到 GITHUB_OUTPUT 并可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-release-notes-"));
  const output = path.join(dir, "github_output");
  const notes = "line-1\nline-2\nline-3";
  const body = writeReleaseBody(notes, { outputPath: output });
  assert.equal(body, notes);
  const text = fs.readFileSync(output, "utf8");
  assert.equal(parseBodyOutput(text), notes);
  // 追加而不是覆盖：第二次写入后两条 output 都在。
  writeReleaseBody("second", { outputPath: output });
  const appended = fs.readFileSync(output, "utf8");
  assert.ok(appended.includes("second"));
  assert.equal((appended.match(/^body<</gm) || []).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
