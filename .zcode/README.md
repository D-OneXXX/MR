# .zcode — ECC 工程系统在本项目的应用

本目录把 [ECC](https://github.com/affaan-m/ECC)（agent harness 性能优化系统，
MIT，commit `90606c8`）的工作流理念应用到 MangaReader 仓库。
ECC 原生面向 Claude Code 等十余种 harness，**没有 ZCode 适配器**，
因此这里采用「精选移植 + 宪法本地化」而不是跑它的安装器
（`npx ecc-universal` 是交互式向导，且会在工具事件上挂第三方 Node 脚本）。

## 安装了什么

| 位置 | 内容 | 来源 |
|---|---|---|
| `C:\Users\Administrator\.zcode\ecc\` | ECC 完整只读克隆（参考库，4627 个文件） | git clone --depth 1 |
| `C:\Users\Administrator\.zcode\skills\ecc-*`（4 个） | 用户级精选技能：TDD 工作流 / 安全评审 / Conventional Commits 评审 / 深度研究 | ECC skills 改写（去掉 Claude 专属工具引用） |
| 本目录 `agents/`（3 个） | 项目代理：`mr-spec-planner`（规划）、`mr-constitution-reviewer`（宪法评审）、`mr-build-resolver`（构建修复） | ECC planner/code-reviewer/build-resolver 改写，绑定本仓库 AGENTS.md 红线 |
| 本目录 `skills/mr-verify` | 项目技能：AGENTS.md §6 全量验证管线一键执行 | 派生 |

## 刻意没有安装的部分

- **hooks 层**（`scripts/hooks/*.js`）：ECC 的 hooks 深度绑定 Claude Code
  （`CLAUDE_PLUGIN_ROOT`、`~/.claude`、Bash/PowerShell matcher），迁移到 ZCode
  需要重写引导；更重要的是 hooks 在模型上下文之外执行任意第三方脚本，
  属于供应链攻击面（ECC 自己的 README 也警告不要混用安装来源）。**默认不启用。**
  人工审查后如需启用：ZCode 的 hook 事件为 SessionStart / UserPromptSubmit /
  PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop，
  配置在 `~/.zcode/cli/config.json` 的 `hooks` 字段（需 `hooks.enabled: true`）。
- **memory vault / AgentShield 运行时**：依赖 ECC 自身守护进程，同属可执行面。
- 其余 300+ 技能：按需从 `C:\Users\Administrator\.zcode\ecc\skills\` 挑选改写。

## 卸载

- 删 `C:\Users\Administrator\.zcode\ecc\`（参考克隆）。
- 删 `C:\Users\Administrator\.zcode\skills\ecc-*`（用户级技能）。
- 删本目录（`.zcode/`）即可，不影响产品代码与构建。

## 与 AGENTS.md 的关系

AGENTS.md 是本仓库最高优先级工程红线；本目录的所有代理/技能都以其为
前置约束（规划代理必须先做「红线映射」，评审代理按条款逐项审查）。
两者冲突时以 AGENTS.md 为准。
