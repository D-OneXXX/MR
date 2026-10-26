# 发布审批边界审计（只读）

> 审计时间：2026-10-26。本文只记录事实与建议，**不构成远程设置变更**。
> Environment、Secrets、Ruleset、仓库权限的任何变更都需要维护者单独确认。

## 1. 结论

当前正式发布审批**没有技术隔离**：Agent 使用的 GitHub 身份与维护者相同，且
`release-windows` 允许 self-review、允许管理员绕过。因此 Agent 技术上可以触发
`release-publish.yml` 并批准自己的 deployment。当前只有“Agent 不批准”的流程约束；
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
  - Token: gho_************************************
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

目标：Agent 以**非 reviewer 身份**触发；维护者以自己的身份批准；Agent 无法批准。

1. 为自动化创建 GitHub App（或一个只用于自动化的 bot 账号），安装到仓库。
   - 权限尽量小：`Contents: read/write`（Release 资产/分支）、`Actions: write`
     （手动触发 workflow）、`Issues: write`、`Pull requests: write`、`Metadata: read`。
   - **不要**给 `Administration`、`Environments`、`Deployments` 写权限。
   - App 不能作为 Environment required reviewer（GitHub 的 reviewer 是 user/team），
     所以它天然无法批准 deployment。
2. `release-windows` / `release-linux`：
   - required reviewer 保持 `D-OneXXX`（或维护者控制的团队）；
   - `prevent_self_review=true`；
   - `can_admins_bypass=false`；
   - deployment branch policy 保持 protected branches。
3. Agent 改用 App installation token（短生命周期）执行触发/上传等操作；维护者
   的 `gho_` token 不再提供给 Agent。
4. 新的发布流程：
   - Agent（App 身份）触发 `release-publish.yml`；
   - 维护者在 GitHub UI 批准 `release-windows`（actor=App ≠ approver=D-OneXXX）；
   - Agent 无法批准（App 不是 reviewer），维护者的个人 token 不在 Agent 手里。

影响：

- PR/候选/QA CI 不经过 Environment，不需要改动，不受影响。
- 只有 publish 的触发身份变化；维护者仍需本人批准。
- 需要维护者创建 App/安装/配置，并把 installation token 交给 Agent 的方式确定下来
  （短期 token 由维护者生成，或用受控的 CI 步骤）。

### 方案 B（次选）：第二个人类 reviewer 账号

1. 维护者控制第二个 GitHub 账号（2FA、与主账号分开保存凭据），给仓库 read 权限。
2. `release-windows` / `release-linux` 的 required reviewer 只保留第二账号；
   `prevent_self_review=true`；`can_admins_bypass=false`。
3. Agent 继续用主账号触发；维护者用第二账号批准。

优点：不需要 GitHub App。缺点：多一个账号的凭据管理；主账号不能批准，操作上更繁琐。

### 方案 C（补充）：Agent 使用细粒度 PAT

1. 为 Agent 新建 fine-grained PAT：Contents read/write、Issues/PR write、
   Actions read（如需触发再评估 Actions write）；**不含** Deployments/Environments/
   Administration 写权限。
2. 从 Agent 环境移除维护者的 `gho_` token。
3. 验证该 PAT 不能调用 deployment approve API；如果 GitHub 把 approve 归到
   `Actions: write`，则 Agent 不能触发 workflow，由维护者手动触发。

这是“降低权限面”的补充，不是完整的身份隔离；最好与 A/B 组合。

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

1. 决定采用 A、B 或 C；如果采用 A/B，创建对应的 App/第二账号并配置 Environment：
   - required reviewer 指向人类身份；
   - `prevent_self_review=true`；
   - `can_admins_bypass=false`。
2. 从 Agent 环境移除维护者个人 `gho_` token，换成 App/PAT 身份；确认 Agent 不能调用
   deployment approve。
3. 重新跑一次候选/演练，验证：
   - Agent 触发 publish 后，维护者能批准；
   - Agent 自己调用 approve 时被拒绝（用测试 deployment 验证，不要用正式发布试）。
4. 在完成前，正式发布只能由维护者本人从 GitHub UI 触发并批准；Agent 不触发、
   不批准 publish deployment。

## 7. 复核命令（只读）

```bash
gh auth status
gh api repos/:owner/:repo/environments/release-windows
gh api repos/:owner/:repo/environments/release-linux
gh api repos/:owner/:repo/actions/runs/<run-id>/approvals
git diff -- .github/workflows/release-publish.yml
```

不要输出 token 明文；不要把 approval API 的写操作放进 Agent 的自动化脚本。
