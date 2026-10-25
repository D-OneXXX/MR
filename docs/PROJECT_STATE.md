# MangaReader 项目状态

> 生成时间：2026-10-25T19:15:57.831Z
> 本文件由 `npm run status` 生成，请勿手工编辑。
> `UNKNOWN` 表示当前环境无法验证，不代表正常。

## 1. 版本与维护阶段

| 项目 | 值 |
|---|---|
| package.json | `0.17.1` |
| 最新 Release | `v0.17.1-linux-sec1`（0.17.1） |
| 最新 Windows Release | `v0.17.1`（0.17.1）；HEAD 领先 7 个提交 |
| 最新 Linux critical Release | `v0.17.1-linux-sec1`（0.17.1）；HEAD 领先 4 个提交 |
| HEAD 距最新 Release | 4 个提交 |
| 当前阶段 | 开发中（与最新发布同版本） |
| 判定依据 | HEAD 领先最新发布 4 个提交，但版本号仍为 0.17.1。下一次发布前必须 bump。 |

## 2. 仓库与工作区

| 项目 | 值 |
|---|---|
| 分支 | `chore/13-phase-1-governance` |
| HEAD | `547cada6eefa` |
| 提交 | chore(governance): 建立 Phase 1 工程治理骨架 |
| 提交时间 | 2026-10-26T03:10:11+08:00 |
| 工作区 | 干净 |
| 本地分支 | `chore/13-phase-1-governance`, `main`, `wip/main-telegram-20261023` |
| 已注册 Worktree | `manga-reader-tauri`（chore/13-phase-1-governance） |

## 3. 质量门禁

- GitHub 数据：可用

| 检查 | 状态 | 结论 |
|---|---|---|
| cargo check + frontend build (ubuntu-22.04) | completed | success |
| tsc + cargo test + static QA (windows-latest) | completed | success |

- 分支保护：enforce_admins=true
- required checks：tsc + cargo test + static QA (windows-latest), cargo check + frontend build (ubuntu-22.04)
- required reviews：非必需
- force push：禁止；deletion：禁止

- 发布审批环境：未配置

## 4. 活跃 Issue

| # | 标题 | 状态 | 严重度 | 负责人 |
|---|---|---|---|---|
| #15 | 依赖安全：处置 8 个 Dependabot 告警（1 high / 4 medium / 2 low） | status:triaged | severity:p2 | — |
| #13 | Phase 1: 建立工程治理骨架 | status:in-progress | severity:p2 | D-OneXXX |

## 5. 开放 PR

| # | 标题 | 分支 | 状态 |
|---|---|---|---|
| #16 | build(deps): bump react-router and react-router-dom | dependabot/npm_and_yarn/multi-ab7d3a7fa5 | Open |
| #14 | chore(governance): 建立 Phase 1 工程治理骨架 | chore/13-phase-1-governance | Open |

## 6. 最近 CI

| Workflow | 事件 | 分支 | 状态 | 结论 |
|---|---|---|---|---|
| Linux check | pull_request | dependabot/npm_and_yarn/multi-ab7d3a7fa5 | completed | success |
| Windows check | pull_request | dependabot/npm_and_yarn/multi-ab7d3a7fa5 | in_progress | — |
| npm_and_yarn in /. for vite - Update #1651875149 | dynamic | main | completed | failure |
| cargo in /src-tauri for lru - Update #1651875154 | dynamic | main | completed | failure |
| npm_and_yarn in /. for react-router - Update #1651875144 | dynamic | main | completed | success |

## 7. 最近 Release

| Tag | 名称 | 类型 | 发布时间 |
|---|---|---|---|
| v0.17.1-linux-sec1 | MangaReader v0.17.1-linux-sec1 (Linux critical) | Published | 2026-10-25T10:15:11Z |
| v0.17.1 | MangaReader v0.17.1 | Published | 2026-10-25T09:48:51Z |
| v0.17.0 | MangaReader v0.17.0 | Published | 2026-10-25T02:45:44Z |

## 8. 阻塞项与下一步

### 治理告警

- 未配置发布审批环境；Phase 1–3 禁止推送发布 Tag。
- 最新版本已发布但 HEAD 仍有未发布提交；下一次发布前必须 bump。
- Windows 常规通道落后 HEAD 7 个提交。
- Linux critical 通道落后 HEAD 4 个提交。

### 阻塞项

无已知阻塞项。

### 下一步任务

#13 Phase 1: 建立工程治理骨架

## 9. 恢复检查清单

1. 运行 `npm run status` 刷新本文件。
2. 阅读 `AGENTS.md` 与 `docs/ENGINEERING_WORKFLOW.md`。
3. 运行 `git status --short` 与 `git worktree list`，确认没有覆盖他人修改。
4. 在 GitHub Issue 中确认认领、分支和 One Writer 归属。
5. 检查 HEAD CI、最新 Release 与阻塞项，再开始修改。
