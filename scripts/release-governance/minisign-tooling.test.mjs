/**
 * 发布工具链回归测试：官方 minisign 的**下载 → 解压 → 定位**三段都必须可靠。
 *
 * 背景：Phase 5 实测发现两处会让发布流水线（windows-2022）**必然失败**的缺陷：
 * 1. 压缩包临时文件没有 `.zip` 扩展名 → PowerShell `Expand-Archive` 抛
 *    NotSupportedArchiveFileExtension → minisign 永远装不上；
 * 2. `verify-signature.mjs` 只在 `tools/minisign/minisign.exe` 查找，而官方包
 *    解压后实际位于 `tools/minisign/minisign-win64/x86_64/minisign.exe`
 *    → 验签步骤报「找不到 minisign」。
 *
 * 两个缺陷都不会被发布门禁自己发现（它们在门禁之前就崩了），因此必须单测锁死。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveArchiveName } from "./fetch-minisign.mjs";
import { findMinisign } from "./verify-signature.mjs";

test("压缩包文件名必须保留真实扩展名（Expand-Archive 只接受 .zip）", () => {
  assert.equal(
    resolveArchiveName(
      "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip",
      "win64",
    ),
    "minisign-0.12-win64.zip",
  );
  assert.equal(
    resolveArchiveName(
      "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-linux.tar.gz",
      "linux",
    ),
    "minisign-0.12-linux.tar.gz",
  );
  // URL 没有扩展名时也必须给出可解压的扩展名。
  assert.match(resolveArchiveName("https://example.invalid/minisign", "win64"), /\.zip$/);
  assert.match(resolveArchiveName("https://example.invalid/minisign", "linux"), /\.tar\.gz$/);
});

test("minisign 定位必须覆盖官方包的嵌套解压布局", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-minisign-locate-"));
  try {
    const nested = path.join(root, "tools", "minisign", "minisign-win64", "x86_64");
    fs.mkdirSync(nested, { recursive: true });
    const binary = path.join(nested, "minisign.exe");
    fs.writeFileSync(binary, "fake-minisign");
    assert.equal(findMinisign(root), binary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("minisign 定位：扁平布局仍可用（向后兼容）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-minisign-flat-"));
  try {
    const dir = path.join(root, "tools", "minisign");
    fs.mkdirSync(dir, { recursive: true });
    const binary = path.join(dir, "minisign.exe");
    fs.writeFileSync(binary, "fake-minisign");
    assert.equal(findMinisign(root), binary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("minisign 定位：环境变量优先", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-minisign-env-"));
  const custom = path.join(root, "custom-minisign.exe");
  try {
    fs.writeFileSync(custom, "fake-minisign");
    process.env.MR_MINISIGN_BIN = custom;
    assert.equal(findMinisign(root), custom);
  } finally {
    delete process.env.MR_MINISIGN_BIN;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("minisign 定位：必须优先宿主架构（选到 aarch64 会静默拿不到可执行结果）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-minisign-arch-"));
  try {
    const armDir = path.join(root, "tools", "minisign", "minisign-win64", "aarch64");
    const x64Dir = path.join(root, "tools", "minisign", "minisign-win64", "x86_64");
    fs.mkdirSync(armDir, { recursive: true });
    fs.mkdirSync(x64Dir, { recursive: true });
    const arm = path.join(armDir, "minisign.exe");
    const x64 = path.join(x64Dir, "minisign.exe");
    fs.writeFileSync(arm, "fake-minisign-arm");
    fs.writeFileSync(x64, "fake-minisign-x64");
    assert.equal(findMinisign(root), x64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
