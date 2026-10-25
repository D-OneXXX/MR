# 发布与自动更新签名

> 适用版本：`0.17.0` 起。官方更新通道使用 Tauri 2 Updater + GitHub Releases；
> **双通道拆分**：Windows 常规通道走 `latest.json`，Linux 长期稳定分支只接收
> 高危安全/崩溃补丁，走 `latest-linux-critical.json`（平台专属配置
> `src-tauri/tauri.linux.conf.json` 覆盖端点）。旧自定义补丁通道的 IPC 已下线，
> 仅保留历史校验代码与回归测试；官方通道互不绕过签名校验。

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
    仅 `windows-2022` 构建 NSIS + 签名 + 上传 `latest.json`（tauri-action），
    并把上一版 Release 里的 `latest-linux-critical.json` 接力携带到新 Release
    （保证 `releases/latest/download/...` 双通道 URL 永远可用）。
    发布 QA 需要真实 WebView2，固定 `windows-2022`：`windows-2025` 的 Evergreen
    WebView2（>=133）存在 DevTools/CDP 端口回归，会卡在 `qa:app-bootstrap`
    （参考 actions/runner-images#14738）。主 CI 的 Windows 构建检查仍用
    `windows-latest`，不启动 WebView2。
  - 发布 QA 固定 **Node.js 22+**：CDP harness 使用 Node 全局 `WebSocket`；
    Node 20 会在 `qa:app-bootstrap` 直接报错。
  - `.github/workflows/release-linux-critical.yml`：`v*-linux-sec*` 标签或手动
    `workflow_dispatch` → `ubuntu-22.04` 构建 deb/rpm/AppImage，
    `scripts/make-linux-critical-manifest.mjs` 生成
    `latest-linux-critical.json`（AppImage + minisign 签名），同样把
    `latest.json` 接力携带。
  - `.github/workflows/ci-linux-check.yml`：PR/推送时 Linux cfg 块编译检查。
- **社区构建**：`npm run build:community`（无 `TAURI_SIGNING_PRIVATE_KEY` 时自动
  覆盖 `createUpdaterArtifacts=false` 并标记 `MR_BUILD_ORIGIN=community`），
  见 `../../NOTICE.md` 与 `../TECHNICAL.md`。
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
   npm run version:sync -- 0.17.1
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
   git tag v0.17.1
   git push origin v0.17.1
   ```

4. `.github/workflows/release-windows.yml` 会：
   - 校验 tag 与 `package.json` 版本一致（`-linux*` 标签自动跳过）；
   - `npm ci` + Tauri 构建（`--bundles nsis`，注入 `MR_BUILD_ORIGIN=official`）；
   - 用 Secrets 中的私钥签名更新包；
   - 通过 `tauri-action@v1` 创建**已发布**的 GitHub Release，并上传
     `latest.json` 与安装包；
   - 接力携带上一版 Release 的 `latest-linux-critical.json`。

   > **本地全量 QA 证明发布（例外）**：当 GitHub-hosted Windows runner 因已知
   > WebView2 131 环境问题阻塞全量 QA，且本机已运行 `node tests/qa/run-qa.mjs`
   > 得到 226/226、P0–P3=0，可由维护者手动触发：
   > ```bat
   > gh workflow run release-windows.yml --ref v0.17.1 -f skip_full_qa=true -f local_qa_total=226
   > ```
   > `local_qa_total` 会原样写进发布说明的 QA 行；**每次受控发布都必须按当次本地
   > 全量 QA 的实际通过数传入**，不要沿用上一版的数字。
   > 发布说明必须写明“本地全量 QA 已通过、CI 全量 QA 因环境原因跳过”；
   > 这是例外，不是默认发布流程。

5. **Linux 高危补丁发布**（仅安全/崩溃级修复，先同步 `package.json` 到补丁版本）。
   deb/rpm 系统安装不会在应用内自我替换：更新面板只提供下载页/发行说明，
   由用户用包管理器安装；AppImage 运行态才允许自动替换。

   ```bat
   npm run version:sync -- 0.17.1
   :: 提交后：
   git tag v0.17.1-linux-sec1
   git push origin v0.17.1-linux-sec1
   ```

   `.github/workflows/release-linux-critical.yml` 在 `ubuntu-22.04` 构建
   deb/rpm/AppImage，生成并上传 `latest-linux-critical.json`（也接力携带
   `latest.json`）。也可在 Actions 页面手动 `workflow_dispatch` 指定标签。

   > **平台 overlay 必须显式生效**：Linux 构建命令带
   > `--config src-tauri/tauri.linux.conf.json`，它把打包目标固定为
   > deb/rpm/appimage，并把 updater 端点覆盖为 `latest-linux-critical.json`。
   > 少了这个 `--config`，产物会带着 Windows 的 `latest.json` 端点，
   > Linux 客户端永远看不到更新。`static:release-surface` 会守住这条。
   > 手动 `workflow_dispatch` 必须按 `inputs.tag` 检出（Checkout 的 `ref`），
   > Release 目标提交取构建时的 `git rev-parse HEAD`；早期版本误用
   > `$GITHUB_SHA`，在 dispatch 下会指向默认分支而不是标签。

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
  `updaterJsonPreferNsis: true` 可避免大多数问题）；
- 发布前全量 QA 失败时，工作流会保留 `qa-diagnostics-<attempt>` artifact
  （QA 报告、`qa-app.log` 与隔离数据日志）；先按 `qa:app-bootstrap` / suite id
  定位原因，再决定是否重跑，不要通过跳过 suite 放行发布。

## 6. 旧自定义补丁通道（已下线）

旧 `check_update` / `download_update` / `install_update` / `cancel_update` /
`get_update_snapshot` IPC 已从 `lib.rs` 移除，前端无调用；`update.rs` 的清单/签名
代码仅作为历史回归资产保留，不构成可用更新通道。未配置 `MR_UPDATE_PUBKEY` 时
只有回环清单允许无签名，远程清单一律拒绝。若未来重新启用，必须重新注册命令、
注入公钥、统一清单格式并补前端接线。官方 GitHub 通道的私钥不能提交到仓库，
也不能写入前端或日志。
