# MangaReader 项目状态

> 生成时间：2026-10-26T10:46:51.946Z
> 本文件由 `npm run status` 生成，请勿手工编辑。
> `UNKNOWN` 表示当前环境无法验证，不代表正常。

## 1. 版本与维护阶段

| 项目 | 值 |
|---|---|
| package.json | `0.17.1` |
| 最新 Release | `v0.17.1-linux-sec1`（0.17.1） |
| 最新 Windows Release | `v0.17.1`（0.17.1）；HEAD 领先 38 个提交 |
| 最新 Linux critical Release | `v0.17.1-linux-sec1`（0.17.1）；HEAD 领先 35 个提交 |
| HEAD 距最新 Release | 35 个提交 |
| 当前阶段 | 开发中（与最新发布同版本） |
| 判定依据 | HEAD 领先最新发布 35 个提交，但版本号仍为 0.17.1。下一次发布前必须 bump。 |

## 2. 仓库与工作区

| 项目 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `9ae4264c26ac` |
| 提交 | feat(release): 签名与安装升级验证纳入强制发布门禁 (#68) |
| 提交时间 | 2026-10-26T18:46:13+08:00 |
| 工作区 | 干净 |
| 本地分支 | `chore/13-phase-1-governance`, `chore/15-vite-lru-security`, `chore/18-glib-risk-acceptance`, `chore/19-pr-governance`, `chore/24-phase2-closeout`, `chore/28-rust-security-audit`, `chore/30-full-qa-evidence`, `chore/36-local-qa-attestation`, `chore/38-actions-sha`, `chore/39-upgrade-compat`, `chore/40-final-status-snapshot`, `chore/40-phase3-report`, `chore/40-status-refresh`, `chore/48-version-attribution`, `chore/49-version-attribution`, `chore/57-phase4-final`, `chore/57-phase4-remote-report`, `feat/57-phase4-release-governance`, `feat/61-rehearsal-mode`, `feat/68-evidence-gate`, `fix/21-status-required-checks`, `fix/23-chaos-cdp-retry`, `fix/30-full-qa-retry`, `fix/30-full-qa-retry-v2`, `fix/32-arch-webtoon-ci-diag`, `fix/32-arch-webtoon-flake`, `fix/42-chaos-rage-click`, `fix/51-cache-quiescence`, `fix/61-candidate-tauri-action`, `fix/61-rehearsal-commit-binding`, `fix/61-rehearsal-version-var`, `main`, `wip/main-telegram-20261023` |
| 已注册 Worktree | `manga-reader-tauri`（main） |

## 3. 质量门禁

- GitHub 数据：可用

| 检查 | 必需 | 状态 | 结论 |
|---|---|---|---|
| Analyze (javascript-typescript) | 否 | in_progress | — |
| Analyze (actions) | 否 | completed | success |
| cargo check + frontend build (ubuntu-22.04) | 是 | in_progress | — |
| Release governance rehearsal (no secrets) | 否 | completed | success |
| tsc + cargo test + static QA (windows-latest) | 是 | in_progress | — |

- 分支保护：enforce_admins=true
- required checks：tsc + cargo test + static QA (windows-latest), cargo check + frontend build (ubuntu-22.04), PR governance (issue link + branch naming)
- required reviews：非必需
- force push：禁止；deletion：禁止

- 发布审批环境：release-linux, release-windows

## 4. 活跃 Issue

| # | 标题 | 状态 | 严重度 | 负责人 |
|---|---|---|---|---|
| #68 | Phase 4: 签名与安装升级验证纳入强制发布门禁 | status:in-progress | severity:p1 | — |

## 5. 开放 PR

无开放 PR。

## 6. 最近 CI

| Workflow | 事件 | 分支 | 状态 | 结论 |
|---|---|---|---|---|
| Push on main | dynamic | main | in_progress | — |
| Linux check | push | main | in_progress | — |
| Windows check | push | main | in_progress | — |
| Release governance rehearsal | push | main | completed | success |
| Windows check | pull_request | feat/68-evidence-gate | completed | success |

## 7. 最近 Release

| Tag | 名称 | 类型 | 发布时间 |
|---|---|---|---|
| v0.0.0-rehearsal | MangaReader v0.0.0-rehearsal | Draft |  |
| v0.17.1-linux-sec1 | MangaReader v0.17.1-linux-sec1 (Linux critical) | Published | 2026-10-25T10:15:11Z |
| v0.17.1 | MangaReader v0.17.1 | Published | 2026-10-25T09:48:51Z |
| v0.17.0 | MangaReader v0.17.0 | Published | 2026-10-25T02:45:44Z |

## 8. 阻塞项与下一步

### 治理告警

- 最新版本已发布但 HEAD 仍有未发布提交；下一次发布前必须 bump。
- Windows 常规通道落后 HEAD 38 个提交。
- Linux critical 通道落后 HEAD 35 个提交。

### 阻塞项

无已知阻塞项。

### 下一步任务

#68 Phase 4: 签名与安装升级验证纳入强制发布门禁

## 9. 恢复检查清单

1. 运行 `npm run status` 刷新本文件。
2. 阅读 `AGENTS.md` 与 `docs/ENGINEERING_WORKFLOW.md`。
3. 运行 `git status --short` 与 `git worktree list`，确认没有覆盖他人修改。
4. 在 GitHub Issue 中确认认领、分支和 One Writer 归属。
5. 检查 HEAD CI、最新 Release 与阻塞项，再开始修改。
