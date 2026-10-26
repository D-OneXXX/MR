# 发布与自动更新签名

> **发布流程（Phase 4 起）**：仓库内**没有任何 Tag 触发的发版工作流**，推送 `v*`
> 标签不会构建也不会公开发布。正式发布必须由维护者手动触发「候选」与「发布」
> 两个工作流，且两次都要通过 Environment 人工审批。
> **Phase 5 起**：候选必须绑定 QA run id、Commit 与制品 SHA-256；发布前必须有
> 官方 minisign 验签证据与**干净环境**的安装/升级/数据完整性回执，缺一即拒绝。
> 完整规则见 `docs/ENGINEERING_WORKFLOW.md` §9 与
> [PHASE4_RELEASE_GOVERNANCE.md](PHASE4_RELEASE_GOVERNANCE.md)。
>
> **发布候选 QA 回退**：hosted 全量 QA 被 #30/#32 阻塞期间，可按
> `docs/dev/LOCAL_QA_ATTESTATION.md` 执行固定 Commit 的本地完整 QA attestation；
> 它不能替代发布批准、签名校验或安装/升级测试，且仍禁止在审批前推 Tag。

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
  - `.github/workflows/release-candidate.yml`：`workflow_dispatch` 手动触发
    （输入 `tag` + `qa_run_id`）→ Environment `release-windows` 人工审批 →
    仅 `windows-2022` 构建 NSIS + 签名 + 上传 `latest.json`（tauri-action）→
    **只创建 Draft** 并附上 `rc-record.json`（版本 + Commit + 平台 + QA runId +
    每个制品 SHA-256）。它**不会**公开发布，也不会被 Tag 推送触发。
    发布 QA 需要真实 WebView2，固定 `windows-2022`：`windows-2025` 的 Evergreen
    WebView2（>=133）存在 DevTools/CDP 端口回归，会卡在 `qa:app-bootstrap`
    （参考 actions/runner-images#14738）。主 CI 的 Windows 构建检查仍用
    `windows-latest`，不启动 WebView2。
  - 发布 QA 固定 **Node.js 22+**：CDP harness 使用 Node 全局 `WebSocket`；
    Node 20 会在 `qa:app-bootstrap` 直接报错。
  - `.github/workflows/release-publish.yml`：`workflow_dispatch` 手动触发
    （输入 `tag`）→ Environment 审批 → 下载 Draft 制品 → 绑定校验 →
    取官方 minisign 验签 + 证据总闸 → 把 Draft 变为公开 Release，
    并把另一通道的清单接力携带（保证 `releases/latest/download/...` 双通道 URL 永远可用）。
  - `.github/workflows/release-candidate-linux.yml` / `release-publish-linux.yml`：
    Linux 高危补丁通道（标签固定 `vX.Y.Z-linux-secN`），`ubuntu-22.04` 构建
    deb/rpm/AppImage，`scripts/make-linux-critical-manifest.mjs` 生成
    `latest-linux-critical.json`（AppImage + minisign 签名）。与 Windows 通道
    各自独立审批，互不触发。
  - `.github/workflows/release-rehearsal.yml`：无 Secret 的发布状态机隔离演练，
    每次 push / PR 都跑。
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

## 3. GitHub Secrets（Phase 4：Environment 作用域）

签名私钥**只允许放在 Environment 作用域**，让「候选构建」这一条路径能读到它，
发布 job 与其它工作流读不到。

| 位置 | Secret | 值 |
|---|---|---|
| Environment `release-windows` | `TAURI_SIGNING_PRIVATE_KEY` | `updater.key` 的完整文本内容（不是路径） |
| Environment `release-windows` | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `password.txt` 的完整文本内容 |
| Environment `release-linux` | 同上两项 | 同上（Linux 通道需要同一把 minisign 私钥） |

`GITHUB_TOKEN` 由 Actions 自动提供，不需要手动添加。

### 3.1 迁移顺序（先配置 → 再验证 → 后删除旧副本）

1. **先配置**：在 `release-windows` 与 `release-linux` 两个 Environment 里新增上述 Secret。
   值只能由持有本机私钥的维护者提供——GitHub 不提供 Secret 明文读取，
   **Agent 既读不到也绝不会输出任何密钥内容**。
2. **再验证**：用一次**候选**工作流（演练标签）确认 Environment 级 Secret 可用：
   签名产物 `.sig` 存在、`latest.json` 的签名非空、且能通过
   `node scripts/verify-updater-manifest.mjs`。
3. **后删除**：验证通过后，才删除**仓库级**同名 Secret。删除后仓库内任何工作流
   （包括候选工作流）都拿不到私钥——这是预期的收敛方向。

> 迁移期间仓库级与 Environment 级副本会短暂共存；这是有意的安全窗口，
> 不要在第 2 步验证通过之前删除仓库级副本。

## 4. 发布步骤（Phase 4 新流程：候选 → Draft → 审批 → 发布）

> **仓库内已没有任何 Tag 触发的发版工作流**：推送 `v*` 标签不会再自动构建或公开发布。
> 正式发布必须由维护者手动触发「候选」与「发布」两个工作流，且两次都要通过
> Environment 人工审批。完整说明与验收证据见
> [PHASE4_RELEASE_GOVERNANCE.md](PHASE4_RELEASE_GOVERNANCE.md)。

### 4.0 前置门禁（本地可执行，必须先绿）

```bat
npm run test:release          :: 发行面契约 + 更新清单校验 + 发布治理单测
npm run release:rehearse      :: 隔离发布演练（不联网、不创建 Release）
npm run format:check          :: Rust 格式
node tests\qa
un-qa.mjs --suite=static   :: 含 static:release-governance 守卫
```

### 4.1 候选（Draft）

1. 修改版本（单一事实源为 `package.json`）并合并到 `main`：

   ```bat
   npm run version:sync -- 0.17.2
   npm run version:check
   npm run test:version
   ```

2. 打标签并推送（**不会触发任何发版流程**）：

   ```bat
   git tag v0.17.2
   git push origin v0.17.2
   ```

3. 跑一次全量 QA 并记录 run id（必须 `success` 且 `head_sha` 等于标签提交）：

   ```bat
   gh workflow run qa-full.yml -f ref=v0.17.2
   ```

4. 触发候选工作流（Windows 常规通道 / Linux 高危通道各一个）：

   ```bat
   gh workflow run release-candidate.yml --ref main ^
     -f tag=v0.17.2 -f qa_run_id=<run id>

   gh workflow run release-candidate-linux.yml --ref main ^
     -f tag=v0.17.2-linux-sec1 -f qa_run_id=<run id>
   ```

   候选 job 会：校验标签与版本一致且提交在 `main` 上 → 查证 QA run 的结论与
   `head_sha` → 跑本地门禁 → 构建并签名 → **创建 Draft**（绝不公开）→ 上传制品、
   `latest.json` / `latest-linux-critical.json`、签名文件与 `rc-record.json`
   （记录版本 + Commit + 每个制品的 SHA-256 + 平台）。

### 4.2 安装验证（正式发布的强制条件）

在**一次性干净 Windows 虚拟机**上执行：

```powershell
pwsh -File scripts/release-smoke/windows-install-upgrade.ps1 ^
  -PreviousInstaller <旧版安装包> -Installer <新版本安装包> -ExpectedVersion 0.17.2 ^
  -CleanEnvironment -ImageName "Windows 11 Pro 24H2" ^
  -Commit <候选提交> -DataDirForApp <隔离数据目录> `
  -EmitEvidence install-verification.json `
  -ArtifactName MangaReader_0.17.2_x64-setup.exe
```

脚本会输出安装验证回执（JSON）。把它作为候选/发布输入（base64）或直接作为
Draft 资产 `install-verification.json` 上传。**没有这份回执，发布工作流会拒绝发布**
（这是设计，不是可绕过的例外）。

> **干净环境声明是机器可判定字段**：回执必须带
> `machine.cleanEnvironment: true` 与 `machine.image`（镜像标识）。
> 这两个字段由 `-CleanEnvironment` / `-ImageName` 显式声明——**共享宿主上不要传**：
> 回执会写成 `cleanEnvironment=false`，发布门禁（`verify-draft.mjs` 与
> `verify-evidence.mjs`）直接拒绝。这是有意的失败方向，避免「在开发机上跑一遍」
> 冒充干净环境验证。声明了 `-CleanEnvironment` 却没有镜像标识时脚本自身判失败。

### 4.3 发布（人工审批后）

```bat
gh workflow run release-publish.yml --ref main -f tag=v0.17.2
```

发布 job 会：确认目标是 **Draft**（已发布则幂等跳过）→ 下载 Draft 全部制品 →
逐项比对「版本 / Commit / 每个制品 SHA-256 / 平台 / QA 证据 / 安装验证回执」→
**强制验收（无开关可绕）**：

1. 拉取**官方 minisign**（按仓库固定摘要校验）→ 用**仓库当前配置的 updater 公钥**
   验签候选安装包 → 生成 `signature-verification.json`；
2. 要求 Draft 里存在干净环境的 `install-verification.json`（安装/升级/数据完整性/恢复）；
3. `verify-evidence.mjs` 总闸：两份证据都必须与候选的版本、Commit、平台、
   制品 SHA-256 一致且未过期，签名证据还必须锚定到配置的公钥 ID。

→ 通过后把 Draft 变为公开 Release → 接力携带另一通道的清单 → 发布后验证
（重新下载并校验公开清单）。

任一不一致、缺证据、证据过期或验签失败都会**拒绝发布**并给出具体原因；
这条链路没有布尔开关、状态文件或可跳过的 Job。

### 4.4 Linux 高危补丁通道

Linux 通道只发安全/崩溃级修复，标签形态固定为 `vX.Y.Z-linux-secN`，走
`release-candidate-linux.yml` / `release-publish-linux.yml`，端点固定
`latest-linux-critical.json`，与 Windows 通道互不影响。

> **平台 overlay 必须显式生效**：Linux 构建命令带
> `--config src-tauri/tauri.linux.conf.json`，它把打包目标固定为
> deb/rpm/appimage，并把 updater 端点覆盖为 `latest-linux-critical.json`。
> 少了这个 `--config`，产物会带着 Windows 的 `latest.json` 端点，
> Linux 客户端永远看不到更新。`static:release-surface` 会守住这条。

### 4.5 已移除的旧路径（不要再用）

- ~~`on: push: tags: v*` 触发发版~~ → 仓库内已无 Tag 触发器。
- ~~`skip_full_qa` / `local_qa_total` 跳过 hosted QA 直接发布~~ → 已删除，无绕过开关。
- ~~`releaseDraft: false` 直接创建已发布 Release~~ → 候选阶段只建 Draft。
- ~~发布 job 持有签名私钥~~ → 签名只在候选阶段，发布 job 不接触私钥。

## 5. 更新失败的常见原因

- `latest.json` 不在**最新已发布** Release 中（草稿/Draft 不可被 `releases/latest` 访问）；
- tag 版本与 `package.json` 不一致，工作流在构建前失败；
- GitHub Secrets 缺失/私钥口令错误，签名产物缺失；
- 客户端 `pubkey` 与 CI 私钥不匹配；
- 资产名/平台键与 `latest.json` 不一致（保留 `--bundles nsis` 与  `updaterJsonPreferNsis: true` 可避免大多数问题）；
- 发布前全量 QA 失败时，工作流会保留 `qa-diagnostics-<attempt>` artifact
  （QA 报告、`qa-app.log` 与隔离数据日志）；先按 `qa:app-bootstrap` / suite id
  定位原因，再决定是否重跑，不要通过跳过 suite 放行发布。

### 5.1 建 Release 被拒（`Resource not accessible by integration`）

**症状**：工作流在「Build and publish」或 `gh release create` 处报
`Resource not accessible by integration - .../releases#create-a-release`，
`POST /releases` 被拒；构建产物（安装包 + 签名）已生成但没上传。

**已排除的原因**（2026-10-25 在 v0.17.1 上逐一验证）：

| 假设 | 验证方式 | 结论 |
|---|---|---|
| 标签是附注标签（annotated）导致 GitHub 试图改写标签引用 | 分别用附注标签与轻量标签各建一次 Release | 两者都成功，排除 |
| `Protect release tags` ruleset 拦住了建 Release | 用管理员令牌对 `refs/tags/v*` 标签建 Release | 成功，排除 |
| 工作流的 `permissions: contents: write` 没写对 | 与当天成功发布 v0.17.0 的文件逐行 diff | 完全一致，排除 |
| 旧式 tag 保护规则 | `GET /tags/protection` | 仓库没有此类规则，排除 |

**观察到的边界**：同一个 `GITHUB_TOKEN` 能 `PATCH` 既有 Release、能上传资产，
只有「创建 Release」被拒；管理员 OAuth 令牌则完全正常。

**处置办法**：在触发发布前，用管理员令牌先把 Release 建好，工作流就只剩上传资产：

```bat
gh release create <tag> --verify-tag --title "<标题>" --notes "<说明>"
```

工作流检测到 Release 已存在会跳过创建（Linux 通道是 `|| echo "release already exists"`，
tauri-action 是 `updateRelease`），随后正常上传资产与清单。
Windows 通道用同样的预建方式验证通过。

**不要**为此把仓库的默认 workflow 权限（`default_workflow_permissions`）改成
read-write —— 那是全仓库、所有第三方 action 的令牌权限面，属于安全降级；
工作流内的 `permissions:` 声明保持现状即可。

## 6. 旧自定义补丁通道（已下线）

旧 `check_update` / `download_update` / `install_update` / `cancel_update` /
`get_update_snapshot` IPC 已从 `lib.rs` 移除，前端无调用；`update.rs` 的清单/签名
代码仅作为历史回归资产保留，不构成可用更新通道。未配置 `MR_UPDATE_PUBKEY` 时
只有回环清单允许无签名，远程清单一律拒绝。若未来重新启用，必须重新注册命令、
注入公钥、统一清单格式并补前端接线。官方 GitHub 通道的私钥不能提交到仓库，
也不能写入前端或日志。
