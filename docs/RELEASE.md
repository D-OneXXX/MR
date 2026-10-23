# 发布与自动更新签名

> 适用版本：`0.16.0` 起。官方更新通道使用 Tauri 2 Updater + GitHub Releases
> `latest.json`；原有自定义补丁通道继续保留，两者互不绕过签名校验。

## 1. 已配置内容

- `src-tauri/tauri.conf.json`
  - `bundle.createUpdaterArtifacts: true`
  - `bundle.fileAssociations`：`.cbz` / `.zip`
  - `plugins.updater.pubkey`：本仓库对应的 minisign 公钥
  - `plugins.updater.endpoints`：
    `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json`
- `src-tauri/capabilities/updater.json`：仅主窗获得 `updater:default`；
  重启走自研 `restart_app`，**没有** `process:*` 权限。
- `.github/workflows/release.yml`：推送 `v*` 标签时构建 NSIS 安装包、
  签名更新包并生成/上传 `latest.json`。
- 客户端入口：「设置 → 关于与维护 → GitHub 自动更新」。手动检查，
  不自动轮询、不自动重启。

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
   git tag v0.16.0
   git push origin v0.16.0
   ```

4. `.github/workflows/release.yml` 会：
   - 校验 tag 与 `package.json` 版本一致；
   - `npm ci` + Tauri 构建（`--bundles nsis`）；
   - 用 Secrets 中的私钥签名更新包；
   - 通过 `tauri-action@v1` 创建**已发布**的 GitHub Release，并上传
     `latest.json` 与安装包。

5. 验证：
   - Release 资源中存在 `latest.json` 与 `.nsis.zip` / `.sig`；
   - `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json` 可直接访问；
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
