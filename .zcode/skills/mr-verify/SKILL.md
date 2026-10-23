---
name: mr-verify
description: "MangaReader 全量验证管线：按 AGENTS.md §6 顺序跑版本检查、tsc、cargo test、前端构建与 QA 静态套件，汇总红灯与修复方向。提交前或接到『跑一遍验证』时使用。"
metadata:
  origin: derived from ECC build-resolver patterns, adapted for this repo
---

# MangaReader Verify Pipeline

按仓库宪法（AGENTS.md §6）顺序执行验证，任何一步红灯先报告再继续汇总。

## 步骤

```bat
:: 1) 版本一致性（package.json 是单一事实源）
npm run version:check

:: 2) 前端类型
npx tsc --noEmit

:: 3) Rust 单测（--lib）
cargo test --manifest-path src-tauri\Cargo.toml --lib

:: 4) 前端构建（内含 version:check + tsc + vite build）
npm run build

:: 5) 全量 QA（静态守卫 + 隔离数据目录）
node tests\qa\run-qa.mjs
```

## 汇总要求

- 每步给 PASS/FAIL + 失败摘要（第一条错误的文件:行）。
- QA 报告落在 `tests/qa/reports/`，引用其中红灯 id（如 `static:i18n-parity`）。
- 不要为了让管线变绿而改守卫本身；守卫变更需要单独说明理由。
- Linux 专属 cfg 块本机无法验证，提醒由 `.github/workflows/ci-linux-check.yml`
  在 ubuntu-22.04 上覆盖。
