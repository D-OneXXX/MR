# v3「暗色玻璃座舱」设计记录

日期：2026-10-20
状态：Phase 1–5 已落地（前端重构，未改后端契约）
取代：`2026-10-06-fluid-v2-design.md`（其“单画布、禁固定三栏”约束自本日起失效）

## 1. 目标与原则

- 管理态：高密度、命令驱动、可扫读的书库/检索舱。
- 阅读态：画布零干扰、控件按需唤醒的沉浸阅读器。
- 一句话原则：**书库让人掌控更多，阅读器让人看见更少**；任何新增控件都要证明自己值得占用像素。
- 不实现、不伪装不存在的能力：系统代理探测与章节模型已由在线直读阶段提供（`detect_system_proxy`、`get_series_books`），v3 只负责展示；无 WebView 验证接管、无标签/收藏/下载队列。

## 2. 双模态布局

### 管理态（Shell / Library）

- 自定义标题栏 48px；导航轨收起 48px，悬停/固定展开 184px（覆盖式，不推挤内容）。
- 主区 ≥1100px 为「导航轨 + 书库画布 + 右侧 Inspector」：
  - Inspector 默认 320px，可拖拽 280–420px，可折叠为 40px 窄条；
  - 宽度/折叠写入 `mr-inspector-width` / `mr-inspector-collapsed`；
  - 窄于 1100px 不渲染 Inspector 列，单击封面改为覆盖式 Sheet；跨断点不自动弹 Sheet。
- 书库工具栏：数据条、搜索、来源筛选（全部/本地/在线）、按合集/平铺、URL 直读、导入、管理。
- 卡片：3:4 封面、12px 圆角、内嵌 2px 进度、hover/focus 浮现标题与进度；网格 `minmax(clamp(132px,12vw,168px),1fr)`，gap 12。

### 阅读态（Reader）

- 全视口、无固定侧栏、无固定壳；画布恒为不透明 `#09090b`（亮色主题同样）。
- 顶部 HUD：返回、标题、页签切换器、缩放组、窗口控制；非交互区兼任拖拽带，另保留 8px 常驻顶部拖拽带（`h-2`）。
- 底部 Dock：上一页、页目录、单页/双页/条漫分段、进度 Slider、页码、下一页、更多。
- 显隐：空闲 1500ms 渐隐；条漫开始滚动立即隐藏；指针移动/按键/顶部边缘唤醒；悬停或焦点在 HUD 内不隐藏；隐藏时 `inert`（不可聚焦）但不卸载 DOM。
- 进度 Slider：拖拽只做本地预览（缩略图仅用已缓存图，不发请求），提交在松手时；键盘 Home/End/方向键不与全局翻页重复触发。

## 3. 视觉 token

`src/v3.css` 定义语义变量，再经 `@theme inline` 映射为 Tailwind 工具类：

| 语义 | 暗色 | 亮色 |
|---|---|---|
| `reader` | `#09090b` | 不适用（阅读画布恒暗） |
| `canvas` | `#0c0c0e` | `#f6f6f7` |
| `surface` | `rgb(24 24 27 / .88)` | `#ffffff` |
| `hairline` | `rgb(255 255 255 / .07)` | `rgb(0 0 0 / .08)` |
| `text` | `#f4f4f5` | `#18181b` |
| `muted` | `#a1a1aa` | `#71717a` |
| `accent` | `#4d7cfe` | `#4d7cfe` |
| `blur` | 12px | 0（亮色实色） |

- 统一描边：`1px solid hairline` + 顶部内高光 `inset 0 1px 0 rgb(255 255 255 / .08)`。
- 模糊只允许出现在 HUD/Inspector/抽屉/弹层；画布层无全屏 `backdrop-filter`；HUD 无永久 `will-change`。

## 4. 技术栈与组件边界

- Tailwind v4（Vite 插件）+ shadcn/Base UI；`@/*` 别名；旧 `theme.css` token 作为兼容桥。
- 目录：
  - `src/components/shell/`：AppShell、TitleBarV3、NavRail、OmniBar、StatusPill；
  - `src/components/library/`：BookInspector（含页目录）；
  - `src/components/Reader/`：ReaderHudTop、ReaderDock、ProgressScrubber、TabSwitcher（复用既有 Webtoon/spread/region/shortcuts）；
  - `src/features/workspace/`：页签模型与轻量会话快照；
  - `src/components/ui/`：shadcn 生成组件。
- 所有 `invoke` 仍集中在 `src/lib/tauri.ts`；后端命令/JSON 形状未改。

## 5. 阅读工作区（页签）

- 固定「书库」页签 + 最多 5 个漫画页签；同一本书只允许一个页签。
- 只有激活页签挂载 Reader（`key=bookId` 强制卸载旧实例）；快照只存页码、scrollPct、版式、方向，不存图片/DOM。
- 切换/关闭前 flush 分页进度（卸载时立即 `set_progress`）；条漫由 Webtoon 卸载钩子提交。
- `clear_pages` 从“每次退出阅读器”移到“关闭最后一个阅读页签”，切页签不清 L1。
- 快捷键：`Ctrl+1` 书库、`Ctrl+2…6` 切页签、`Ctrl+W` 关闭当前；中键关闭页签。
- 下一话替换当前页签，不随章节增长。
- 页签状态仅内存（重启回书库）；`localStorage["mr-tabs"]="0"` 可回退单页签模式。

## 6. 阶段与版本

| 阶段 | 内容 | 版本 |
|---|---|---|
| Phase 1 | Tailwind/shadcn、token、新壳（标题栏/导航轨/OmniBar/状态胶囊） | 0.2.0 |
| Phase 2 | 书库、Inspector、页目录窗口化、在线直读入口 | 0.3.0 |
| Phase 3 | 阅读器 HUD、Dock、进度 Slider、显隐逻辑 | 0.4.0 |
| Phase 4 | 多页签会话、快照恢复、缓存清理时机 | 0.5.0 |
| Phase 5 | 亮色/无障碍收尾（reduced-motion 已覆盖 HUD/弹层/详情动画）、文档同步、全量回归 | 0.6.0 |

## 7. 关键决策与修复

- **三栏回归**：v3 推翻 v2 的“禁固定三栏”；v2 文档已加失效标注。
- **`.hidden` 类冲突**：阅读器状态类原名 `hidden` 与 Tailwind `display:none` 冲突，导致 HUD 隐藏时整页消失、条漫宽度 0、滚动位置重置；改名 `chrome-hidden`。
- **首启动实验开关**：`getSettings()` 只刷新镜像未回灌状态，条漫按钮曾误禁用；读取完成后回灌。
- **Toast 丢失**：超限回退时 Reader 不挂载、页面无 Toaster；改为“监听器 + 待投递队列”，下个 Toaster 挂载后补显示。
- **页签上限**：5 个漫画页签（书库不计入）；超限路由层不挂载 Reader，提示并回退。
- **Mica（未启用）**：需要 `transparent` 窗口 + 透明 WebView 背景，且必须真机验证闪烁/掉帧/截图；本环境 CDP 不可用，无法验证，按提示词“失败即回退实色”，**默认保持不透明壳**。后续若启用，按 `windowEffects: mica` + Win11 22621+ 判定 + 失败回退实色的顺序单独验证。

## 8. 验证与未验证

- 自动检查：`tsc --noEmit`、`npm run build`、`verify-spread.mjs`、`verify-region.mjs` 全通过。
- 组件级验收（Playwright + IPC mock，**当时验证记录**）：Phase 2 38 项、Phase 3 36 项、Phase 4 29 项、回退模式 8 项。
- 真机：应用可启动、窗口响应正常；**真实 WebView2 内 DOM/滚动帧率/DPI/Mica 未测**（本机 CDP 端点零字节返回）。
- 未验证项需真机手测：原生拖放、真实导入/删除、鼠标中键、长时间多页签内存、125%/150% DPI、窗口拖动/最大化。

## 9. 已知限制

- 打包 chunk 约 700KB（2026-10-21 构建）警告未处理（可后续 manualChunks）。
- 页签不跨重启恢复（有意为之，避免陈旧 bookId 与后端“一书一个 currentPage”语义冲突）。
- 阅读态 HUD 在亮色主题下为白色实色（token 行为），若需“阅读 HUD 恒暗”需单独确认。

## 2026-10-21 补充：与 /browser、配对桥接的边界

- v0.6.0 已包含独立的 `/browser` 路由与内嵌浏览器窗口（label `browser`）、下载 zip/cbz 自动导入，
  以及“外部系统浏览器协同导入”的长驻回环桥接。
- 这些能力**不**注入第三方页面脚本、**不**采集或持久化 Cookie、**不**做站点适配；
  浏览器窗口没有任何 Tauri IPC 权限（`capabilities/default.json` 仅授权 `windows: ["main"]`）。
- 因此本文第 12 行“无 WebView 验证接管、无下载队列”应理解为：不做站点登录态接管、
  不做应用内下载队列页面；内嵌浏览器与配对导入属于已交付的独立能力。
