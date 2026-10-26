# 发布权限隔离验收报告（只读审计 + 设计）

> 日期：2026-10-27
> 仓库：`D-OneXXX/MR`（public，user-owned）
> 范围：AI 自动化身份、GitHub Environment 审批、Release 触发与发布边界。
>
> **结论**：GitHub 侧的技术隔离方案已经明确，但**尚未实施**；正式发布仍为 **BLOCKED**。
> 本轮没有修改任何 Environment、Secrets、Ruleset、仓库权限或正式更新清单，也没有触发
> 正式发布。v0.17.2 Draft 与 `v0.0.0-rehearsal` 资源保持不变。

## 0. 本轮完成情况

- PR #82（Windows 发布验收报告）在全部 required checks 通过后已合并为
  `1d63c35d209bcb341bace2add747a7654ad33ba8`；变更仅为 4 个文档文件。
- 5 个并行只读审计子代理全部完成，未出现阻塞或需要中止的长时间等待。
- Linux required check `cargo check + frontend build (ubuntu-22.04)` 用时 22m6s 后通过；
  期间在 apt/前端步骤出现过等待，但没有失败。
- 本轮新增的是审计与设计文档，没有修改产品代码、工作流、安装测试体系或公开清单。

## 1. 当前事实（VERIFIED）

### 1.1 AI 当前使用的身份

| 项目 | 观测值 |
|---|---|
| GitHub 账号 | `D-OneXXX`（User，id `217948500`，`site_admin=false`） |
| 仓库权限 | admin / maintain / push / triage / pull |
| 本地认证 | `gh` keyring，HTTPS；账号与维护者**同一身份** |
| 令牌类型 | 用户 OAuth token，不是 GitHub App installation token |
| 令牌 scopes | `gist`、`read:org`、`repo`、`workflow` |
| 协作者 | 仅 `D-OneXXX`（admin） |
| 仓库 secret | 0 个 |
| Environment secret | `release-windows` / `release-linux` 各有 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（只记录名称，未读取值） |

风险含义：`repo` scope + admin 使当前身份可以修改 Environment、Ruleset、分支保护、
Release 和 workflow；审计日志无法区分“维护者本人操作”和“AI 操作”。

### 1.2 Environment 保护

`release-windows`（id `25323688833`）与 `release-linux`（id `25323689512`）：

- `can_admins_bypass=true`
- required reviewer 只有 `D-OneXXX`
- `prevent_self_review=false`
- deployment branch policy：仅受保护分支（当前实际只有 `main` 受保护）
- 两个 Environment 创建于 2026-10-26，之后未修改

真实审批记录：v0.17.2 候选 run `40325710339` 的 actor 与 approver 都是 `D-OneXXX`
（comment `agree`）；最近的 Windows 候选 run 也全部由同一账号触发并批准。
`release-linux` 从未产生过 deployment。

### 1.3 分支、标签与 Actions

- `main` 保护：strict required checks 3 个（Windows、Linux、PR governance），
  `enforce_admins=true`，要求 conversation resolution，禁止 force-push / deletion。
- 父级 branch protection 响应中**没有** `required_pull_request_reviews`；子端点却返回
  `required_approving_review_count=1`；最近的 PR #81 在 0 个 review 的情况下合并。
  因此当前**不能依赖 PR review 作为技术门禁**，只能确认 required checks + 管理员约束生效。
- Tag ruleset `Protect release tags`（id `25802721`）：target `tag`，refs `refs/tags/v*`，
  规则只有 `deletion` + `update`，`bypass_actors=[]`。
  **没有 `creation` 规则**：新 `v*` 标签仍可被有写权限的身份创建。
- Actions：启用，`allowed_actions=all`，默认 workflow 权限 `read`，
  `can_approve_pull_request_reviews=false`；workflow 文件本身已固定 action SHA，
  但仓库策略没有强制 SHA pinning。

### 1.4 工作流与个人令牌的边界

- **没有** 任何 workflow 直接使用维护者的个人 token；Actions 内使用的是自动
  `GITHUB_TOKEN`，候选构建额外使用 Environment 级签名 secret。
- Environment 门禁只出现在：`release-candidate.yml`、`release-candidate-linux.yml`、
  `release-publish.yml`、`release-publish-linux.yml`。
- `release-install-verify.yml` 不使用 Environment；它只读 Draft、产出 artifact，
  不写 Draft。
- `release-publish.yml` 在审批通过后执行 `gh release edit --draft=false`（当前文件
  `:264`），把 Draft 变为公开 Release。
- 个人 token 仅用于 AI 本地 CLI：git push、PR/Issue 写入、`workflow run`、
  Draft 证据上传/下载、Environment/Secret/Ruleset 管理等。
- 因此迁移时要把“AI 本地身份”与“Actions 内部 GITHUB_TOKEN”分开处理；
  现有 CI/QA/candidate 的 Actions 认证本身不需要替换。

### 1.5 发布状态（未改变）

- `v0.17.2` Release 仍为 Draft，7 个资产，`publishedAt=null`；
  `install-verification.json` 摘要仍为
  `sha256:b2f0084855a5dac7b44675dc34f1630907489671c4f50a879a3a3059b5c1bb56`。
- `v0.0.0-rehearsal` Draft 与 Tag 保留。
- 公开更新清单未变：
  - `latest.json`：`64f6038e4dec5c9f12373be3163610d72a8ade72082f7fe4c487d90f0cb11a45`
  - `latest-linux-critical.json`：`2bdb3af5271cc1b5e9dfeb61584a060dcb9d8e0ca8dba4809db9188db682b8e3`
- 最新公开 Release 仍是 `v0.17.1-linux-sec1`（published `2026-10-25T10:15:11Z`）；
  本轮没有 Linux 发布运行。

## 2. 关键风险

### 2.1 同身份自审

当前 AI 与维护者是同一个 GitHub 用户，且 Environment 允许 self-review、允许管理员
绕过。技术上，AI 可以触发 publish 并批准自己的 deployment；目前只有流程约束阻止。

### 2.2 Contents write 可以直接发布 Draft

GitHub 没有独立的 “Releases” 权限；Release 创建/编辑由 **Contents write** 覆盖。
拥有 Contents write 的身份可以绕过 workflow 和 Environment，直接调用
`PATCH /repos/{owner}/{repo}/releases/{id}` 把 `draft=false`。

因此：

- **不能给 AI 身份授予 Contents write**，否则“AI 不能批准正式发布”的设计不成立。
- 候选工作流创建 Draft 所需的 Contents write 应只存在于 Actions job 的
  `GITHUB_TOKEN` 中，由 Environment 审批保护；AI 只负责触发，不持有该 token。

### 2.3 工作流路径 + workflow_dispatch 的绕过（P0）

`workflow_dispatch` 可以在指定 ref 上运行 workflow。如果 AI 同时拥有：

- Actions write（可触发 workflow），以及
- 可写分支的 git 身份（deploy key 或 Contents write），

它就可能推送一个修改过的 `.github/workflows/release-publish.yml`（移除
`environment:` 或加入直接发布步骤），然后在分支上触发该 workflow，绕过 Environment。

仅仅保护 `main` 不够，因为分支本身不受同样的 workflow 内容约束。必须先增加
**push ruleset：`file_path_restriction`**，阻止 AI 身份推送 `.github/workflows/**`
（以及必要的 `.github/actions/**`、`scripts/release-governance/**`），
只允许维护者绕过。没有这个规则前，不应同时授予 Actions write 和写分支能力。

### 2.4 新 Tag 创建

当前 `v*` Tag ruleset 只阻止删除和更新，不阻止创建。可写 git 身份可以创建新
`v*` Tag 指向含修改 workflow 的提交，再在该 Tag 上触发 publish。需要增加
`creation` 规则，并只允许维护者绕过。

### 2.5 证据上传依赖

最终 `install-verification.json` 目前是由 AI 用个人 token 通过
`gh release upload` 上传到 Draft 的。迁移后 AI 没有 Contents write，不能直接上传。
必须选择：

- 一个最小化的 `release-evidence-upload` workflow（job 级 `contents: write`，
  只校验并上传 `install-verification.json`，不做发布），由 AI 触发；或
- 由维护者本人上传。

这个依赖必须在撤销旧 token 前解决，否则候选/发布链路会断。

### 2.6 操作系统级凭据隔离

当前 AI 与维护者在同一 Windows 账号下运行，`gh` keyring 可被同一账号的进程读取。
即使 GitHub 侧换成 App 身份，只要维护者的个人 token 仍在同一 OS 会话/keyring 中，
AI 仍可能读取它。真正的隔离需要：

- 为 AI 使用独立的 Windows 用户/VM/容器；或
- 从 AI 所在环境移除维护者 token，并接受同一 OS 用户下的残余风险。

这是本轮最重要的 **BLOCKED** 项之一。

## 3. 目标设计（未实施）

### 3.1 身份拆分

| 身份 | 用途 | 关键边界 |
|---|---|---|
| 维护者 `D-OneXXX` | 人工审批、Environment 配置、正式发布授权 | 个人 token/浏览器只用于人工操作；不交给 AI |
| GitHub App `mr-release-automation` | 触发 workflow、读写 Issue/PR、读取 run/artifact | **无 Contents write**、无 Deployments/Environments/Secrets/Administration/Workflows write；不能成为 Environment reviewer |
| 写 deploy key | 仅用于推送 `ai/*` 分支 | 不是 API token；不能发布 Release 或批准 deployment；受 ruleset/分支保护约束 |

GitHub App 建议权限：

| 权限 | 级别 | 理由 |
|---|---|---|
| Metadata | Read | 必需 |
| Contents | **Read** | 读取代码；不授予 write |
| Actions | Read and write | 触发 `workflow_dispatch`、读取 run/artifact；不能批准 deployment |
| Issues | Read and write | 开发协作 |
| Pull requests | Read and write | 创建/更新 PR；不应能合并（由 Contents write 缺失和分支保护共同约束，待实测） |
| Deployments | No access | 不参与 deployment |
| Environments | No access | 不能改审批规则 |
| Secrets | No access | 不能读取签名密钥 |
| Administration | No access | 不能改分支保护/ruleset |
| Workflows | **No write** | 避免通过 API 修改 workflow 文件 |

> GitHub App 的 `Contents: write` 等价于 Release 发布能力；不要为了“方便上传证据”
> 而授予它。上传证据走独立 workflow 或人工。

### 3.2 Ruleset

1. **Tag 创建保护**：在现有 `Protect release tags` 中增加 `creation` 规则，
   或新建同范围 ruleset；`refs/tags/v*`，bypass 仅 `D-OneXXX`（User，always）。
   App 和 deploy key 不得在 bypass 列表中。
2. **Workflow 路径保护**：新建 target `push` 的 ruleset，规则类型
   `file_path_restriction`，至少覆盖：
   - `.github/workflows/**`
   - `.github/actions/**`
   - `scripts/release-governance/**`（建议；发布门禁脚本从 main 读取）

   bypass 仅 `D-OneXXX`。`file_path_restriction` 支持 `restricted_file_paths`，
   bypass actor 类型包括 User/Integration/DeployKey；必须确认 App/deploy key
   不在 bypass 中。
3. 现有 Tag 删除/更新规则保持；`bypass_actors=[]` 或仅维护者。

> UI 可用性必须在仓库 Settings → Rules 中实际确认；如果当前账号/仓库计划不支持
> push ruleset 或 Tag creation 规则，则**不能**同时授予 App `Actions: write` 和
> deploy key 写权限。此时退回到“AI 只读代码 + 维护者推送/触发”，不要降低门禁。

### 3.3 Environment 设置

在 App 能触发候选/发布之后，再将两个 Environment 调整为：

- required reviewer：`D-OneXXX`（人类）
- `prevent_self_review=true`
- `can_admins_bypass=false`
- deployment branch policy：仅 `main`（当前“仅受保护分支”实际上等价，但建议显式
  使用 custom branch policy `main`）

注意：

- `prevent_self_review` 可在 REST `PUT /environments/{name}` 中设置；
- `can_admins_bypass` **不在** 文档化的 PUT body 中（OpenAPI 1.1.4 中该字段出现
  0 次，仅 GET 响应可见），必须在 GitHub UI 中取消勾选；
- 如果先开启 `prevent_self_review=true` 而 App 尚未接管触发，维护者将无法批准
  自己触发的候选/发布 run，现有流程会中断。顺序必须是：先让 App 触发，再由
  维护者批准，最后开启 self-review 限制。

### 3.4 目标发布流程

1. AI 用 App installation token 触发 `release-candidate.yml`（`ref=main`）。
2. 候选 job 等待 `release-windows`；维护者在 GitHub UI 批准（actor=App，
   approver=D-OneXXX，不是 self-review）。
3. 候选 job 用 job 级 `GITHUB_TOKEN` 创建/上传 Draft；AI 不持有该 token。
4. AI 触发 `release-install-verify.yml`；证据 artifact 产生。
5. 证据通过独立上传 workflow 或维护者本人写入 Draft。
6. AI 触发 `release-publish.yml`（`ref=main`）。
7. 维护者在 GitHub UI 批准；publish job 用 job 级 `GITHUB_TOKEN` 执行
   `gh release edit --draft=false`。
8. AI 始终没有 Contents write，不能直接 PATCH Release；也没有 Environments/
   Deployments 权限，不能改审批规则或批准 deployment。

### 3.5 令牌处理

- App 私钥：生成后存入 Windows Credential Manager/DPAPI 或 ACL 受限文件；
  不写入仓库、日志、命令行参数或 workflow 环境变量。
- JWT 最长 10 分钟；installation token 最长 1 小时；按需生成，只放在子进程的
  `GH_TOKEN` 中，不执行全局 `gh auth login`。
- deploy key 使用独立 SSH key；通过 `GIT_SSH_COMMAND` 使用，不把 token 放进
  remote URL。
- 旧个人 token：在新身份通过全部验收前保留；通过后才从 AI 环境移除，并按需
  轮换/撤销。维护者本人仍需保留一个用于 GitHub UI 审批的人类会话。

## 4. 验收测试矩阵（设计）

> 所有测试只使用 rehearsal Tag/Draft 或一次性测试 deployment；不得用 v0.17.2
> 正式发布做负向测试。任何 200 的成功发布/批准都视为 P0 失败并立即停止。

| ID | 测试 | 期望 | 证据 |
|---|---|---|---|
| P1 | App 触发 `qa-full.yml` / `release-install-verify.yml` | 204；run 成功；actor=App | run id/url、actor、head_sha |
| P2 | App 触发 rehearsal 候选 | 等待 `release-windows`；维护者批准后仅生成 Draft | deployment、approval user/state |
| P3 | App 触发 `release-publish.yml` on `v0.0.0-rehearsal` | 等待审批；维护者批准后在 rehearsal 校验处失败；不发布 | run conclusion、release isDraft |
| N1 | App 调 `POST .../pending_deployments` 批准 | 403/404；不得 200 | HTTP status/body |
| N2 | App 调 `PATCH /releases/{id}` `draft=false` | 403；Draft 保持 | HTTP status、release 前后 |
| N3 | App 改 Environment/Secret/Ruleset/分支保护 | 403 | HTTP status |
| N4 | App/deploy key push `main` 或创建 `v*` Tag | 拒绝 | git/API 错误 |
| N5 | App/deploy key push 修改 `.github/workflows/**` 的分支 | 被 `file_path_restriction` 拒绝 | git 错误、ruleset |
| P4 | App 推送 `ai/*` 分支并创建 PR；维护者合并 | 成功；App 不能 merge | PR/merge API |
| P5 | 维护者批准 App 触发的 publish rehearsal | 成功；维护者本人触发时被 self-review 拒绝 | approval 记录 |
| P6 | 旧 token 撤销后重跑 CI/QA/候选只读检查 | 不依赖个人 token | run 记录 |

## 5. 迁移顺序与回滚

### 5.1 顺序

0. 只读快照：Environment、rulesets、branch protection、Draft、Tag、PR #82 合并状态。
1. 维护者创建 App 并按 3.1 授权；只安装到 `D-OneXXX/MR`。
2. 生成 App 私钥/记录 App ID、installation ID；存入 AI 的独立安全存储。
3. 创建写 deploy key；先不要授予 App Actions write，先验证 deploy key 的
   branch/tag/path 规则行为。
4. 增加 workflow 路径 ruleset 与 Tag creation 规则；验证 App/deploy key 不能绕过。
5. 将 AI 本地 CLI 切到 App token（独立 `GH_CONFIG_DIR` 或独立 OS 用户）。
6. 跑只读探测与 P1/P4；再跑 P2/P3（维护者批准）。
7. 将 Environment 改为 `prevent_self_review=true`、`can_admins_bypass=false`、
   branch policy `main`；重跑 P5。
8. 跑 N1–N5；确认 App 不能批准/直接发布/改规则。
9. 解决证据上传；确认候选/发布链路完整。
10. 从 AI 环境移除旧个人 token；按需轮换/撤销；保留维护者人类会话。
11. 记录验收证据，更新本报告与状态文档。

### 5.2 回滚

- 停止 App 触发；卸载 App 或删除 deploy key；恢复 Environment 快照；
- 将 AI CLI 暂时切回旧 token（如果尚未撤销）；
- 不删除 v0.17.2 Draft、rehearsal Tag/Draft、PR #82 或历史 Release；
- 如果发生意外发布：立即把 Release 改回 Draft、冻结发布、轮换 App/deploy key，
  保留日志并单独报告，不得静默处理。

## 6. 状态判定

### VERIFIED

- 当前身份、token scopes、admin 权限、协作者、secret 名称等事实；
- 两个 Environment 的 `prevent_self_review=false`、`can_admins_bypass=true`、
  单一 reviewer、仅受保护分支；
- `main` 的 3 个 required checks、`enforce_admins=true`、conversation resolution；
- Tag ruleset 只有 deletion/update，缺 creation；当前只有 `main` 受保护；
- 没有 workflow 使用个人 token；Actions 使用 `GITHUB_TOKEN`/Environment secrets；
- `release-publish.yml` 使用 `gh release edit --draft=false`；
- `release-install-verify.yml` 只读 Draft、不写 Release；
- GitHub App 不能成为 Environment reviewer（reviewer 类型只有 User/Team）；
- `POST pending_deployments` 在 GitHub OpenAPI 中标记
  `enabledForGitHubApps=false`；
- Content write 覆盖 Release 发布，没有独立 Releases 权限；
- `prevent_self_review` 可写；`can_admins_bypass` 不在 REST PUT schema 中；
- `file_path_restriction` push rule 存在，支持 bypass actors；
- 发布面未改变：Draft 仍为 Draft、公开清单哈希不变、无 Linux 发布；
- PR #82 已合并为 `1d63c35`，required checks 全绿，docs-only。

### BLOCKED（需要维护者操作/授权）

1. 创建并安装 GitHub App、生成私钥、提供 App ID/installation ID。
2. 建立写 deploy key，并确保它不在任何 ruleset bypass 中。
3. 增加 `v*` Tag creation 规则和 workflow 路径 push ruleset。
4. 在 App 接管触发后启用 `prevent_self_review=true`、`can_admins_bypass=false`；
   `can_admins_bypass` 只能在 UI 设置。
5. 解决证据上传（最小 workflow 或维护者手动）。
6. 建立 AI 的独立 OS 用户/VM 或至少从 AI 环境移除维护者个人 token；否则
   同一 OS 账号仍可读取 keyring/浏览器凭据。
7. 运行 N1–N5 负向测试并批准 rehearsal 部署。
8. 通过后撤销/轮换旧 token；在此之前不得删除旧凭据。
9. 正式发布仍需维护者单独授权；AI 不得触发/批准 publish。

### NOT_VERIFIED

- GitHub App installation token 对 `POST pending_deployments` 的实际拒绝行为：
  OpenAPI 与 docs 权限表存在冲突；必须用一次性 pending deployment 实测。
- `prevent_self_review` 对 App actor 的具体语义（文档写的是 “users”）。
- deploy key 对 branch protection/tag ruleset/file path ruleset 的端到端行为。
- App 在没有 Contents write 时是否确实不能 merge PR；如果 `Pull requests: write`
  单独就允许 merge，需要补 required PR review/CODEOWNERS，否则 AI 可在无人工
  review 的情况下合并普通代码（workflow/gate 路径已被 ruleset 阻止）。
- App 是否能以 `Actions: write` 成功 dispatch 现有 workflow（预期可以）。
- `can_admins_bypass=false` 保存后的实际效果（需 UI 设置后重读）。
- 当前仓库计划是否支持 push ruleset 的 `file_path_restriction` 与 Tag `creation`
  规则（API schema 存在不等于 UI/计划已开放；必须在 Settings → Rules 中确认）。
  如果不支持，不能同时授予 Actions write 和写分支能力。
- Linux 通道：从未产生 deployment，未做安装/升级/审批测试；保持独立，不随
  Windows 自动发布。

## 7. 需要维护者在 GitHub UI 亲自完成的步骤

1. **创建 App**：GitHub → Settings → Developer settings → GitHub Apps →
   New GitHub App。按 3.1 权限矩阵授权；Webhook 关闭；只安装到 `D-OneXXX/MR`。
2. **生成私钥**：Generate a private key；记录 App ID 和 installation ID；
   私钥存入 AI 专用的安全存储（不要粘贴到聊天、Issue、仓库或日志）。
3. **创建 deploy key**：仓库 Settings → Deploy keys → Add deploy key；
   勾选 Allow write access；使用独立 SSH key；不要加入 ruleset bypass。
4. **Tag ruleset**：Settings → Rules → Rulesets → `Protect release tags`；
   增加 `creation` 规则（`refs/tags/v*`）；bypass 仅 `D-OneXXX`。
5. **Workflow 路径 ruleset**：新建 push ruleset；
   `file_path_restriction` 覆盖 `.github/workflows/**`、`.github/actions/**`、
   `scripts/release-governance/**`；bypass 仅 `D-OneXXX`。
6. **Environment**：Settings → Environments → `release-windows` / `release-linux`；
   required reviewer 保持 `D-OneXXX`；勾选 Prevent self-review；取消
   Allow administrators to bypass；deployment branches 选 Protected branches
   或显式 `main`。**先确认 App 已能触发候选/发布，再保存 self-review 限制。**
7. **证据上传**：批准一个最小 workflow，或由你本人在 install-verify 后上传
   `install-verification.json`；不要把 Contents write 给 App。
8. **AI 本地身份**：为 AI 使用独立 Windows 用户/VM，或至少从 AI 环境移除你的
   个人 token/keyring；将 App 私钥只放在 AI 的安全存储中。
9. **负向测试**：用 rehearsal Tag/Draft 或一次性 deployment 验证 N1–N5；
   不要用 v0.17.2 正式发布测试。
10. **最后撤销旧 token**：全部验收通过后才从 AI 环境移除/轮换；保留你本人
    用于 GitHub UI 审批的人类会话。

## 8. 明确未执行的操作

- 未修改 `release-windows` / `release-linux` 的 reviewer、self-review、admin bypass；
- 未创建/修改任何 Secret、Variable、Ruleset、branch protection；
- 未创建 GitHub App、未生成/读取私钥、未创建 deploy key；
- 未创建测试 deployment、未批准任何 deployment；
- 未修改公开更新清单、未发布 v0.17.2、未触发 Linux 发布；
- 未删除或修改 Draft/Tag/rehearsal 资源。

## 9. 只读复核命令

```bash
# 身份与 scopes（不要输出 token）
gh api user --jq '{login,type,id,site_admin}'
gh api -i user 2>/dev/null | grep -i '^X-OAuth-Scopes:'

# Environment
gh api repos/D-OneXXX/MR/environments/release-windows \
  --jq '{can_admins_bypass,protection_rules,deployment_branch_policy}'
gh api repos/D-OneXXX/MR/environments/release-linux \
  --jq '{can_admins_bypass,protection_rules,deployment_branch_policy}'

# 分支保护与 ruleset
gh api repos/D-OneXXX/MR/branches/main/protection
gh api repos/D-OneXXX/MR/rulesets

# 发布面
gh release view v0.17.2 --json isDraft,publishedAt,assets
gh release view v0.0.0-rehearsal --json isDraft,publishedAt
```

## 10. 参考

- GitHub Docs: [Review pending deployments for a workflow run](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#review-pending-deployments-for-a-workflow-run)
- GitHub Docs: [Manage environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- GitHub Docs: [Create or update an environment](https://docs.github.com/en/rest/deployments/environments?apiVersion=2022-11-28#create-or-update-an-environment)
- GitHub Docs: [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- GitHub Docs: [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- GitHub Docs: [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- 本地只读事实：OpenAPI 1.1.4（`/repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`
  `x-github.enabledForGitHubApps=false`；`file_path_restriction` schema）。
- 相关文档：`docs/dev/RELEASE_APPROVAL_BOUNDARY.md`、`docs/dev/RELEASE.md`、
  `docs/ENGINEERING_WORKFLOW.md`。
