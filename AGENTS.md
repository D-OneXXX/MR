# AGENTS.md · MangaReader 全局架构宪法

> 本文件是 MangaReader（Tauri 2 + React 19.1 + TypeScript 5.8 + Vite 6 + Rust + SQLite）的**最高优先级工程红线**。
> 任何模块的新增、修改、重构都必须先满足本文件，再谈功能实现。
> 违反本文件的改动在评审中一律按缺陷处理（至少 P1）。

- 角色：首席架构师 / 实施代理。
- 使命：本地优先、零遥测、零静默副作用的 Windows 桌面漫画阅读器。
- 当前版本：`0.17.0`（版本单一事实源是 `package.json`，`npm run version:sync` 负责同步）。

---

## 0. 术语与命名

- 视觉体系在本项目内统一称为 **「晴空蓝胶囊新粗野主义（Ice-blue Capsule Neo-Brutalism）」**。
  代码、文档、提交信息里**不得**出现任何第三方设计模板/作品名称作为风格代号；只描述可度量的实现规则
  （全圆角胶囊、`rounded-2xl` 卡片、1px 硬描边、实体偏移阴影、晴空蓝主色）。
- 主题 token 以 `src/index.css` 的 `--sh-*` 为唯一权威；`--mi-*` / `--v3-*` 是历史兼容别名
  （`--v3-reader` 等仍被 `Reader.css` 局部引用），**新代码一律不得新增对它们的依赖**，
  也不得把别名反向写回 `--sh-*` 之外的变量。

---

## 1. 跨模块全局不变量（防失忆与相互覆盖）

### 1.1 UI 形态不变量

- **胶囊层**（必须 100% `rounded-full`）：导航轨、顶栏控件、状态胶囊、命令中心、
  读者 HUD/浮动按钮、Badge、Tab 触发器、胶囊输入框。
- **卡片/面板层**：自定义卡片与面板统一 `rounded-2xl`。
- **基础组件层**：`src/components/ui/` 下的 shadcn 基类（`button.tsx` / `tabs.tsx` /
  `dialog.tsx` / `popover.tsx` / `sheet.tsx` 等）保留自身 radius（`rounded-lg`/`md`/`xl`），
  **只有 `pill` 系列变体是胶囊**；不要为了“全胶囊”去改基类，那会波及全部页面。
- **严禁** 回退成直角后台风格；**严禁** 重新引入已删除的 `theme.css` / `ui.css` / `v3.css` 类名
  （`tests/qa/suites/static.mjs` 有静态守卫）。
- 双主题必须同时成立，并支持跟随系统：

  | 语义 | Light | Dark |
  |---|---|---|
  | 画布 `--sh-background` | `#EFF8FF` | `#0B111E` |
  | 卡片 `--sh-card` | `#FFFFFF` | `#151F32` |
  | 描边 `--sh-border` | `#09090B` | `#334155` |
  | 前景 `--sh-foreground` | `#09090B` | `#F8FAFC` |
  | 主操作 `--sh-primary` | `#38A8F8` | `#38A8F8` |

- 阴影：主表面用硬偏移阴影（`shadow-hard` / `shadow-hard-sm`）；浮层（popover / sheet / dialog）
  允许使用普通阴影（`shadow-md` / `shadow-lg`）与 `--shadow-soft`，不要一律改成硬阴影。

### 1.2 多语言（i18n）不变量

- **严禁** 在组件、弹窗、Toast、错误提示里硬编码中英文串；全部走 `t()`。
- 新增 key 必须同时写入 6 套字典：`zh-CN`、`zh-TW`、`en`、`es`、`ja`、`ko`
  （`src/i18n/messages/*.ts`，每个文件内含六语块，类型由其它语言块约束）。
- 胶囊容器必须有 `whitespace-nowrap` 或弹性宽度保护，防止西语/英语长词溢出。
- 后端错误在非中文界面必须经 `src/features/errors/localize.ts` 本地化，不得直出中文。

### 1.3 日志脱敏与可观测性不变量

- 关键交互动作必须推入前端「最近 20 步操作轨迹」环形队列（`recordBreadcrumb`）。
- 任何涉及本地路径、漫画名（`.zip`/`.cbz`/文件夹）、在线 URL 的日志，展示或导出前必须经
  Rust 侧脱敏（`src-tauri/src/diagnostics.rs` / `security.rs`），禁止原样落盘。
- 日志中禁止出现：Cookie / Token / 请求头值 / 完整签名 URL query。

### 1.4 用户主权第一不变量

- **严禁** 未经用户点击确认的：静默重启、强制切换阅读模式、后台刷新、自动模式切换、遥测上传。
- 任何“看门狗自动恢复”只允许开**独立恢复窗口**并等待用户选择，不得自动重建主窗口。
- **会话级请求头**（`session_online_headers`，用户临时勾选「仅驻留内存」模式时）**只驻留内存**，
  绝不写 SQLite、绝不写日志——这是最高级别约束，任何与它冲突的需求一律以它为准。
- 注意区分：设置里的**全局** `onlineHeaders`（`settings.online_headers`）是用户自己管理的持久化偏好，
  允许落 SQLite；但它同样不得出现在日志、诊断导出与错误文案里。

---

## 2. 路由与残留状态防爆兜底

### 2.1 废弃路由静默重定向

- 真实路由只有 4 条：`/`（书库）、`/reader/:id`、`/browser`、`/settings`；
  `/library` 仅作为历史兼容别名，命中后 `replace` 回 `/`。
- 两套路由表（`src/App.tsx` 的 immersive 分支、`src/components/shell/AppShell.tsx` 的外壳分支）
  **都必须**有通配兜底 `<Route path="*" element={<Navigate to="/" replace />} />`。
- 目标：`#/translator`、`#/glossary`、`#/status`、`#/data`、`#/ocr`、`#/workbench` 等历史路径
  静默重定向到书库首页，**不出现未匹配路由白屏、不产生控制台报错**、`replace` 保证历史栈不留残 URL。

### 2.2 本地持久化状态安全清洗

- 应用启动时（`src/main.tsx`，React 挂载前）必须执行 `src/lib/storageSanitizer.ts` 的
  `sanitizeStorage(window.localStorage)`：
  - 枚举值非法（`mr-theme`、`mr-locale`、`mr-exp-*`、`mr-reader-mode/dir` 等）→ 修正或删除；
  - JSON 类键解析失败 → 删除该键并回落默认值；
  - 废弃前缀（`mr-translator`、`mr-translation`、`mr-ocr`、`mr-glossary`、`mr-batch`、
    `mr-sidecar`、`mr-status`、`mr-data`、`mr-pretranslate`）→ 一律删除；
  - 未知键 → 删除；动态前缀（`mr-reader-`、`mr-wt-`）保留但校验值。
- 清洗必须幂等、try/catch 包裹，localStorage 不可用时静默跳过，**绝不让脏状态导致白屏**。
- SQLite 侧由 `src-tauri/src/versioning.rs::normalize_settings` 负责修复越界设置，
  两者都要在启动路径上被调用。

---

## 3. Tauri 2 权限能力墙

- `src-tauri/capabilities/default.json` 必须覆盖全部真实窗口标签：
  **main**（主窗口）、**recovery**（独立恢复窗，标签见 `resilience.rs::RECOVERY_LABEL`）、
  **browser**（内嵌浏览器，标签见 `browser.rs::BROWSER_LABEL`）。
- 权限只声明代码里**真实调用**的能力（`core:window:allow-*`、`opener:default`、`dialog:default` 等）；
  **严禁** 出现 `fs:allow-*` 全量、`shell:*`、`process:*` 等过宽权限。
- 自研 Rust 命令（`invoke_handler` 注册）不经过 capability ACL；新增命令不需要改 JSON，
  但新增**插件**调用必须同步补权限。
- 官方 Updater 的 `updater:default` 只授予主窗（`capabilities/updater.json`），
  恢复窗/内嵌浏览器窗不得获得更新能力；重启走自研 `restart_app`，**禁止**声明
  `process:*` 全量权限。
- 内嵌浏览器窗只允许 `http/https` 导航，且**禁止跳回应用本地源**（`tauri.localhost`、
  开发态 `localhost:1420`）：远程页一旦自跳到本地 Origin，就可能拿到该窗口的本地能力。
- 新增窗口时必须在同一提交内补齐 `windows` 数组，否则该窗口按钮“点了没反应”。

---

## 4. 生产环境交付四道防线

### 4.1 防杀软误报与安全事务更新

- 严禁直接内存覆写正在运行的二进制。
- 自定义补丁通道的签名校验以构建期注入的 `MR_UPDATE_PUBKEY` 为准：注入了公钥时
  minisign 校验强制生效；未注入公钥时只接受回环（loopback）制品，不允许任何远程包落地。
- 官方 GitHub Updater 通道以 `tauri.conf.json` 的 `plugins.updater.pubkey` 为准，
  只信任 GitHub Releases `latest.json`；CI 必须通过
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 注入私钥，
  **私钥与密码绝不入库**。两条通道可以并存，但不得互相绕过校验。
- Windows 只发布 NSIS，`bundle.targets` 锁定为
  `["nsis", "deb", "rpm", "appimage"]`，不得加入 `msi`；NSIS 使用
  `installMode: "both"`、`compression: "lzma"`、语言选择器与六种内置语言。
  `plugins.updater.windows.installMode` 固定为 `passive`。
- **升级身份不可漂移**：`productName`（MangaReader）、`identifier`
  （com.local.manga-reader）与主程序名是 NSIS 卸载/升级键、桌面快捷方式和
  `.cbz`/`.zip` 文件关联的锚点；静态守卫 `static:release-surface` 会阻止误改。
- 补丁与全量包必须下载到**系统临时目录**（`std::env::temp_dir()`）或应用专属 staging 目录，
  完成 SHA-256 + minisign 签名校验后，由标准安装器事务（PowerShell `-EncodedCommand`，UTF-16LE）
  完成替换；校验失败一律拒绝。Linux deb/rpm 系统安装禁止应用内替换 `/usr` 文件，
  只能引导用户下载后用包管理器安装；AppImage 才允许原地替换。
- 「设置 → 隐私与安全」必须提供 SmartScreen 放行说明与杀软白名单目录建议
  （数据目录 `%APPDATA%\com.local.manga-reader`、缓存目录 `%LOCALAPPDATA%\com.local.manga-reader`、
  系统临时目录）。

### 4.2 超高分辨率条漫自动无损切片

- WebView2 单张纹理高度上限约 16384px；巨图（20000–65000px 高）直送 `<img>` 会显存溢出成黑/白块。
- Rust 侧阈值与常量（`src-tauri/src/pipeline.rs`）：
  - `MAX_SAFE_TEXTURE_H = 8192`：单页渲染输出的安全高度上限，超出即等比再缩放；
  - `MAX_SLICE_H = 4096`：单片源高度上限（正常长宽比下成立；极端长宽比时以整页高度兜底）；
  - `WEBTOON_TILE_H = 2048`：前端可见切片高度，后端与前端切片几何公式必须保持一致。
- 条漫必须**先切后缩**（按源图纵向切带再逐带缩放），避免同时持有原图+缩放图+切片三份缓冲。
- 前端瀑布流按序无缝拼接，任何一片失败必须有可见的失败态而不是空白。

### 4.3 在线直读与受控 WebView 的上下文共享

- 用户通过「辅助 WebView 验证交接」完成站点验证后，Rust 侧登记**辅助会话**（origin → UA / 用户自备请求头），
  后续该 origin 的章节解析与图片拉取复用同一 UA 与同源请求头，避免裸请求器反复 403。
- 辅助会话的请求头**严格按 origin 绑定**：只发给当初登记它的那个站点，其它 origin 一律不附带；
  交接得到的凭据**不得**写进全局会话槽（全局槽会随“当前书同 origin”下发，会把上一站凭据带到下一站）。
- 交接回传的 origin 非法（`file://` 页面的 `location.origin === "null"` 等）时**降级为跳过登记**，
  不得因此阻断章节导入。
- 合规红线：
  - 会话请求头**只驻留内存**，不写 SQLite、不写日志；
  - **不自动抓取、不持久化第三方 Cookie**：交接脚本只运行在用户主动打开的辅助浏览器窗内，
    仅采集章节链接所需的 `img` / `a[href]` 与 `location.origin` / `navigator.userAgent`，
    **不读 Cookie**；应用主窗口不注入任何脚本；
  - 不做验证码破解、不做后台批量爬虫；同步范围仅限用户主动验证与阅读的当前页面。
- 用户请求头只在**同 origin** 发送，跨 origin 一律丢弃（`online/http.rs`）。

### 4.4 全局快捷键输入态隔离守卫

- 所有全局快捷键统一走 `src/features/shortcuts/useGlobalShortcuts.ts`，不得各自手写监听。
- 触发前**强制顺序**：
  1. `event.isComposing === true` 或 `event.keyCode === 229`（中日韩输入法候选）→ 直接 return；
  2. `document.activeElement` / `event.target` 命中 `input` / `textarea` / `select` /
     `isContentEditable` → 直接 return，放行原生输入；
  3. 其余才按 key 分发（翻页 Space/方向键、模式切换 M/F、页签数字键、Ctrl/Cmd+K 等）。
- 唯一的输入态豁免是 `editableExempt`（当前仅 Ctrl/Cmd+W，用于“关闭窗口”保护）：
  它在输入态仍要生效；**除这一项外，任何全局快捷键都不得在输入态触发**。
- 组件内部（上下文菜单、对话框）的**局部**键盘导航不属于全局快捷键，可保留组件级监听，
  但不得劫持阅读器翻页键（Space / 方向键）。
- 行为变更提醒：输入态下 `Ctrl/Cmd+K`（命令中心）不再触发，这与 §4.4 一致。

---

## 5. 其它长期不变量（沿用上一轮审计结论）

- **自然序**：文件名/目录用 `natural_cmp_path`（忽略 `_ - .` 分隔符，数字段按数值），
  卷/话标题用 `natural_cmp`；`1.jpg / 2.png / 10.jpg` 混合扩展名、嵌套目录、前导零都必须稳定。
  严禁在新增路径里退回普通字典序。
- **磁盘缓存**：`render_cache/` 与 `online_cache/` 共用 `diskCacheBudgetMb`（500MB–10GB，默认 2048MB）
  软上限，读取刷新 mtime，LRU 淘汰；清理只删派生目录，绝不碰 `library.db` 与阅读进度。
- **SQLite 并发**：所有生产连接必须经 `db::open` / `db::configure` 开启
  `journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`；
  禁止绕过该入口直接 `Connection::open`，否则高速滚动进度与规则落盘会互相锁库。
- **数据库启动自检**：`init_schema` 后必须运行 `PRAGMA quick_check`；失败时写入稳定
  错误码并阻塞前端，提供 `recover_database_from_backup`（staging → 校验 → 隔离旧库 →
  原子替换）与 `open_data_dir`。**禁止**静默继续启动或吞掉 `set_settings` 的数据库错误。
- **路径锚点**：数据与缓存必须来自 Tauri `app.path().app_data_dir()` / `app_cache_dir()`
  （`MR_DATA_DIR` / `MR_RENDER_CACHE_DIR` / `MR_ONLINE_CACHE_DIR` 仅用于测试隔离），
  启动时 `create_dir_all`；严禁 CWD 相对路径或 exe 同级目录。
- **无 Sidecar**：应用启动不得拉起任何 Python / 8500 端口进程；静态守卫在
  `tests/qa/suites/static.mjs`。
- **在线提纯**：规则 → URL/DOM → 尺寸/宽高比 → 中位宽度/序列聚类 → 站点档案，四层漏斗不得删减。
- **文件关联/单实例**：`.cbz` / `.zip` 与命令行路径只接受已存在的目录或压缩包；
  二次启动由 `tauri-plugin-single-instance` 唤醒主窗，请求只驻留内存队列，
  前端通过 `take_pending_open` 一次性消费。不得把任意参数当可执行命令。
- **失效路径无损重定位**：只有本地源 `NotFound` 才标记 `missing`；重定位在单事务内
  迁移 `id=sha256(newPath)`、`reading_log` 与过滤事件，保留 `current_page` /
  `scroll_pct` / 阅读统计；绝不因文件移动而删记录或重置进度。
- **本地备份/恢复**：`.mrbackup` 只含净化后的 SQLite 快照（书库/进度/统计/设置
  白名单/过滤规则）与白名单前端偏好；**绝不包含**图片缓存、`online_headers`、
  `online_proxy`、`experimental_online`、Cookie、`online_filter_events` 或内部版本标记。
  恢复前必须完整性/计数校验；本地 `books.path` 必须是存在且安全的目录/压缩包，
  无效行跳过并报告，失败不得改活库。
- **删除源文件锚定**：`remove_books(delete_source_files=true)` 只允许删除压缩包或
  宽目录下的实际书目录；系统根、系统目录、用户主目录/文档/桌面/下载等目录本身、
  应用数据/缓存目录一律拒绝，绝不因伪造备份路径误删用户数据。

---

## 6. 变更流程与自检

```bat
:: 1) 版本（package.json 是单一事实源）
npm run version:sync -- 0.15.1
npm run version:check
npm run test:version

:: 2) 编译与单测
npx tsc --noEmit
cd src-tauri && cargo test --lib && cd ..

:: 3) 构建与全量 QA（隔离数据目录 + 本地 stub）
npm run build
node tests\qa\run-qa.mjs
```

- 提交信息遵循 Conventional Commits 中文说明（`feat:` / `fix:` / `refactor!:` + 3–6 条中文要点）。
- 涉及 UI 的改动必须同步：6 语字典、QA 回归、`docs/QA.md`、`docs/TECHNICAL.md`。
- 涉及后端数据结构/命令的改动必须同步：`docs/TECHNICAL.md` 的数据模型与命令契约小节。
- 子代理协作：按**文件所有权**切分，同一文件同一时间只允许一个代理写；主代理负责集成与验收。

### 自检清单（提交前逐条确认）

1. 新增 UI 是否全圆角胶囊 + 双主题 + 六语齐 + 无硬编码文案？
2. 新增后端命令是否在 `lib.rs` 注册、是否在 `docs/TECHNICAL.md` 记录？
3. 新增窗口是否在 `capabilities/default.json` 覆盖？
4. 是否有任何静默重启/强制模式切换/后台上传？
5. 是否有任何路径/漫画名/Cookie/Token 未经脱敏进入日志或 SQLite？
6. `tsc` / `cargo test` / `npm run build` / 全量 QA 是否全绿？
7. 版本号与 `docs/` 是否同步？
