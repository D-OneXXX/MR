import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { globToRegExp, resolveDraftAsset } from "./resolve-draft-asset.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "resolve-draft-asset.mjs");

function withAssets(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-draft-asset-"));
  try {
    for (const name of files) fs.writeFileSync(path.join(dir, name), "x", "utf8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("glob 转正则：只把 * 与 ? 当通配符，其余按字面量", () => {
  assert.ok(globToRegExp("*.exe").test("MangaReader_0.19.0_x64-setup.exe"));
  assert.ok(!globToRegExp("*.exe").test("MangaReader_0.19.0_x64-setup.exe.sig"));
  assert.ok(globToRegExp("*.exe.sig").test("a.exe.sig"));
  assert.ok(!globToRegExp("*.exe").test("readme.md"));
  assert.ok(globToRegExp("a+b?.txt").test("a+b1.txt"));
});

test("缺少安装包必须失败并说清缺什么", () => {
  withAssets(["rc-record.json"], (dir) => {
    const result = resolveDraftAsset({ dir, pattern: "*.exe", label: "安装包" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /缺少安装包/);
    assert.match(result.reason, /无结果/);
  });
});

test("唯一命中时返回该文件", () => {
  withAssets(["MangaReader_0.19.0_x64-setup.exe", "rc-record.json"], (dir) => {
    const result = resolveDraftAsset({ dir, pattern: "*.exe", label: "安装包" });
    assert.equal(result.ok, true);
    assert.ok(result.file.endsWith("MangaReader_0.19.0_x64-setup.exe"));
  });
});

test("命中多个时失败并说明歧义（不得随意挑一个验签）", () => {
  withAssets(["a.exe", "b.exe"], (dir) => {
    const result = resolveDraftAsset({ dir, pattern: "*.exe", label: "安装包" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /2 个安装包/);
    assert.match(result.reason, /无法确定/);
  });
});

test("目录不存在时失败并给出原因", () => {
  const result = resolveDraftAsset({ dir: "no-such-dir", pattern: "*.exe", label: "安装包" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /无法读取资产目录/);
});

test("CLI：缺件退出 2 且给出可读原因；命中时输出路径并退出 0", () => {
  withAssets(["rc-record.json"], (dir) => {
    const missing = spawnSync(
      process.execPath,
      [SCRIPT, "--dir", dir, "--pattern", "*.exe", "--label", "安装包"],
      { encoding: "utf8" },
    );
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /缺少安装包/);
    assert.doesNotMatch(missing.stderr, /node:internal|\n\s+at /);
  });

  withAssets(["MangaReader_0.19.0_x64-setup.exe"], (dir) => {
    const ok = spawnSync(
      process.execPath,
      [SCRIPT, "--dir", dir, "--pattern", "*.exe", "--label", "安装包"],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /MangaReader_0\.19\.0_x64-setup\.exe/);
  });
});
