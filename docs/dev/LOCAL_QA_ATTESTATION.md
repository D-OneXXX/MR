# 本地 QA Attestation 流程

> 状态：受控例外流程，适用于 hosted `qa-full` 暂时不可用的发布候选。
> 当前适用原因：#30 / #32 —— windows-2022 / WebView2 131 的全量 QA 在
> `arch:ultra-tall-webtoon` 上无法稳定复现；同一 Commit 本地为 228/228。
> 本流程不能替代发布批准、安装/升级测试或签名校验。

## 1. 何时使用

优先使用 `.github/workflows/qa-full.yml` 在固定 Commit 上生成的
`qa-evidence-<sha>` artifact。只有以下情况才使用本地 attestation：

- hosted QA 被 #30/#32 之类的已记录环境问题阻塞；
- 维护者明确接受该例外，并在发布候选中写明原因与证据；
- 没有未解释的 P0/P1、没有未处置的安全公告；
- 没有通过本流程自动获得发布授权。

hosted QA 恢复稳定后，应优先使用 CI artifact；本地 attestation 保留为补充证据。

## 2. 角色与批准

- **执行者/Attestor**：在本机运行完整门禁并填写 attestation 草稿。
- **维护者（用户）**：审核结果、确认例外、批准发布；AI 不得代替用户批准。
- **发布批准**：Phase 4 的 Draft + 人工审批流程；本文件只提供 QA 证据。

Attestation 必须由维护者在 Draft/Issue 中显式确认，记录：
`Approved by / 日期 / 关联 Draft 或 Issue / 版本 / Commit / 目标平台`。
一次批准只对一个版本和 Commit 有效。

## 3. 前置条件

- 使用**固定 Commit**（完整 40 位 SHA），不是浮动分支。
- 版本已按 `package.json` 单一事实源 bump，并通过版本同步。
- 工作树干净：`git status --porcelain` 无输出（包括未跟踪的非忽略文件）。
- 使用隔离数据目录；绝不指向真实书库。
- 记录操作系统、WebView2、Node、Rust、Tauri CLI 版本。
- 本流程只覆盖 Windows 桌面完整 QA；Linux 的构建/安装证据按
  `docs/dev/smoke-test.md` 与 Linux 发布通道另行记录。

## 4. 执行命令

```bash
git fetch --tags
git checkout <full-commit-sha>
git status --porcelain          # 必须为空
git rev-parse HEAD
node -v
npm -v
rustc -V
cargo -V
npx tauri -V
```

Windows WebView2 版本（PowerShell）：

```powershell
(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv
```

安装与门禁：

```bash
npm ci
npm run version:check
npm run test:version
npm run test:governance
npx tsc --noEmit
npm run build
cargo test --lib --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml \
  --test e2e_stage1 --test memory_budget
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm audit --omit=dev --audit-level=high
cargo audit --file src-tauri/Cargo.lock \
  --ignore RUSTSEC-2026-0367 \
  --ignore RUSTSEC-2026-0368 \
  --ignore RUSTSEC-2026-0369
cargo build --manifest-path src-tauri/Cargo.toml
node tests/qa/run-qa.mjs
```

说明：

- `cargo audit` 例外必须与 `docs/TECHNICAL.md` 记录一致；新增例外不得只写在
  attestation 里。
- 本机没有 `cargo-audit` 时，可引用同一 Commit 的 CI 审计 run ID；仍必须在
  attestation 中写明来源，不能标记为“已本地验证”。
- 本流程不包含安装/覆盖升级、旧版兼容、签名和 Release 资产校验；这些在
  Phase 4/5 的发布门禁单独执行。

## 5. 结果判定

必须同时满足：

1. `tests/qa/reports/latest.json` 的 `buildCommit` 等于
   `git rev-parse --short=12 HEAD`，且**不带 `-dirty`**。
2. `appVersion` 等于 `package.json` 版本，并与目标 Tag/版本一致。
3. 完整 QA 的 P0=0、P1=0；P2/P3 已逐条记录并进入 Known Issues。
4. 没有跳过 suite、没有删除/弱化断言；重试必须记录原因和每一次结果。
5. 质量门禁全部通过；失败项不得用“本地环境问题”直接忽略，必须有证据。
6. 原始 QA 报告文件已计算 SHA-256。

失败/重试规则：

- 首次失败必须保留错误摘要；不得直接覆盖成“通过”。
- 允许对**完整 suite**重试；不允许只重跑单个失败 suite 来拼出通过结果。
- 已知 flake（#32）必须在 attestation 中引用 Issue；第二次仍失败则停止，
  不得继续盲重试。

计算报告哈希（Git Bash）：

```bash
sha256sum tests/qa/reports/latest.json tests/qa/reports/latest.md
git rev-parse HEAD
git status --porcelain
```

## 6. 隐私与存储

- 原始 QA 报告/日志可能包含本机绝对路径；**不要**直接提交到公开仓库或公开
  Release。
- Attestation 只保留：Commit、版本、环境版本、实际检查数、P0–P3、失败/重试
  摘要、报告 SHA-256、Draft/Issue 链接。
- 不写入书库路径、书名、Cookie、Token、请求头、完整私有 URL。
- 原始证据由维护者保管；如必须共享，先按 `docs/TESTING.md` 的脱敏规则处理。
- 默认将脱敏 attestation 放入 Draft Release 说明或关联 Issue；如需仓库内留存，
  仅提交脱敏摘要，不提交原始日志。

## 7. Attestation 模板

复制以下内容到 Draft Release 或 Issue，替换占位符：

```markdown
# MangaReader QA Attestation — v<version>

## 结论

- 状态：PROPOSED / APPROVED
- 版本：v<version>
- 目标平台：Windows x64（NSIS）
- 完整 Commit：<40-char-sha>
- 分支/Tag：<ref>
- 工作树：clean（`git status --porcelain` 为空）
- QA 执行时间：<ISO-8601>
- 执行者：<name>

## 环境

- OS / build：<Windows version>
- WebView2：<version>
- Node / npm：<versions>
- Rust / Cargo：<versions>
- Tauri CLI：<version>

## 质量门禁

- version:check / version tests：PASS
- governance tests：PASS（<n>/<n>）
- tsc / build：PASS
- cargo test --lib：<n> passed
- cargo integration：PASS
- cargo clippy -D warnings：PASS
- npm audit（production）：PASS（0 vulnerabilities）
- cargo audit（书面例外）：PASS（exit 0；例外 RUSTSEC-...）
- 其他：<none or details>

## 完整 QA

- 命令：`node tests/qa/run-qa.mjs`
- 是否隔离数据目录：yes
- 第 1 次：<pass/fail + 摘要>
- 第 2 次（如有）：<pass/fail + 摘要>
- 最终结果：<passed>/<total>；P0=0 P1=0 P2=<n> P3=<n>
- 失败/重试原因：<none or issue link>
- 跳过 suite：none

## 证据哈希

- `tests/qa/reports/latest.json` SHA-256：<sha256>
- `tests/qa/reports/latest.md` SHA-256：<sha256>
- 同 Commit CI 审计 run（如引用）：<run-url 或 none>

## 例外与已知问题

- 使用本地 attestation 的原因：#30 / #32（hosted windows-2022 / WebView2 131）
- 已知 P2/P3：<links>
- 安装/覆盖升级：<未执行 / 单独证据链接>
- 签名/资产校验：<未执行 / 单独证据链接>

## 批准

- Approved by：<maintainer>
- 批准日期：<ISO-8601>
- 关联 Draft/Issue：<url>
- 批准范围：仅 v<version> / <commit> / Windows x64
```

## 8. 发布门禁关系

- 本文件通过后，仍必须完成 Phase 4 的 Draft 资产、签名/校验与用户发布批准。
- 本文件不能用于自动推 Tag、自动发布或绕过安装/升级验证。
- hosted `qa-full` 恢复绿色后，优先使用 `qa-evidence-<sha>`；本地 attestation
  作为补充或环境例外记录。
- 每次发布重新生成 attestation，不继承上一次的批准。
