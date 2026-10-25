# MangaReader 工程治理流程 V1.0

> 本文件是 MangaReader 的工程治理入口，与 `AGENTS.md` 同时生效。
> `AGENTS.md` 负责架构、隐私、数据与产品不变量；本文件负责任务、分支、质量门禁与发布治理。
> 两者冲突时，以更严格、更保护用户数据与发布安全的一方为准。
>
> 当前状态：Phase 1（治理骨架）。Phase 4 发布改造完成前，**禁止推送任何 `v*` 发布标签**。

---

## 1. 事实来源

| 对象 | 唯一事实来源 | 说明 |
|---|---|---|
| 代码状态 | Git | 以 `main` 与受保护标签为准；不得用对话历史替代 |
| Bug / 任务 | GitHub Issues | 一个可执行任务一个 Issue |
| 任务状态 | Issue 标签 + Assignee | 见第 3 节；不另建多份状态文档 |
| 测试结果 | CI Run / QA Report | 必须能绑定 Commit；手写数字不算证据 |
| 发布版本 | GitHub Release + Tag | 版本号单一事实源仍是 `package.json` |
| 项目快照 | `docs/PROJECT_STATE.md` | 由 `npm run status` 生成，不手工编辑 |
| 技术架构 | `AGENTS.md` + `docs/TECHNICAL.md` | `AGENTS.md` 优先 |
| Agent 行为 | `AGENTS.md` + 本文件 | 新 Agent 必须先读两份 |

GitHub Projects 不是当前必需依赖。若未来启用，只能作为 Issue 的视图，不得成为与 Issues 冲突的第二状态源。

---

## 2. 角色与写入权

- **维护者（用户）**：唯一正式发布批准人；决定版本、发布范围、签名与高风险设置。
- **主 Agent / 集成者**：拆分任务、指派所有权、集成 PR、维护状态快照。
- **实施 Agent**：只修改被指派 Issue 范围内的文件；一个文件同一时间只有一个写者。
- **只读审计 Agent**：可以读代码、Issue、CI、Release；不得修改文件或远程状态。

硬规则：

1. 一个 Issue 同一时间只有一个代码修改负责人。
2. 一个文件同一时间只允许一个 Agent 写；重叠时先拆分或串行。
3. Agent 不得覆盖他人的未提交修改，不得使用 `git stash`、`git checkout --`、强制推送清理他人工作。
4. 冲突必须写进 Issue 或 PR；不得用强制覆盖解决。
5. 执行前同步真实仓库；执行后更新 Issue 状态。
6. 不把对话历史当作唯一状态；能从 Git/Issue/CI/Release 读取的事实必须读取。

---

## 3. Issue 生命周期

标准路径：

```text
NEW → TRIAGED → REPRODUCING → IN_PROGRESS → TESTING → REVIEW
    → MERGED → RELEASE_PENDING → RELEASED → VERIFIED → CLOSED
```

异常状态：

- `BLOCKED`：有明确阻塞，记录阻塞原因与解除条件。
- `DUPLICATE`：关联原 Issue 后关闭。
- `CANNOT_REPRODUCE`：记录环境、尝试步骤与缺失证据，不编造根因。
- `WONT_FIX`：记录范围/成本/风险决定。
- `REOPENED`：从 `CLOSED`/`VERIFIED` 回到 `REPRODUCING` 或 `TRIAGED`。

进入条件：

| 状态 | 进入条件 |
|---|---|
| NEW | Issue 已创建，未分级 |
| TRIAGED | 已确认范围、严重度、区域与是否重复 |
| REPRODUCING | 有负责人，正在复现并收集证据 |
| IN_PROGRESS | 可稳定复现或问题明确，已有分支/Worktree |
| TESTING | 修复完成，回归测试与定向测试已运行 |
| REVIEW | PR 已创建，CI 已启动或通过 |
| MERGED | PR 已合并且 CI 通过 |
| RELEASE_PENDING | 已进入发布候选/Draft，等待审批 |
| RELEASED | 已包含在公开 Release 中 |
| VERIFIED | 发布后安装/升级/关键功能验证通过 |
| CLOSED | 无需继续跟踪 |

每次状态变化必须同时更新对应标签；不要让标签与 Issue 描述互相矛盾。

---

## 4. 严重度

| 级别 | 定义 | 处理 |
|---|---|---|
| P0 | 数据损坏、重大安全漏洞、广泛无法启动 | 立即停止其他工作，Hotfix 评估 |
| P1 | 核心功能不可用、频繁崩溃、隐私/更新通道失效 | 优先处理，进入发布阻塞 |
| P2 | 一般功能错误 | 正常队列，可进入下一补丁 |
| P3 | 轻微 UI、交互、文本问题 | 批量处理 |
| P4 | 功能建议或优化 | 进入需求池，不阻塞发布 |

严重度由维护者/主 Agent 定级，不依赖报告者自评。P0/P1 必须标记 `release:blocker`，除非维护者明确接受风险。

---

## 5. 分支、Worktree 与认领

命名：

```text
fix/<issue-id>-<slug>
feat/<issue-id>-<slug>
hotfix/<issue-id>-<slug>
chore/<issue-id>-<slug>
```

Worktree：

```bash
git worktree add .worktrees/issue-<id>-<slug> -b <type>/<id>-<slug> main
```

规则：

1. 先确认 Issue 未被他人认领；认领方式为 Assignee + `status:in-progress`。
2. 认领冲突时，以较早的 assignment 记录为准；后来者停止并记录，不得并行改同一文件。
3. 每个任务独立 Worktree；不得在主工作区混入多个任务的未提交修改。
4. 分支只包含本 Issue 的变更；不把多个无关 Bug 混入同一个 PR。
5. 不使用强制推送；不删除他人分支；不主动改写历史。
6. 子 Agent 完成任务后报告：分支、Worktree、修改文件、测试证据、未决风险；主 Agent 负责集成。

---

## 6. 跨对话恢复

任何新 Agent 启动按顺序执行：

1. 阅读 `AGENTS.md` 与本文。
2. 运行 `npm run status`，读取 `docs/PROJECT_STATE.md`。
3. 运行 `git status --short`、`git branch -vv`、`git worktree list`。
4. 读取相关 Issue、PR、最近 CI 与最新 Release。
5. 检查是否有 `status:blocked` / `release:blocker`。
6. 确认认领与文件所有权，再开始修改。

状态文件中 `UNKNOWN` 表示当前环境无法验证，不是“正常”。不得把 `UNKNOWN` 当作通过。

---

## 7. PR 与自动合并

每个 PR 必须包含：

- 关联 Issue：`Closes #N` 或 `Refs #N`（Dependabot 例外）。
- 变更范围与不做的范围。
- 复现/回归测试，或说明为什么无法自动化。
- 平台影响（Windows / Linux / 两者）。
- 数据影响（书库、进度、SQLite、备份、缓存、文件删除）。
- 发布影响（版本、Updater、签名、安装器、文档）。
- 实际执行的命令与结果。
- 风险与回滚方式。

允许自动合并的条件（全部满足）：

1. PR 只包含关联 Issue 的范围，无无关改动。
2. required checks 全部通过，且针对最新 base Commit。
3. 无冲突、无未解决 review thread。
4. 不涉及未获授权的发布、签名、Tag 或生产数据迁移。
5. 不包含 P0/P1 未解释风险；数据迁移有专门测试。
6. 版本策略满足：已发布版本不得复用 Tag；需要 bump 时同步全部版本文件。

PR 元数据门禁（`ci-pr-governance.yml`，required check）：

- 非 Dependabot/Renovate 的 PR 必须关联 Issue（`Closes/Fixes/Resolves/Refs #N`）。
- 分支必须形如 `fix|feat|hotfix|chore/<issue>-<slug>`，编号必须与关联 Issue 一致。
- PR 必须包含非空的「验证」「数据与隐私」「发布影响」段落。
- PR 必须指向 `main`。
- Dependabot / Renovate / `*[bot]` 自动跳过。
- 校验脚本从 base SHA 读取；不在 PR 代码中执行校验器。

任一条件不满足：停下来记录 `BLOCKED`，请求用户决定。

---

## 8. 质量门禁

### PR 门禁

- 版本检查与版本测试。
- TypeScript 类型检查、生产构建。
- Rust 单元测试、集成测试。
- Linux `cargo check --all-targets`、clippy。
- 静态 QA。
- 治理脚本测试（`npm run test:governance`）。
- 依赖审计可见；高危项需处置。
- 数据/隐私/更新通道变更需对应静态守卫与回归测试。

### Release Candidate 门禁

- 固定 Commit、固定依赖。
- 完整 QA 在 CI 上运行，报告绑定 Commit，保存 artifact。
- Windows 安装/覆盖升级、Linux 包安装/启动、数据保留。
- 签名、清单、SHA-256 校验。
- Release Notes、Known Issues、回滚说明。
- 未验证项写 `UNKNOWN`/`BLOCKED`，不得用本地手写数字替代。

禁止：

- 删除测试、改测试使其永远通过、跳过失败检查、隐藏错误。
- 无理由降低断言、用 Mock 替代必要的真实集成测试。
- 用“已本地验证”替代可追溯证据；例外必须由用户批准并记录。

---

## 9. 版本与发布治理

### 9.1 版本

- `package.json` 是唯一版本源；使用 `npm run version:sync -- X.Y.Z`。
- 已发布版本不得重打 Tag；下一次修复用新的补丁版本。
- 每次发布前运行 `npm run version:check` 与 `npm run test:version`。

### 9.2 发布候选与 Draft

目标流程（Phase 4 实施）：

```text
固定 Commit → 全量 QA → 构建/签名 → 上传 Draft Release → 人工审批 → 发布
```

准备阶段：

- 不推送会触发发布的 `v*` Tag。
- 不公开 Release、不更新 `latest.json`/`latest-linux-critical.json`。
- Draft 必须包含全部资产、校验值、Release Notes、Known Issues。

### 9.3 人工批准

- 正式发布必须由用户明确批准。
- 批准绑定：版本、Commit SHA、制品 SHA-256、目标平台。
- 一次批准只对一个版本有效；不得延伸为后续版本授权。
- 审批门禁优先使用 GitHub Environment required reviewer；签名密钥应放在该 Environment。

### 9.4 Windows / Linux

- Windows：NSIS 正式更新通道，`latest.json`。
- Linux：长期稳定高危补丁通道，`latest-linux-critical.json`；deb/rpm 由包管理器安装，AppImage 才允许应用内替换。
- 两个通道独立触发、独立审批；不得因 Windows 发布自动发布 Linux，反之亦然。
- 保持现有公开更新端点不变；双清单接力机制在 Phase 4 继续保留并加并发保护。

### 9.5 发布后

- 下载并校验资产、安装/覆盖升级、启动、数据库与进度、更新面板、版本展示。
- 通过后才把 Issue 从 `RELEASED` 改为 `VERIFIED`，再 `CLOSED`。
- P0/P1 事故：暂停推广、保护数据、评估 Hotfix，不默认认为安装旧版就是安全回滚。

---

## 10. 当前发布安全暂停

**Phase 1–3 期间不得推送任何 `v*` Tag。**

原因：当前 `release-windows.yml` 与 `release-linux-critical.yml` 会在 Tag 推送后直接发布，且没有人工审批环境。Phase 4 完成 Draft/审批改造并获用户批准前，任何发布 Tag 都可能立即改变公开更新通道。

允许：本地构建、CI 验证、静态 QA、生成候选制品到本地或 Draft（在修改工作流后）。
禁止：`git push origin v*`、创建会触发发布的 Release、修改公开更新清单。

当前已知发布阻塞（Phase 4 必须解决）：

- `GITHUB_TOKEN` 创建 Release 被拒，当前依赖管理员预建；根因待确认。
- 发布公开时间早于资产上传，存在更新清单空窗。
- v0.17.1 发布使用未绑定 Commit 的本地 QA 声明。
- 已发布 v0.17.1 不含 `main` 上后续的隐私/更新自检修复；下一次发布前必须 bump。

---

## 11. 仓库设置基线

以下设置涉及远程权限与安全，需用户授权后执行；未执行前，Agent 不得用管理员直推绕过门禁。

| 设置 | 当前 | 目标 | 状态 |
|---|---|---|---|
| `main` required checks | Windows + Linux | 保留并补治理测试 | 已具备 |
| `enforce_admins` | false | true（常规改动走 PR） | 待授权 |
| required reviews | 无 | 不要求人工 review（AI 自动合并）；发布单独审批 | 待确认 |
| 发布 Environment | 无 | `release` + required reviewer + 签名 Secret | Phase 4 |
| Secret scanning / push protection | 关闭 | 开启 | 待授权 |
| Dependabot security updates | 关闭 | 开启 | 待授权 |
| Actions 引用 | 可变 Tag | 固定 SHA | Phase 3 |
| 发布 concurrency | 无 | 按通道加 concurrency | Phase 4 |

---

## 12. 文档与状态

- 本文件是唯一工程流程文档；不要新增 `agent-status.md`、`bug-status.md`、`release-status.md`、`current-phase.md`。
- `docs/PROJECT_STATE.md` 由脚本生成，保留一个快照即可。
- 涉及 UI/后端/发布行为的变更，按 `AGENTS.md` 同步六语、QA、`docs/TESTING.md`、`docs/TECHNICAL.md` 与 `docs/dev/RELEASE.md`。
- README 继续面向产品用户；内部流程只引用本文件，不复制全文。

---

## 13. Phase 计划与验收

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 只读审计 | 已完成，用户已确认 |
| 1 | 治理骨架：Issue/分支/Worktree/状态/PR 模板 | 已完成（PR #14） |
| 2 | Bug 生命周期与自动修复流程 | 已完成门禁与单 Bug 演练（PR #20/#22、#21） |
| 3 | 质量门禁与安全扫描 | 下一阶段（#18 glib、#23 chaos/CDP） |
| 4 | RC / Draft / 审批 / 双通道发布 | 待开始 |
| 5 | 发布后验证、Hotfix 与回滚 | 待开始 |
| 6 | 隔离演练，不触发真实发布 | 待开始 |

Phase 2 收尾于 2026-10-26：PR 元数据 required check 已生效；下一步先处理 #18（glib 风险接受/升级）与 #23（QA flake），再进入 Phase 3 的完整质量门禁。

Phase 1 验收：

- 新 Agent 能从本文件 + 状态快照恢复方向。
- Issue/分支/Worktree/One Writer 规则清晰。
- 标签体系可同步且可检查。
- PR 模板能约束范围、测试、数据与发布影响。
- 不改变产品行为、不发布、不改公开更新端点。
- 治理脚本测试、版本检查与静态 QA 通过。
