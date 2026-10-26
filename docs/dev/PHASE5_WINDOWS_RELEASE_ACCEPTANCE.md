# v0.17.2 Windows 发布验收报告（最终）

> 2026-10-27。授权范围：版本准备、候选构建、自动化测试、安装升级验证、Release Draft；
> **后续维护者单独授权了正式发布**。本报告 §1/§2/§5/§6 中“Draft/未公开/BLOCKED”
> 是发布前快照；发布后状态见本节与 §10。
>
> **2026-10-27 发布后更新**：`v0.17.2` 已公开（`publishedAt=2026-10-26T21:10:06Z`，
> publish run `40385949803` success）。公开资产、minisign、`latest.json`、
> `latest-linux-critical.json`、v0.17.1 回滚面已独立验证；Linux 通道未升级，仍为
> `v0.17.1-linux-sec1`。AI 权限隔离采用 local-only 最小方案，详见
> `PERMISSION_ISOLATION_ACCEPTANCE.md`。

## 1. 结论摘要

- **VERIFIED**：v0.17.2 候选身份、QA/Draft/制品 SHA-256 绑定；GitHub-hosted `windows-2022`
  干净 VM 上的全新安装、0.17.1 → 0.17.2 升级、回滚、合成书库/阅读进度/真实 `list_books`
  IPC；provenance、签名、证据总闸、更新清单；**v0.17.2 已公开**，发布后资产/签名/
  updater/回滚/Linux 独立性复核通过（见 §9）。
- **BLOCKED**：AI 远程 PR/CI 自动化（local-only，无 GitHub API/git 写凭据）；浏览器/OS
  级隔离需要独立执行账号/VM；本地交互式 VM（本机没有可用的本地 VM 管理工具）；
  Linux 通道的安装证据（Linux 保持独立）。
- **NOT_VERIFIED**：hosted runner 镜像的完整供应链（仅 ImageVersion + run URL 可核实）；
  **release 构建的完整 UI**（本次验证启动 + IPC + 数据库，完整 UI QA 在 debug 构建上）；
  live updater 客户端实际升级；minisign 上游二进制自身签名；Vercel App 权限；
  tag creation rule 对非 bypass 身份的拒绝（无第二身份可测）。

## 2. 候选身份

| 项 | 值 |
|---|---|
| 标签 / Commit | `v0.17.2`（annotated tag `9e09bce…`）→ `f331782a29e53885c061b56d740dbd1faabdec1c` |
| 安装包 | `MangaReader_0.17.2_x64-setup.exe`，5,306,377 bytes |
| 安装包 SHA-256 | `b6d7048894a4b16382ce25b5762c881dba79e03f1642acf3452ceb4f11f1db82` |
| 签名 | `MangaReader_0.17.2_x64-setup.exe.sig`，SHA-256 `ee09d934b07717187353740325ab2200c757e03fbbb797e1ba983192c58f1801` |
| 更新清单 | `latest.json`，SHA-256 `d9c4324318087f424eab1a462d04947aa67d7a7950a69939778f658b057ad51a` |
| RC 记录 | `rc-record.json`，SHA-256 `79ba88ac24b2d88f5d60f03024500ce51c57e66bfb28f001fb7c84ba26bcfeca` |
| QA 证据 | run `40324223701`，success，headSha `f331782…`，230/230 |
| 发布前 Draft | `v0.17.2`，`isDraft=true`，target `f331782…`，7 个资产（历史快照） |
| 当前 Latest | `v0.17.2`，published_at `2026-10-26T21:10:06Z`；Linux 通道仍 `v0.17.1-linux-sec1` |

## 3. 干净 Windows VM 验证（最终证据）

### 3.1 最终运行

| 项 | 值 |
|---|---|
| Workflow | `release-install-verify.yml`（`workflow_dispatch` only） |
| Run | `40374494977`，success，attempt 1 |
| Run URL | https://github.com/D-OneXXX/MR/actions/runs/40374494977 |
| 触发者 | `D-OneXXX` |
| Runner | GitHub-hosted `windows-2022` |
| ImageOS / ImageVersion | `win22` / `20261022.344.1` |
| Runner name | `GitHub Actions 1000000661` |
| 工作流 head | `2508cc147d09d000ac4423d5bec0cad3ded13f73`（main 上的当前验证器；被测制品仍是 tag 的 `f331782…`） |
| 时间 | started `2026-10-26T18:04:35Z`，completed `2026-10-26T18:06:01Z` |
| 证据 artifact | `clean-vm-evidence-v0.17.2-40374494977` |
| `install-verification.json` | 2,682 bytes，SHA-256 `b2f0084855a5dac7b44675dc34f1630907489671c4f50a879a3a3059b5c1bb56` |
| 已上传 Draft | 是；Draft 资产 digest `sha256:b2f00848…` |

`run-manifest.json`（SHA-256 `0c39b899…`）记录：

- `tag=v0.17.2`、`commit=f331782…`、`version=0.17.2`
- `artifactSha256=b6d704…`、`previousVersion=0.17.1`、`previousArtifactSha256=3e90ece58ec984a8f1a94292587956d0482af5fd6c9b05403d3cd3a8b83b55e6`
- `runId=40374494977`、`imageVersion=20261022.344.1`、`runUrl`、`event=workflow_dispatch`
- 证据/fresh/fixture/rc-record/candidate 的文件 SHA-256

### 3.2 证据绑定与数据完整性

`install-verification.json`（最终）：

```json
{
  "verdict": "PASS",
  "version": "0.17.2",
  "commit": "f331782a29e53885c061b56d740dbd1faabdec1c",
  "artifactName": "MangaReader_0.17.2_x64-setup.exe",
  "artifactSha256": "b6d7048894a4b16382ce25b5762c881dba79e03f1642acf3452ceb4f11f1db82",
  "expectedArtifactSha256": "b6d7048894a4b16382ce25b5762c881dba79e03f1642acf3452ceb4f11f1db82",
  "previousVersion": "0.17.1",
  "previousArtifactName": "MangaReader_0.17.1_x64-setup.exe",
  "previousArtifactSha256": "3e90ece58ec984a8f1a94292587956d0482af5fd6c9b05403d3cd3a8b83b55e6",
  "checks": {
    "freshInstall": "pass",
    "upgrade": "pass",
    "dataIntegrity": "pass",
    "recovery": "pass"
  },
  "library": {
    "quickCheck": "ok",
    "schemaVersionBefore": 1,
    "schemaVersionAfter": 1,
    "bookCount": 1,
    "readingLogRows": 2,
    "readingLogPages": 3,
    "books": [{
      "id": "763171bec9e118abbe24d850c2f7e0183eefc22c77a11d1d4061e44fa3f57283",
      "title": "Release Smoke Book",
      "pageCount": 3,
      "currentPage": 2,
      "scrollPct": 0.5,
      "removed": 0,
      "sourceType": "local"
    }],
    "ipc": {
      "ok": true,
      "source": "list_books",
      "bookId": "763171bec9e118abbe24d850c2f7e0183eefc22c77a11d1d4061e44fa3f57283",
      "title": "Release Smoke Book",
      "currentPage": 2,
      "scrollPct": 0.5,
      "bookCount": 1,
      "checkedAt": "2026-10-26T18:05:40.924Z"
    },
    "snapshotSha256": "a364619f140e1890471a46e3abc5352d8f8647642fb593223dde3c220913c615"
  },
  "machine": {
    "os": "Microsoft Windows Server 2022 Datacenter",
    "cleanEnvironment": true,
    "image": "GitHub Actions win22 20261022.344.1",
    "host": "runnervma5ucf",
    "provenance": {
      "kind": "github-actions",
      "repository": "D-OneXXX/MR",
      "runId": "40374494977",
      "runUrl": "https://github.com/D-OneXXX/MR/actions/runs/40374494977",
      "runnerName": "GitHub Actions 1000000661",
      "imageOs": "win22",
      "imageVersion": "20261022.344.1",
      "workflow": "D-OneXXX/MR/.github/workflows/release-install-verify.yml@refs/heads/main",
      "actor": "D-OneXXX",
      "runAttempt": "1"
    }
  }
}
```

这证明：数据库 `quick_check`、schema 未降级、合成书库 1 本、阅读进度 `2`、
`scroll_pct=0.5`、两条 `reading_log` 共 3 页，并且**已安装应用**通过真实
`list_books` IPC 回读到同一本书与同一进度（bookId/currentPage/scrollPct 全一致）。

### 3.3 两遍流程

1. **Fresh install**：安装 0.17.2 → 启动 → 自动创建 `library.db` → 卸载；`freshInstall=pass`。
2. **Upgrade / rollback**：安装 0.17.1 → 启动 → 写入合成书库/进度 → 安装 0.17.2 →
   启动 → `list_books` IPC → 校验数据库 → 回滚 0.17.1 → 启动 → IPC → 校验 → 卸载；
   `upgrade/dataIntegrity/recovery` 全 pass。两遍通过 `-MergeFrom` 合并，且版本/Commit/
   制品 SHA 必须一致。

### 3.4 四轮 hosted 迭代（真实失败与修复）

| # | Run | 结果 | 发现的真实缺陷 | 修复 |
|---|---|---|---|---|
| 1 | `40361450086` | fresh PASS；upgrade FAIL | UI check 复用 debug-only `connectMain`（只认 `localhost:1420/`），release target 是 `tauri.localhost`，30s 超时 | PR #79 `0c6893e`（release-aware target + 90s） |
| 2 | `40369438334` | 已连上并执行 `list_books`，但步骤挂起 | UI check 未关闭 CDP WebSocket，Node 进程不退出，安装脚本等待 `& node` | PR #80 `4fdf643`（finally 关闭 + process.exit） |
| 3 | `40372963462` | upgrade/rollback PASS；self-check FAIL | PowerShell 函数同时捕获 node stdout 与结果对象，`library` 被写成数组，门禁按“缺少 library”拒绝 | PR #81 `2508cc1`（三处 `| Out-Host`） |
| 4 | `40374494977` | **success** | 无 | 最终证据 |

这四轮**没有跳过或放宽任何断言**；每次失败都定位到 harness/CI 的真实缺陷并修复。
产品源码、候选制品、公开清单未因这些修复改变。

补充：Linux check 的 `Install WebKitGTK build dependencies` 连续卡住（>10 分钟，
GitHub Actions 状态正常）；PR #79 增加 `DEBIAN_FRONTEND=noninteractive`、
`NEEDRESTART_MODE=a`、有界超时/重试和 Azure→官方 archive 回退，之后 apt 31 秒完成，
完整 Linux 门禁通过。该修复只影响 CI 依赖安装，不改变任何断言。

### 3.5 旧回执拒绝与正向控制

- Draft 里旧的共享宿主回执（`cleanEnvironment=false`、无 provenance/library、
  无 expected SHA、无 previous 身份）在**真实 Draft** 上被 `verify-draft` 与
  `verify-evidence` 同时拒绝，共 8 条理由。
- 另用 local-vm provenance 的 synthetic 证据做正向控制，确认新 schema 可被门禁接受；
  该 synthetic 证据**未上传、未用于发布**。
- 仅最终 run `40374494977` 的 `install-verification.json` 被上传 Draft。

### 3.6 “干净环境”的边界

本次是 **GitHub-hosted 一次性 ephemeral VM**：`ImageVersion=20261022.344.1`，run URL 可公开
核实；没有先前的 MangaReader 安装，数据目录完全隔离。它**不是**零售 pristine Windows
安装，也不是维护者本地的交互式桌面 VM；预装的 runner 软件属于镜像的一部分。若发布政策
要求本地桌面 VM，请按 `docs/dev/RELEASE.md` §4.2 的本地 VM 命令重跑并人工核验镜像
SHA-256/运行日志；当前证据是 hosted VM。

## 4. 发布门禁重跑

### 4.1 Draft 上的官方闸门

| 闸门 | 结果 |
|---|---|
| `verify-provenance.mjs` | OK run `40374494977`，image `win22/20261022.344.1`，run URL 自洽 |
| `verify-draft.mjs` | OK `rc-v0.17.2-f331782a29e5`，版本/通道/平台/3 个制品 |
| `fetch-minisign.mjs` + `verify-signature.mjs` | OK，SHA `b6d704…`，公钥 ID `67CB304460E08E4A` |
| `verify-evidence.mjs` | OK：签名 + 安装/升级证据齐备且与候选绑定 |
| `verify-updater-manifest.mjs` | OK `latest.json`，`version=0.17.2`，`windows-x86_64` |

### 4.2 本地门禁

| 门禁 | 结果 |
|---|---|
| `npm run version:check` | OK 0.17.2（五个版本文件一致） |
| `npm run test:version` | 6/6 |
| `npm run test:release` | 88/88 |
| `npm run release:rehearse` | 37/37 |
| `npm run test:governance` | 33/33 |
| `npm run test:fixtures` | 3/3 |
| `node tests/qa/run-qa.mjs --suite=static` | 23/23，P0=P1=P2=P3=0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | ✓ built |
| `cargo fmt --check` | 无差异 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Node 22.23.4 复跑新增测试 | 70/70 |
| PowerShell 5.1 Parser + 四条硬失败路径 | 通过 |
| actionlint 1.7.7（新增/修改 workflow） | 通过 |
| PR #78/#79/#80/#81 required checks | Windows/Linux/PR 治理/演练全绿 |

### 4.3 QA 证据

`qa-full` run `40324223701`：success，headSha `f331782…`，230/230。候选应用源码未变
（四个修复 PR 只改 release harness、CI、测试与文档），因此该 QA 证据仍绑定候选
Commit；未用新的 app 源码替换。`visual:theme-token` 本轮未复现，保持观察，未新建 Issue。

### 4.4 公开面与隔离

| 项 | 结果 |
|---|---|
| 公开 `latest.json` | SHA-256 `64f6038e4dec5c9f…`（与基线逐字节一致） |
| 公开 `latest-linux-critical.json` | SHA-256 `2bdb3af5271cc1b5…`（与基线逐字节一致） |
| Latest Release | `v0.17.1-linux-sec1`，published_at `2026-10-25T10:15:11Z`（未变） |
| `v0.17.2` Draft | `isDraft=true`，7 资产，target `f331782…`，证据已替换 |
| `v0.0.0-rehearsal` | Tag `b0820e2…` + Draft 均保留，未清理 |
| `v0.17.2` Tag | annotated `9e09bce…` → `f331782…`，未移动 |
| Publish（Windows） | 本轮 0 个 v0.17.2 publish；唯一的失败 run `40293390900` 是 08:36 的历史记录 |
| Linux 发布通道 | 0 个 `release-candidate-linux` / `release-publish-linux` 运行 |
| 仓库级 Secrets | `total_count=0` |
| Environments | `release-windows` / `release-linux` 保持原配置 |

## 5. 审批边界（未技术隔离）

当前事实（只读审计）：

- Agent 使用维护者本人的 `gho_` OAuth token（scopes `gist/read:org/repo/workflow`）；
  Agent 与维护者是同一 GitHub 身份。
- 两个 Environment 的 required reviewer 都是 `D-OneXXX`，`prevent_self_review=false`，
  `can_admins_bypass=true`。
- 上一次候选 run `40325710339` 的 approval 记录是 `D-OneXXX` 批准自己的 deployment。
- 因此 AI 技术上仍可触发 publish 并批准自己的 deployment；当前只有流程约束 +
  只读审计，不是技术隔离。

已新增（代码级、非远程设置）：

- `release-publish.yml` 的 `verify-provenance.mjs` 在线核验安装证据 run；
- `Audit deployment approval boundary` 只读记录 actor/approver，同身份时打印 warning
  并写入 job summary；
- `docs/dev/RELEASE_APPROVAL_BOUNDARY.md` 记录风险、证据与变更清单。

本轮**未修改**任何 Environment、Secrets、Ruleset、仓库权限。要获得技术隔离，维护者需
选择并配置（详见审计文档）：

1. **推荐**：GitHub App 自动化身份 + `prevent_self_review=true` +
   `can_admins_bypass=false`；Agent 用 App token 触发，维护者本人批准。
2. 备选：维护者控制的第二个 GitHub 账号作为唯一 reviewer。
3. 备选：Agent 使用细粒度 PAT（不含 Deployments/Environments/Administration 写权限）。

在上述任一完成前，正式发布只能由维护者本人从 GitHub UI 触发并批准；Agent 不触发、
不批准 publish deployment。

## 6. VERIFIED / BLOCKED / NOT_VERIFIED

### VERIFIED

- 候选身份：tag/Commit/安装包 SHA/签名/更新清单/RC 记录/QA run/Draft 全部绑定。
- hosted 干净 Windows VM：fresh install、0.17.1→0.17.2 升级、回滚、数据库自检、
  合成书库/阅读进度、真实 `list_books` IPC。
- provenance、签名、`verify-draft`、`verify-evidence`、updater manifest 五个官方闸门
  在 Draft 实际资产上全部通过。
- **v0.17.2 已公开**：publish run `40385949803`；发布后资产/签名/updater/回滚面
  独立验证通过；`v0.0.0-rehearsal` 保留；Linux 通道未升级。
- 四个 harness/CI 缺陷已修复，未跳过/放宽断言。

### BLOCKED

- **AI 远程 PR/CI 自动化**：已实施 local-only 隔离（无 GitHub API/git 写凭据）；
  远端 push/PR/CI/发布由维护者完成。若恢复自动化，需 GitHub App + 独立 OS。
- **浏览器/OS 级隔离**：AI 与维护者在同一 Windows 账号；需要独立执行账号/VM 才能
  证明 browser/computer-use 级别的自审批防护。
- **本地交互式 VM**：本机没有可用的本地 VM 管理工具（Hyper-V `vmms` 未安装、无
  VMware/VirtualBox/QEMU，当前会话非管理员）；本次使用 hosted ephemeral VM。若政策要求
  本地桌面 VM，需维护者按 RELEASE.md §4.2 重跑并人工核验。
- **Linux 安装/升级证据**：无 Linux 主机；Linux 通道保持独立，不随 Windows 自动发布。
- **演练 Tag/Draft 清理**：未执行；Tag ruleset 保护 `v*`，需维护者决定。

### NOT_VERIFIED

- hosted runner 镜像的完整供应链：仅 `ImageOS`/`ImageVersion` + run URL 可核实，
  没有可核对的 VM 镜像 SHA-256。
- **release 构建的完整 UI**：本次只验证启动 + `list_books` IPC + 数据库；完整的
  visual/reader/online/cache/privacy/chaos QA 跑在 debug 构建上（230/230），
  不能证明 release 构建的每个界面行为。
- 正式公开 publish 路径已执行（run `40385949803`），但 live updater 客户端实际升级
  与完整 release UI 仍未验证；见 §9。
- minisign 上游二进制自身签名：按仓库固定摘要下载；未单独核验 minisign 发布者的
  上游签名。
- **AI 技术无法自批**：API/git 层已通过 local-only 实现；浏览器/OS 级仍未验证。
- `visual:theme-token` 的长期稳定性：本轮未复现，保持观察。

## 7. 维护者需亲自完成的最小操作

1. 已发布 `v0.17.2`；后续发布仍由维护者本人触发/批准，Agent 不触发/不批准。
2. 审查最终证据与 run（链接见下）；如要求本地桌面 VM，按 RELEASE.md §4.2 重跑并
   人工核验镜像 SHA-256/日志。
3. AI 权限隔离已采用 local-only；若要恢复远程 PR/CI，按
   `PERMISSION_ISOLATION_ACCEPTANCE.md` §11.6 创建 App + 独立 OS，先测试再移除旧凭据。
4. Linux 通道独立决策；本轮未发布 Linux。
5. 决定 `v0.0.0-rehearsal` Tag/Draft 的后续处理（ruleset 保护，未擅自清理）。

## 8. 证据链接与复核

- 最终 hosted run：https://github.com/D-OneXXX/MR/actions/runs/40374494977
- 最终证据 artifact：`clean-vm-evidence-v0.17.2-40374494977`
- Public Release：https://github.com/D-OneXXX/MR/releases/tag/v0.17.2 （已公开）
- QA run：https://github.com/D-OneXXX/MR/actions/runs/40324223701
- 审批边界审计：`docs/dev/RELEASE_APPROVAL_BOUNDARY.md`
- 安装验证契约/用法：`docs/dev/RELEASE.md` §4.2
- 复核命令：

```bash
# 真实 Draft 官方闸门
GH_TOKEN="$(gh auth token)" node scripts/release-governance/verify-provenance.mjs \
  --evidence draft-final/install-verification.json --repo D-OneXXX/MR \
  --expected-workflow .github/workflows/release-install-verify.yml
node scripts/release-governance/verify-draft.mjs --tag v0.17.2 --channel windows \
  --commit f331782a29e53885c061b56d740dbd1faabdec1c \
  --record draft-final/rc-record.json --assets-dir draft-final \
  --attestation draft-final/install-verification.json \
  --manifest draft-final/latest.json --platform windows-x86_64
node scripts/release-governance/verify-evidence.mjs --record draft-final/rc-record.json \
  --assets-dir draft-final --signature-evidence signature-verification-final.json \
  --install-evidence draft-final/install-verification.json \
  --public-key configured.pub --channel windows \
  --commit f331782a29e53885c061b56d740dbd1faabdec1c
node scripts/verify-updater-manifest.mjs draft-final/latest.json \
  --expect-version 0.17.2 --require-platform windows-x86_64
```

> 公开 `latest.json` / `latest-linux-critical.json` 的字节未变；本报告不构成发布授权。

## 9. 2026-10-27 发布后验证（当前状态）

- `v0.17.2` 公开：https://github.com/D-OneXXX/MR/releases/tag/v0.17.2，
  `publishedAt=2026-10-26T21:10:06Z`；publish run `40385949803` success；公开 API
  匿名访问返回 200。
- 8 个资产：原 7 个候选资产 SHA-256 全部不变（安装包 `b6d70488…`、签名
  `ee09d934…`、`latest.json` `d9c43243…`、RC 记录 `79ba88ac…`、安装证据
  `b2f00848…`、摘要 `524234c0…`、签名证据 `b3c4ca50…`），另加 Linux 接力清单
  `2bdb3af5…`。
- 公开 `releases/latest/download/latest.json` = `d9c43243…`，version 0.17.2，
  Windows 平台；其 URL 下载到安装包 SHA-256 `b6d70488…`。
- 公开 `latest-linux-critical.json` = `2bdb3af5…`，version 0.17.1，Linux 平台；
  Linux Release 仍为 `v0.17.1-linux-sec1`，无新 Linux 运行/deployment。
- `v0.17.1` 仍公开：安装包 `3e90ece5…`、签名 `a579e827…`、`latest.json`
  `64f6038e…`，可用于回滚。
- 发布工作流 `Channel hand-off` 把 Linux 清单带入 v0.17.2；这是同一字节的通道
  接力，不是 Linux 发布。发布后目录级 `verify-draft` 会因该额外资产报错；对 7 个
  候选资产单独运行 `verify-draft` 通过。
- 已知残余：公开 Release 说明仍含“Draft/未公开”旧文案（P2，未修改 release
  artifact）；AI 权限隔离已在 API/git 层 local-only，但远程 PR/CI 自动化与浏览器/
  OS 隔离仍 BLOCKED，见 `PERMISSION_ISOLATION_ACCEPTANCE.md`。
