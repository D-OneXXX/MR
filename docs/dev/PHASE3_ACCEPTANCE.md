# Phase 3 最终验收报告与 Phase 4 实施方案

> 生成时间：2026-10-26（`docs/PROJECT_STATE.md` 为机器生成的实时快照）
> 适用版本线：`0.17.1`（`main` 领先已发布 Release 19 个提交）
> 边界：本文件**不构成发布授权**；Phase 1–3 的「禁止推送 `v*` Tag」仍然有效。

---

## 1. 结论摘要

| 维度 | 结论 |
|---|---|
| Phase 3 门禁硬化 | **完成**：Actions SHA 固定、rustfmt 门禁、夹具门禁、发布契约门禁均已进 CI |
| QA 证据链 | **完成**：hosted `qa-full` 已能在 windows-2022 上跑出**全绿**证据（run 40265639362，228/228） |
| 断言有效性 | **完成**：#32 的「两张不同切片」无效判据已修正为渐变夹具 + API/DOM 双断言 |
| 数据与升级 | **部分完成**：SQLite 跨版本兼容与更新清单契约已自动化；**真实 NSIS 安装/覆盖/回滚仍 BLOCKED**（需干净 VM） |
| 发布边界 | **已审计**：当前「Tag 推送即公开发布」，无 Environment、无人工审批、无发布后验证；Phase 4 必须先补 |
| 剩余阻塞 | **1 项**：#42 `chaos:rage-click` 在 hosted 上偶发未触发恢复窗（正在用证据采集定位） |
| Phase 3 验收 | **待 #42 结论**：其余条目已具备可复现证据 |

---

## 2. 逐项完成情况与证据

### 2.1 CI 与供应链硬化（Issue #38 → PR #44，`ef1b6cf`）

| 条目 | 证据 | 结论 |
|---|---|---|
| Actions 引用固定到 commit SHA | 6 个 workflow 共 27 处 `uses` 全部固定为 40 位 SHA（保留版本注释）；`static:actions-pinned` 静态守卫在 QA 静态套件内生效（22/22 通过） | VERIFIED |
| Rust 格式门禁 | `cargo fmt --all` 规范化 28 个文件；CI 三条工作流加入 `cargo fmt --all -- --check`；`npm run format:check` 可本地执行 | VERIFIED |
| 夹具门禁 | `npm run test:fixtures`（3/3）防止超高条漫夹具退化成纯色（#32 根因） | VERIFIED |
| 「整套重试」逃逸口 | `qa-full.yml` 中的完整 suite 重试已删除（根因已修，重试会掩盖真实失败） | VERIFIED |
| 前端格式化（Prettier/ESLint） | 仓库无格式化配置；引入会触及约 125 个前端源文件（67 `.tsx` + 53 `.ts`） | MISSING（记录为后续项，不阻塞 Phase 3） |

### 2.2 QA 证据工作流与断言修复（#30 / #32 → PR #41，`143c463`）

- **根因（有证据，非猜测）**：超高条漫夹具是纯色 800×21000 PNG，切出的每片像素完全相同 →
  data URL 相同 → 「加载到 ≥2 张不同切片」实际测的是**渲染宽度**是否变化，而非是否切片。
  hosted 只用一个宽度故恒失败；本地恰好出现过 W=640→1152 切换而偶然通过。
- **诊断证据**：run 40261202752 —— rAF 1886 帧/30s、scroll 事件 58 次、`visibility=visible`、
  `hasFocus=true`，DOM 已推进到切片 `0:14`（`top=43144px`、`height=3082px`、
  `naturalWidth=800`、`complete=true`），唯一失败项即该无效判据。
- **修复**：夹具改竖向渐变（与 Rust `ultra_tall_page` 同公式）；断言加强为
  API 级「同宽度下切片 0/1 指纹不同」+ DOM 级「出现 ≥2 个不同切片节点 key」。
- **结果**：hosted run 40263953942 中该检查通过；run 40265639362 **228/228 全绿**。

### 2.3 混沌恢复（Issue #42，PR #43 —— 进行中）

- 已加入只读诊断探针：记录 6 次连点的**到达时间线**与检测窗口内的状态变化。
- 已知基线：本地 `dispatchMs=5–9ms`、点击到达 `t=5/95/186/283/374/459ms`、`mutationCount=0`；
  hosted（run 40265639362）`dispatchMs=3–15ms`、到达 `t=6/99/194/288/383/476ms`、`mutationCount=0`。
- 失败样本（run 40263953942）选取的注入点为 `(100,300)`，而成功样本为 `(260,300)`：
  **注入点选取依赖布局**，这是当前唯一可证伪的不确定性来源，正在用重复运行采集证据。

### 2.4 数据兼容、安装升级与回滚（Issue #39 → PR #45）

| 条目 | 证据 | 结论 |
|---|---|---|
| 旧库文件无损升级 | `cargo test --lib legacy_library_file_migrates_without_data_loss`：旧形态库文件经 `db::open`+`init_schema` 后书/路径/页数/进度/设置/旧史全部保留，新增列取默认，唯一索引生效，`quick_check` 通过，重复迁移幂等 | VERIFIED |
| 高版本库不被降级 | `cargo test --lib newer_schema_version_is_not_downgraded`：`user_version` 高于当前 schema 的库不被写回旧值且数据不丢 | VERIFIED |
| 发行面静态契约 | `npm run test:release`（13/13）：产品标识、NSIS 目标（禁 MSI）、六语安装向导、minisign 公钥、Windows/Linux 通道端点互不相同 | VERIFIED |
| 公开更新清单结构 | `scripts/verify-updater-manifest.mjs` + Linux 发布前校验 + Windows 发布后校验 | VERIFIED |
| NSIS 真实安装/覆盖/回滚 | `scripts/release-smoke/windows-install-upgrade.ps1` 已就绪（PowerShell 语法校验通过），但**当前环境无可用干净 VM** | **BLOCKED**（不伪造通过） |
| 真实用户目录升级迁移 | 需真实用户样本，超出隐私与自动化边界 | BLOCKED |

### 2.5 发布权限边界审计（只读，未改动任何远程状态）

| 观察 | 证据 | 风险 |
|---|---|---|
| Tag 推送即公开发布 | `release-windows.yml` 触发条件 `push: tags: v*`，`releaseDraft: false`，`permissions: contents: write` | **高**：无人工确认门禁 |
| 无发布审批环境 | `GET /environments` → `total_count = 0` | **高**：无法配置 required reviewer |
| 签名私钥在仓库级 | `gh secret list` → `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`（仓库作用域） | **高**：任一仓库内工作流理论上可读取；无法按 job 收敛 |
| Tag 规则集无豁免 | ruleset `Protect release tags`（`refs/tags/v*`，禁改禁删，`bypass_actors=[]`） | 中：这也是 `gh release create` 必须 `--verify-tag` 的原因（不得传 `target_commitish`） |
| 现存 Release 均为已发布 | v0.17.0 / v0.17.1 / v0.17.1-linux-sec1，无 Draft | 中：没有「先看 Draft 再发布」的中间态 |
| 通道清单接力发生在发布后 | `release-windows.yml` / `release-linux-critical.yml` 末尾互相搬运 `latest.json` / `latest-linux-critical.json` | 中：接力失败会造成 `releases/latest/download/...` 404 |
| Linux 通道无 Windows 全量 QA | 仅执行静态 QA（Windows 专属 WebView2 路径无法在 Linux 跑） | 中：Linux 通道的质量证据弱于 Windows |
| 工作流权限 | `actions/permissions`：`default_workflow_permissions = null`（仓库默认），`allowed_actions = all` | 中：应显式收敛为最小权限 |

> 以上均为**只读**结论；Phase 1–3 期间未创建/修改任何 Release、Tag、Environment、Secret 或 ruleset。

---

## 3. 证据矩阵（结论口径）

- **VERIFIED**：有可复现命令与实际输出。
- **PARTIAL**：部分覆盖，剩余部分已明确标注原因。
- **MISSING**：确认缺失且已记录为后续项。
- **BLOCKED**：当前环境无法执行，**没有伪造通过记录**。
- **UNKNOWN**：当前无法验证（不代表正常）。

| 项 | 结论 |
|---|---|
| Actions SHA 固定 | VERIFIED |
| Rust 格式门禁 | VERIFIED |
| 夹具单测门禁 | VERIFIED |
| 发布契约 + 更新清单门禁 | VERIFIED |
| SQLite 旧库升级 | VERIFIED |
| SQLite 高版本库不降级 | VERIFIED |
| hosted 全量 QA 证据（一次全绿） | VERIFIED（run 40265639362） |
| hosted 全量 QA 稳定性（≥3 次连续全绿） | 待 #42 结论 |
| 混沌连点恢复在 hosted 的稳定性 | 待 #42 结论 |
| NSIS 真实安装/覆盖/回滚 | BLOCKED |
| 前端格式化 | MISSING |
| CodeQL Rust 覆盖 | MISSING（CodeQL default setup 不支持 Rust；需独立 language 化工作流） |
| 发布 Environment / 审批门禁 | MISSING（Phase 4） |
| 发布后验证与回滚流程 | MISSING（Phase 4） |

---

## 4. 风险接受项（继续有效，需定期复核）

| 项 | 内容 | 触发复核的条件 |
|---|---|---|
| `glib 0.18.5` | Linux 传递依赖风险，需升级 Tauri/GTK 栈 | Tauri 2 大版本升级窗口 |
| `RUSTSEC-2026-0367/0368/0369` | `tauri-plugin-updater` 间接依赖 `zip 4.6.1`，仅用于 .zip 更新包 | 官方 updater 升级到 zip 9+，或启用 .zip 更新包 |
| required reviews | 当前不要求人工 review（AI 自动合并），发布审批单独设环境 | Phase 4 建立发布 Environment 后复核 |
| 前端格式化 | 暂不引入（约 125 个前端源文件需一次性改写） | 引入前需单独评估改动面 |

---

## 5. Phase 4 实施方案（设计，尚未实施）

### 5.1 目标模型

```
固定 Commit ──► qa-full 证据（绑定 SHA）──► 构建 + 签名 ──► Draft Release
                                                          │
                                        人工审批（Environment required reviewer）
                                                          ▼
                                                    发布 + 通道清单接力
                                                          │
                                                          ▼
                                                    发布后验证（资产/清单/签名/可下载）
```

硬约束：
1. **任何公开 Release 的创建与发布都必须经过人工审批**，且审批不可被工作流参数绕过
   （不得保留 `skip_full_qa` 之类的「无人值守直发」入口）。
2. **签名私钥收敛到 Environment 作用域**，仓库级不再保留副本。
3. **Tag 不再是发布触发器**：由「准备 Tag」的人工动作与「审批后发布」两步组成，
   且创建 Tag 与发布之间必须有可审计的 Draft 供复核。
4. **Windows / Linux 通道继续独立**：各自的 workflow、concurrency 组、端点与清单。
5. 不删除历史 Tag、不移动已发布 Release、不强推分支。

### 5.2 工作流结构

| 工作流 | 触发 | 环境 | 职责 |
|---|---|---|---|
| `qa-full.yml`（已存在） | `workflow_dispatch` / `workflow_call` | 无 | 绑定 SHA 的全量 QA 证据 |
| `release-candidate.yml`（新增，替代 `release-windows.yml` 的发布部分） | `workflow_dispatch`（输入 tag 或 commit） | `release-build`（required reviewer） | 校验版本一致 → 跑/引用 QA 证据 → 构建 NSIS → 签名 → 上传到 **Draft** |
| `release-publish.yml`（新增） | `workflow_dispatch`（输入 tag） | `release-publish`（required reviewer） | 复核 Draft + QA 证据 → 发布 → 通道清单接力 → 发布后验证 |
| `release-linux-critical.yml`（改造） | `workflow_dispatch`（输入 tag） | `release-linux-critical` | 同上，deb/rpm/AppImage + `latest-linux-critical.json` |

并发：`concurrency.group = release-<channel>-<tag>`，`cancel-in-progress: false`，
防止同一通道并发发布。

### 5.3 权限与 Secret 边界

| 位置 | 权限 | Secret |
|---|---|---|
| `qa-full.yml` | `contents: read` | 无 |
| `release-candidate.yml` | `contents: read`（仅 Draft 阶段用 `contents: write` 创建 Draft） | `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` **Environment 级**（`release-build`） |
| `release-publish.yml` | `contents: write` | 无需私钥（资产已签名） |

仓库级同名 Secret 需在 Phase 4 实施时删除（迁移到 Environment 后再删，避免窗口期中断）。

### 5.4 人工审批门禁

- Environment `release-build` / `release-publish` / `release-linux-critical` 均配置
  required reviewer（仓库管理员本人），**禁止**「prevent self review」以外的自动放行，
  并确保工作流不能自行批准自己的部署。
- 审批记录进入 Release 正文（审批人、时间、Commit SHA、QA 证据链接）。
- `workflow_dispatch` 不再提供「跳过 QA 直接发布」的开关；QA 证据必须是
  `qa-evidence-<sha>` artifact 或已签署的本地 attestation（两者都绑定精确 Commit）。

### 5.5 更新清单与通道接力

- 清单生成后立即用 `scripts/verify-updater-manifest.mjs` 校验（版本一致、平台齐全、签名非空、https URL）。
- 通道接力在**发布时**执行（Draft 阶段不能占用 `releases/latest`）：
  Windows 发布时带 `latest-linux-critical.json`，Linux 发布时带 `latest.json`；
  任一缺失 → 发布失败（不允许出现 `releases/latest/download/*.json` 404）。
- 清单内容不可被后续运行覆盖（`--clobber` 只允许在同一次发布事务内使用）。

### 5.6 发布后验证与回滚

- 发布后 job：`gh release download` 取回 `latest.json` + `.sig`，运行清单校验器；
  校验 `releases/latest/download/latest.json` 可直接下载；记录到 `docs/PROJECT_STATE.md`。
- **回滚策略**：不删 Tag、不动已发布 Release（ruleset 本就禁止）；回滚 = 追加一个补丁版本
  并重新走审批流。已发布的旧版本仍可通过固定版本链接下载。

### 5.7 需要用户单独授权的仓库设置变更

1. 创建三个 Environment 并配置 required reviewer。
2. 把 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 迁移到 Environment 作用域，
   并删除仓库级副本。
3. 调整 `Protect release tags` ruleset 的 `bypass_actors`（如需让工作流创建 Tag）。
4. 把仓库默认工作流权限收敛为 `read`（显式声明 `contents: write` 的只有发布 job）。

### 5.8 实施顺序与验收

1. Phase 4.1：建 Environment + 迁移 Secret（需授权）。
2. Phase 4.2：`release-candidate.yml` / `release-publish.yml` 上线，**先只建 Draft 不发布**。
3. Phase 4.3：用一次真实候选跑通「Draft → 审批 → 发布 → 发布后验证」。
4. Phase 4.4：版本 bump 到 `0.17.2`、更新通道清单、跑发布前全量 QA。
5. Phase 4.5：发布 `v0.17.2`（Windows 常规通道），Linux 通道按需单独发。

验收口径：发布前的每个门禁都有可复现证据；`docs/PROJECT_STATE.md` 与 Release 正文一致；
**未取得用户对具体发布的单独授权前，不得推 Tag、不得创建或发布 Release**。

---

## 6. 如何复核本报告

```bash
# 门禁与兼容性
npm run test:governance      # 治理脚本
npm run test:fixtures        # 夹具（防退化）
npm run test:release         # 发行面契约 + 更新清单
npm run format:check         # Rust 格式
cargo test --lib --manifest-path src-tauri/Cargo.toml   # 含两条跨版本兼容断言
node tests/qa/run-qa.mjs --suite=static                 # 静态守卫（含 actions-pinned）

# hosted 全量 QA 证据（绑定 Commit）
gh workflow run qa-full.yml -f ref=<commit-sha>
gh run view <run-id> --json conclusion
gh run download <run-id>   # qa-evidence-<sha>

# 远端发布面（只读）
gh api repos/D-OneXXX/MR/environments --jq .total_count
gh secret list
gh api repos/D-OneXXX/MR/rulesets
gh release list
```

本报告引用的具体 run id：40261202752（诊断）、40263953942（arch 修复后首个 hosted 运行）、
40265639362（hosted 全绿 228/228）。
