# 发布审批边界审计（只读）

> 审计时间：2026-10-26。本文只记录事实与建议，**不构成远程设置变更**。
> Environment、Secrets、Ruleset、仓库权限的任何变更都需要维护者单独确认。
>
> **2026-10-27 发布后实施更新**：`v0.17.2` 已在维护者个人批准后公开。AI 侧改为
> **local-only**（不持有 GitHub API/git 写凭据），并启用 `v*` Tag creation ruleset；
> write deploy key 因 public user-owned 仓库不支持 push ruleset（API 422）未创建；
> GitHub App 未实施。**不得**给自动化身份 `Contents: write`：它可以直接 `PATCH`
> Draft 为公开 Release，绕过 Environment。完整状态见
> [`PERMISSION_ISOLATION_ACCEPTANCE.md`](./PERMISSION_ISOLATION_ACCEPTANCE.md) §11。

## 1. 结论

历史上的正式发布审批**没有技术隔离**：Agent 使用的 GitHub 身份与维护者相同，且
`release-windows` 允许 self-review、允许管理员绕过。因此当时 Agent 技术上可以触发
`release-publish.yml` 并批准自己的 deployment。`v0.17.2` 发布也使用了这条路径。
2026-10-27 实施后 AI 改为 local-only，不再持有 GitHub token；上述 API/git 自批能力
已被移除。Environment 仍允许维护者 human self-review（未修改）；浏览器/OS 级隔离仍
需要独立执行账号/VM。
它不是密码学或权限系统上的保证。

Windows 安装/升级门禁可以与审批边界分开验收：前者看干净 VM 证据，后者看审批身份。
本文只处理后者。

## 2. 事实与证据

### 2.1 Agent 的凭据

`gh auth status`（不输出 token 明文）：

```text
github.com
  ✓ Logged in to github.com account D-OneXXX (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: <redacted>（本报告不记录令牌值）
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

- 这是维护者本人的 **OAuth token**，不是机器人/App 身份。
- scopes 包含 `repo` 与 `workflow`；Agent 可以触发 workflow、读写 Release 资产。
- Agent 与维护者在 GitHub 上是同一个 user；审计日志无法区分“人点的”与“Agent 点的”。

### 2.2 Environment 保护

`gh api repos/:owner/:repo/environments/release-windows`：

```json
{
  "name": "release-windows",
  "can_admins_bypass": true,
  "protection_rules": [
    {
      "type": "required_reviewers",
      "prevent_self_review": false,
      "reviewers": ["D-OneXXX"]
    },
    {
      "type": "branch_policy",
      "protected_branches": true
    }
  ]
}
```

`release-linux` 的结构相同（reviewer 也是 `D-OneXXX`）。

- `prevent_self_review=false`：触发者可以批准自己的 deployment。
- `can_admins_bypass=true`：管理员可以绕过保护规则。
- required reviewer 只有维护者一人；没有第二个可独立批准的身份。

### 2.3 真实审批记录

v0.17.2 候选 run `40325710339`：

```text
actor=D-OneXXX
triggering_actor=D-OneXXX
environment=release-windows
approval.user=D-OneXXX
approval.state=approved
approval.comment=agree
```

这条记录说明维护者本人确实批准过候选 deployment；也说明同一身份同时是
trigger actor 与 approver 时，系统不会阻止。publish 流程将来同样如此。

### 2.4 现有代码级缓解

`release-publish.yml` 现在包含：

- `verify-provenance.mjs`：在线核验安装证据指向的 GitHub Actions run 是真实的、
  `workflow_dispatch` 触发、跑在 `main` 上、成功完成且证据时间在 run 窗口内；
- `Audit deployment approval boundary`：只读记录本次 run 的 actor 与 deployment
  approver；相同身份时打印 warning 并写入 job summary；
- 这些步骤**不改变** Environment 审批结构，也不阻止同身份自批。

## 3. 风险场景

1. **Agent 触发 + Agent 批准**：Agent 用 `gh workflow run release-publish.yml` 触发，
   再用 `gh api` 批准 `release-windows` deployment；发布继续。当前流程约束是唯一障碍。
2. **维护者触发 + Agent 批准**：维护者触发后离开；Agent 发现 pending deployment 并
   批准。由于 approver 与 actor 都是 `D-OneXXX`，系统无法区分。
3. **Agent 修改审批步骤**：Agent 有 `repo`/`workflow` scope，理论上可以走 PR 修改
   workflow；`main` 的 required checks 与 PR 治理会阻止直接推送，但 Agent 与维护者
   同身份，仍可能自行合并。这不是本审计要解决的主路径，但说明“同身份”是根问题。

## 4. 推荐变更（按强度排序，均未执行）

### 方案 A（推荐）：自动化身份 + 人类 reviewer 技术隔离

目标：Agent 以**非 reviewer 身份**触发；维护者以自己的身份批准；Agent 无法批准，
也无法绕过 workflow 直接发布。

**硬约束：不要给自动化身份 `Contents: write`。** GitHub 没有独立的 Releases 权限，
Release 创建/编辑由 Contents write 覆盖；拥有该权限的身份可以调用
`PATCH /repos/{owner}/{repo}/releases/{id}` 把 `draft=false`，不经过 workflow 或
Environment。`Contents: write` 同时也允许改 workflow 文件和 Tag，因此不能靠
“严格 PR review”来抵消 API 直发。

1. 为自动化创建 GitHub App（或一个只用于自动化的 bot 账号），只安装到本仓库。
   - `Metadata: read`（必需）
   - `Contents: read`（只读；**不要 write**）
   - `Actions: read/write`（触发 `workflow_dispatch`、读取 run/artifact）
   - `Issues: read/write`、`Pull requests: read/write`
   - **不要**给 `Contents` write、`Workflows` write、`Administration`、
     `Environments`、`Secrets`、`Deployments` 写权限。
   - App 不能作为 Environment required reviewer（GitHub 的 reviewer 类型只有
     User/Team）；REST 的 `POST .../pending_deployments` 在 OpenAPI 中还标记为
     `enabledForGitHubApps=false`。两条独立信号都指向“App 不能批准”，但仍需用
     一次性 pending deployment 实测（见验收报告 N1）。
2. 写代码使用**独立的 write deploy key**（SSH），只推送 `ai/*` 分支；deploy key
   不是 API token，不能发布 Release 或批准 deployment。它必须不在任何 ruleset
   bypass 中。
3. 在授予 App `Actions: write` / deploy key 之前，先增加：
   - `v*` Tag 的 **creation** 规则（当前 ruleset 只有 deletion/update）；
   - target `push` 的 `file_path_restriction` ruleset，覆盖
     `.github/workflows/**`、`.github/actions/**`、`scripts/release-governance/**`；
   - bypass 仅维护者 `D-OneXXX`，App/deploy key 不得 bypass。
   否则 App 可以在分支上改掉 publish workflow 的 `environment:` 再触发，绕过审批。
   如果当前仓库计划不支持上述规则，**不要**同时授予 Actions write 与写分支能力；
   退回“AI 只读代码 + 维护者推送/触发”。
4. `release-windows` / `release-linux`（在 App 已能触发后）：
   - required reviewer 保持 `D-OneXXX`（或维护者控制的团队）；
   - `prevent_self_review=true`；
   - `can_admins_bypass=false`；
   - deployment branch policy 设为仅 `main`（或保持当前仅受保护分支；当前只有
     `main` 受保护）。
5. Agent 改用 App installation token（短生命周期）执行触发；维护者的个人 token
   不再提供给 Agent。App 没有 Contents write，因此不能上传 Draft 证据；证据上传
   必须走一个只写 `install-verification.json` 的最小 workflow，或由维护者本人完成。
6. 新的发布流程：
   - Agent（App 身份）触发 `release-candidate.yml` / `release-publish.yml`；
   - 维护者在 GitHub UI 批准 `release-windows`（actor=App ≠ approver=D-OneXXX）；
   - 候选/发布 job 用 job 级 `GITHUB_TOKEN` 创建 Draft 和 `gh release edit --draft=false`；
   - Agent 不持有该 token，不能批准 deployment，也不能直接 PATCH Release。

影响：

- PR/候选/QA CI 不经过 Environment，不需要改动，不受影响。
- 只有候选/发布的触发身份变化；维护者仍需本人批准。
- `prevent_self_review=true` 不能再让维护者批准自己触发的 run；必须由 App 触发
  候选/发布，或另设第二个人类 reviewer。顺序不能颠倒，否则现有候选流程立刻中断。
- `can_admins_bypass` 不在 REST 的 Environment PUT body 中（OpenAPI 里该字段出现
  0 次，仅 GET 可见），只能在 GitHub UI 取消勾选。
- 需要维护者创建 App/安装/配置，并建立 AI 的独立 OS 凭据环境；同一 Windows
  账号下 keyring 仍可能被 AI 读取，这是残余风险。

### 方案 B（次选）：第二个人类 reviewer 账号

1. 维护者控制第二个 GitHub 账号（2FA、与主账号分开保存凭据），给仓库 read 权限。
2. `release-windows` / `release-linux` 的 required reviewer 只保留第二账号；
   `prevent_self_review=true`；`can_admins_bypass=false`。
3. Agent 继续用主账号触发；维护者用第二账号批准。

优点：不需要 GitHub App。缺点：多一个账号的凭据管理；主账号不能批准，操作上更繁琐。

### 方案 C（仅补充）：Agent 使用细粒度 PAT

1. fine-grained PAT 属于某个用户，不是独立机器人身份；它仍可能被加为 reviewer，
   审计上也仍是一个人类账号。它不能替代 A/B 的身份隔离。
2. **带 Contents write 的 PAT 仍可直接 PATCH Draft 发布**；不带 Contents write
   又无法推送代码/上传 Draft 证据。因此它不能同时满足“可开发”和“不能发布”。
3. 只有在没有条件创建 App 时，才考虑“PAT 只读/Actions write + 维护者手动发布”，
   并把 Deployments/Environments/Administration/Secrets 全部排除。
4. 旧 PAT 不应长期驻留；新身份验证通过后再撤销。

### 方案 D（不推荐作为唯一措施）

仅依赖“Agent 承诺不批准”。它不能阻止错误、被诱导或凭据泄漏；本轮已明确不使用它作为
正式发布的技术保证。

## 5. 对现有 CI 的影响

- `.github/workflows/ci-windows-check.yml`、`ci-linux-check.yml`、`qa-full.yml`：
  不使用 Environment 审批；不受方案 A/B/C 影响。
- `release-candidate.yml` / `release-candidate-linux.yml`：使用 Environment 做候选阶段
  审批；如果启用 `prevent_self_review=true`，触发者不能批准自己的候选 deployment。
  需要确认候选流程由谁触发：若 Agent 触发，维护者仍可批准（actor=Agent/App）；
  若维护者自己触发，则需第二身份批准。方案 A 的 App 触发可保持候选流程顺畅。
- `release-publish.yml` / `release-publish-linux.yml`：审批身份变化是目标；发布门禁
  （绑定/签名/证据/provenance）不变。
- 本轮没有修改任何远程设置、Secret、Ruleset 或 Linux 工作流。

## 6. 维护者需要亲自完成的最小操作（建议顺序）

**顺序不能颠倒**：先建 App/deploy key 与 ruleset，再让 App 触发候选/发布，确认维护者
能批准 App 触发的 run，最后才开启 `prevent_self_review` 和关闭 admin bypass。否则
维护者将无法批准自己触发的候选/发布 run，现有流程会立即中断。

1. 决定采用 A、B 或 C；优先 A。创建 App/第二账号，只授予最小权限；App 不要
   Contents write，不加入任何 bypass 列表。
2. 创建写 deploy key；先验证 push 分支、`main`、Tag、workflow 路径规则的行为。
3. 增加 `v*` Tag creation 规则和 workflow 路径 `file_path_restriction` ruleset；
   bypass 仅维护者。
4. 把 AI 本地 CLI 切到 App installation token；在 AI 的独立 OS 用户/VM 或独立
   `GH_CONFIG_DIR` 中运行，确认它不能读取维护者的个人 token。
5. 重新跑一次候选/演练，验证：
   - Agent 触发候选/publish 后，维护者能批准；
   - Agent 自己调用 approve 时被拒绝（用测试 deployment 验证，不要用正式发布试）；
   - Agent 直接 PATCH Draft、改 Environment/Secret/Ruleset、推送受保护 ref 均被拒绝。
6. 确认无误后再配置 Environment：
   - required reviewer 指向人类身份；
   - 在 UI 勾选 `Prevent self-review`；
   - 在 UI 取消 `Allow administrators to bypass configured protection rules`；
   - deployment branch policy 设为 `main`。
   `can_admins_bypass` 没有文档化的 REST 写字段，不能靠 API 自动完成。
7. 解决证据上传（最小 `install-verification.json` 上传 workflow，或维护者手动上传）。
8. 通过后才从 AI 环境移除旧个人 OAuth token；不要删除维护者用于 GitHub UI 审批的
   人类会话。正式发布仍需维护者单独授权；Agent 不触发、不批准 publish deployment。

## 7. 复核命令（只读）

```bash
# 身份与 scopes（不要输出 token）
gh api user --jq '{login,type,id,site_admin}'
gh api -i user 2>/dev/null | grep -i '^X-OAuth-Scopes:'

# Environment / 分支保护 / ruleset
gh api repos/:owner/:repo/environments/release-windows
gh api repos/:owner/:repo/environments/release-linux
gh api repos/:owner/:repo/branches/main/protection
gh api repos/:owner/:repo/rulesets

# 审批记录与发布面
gh api repos/:owner/:repo/actions/runs/<run-id>/approvals
gh release view v0.17.2 --json isDraft,publishedAt,assets
```

不要输出 token 明文；不要把 approval API 的写操作放进 Agent 的自动化脚本。

## 8. 2026-10-27 发布后实施补充

- `v0.17.2` 已公开（`publishedAt=2026-10-26T21:10:06Z`，run `40385949803`）；
  发布时 actor/approver 仍为 `D-OneXXX`，这条历史自审风险已记录。
- 当前 AI 改为 **local-only**：无 GitHub API token、无 deploy key、无 App token；
  远端 push/PR/CI/发布由维护者完成。维护者仍需在 UI 自行审批后续发布。
- 已增加 `Protect release tag creation` ruleset（id `25915443`，`refs/tags/v*`，
  bypass 仅 `D-OneXXX`）；现有 tag update/delete ruleset 保持。
- **write deploy key 未采用**：public user-owned 仓库不支持 push ruleset（API 422）；
  deploy key 分支可注入新 workflow，形成绕过 Environment 的 P0 路径。
- GitHub App 未采用：创建/安装/私钥需要维护者 UI；且当前同一 Windows 账号无法证明
  浏览器/OS 级隔离。App 仍作为未来可选方案。
- `can_admins_bypass` 只能通过 UI 设置；REST 的 Environment PUT body 没有该字段。
- `POST .../pending_deployments` 对 App 的行为仍需未来 App 方案实测。
- 当前 main 的父级 branch protection 没有 `required_pull_request_reviews`，近期 PR
  在 0 review 下合并；local-only AI 无 merge 权限，人工合并仍由维护者负责。
- 公开 Release 说明仍含旧“Draft”文案（P2，未修改 release artifact）；完整状态、
  测试矩阵、迁移/回滚见
  [`PERMISSION_ISOLATION_ACCEPTANCE.md`](./PERMISSION_ISOLATION_ACCEPTANCE.md)。
