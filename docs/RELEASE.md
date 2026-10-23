# 发布与自动更新签名

> 适用版本：`0.17.0` 起。官方更新通道使用 Tauri 2 Updater + GitHub Releases；
> **双通道拆分**：Windows 常规通道走 `latest.json`，Linux 长期稳定分支只接收
> 高危安全/崩溃补丁，走 `latest-linux-critical.json`（平台专属配置
> `src-tauri/tauri.linux.conf.json` 覆盖端点）。原有自定义补丁通道继续保留，
> 两者互不绕过签名校验。

## 1. 已配置内容

- `src-tauri/tauri.conf.json`
  - `bundle.targets: ["nsis", "deb", "rpm", "appimage"]`；Windows 只发布 NSIS，
    不再产出 MSI
  - `bundle.windows.nsis`：`installMode: "both"`、`compression: "lzma"`、
    `displayLanguageSelector: true`，六种安装向导语言
    `SimpChinese / TradChinese / English / Spanish / Japanese / Korean`
  - `bundle.fileAssociations`：`.cbz` / `.zip`
  - `plugins.updater.pubkey`：本仓库对应的 minisign 公钥
  - `plugins.updater.endpoints`（Windows 常规通道）：
    `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json`
  - `src-tauri/tauri.linux.conf.json`（Linux 高危补丁通道）：
    端点覆盖为 `.../latest-linux-critical.json`
  - `plugins.updater.windows.installMode: "passive"`
- **升级身份**：`productName`、`identifier` 与主程序名必须保持稳定；NSIS 升级键、
  桌面快捷方式与 `.cbz` 关联都依赖它们。不要为了改品牌名而直接修改；
  如需改名，必须设计迁移方案并重新验证升级继承。
- **构建来源指纹（Build Origin）**：官方流水线注入 `MR_BUILD_ORIGIN=official`，
  本地/社区构建默认按 `community` 展示（设置 → 关于与维护 + 诊断快照）。
- `src-tauri/capabilities/updater.json`：仅主窗获得 `updater:default`；
  重启走自研 `restart_app`，**没有** `process:*` 权限。
- **CI 双流水线（互不阻塞）**：
  - `.github/workflows/release-windows.yml`：`v*` 标签（排除 `-linux*`）→
    仅 `windows-latest` 构建 NSIS + 签名 + 上传 `latest.json`（tauri-action），
    并把上一版 Release 里的 `latest-linux-critical.json` 接力携带到新 Release
    （保证 `releases/latest/download/...` 双通道 URL 永远可用）。
  - `.github/workflows/release-linux-critical.yml`：`v*-linux-sec*` 标签或手动
    `workflow_dispatch` → `ubuntu-22.04` 构建 deb/rpm/AppImage，
    `scripts/make-linux-critical-manifest.mjs` 生成
    `latest-linux-critical.json`（AppImage + minisign 签名），同样把
    `latest.json` 接力携带。
  - `.github/workflows/ci-linux-check.yml`：PR/推送时 Linux cfg 块编译检查。
- **社区构建**：`npm run build:community`（无 `TAURI_SIGNING_PRIVATE_KEY` 时自动
  覆盖 `createUpdaterArtifacts=false` 并标记 `MR_BUILD_ORIGIN=community`），
  见 `NOTICE.md` 与 `docs/TECHNICAL.md`。
- 客户端入口：「设置 → 关于与维护 → GitHub 自动更新」。手动检查，
  不自动轮询、不自动重启。Linux 端面板常驻提示「长期稳定分支，仅推送高危
  安全与崩溃修复补丁」。

## 2. 本机密钥位置（不入库）

生成时私钥放在仓库外：

```
%USERPROFILE%\.mangareader-updater\updater.key
%USERPROFILE%\.mangareader-updater\updater.key.pub
%USERPROFILE%\.mangareader-updater\password.txt
```

- `updater.key.pub` 的内容已经写入 `tauri.conf.json` 的 `pubkey`；
- `updater.key` 是私钥，`password.txt` 是私钥口令；
- **绝不要把这两个文件复制进仓库、Issue、日志或聊天记录**；
- 若本机目录丢失，必须重新生成密钥对、更新 `pubkey`，并同步更新 GitHub Secrets；
  旧私钥无法为新的公钥签名，更新会全部失败。

## 3. GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `updater.key` 的完整文本内容（不是路径） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `password.txt` 的完整内容 |

`GITHUB_TOKEN` 由 Actions 自动提供，不需要手动添加。

## 4. 发布步骤

1. 修改版本（单一事实源为 `package.json`）：

   ```bat
   npm run version:sync -- 0.16.0
   npm run version:check
   npm run test:version
   ```

2. 本地验证：

   ```bat
   npx tsc --noEmit
   cd src-tauri && cargo test --lib && cargo check && cd ..
   npm run build
   node tests\qa\run-qa.mjs --suite=static
   ```

3. 提交并推送 `main`，然后打标签：

   ```bat
   git tag v0.17.0
   git push origin v0.17.0
   ```

4. `.github/workflows/release-windows.yml` 会：
   - 校验 tag 与 `package.json` 版本一致（`-linux*` 标签自动跳过）；
   - `npm ci` + Tauri 构建（`--bundles nsis`，注入 `MR_BUILD_ORIGIN=official`）；
   - 用 Secrets 中的私钥签名更新包；
   - 通过 `tauri-action@v1` 创建**已发布**的 GitHub Release，并上传
     `latest.json` 与安装包；
   - 接力携带上一版 Release 的 `latest-linux-critical.json`。

5. **Linux 高危补丁发布**（仅安全/崩溃级修复，先同步 `package.json` 到补丁版本）：

   ```bat
   npm run version:sync -- 0.17.1
   :: 提交后：
   git tag v0.17.1-linux-sec1
   git push origin v0.17.1-linux-sec1
   ```

   `.github/workflows/release-linux-critical.yml` 在 `ubuntu-22.04` 构建
   deb/rpm/AppImage，生成并上传 `latest-linux-critical.json`（也接力携带
   `latest.json`）。也可在 Actions 页面手动 `workflow_dispatch` 指定标签。

6. 验证：
   - Windows Release 资源中存在 `latest.json` 与 `.nsis.zip` / `.sig`；
   - Linux 补丁 Release 资源中存在 `latest-linux-critical.json` 与
     `.AppImage` / `.AppImage.sig`；
   - `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json` 与
     `.../latest-linux-critical.json` 均可直接访问（双通道接力保证）；
   - 安装上一版本，打开「设置 → 关于与维护 → GitHub 自动更新」检查并安装；
   - 安装完成后按提示重启（Windows 安装器会自动退出/重启，属于用户点击后的预期行为）。

## 5. 更新失败的常见原因

- `latest.json` 不在**最新已发布** Release 中（草稿/Draft 不可被 `releases/latest` 访问）；
- tag 版本与 `package.json` 不一致，工作流在构建前失败；
- GitHub Secrets 缺失/私钥口令错误，签名产物缺失；
- 客户端 `pubkey` 与 CI 私钥不匹配；
- 资产名/平台键与 `latest.json` 不一致（保留 `--bundles nsis` 与
  `updaterJsonPreferNsis: true` 可避免大多数问题）。

## 6. 自定义补丁通道

`src-tauri/src/update.rs` 的清单/补丁通道仍使用构建期 `MR_UPDATE_PUBKEY`。
如果同时维护两条通道，必须保证各自的公钥/私钥对应关系独立且可追溯；
官方通道的私钥不能提交到仓库，也不能写入前端或日志。
