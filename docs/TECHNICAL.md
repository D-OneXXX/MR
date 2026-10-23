# MangaReader 技术文档

> 应用版本：`0.16.0`。`package.json` 是版本单一事实源，`npm run version:sync` 同步
> `tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、`package-lock.json`；前端版本由 Vite 注入。

- [README](../README.md)
- [QA 摘要](QA.md)
- [冒烟清单](smoke-test.md)
- [架构宪法 AGENTS.md](../AGENTS.md)

## 1. 定位与边界

本地优先的 Windows 漫画阅读器。书库、缓存、阅读进度、在线学习规则全部落在本机；
不提供账号体系、云同步、漫画源订阅、云端 OCR/翻译。网络请求只发生在用户主动解析 /
阅读在线书 / 检查更新时。

> 全局工程红线写在仓库根目录的 [AGENTS.md](../AGENTS.md)：UI 形态、六语 i18n、日志脱敏、
> 用户主权四条不变量，以及路由/存储兜底、能力墙、生产交付四道防线。改代码前先读它。

## 2. 技术栈

- 前端：React 19、TypeScript 5.8、Vite 6、Tailwind v4、Base UI / shadcn 风格组件、lucide-react。
- 后端：Rust 2021、Tauri 2、SQLite（rusqlite bundled）、image、zip、ureq、reqwest、tokio。
- 字体：Plus Jakarta Sans（SIL OFL），本地打包。
- 平台：Windows WebView2；恢复窗口为独立 Tauri WebView。

## 3. 运行架构

```
main WebView ── IPC ── Tauri commands (Rust)
     │                    ├─ SQLite library.db
     │                    ├─ source/pipeline/cache
     │                    └─ online/http/filter/telegram
recovery WebView ─ IPC ── resilience / diagnostics
browser WebView  ─ 无 IPC 权限，仅导航与下载
```

- 阻塞工作（SQLite、zip、图片解码、网络同步请求）走 `spawn_blocking`。
- 能力墙（`src-tauri/capabilities/default.json`）覆盖真实窗口标签
  `main` / `recovery` / `browser`，权限只声明代码里真实用到的
  `core:window:allow-*`、`opener:default`、`dialog:default`；自研命令不经 ACL。
  官方 Updater 额外由 `capabilities/updater.json` 仅授予 `main`；重启使用自研
  `restart_app`，不声明 `process:*` 权限。
- 主窗口心跳每 1s；6s 无心跳由独立看门狗开恢复窗；系统休眠/唤醒按 tick gap 重置，
  不误判。
- 恢复窗可重载或重建主窗口；重建返回真实结果，不伪造成功。
- 安全模式文件损坏/不可读时 fail-closed；在线命令在 Rust 层再次校验。

## 4. 数据与缓存目录

- 数据根（Tauri `app.path().app_data_dir()`）：`%APPDATA%\com.local.manga-reader\`
  - `library.db`：书库、进度、设置、在线规则、app_meta。
  - `logs/app.log`：错误日志。
  - `downloads/` / `downloads/telegram/`：内嵌浏览器 / Telegram 附件。
  - `safe-mode.json`、`crash-guard.json`：安全模式与启动守卫。
- 缓存根（Tauri `app.path().app_cache_dir()`）：`%LOCALAPPDATA%\com.local.manga-reader\`
  - `render_cache/`：本地/在线页面的成品 JPEG、封面与条漫切片。
  - `online_cache/`：在线原图（按 book + URL + Referer 哈希命名，不含原始 URL）。
- 启动时对数据根与缓存根递归 `create_dir_all`；两者绝不使用 CWD 相对路径或 exe 同级目录。
- 旧版 `%LOCALAPPDATA%\com.local.manga-reader\library.db`（及安全模式/启动守卫文件）在目标缺失时
  一次性 best-effort 复制到新数据根；旧缓存目录不迁移、不删除。
- 两个缓存目录共用 `diskCacheBudgetMb` 软上限（默认 2048 MB，可调 500–10240 MB）；
  读取时刷新文件 mtime，启动、累计写盘 256 MB、每 5 分钟与退出时按最旧优先 LRU 清理。
  清理只删除派生目录，绝不触碰 `library.db`、书库记录或阅读进度。
- SQLite 所有生产连接统一经 `db::open`：`journal_mode=WAL`、`busy_timeout=5000`、
  `synchronous=NORMAL`、`foreign_keys=ON`，避免条漫滚动进度 / 规则落盘 / 缓存统计并发写入时锁库。

环境变量：`MR_DATA_DIR`、`MR_RENDER_CACHE_DIR`、`MR_ONLINE_CACHE_DIR`、
`WEBVIEW2_USER_DATA_FOLDER`（主要用于 QA 隔离）。`MR_DATA_DIR` 隔离模式下缓存根为
`<MR_DATA_DIR>/cache`，且跳过旧数据目录迁移。

## 5. 数据模型

| 表 | 主键 | 内容 |
|---|---|---|
| `books` | `id` | path、title、page_count、current_page、scroll_pct、source_type、meta_json |
| `reading_log` | `(date, book_id)` | 逐日阅读页数 |
| `settings` | `k` | 主题、缓存、目录、在线源等设置 |
| `app_meta` | `k` | last_run_version 等内部标记 |
| `online_filter_profiles` | `host` | 站点选择器、CDN 模板、宽度/aspect 区间、uses |
| `online_filter_rules` | `id` | block/allow + URL 模板/精确 URL/SHA-256/DOM class/尺寸 |
| `online_filter_events` | `id` | 脱敏 URL、原因、动作、尺寸、时间；最多 10000 条 |

- `BookInfo.path` 对在线书就是规范化 URL，`id = sha256(path)`。
- `BookInfo.missing` 不落库：`list_books` / `get_book` 对本地源做一次
  `symlink_metadata`，仅 `NotFound` 标记为 `true`（权限/网络盘错误不误判）；
  在线书恒为 `false`。
- **无损重定位**：`relocate_book(bookId, newPath)` 在单事务内把 `books.id` 从
  `sha256(oldPath)` 改为 `sha256(newPath)`，同步迁移 `reading_log.book_id` 与
  `online_filter_events`，保留 `current_page` / `scroll_pct` / `updated_at` /
  `source_type` / `meta_json`，并按新页数钳制页码。移动/改名文件后重导入不会产生重复书。
- 在线 `meta_json` 是 `StoredMeta`：`pages[]`、`filtered[]`、`filter_profile`、系列/下一话链路。
- `PageRef` 可带 `anchor { channel, messageId, photoIndex, refreshBase }`。
- `reading_log(date PK)` 旧库迁移在单事务内完成；崩溃遗留的 `reading_log_legacy`
  会在下次启动合并后删除。
- 页数缩小用 `MIN(current_page, page_count-1)` 钳制。

## 6. 后端模块

| 模块 | 职责 |
|---|---|
| `lib.rs` | 设置、启动迁移、命令注册、路径解析入口 |
| `paths.rs` | `app_data_dir` / `app_cache_dir` 锚点、旧库原子迁移与 `quick_check` |
| `db.rs` | SQLite schema、WAL + `busy_timeout=5000`、书库/进度/设置/统计/重定位事务 |
| `commands.rs` | 书库/取页/进度/设置/在线导入/过滤标记恢复/失效路径重定位 |
| `open_with.rs` | 文件关联与命令行参数过滤、单实例唤醒、待打开请求内存队列 |
| `backup.rs` | `.mrbackup` 导出/恢复、快照净化、完整性/计数校验、事务导入 |
| `source.rs` | 文件夹/zip/在线源；自然排序、zip bomb 上限、CDN 刷新 |
| `pipeline.rs` / `cache.rs` / `render_cache.rs` / `disk_cache.rs` | 解码缩放、三级内存缓存、渲染 L2、在线原图 L2 与统一 LRU |
| `online/{mod,http,direct,html,filter,telegram,handoff}.rs` | 在线直读全链路 |
| `browser.rs` | 独立浏览器窗口、下载捕获、zip/cbz 导入 |
| `update.rs` | 更新清单、签名、下载、安装与重启 |
| `diagnostics.rs` | 诊断包、脱敏、Prompt 导出 |
| `resilience.rs` | 心跳、连点、恢复窗、安全模式 |
| `security.rs` / `versioning.rs` / `system_proxy.rs` | 隐私检查、版本迁移、系统代理 |

### 6.1 条漫巨图切片（WebView2 纹理上限防御）

- WebView2 单张纹理高度上限约 16384px；巨图（>8000px）直送 `<img>` 会显存溢出成黑/白块。
- Rust 侧常量（`src-tauri/src/pipeline.rs`）：
  - `MAX_SAFE_TEXTURE_H = 8192`：单页渲染输出高度上限，超出即在缩放阶段直接落到该上限
    （`orig_width/orig_height` 仍报源图尺寸，宽高比误差 <1%）；
  - `MAX_SLICE_H = 4096`：单片源带行数上限；
  - `WEBTOON_TILE_H = 2048`：输出切片高度上限。
- 条漫走「先切后缩」：解码一次 → 按源图切带（每带 ≤4096 行）→ 逐带缩放到显示宽 → 输出连续切片；
  峰值内存只多活「一条源带 + 一张切片栅格」，不再同时持有原图/整图副本/全部切片。
- 切片边界与前端 `webtoon_tile_count` / `tileTopAt` 同一公式（`round(j*disp_h/n)`），
  前后端几何一致，不出现缝隙或重叠。
- 在线清单缺 `width/height`（典型：Telegram 相册只有 CDN URL）时，用户**显式进入条漫**
  才按页读取探测尺寸并回写 `meta_json`；只探测缺失页，不后台爬取，后续布局/启动直接复用。

### 6.2 辅助 WebView 上下文复用

- 用户通过「辅助 WebView 验证交接」完成站点验证后，Rust 侧登记**辅助会话**
  （`origin → { user_agent, headers }`），仅驻留进程内存（`AppState::assisted_sessions`）。
- `UreqTransport::new_with_assisted` 按**当前 hop 的 origin** 查表：命中则用该会话的 UA
  与请求头，未命中回落到标准桌面 Chrome UA。
- 作用域：辅助会话的请求头**严格按 origin 绑定**——只发给当初登记它的那个站点，
  其它 origin 一律不附带；交接得到的凭据**不写全局会话槽**，避免「上一站凭据被带给下一站」。
- 降级：origin 非法（`file://` 页面 `location.origin === "null"` 等）或请求头非法时，
  只跳过登记 / 忽略该头，**不阻断章节导入**。
- 合规边界：脚本只回传 `location.origin` 与 `navigator.userAgent`，**不读 Cookie**；
  注册表不写 SQLite、不写日志（只记脱敏 host）；停止交接或清理在线痕迹即作废。

### 6.3 自然序

- `natural_cmp` 用于卷/话标题：数字段按数值比较，数字与非数字结构不同时保持字典序，
  避免把「第10话」和「第2卷」混排。
- `natural_cmp_path` 用于文件夹、ZIP/CBZ 条目：逐级目录比较，文件名按 token 比较并忽略
  `_ - .` 与空白，因此 `page_2 < page_10`；`1.jpg / 2.png / 10.jpg` 混合扩展名也按页号。
- 递归扫描子目录、合集章节与前端章节列表使用同一顺序；`01.jpg` 与 `1.jpg` 数值相同时
  以稳定字典序兜底，保证跨平台结果一致。

### 6.4 文件关联、单实例与命令行直开

- `bundle.fileAssociations` 注册 `.cbz` / `.zip`；Windows 安装器负责写入关联。
- 首次启动：`setup` 读取 `std::env::args_os()`；二次启动：
  `tauri-plugin-single-instance`（必须是第一个插件）回调唤醒主窗并转交 argv。
- `open_with::extract_paths` 只接受**已存在目录**或 `.zip` / `.cbz` 文件，跳过 exe、
  空串、`-` 开关与不支持文件，Windows 下小写去重；绝不把任意参数当命令执行。
- 导入在后台线程复用 `commands::import_blocking`；结果写入 `AppState` 的内存 FIFO
  （上限 16 条），并发送无载荷 `open-with-pending` ping。前端循环调用
  `take_pending_open` 消费，重复事件不会重复打开；安全模式开启时只入库、不挂 Reader。
- 日志只记计数/稳定 ID 前缀，不落命令行路径或书名。

### 6.5 本地备份与恢复（`.mrbackup`）

- 导出：`VACUUM INTO` 生成一致性快照 → 净化（删除 `settings.online_headers`、
  `online_filter_events`、`app_meta`）→ `VACUUM` 抹除空闲页 → `PRAGMA integrity_check`
  → 切 `journal_mode=DELETE` → 写入 zip（`manifest.json` + `library.db` +
  可选 `preferences.json`）。目标文件先写同目录临时文件，再原子替换。
- 恢复：zip 条目数/大小/名称校验，缺 `manifest` 或路径穿越直接拒绝；`library.db`
  解压到系统临时目录，只读 `integrity_check`、必需表和列、manifest 计数全部通过后，
  才用 `ATTACH` + 单事务清空/复制核心表；失败 `ROLLBACK`，活库不动。
- 恢复范围：`books`、`reading_log`、`settings`（保留当前 `online_headers`）、
  `online_filter_profiles`、`online_filter_rules`；**不含**缓存、Cookie、过滤事件、
  `app_meta`。恢复后刷新内存设置、缓存预算、内存/磁盘派生缓存与源句柄。
- `preferences.json` 由前端白名单采集（主题/语言/阅读器偏好），后端只校验
  JSON 对象与大小并原样透传；恢复后前端写回 localStorage 并即时应用主题/语言。

## 7. 在线直读

### 7.1 入口

`online::resolve_with` 按顺序：

1. `tg://` / `t.me` / `telegra.ph` → Telegram Provider。
2. 其他 http(s) → 只拉取一次，先 JSON 清单，再 HTML 图集。
3. 合法 JSON 但语义错误不回退 HTML；书身份保持用户请求 URL。

### 7.2 JSON 清单

```json
{"version":1,"title":"...","seriesId":"...","nextUrl":"...",
 "pages":["https://...",{"url":"https://...","width":800,"height":1200}]}
```

- 页数 1..=5000；URL 规范化、保序去重；宽高必须同时为正。
- 合集 `chapters` 1..=100；`chapter_index` 1-based；下一话自动串联。
- 清单变化才清派生缓存并失效源句柄。

### 7.3 HTML 图集

- 单页 `<img>`，不执行 JS、不跟随分页查看器。
- 支持 `data-src` / `data-original` / `data-lazy-src` / `data-srcset` / `src`。
- 轻量标签扫描器追踪元素栈，剔除 header/footer/nav/aside、评论/推荐/分享等 chrome。
- 按 BOM / `<meta charset>` 解码（encoding_rs，GBK/Shift_JIS 等），支持 `<base href>`。
- 跳过 script/style 内容、注释、SVG/ICO 与占位符。

### 7.4 图片提纯

四层漏斗：用户规则 → URL/属性/容器 → 尺寸与宽高比 → 中位宽度/序列聚类/站点档案。

- 默认阈值：最小 320×240；aspect > 2.8 判横幅；中位宽度偏差 40%。
- 缺尺寸最多探测 24 张图片头；探测失败不阻断。
- 用户标记写 block 规则（URL 模板 + 精确 URL + SHA-256）；恢复写 allow 规则并放宽
  站点宽度/aspect。仅当模板不是正文主模板时才写 URL 模板，避免误封整章。
- 所有规则/事件只保存脱敏 host + path，不保存 Cookie 或签名 query。

### 7.5 Telegram

- 支持 `t.me/<channel>`、`t.me/s/<channel>`、`t.me/<channel>/<id>`、`tg://resolve`、
  `telegra.ph/<slug>`。
- 频道预览聚合相册组、Telegraph、zip/cbz 附件；剔除纯文本、投票、贴纸、头像、语音、
  圆形视频；`?before=` 向上分页。
- 单条消息用 `?embed=1` 取相册原图；每页保存 `channel + message_id + photo_index` 锚点。
- 图片 403/404 时 `OnlineSource` 按锚点重取嵌入页、刷新直链并重试一次。
- 文档下载上限 256 MiB，落 `<数据目录>/downloads/telegram` 后校验 zip/cbz 再导入。
- 无登录、无 Cookie、无 WebView 脚本注入。QA 专用 `MR_TELEGRAM_TEST_ORIGIN` 只在
  debug 构建且仅接受 loopback。

### 7.6 图片请求代理与磁盘缓存

- 前端不直接请求第三方图床：在线页、封面、过滤预览都通过 Rust `get_page` /
  `get_thumbnail` / `get_filtered_preview` 返回 data URL，因此不存在浏览器 CORS 问题。
- 单页请求自动携带整本规范化 URL 作为 Referer/Origin；跨 origin 时去掉 query/fragment。
  UA 固定为标准桌面 Chrome，复用设置中的系统/自定义 HTTP(S)/SOCKS5 代理。
- 原图按 `book_id + URL + Referer` 哈希落 `online_cache/`；成品 JPEG 落 `render_cache/`。
  两层都命中时不再发网络请求；403/404 的 Telegram 直链仍按消息锚点刷新。
- 两目录由 `AppState::trim_disk_cache` 共用软上限（设置项 `diskCacheBudgetMb`，500–10240 MB）；
  读取刷新 mtime，按最旧优先淘汰；设置页可查看占用/分项并一键清空临时缓存。
- `clear_temp_cache` 同时清空内存页/缩略图/条漫切片与两个磁盘目录，但不删除 SQLite 的任何行。

### 7.7 请求头作用域

- 支持 JSON 对象或单行 Cookie；禁止 Host/Content-Length/Connection/Transfer-Encoding；
  拒绝 CRLF。
- 用户请求头只在同 origin 发送；跨 origin 丢弃，只保留派生 Referer/Origin。
- 会话请求头 `session_online_headers` 仅内存，绝不写 SQLite/日志。

## 8. 更新与版本

### 8.1 自定义补丁通道（保留）

- SemVer 严格 `MAJOR.MINOR.PATCH`，拒绝 `1.2`、`01.2.3`、四段版本。
- PATCH 优先补丁；MINOR 可补丁；跨多个 MINOR / MAJOR 回退全量。
- 更新清单签名覆盖 version、URL、sha256、size、notes 等字段；构建期 `MR_UPDATE_PUBKEY`。
- 安装包按 sha256 + minisign 校验；下载连接超时 20s，分块空闲超时，总上限 60 分钟。
- 安装使用 PowerShell `-EncodedCommand`（UTF-16LE），支持中文/emoji 路径；不写 UTF-8 `.cmd`。

### 8.2 官方 Tauri Updater / GitHub Releases（0.16.0）

- `bundle.createUpdaterArtifacts = true`；`plugins.updater.pubkey` 保存 minisign 公钥，
  `endpoints` 指向 `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json`。
- 客户端「设置 → 关于与维护」新增 GitHub 自动更新区：手动检查（不自动轮询）、
  显示版本/日期/纯文本 notes、下载进度、安装完成提示；重启只在用户点击
  `restart_app` 后发生。Windows 安装器退出/重启属于用户点击安装后的预期行为。
- CI `release.yml` 在推送 `v*` 标签时：校验 tag 与 `package.json` 版本一致 →
  `npm ci` → `tauri-action@v1`（NSIS，`uploadUpdaterJson: true`）→ 上传签名安装包与
  `latest.json`。签名私钥由 `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 注入，**绝不入库**。
- 权限：仅 `capabilities/updater.json` 对 `main` 授予 `updater:default`；
  `restart_app` 是自研命令，不需要 `process:*`。
- `version:sync` 先校验全部文件再统一写入，失败回滚，不产生半迁移。

### 8.3 Linux 更新策略（feat/linux-port）

- 安装形态由 Rust `platform::install_channel()` 判定，经 `get_app_info` 的
  `linuxInstall` 字段暴露：`appimage`（`APPIMAGE`+`APPDIR` 运行时注入）/
  `system`（exe 位于 `/usr`、`/opt`，deb/rpm 管辖）/ `portable` / 空串（非 Linux）。
- **AppImage 运行态**：自研更新通道新增 `appimage` 制品格式
  （`resolve_format` 识别 `.AppImage`/`deb`/`.rpm`）；`install_appimage`
  备份旧文件 → 改名新包 → 拉起新进程，任一步失败回滚，无需 root。
- **系统安装态（.deb/.rpm）**：应用绝不以 root 自居改 `/usr` 下文件；
  安装按钮替换为手动引导（`sudo apt install ./MangaReader_<v>_amd64.deb` /
  `sudo dnf install ./MangaReader-<v>-x86_64.rpm`），安装包暂存于
  `/tmp/mangareader-updates/`；同时提示 Ubuntu 22.04+ 运行 AppImage 需
  `libfuse2`。
- 打包目标经 `src-tauri/tauri.linux.conf.json` 平台 overlay 固定为
  `["deb","rpm","appimage"]`（Windows 的 `tauri.conf.json` 不受影响）；
  `.cbz`/`.zip` 的 MIME 关联（`application/vnd.comicbook+zip`）由
  `fileAssociations` 生成 `.desktop` 条目，支持文件管理器双击直开。

## 9. 隐私与韧性

- 诊断包、错误、日志、描述、Prompt 均经 Rust 脱敏：Windows/Unix 路径、漫画名、
  Cookie/Token/JSON 引号键、URL query。
- 在线书路径展示去掉 query/hash/userinfo。
- 嵌入浏览器使用独立 WebView，无 IPC 权限；下载只允许 zip/cbz；
  导航只允许 http/https，并拦截跳回应用本地源（`tauri.localhost`、开发态 `localhost:1420`），
  避免远程页借导航变成「本地 Origin」拿到窗口能力。
- 独立恢复窗口与安全模式；不自动刷新、不静默重启、不上传。
- 恢复窗继承主窗 `mr-theme` / `mr-locale`（storage 事件实时同步），原生标题按
  `recovery.windowTitle` 调用 `setTitle`；`capabilities/default.json` 只补该权限。
- 取页/缩略图/切片失败日志只写稳定书 ID 前缀 + 页码 + 脱敏错误，
  不落书名、本地路径、完整 URL/query。
- 睡眠唤醒按 tick gap 重置；最小化/隐藏不判死。
- CBZ/ZIP 打开时限制 10000 页 / 4 GiB 声明解压体积，单页读取上限 32 MiB。

## 10. 前端

路由只有 4 个页面：

| 路由 | 页面 |
|---|---|
| `/` | 书库 + Inspector |
| `/reader/:id` | 沉浸阅读器（单页/双页/条漫） |
| `/browser` | 地址栏、Telegram 章节、下载列表 |
| `/settings` | 常规与外观 / 网络与在线源 / 存储与数据 / 隐私与安全 / 关于与维护 |

- `/reader/:id` 不挂 AppShell；阅读器以 bookId 为 key。
- 设置页固定 5 个高内聚分区；旧 `?tab=online|reading|cache|updates|support` 分别映射到
  `network` / `storage` / `storage` / `about` / `about`；`?tab=privacy` 保持直达。
- 条漫进度以逻辑页 P 写入 SQLite：物理切片只用于渲染，`get_webtoon_layout` 长度、
  HUD 分母与 scrubber 均以 `book.pageCount` 为准。
- 路由只有 4 条：`/`、`/reader/:id`、`/browser`、`/settings`；`/library` 是历史别名。
  两套路由表都带 `<Route path="*" element={<Navigate to="/" replace />} />`，
  已下线路径（翻译台/词条/状态/数据等）与任意乱码深链静默 replace 回书库首页，
  不留残 URL、不出现未匹配路由白屏。
- 启动前（`src/main.tsx`）执行 `src/lib/storageSanitizer.ts`：
  枚举越界修正、JSON 坏值删除、废弃键前缀（`mr-translator`/`mr-ocr`/`mr-glossary`/
  `mr-batch`/`mr-sidecar`/`mr-status`/`mr-data`/`mr-pretranslate`）清除、
  未知键清理；清洗幂等且 try/catch 包裹，localStorage 不可用时静默跳过。
- 全局快捷键统一走 `src/features/shortcuts/useGlobalShortcuts.ts`：
  先判 `isComposing`/`keyCode===229`（输入法候选），再判输入态
  （input/textarea/select/contentEditable），最后才分发；阅读器、页签切换、
  条漫画布共用同一守卫。
- 六语种：zh-CN、zh-TW、en、es、ja、ko；所有 UI 文案走 `t()`。
- 条漫：固定布局高度、DOM 窗口切片、滚动 120ms 空闲合流、最多 4 个在途请求；
  切换版式使用 Webtoon 实时中心页，避免 400ms 防抖导致进度回退。
- HUD/Dock 自动隐藏；过滤抽屉/目录/设置弹层会锁定 HUD。
- 书库失效态：`BookInfo.missing` 为 true 时书卡显示「文件位置已变更」胶囊，
  单击/双击/回车都打开 `RelocateDialog`，不进入 Reader；详情 Sheet 同步显示
  重新指定/从书库移除两个胶囊按钮。
- `OpenWithBridge` 挂载在 WorkspaceProvider 内：启动与 `open-with-pending` 时
  循环消费 `take_pending_open`，有书则 `nav('/reader/:id')`，安全模式下只回书库。
- 设置 → 存储与数据新增 `DataBackupPanel`：导出/恢复胶囊按钮、保存/打开对话框、
  覆盖确认、偏好白名单应用、关闭旧页签并广播书库/设置刷新。
- 设置 → 关于与维护保留原有自定义补丁通道，并新增 GitHub 官方更新区；
  所有文案六语齐全，不自动检查、不自动重启。

## 11. 命令契约

只读 / 书库：`scan_library`、`import_books`、`remove_books`、`list_books`、`get_book`、
`get_next_book`、`get_series_books`、`list_entries`、`get_page`、`get_thumbnail`、
`clear_thumbnail_cache`、`clear_temp_cache`、`get_webtoon_layout`、`get_webtoon_tile`、
`get_memory_stats`、`get_dashboard`、`get_reading_log`、`get_reading_by_book`、`set_progress`、
`clear_pages`、`relocate_book`、`take_pending_open`、`export_backup`、`import_backup`。

设置与在线：`get_settings`、`set_settings`、`resolve_online_url`、`test_online_connection`、
`import_resolved_pages`、`resolve_online_batch`、`resolve_telegram_channel`、
`download_telegram_document`、`get_online_filter_status`、`list_online_filter_rules`、
`export_online_filter_rules`、`import_online_filter_rules`、`reset_online_filter_rules`、
`get_filtered_pages`、`get_filtered_preview`、`mark_online_page_non_content`、
`restore_online_filtered_page`、`set_session_online_headers`、`clear_session_online_headers`、
`get_session_online_headers`。

系统：`start_browser_handoff`、`stop_browser_handoff`、`get_browser_handoff_status`、
`detect_system_proxy`、`open_browser_window`、`navigate_browser`、`list_browser_downloads`、
`import_browser_download`、更新命令（含官方 Updater 前端插件的 `check` /
`download` / `install` 与自研 `restart_app`）、诊断命令、韧性/安全模式命令。

事件：`open-with-pending`（无载荷，单实例/文件关联新请求 ping）、
`online-handoff-imported`、`browser-download` 等保持原有契约。

## 12. 测试

```bat
cd src-tauri && cargo test --lib
npx tsc --noEmit
npm run test:version
node tests\qa\run-qa.mjs
```

QA 覆盖：静态/版本红线、双主题六语种、阅读器导入与 125 页条漫压测、自然序（20 页 CBZ /
中文章节名）、在线 30 页噪音与推广图学习、严格 Referer + 桌面 UA 防盗链、Telegram
频道/消息/403 自愈、磁盘缓存上限/清理隔离、诊断脱敏、混沌/恢复窗/安全模式。
运行报告写入 `tests/qa/reports/latest.md`（生成物不提交）。

Linux 专属代码（`#[cfg(target_os = "linux")]`）在 Windows 宿主上不参与编译，
由 `.github/workflows/ci-linux-check.yml`（push/PR 到 `feat/linux-port` 触发，
ubuntu-22.04）执行 `cargo check --all-targets` + `cargo test --lib` +
前端 `tsc`/`vite build` 真实验证；纯逻辑（GBK 条目名修复、gsettings/kioslaverc
解析、DMABUF 决策表）写成跨平台纯函数，Windows 宿主单测同样覆盖。
`release.yml` 为 `windows-latest`（NSIS）+ `ubuntu-22.04`（deb/rpm/AppImage）
双矩阵。

## 13. Linux 适配要点（feat/linux-port）

- **启动期加固**（`src-tauri/src/platform.rs`）：安全模式、用户显式
  `MR_FORCE_DISABLE_DMABUF=1` 或「Wayland + NVIDIA 专有驱动」时，在 Builder
  之前注入 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 防黑屏；用户已设置的值永不覆盖。
- **目录与路径**：数据/缓存全部走 Tauri `app_data_dir`/`app_cache_dir`
  （Linux 映射 `~/.local/share`、`~/.cache`）；无硬编码盘符/反斜杠。
- **ZIP 条目名编码**：`ZipEntryName{display,lookup}` 分离——未带 UTF-8 标志的
  条目按 GBK 修复展示名（中文 Windows 压缩工具产物），`by_name` 查找名保持
  zip crate 解码，页序与读取不受猜测影响；纯 ASCII/UTF-8 条目路径不变。
- **文件关联去重键**按平台语义：Windows 忽略大小写，Linux/macOS 精确匹配。
- **脱敏扩展**：`/run/media/<用户名>/` 并入 `<USER_HOME>`；`/mnt/<挂载名>/`
  折叠为 `<MOUNT>/`，其后漫画路径继续按 `<MANGA_DIR>/<MANGA_FILE>` 收尾。
- **系统代理**：环境变量（大小写不敏感）→ GNOME `gsettings`（mode=manual 时
  https→http→socks）→ KDE `~/.config/kioslaverc`（`[Proxy Settings]`
  `ProxyType=1`）；解析为纯函数跨平台可测。
- **Wayland 窗口容错**：`ensure_window_on_screen` 读取显示器/坐标失败时降级
  `window.center()` 并记日志，绝不 panic、不阻断恢复窗；`data-tauri-drag-region`
  与自绘按钮由 tao 层在 X11/Wayland 一致支持。
- **CJK 字体栈**：`--font-sans`/`--font-heading` 显式回退
  `Noto Sans CJK SC/TC/JP/KR` 与 `WenQuanYi Micro Hei`，防止 WebKitGTK
  无 PingFang/雅黑时六语文本渲染成方块。
- **图片通道**：页面图片经命令通道以 data URL 交付（无自定义 URI 协议），
  WebKitGTK 与 WebView2 行为一致；内嵌浏览器导航守卫同时拦截
  `http://tauri.localhost`（Windows/Android 形态）与非 http(s) 的
  `tauri://localhost`（Linux/macOS 形态）。
- **无 inotify**：书库为按需扫描（`scan_library`/`import_books`），
  不注册任何递归文件监听，不存在 inotify 句柄耗尽（OS Error 28）风险。
- `.gitattributes` 固化 `* text=auto eol=lf` + 二进制类型标记，防止
  CRLF 污染 Linux 构建脚本与配置。

## 13. 已知限制

- Telegram 真实站点 HTML 变体仍需用实际频道做联网冒烟；QA 使用确定性本地预览 stub。
- 文档附件下载在内存缓冲后落盘，不是边下边写流。
- Vite 主包仍 >500 kB（警告，不阻塞）。
- 历史 P3 审计项（更新构建哈希、SSRF link-local、状态胶囊 tab、品牌残留等）保留 backlog。
