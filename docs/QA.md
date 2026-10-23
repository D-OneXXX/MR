# MangaReader QA 摘要（v0.16.0）

独立 QA 使用隔离数据目录与本地 stub，不触碰真实书库、不写用户数据。
本轮的架构红线固化在仓库根目录 [AGENTS.md](../AGENTS.md)。

## 最近一次运行（0.16.0 Linux 移植验收）

- 版本：`0.16.0`
- 全量 E2E：**222/222（100%）**，P0=0 · P1=0 · P2=0 · P3=0
  （visual / reader / online / cache / privacy / architecture / chaos 全绿；
  首次以新构建二进制运行时 online/architecture 出现过两例冷启动时序抖动，
  复跑两次均稳定通过，判定为 flake 而非缺陷）
- Rust 单测：**294 passed**（含 Linux 移植新增：ZIP GBK 条目名修复、
  gsettings/kioslaverc 代理解析、`/run/media`+`/mnt` 脱敏、DMABUF 决策表、
  deb/rpm/AppImage 格式解析）
- `npx tsc --noEmit`、`npm run build`、版本门禁：通过
- `cargo check --all-targets`（Windows 宿主）：通过
- Linux 专属 `cfg(linux)` 代码的**真实编译**由
  `.github/workflows/ci-linux-check.yml`（ubuntu-22.04）在推送
  `feat/linux-port` 时验证；`release.yml` 双矩阵产出 deb/rpm/AppImage。

生成的逐条报告在 `tests/qa/reports/latest.md`（构建产物，不提交）。

### 0.16.0 新增验收证据

- **文件关联/CLI 直开 + 单实例**：隔离数据目录启动 debug 应用，传入 20 页 CBZ →
  主窗 hash 为 `#/reader/<id>`，`list_books` 仅该书；再启动第二个实例传入另一本 CBZ →
  第二进程退出码 0，已有主窗自动切到第二本。证据：临时 CDP 冒烟脚本输出
  `FIRST_HASH` / `SECOND_EXIT {"code":0}` / `SECOND_HASH`。
- **失效路径无损重定位**：真实 20 页 CBZ 写到第 15 页 → 重命名文件 → 书库卡片出现
  「文件位置已变更」胶囊 → 点击弹出重定位引导 → 事务迁移后 `currentPage=15`、
  `pageCount=20`、`missing=false`，阅读历史同步迁移。Rust 回归：
  `renamed_archive_keeps_page_fifteen_after_relocation`。
- **备份/恢复**：真实应用内导出 `.mrbackup`（1 本书、偏好 JSON，78 KB）→ 把进度改成
  第 2 页、主题改成 light → 恢复 → 进度回到第 15 页、主题回到 dark、偏好 JSON
  完整带回 `mr-locale=en`；导出快照不含 `online_headers` / 过滤事件 / app_meta。
  Rust 回归：`backup::tests` 5 项。
- **Updater**：`tauri.conf.json` 的 `createUpdaterArtifacts` / `fileAssociations` /
  `plugins.updater` 公钥与 `latest.json` endpoint 已校验；设置页「GitHub 自动更新」
  与「本地备份与恢复」面板在真实应用中可见；静态能力墙 17/17 通过。
  **未实际发布 GitHub Release**，`latest.json` 生成由 `release.yml` 的
  `tauri-action@v1`（`uploadUpdaterJson: true`）保证，需用户配置签名 secrets 后推送 tag 验证。

## 覆盖范围

- 静态与版本红线：三端版本、构建注入、错误行号、移除路由/素材扫描、无 Python/sidecar 自启、
  能力墙窗口标签与权限白名单、条漫纹理安全线常量、**存储键白名单与清洗器对齐**。
- 视觉：双主题 × 六语种、900×600、溢出、设置页 **5 个高内聚分区单行胶囊**、
  对比度（含半透明背景合成）。
- 阅读器：文件夹/ZIP/CBZ、中文/空格/损坏压缩包、自然序（20 页无补零 CBZ、混合扩展名、
  多级目录、中文章节名）、单/双页/条漫、125 页快速滚动、宽度 50–150%、进度恢复。
- 在线：30 页正文 + Logo/广告/二维码/头像；跨页/横幅；推广图标记 → 新章节拦截 → 恢复；
  规则统计/导出；严格 Referer + 桌面 Chrome UA 防盗链图床；Telegram 频道分页、相册、
  Telegraph、压缩包、CDN 403 自愈、浏览器章节面板。
- 缓存：diskCacheBudgetMb 500–10240 持久化/即时生效、render + online 双 L2 写入、
  一键清理释放磁盘且保留 SQLite 阅读进度、清理后重新取页、设置页滑杆/进度/按钮可见。
- 架构宪法（`architecture`）：8 条废弃路由静默重定向到书库首页、
  localStorage 脏键清理（合法键必须保留、二次清洗幂等）、输入态/输入法快捷键隔离、
  800×21000 巨图条漫切片渲染与单页高度钳制、浏览器窗导航白名单、
  **设置 5 分区（zh-CN/en/es）与旧深链映射**、**条漫逻辑页 P 与物理切片解耦**、
  后置模块固定文案六语覆盖。
- 生产红线（`static`）：`tauri.conf.json` 无 externalBin/resources、无 Python/sidecar 自启、
  无无用自定义协议、Zip 按需单条读取、WAL/busy_timeout、数据/缓存路径锚点、
  反 Mock 守卫、能力墙（含恢复窗 `set-title`）。
- 隐私：路径/漫画名/Cookie/Token、JSON 引号键、诊断描述进入 Prompt 前脱敏、URL query 脱敏。
- 韧性：真实主线程死锁、独立恢复窗、重载视图、安全模式、连点、睡眠/唤醒不误判；
  **恢复窗继承主窗 dark 主题 + en 语言 + 英文文案**。
- 更新：SemVer 严格性、补丁/全量回退、清单/安装包签名、非 ASCII 路径安装脚本。

## 本轮（0.15.0）架构宪法与盲区防御

- 新增 `AGENTS.md`：UI 形态 / 六语 i18n / 脱敏与操作轨迹 / 用户主权四条全局不变量，
  以及路由与存储兜底、能力墙、生产交付四道防线、提交前自检清单。
- **盲区 1（失忆/覆盖）**：AGENTS.md + 六语字典 + 能力墙 + 存储清洗白名单静态守卫，
  杜绝新代码回退到直角样式、硬编码文案或未知 localStorage 键。
- **盲区 2（路由/残留状态）**：两套路由表都带 `path="*"` + `Navigate replace`，
  废弃路由（翻译台/词条/状态/数据/OCR/工作台）与 `/library` 别名静默回书库；
  启动前 `sanitizeStorage` 清洗废弃键与非法枚举，隐私模式下静默跳过。
- **盲区 3（能力墙）**：`capabilities/default.json` 覆盖 main / recovery / browser 真实标签，
  权限只声明真实调用项；浏览器窗只允许 http/https 导航并拦截跳回应用本地源。
- **盲区 4（杀软/更新）**：核实更新包走系统临时目录 + SHA-256 + minisign + PowerShell
  安装器事务，全仓无就地覆写 exe；设置页新增 SmartScreen 放行与杀软白名单引导（六语）。
- **盲区 5（超高条漫）**：`MAX_SAFE_TEXTURE_H=8192` / `MAX_SLICE_H=4096`，
  条漫改「先切后缩」，单页渲染高度钳制在纹理安全线内；20000px+ 巨图切片渲染无黑块。
- **盲区 6（过盾上下文）**：辅助 WebView 验证后的会话按 origin 复用 UA 与请求头，
  **严格同 origin 绑定**；凭据只驻留内存、不写库不记日志、绝不跨站携带；
  origin 非法时降级为跳过登记而不阻断导入。
- **盲区 7（快捷键输入态）**：统一 `useGlobalShortcuts`，先判 IME（isComposing / keyCode 229），
  再判输入态（input/textarea/select/contentEditable），最后才分发；
  仅 Ctrl/Cmd+W 关闭保护豁免输入态。

## 本轮（0.15.0 封版）回溯缝合与生产排雷

- **设置信息架构**：7 个 Tab 收敛为 5 个高内聚分区（常规与外观 / 网络与在线源 /
  存储与数据 / 隐私与安全 / 关于与维护）；旧 `?tab=online|reading|cache|updates|support`
  全部映射到新分区；900px + 六语长文案下标签栏单行不溢出。
- **后置模块 i18n**：设置新分区、全局快捷键说明、诊断 Prompt 生成器（35 个字段 × 6 语）、
  恢复窗与诊断面板兜底文案全部走字典；恢复窗实时继承主窗语言/主题，原生标题同步。
- **条漫页/片解耦**：本地 zip/cbz/文件夹与在线图片（含缺尺寸的 Telegram 相册，
  进入条漫时按页惰性探测并回写尺寸）统一走 `get_webtoon_tile`；
  `layout.pages.length`、HUD 页码、scrubber、SQLite 进度始终是逻辑页 P，
  物理切片只参与渲染；修正前端 tile 公式在 2048 整数倍边界的浮点漂移。
- **SQLite 并发**：所有生产连接经 `db::open` 开启 `WAL + busy_timeout=5000 +
  synchronous=NORMAL + foreign_keys=ON`；并发写测试证明不再立即 `database is locked`。
- **路径锚点**：数据根 `app_data_dir`、缓存根 `app_cache_dir`，启动递归建目录；
  `MR_*` 仅测试隔离；旧 `%LOCALAPPDATA%` 库文件原子迁移并 `quick_check`。
- **窗口与恢复链路**：主窗重建/恢复窗显示前按 `available_monitors` 校验，越界 `center()`；
  rage-click/watchdog → recovery 无 mock；capabilities 补齐恢复窗 `set-title`。
- **生产排雷**：`bundle` 无闲置 externalBin/resources；zip 只读中央目录 + 按需单条解压，
  测试断言不落盘；无 `manga-proxy` 自定义协议，URL 百分号编码用真实 loopback 请求回归；
  vite 多入口保证 `dist/recovery.html` 生产可达；日志不再原样落盘漫画名/路径。

## 剩余 P3 backlog

仅 6 条低优先级：条漫坏图重试、连点元素签名、构建哈希漂移、在线 link-local 拦截、
i18n 复数/小数、品牌残留 token。均不影响当前验收。

## 复现

```bat
cd src-tauri && cargo test --lib
npx tsc --noEmit
npm run test:version
node tests\qa\run-qa.mjs
```

真实 Telegram/第三方站点仍建议用你有权访问的频道手动冒烟；自动 QA 使用本地确定性预览 stub。
