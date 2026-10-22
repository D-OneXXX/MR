# MangaReader 技术文档

> 应用版本：`0.13.0`。`package.json` 是版本单一事实源，`npm run version:sync` 同步
> `tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、`package-lock.json`；前端版本由 Vite 注入。

- [README](../README.md)
- [QA 摘要](QA.md)
- [冒烟清单](smoke-test.md)

## 1. 定位与边界

本地优先的 Windows 漫画阅读器。书库、缓存、阅读进度、在线学习规则全部落在本机；
不提供账号体系、云同步、漫画源订阅、云端 OCR/翻译。网络请求只发生在用户主动解析 /
阅读在线书 / 检查更新时。

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
- 主窗口心跳每 1s；6s 无心跳由独立看门狗开恢复窗；系统休眠/唤醒按 tick gap 重置，
  不误判。
- 恢复窗可重载或重建主窗口；重建返回真实结果，不伪造成功。
- 安全模式文件损坏/不可读时 fail-closed；在线命令在 Rust 层再次校验。

## 4. 数据目录

默认：`%LOCALAPPDATA%\com.local.manga-reader\`

- `library.db`：书库、进度、设置、在线规则、app_meta。
- `logs/app.log`：错误日志。
- `render_cache/`：磁盘成品缓存（≤2 GiB，启动时按 mtime 清理）。
- `downloads/` / `downloads/telegram/`：内嵌浏览器 / Telegram 附件。
- `safe-mode.json`、`crash-guard.json`：安全模式与启动守卫。

环境变量：`MR_DATA_DIR`、`MR_RENDER_CACHE_DIR`、`WEBVIEW2_USER_DATA_FOLDER`（主要用于 QA 隔离）。

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
- 在线 `meta_json` 是 `StoredMeta`：`pages[]`、`filtered[]`、`filter_profile`、系列/下一话链路。
- `PageRef` 可带 `anchor { channel, messageId, photoIndex, refreshBase }`。
- `reading_log(date PK)` 旧库迁移在单事务内完成；崩溃遗留的 `reading_log_legacy`
  会在下次启动合并后删除。
- 页数缩小用 `MIN(current_page, page_count-1)` 钳制。

## 6. 后端模块

| 模块 | 职责 |
|---|---|
| `lib.rs` | 设置、启动迁移、命令注册、数据目录 |
| `commands.rs` | 书库/取页/进度/设置/在线导入/过滤标记恢复 |
| `source.rs` | 文件夹/zip/在线源；自然排序、zip bomb 上限、CDN 刷新 |
| `pipeline.rs` / `cache.rs` / `render_cache.rs` | 解码缩放、三级缓存、条漫切片 |
| `online/{mod,http,direct,html,filter,telegram,handoff}.rs` | 在线直读全链路 |
| `browser.rs` | 独立浏览器窗口、下载捕获、zip/cbz 导入 |
| `update.rs` | 更新清单、签名、下载、安装与重启 |
| `diagnostics.rs` | 诊断包、脱敏、Prompt 导出 |
| `resilience.rs` | 心跳、连点、恢复窗、安全模式 |
| `security.rs` / `versioning.rs` / `system_proxy.rs` | 隐私检查、版本迁移、系统代理 |

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

### 7.6 请求头作用域

- 支持 JSON 对象或单行 Cookie；禁止 Host/Content-Length/Connection/Transfer-Encoding；
  拒绝 CRLF。
- 用户请求头只在同 origin 发送；跨 origin 丢弃，只保留派生 Referer/Origin。
- 会话请求头 `session_online_headers` 仅内存，绝不写 SQLite/日志。

## 8. 更新与版本

- SemVer 严格 `MAJOR.MINOR.PATCH`，拒绝 `1.2`、`01.2.3`、四段版本。
- PATCH 优先补丁；MINOR 可补丁；跨多个 MINOR / MAJOR 回退全量。
- 更新清单签名覆盖 version、URL、sha256、size、notes 等字段；构建期 `MR_UPDATE_PUBKEY`。
- 安装包按 sha256 + minisign 校验；下载连接超时 20s，分块空闲超时，总上限 60 分钟。
- 安装使用 PowerShell `-EncodedCommand`（UTF-16LE），支持中文/emoji 路径；不写 UTF-8 `.cmd`。
- `version:sync` 先校验全部文件再统一写入，失败回滚，不产生半迁移。

## 9. 隐私与韧性

- 诊断包、错误、日志、描述、Prompt 均经 Rust 脱敏：Windows/Unix 路径、漫画名、
  Cookie/Token/JSON 引号键、URL query。
- 在线书路径展示去掉 query/hash/userinfo。
- 嵌入浏览器使用独立 WebView，无 IPC 权限；下载只允许 zip/cbz。
- 独立恢复窗口与安全模式；不自动刷新、不静默重启、不上传。
- 睡眠唤醒按 tick gap 重置；最小化/隐藏不判死。
- CBZ/ZIP 打开时限制 10000 页 / 4 GiB 声明解压体积，单页读取上限 32 MiB。

## 10. 前端

路由只有 4 个页面：

| 路由 | 页面 |
|---|---|
| `/` | 书库 + Inspector |
| `/reader/:id` | 沉浸阅读器（单页/双页/条漫） |
| `/browser` | 地址栏、Telegram 章节、下载列表 |
| `/settings` | 常规 / 更新 / 隐私 / 在线源 / 统计 / 缓存 / 支持 |

- `/reader/:id` 不挂 AppShell；阅读器以 bookId 为 key。
- 六语种：zh-CN、zh-TW、en、es、ja、ko；所有 UI 文案走 `t()`。
- 条漫：固定布局高度、DOM 窗口切片、滚动 120ms 空闲合流、最多 4 个在途请求；
  切换版式使用 Webtoon 实时中心页，避免 400ms 防抖导致进度回退。
- HUD/Dock 自动隐藏；过滤抽屉/目录/设置弹层会锁定 HUD。

## 11. 命令契约

只读 / 书库：`scan_library`、`import_books`、`remove_books`、`list_books`、`get_book`、
`get_next_book`、`get_series_books`、`list_entries`、`get_page`、`get_thumbnail`、
`clear_thumbnail_cache`、`get_webtoon_layout`、`get_webtoon_tile`、`get_memory_stats`、
`get_dashboard`、`get_reading_log`、`get_reading_by_book`、`set_progress`、`clear_pages`。

设置与在线：`get_settings`、`set_settings`、`resolve_online_url`、`test_online_connection`、
`import_resolved_pages`、`resolve_online_batch`、`resolve_telegram_channel`、
`download_telegram_document`、`get_online_filter_status`、`list_online_filter_rules`、
`export_online_filter_rules`、`import_online_filter_rules`、`reset_online_filter_rules`、
`get_filtered_pages`、`get_filtered_preview`、`mark_online_page_non_content`、
`restore_online_filtered_page`、`set_session_online_headers`、`clear_session_online_headers`、
`get_session_online_headers`。

系统：`start_browser_handoff`、`stop_browser_handoff`、`get_browser_handoff_status`、
`detect_system_proxy`、`open_browser_window`、`navigate_browser`、`list_browser_downloads`、
`import_browser_download`、更新命令、诊断命令、韧性/安全模式命令。

## 12. 测试

```bat
cd src-tauri && cargo test --lib
npx tsc --noEmit
npm run test:version
node tests\qa\run-qa.mjs
```

QA 覆盖：静态/版本红线、双主题六语种、阅读器导入与 125 页条漫压测、在线 30 页噪音与
推广图学习、Telegram 频道/消息/403 自愈、诊断脱敏、混沌/恢复窗/安全模式。
运行报告写入 `tests/qa/reports/latest.md`（生成物不提交）。

## 13. 已知限制

- Telegram 真实站点 HTML 变体仍需用实际频道做联网冒烟；QA 使用确定性本地预览 stub。
- 文档附件下载在内存缓冲后落盘，不是边下边写流。
- Vite 主包仍 >500 kB（警告，不阻塞）。
- 历史 P3 审计项（更新构建哈希、SSRF link-local、状态胶囊 tab、品牌残留等）保留 backlog。
