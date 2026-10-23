#!/usr/bin/env node
/**
 * 社区构建入口（Community Build Fallback）
 *
 * 第三方开发者拉取 Linux 分支源码本地修改后，没有官方
 * TAURI_SIGNING_PRIVATE_KEY。`bundle.createUpdaterArtifacts: true` 在缺失
 * 私钥时会让 `tauri build` 直接失败。本脚本：
 * - 未检测到签名私钥时，生成 `src-tauri/tauri.community.json` 覆盖层，
 *   把 createUpdaterArtifacts 置为 false，一键产出本地 deb/rpm/AppImage；
 * - 注入 MR_BUILD_ORIGIN=community，使关于页与诊断快照显示
 *   `Community Modified Build (Non-Commercial)`；
 * - 已配置官方私钥时直接走官方构建路径（并提示）。
 *
 * 用法：npm run build:community [-- 透传给 tauri build 的参数]
 *   例：npm run build:community -- --bundles appimage
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const overlayPath = path.join(root, "src-tauri", "tauri.community.json");

const hasSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());
const passthrough = process.argv.slice(2);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, env) => {
  const result = spawnSync(npm, args, {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  return result.status === 0;
};

let ok = true;
try {
  if (hasSigningKey) {
    console.log("[build:community] 检测到官方签名私钥，走官方构建路径（社区覆盖层不生效）。");
    ok = run(["run", "tauri", "--silent", "--", "build", ...passthrough], {
      MR_BUILD_ORIGIN: "official",
    });
  } else {
    console.log(
      "[build:community] 未检测到 TAURI_SIGNING_PRIVATE_KEY：关闭 updater 产物生成（社区构建，不发布官方更新签名）。",
    );
    fs.writeFileSync(
      overlayPath,
      `${JSON.stringify({ bundle: { createUpdaterArtifacts: false } }, null, 2)}\n`,
      "utf8",
    );
    ok = run(
      [
        "run",
        "tauri",
        "--silent",
        "--",
        "build",
        "--config",
        "src-tauri/tauri.community.json",
        ...passthrough,
      ],
      { MR_BUILD_ORIGIN: "community" },
    );
  }
} finally {
  // 覆盖层是临时产物，无论成败都清理；tauri.community.json 已在 .gitignore。
  try {
    fs.rmSync(overlayPath, { force: true });
  } catch {
    /* 清理失败不影响构建结果 */
  }
}

process.exit(ok ? 0 : 1);
