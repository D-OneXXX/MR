# Phase 4 发布治理验收报告

> 生成时间：2026-10-26
> 授权范围：**仅发布基础设施、权限治理、自动化测试与非正式发布演练**；
> 不授权创建或公开任何正式版本，不授权修改 Tag / 正式更新清单，版本保持 `0.17.1`。
> 本报告不构成发布授权，也不代表任何版本已发布。

---

## 1. 结论摘要

| 维度 | 结论 |
|---|---|
| Tag 推送直接公开发布 | **已消除**：仓库内不再存在任何 Tag 触发的 workflow，静态守卫强制 |
| RC → Draft → 人工审批 → Publish | **已建成**（代码与工作流就绪；缺 Environment 配置，审批门禁尚未真实生效） |
| 审批与制品绑定 | **已实现并验证**：版本 + Commit + 每个制品 SHA-256 + 目标平台 + 安装验证回执，任一不一致即拒绝发布 |
| 权限收敛 | **已实现**：工作流级 `contents: read`，仅候选/发布 job 提升为 `contents: write`；发布 job 不持有签名私钥 |
| 双通道独立 | **已实现**：Windows / Linux 各自独立的工作流、Environment、端点、并发组，并互相拒绝跨通道发布 |
| 绕过路径 | **已清除**：`skip_full_qa`、`releaseDraft: false`、Tag 触发全部移除，并有静态守卫防回归 |
| 非正式发布演练 | **已通过**：隔离演练 22/22（候选→Draft→审批绑定→发布→失败恢复→并发→清单安全→跨通道） |
| GitHub Environment 审批真实性 | **NOT_VERIFIED**：远端尚无 Environment，审批门禁未被真实触发过 |
| NSIS 真实安装 / 覆盖升级 / 数据完整性 | **BLOCKED**：需要干净 Windows VM，当前环境无法执行；已做成**发布强制条件**（缺回执即拒绝发布） |
| 正式版本发布 | **未执行**（授权范围之外） |

---

## 2. 改造内容

### 2.1 消除「Tag 推送即公开发布」

| 变更 | 说明 |
|---|---|
| 删除 `.github/workflows/release-windows.yml` | 原文件 `on: push: tags: v*` + `releaseDraft: false` + `contents: write`：推送 `v*` 立刻公开发布 |
| 删除 `.github/workflows/release-linux-critical.yml` | 同上（Linux 通道同样由 Tag 直接发布） |
| 新增 `release-candidate.yml` / `release-candidate-linux.yml` | 仅 `workflow_dispatch` 手动触发，产出**签名后的 Draft** + `rc-record.json` |
| 新增 `release-publish.yml` / `release-publish-linux.yml` | 仅 `workflow_dispatch` 手动触发，先校验绑定再把 Draft 变成公开 Release |
| 新增静态守卫 `static:release-governance` | 任何 workflow 出现 `push: tags:`、缺 `environment:`、含 `skip_full_qa` / `releaseDraft: false` / `permissions: write-all` → 静态 QA 失败（门禁内） |

> 改造期间不会误触发旧工作流：旧文件在同一个 PR 内被删除，`main` 上不存在 Tag 触发器；
> 本轮**没有推送任何 Tag**，也没有创建任何 Release。

### 2.2 审批绑定（防止审批后替换制品）

发布前的强制校验（`scripts/release-governance/verify-draft.mjs`）逐项对齐：

| 绑定项 | 校验方式 |
|---|---|
| 版本 | 标签、RC 记录、安装验证回执、`package.json` 四处必须一致 |
| Commit | 标签指向的提交、RC 记录、QA 证据 `buildCommit`、回执必须一致，且必须在 `main` 上 |
| 制品 SHA-256 | RC 记录中每个制品的摘要与**实际下载到的文件**逐一比对；多出记录外的制品也拒绝 |
| 目标平台 | 通道 ↔ 平台（`windows-x86_64` / `linux-x86_64`）与清单平台项必须匹配 |
| QA 证据 | 候选工作流按 `qa_run_id` 查证：该 run 必须 `success` 且 `head_sha` 等于候选 Commit |
| 安装验证 | 干净 VM 的安装/升级/回滚/数据完整性回执必须 `PASS` 且指向同一份安装包摘要 |

### 2.3 权限收敛

| 工作流 / job | 权限 |
|---|---|
| `qa-full.yml` / CI | `contents: read` |
| 候选 job（Windows / Linux） | `contents: write`（仅创建 Draft 与上传制品） |
| 发布 job（Windows / Linux） | `contents: write`（仅发布 Draft、接力清单、发布后校验）；**不持有签名私钥** |
| `release-rehearsal.yml` | `contents: read`，不接触任何 Secret |

### 2.4 通道独立与并发

- 候选并发组：`release-candidate-<channel>-<tag>`；发布并发组：`release-publish-<channel>-<tag>`；
  `cancel-in-progress: false`（同一通道同一标签不允许并发发布）。
- 标签形态硬约束：常规通道 `vX.Y.Z`，Linux 高危通道 `vX.Y.Z-linux-secN`，互相拒绝。
- 清单接力：Windows 发布时必须带上 `latest-linux-critical.json`，Linux 发布时必须带上 `latest.json`，
  否则 `releases/latest/download/*.json` 会 404 → 发布失败。

---

## 3. 证据矩阵

### VERIFIED（有可复现输出）

| 项 | 证据 |
|---|---|
| 发布治理单元测试 | `node --test scripts/release-governance/rc-record.test.mjs` → 10/10 |
| 隔离发布演练 | `node scripts/release-governance/rehearse.mjs` → **22/22**（A 候选→Draft / B 审批绑定 / C 失败恢复 / D 并发控制 / E 清单安全 / F 跨通道 / G 标签约束） |
| 静态守卫 | `static:release-governance` 与 `static:release-surface` 在静态 QA 中通过；新增 `static:release-governance` 使静态套件达到 23 项全绿 |
| 发布契约 | `npm run test:release` → 13 + 10 项全绿 |
| Tag 触发已消失 | `.github/workflows/` 下无 `push: tags:`；静态守卫强制 |
| 绕过路径已清除 | 仓库内不再出现 `skip_full_qa` / `releaseDraft: false` |

### BLOCKED（环境限制，未伪造通过）

| 项 | 原因 | 现状 |
|---|---|---|
| NSIS 真实安装 / 覆盖升级 / 数据完整性 | 需要一次性干净 Windows VM（无桌面会话的 hosted runner 不适用） | 脚本 `scripts/release-smoke/windows-install-upgrade.ps1` 就绪；已做成**发布强制条件**：缺回执 → 发布被拒 |
| 真实 Draft / 审批 / 发布的端到端演练 | 需要远端 Environment + 真实 Draft（属远程状态变更，需单独授权） | 逻辑层已由隔离演练覆盖；远端链路待授权后补做 |

### NOT_VERIFIED（当前无法验证，不代表正常）

| 项 | 原因 | 补验方式 |
|---|---|---|
| GitHub Environment 审批是否真实生效 | 远端 `environments` 数量为 0，审批规则未配置 | 配置后跑一次部署，观察 `pending_approval` 状态（AI 不得自行批准） |
| Environment 级签名私钥可用性 | Environment 与其 Secret 尚未创建 | 按「先配置 → 再验证 → 后删除旧副本」顺序执行后验证 |
| `GITHUB_TOKEN` 在真实 Draft 上的写权限 | 未创建过 Draft | 授权后由候选工作流在演练标签上验证 |
| ruleset 与 Environment 的交互（标签保护 vs 建 Draft） | 未在真实标签上验证 | 授权后用演练标签验证 |

---

## 4. 需要用户单独确认的远程设置变更清单

以下变更**均未执行**，需要逐项确认后才会动：

### 4.1 创建 Environment（发布审批门禁）

| Environment | 用途 | 建议配置 | 风险 |
|---|---|---|---|
| `release-windows` | Windows 候选构建 + 发布 | required reviewer = 仓库管理员；deployment branch = `main`；不设「防止自我审批」豁免 | 审批人可拒绝发布；无人审批时发布被卡住（安全方向的失败） |
| `release-linux` | Linux 候选构建 + 发布 | 同上 | 同上 |

### 4.2 签名 Secret 迁移（顺序：先配置 → 再验证 → 后删除旧副本）

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | 在 `release-windows` / `release-linux` 新增 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 值只能由持有本地私钥的维护者提供；**Agent 读不到也绝不会输出密钥内容**（GitHub 不提供 Secret 明文读取） |
| 2 | 跑一次**候选**工作流（演练标签）验证 Environment 级 Secret 可用 | 验证点：签名产物 `.sig` 存在、`latest.json` 的签名非空且能被 `verify-updater-manifest.mjs` 通过 |
| 3 | 删除**仓库级**同名 Secret | 只有第 2 步通过后才删；删除前仓库级副本仍然存在（双副本窗口），删除后任何仓库内工作流都拿不到私钥 |

### 4.3 收紧默认工作流权限（可选，收益较小）

| 变更 | 风险 |
|---|---|
| 仓库 `default_workflow_permissions` 由默认改为 `read` | 现有工作流已显式声明权限，理论上无影响；但若存在未声明权限的工作流会立即失败 |

### 4.4 可选：给 tag ruleset 增加豁免（当前不需要）

现规则集 `Protect release tags`（`refs/tags/v*`，禁改禁删，无豁免）会阻止集成令牌写标签引用，
这正是 `gh release create --verify-tag` 存在的原因。**新流程不需要写标签引用**，因此无需修改 ruleset；
建议保持现状（更严格）。

---

## 5. 新的发布流程（人工操作顺序）

```text
1. 维护者在 main 上合并版本 bump（0.17.2），打标签并推送：git tag v0.17.2 && git push origin v0.17.2
   （此时**不会**触发任何发版工作流——仓库内已无 Tag 触发器）
2. 跑一次 qa-full，拿到 run id（必须 success 且 headSha = 标签提交）
3. 触发 release-candidate.yml（Windows）或 release-candidate-linux.yml（Linux）
   输入：tag、qa_run_id、（可选）install_attestation_b64
   → 在 Environment 审批 → 构建、签名、上传制品 → 创建 **Draft** + rc-record.json
4. 在干净 VM 上执行 scripts/release-smoke/windows-install-upgrade.ps1，生成安装验证回执
   （base64 编码后作为候选/发布输入，或直接作为 Draft 资产上传）
5. 触发 release-publish.yml（对应通道）
   输入：tag
   → 在 Environment 审批 → 下载 Draft 制品 → 绑定校验（版本/Commit/SHA-256/平台/回执）
   → 通过后把 Draft 变为公开 Release → 通道清单接力 → 发布后验证
6. 核对发布后验证结果与 docs/PROJECT_STATE.md
```

任何一步不满足都会被**拒绝**而不是绕过：缺 QA 证据、缺安装回执、摘要不符、跨通道、
清单非法、并发冲突，都会以非零码阻断。

---

## 6. 复核命令

```bash
npm run test:release          # 发布契约 + 发布治理单测
npm run release:rehearse      # 隔离发布演练（不联网、不创建 Release）
node tests/qa/run-qa.mjs --suite=static   # 含 static:release-governance 守卫
```

远端只读复核：

```bash
gh api repos/D-OneXXX/MR/environments --jq .total_count
gh api repos/D-OneXXX/MR/branches/main/protection --jq .required_status_checks
grep -rn "push:" .github/workflows/    # 不得出现 tags 触发
```

---

## 7. 合并与验收状态（2026-10-26）

| 项 | 结果 |
|---|---|
| 合入 `main` | `b3ddabf`（PR #59，Issue #57） |
| PR 门禁 | Windows ✅ / Linux ✅ / PR governance ✅ / **Release governance rehearsal ✅** / CodeQL ✅ / Analyze ✅ |
| 本地全量 QA | **230/230**，P0–P3=0（`buildCommit=b3ddabf60240`，与 HEAD 一致） |
| `main` 上的 Tag 触发器 | **0 个**（`git grep "tags:" origin/main -- .github/workflows/` 无命中） |
| `main` 上的绕过开关 | **0 个**（`releaseDraft: false` / `skip_full_qa` 均已消失） |
| 旧发版文件 | `release-windows.yml` / `release-linux-critical.yml` 已删除 |
| 版本 / Tag / Release | 仍为 `0.17.1`；未创建 Tag，未创建或修改任何 Release，未改动正式更新清单 |
| 远端 Environment / Secret | **未改动**（等待用户确认，见第 4 节） |

下一步（需用户确认后才执行）：

1. 创建 `release-windows` / `release-linux` Environment + required reviewer；
2. 按「先配置 → 再验证 → 后删除」迁移签名 Secret；
3. 用演练标签跑一次候选工作流，验证 Environment 审批与 Secret 可用性；
4. 补做真实 Draft → 审批 → 发布的端到端演练（仍不公开正式版本）；
5. 在干净 Windows VM 上完成 NSIS 安装/覆盖升级/数据完整性验证（正式发布强制条件）。

---

## 8. 远程配置验收报告（2026-10-26，用户授权后执行）

### 8.1 实际执行的远程变更

| 变更 | 状态 | 说明 |
|---|---|---|
| 创建 Environment `release-windows` | 已完成 | required reviewer = `D-OneXXX`（User 217948500）；`prevent_self_review=false`；deployment branch policy = 仅受保护分支（main） |
| 创建 Environment `release-linux` | 已完成 | 同上 |
| 写入 Environment 签名 Secret（2×2 项） | 已完成 → **随后删除** | 演练证明 Environment 级 Secret 可用（构建产出有效 minisign 签名）；但无法证明它与「已发布版本所使用的私钥」是同一把（见 8.3 阻塞），故按「宁可无密钥、不可错密钥」原则移除副本 |
| 删除仓库级签名 Secret | **未执行** | 用户要求「验证失败不得删除原 Secret」；仓库级副本原样保留（`updated=2026-10-24`） |
| 仓库默认工作流权限 → `read` | 已确认 | 修改前审计：4 个发布工作流均在 job 级显式声明 `contents: write`，其余工作流只需 `read`；修改后 CI 复跑全绿（Windows 40283927447 / Linux 40283930606） |
| tag ruleset | **未改动** | 新流程不需要写标签引用，`Protect release tags` 保持原样（更严格） |
| 创建隔离演练标签 `v0.0.0-rehearsal` | 已完成 | 指向 `b0820e2`；**推送后没有任何 workflow 被触发**（核心风险消除的真实验证） |
| 创建演练 Draft Release | 已完成 | `v0.0.0-rehearsal`，`isDraft=true`，从未公开 |

### 8.2 隔离演练证据

| 检查 | 结果 | 证据 |
|---|---|---|
| Tag 推送不触发发版 | PASS | 推送 `v0.0.0-rehearsal` 后运行列表无新增发版运行 |
| Environment 审批真实生效 | PASS | deployment `7325926128` 状态 `waiting`；`required_reviewers=["User#D-OneXXX"]`；`current_user_can_approve=true`（单人维护者可审批）；job 在审批前不执行 |
| 单人维护者可完成审批 | PASS | `prevent_self_review=false` → 维护者可批准自己触发的部署 |
| 候选流程端到端 | PASS | run `40290561696` success：构建 → 签名 → 建 Draft → 生成 RC 记录 |
| Environment 级 Secret 可用 | PASS | 构建日志显示 `TAURI_SIGNING_PRIVATE_KEY: ***`，产出 `MangaReader_0.17.1_x64-setup.exe.sig` 与 `latest.json`（签名非空） |
| RC 记录绑定 | PASS | `rc-record.json` 含版本/Commit/平台/QA runId + 每个制品 SHA-256；实测摘要与真实资产逐一相符 |
| 发布闸门拒绝演练候选 | PASS | `verify-draft.mjs` 对真实远端制品返回「演练候选永远不得发布」 |
| 发布工作流拒绝演练标签 | PASS | run `40293390900`：审批后立即失败「演练标签永远不得发布：v0.0.0-rehearsal」 |
| 公开更新清单未被改动 | PASS | 演练前后 `latest.json` = `64f6038e…`、`latest-linux-critical.json` = `2bdb3af5…`（字节一致） |
| `releases/latest` 未变 | PASS | 仍为 `v0.17.1-linux-sec1`（id 423315120，published_at 未变） |
| 演练中暴露并修复的真实缺陷 | PASS | ① 纯 `tauri build` 不产出 `latest.json`（已改回 tauri-action 产出清单）；② 演练模式 `VERSION` 未定义；③ 演练 Commit 取 main HEAD 与构建来源不一致；④ 治理文件被误判为「记录外制品」 |

### 8.3 遗留风险与阻塞

| 项 | 结论 | 说明 |
|---|---|---|
| 签名私钥与配置 `pubkey` 的一致性 | **NOT_VERIFIED** | 本机 `updater.key` 是 rsign 加密密钥（公钥不明文内嵌），离线无法与 `tauri.conf.json` 的公钥（ID `67CB304460E08E4A`）比对；环境无 minisign。**处置**：Environment 副本已删除、仓库级副本保留；正式发布前必须由维护者用权威密钥材料写入 Environment Secret，并用 minisign 验签 |
| NSIS 真实安装 / 覆盖升级 / 数据完整性 | **BLOCKED** | 需要干净 Windows VM；脚本就绪但本环境无法执行。正式发布强制条件未满足 |
| 演练 Draft 清理 | 待决 | `v0.0.0-rehearsal` Draft 保留作为证据（未公开、不影响 `releases/latest`）；删除需维护者确认（ruleset 保护 `v*` 标签的删除） |
| 版本与正式发布 | 未授权 | 仍为 `0.17.1`；未推 `v0.17.2`；未创建/修改任何正式 Release |

### 8.4 是否具备正式发布条件

**尚不具备。** 至少需要先解决两项：

1. 签名私钥一致性（NOT_VERIFIED → 需要维护者用权威密钥材料重装 Environment Secret 并验签）；
2. 干净 Windows VM 上的 NSIS 安装 / 覆盖升级 / 用户数据完整性验证（BLOCKED）。

其余发布链路（候选→Draft→审批→发布、制品绑定、权限收敛、通道独立、无绕过路径）已具备可验证证据。
