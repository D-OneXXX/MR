# v0.17.2 Release Candidate 准备与验证 · 执行计划与验收报告

> **For agentic workers:** 本文件既是 Phase 5 的执行计划，也是最终验收报告。
> 任务按勾选框跟踪；每完成一项在「执行记录」补一行真实输出。
>
> **授权边界（维护者 2026-10-26 授权）**：仅限版本准备、候选构建、自动化测试、
> 安装升级验证与 Release Draft。**不包含正式公开发布**、不发布正式 Release、
> 不修改公开更新清单、不绕过任何发布门禁、不动 Linux 通道。
>
> 本文件不构成发布授权；正式发布必须由维护者本人在全部门禁通过后单独批准。

**Goal:** 把 `main` 从 0.17.1 推进到 0.17.2，产出绑定「版本 + Commit + 平台 + QA 证据 +
制品 SHA-256」的 Windows Release Candidate（Draft），并用真实证据验证签名与安装升级链路。

**Architecture:** 复用 Phase 4 已建成的发布状态机：`固定 Commit → 全量 QA →
候选工作流（签名、只建 Draft）→ 绑定校验 → 人工审批 → 发布`。本轮**不触碰发布工作流**，
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

## Task 1: 预检与版本规范核对

**Files:**
- Read: `docs/ENGINEERING_WORKFLOW.md` §9.1/§9.2/§10、`scripts/version-lib.mjs`

- [x] **Step 1: 核对工作区与版本**

```bash
git status --short                 # 期望：无输出
git rev-parse --abbrev-ref HEAD    # 期望：main
node -p "require('./package.json').version"   # 期望：0.17.1
```

- [x] **Step 2: 核对已发布版本与待发布变更**

```bash
gh release list --limit 10
git log --oneline v0.17.1..main
```

- [x] **Step 3: 判定 bump 类型**

`scripts/version-lib.mjs::classifyVersionChange("0.17.1","0.17.2")` →
`{kind:"patch", updateMode:"patch-preferred"}`，符合 `docs/ENGINEERING_WORKFLOW.md` §9.1
「已发布版本不得重打 Tag；下一次修复用新的补丁版本」与 §10「已发布 v0.17.1 不含 main 上
后续的隐私/更新自检修复；下一次发布前必须 bump」。

- [x] **Step 4: 结论落档** → 见「执行记录」第 1 行与本文件第 6 节。

---

## Task 2: 安装证据的「干净环境」硬约束

**Files:**
- Modify: `scripts/release-smoke/windows-install-upgrade.ps1`（新增 `-CleanEnvironment` /
  `-ImageName`，证据写入 `machine.cleanEnvironment` 与 `machine.image`）
- Modify: `scripts/release-governance/evidence.mjs`（`validateInstallEvidence` 要求
  windows 通道声明干净环境 + 镜像标识）
- Modify: `scripts/release-governance/evidence.test.mjs`（新增正反例）
- Modify: `scripts/release-governance/rehearse.mjs`（场景 I 增加干净环境判定）
- Modify: `docs/dev/RELEASE.md` §4.2（干净 VM 命令行加新参数）

**Interfaces:**
- Produces: `evidence.mjs::validateInstallEvidence(evidence, expected)` 新增问题串
  「安装证据未声明干净环境（共享宿主上的验证不满足发布强制条件）」；
  证据字段 `machine.cleanEnvironment: boolean`、`machine.image: string`。
- Consumes: 无（纯函数 + 脚本参数）。

- [ ] **Step 1: 写失败测试**（`evidence.test.mjs`）

```js
test("windows 通道拒绝未声明干净环境的安装证据", () => {
  const evidence = baseInstallEvidence();
  delete evidence.machine.cleanEnvironment;
  const problems = validateInstallEvidence(evidence, { channel: "windows" });
  assert.ok(problems.some((p) => p.includes("干净环境")));
});

test("windows 通道要求干净环境声明镜像标识", () => {
  const evidence = baseInstallEvidence({ cleanEnvironment: true, image: "" });
  const problems = validateInstallEvidence(evidence, { channel: "windows" });
  assert.ok(problems.some((p) => p.includes("镜像")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/release-governance/evidence.test.mjs`
Expected: FAIL（新用例失败，旧用例通过）

- [ ] **Step 3: 实现契约**（`evidence.mjs`）

在 `validateInstallEvidence` 的 `machine?.os` 检查之后追加：

```js
const requiredChecks = expected.channel === "linux-critical" ? ... : ...
if (expected.channel !== "linux-critical") {
  if (evidence.machine?.cleanEnvironment !== true) {
    problems.push("安装证据未声明干净环境（共享宿主上的验证不满足发布强制条件）");
  }
  if (!String(evidence.machine?.image || "").trim()) {
    problems.push("安装证据未记录干净环境镜像标识（machine.image）");
  }
}
```

- [ ] **Step 4: 脚本产出字段**（`windows-install-upgrade.ps1`）

参数区新增：

```powershell
  [Parameter(Mandatory = $false)]
  [switch]$CleanEnvironment,

  [Parameter(Mandatory = $false)]
  [string]$ImageName = "",
```

证据 `machine` 段新增：

```powershell
      cleanEnvironment = [bool]$CleanEnvironment
      image = if ($ImageName) { $ImageName } else { $env:IMAGE_NAME }
```

并在声明干净环境但缺少镜像标识时 `Assert-True $false`，使脚本自身失败。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test scripts/release-governance/evidence.test.mjs && npm run release:rehearse`
Expected: 全部 PASS；演练场景 I 增加「干净环境缺失即拒绝」判定

- [ ] **Step 6: 提交**

```bash
git add scripts/release-smoke/windows-install-upgrade.ps1 \
        scripts/release-governance/evidence.mjs \
        scripts/release-governance/evidence.test.mjs \
        scripts/release-governance/rehearse.mjs docs/dev/RELEASE.md
git commit -m "feat(release): 安装证据必须声明干净环境并记录镜像标识"
```

---

## Task 3: 版本同步到 0.17.2

**Files:**
- Modify: `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、
  `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（全部由同步脚本写入）

- [ ] **Step 1: 干跑确认变更类型**

```bash
npm run version:sync -- --dry-run 0.17.2
```
Expected: `change.kind = "patch"`，`updateMode = "patch-preferred"`

- [ ] **Step 2: 执行同步**

```bash
npm run version:sync -- 0.17.2
```

- [ ] **Step 3: 校验无漂移**

```bash
npm run version:check && npm run test:version
```
Expected: 两者均 exit 0，五个版本文件一致为 `0.17.2`

---

## Task 4: 本地完整质量门禁

- [ ] **Step 1: 前端类型与生产构建**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 2: Rust 单测与 clippy**

```bash
cargo test --lib --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run format:check
```

- [ ] **Step 3: 治理与发布契约**

```bash
npm run test:governance
npm run test:fixtures
npm run test:release
npm run release:rehearse
node tests/qa/run-qa.mjs --suite=static
```

- [ ] **Step 4: 依赖审计**

```bash
npm audit --omit=dev --audit-level=high
```

- [ ] **Step 5: 全量 QA**

```bash
node tests/qa/run-qa.mjs
```
Expected: 全部通过、P0/P1 = 0；失败必须定位并修复，**不得跳过**。

---

## Task 5: 提交并合并版本准备 PR

- [ ] **Step 1: 建 Issue**（标题含版本与范围）
- [ ] **Step 2: 建分支**

```bash
git worktree add .worktrees/issue-<id>-release-0-17-2 -b chore/<id>-release-0-17-2 main
```

- [ ] **Step 3: 提交并推送，开 PR**（PR 正文含「验证」「数据与隐私」「发布影响」三段，
  并 `Closes #<id>`）
- [ ] **Step 4: 等 required checks 全绿**（Windows check / Linux check / PR governance /
  Release governance rehearsal）
- [ ] **Step 5: 按保护规则合并**（strict up-to-date），确认 `main` HEAD = 合并提交

---

## Task 6: 打标签 v0.17.2 并确认不触发任何工作流

- [ ] **Step 1: 在合并提交上打标签并推送**

```bash
git tag v0.17.2 <merge-commit>
git push origin v0.17.2
```

- [ ] **Step 2: 记录推送前的 workflow run 数量，推送后核对无新增发版运行**

```bash
gh run list --limit 20 --json databaseId,name,createdAt
```
Expected: 无新增 `Release candidate` / `Publish release` 运行。

- [ ] **Step 3: 核对公开面未变**

```bash
gh release view --json tagName,isDraft    # releases/latest 仍为 v0.17.1-linux-sec1
```
Expected: `latest.json` / `latest-linux-critical.json` 字节不变。

---

## Task 7: hosted 全量 QA

- [ ] **Step 1: 触发**

```bash
gh workflow run qa-full.yml --ref main -f ref=v0.17.2
```

- [ ] **Step 2: 等待并核对**

```bash
gh run list --workflow qa-full.yml --limit 3
```
Expected: `conclusion=success` 且 `head_sha` 等于候选提交；否则记录真实失败原因。

---

## Task 8: 触发 Windows 候选工作流

- [ ] **Step 1: 触发**

```bash
gh workflow run release-candidate.yml --ref main \
  -f tag=v0.17.2 -f qa_run_id=<run id> -f rehearsal=false
```

- [ ] **Step 2: Environment 审批**

`release-windows` 的 required reviewer 为维护者本人；**候选阶段只建 Draft**，
不构成正式发布批准。

- [ ] **Step 3: 核对产物**

```bash
gh release view v0.17.2 --json isDraft,assets
```
Expected: `isDraft=true`，资产含 NSIS 安装包、`.nsis.zip`、`.sig`、`latest.json`、
`rc-record.json`、`rc-summary.md`。

---

## Task 9: 验签与安装升级验证

- [ ] **Step 1: 下载候选制品并校验清单**

```bash
gh release download v0.17.2 --dir candidate --clobber
node scripts/verify-updater-manifest.mjs candidate/latest.json --require-platform windows-x86_64
```

- [ ] **Step 2: 官方 minisign 验签**

```bash
node scripts/release-governance/fetch-minisign.mjs
node scripts/release-governance/verify-signature.mjs \
  --artifact candidate/MangaReader_0.17.2_x64-setup.exe \
  --public-key src-tauri/updater.key.pub --output signature-verification.json
```

- [ ] **Step 3: 安装 / 升级 / 回滚 + 数据完整性**

```bash
pwsh -File scripts/release-smoke/windows-install-upgrade.ps1 \
  -PreviousInstaller <v0.17.1 安装包> \
  -Installer candidate/MangaReader_0.17.2_x64-setup.exe \
  -ExpectedVersion 0.17.2 -Commit <candidate commit> \
  -DataDirForApp <隔离数据目录> \
  -EmitEvidence install-verification.json \
  -ArtifactName MangaReader_0.17.2_x64-setup.exe
```
**本机是共享宿主**：不传 `-CleanEnvironment`，产物 `machine.cleanEnvironment=false`，
据此发布门禁必须拒绝（见 Task 10），这正是诚实结果。

- [ ] **Step 4: 上传两份证据为 Draft 资产**

```bash
gh release upload v0.17.2 install-verification.json signature-verification.json --clobber
```

---

## Task 10: 发布闸门拒绝路径与 Draft 隔离验证

- [ ] **Step 1: 用真实 Draft 跑绑定校验**

```bash
node scripts/release-governance/verify-draft.mjs --tag v0.17.2 --assets-dir candidate
```

- [ ] **Step 2: 跑证据总闸**

```bash
node scripts/release-governance/verify-evidence.mjs \
  --record candidate/rc-record.json --assets-dir candidate \
  --signature-evidence signature-verification.json \
  --install-evidence install-verification.json \
  --public-key src-tauri/updater.key.pub --channel windows --commit <commit>
```
Expected: **拒绝**，理由为「安装证据未声明干净环境」——这正是本轮的真实结论。

- [ ] **Step 3: 确认公开面未变**（`releases/latest`、两个公开清单字节、演练 Draft 仍在）

- [ ] **Step 4: 确认未代批任何发布部署**

```bash
gh api repos/:owner/:repo/actions/runs --jq '.workflow_runs[] | select(.name|startswith("Publish"))'
```
Expected: 本轮没有任何 publish 运行被批准或执行。

---

## Task 11: visual:theme-token 观察

- [ ] **Step 1: 汇总该用例历史失败记录**（CI run 与本地 QA 报告）
- [ ] **Step 2: 本轮是否复现**
  - 复现 → 建 Issue，附复现命令、run id、失败断言、怀疑因素；
  - 未复现 → 在报告里保留观察记录与触发条件（并发负载），并给出后续观察点。

---

## Task 12: 验收报告与状态快照

- [ ] **Step 1: 补全本文件第 6 节**（VERIFIED / BLOCKED / NOT_VERIFIED + 维护者待办）
- [ ] **Step 2: 刷新状态快照**

```bash
npm run status
```

- [ ] **Step 3: 更新 `docs/ENGINEERING_WORKFLOW.md` §13 阶段表**
- [ ] **Step 4: 开 PR 并合并**

---

## 6. 验收报告

> 执行完成后由 Task 12 补全。发布前强制门禁未全绿前，本报告不构成发布申请。

### 6.1 VERIFIED

（待填）

### 6.2 BLOCKED

（待填）

### 6.3 NOT_VERIFIED

（待填）

### 6.4 需要维护者亲自完成的最小操作

（待填）

---

## 7. 执行记录

| # | 任务 | 结果 | 证据 |
|---|---|---|---|
| 1 | 预检与版本规范核对 | DONE | 见 Task 1；执行记录见第 7 节首行 |
