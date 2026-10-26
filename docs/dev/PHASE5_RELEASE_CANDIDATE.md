# v0.17.2 Release Candidate 准备与验证 · 执行计划与验收报告

> **本文件既是 Phase 5 的执行计划，也是最终验收报告。**
>
> **授权边界（维护者 2026-10-26 授权）**：仅限版本准备、候选构建、自动化测试、
> 安装升级验证与 Release Draft。**不包含正式公开发布**、不发布正式 Release、
> 不修改公开更新清单、不绕过任何发布门禁、不动 Linux 通道。
>
> 本文件不构成发布授权。正式发布必须由维护者本人在全部门禁通过后单独批准。
>
> **2026-10-27 最终更新**：干净 Windows VM 验证已由 GitHub-hosted
> `release-install-verify.yml` 完成（run `40374494977`，ImageVersion
> `20261022.344.1`，证据 SHA-256 `b2f00848…`）；Draft 的旧共享宿主回执已被替换。
> 正式发布仍等待维护者明确授权；审批边界技术隔离仍需维护者配置。最终报告见
> `PHASE5_WINDOWS_RELEASE_ACCEPTANCE.md`；本文 §6/§7 的“干净 VM BLOCKED”已被最终报告替代。

**Goal:** 把 `main` 从 0.17.1 推进到 0.17.2，产出绑定「版本 + Commit + 平台 + QA 证据 +
制品 SHA-256」的 Windows Release Candidate（Draft），并用真实证据验证签名与安装升级链路。

**Architecture:** 复用 Phase 4 已建成的发布状态机：`固定 Commit → 全量 QA →
候选工作流（签名、只建 Draft）→ 绑定校验 → 人工审批 → 发布`。本轮**不触发发布工作流**，
只在候选侧产出证据，并把「干净环境安装验证」这一强制前置条件从口头约定升级为
机器可判定字段，避免共享宿主上的回执满足发布门禁。

**Tech Stack:** Tauri 2.12 / React 19 / Rust 1.98 / NSIS / minisign 0.12 /
GitHub Actions + Environments / Node 22（QA harness）

**Spec:** 维护者 Phase 5 授权指令 12 条；`docs/ENGINEERING_WORKFLOW.md` §8/§9/§13；
`docs/dev/PHASE4_RELEASE_GOVERNANCE.md` §9–§11；`docs/dev/RELEASE.md` §3–§4

---

## Global Constraints

- 版本单一事实源是 `package.json`；只能 `npm run version:sync -- X.Y.Z`，禁止手工改版本。
- 仓库内**不得**存在 `push: tags:` 触发器；正式发布只能经 `workflow_dispatch` + Environment 审批。
- 候选工作流只允许产出 **Draft**；`rehearsal: false` 的常规通道标签必须形如 `vX.Y.Z`。
- 候选 Commit 必须是 `origin/main` 的祖先；QA run 必须 `conclusion=success` 且
  `head_sha` 等于候选 Commit。
- 签名私钥只存在于 `release-windows` / `release-linux` 两个 Environment；
  仓库级 Secret 保持 0；Agent 不得读取、输出、记录任何密钥明文。
- 发布门禁必须「缺证据即拒绝」：不得通过改状态文件、置布尔变量或跳过 Job 绕过。
- Linux 通道独立：本轮**不**触发 `release-candidate-linux.yml` / `release-publish-linux.yml`。
- 不得修改 `releases/latest/download/latest.json` 与 `latest-linux-critical.json`。
- 保留 `v0.0.0-rehearsal` 标签与对应 Draft；不修改任何历史正式 Release 记录。
- 安装验证不得接触真实用户书库：一律用隔离 `MR_DATA_DIR` / `MR_RENDER_CACHE_DIR` /
  `MR_ONLINE_CACHE_DIR`。
- 共享宿主上的验证结果必须**明确标注为非干净环境**，不得冒充干净 VM 证据。

---

## 1. 执行结果总览

| 任务 | 结果 | 关键证据 |
|---|---|---|
| 1 预检与版本规范核对 | ✅ DONE | `main` 干净、版本 0.17.1；`v0.17.1..main` 41 个提交；0.17.1→0.17.2 = `patch / patch-preferred` |
| 2 安装证据「干净环境」硬约束 | ✅ DONE | `machine.cleanEnvironment` + `machine.image` 双端校验；单测与演练同步更新；静态守卫生效 |
| 3 版本同步到 0.17.2 | ✅ DONE | `version:sync` 写 5 个文件；`version:check` OK 0.17.2；`test:version` 6/6 |
| 4 本地完整质量门禁 | ✅ DONE | 见第 5 节；全量 QA **230/230**，P0=P1=P2=P3=0 |
| 5 PR 提交与合并 | ✅ DONE | PR #74 → 合并提交 `f331782`；hosted CI 6 项全绿 |
| 6 打标签 v0.17.2 | ✅ DONE | 标签指向 `f331782`；推送后**零 workflow 被触发** |
| 7 hosted 全量 QA | ✅ DONE | run `40324223701` success，head_sha = `f331782`，230/230 |
| 8 候选 Draft | ✅ DONE | run `40325710339` success；`v0.17.2` Draft，7 个资产，`isDraft=true` |
| 9 验签与安装升级验证 | ✅ DONE（hosted 干净 VM，run 40374494977） | 见最终报告 `PHASE5_WINDOWS_RELEASE_ACCEPTANCE.md` |
| 10 发布闸门与 Draft 隔离 | ✅ DONE | 三道闸门对真实远端 Draft 均拒绝；公开面字节未变 |
| 11 visual:theme-token 观察 | ✅ DONE（未复现） | 本地与 hosted 均 12/12；观察记录已写入 `docs/TESTING.md` |
| 12 验收报告与状态快照 | ✅ DONE | 本文件 + `docs/PROJECT_STATE.md` + `docs/ENGINEERING_WORKFLOW.md` |

---

## 2. 候选身份（唯一事实）

| 项 | 值 |
|---|---|
| 候选 ID | `rc-v0.17.2-f331782a29e5` |
| 版本 / 标签 | `0.17.2` / `v0.17.2`（annotated tag → `f331782a29e53885c061b56d740dbd1faabdec1c`） |
| Commit | `f331782a29e53885c061b56d740dbd1faabdec1c`（PR #74 合并提交，在 `origin/main` 上） |
| 通道 / 平台 | `windows` / `windows-x86_64` |
| QA 证据 | `qa-full` run `40324223701`（success，head_sha = 候选 Commit，230/230） |
| 主制品 | `MangaReader_0.17.2_x64-setup.exe`，SHA-256 `b6d7048894a4b16382ce25b5762c881dba79e03f1642acf3452ceb4f11f1db82`（5 306 377 字节） |
| 签名 | `MangaReader_0.17.2_x64-setup.exe.sig`，SHA-256 `ee09d934…` |
| 清单 | `latest.json`，SHA-256 `d9c43243…`（version 0.17.2 / windows-x86_64） |
| Draft 状态 | `isDraft=true`，`publishedAt=null`，`prerelease=false` |

---

## 3. 本轮实测发现并修复的五个真实缺陷

这五个缺陷都**发生在门禁之前或门禁内部**，发布门禁自己无法发现；其中三个会**直接阻断正式发布**。

| # | 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | **回执契约分裂**（发布阻断级） | 发布工作流第一道闸门 `verify-draft.mjs` 对**安装脚本真实产出的回执**必然判「疑似审批后替换制品」 | `rc-record.mjs` 期望 `installer.sha256` + 检查项 `install/upgrade/rollback/dataIntegrity`；脚本与 `evidence.mjs` 用的是 `artifactSha256` + `freshInstall/upgrade/dataIntegrity/recovery`。两套字段名长期并存 | 统一为**唯一契约**（`artifactName`/`artifactSha256` + 四个检查项），`rc-record.mjs` 与 `evidence.mjs` 对齐；演练夹具与单测同步；新增「旧结构必须被拒绝」用例 |
| 2 | **卸载路径解析错误**（安装验证假失败） | 脚本末尾「卸载后卸载列表不再包含 MangaReader」恒失败，`verdict` 恒为 FAIL | 注册表 `UninstallString` 是**带引号且含空格**的路径（`"C:\Program Files\…"`），脚本用 `.Split(" ")[0]` 截成 `"C:\Program`，卸载器从未执行 | 正确解析引号路径；并对 NSIS 卸载器的**异步清理**做 30s 有界轮询（不弱化断言） |
| 3 | **minisign 在 Windows 上装不上**（发布阻断级） | `Expand-Archive: NotSupportedArchiveFileExtension`，发布流水线第一步就崩 | 压缩包临时文件丢掉了 `.zip` 扩展名，而 PowerShell `Expand-Archive` 只接受 `.zip` | 按 URL 保留真实扩展名（新增 `resolveArchiveName`），并检查解压命令退出码 |
| 4 | **minisign 定位不到 / 选错架构**（发布阻断级） | 报「找不到 minisign」；修复后又命中 `aarch64` 可执行文件而静默拿不到结果 | 官方包解压后位于 `tools/minisign/minisign-win64/x86_64/`，脚本只找扁平路径；递归查找时又未按架构排序 | 递归定位 `tools/minisign` 且**优先宿主架构**；失败时输出工具执行错误 |
| 5 | **发布门禁用标签里的旧脚本**（发布阻断级 + 结构性） | 缺陷 1 修好后仍发不了：标签 `v0.17.2` 被 ruleset 固定在 `f331782`（修复之前），而发布工作流从**标签提交**取门禁脚本 → 仍然按旧契约判「疑似审批后替换制品」 | 发布工作流 `actions/checkout` 标签后再跑仓库里的门禁脚本，等于把「门禁实现版本」与「候选身份」绑死；而 `v*` 标签禁止改删，候选创建后修过门禁就再也无法正式发布——只剩「绕过门禁」一条路 | 发布工作流改为执行 **main 上的当前治理脚本**（`git checkout FETCH_HEAD -- scripts/`）：候选身份仍由 tag / commit / 平台 / 每个制品 SHA-256 单独绑定，门禁实现版本不参与绑定；main 受保护（PR + CI + PR 治理门禁）。静态守卫新增该检查防回退 |

> 缺陷 5 的边界说明：它**不放宽**任何门禁——main 上的门禁比标签里的更严（多了干净环境强制条件）。
> 它消除的是「候选创建后修过门禁 ⇒ 正式发布必然失败 ⇒ 只能绕过」这条结构性死路。
> 若要彻底避免，可用新版本号重新切候选；本轮沿用维护者授权的 0.17.2。

回归保护：新增 `scripts/release-governance/minisign-tooling.test.mjs`（5 项）并入 `npm run test:release`；
`rc-record.test.mjs` 与 `evidence.test.mjs` 新增契约与干净环境用例；演练新增 I8 场景；
静态守卫新增「发布工作流必须用 main 的当前门禁脚本」。

---

## 4. 执行记录（真实输出）

| 步骤 | 命令 / 动作 | 结果 |
|---|---|---|
| 预检 | `git status --short` / `node -p require('./package.json').version` | 干净；0.17.1 |
| 待发布变更 | `git log --oneline v0.17.1..main` | 41 个提交（隐私/更新自检修复 + Phase 4 治理 + 本轮门禁） |
| 版本类型 | `version:sync -- --dry-run 0.17.2` | `kind=patch`、`updateMode=patch-preferred` |
| 版本同步 | `npm run version:sync -- 0.17.2` | 写 `package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` |
| 一致性 | `npm run version:check` / `npm run test:version` | OK 0.17.2；6/6 |
| 本地门禁 | 见第 5 节 | 全绿 |
| PR | `gh pr create` → PR #74 | CI 6 项全绿后 squash 合并为 `f331782` |
| 打标签 | `git tag -a v0.17.2 f331782` + `git push origin v0.17.2` | 推送时间 12:37:35Z；此后**零 workflow 运行** |
| hosted QA | `gh workflow run qa-full.yml --ref main -f ref=v0.17.2` | run `40324223701` success，230/230，P0–P3=0 |
| 候选 | `gh workflow run release-candidate.yml -f tag=v0.17.2 -f qa_run_id=40324223701 -f rehearsal=false` | run `40325710339`：Environment 审批 `waiting → queued`（**维护者本人在 GitHub UI 批准**）→ success |
| 候选产物 | `gh release view v0.17.2` | Draft，7 资产，`publishedAt=null` |
| 摘要比对 | 实际下载 vs `rc-record.json` | 3/3 制品 SHA-256 **完全一致** |
| 清单 | `verify-updater-manifest.mjs latest.json --expect-version 0.17.2 --require-platform windows-x86_64` | OK |
| 验签 | 官方 minisign 0.12 vs `tauri.conf.json` 配置公钥 | `Signature and comment signature verified`，公钥 ID `67CB304460E08E4A` |
| 安装 A | 全新安装 0.17.2 候选 | 全部 OK，`verdict=PASS` |
| 安装 B | 0.17.1 → 0.17.2 覆盖升级 → 回滚 0.17.1 | 全部 OK，`verdict=PASS`（四项 check 全 pass） |
| 数据完整性 | 应用读回 + 直接读 SQLite | 8 本书、`QA Local Folder` 进度 = 3、`scroll_pct=0.42`、`reading_log` 1 行 |
| 闸门 | `verify-draft.mjs` / `verify-evidence.mjs` 对真实 Draft | **拒绝**（非零码），理由见第 6.2 节 |

---

## 5. 本地质量门禁证据

| 门禁 | 结果 |
|---|---|
| `npm run version:check` | OK 0.17.2 |
| `npm run test:version` | 6/6 |
| `npm run test:governance` | 33/33 |
| `npm run test:fixtures` | 3/3 |
| `npm run test:release` | 全绿（发布契约 + 治理 + 证据 + 工具链） |
| `npm run release:rehearse` | 31/31（新增 I8：未声明干净环境即拒绝） |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | ✓ built |
| `cargo test --lib` | 325 passed / 0 failed |
| `cargo test --test e2e_stage1 --test memory_budget` | 全绿 |
| `cargo clippy --all-targets -- -D warnings` | 无告警 |
| `npm run format:check` | 无差异 |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `node tests/qa/run-qa.mjs --suite=static` | 23/23，P0=P1=P2=P3=0 |
| `node tests/qa/run-qa.mjs`（全量） | **230/230 (100.0%)**，P0=P1=P2=P3=0 |
| hosted `qa-full`（候选提交） | **230/230 (100.0%)**，P0=P1=P2=P3=0 |

### 5.1 全量 QA 首轮的 chaos P0：已知 flake 取证（Issue #23 同类）

首次本地全量 QA 得到 223/225，2 个 P0：`chaos:recovery-window`、`chaos:freeze-suite`。

| 取证动作 | 结果 |
|---|---|
| 失败详情 | 恢复窗内容为 WebView2 错误页 `ERR_CONNECTION_REFUSED`（`localhost:1420` 连不上），随后 `freeze-suite` 因找不到「Reload view only」按钮而中断 |
| 本轮变更是否触及该链路 | **否**：改动只有版本号、发布证据契约、静态守卫与文档；未触碰 `resilience.rs` / `RecoveryApp.tsx` / chaos 套件 / Vite 配置 |
| 单独跑 chaos 套件 | **33/33 全过，P0=0**（与 Issue #23 的特征一致：全量中偶发、单独跑必过） |
| 干净工作树复跑全量 | **230/230 全绿** |
| hosted 全量（候选提交） | **230/230 全绿**，chaos 10/10 通过 |
| 处置 | 按 #23 的既定方法处理：不清断言、不跳过套件；用干净工作树 + hosted QA 取两次独立证据 |

### 5.2 `visual:theme-token` 观察（要求 9）

| 运行 | 结果 |
|---|---|
| 本地首轮全量 | 12/12 pass |
| 本地干净树全量 | 12/12 pass |
| hosted `40324223701` | 12/12 pass（工件 `qa-evidence-f331782…`） |
| 单独 visual 复跑 | 12/12 pass |
| hosted 历史 | 近期唯一失败是**另一个**用例（`cache:clear-isolated`，P1，`463a5ed`），已单独处置 |

历史观察：并发负载下的**一次**本地 P2（读取 `--sh-background` 时主题尚未生效）。
本轮**多次独立全量 + hosted 均未复现** → 按要求**不建 Issue**，
改为在 `docs/TESTING.md` 建立观察条目（保留证据 + 复现后的处置路径）。

---

## 6. 验收报告

### 6.1 VERIFIED（有可复现输出）

| 项 | 证据 |
|---|---|
| 版本提升合法且无漂移 | `npm run version:sync -- 0.17.2`；五个版本文件一致为 0.17.2；`version:check` OK；`test:version` 6/6；类型 = patch |
| 本地完整质量门禁 | 全量 QA **230/230**，P0–P3=0；static 23/23；治理 33/33；Rust 325 单测 + 集成测试 + clippy 零告警 |
| hosted 全量 QA 绑定候选提交 | run `40324223701` success，`head_sha = f331782a29e5…`（= 候选 Commit），230/230，P0–P3=0 |
| 标签推送不再触发公开发布 | `v0.17.2` 推送时间 12:37:35Z；此后 `gh run list` **零新增运行**；仓库内无 `push: tags:` |
| Environment 审批真实生效 | deployment `7332256741`：`waiting`（12:51:06Z）→ `queued`（13:09:12Z，**维护者本人在 GitHub UI 批准**）→ `in_progress` → `success`；job 在审批前不执行 |
| 候选只建 Draft | `v0.17.2`：`isDraft=true`、`publishedAt=null`、`prerelease=false`；`releases/latest` 仍是 `v0.17.1-linux-sec1`（id 423315120，published_at 未变） |
| RC 记录绑定完整 | `rc-v0.17.2-f331782a29e5`：版本 / 标签 / Commit / 通道 / 平台 / QA runId / buildCommit / 3 个制品 SHA-256；实际下载摘要 **3/3 完全一致** |
| 候选制品签名有效 | 官方 minisign 0.12 验证 `MangaReader_0.17.2_x64-setup.exe`：`Signature and comment signature verified`，锚定仓库配置公钥 ID `67CB304460E08E4A` |
| 已发布版本信任链仍完好 | 同法验证已发布 `v0.17.1` 安装包（SHA-256 `3e90ece5…`）：通过 |
| 更新清单合法 | `verify-updater-manifest.mjs` OK：version 0.17.2 / platforms `windows-x86_64` |
| Windows 全新安装 | 运行 A：注册项 0.17.2、主程序启动、`library.db` 创建，全部 OK |
| 0.17.1 → 0.17.2 覆盖升级 | 运行 B：注册项 0.17.2、主程序启动、`library.db` 存在且未截断（4096 → 4096） |
| 回滚到 0.17.1 | 重新安装旧版本后仍注册、仍可启动、`library.db` 仍在 |
| 阅读进度与 SQLite 完整性 | 升级 + 回滚后：**8 本书**、`QA Local Folder` 进度 = 3、`scroll_pct=0.42`、`reading_log` 1 行；应用读回与直接读库结果一致 |
| 数据库在版本间无功能变更 | `SCHEMA_VERSION` 两版同为 1；`db.rs` 差异**纯 rustfmt 换行**，新增内容只有测试 |
| 发布闸门对真实远端 Draft 生效 | `verify-draft.mjs` 与 `verify-evidence.mjs` 对**真实** v0.17.2 Draft 均以非零码拒绝；理由仅剩「未声明干净环境」 |
| 闸门唯一阻塞项定位精确 | 控制探针：同一回执仅把 `cleanEnvironment` 置真并补 `image` 后，`verify-evidence` 立即 **OK**（exit 0）——证明签名/摘要/版本/Commit/平台/QA 绑定已全部对齐 |
| 演练候选永不发布 | 对真实远端 `v0.0.0-rehearsal` Draft 跑两道闸门 → 均拒绝「演练候选永远不得发布」 |
| 公开更新面完全未变 | `latest.json` = `64f6038e…`、`latest-linux-critical.json` = `2bdb3af5…`，与 Phase 5 基线**字节一致** |
| 历史记录未被修改 | `v0.17.0` / `v0.17.1` / `v0.17.1-linux-sec1` 三个正式 Release 的时间与内容未动；`v0.0.0-rehearsal` 标签与 Draft 完整保留 |
| 双通道独立 | 本轮**未触发**任何 Linux 工作流；`release-linux-critical` 目录与 `latest-linux-critical.json` 未变 |
| AI 未代批任何正式发布 | `gh run list` 中 **0** 个 `Publish release` 运行；`release-windows` 环境本轮只有一次部署（候选构建），由维护者本人在 UI 批准 |

### 6.2 BLOCKED（当前环境无法完成，未伪造通过）

| 项 | 原因 | 解除方式 |
|---|---|---|
| **干净 Windows VM 上的安装/升级/回滚验证** | 本机是共享宿主（Windows 11 专业工作站版，`WIN-VIIUQOUF1EB`）：无管理员权限、`WindowsSandbox.exe` 不存在、Hyper-V 模块与 vmms 服务缺失、无 Docker/VirtualBox/qemu；且本机本身运行在 hypervisor 内，嵌套虚拟化不可用 | 在一次性干净 Windows VM 上用同一脚本跑两遍（全新安装 + 覆盖升级/回滚，用 `-MergeFrom` 合并），**必须带 `-CleanEnvironment -ImageName "<镜像名>"`**，把 `install-verification.json` 上传为 Draft 资产替换本轮的共享宿主回执 |
| 正式发布本身 | 未授权，且上述强制门禁未解除 | 维护者在干净 VM 补齐证据后，重新触发 `release-publish.yml`，并在 Environment 审批中本人批准 |
| Linux 通道的安装/升级证据 | 无 Linux 主机 | Linux 通道同样需要一份带干净环境声明的安装回执（Linux 侧尚无证据产出脚本） |

> **本轮安装证据的状态**：`install-verification.json` 四项检查全 `pass`，但
> `machine.cleanEnvironment=false`（共享宿主，未传 `-CleanEnvironment`）。
> 因此 `verify-draft.mjs` 与 `verify-evidence.mjs` **必然拒绝**——
> 这是刻意的失败方向，防止「在开发机上跑一遍」冒充干净环境验证。

### 6.3 NOT_VERIFIED（当前无法验证，不代表正常）

| 项 | 说明 |
|---|---|
| 干净环境声明的真实性 | `machine.cleanEnvironment` 由执行脚本的人显式声明，机器只能校验字段；它无法证明那台机器确实干净。这条仍依赖维护者的操作纪律与 VM 的一次性属性 |
| 已安装的**发布版**应用被 CDP 驱动 | 发布版构建不暴露 CDP target；安装脚本以「进程存活」判断，数据核验通过调试构建 + 直接读 SQLite 完成 |
| 正式发布的**公开**路径 | 本轮只到 Draft；`release-publish.yml` 从未被执行过（草稿转公开、清单接力、发布后校验均未实测） |
| minisign 工具自身的发布签名 | 上游未公布其发布用公钥，无法离线验证；工具来源为官方 GitHub Release，SHA-256 固定在 `minisign.digests.json` |
| AI 无法代维护者审批的技术边界 | `gh` 令牌当前登录身份就是维护者 `D-OneXXX`（scopes: `repo`, `workflow`），**技术上具备代批能力**；阻止代批的是流程约束（维护者明确要求 AI 不得代替其审批）与本轮的自律，不是密码学限制。工作流自身的 `GITHUB_TOKEN` 无法审批自己的部署（GitHub 平台规则） |
| 真实用户目录下的升级迁移 | 超出隐私边界，不做自动化 |

### 6.4 需要维护者亲自完成的最小操作

1. **在干净 Windows VM 上重跑安装/升级/回滚**（解除唯一强制门禁）：

   ```powershell
   pwsh -File scripts/release-smoke/windows-install-upgrade.ps1 `
     -PreviousInstaller <v0.17.1 安装包> `
     -Installer MangaReader_0.17.2_x64-setup.exe `
     -ExpectedVersion 0.17.2 -Commit f331782a29e53885c061b56d740dbd1faabdec1c `
     -CleanEnvironment -ImageName "<VM 镜像名>" `
     -DataDirForApp <隔离数据目录> `
     -EmitEvidence install-verification.json `
     -ArtifactName MangaReader_0.17.2_x64-setup.exe
   ```

   再跑一遍「仅全新安装」并用 `-MergeFrom` 合并，然后
   `gh release upload v0.17.2 install-verification.json --clobber` 覆盖本轮回执。
   命令细节见 `docs/dev/RELEASE.md` §4.2。

2. **本人批准正式发布**（仅在第 1 步完成后）：触发 `release-publish.yml -f tag=v0.17.2`
   并在 `release-windows` Environment 审批。**AI 不得代批**；若希望从技术上杜绝，
   可为 Agent 会话使用一个不具备 deployment 审批能力的受限令牌（或撤销本机 PAT）。

3. **决定演练产物去留**：`v0.0.0-rehearsal` 标签与 Draft 已按要求保留；
   ruleset 保护 `v*` 标签的删除/修改，清理需要豁免或接受保留。

4. **Linux 通道**：如需发布 `vX.Y.Z-linux-secN`，需另行准备带干净环境声明的 Linux 安装证据。

---

## 7. 本轮改动清单

| 文件 | 改动 |
|---|---|
| `package.json` / `package-lock.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` | 版本 0.17.1 → 0.17.2（由同步脚本写入） |
| `scripts/release-governance/evidence.mjs` | 安装证据要求 `machine.cleanEnvironment` 与 `machine.image` |
| `scripts/release-governance/rc-record.mjs` | 回执契约统一为 `artifactName`/`artifactSha256` + 四个检查项；新增干净环境校验；`signature-verification.json` 归入治理文件 |
| `scripts/release-governance/verify-signature.mjs` | minisign 递归定位 + 宿主架构优先 + 执行错误输出 |
| `scripts/release-governance/fetch-minisign.mjs` | 压缩包保留真实扩展名 + 检查解压退出码 |
| `scripts/release-governance/minisign-tooling.test.mjs` | 新增 5 项工具链回归测试 |
| `scripts/release-governance/evidence.test.mjs` / `rc-record.test.mjs` | 新增干净环境与契约用例 |
| `scripts/release-governance/rehearse.mjs` | 夹具对齐唯一契约；新增 I8 场景 |
| `scripts/release-smoke/windows-install-upgrade.ps1` | 新增 `-CleanEnvironment` / `-ImageName`；修复卸载路径解析；卸载后有界轮询 |
| `tests/qa/suites/static.mjs` | 静态守卫守住三处 `cleanEnvironment` 契约；新增「发布工作流必须用 main 的当前门禁脚本」 |
| `.github/workflows/release-publish.yml` / `release-publish-linux.yml` | 发布门禁改用 main 上的当前治理脚本；`git fetch` 改用显式 refspec 保证 `origin/main` 存在 |
| `.gitignore` | 忽略本地工具目录 `tools/` |
| `docs/TESTING.md` | CI 门禁章节更新为现有工作流；新增 `visual:theme-token` 观察条目 |
| `docs/dev/RELEASE.md` | 发布流水线描述更新为「候选 → Draft → 审批 → 发布」；§4.2 补干净 VM 参数 |
| `docs/ENGINEERING_WORKFLOW.md` | §10 发布安全状态、阶段表与设置基线同步到 Phase 5 |
| `docs/dev/PHASE5_RELEASE_CANDIDATE.md` | 本文件 |
| `docs/PROJECT_STATE.md` | 由 `npm run status` 生成 |

---

## 8. 复核命令

```bash
npm run test:release          # 发布契约 + 治理单测
npm run release:rehearse      # 隔离发布演练
node tests/qa/run-qa.mjs --suite=static
git ls-remote --tags origin   # 标签：v0.17.2 指向 f331782（不含触发器）
gh release view v0.17.2 --json isDraft,publishedAt   # 期望 isDraft=true / publishedAt=null
```
