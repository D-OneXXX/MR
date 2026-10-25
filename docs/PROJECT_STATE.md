# MangaReader 项目状态

> 生成时间：2026-10-25T20:50:33.188Z
> 本文件由 `npm run status` 生成，请勿手工编辑。
> `UNKNOWN` 表示当前环境无法验证，不代表正常。

## 1. 版本与维护阶段

| 项目 | 值 |
|---|---|
| package.json | `0.17.1` |
| 最新 Release | `v0.17.1-linux-sec1`（0.17.1） |
| 最新 Windows Release | `v0.17.1`（0.17.1）；HEAD 领先 11 个提交 |
| 最新 Linux critical Release | `v0.17.1-linux-sec1`（0.17.1）；HEAD 领先 8 个提交 |
| HEAD 距最新 Release | 8 个提交 |
| 当前阶段 | 开发中（与最新发布同版本） |
| 判定依据 | HEAD 领先最新发布 8 个提交，但版本号仍为 0.17.1。下一次发布前必须 bump。 |

## 2. 仓库与工作区

| 项目 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `e197dc3225c3` |
| 提交 | fix(status): 区分必需与非必需 check runs (#22) |
| 提交时间 | 2026-10-26T04:44:50+08:00 |
| 工作区 | 干净 |
| 本地分支 | `chore/13-phase-1-governance`, `chore/15-vite-lru-security`, `chore/19-pr-governance`, `fix/21-status-required-checks`, `main`, `wip/main-telegram-20261023` |
| 已注册 Worktree | `manga-reader-tauri`（main） |

## 3. 质量门禁

- GitHub 数据：可用

| 检查 | 必需 | 状态 | 结论 |
|---|---|---|---|
| cargo check + frontend build (ubuntu-22.04) | 是 | completed | success |
| tsc + cargo test + static QA (windows-latest) | 是 | completed | success |

- 分支保护：enforce_admins=true
- required checks：tsc + cargo test + static QA (windows-latest), cargo check + frontend build (ubuntu-22.04), PR governance (issue link + branch naming)
- required reviews：非必需
- force push：禁止；deletion：禁止

- 发布审批环境：未配置

## 4. 活跃 Issue

| # | 标题 | 状态 | 严重度 | 负责人 |
|---|---|---|---|---|
| #23 | QA: chaos CDP 超时偶发导致全量 QA P0（safe-mode/freeze） | status:triaged | severity:p2 | — |
| #18 | 依赖安全：glib 0.18.5 需 Tauri/GTK 协调升级 | status:triaged | severity:p2 | — |

## 5. 开放 PR

无开放 PR。

## 6. 最近 CI

| Workflow | 事件 | 分支 | 状态 | 结论 |
|---|---|---|---|---|
| Linux check | push | main | completed | success |
| Windows check | push | main | completed | success |
| Windows check | pull_request | fix/21-status-required-checks | completed | success |
| Linux check | pull_request | fix/21-status-required-checks | completed | success |
| PR governance | pull_request | fix/21-status-required-checks | completed | success |

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
- Windows 常规通道落后 HEAD 11 个提交。
- Linux critical 通道落后 HEAD 8 个提交。

### 阻塞项

无已知阻塞项。

### 下一步任务

#23 QA: chaos CDP 超时偶发导致全量 QA P0（safe-mode/freeze）

## 9. 恢复检查清单

1. 运行 `npm run status` 刷新本文件。
2. 阅读 `AGENTS.md` 与 `docs/ENGINEERING_WORKFLOW.md`。
3. 运行 `git status --short` 与 `git worktree list`，确认没有覆盖他人修改。
4. 在 GitHub Issue 中确认认领、分支和 One Writer 归属。
5. 检查 HEAD CI、最新 Release 与阻塞项，再开始修改。
