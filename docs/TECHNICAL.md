# MangaReader 技术文档

> 适用代码基线：`d1c88ad`（2026-10-23，分支 `v3-ui-refactor`）
> 应用版本：`0.12.1`（`package.json` 单一事实源；`src/lib/version.ts` 由 Vite 注入 `__APP_VERSION__` / `__BUILD_COMMIT__`，`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 由 `npm run version:sync` 同步）
> 文档定位：面向接手开发、架构评审与排障的工程说明，不替代用户手册。
> 相关文档：[README](../README.md)、[Sidecar 接口契约](sidecar-api.md)、[真机冒烟清单](smoke-test.md)、[冒烟报告（2026-10-19）](smoke-test-report-2026-10-19.md)、[v3 设计记录](superpowers/specs/2026-10-20-v3-cockpit-design.md)、[在线直读设计（第一阶段）](superpowers/specs/2026-10-19-online-direct-reader-design.md)。

## 目录

- [1. 项目定位](#1-项目定位)
- [2. 技术栈](#2-技术栈)
- [3. 系统架构](#3-系统架构)
- [4. 目录结构](#4-目录结构)
- [5. 数据模型](#5-数据模型)
- [6. 后端架构](#6-后端架构)
- [7. 前端架构](#7-前端架构)
- [8. 配置与环境变量](#8-配置与环境变量)
- [9. 开发与运行](#9-开发与运行)
- [10. 测试与验收](#10-测试与验收)
- [11. Sidecar 契约](#11-sidecar-契约)
- [12. 性能设计要点](#12-性能设计要点)
- [13. 已知限制](#13-已知限制)
- [14. 扩展指南](#14-扩展指南)
- [15. 术语表](#15-术语表)
- [附录 A：Tauri 命令契约](#附录-atauri-命令契约)
- [附录 B：常见故障排查](#附录-b常见故障排查)
- [附录 C：文档维护约定](#附录-c文档维护约定)

---

## 1. 项目定位

MangaReader 是一个 **local-first 的 Windows 桌面漫画阅读器**：

- 书库、阅读进度、统计、OCR/翻译缓存全部保存在本机；
- 支持图片文件夹、`.zip`、`.cbz`；实验性支持 URL 在线直读（JSON 清单、单页 HTML 图集、多话合集）；
- 阅读器支持单页 / 双页 / 条漫三种版式，日式右开（RTL）与西式左开（LTR），多页签并行阅读；
- 集成一条本地 AI 流水线：文本检测（ctd）→ OCR（mit48px）→ 翻译（OpenAI 兼容 LLM）→ 擦除（LaMa）→ 嵌字；
- 提供逐页翻译工作台、整话批量预翻译、术语表、阅读统计看板与服务状态页；
- 提供外部系统浏览器协同导入（长驻本地回环桥接）与内嵌通用浏览器窗口（下载自动导入）。

### 1.1 设计原则

1. **事实优先**：UI 只展示真实存在的数据，不伪造“已验证/已登录/已连接”状态。
2. **本地优先**：所有书库与缓存数据落在本机；网络请求仅发生在用户主动触发或阅读在线书时。
3. **阅读优先**：阅读画布保持不透明、零干扰，控件按需唤醒。
4. **可控边界**：不注入第三方页面脚本、不采集或持久化第三方 Cookie、不做站点适配器、不伪装 UA。

### 1.2 冻结功能池（当前阶段不实现）

- 标签系统（自定义分类/颜色标签）
- 跨设备同步（进度/书库云同步）
- 阅读统计分享
- 漫画源订阅（自动抓取/RSS/站点插件；手动 URL 直读不在此列）
- 云端模型（把检测/OCR/擦除/翻译切到云端 API 的选项）

---

## 2. 技术栈

### 2.1 前端

| 项 | 版本/说明 |
|---|---|
| React / React DOM | `^19.1.0`，`React.StrictMode` + `HashRouter` |
| TypeScript | `~5.8.3`，`strict`、`noEmit`、`noUnusedLocals/Parameters` |
| Vite | `^6.3.5`，`@vitejs/plugin-react` |
| Tailwind CSS | `^4.3.3`，通过 `@tailwindcss/vite` 插件接入，无 PostCSS 配置 |
| shadcn/ui | `^4.22.1`，`style: base-nova`（Base UI 变体） |
| Base UI | `@base-ui/react ^1.9.0` |
| 图标 | `lucide-react ^0.525.0` |
| 路由 | `react-router-dom ^6.30.0`（HashRouter，Tauri 本地加载依赖） |
| 可拖拽分栏 | `react-resizable-panels ^4.14.7`（书库 Inspector） |
| 字体 | `@fontsource-variable/geist`（Geist Variable，配合 legacy `--mono`） |
| 动画 | `tw-animate-css ^1.4.0` |

样式入口顺序（`src/main.tsx`）：`theme.css`（legacy token）→ `components/ui.css`（legacy 组件）→ `v3.css`（Tailwind + v3 token）。两套 token 共存，避免一次性重写旧页面。

### 2.2 后端

| 项 | 说明 |
|---|---|
| Tauri | 2.x，`decorations: false`，最小窗口 900×600 |
| Rust edition | 2021，`tauri`、`serde`、`rusqlite`（bundled SQLite）、`ureq`、`sha2`、`hex`、`image`、`zip`、`parking_lot`、`reqwest`、`chrono`、`sysinfo`、`windows 0.62` |
| 数据库 | 单文件 SQLite（`library.db`），无 ORM、无迁移框架 |
| 平台 | Windows 优先（本地 OCR 依赖 WinRT；注册表代理读取仅 Windows） |

### 2.3 Sidecar

Python 服务（`sidecar/`），提供 `/health`、`/v1/detect`、`/v1/ocr`、`/v1/inpaint`；详见 `docs/sidecar-api.md`。

### 2.4 LLM

OpenAI 兼容的 `/chat/completions`（默认 `http://localhost:8080/v1`），用于选区翻译、工作台翻译与批量预翻译。

---

## 3. 系统架构

### 3.1 进程与端口

| 进程 | 端口 | 说明 |
|---|---|---|
| Tauri 主进程 | — | 前端 WebView2 + Rust 后端 |
| Vite（开发） | 1420 | `strictPort: true`，Tauri `devUrl` |
| Sidecar | 8500 | Python 检测/OCR/擦除 |
| 翻译 LLM | 8080 | 外部应用，用户自行启动 |
| 本地配对桥接 | 127.0.0.1:0（系统分配） | 仅在用户启动配对时存在，长驻直到停止 |

### 3.2 本地数据目录

- 数据目录：`MR_DATA_DIR` 非空时优先，否则 `dirs::data_local_dir()/com.local.manga-reader`（`src-tauri/src/lib.rs:367-383`）。
- 数据库：`<数据目录>/library.db`。
- 日志：`<数据目录>/logs/app.log`。
- 下载：`<数据目录>/downloads`（内嵌浏览器捕获）。
- 渲染缓存：`MR_RENDER_CACHE_DIR` 优先，否则 `<数据目录>/render_cache`，再退临时目录（`src-tauri/src/state.rs:52-61`）。

### 3.3 启动顺序（`src-tauri/src/lib.rs`）

1. 解析数据目录 → 打开 `library.db` → `db::init_schema` 建表/增量迁移。
2. 初始化日志文件。
3. `hydrate_settings` 从 `settings` 表回读 23 个键，夹取预算/并发后写入内存 `AppState`。
4. 应用缓存预算；启动批量 worker（`batch::spawn_worker`）与渲染缓存后台 trim。
5. `invoke_handler` 注册 **54 个命令**；构建 Tauri 应用。
6. `RunEvent::ExitRequested` 时取消配对桥接（`cancel_handoff`）。

### 3.4 线程与后台任务

| 任务 | 机制 | 取消/清理 |
|---|---|---|
| 批量预翻译 worker | `tauri::async_runtime::spawn` 无限循环，2.5s 轮询 | 每页前重读 `batch_jobs.state`；pause/cancel 即时生效 |
| 邻页预取 | `spawn_blocking`，在途键 `prefetching` 去重 | 无独立取消 flag，随请求结束 |
| 渲染缓存 trim | 累计写入 >256 MiB 触发后台线程；启动时一次 | 按 mtime 删除至 2 GiB 预算 |
| 配对桥接 | 每次 `start_browser_handoff` 起一个 `std::thread` | 非阻塞 accept + 25 ms 轮询；stop/开关关闭/进程退出 |
| 浏览器下载完成导入 | 独立线程执行 `finish_download` | 进程退出 |

> 批量 worker、预取、trim 线程未保留 `JoinHandle`，随进程退出结束。

---

## 4. 目录结构

```text
manga-reader-tauri/
├─ src/                          # React 前端
│  ├─ main.tsx                   # HashRouter + 样式入口
│  ├─ App.tsx                    # 路由判定：/reader 沉浸分支 / AppShell
│  ├─ theme.css                  # legacy token（v2 兼容层）
│  ├─ v3.css                     # Tailwind v4 + v3 token + shadcn 命名空间
│  ├─ components/
│  │  ├─ shell/                  # AppShell / TitleBarV3 / NavRail / OmniBar / StatusPill
│  │  ├─ library/BookInspector.tsx
│  │  ├─ Reader/                 # ReaderHudTop / ReaderDock / ProgressScrubber / TabSwitcher / Webtoon / spread / region / shortcuts
│  │  ├─ ui/                     # shadcn(Base UI) 生成组件
│  │  ├─ BookCard.tsx / BookDetail.tsx / DetailSheet.tsx
│  │  ├─ OnlineImportDialog.tsx / Toast.tsx / ConfirmDialog.tsx / ...
│  │  └─ ui.css                  # legacy 组件样式
│  ├─ features/workspace/WorkspaceContext.tsx   # 页签与会话快照
│  ├─ lib/tauri.ts               # 全部 invoke 封装与类型
│  ├─ lib/sourceDisplay.ts       # 来源地址脱敏
│  ├─ lib/onlineLastTest.ts      # 最近一次在线测试记录（localStorage）
│  ├─ pages/                     # Library / Reader / Settings / DataView / Browser / Status / Workbench / Glossary
│  └─ scripts(仓库根)/verify-*.mjs
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs                  # 入口、Settings、命令注册、启动/退出
│  │  ├─ commands.rs             # 书库/取页/进度/设置/OCR/翻译/在线导入/系列
│  │  ├─ db.rs                   # schema/迁移/查询
│  │  ├─ state.rs                # AppState、句柄池、会话头、配对运行时
│  │  ├─ source.rs               # 目录/zip/在线源
│  │  ├─ pipeline.rs             # 解码/缩放/JPEG/条漫切片
│  │  ├─ cache.rs / render_cache.rs
│  │  ├─ online/                 # mod / http / direct / html / handoff
│  │  ├─ browser.rs / system_proxy.rs
│  │  ├─ ocr.rs / translate.rs / workbench.rs / batch.rs / sidecar.rs / logging.rs
│  │  └─ tests: tests/e2e_stage1.rs, tests/memory_budget.rs
│  ├─ capabilities/default.json  # 仅 main 窗口有 IPC 权限
│  └─ tauri.conf.json
├─ sidecar/                      # Python 检测/OCR/擦除
├─ docs/                         # 本目录
└─ scripts/verify-spread.mjs、verify-region.mjs
```

---

## 5. 数据模型

### 5.1 表

`db::init_schema` 用 `CREATE TABLE IF NOT EXISTS` 建 8 张表（`src-tauri/src/db.rs:30-100`）：

| 表 | 主键 | 关键列 | 用途 |
|---|---|---|---|
| `books` | `id` | `path UNIQUE`、`title`、`page_count`、`current_page`、`updated_at`、`removed`、`scroll_pct`、`source_type`、`meta_json` | 书库与进度 |
| `reading_log` | `(date, book_id)` | `pages` | 每日阅读页数 |
| `settings` | `k` | `v` | 设置键值 |
| `trans_log` | `id` 自增 | `kind`、`ok`、`elapsed_ms`、`created_at` | OCR/翻译调用统计 |
| `trans_cache` | `id` | `text`、`book_id`、`created_at` | 工作台译文缓存 |
| `glossary` | `(series_id, src)` | `dst` | 术语表 |
| `page_ocr` | `(book_id, page)` | `width`、`height`、`boxes`、`texts`、`updated_at` | 工作台逐页 OCR 存档 |
| `batch_jobs` | `id` 自增 | `book_id`、`book_title`、`state`、`total_pages`、`done_pages`、`ok_pages`、`fail_pages`、`last_error`、`created_at`、`updated_at` | 批量预翻译任务 |

无显式二级索引；索引来自主键/唯一约束。

### 5.2 迁移

- 无版本表/`user_version`；`init_schema` 用 `pragma_table_info` 探测列，缺列才 `ALTER TABLE ADD COLUMN`（`db.rs:97-98`、`130-185`）。
- `reading_log` 旧结构（无 `book_id`）会重命名为 `reading_log_legacy`、重建复合主键、旧数据以 `book_id=''` 并入后删旧表（`db.rs:105-127`）。

### 5.3 StoredMeta 与 BookInfo

`StoredMeta`（`src-tauri/src/online/mod.rs:35-54`，camelCase 落盘）：

```json
{
  "schema": 1,
  "manifestHash": "sha256(title+pages)",
  "fetchedAt": "本地时间字符串",
  "pages": [{ "url": "...", "width": 800, "height": 1200 }],
  "seriesId": "可选，系列标识",
  "seriesTitle": "可选，系列名",
  "chapterIndex": 1,
  "nextUrl": "可选，下一话 URL"
}
```

- `seriesId`/`seriesTitle`/`chapterIndex`/`nextUrl` 均带 `serde(default, skip_serializing_if = "Option::is_none")`：旧 `meta_json` 缺字段解析为 `None`，新写时不输出空字段。
- `manifestHash` **只由最终标题与页面列表计算**，系列/章节/下一话字段不参与，避免更新链路字段时误判“清单变化”而清空 OCR/翻译缓存（`direct.rs:218-236`）。

`BookInfo`（`src-tauri/src/lib.rs:30-53`）在基础字段外暴露：`seriesId`、`seriesTitle`、`chapterIndex`、`nextUrl`，均由 `to_book_info` 从 `meta_json` 反序列化后填充（解析失败填 `None`，不 panic）。

`webtoon_ready`：本地书恒为 `true`；在线书要求 `pages` 非空且每页宽高均 >0；元数据损坏时记日志并返回 `false`（`commands.rs:33-50`）。

### 5.4 关键不变量

1. `current_page` 始终钳制在 `0..page_count-1`；在线清单更新时 `upsert_online_book` 用 `MIN(current_page, page_count-1)` 防止越界。
2. 0 页清单拒绝入库（`apply_resolved_meta` 前置门禁）。
3. `reading_log` 只增不减：`set_progress` 只在页码前进时累加当日页数。
4. 软删 `removed=1` 不删源文件；硬删先清只读属性再删文件（在线书不触碰远程源）。
5. 在线书的 `path` 即规范化 URL，`book_id` 由 `path` 哈希得到。

---

## 6. 后端架构

### 6.1 设置与持久化

`Settings`（`src-tauri/src/lib.rs:169-204`）共 23 个字段，`settings_persist_pairs`（`commands.rs:1301-1351`）全部持久化到 `settings` 表：

`theme`、`cache_budget_mb`、`library_dir`、`trans_endpoint`、`trans_model`、`trans_api_key`、`trans_temp`、`trans_timeout_s`、`ocr_endpoint`、`ocr_timeout_s`、`src_lang`、`dst_lang`、`experimental_trans`、`experimental_webtoon`、`sidecar_endpoint`、`sidecar_timeout_s`、`wb_detector`、`wb_ocr`、`wb_inpaint`、`experimental_online`、`online_proxy`、`online_concurrency`、`online_headers`。

- 默认值：dark、128 MB、`http://localhost:8080/v1`、ja→zh、sidecar `127.0.0.1:8500`/120s、三个实验开关关闭、并发 3。
- `set_settings` 先校验代理与请求头，`online_concurrency` 夹取 1..8；代理/并发/请求头变化时 `invalidate_sources`。
- `hydrate_settings` 回读同一批 key，`cache_budget_mb` 夹取 16..2048，布尔接受 `true`/`1`。
- **会话级请求头**：`AppState.session_online_headers` 仅驻留内存，优先于 `Settings.online_headers`；`set/clear_session_online_headers` 只改内存并使句柄池失效，**绝不写入 SQLite、绝不记日志**（`state.rs:83-84`、`commands.rs:1623-1657`）。

### 6.2 命令分层（54）

| 模块 | 数量 | 职责 |
|---|---:|---|
| `commands.rs` | 35 | 书库/条目/取页/缩略图/条漫/内存/看板/日志/进度/设置/OCR/翻译/术语表/在线导入/系列 |
| `workbench.rs` | 6 | 检测/OCR/擦除/批量翻译/OCR 存档读写 |
| `batch.rs` | 5 | 批量任务入队/暂停/恢复/取消/列表 |
| `online/handoff.rs` | 3 | 启动/停止/查询配对桥接 |
| `browser.rs` | 4 | 打开/导航浏览器窗口、下载列表、手动导入 |
| `system_proxy.rs` | 1 | 读取系统代理（只读，不持久化） |

完整命令表见 [附录 A](#附录-atauri-命令契约)。

### 6.3 图片源（`source.rs`）

- `FolderSource`：只扫描目录直接子文件，过滤 jpg/jpeg/png/gif/webp，按路径排序。
- `ZipSource`：打开时列出所有非目录图片条目并按名称排序；每次 `read_raw` 重新打开归档、只读命中条目，带 `enclosed_name` ZipSlip 校验。
- `OnlineSource`：页列表 + `Arc<dyn HttpTransport>` + 每书独立 `BlockingSemaphore` + canonical Referer；每页请求携带 `PAGE_MAX_BYTES`、页 URL、Referer 与 header scope。
- 在线图片通过魔数识别 jpeg/png/gif/webp；BMP 等识别但不支持的格式报“图片格式不支持”。
- 常开源句柄池按 `book_id` 复用，上限 16 本；满载整体清空重开。
- `invalidate_sources` 先递增 `source_epoch` 再清池；打开中的旧句柄在插池前复核 epoch，变化则丢弃并重试一次（`state.rs:261-288`）。

### 6.4 图片管线（`pipeline.rs`）

- `fit_size` 只缩小不放大；任一边超限按比例缩放。
- 长图 JPEG（高 >8000、请求 `max_width`）走 IDCT 缩放解码；其他解码后用 Triangle 滤波降采样。
- 成品统一转 RGB、JPEG 质量 82、返回 `data:image/jpeg;base64,...` 与 JPEG 字节（供 L2 落盘）。
- 条漫切片：`WEBTOON_TILE_H=2048`；整页只解码一次，按显示宽度换算后均分，每片 JPEG 质量 80（`pipeline.rs:199-245`）。

### 6.5 三级缓存

| 层 | 内容 | 预算/策略 |
|---|---|---|
| L1 内存 | 缩略图 LRU、页 LRU、条漫切片 LRU | 缩略图 128 MiB + 页 128 MiB（同一滑杆）、切片固定 48 MiB；条目上限 512；只驻留 `data_url` |
| L2 磁盘 | 成品 JPEG：`{index:06}@{w}x{h}.jpg`、`{index:06}t{tile:02}@{w}.jpg` | 2 GiB；写入 >256 MiB 触发后台 trim；启动时 trim；临时文件写完 rename |
| 源 | 原始图片 | 目录/zip/在线；在线不落原始图 |

- L1 键：页 `(book,index,req_w,req_h)`；切片 `(book,index,tile,render_w)`；缩略图仅 `book_id`。
- `remove_book` 级联清三层；`clear_pages` 清页与切片、保留缩略图；`clear_thumbs` 只清缩略图。

### 6.6 取页与预取

`get_page` 三级路径：L1 → L2 → 源读取 + `render_raw` 全管线；全管线结果写 L2 再写 L1，并触发邻页预取（`commands.rs:691-741`）。

- 预取窗口：本地 `±1/±2`；在线 `+1/+2`；跳过已缓存与在途键。
- 条漫 `get_webtoon_tile`：L1 → L2 → 读原页 → 抢全局 `tile_lock` → 双检 L2 → 切片并全部落 L2。
- `get_webtoon_layout`：在线书直接取清单宽高；本地书先读 256 KiB header，失败回退整页解码。

### 6.7 OCR 与翻译

- 选区 OCR：从原图全分辨率裁剪（非展示缩放图）；`ocr_endpoint` 为空走 Windows 本地 OCR（WinRT），否则走 HTTP（`{image: base64 png}` → `{text}`）。
- 翻译：OpenAI 兼容 `POST {endpoint}/chat/completions`，读取 `choices[0].message.content`；超时 `trans_timeout_s.max(1)`。
- `trans_log` 记录 OCR/翻译调用（kind=`ocr`/`trans`），保留最近 5000 条；`get_trans_stats` 返回调用数/失败数/平均耗时与最近 50 条。
- 翻译缓存：`trans_cache` 按文本+书+目标语言缓存；术语表按 `series_id` 注入 system prompt。

### 6.8 工作台（`workbench.rs`）

- `wb_detect` → sidecar `/v1/detect`（原图宽高 + 绝对像素框）。
- `wb_ocr` → `/v1/ocr`（框与输入同序）。
- `wb_inpaint` → `/v1/inpaint`（整页 PNG data URL；**无结果缓存**）。
- `wb_translate`：文本 trim 后保序去重，逐条读取 `trans_cache`，未命中调用 LLM 并回写；重复文本共享译文。
- `wb_save_ocr`/`wb_get_ocr`：`page_ocr` 的 boxes/texts JSON 存档。

> `wb_detector`/`wb_ocr`/`wb_inpaint` 三个设置字段目前只持久化与展示，命令固定调用 `/v1/*` 路径，不按 provider 切换。

### 6.9 批量预翻译（`batch.rs`）

- 状态：`queued` / `running` / `paused` / `cancelled` / `done` / `done_errors` / `failed`；活动态 `queued,running,paused`。
- 常驻 worker：2.5s 轮询 `queued` 的 FIFO 任务；每页处理前重读状态，pause/cancel 即时生效。
- 每页：已有 `page_ocr` 则只补翻译；否则检测→OCR→存档→翻译。连续 3 页失败且成功数为 0 → 整任务 `failed`。
- `batch_enqueue` 对同书已有活动任务幂等返回旧任务；`batch_list` 返回最近 50 条。

### 6.10 日志与脱敏

- 日志文件 `<数据目录>/logs/app.log`，追加格式 `[YYYY-MM-DD HH:MM:SS] [scope] message`；仅错误日志接口，无轮转。
- 关键 scope：`online_meta`、`get_page`、`get_thumbnail`、`clear_thumbnail_cache`、`get_webtoon_tile`、`online_page`、`browser`。
- URL 脱敏：`online::redact_url_for_log` 去掉 userinfo/query/fragment，只保留 scheme/host/port/path；解析失败时按首个 `?`/`#` 截断并尽力去掉 userinfo。
- 传输层失败只保留错误类别 `t.kind()`，不把含 query 的 URL 写入错误。

### 6.11 在线直读

#### 6.11.1 解析入口

`online::resolve` 只拉取一次：

1. `normalize_url`：trim；长度 >2048 拒绝；仅 http/https；拒绝 userinfo；去掉 fragment；保留 query。
2. 用规范化 URL 作为请求 URL 与 header scope；非 2xx 报错并脱敏 URL。
3. 先尝试 JSON 清单；仅当正文**不是合法 JSON** 时才回退 HTML 图集；正文是合法 JSON 但语义错误时直接返回 JSON 错误。
4. 书身份保持用户请求的规范化 URL；相对图片与标题回退使用重定向后的 `final_url`。

#### 6.11.2 清单格式

单本（HTTP 拉取或批量包内）：

```json
{ "version": 1, "title": "...", "seriesId": "...", "nextUrl": "...",
  "pages": ["https://...", { "url": "https://...", "width": 800, "height": 1200 }] }
```

多话合集（`resolve_online_batch` / 配对桥接推送）：

```json
{ "version": 1, "seriesId": "...", "seriesTitle": "...", "nextUrl": "...",
  "chapters": [
    { "title": "第1话", "url": "https://.../ch01", "pages": ["https://.../01.jpg"] }
  ] }
```

规则：

- `version` 缺省或 1；单本 `pages` 1..=5000；合集 `chapters` 1..=100。
- 每页 URL 逐个 `normalize_url`，保序去重；宽高必须同时为正且在 u32 内，否则两者都丢弃。
- 合集 `series_id` 优先级：显式 `seriesId` → `sha256(seriesTitle)` → `sha256(第一话 URL 的父路径)`。
- 合集 `chapter_index` 为 1-based；第 i 话 `next_url` = 第 i+1 话规范化 URL；最后一话取顶层 `nextUrl`。
- 标题 trim 后为空则用 URL 路径末段/主机名，最终截断 200 字符。

#### 6.11.3 请求头作用域（安全关键）

- `RequestHeaders::parse` 支持 JSON 对象或单行 Cookie；禁止 `Host`/`Content-Length`/`Connection`/`Transfer-Encoding`；校验 token 名与 CRLF。
- 用户请求头**只在目标与 `header_scope` 同 origin（scheme+host+port）时发送**，跨源丢弃全部用户头。
- `Referer`：目标与页面、scope 均同源时保留完整页面 URL；否则去掉 query/fragment。
- `Origin` 由页面 URL 派生；同 scope 时用户显式配置的 Referer/Origin 优先。
- 重定向手动逐跳处理（最多 5 次），每跳用同一 scope 重新判断；跨源丢弃，回到 scope 内恢复。
- 传输层重试仅针对 408/429/500/502/503/504，最多 3 次；优先 `Retry-After`。

#### 6.11.4 系列与下一话

- `get_series_books(series_id)`：返回同系列全部书，按 `chapter_index` 升序 → 自然排序 → `updated_at` → `id`。
- `get_next_book(book_id)`：优先 `next_url` 命中的已入库书；其次同 `series_id` 的自然排序下一本；最后同标题前缀兜底；都没有返回 `None`。

#### 6.11.5 配对桥接（`online/handoff.rs`）

`HandoffStatus`：`active`、`port`、`pairingToken`、`callbackUrl`、`receivedChapters`、`allowSessionHeaders`、`script`。

- `start_browser_handoff({allowSessionHeaders})`：校验 `experimental_online`；绑定 `127.0.0.1:0`；生成 128-bit token（32 位 hex，优先 `BCryptGenRandom`）；返回状态并启动长驻线程；旧会话被取消且计数归零。
- 监听**长驻**，直到 `stop_browser_handoff` 或 `experimental_online` 关闭；每次成功推送后继续接受下一次。
- `POST /handoff?token=...`：token 不匹配 → 403 且不导入；`OPTIONS` → 204 + CORS/PNA 头；其他方法 405。
- 请求限制：header 64 KiB、body 2 MiB、socket 5s；POST 必须有 `Content-Length`（缺省 411），拒绝 chunked。
- 请求体接受单本 `{url,title,pages}` 或合集 `{chapters}`，以及可选 `sessionHeaders`。
- `allowSessionHeaders=true` 且 `sessionHeaders` 非空：校验后写入内存会话头（不落盘、不回显、不记日志）；为 `false` 时该字段完全忽略。
- 成功：批量单事务入库，按本次话数累加 `receivedChapters`，emit `online-handoff-imported`（载荷 `BookInfo[]`），聚焦主窗口；响应 `{"books":[{id,title}]}`。
- 停止：`stop_browser_handoff` 取消运行时并 emit `online-handoff-stopped`；应用退出时同样取消（不 emit）。
- 推送脚本：用户在自己浏览器手动执行；用 `localStorage` 按 origin 累积章节；只读已渲染图片地址；不读取 Cookie、不翻页、不爬取；可填 `MR_SERIES_ID`/`MR_SERIES_TITLE`/`MR_SESSION_HEADERS`。

#### 6.11.6 手动与批量导入

- `import_resolved_pages(url,title,pageUrls)`：复用统一归一化/去重/1..=5000 与 `apply_resolved_meta`；签名无 cookie/UA 参数。
- `resolve_online_batch(payloadJson)`：解析单本或合集，解析失败在写库前中止；整批单事务入库，返回按序 `BookInfo[]`。
- 清单变化（`manifestHash` 不同）才清派生缓存（OCR/翻译）并 `invalidate_sources`；仅链路字段变化只更新 `meta_json`。

#### 6.11.7 图片提纯与自学习（`online/filter.rs`）

- 漏斗：用户 allow/block 规则 → DOM chrome/URL 负面词 → 尺寸与宽高比 → 中位宽度 → CDN 序列聚类 → 站点档案宽度。
- 阈值默认 `320×240`、`aspect > 2.8` 判横幅、中位宽度偏差 40%；跨页大图按宽高比豁免。缺尺寸候选最多探测 24 张图片头。
- 站点档案 `online_filter_profiles`：main selector、CDN 模板、标准宽度区间、aspect 上限、使用次数。
- 用户规则 `online_filter_rules`：URL 模板（数字段归一化为 `#`）、精确 URL、SHA-256、DOM class、固定尺寸；只保存脱敏 host + path，绝不保存 Cookie/签名 query。
- `mark_online_page_non_content` 从当前 `meta_json` 移除页面、写入 block 规则与事件；仅当被标记页不是主正文模板时才写 URL 模板规则，避免误封整章。
- `restore_online_filtered_page` 按原 `order` 插回、删除匹配 block 规则、写入 allow 规则并放宽站点宽度/aspect。
- 事件表 `online_filter_events` 上限 10000 条；`(book_id,url,action)` 唯一，重复解析不膨胀统计。设置页支持统计、导出、导入、重置。

#### 6.11.8 Telegram 公开频道（`online/telegram.rs`）

- 支持 `t.me/<channel>`、`t.me/s/<channel>`、`t.me/<channel>/<id>`、`tg://resolve?domain=`、`telegra.ph/<slug>`；不登录、不读第三方 Cookie、不注入 WebView 脚本。
- 频道页聚合：相册 `data-grouped-id`、连续同标题相册、Telegraph 外链、`.zip/.cbz` 文档；纯文本、投票、贴纸、头像、语音、圆形视频全部剔除；`?before=<id>` 向上分页。
- 单消息：`?embed=1` 取最高分辨率相册图；每页持久化 `PageAnchor { channel, message_id, photo_index, refresh_base }`。
- `OnlineSource` 遇 403/404 时调用 `refresh_page_url` 按锚点重取嵌入页，替换内存直链并重试一次；失效直链不写日志。
- 文档按钮流式下载（实际上限 256 MiB）到 `<数据目录>/downloads/telegram`，校验 zip/cbz 后导入并设为本地书。
- QA 专用 `MR_TELEGRAM_TEST_ORIGIN` 仅在 debug 构建生效且只接受 loopback；release 忽略。

### 6.12 内嵌浏览器与下载导入（`browser.rs`）

- 独立窗口 label `browser`，标题“MangaReader 浏览器”，初始 1200×820；仅接受 http/https。
- **权限隔离**：`capabilities/default.json` 只授权 `windows: ["main"]`，浏览器窗口没有任何 IPC 权限。
- 下载目录固定 `<数据目录>/downloads`；文件名清洗控制字符与 `/\<>:"|?*`，保留扩展名，上限 120 字符，重名追加 ` (n)`。
- 下载目标始终限制在下载目录内；`DownloadEvent::Requested` 改写目标路径；`Finished{success}` 在独立线程处理。
- 仅 zip/cbz 自动导入；导入成功后设置文件只读；emit `browser-download`。
- `list_browser_downloads` 按 mtime 降序，`imported` 由 `book_id_for_path` 查库判断；`import_browser_download` 仅允许下载目录内 zip/cbz。

### 6.13 系统代理（`system_proxy.rs`）

- 优先级：`HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`；大小写不敏感，空白跳过。
- 环境变量存在但值无效时直接返回 `Ok(None)`，不回退注册表。
- Windows 回退：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable`（必须非 0）与 `ProxyServer`；`https=` 优先，其次 `http=`，最后整串。
- 归一化为 `scheme://host[:port]`；拒绝分号列表、非法 scheme、空 host、userinfo。
- 只读命令，**不写设置、不持久化**；非 Windows 只查环境变量。

### 6.14 删除与只读

- 本地书“删除源文件”：先清只读位，再删文件/目录；在线书返回 false，不触碰远程源。
- 浏览器导入的文件带只读属性，删除前由后端清除只读。
- 软删（`removed=1`）可逆，保留源文件；硬删清理记录与派生缓存。

---

## 7. 前端架构

### 7.1 入口与路由

- `HashRouter` + `React.StrictMode`；入口样式顺序 `theme.css` → `ui.css` → `v3.css`（`main.tsx`）。
- `WorkspaceProvider` 包裹全部路由（页签状态）。
- `/reader/:id` 为沉浸分支：只渲染 Reader，不挂 AppShell；Reader 以 `bookId` 为 `key`，切页签强制卸载。
- 其余路由由 `AppShell` 承载：

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | Library | 书库（宽屏三栏 / 窄屏单栏 + Sheet） |
| `/data` | DataView | 数据看板 |
| `/browser` | Browser | 内嵌浏览器启动器与下载管理 |
| `/settings` | Settings | 设置 |
| `/status` | Status | 服务状态 |
| `/workbench` | Workbench | 受 `experimentalTrans` 门控 |
| `/glossary` | Glossary | 受 `experimentalTrans` 门控 |
| `*` | Library | 兜底 |

### 7.2 壳层（`src/components/shell/`）

| 组件 | 职责 |
|---|---|
| `AppShell` | 设置加载、主题、lastRead、实验开关、在线回传角标、全局 Ctrl+W/Ctrl+1..9、路由渲染 |
| `TitleBarV3` | 48px 自绘标题栏：品牌 + OmniBar + StatusPill + 窗口控制；空白层为 Tauri 拖拽区 |
| `NavRail` | 48px 收起 / 184px 悬停展开（覆盖式）；固定态写 `mr-nav-pinned`/`mr-nav-width`；含全部路由入口与主题切换 |
| `OmniBar` | Ctrl/Cmd+K 命令中心：页面跳转、本地书搜索（250ms 防抖）、URL → “解析为在线直读”（预填不自动解析）、快速动作；↑↓/Enter/Esc + `aria-activedescendant` |
| `StatusPill` | 24px 胶囊：直连 / 代理 host:port / 最近一次主动测试 / 配对中；路由、focus、`mr-settings-updated`、`mr-settings-changed` 时刷新；<1000px 收缩为圆点 |

- 标题栏高度由 `--titlebar-h: 48px` 统一；`.rail` top 同值。
- 窗口控制复用 `WindowControls`（最小化/最大化/关闭），保留双击最大化/还原。
- 在线回传事件 `online-handoff-imported` 在 AppShell 监听：不在书库时给书库图标加角标，在书库时静默刷新。

### 7.3 设计系统（v3 暗色玻璃座舱）

- v3 语义 token（`src/v3.css`）：`--v3-shell/canvas/reader/surface/surface-solid/hairline/text/muted/accent/accent-soft/warning/danger/success/blur/inset-highlight`。
- shadcn 变量使用独立命名空间 `--sh-*`，避免与 legacy `--accent/--muted/--card/--border/--radius` 冲突（直接覆盖会让品牌蓝变透明、次要文字变近黑、圆角改变）。
- `@theme inline` 映射工具类：`bg-shell/canvas/reader/surface/hairline`、`text-ink/ink-muted`、`brand/warning/danger/success`；圆角 `--radius-v3:12px`、`--radius-v3-card:16px`、`--radius-v3-pill:8px`。
- 亮色主题：`[data-theme="light"]` 下表面改实色、`--v3-blur: 0px`；legacy token 同步覆盖。
- 自定义工具类：`hairline`（1px 描边 + 顶部内高光）、`glass`、`shell-surface`、`reader-canvas`。
- Preflight 兼容：placeholder 恢复 `var(--muted)` + `opacity: 1`；legacy 控件补可见焦点环。
- 全局 `prefers-reduced-motion`：关闭 `.fade-in/.view-fade/.rr-spin/.reader-next-pill` 等非必要动画，跳过 DetailSheet 封面飞行。
- 阅读画布在 `Reader.css` 中固定深色 `#09090b`，不随主题变亮；HUD 跟随主题 token（这是有意的取舍）。

### 7.4 书库与 Inspector

- 宽屏（≥1100px）：`NavRail` + 书库画布 + Inspector 三栏；`ResizablePanelGroup` 两个 Panel。
- Inspector：默认 320px、最小 280、最大 420、折叠宽 40；持久化 `mr-inspector-width` / `mr-inspector-collapsed`；折叠态显示 40px 窄条与展开按钮。
- 窄屏（<1100px）：不渲染 Inspector 列；单击封面打开覆盖式 `DetailSheet`；双击进入阅读。
- 封面单击在窄屏延迟 240ms，避开双击判定窗口。
- 工具栏：数据条（藏书/在读/今日）、搜索（250ms 防抖）、来源筛选（全部/本地/在线）、合集/平铺、URL 直读（受 `experimentalOnline` 门控）、添加书籍/文件夹、管理。
- 合集聚合：按 `seriesId` 分组，代表卡取 `updatedAt` 最新的一本；无 `seriesId` 的各自独立。
- 批量操作：浮动玻璃条，移除（软删）与删除源文件/彻底移除；在线书删除提示远程源未删除。
- 拖放：窗口级 `onDragDropEvent`，逐路径导入。
- 删除确认：统一经 `sourceDisplay` 脱敏（本地显示文件名；在线显示 `scheme://host/…/末段`，**不含 query/hash/userinfo**）。

### 7.5 Inspector 与详情

- `BookInspector` 分区：封面/标题/来源徽标/页数与已读百分比 → 来源地址（脱敏）→ 继续阅读 → 页面目录 → `BookDetail`（统计 + 章节选集）。
- 页目录：首次展开调用 `api.listEntries`；`TOC_WINDOW=60`，先渲染 60 项 + 搜索 + 每次加载更多 60；点击跳 `/reader/:id?page=N`（1-based，Reader 应用后清掉 query）。
- 章节选集：`SERIES_WINDOW=40`，先渲染 40 话 + 搜索 + “显示全部”；按 `chapterIndex` 升序。
- 进度口径：已读 = `currentPage`，百分比 = `currentPage/pageCount`；章节“已读完”标记按到达最后一页判定。
- 窄屏 `DetailSheet`：自定义右侧滑出面板，310ms 退出、330ms 后封面飞行；打开时聚焦关闭按钮、锁 body 滚动、Esc 关闭；共用 `BookDetail`（不含页目录）。

### 7.6 阅读器 HUD 与 Dock

- 顶部 `ReaderHudTop`：返回、标题、页签切换器、拖拽空白、缩放百分比/缩小/放大/重置、窗口控制。
- 底部 `ReaderDock`：上一页、页目录、单/双/条漫分段、进度滑杆、页码、下一页、“更多”（阅读设置/选区翻译/快捷键）。
- HUD 显隐：空闲 1500ms 渐隐；指针移动/按键/边缘进入唤醒；鼠标在 HUD 内、焦点在 HUD 内、目录/设置/OCR/翻译/快捷键/更多/页签菜单打开、选区模式时不隐藏；隐藏用 `inert` + opacity/transform，不卸载 DOM。
- 条漫滚动开始时隐藏 HUD，但同样尊重上述锁；点 Dock 翻页或拖滑杆不会让 HUD 当场消失。
- `ProgressScrubber`：拖拽只写本地 draft，**不发 get_page/get_thumbnail**；分页模式用已缓存图片做预览，未缓存只显示页码；提交在拖拽结束/短防抖，且只提交一次。
- 下一话胶囊：在线书到达末页（webtoon `pct>=0.97`）时显示；已入库直接 `replaceTab` + `navigate(replace)`；仅有 `nextUrl` 时动态解析入库后跳转。

### 7.7 条漫视图（`Webtoon.tsx`）

- 布局来自 `get_webtoon_layout`；按容器宽度与源图比例计算显示高度，切片高度 2048。
- 只挂载视口上下窗口内切片，下方预取 3.5 屏，滚出上方 2 屏/下方 7 屏后释放；整张长图不进入浏览器。
- 滚动进度 rAF 合并 + 400ms 节流提交；卸载立即提交。
- 后台逐页物化：本地近前 3 页、向前最多 10 页；在线收紧为近前 1 页、向前 2 页。
- 条漫键盘捕获：Home/End、Space/PageDown/方向下、PageUp/方向上；目标在 HUD/弹层/滑杆/页签菜单内时不处理。

### 7.8 页签工作区（`features/workspace/WorkspaceContext.tsx`）

- 最多 5 个阅读页签（不含固定的“书库”）；同一本书只允许一个页签。
- 只有激活页签挂载 Reader；后台页签只保存轻量快照 `{page,scrollPct,mode,dir,at}`。
- 恢复页码：比较快照 `at` 与后端 `updated_at`，取较新者；版式/方向始终取快照。
- 切换页签不清 L1；`clear_pages` 只在关闭最后一个阅读页签或回退单页签模式离开阅读态时调用。
- 下一话用 `replaceTab` 替换当前页签，避免页签数随章节增长。
- Reader 卸载时仅当 `isTabOpen(bookId)` 为真才写快照，避免已关闭/替换的页签复活。
- 页签仅在内存中，不跨重启恢复；`localStorage["mr-tabs"]="0"` 可回退单页签模式。

### 7.9 在线导入弹窗

- 双 Tab：“链接 / 清单导入”与“外部浏览器配对”。
- 链接 Tab：URL 输入、测试、仅加入书库、解析并直接阅读、辅助浏览窗口、粘贴图片 URL 列表、多话合集 JSON 导入。
- 配对 Tab：状态胶囊（灰点未启动 / 绿点监听中 + `127.0.0.1:<port>` + 已接收话数）、启动/停止、Callback URL 与 Pairing Token 只读等宽字段、复制接口信息/推送模板、隐私门控（临时请求头仅内存，监听中不可改）。
- 忙碌锁覆盖全部异步动作；忙碌时遮罩/Esc/关闭按钮均不关闭弹窗。
- OmniBar 传入 `initialUrl` 仅预填并聚焦，不自动解析。

### 7.10 快捷键

| 键 | 作用 |
|---|---|
| `←` / `→` | 翻页（RTL 时 ← 为下一页） |
| `Space` / `Shift+Space` | 下一页 / 上一页 |
| `f` | 单页 → 双页 → 条漫（条漫不可用时跳过） |
| `o` | 选区翻译 |
| `Ctrl/Cmd+K` | 命令中心（仅壳层） |
| `Ctrl/Cmd+1…9` | 1=书库，2…=阅读页签（壳层与阅读器均生效） |
| `Ctrl/Cmd+W` | 关闭当前阅读页签（不关闭书库） |
| `Home` / `End` | 首页 / 末页 |
| `Esc` | 依次：关页签菜单 → 退选区 → 关弹层 → 回车库 |
| `?` | 快捷键速查 |

### 7.11 实验开关镜像

- `experimentalTrans`：镜像 localStorage `mr-exp-trans`，订阅变更；关闭时隐藏工作台/术语表/选区翻译入口。
- `experimentalWebtoon`：镜像 `mr-exp-wt`；条漫需同时满足开关开启与 `book.webtoonReady !== false`。
- `experimentalOnline`：控制 URL 直读入口、在线命令与配对桥接；关闭时已打开的导入弹窗收起、桥接停止。

---

## 8. 配置与环境变量

### 8.1 设置项

见 [6.1](#61-设置与持久化)。设置页按“外观 / 实验性功能 / 在线源与网络 / 翻译 / OCR / Sidecar / 数据”分组；在线请求头支持“仅驻留内存 / 持久化到本地库”两种存储模式，并提供“立即清空内存凭据”。

### 8.2 环境变量

| 变量 | 作用 |
|---|---|
| `MR_DATA_DIR` | 覆盖数据目录（测试/冒烟隔离） |
| `MR_RENDER_CACHE_DIR` | 覆盖渲染缓存目录 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | WebView2 启动参数（如 `--remote-debugging-port=9333` 用于验收） |
| `TAURI_DEV_HOST` | Vite HMR 主机（Tauri 移动端/远程调试） |

### 8.3 凭据与隐私

- `trans_api_key` 与 `online_headers` 以普通字符串存入 `settings` 表（本地明文）；设置页有明文存储提示。
- 会话级请求头只在内存中，退出即焚；配对桥接的 `sessionHeaders` 同样只进内存。
- 最近一次在线测试只记录 `{ok, at, urlHost}`（host 脱敏），不包含请求头/凭据/完整 URL。
- 日志与错误信息统一脱敏 URL（去掉 query/fragment/userinfo）。

### 8.4 许可与分发

- 仅 Windows 打包；`decorations: false`，最小 900×600。
- 图标资源在 `src-tauri/icons/`；应用图标源文件 `app-icon.svg`。

---

## 9. 开发与运行

### 9.1 前置条件

- Node.js 20+、npm
- Rust（stable）+ Visual Studio Build Tools（MSVC）
- WebView2 Runtime（Win10/11 通常自带）
- Python 3.10+（仅 sidecar）

### 9.2 首次安装

```bat
npm install
cd sidecar && python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
```

### 9.3 启动

```bat
sidecar\launch.bat          :: 检测/OCR/擦除服务（:8500）
npm run tauri dev           :: 主应用（前端 :1420）
```

外部翻译 LLM（OpenAI 兼容，:8080）需用户自行启动；应用默认指向 `http://localhost:8080/v1`，`trans_model` 默认为空，首次使用需在设置中填写。

### 9.4 构建

```bat
npm run build               :: tsc + vite build
npm run tauri build         :: 生成安装包
```

### 9.5 数据重置

删除 `<数据目录>/library.db` 与 `render_cache/` 即可重置书库与成品缓存；不删除用户漫画源文件。

---

## 10. 测试与验收

### 10.1 自动测试

```bat
cd src-tauri && cargo test
npx tsc --noEmit
node scripts\verify-spread.mjs
node scripts\verify-region.mjs
```

当前基线（2026-10-21）：

- `cargo test`：**171 项全部通过**（169 个库单元测试 + 1 个 e2e + 1 个内存预算测试）。
- `tsc --noEmit`：0 错。
- `verify-spread`：12 项 PASS；`verify-region`：10 项 PASS。
- 构建：`vite build` 通过；单 JS chunk 约 700 KB（未拆包，见 [13](#13-已知限制)）。

单元测试分布（约）：online/http 28、commands 22、online/mod 18、online/direct 15、db 13、online/handoff 12、online/html 10、state 9、browser 8、system_proxy 6、cache 5、source 5、ocr 4、translate 4、sidecar 3、pipeline 2、workbench 2、render_cache 1、logging 1、lib 1。

关键覆盖：

- 在线请求头作用域：同源发送、跨源丢弃、非法 scope fail-closed、跨源 Referer 去 query/fragment、重定向逐跳恢复。
- 配对桥接：错误 token 403、同一会话连续多次 POST、`allowSessionHeaders` 门控、received 计数按会话隔离、停止后端口拒绝连接。
- 合集：series_id 稳定性与优先级、chapter_index/next_url 链、100 章上限、单事务入库。
- 系列/下一话：按 chapter_index 排序、next_url → series_id → 标题前缀三条路径。
- 系统代理：环境变量优先级、ProxyServer 多格式、ProxyEnable=0/非法值返回 None。
- 迁移/缓存/预取/条漫切片/内存预算。

### 10.2 集成与内存验收

- `tests/e2e_stage1.rs`：5 页 CBZ 入库 → 封面/单页可解 → 进度写入 → 今日/热力图同步。
- `tests/memory_budget.rs`：200 页全部驻留 L1、缓存字节不超预算、进程增长 ≤50 MB、关书后回落到基线 ±10 MB。

### 10.3 真机冒烟

使用 [真机冒烟清单](smoke-test.md)。Windows 下建议用 WebView2 CDP 验收：

```bat
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
npm run tauri dev
```

用 Playwright `connectOverCDP('http://127.0.0.1:9333')` 或等价方式操作；结束时不要调用 `browser.close()`，直接退出 Node 进程。每次点击前重新读取 `getBoundingClientRect()`；需要修饰键时发送真实 keyDown/keyUp。

至少覆盖：900×600、1200×800、1600×1000；100%/125%/150% DPI；最大化/还原；亮/暗主题；键盘全流程。

### 10.4 测试数据

- 不使用公网漫画站点做自动验收；用本地 CBZ/图片目录与本地 stub HTTP server / JSON 清单 fixture。
- 在线直读测试优先使用回环 stub 地址，避免代理、Cookie、验证码与站点合规问题。
- 不消耗 sidecar/LLM 配额做 UI 自动化；真实 OCR/翻译由用户按需手测。

---

## 11. Sidecar 契约

完整契约见 [sidecar-api.md](sidecar-api.md)。要点：

- `GET /health` → `{ ok, device, models }`。
- `POST /v1/detect` `{ image: base64 png }` → `{ width, height, boxes: [{x,y,w,h,score?,vertical?}] }`（绝对像素）。
- `POST /v1/ocr` `{ image, boxes }` → `{ texts: [{box, text}] }`（与输入同序）。
- `POST /v1/inpaint` `{ image, boxes }` → `{ image: dataURL, width, height }`。
- 错误响应优先读取 `{ error }`。

---

## 12. 性能设计要点

1. **画布层禁止全屏 `backdrop-filter`**；模糊只用于 HUD、Inspector、抽屉、弹层。
2. HUD 无常驻 `will-change`；滚动期间不每帧 setState 整个 Reader（Webtoon rAF + 400ms 节流）。
3. 进度滑杆拖拽预览只用已缓存图片，**0 网络请求**；提交一次。
4. 封面网格进入 L1/L2 缓存；缩略图只取第 1 页。
5. 条漫整页只解码一次，切片分段落盘；只挂载视口窗口内切片。
6. 预取窗口本地 ±1/±2、在线 +1/+2；在途键去重。
7. 配对桥接与批量 worker 均为独立线程，不阻塞主线程。
8. 磁盘渲染缓存 2 GiB、L1 预算可调（设置滑杆）；启动与写入超阈值时后台 trim。

---

## 13. 已知限制

1. **Mica/窗口材质未启用**：`tauri.conf.json` 无 `transparent`/`windowEffects`；当前为实色外壳，Win10 可用。属 Phase 5 可选项。
2. **打包未拆包**：单 JS chunk 约 700 KB（构建时 >500 KB 警告）；命令中心与弹层尚未懒加载。
3. **DPI 未验证**：125%/150% 缩放、Win10 回退未做真机验收。
4. **条漫真实滚动路径**：自动化与真机验收时若 `experimentalWebtoon` 关闭，仅能验证门控与静态逻辑；条漫滚动性能需开启开关后手测。
5. **页签不跨重启**：只存内存；这是有意行为。
6. **阅读器页目录与 Inspector 页目录独立**：Reader 内目录窗口 200 项、点击直接 `jumpTo`；Inspector 目录窗口 60 项、点击走 `?page=N`。
7. **`wb_detector`/`wb_ocr`/`wb_inpaint` 三个 provider 设置不参与路由**：命令固定调用 `/v1/detect|ocr|inpaint`。
8. **工作台 OCR 未写入翻译统计**：`wb_ocr` 成功路径不调用 `log_trans`，统计页只反映选区 OCR/翻译。
9. **批量任务卡片不显示成功/失败计数**：`batch_jobs` 有 `ok_pages/fail_pages`，列表 UI 仅显示进行中状态。
10. **`wb_inpaint` 无结果缓存**：重复执行会重新请求 sidecar（实测约 8–9 秒）。
11. **Cargo/package lockfile 已随版本更新**；若使用 `--locked` 流程需确保三者一致。
12. **无“关闭全部页签/退出工作区”动作**；回书库默认不清 L1（关闭最后一个页签才清）。

---

## 14. 扩展指南

### 14.1 新增 Tauri 命令

1. 在对应模块实现 `#[tauri::command]`，参数/返回用 serde camelCase。
2. 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册。
3. 在 `src/lib/tauri.ts` 增加封装与类型；不要在组件里直接 `invoke`。
4. 补单元测试；涉及权限时同步 `capabilities/default.json`（默认只授权 main）。

### 14.2 新增数据库字段/表

1. 在 `db::init_schema` 加 `CREATE TABLE IF NOT EXISTS` 或 `ALTER TABLE ADD COLUMN`（用 `pragma_table_info` 探测）。
2. 更新 `BookRow`/查询列。
3. 评估派生缓存失效（OCR/翻译）与 `removed` 语义。

### 14.3 新增页面

1. 在 `AppShell` 的 `Routes` 注册；受实验开关控制的页面复用 `gatedPage`。
2. 左侧导航在 `NavRail` 增加入口（lucide 图标 + 中文名）。
3. 新组件优先使用 v3 token（`bg-surface`、`text-ink`、`border-hairline`、`brand`），不要用 `bg-accent` 表示品牌色。

### 14.4 新增在线图源/清单格式

- 只扩展通用 JSON 清单或 HTML 图集，不写站点专用规则。
- 解析结果统一走 `OnlineBookMeta` + `apply_resolved_meta`；页列表统一走 `normalize_page_urls`。
- 新增链路字段时同步 `StoredMeta`/`BookInfo`/`get_next_book`，并保持 `manifestHash` 只覆盖标题+页面。

### 14.5 缓存规则

- 任何影响成品像素的变化（解码/缩放/质量/水印）都必须改变 L2 文件名或清理缓存。
- 清单变化时清该书 L1/L2/布局并失效源池；仅链路字段变化不清派生缓存。

### 14.6 实验功能与冻结池

- 新实验功能必须有设置开关、localStorage 镜像、关闭时的降级路径。
- 冻结池功能未立项前不得顺手实现；新想法先入 README 的冻结池清单。

---

## 15. 术语表

| 术语 | 含义 |
|---|---|
| 书库 | 本地漫画集合（文件夹/zip/cbz/在线书） |
| 条目 / 页目录 | 一本书内的页列表（`list_entries`） |
| 合集 / 系列 | 由 `seriesId` 关联的多话书籍 |
| 下一话 | `nextUrl` 或同系列自然排序的下一本 |
| L1 / L2 | 内存缓存 / 磁盘成品缓存 |
| 预取 | 当前页相邻页的后台渲染 |
| 条漫切片 | 长图按 2048 高度切分后的显示单元 |
| 工作台 | 逐页检测/OCR/擦除/翻译的编辑页 |
| 批量预翻译 | 对整本书逐页执行检测→OCR→翻译的后台任务 |
| 配对桥接 | 本地回环接收外部浏览器推送的导入通道 |
| 会话请求头 | 仅内存、退出即焚的在线请求头 |
| 冻结池 | 明确不实现的功能清单 |

---

## 附录 A：Tauri 命令契约

共 54 个，注册于 `src-tauri/src/lib.rs:429-484`。参数名按前端 invoke 约定为 camelCase（Rust 侧 snake_case 自动转换）。

### A.1 书库与阅读（`commands.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `scan_library` | — | `BookInfo[]` |
| `import_books` | `paths: string[]` | `ImportItemResult[]` |
| `remove_books` | `ids: string[]`, `deleteFiles: boolean` | `RemoveResult` |
| `list_books` | `query?: string` | `BookInfo[]` |
| `get_book` | `bookId: string` | `BookInfo \| null` |
| `get_next_book` | `bookId: string` | `BookInfo \| null` |
| `get_series_books` | `seriesId: string` | `BookInfo[]` |
| `list_entries` | `bookId: string` | `PageEntry[]` |
| `get_page` | `bookId`, `index`, `maxWidth?`, `maxHeight?` | `PageImage` |
| `get_thumbnail` | `bookId`, `edge` | `PageImage` |
| `clear_thumbnail_cache` | — | `number` |
| `get_webtoon_layout` | `bookId` | `PageDim[]` |
| `get_webtoon_tile` | `bookId`, `index`, `tile`, `width` | `PageImage` |
| `get_memory_stats` | — | `MemoryStats` |
| `get_dashboard` | — | `Dashboard` |
| `get_reading_log` | `bookId`, `days` | `HeatDay[]` |
| `get_reading_by_book` | `days` | `BookDayPoint[]` |
| `set_progress` | `bookId`, `page`, `pct?` | `void` |
| `clear_pages` | — | `void` |
| `get_settings` | — | `Settings` |
| `set_settings` | `settings: Settings` | `void` |
| `ocr_region` | `bookId`, `index`, `rect` | `OcrResult` |
| `translate_region` | `text` | `TranslateResult` |
| `get_trans_stats` | — | `TransStats` |
| `sidecar_health` | — | `SidecarHealth` |
| `glossary_list` | `seriesId` | `[string,string][]` |
| `glossary_set` | `seriesId`, `src`, `dst` | `void` |
| `glossary_remove` | `seriesId`, `src` | `void` |

### A.2 在线直读（`commands.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `resolve_online_url` | `url` | `BookInfo` |
| `test_online_connection` | `url` | `OnlineProbe` |
| `import_resolved_pages` | `url`, `title`, `pageUrls: string[]` | `BookInfo` |
| `resolve_online_batch` | `payloadJson` | `BookInfo[]` |
| `set_session_online_headers` | `headers?: string` | `void` |
| `clear_session_online_headers` | — | `void` |
| `get_session_online_headers` | — | `string \| null` |

### A.3 配对桥接（`online/handoff.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `start_browser_handoff` | `allowSessionHeaders: boolean` | `HandoffStatus` |
| `stop_browser_handoff` | — | `void` |
| `get_browser_handoff_status` | — | `HandoffStatus` |

### A.4 内嵌浏览器（`browser.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `open_browser_window` | `url` | `void` |
| `navigate_browser` | `url` | `void` |
| `list_browser_downloads` | — | `BrowserDownload[]` |
| `import_browser_download` | `path` | `string \| null` |

### A.5 系统代理（`system_proxy.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `detect_system_proxy` | — | `string \| null` |

### A.6 工作台（`workbench.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `wb_detect` | `bookId`, `index` | `DetectResult` |
| `wb_ocr` | `bookId`, `index`, `boxes` | `OcrText[]` |
| `wb_inpaint` | `bookId`, `index`, `boxes` | `InpaintResult` |
| `wb_translate` | `bookId`, `texts` | `TranslatedText[]` |
| `wb_save_ocr` | `bookId`, `index`, `width`, `height`, `boxes`, `texts` | `void` |
| `wb_get_ocr` | `bookId`, `index` | `SavedOcr \| null` |

### A.7 批量（`batch.rs`）

| 命令 | 参数 | 返回 |
|---|---|---|
| `batch_enqueue` | `bookId` | `BatchJob` |
| `batch_pause` | `bookId` | `void` |
| `batch_resume` | `bookId` | `void` |
| `batch_cancel` | `bookId` | `void` |
| `batch_list` | — | `BatchJob[]` |

### A.8 数据契约要点

- `BookInfo`：`id/title/path/pageCount/currentPage/updatedAt/scrollPct/sourceType/webtoonReady/seriesId?/seriesTitle?/chapterIndex?/nextUrl?`。
- `Settings`：23 个字段，camelCase。
- `StoredMeta`：`schema/manifestHash/fetchedAt/pages/seriesId?/seriesTitle?/chapterIndex?/nextUrl?`。
- `HandoffStatus`：`active/port/pairingToken/callbackUrl/receivedChapters/allowSessionHeaders/script`。
- `BrowserDownload`：`path/name/size/modified/imported`。

---

## 附录 B：常见故障排查

| 现象 | 排查 |
|---|---|
| 设置页一直“正在加载设置…” | `get_settings` 失败或 `get_memory_stats` 阻塞；查看日志与数据库文件权限 |
| 在线解析失败 | 先用 `test_online_connection`；检查代理、`experimental_online`、清单 JSON 合法性；JSON 合法但语义错误不会回退 HTML |
| 在线书页请求 403/404 | 站点会话失效；在设置中填写请求头或使用配对桥接推送 `sessionHeaders`（仅内存） |
| 配对桥接启动失败 | `experimental_online` 未开、端口绑定失败或已有会话；查看 `get_browser_handoff_status` |
| 浏览器窗口下载后未自动导入 | 仅 zip/cbz 自动导入；确认文件在 `<数据目录>/downloads`；查看 `browser` 日志 |
| 条漫按钮禁用 | `experimentalWebtoon` 未开或 `webtoonReady=false`（清单缺宽高、本地页头解析失败） |
| OCR 失败 | `ocr_endpoint` 为空时走 Windows 本地 OCR；检查语言包；HTTP OCR 检查 endpoint 与超时 |
| 翻译失败 | `trans_endpoint`/`trans_model` 必填；LLM 服务是否在 8080；检查 API key 与超时 |
| 批量任务不动 | `batch_jobs.state` 是否 queued；sidecar 健康；查看 `last_error` |
| 磁盘占用过大 | 渲染缓存 2 GiB 上限自动 trim；可手动删除 `render_cache/` |
| 版本不一致 | 五处版本：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock`、`package-lock.json`；UI 版本在 `AppShell.tsx` |

---

## 附录 C：文档维护约定

1. **单一真相**：本文件描述当前代码；历史设计/计划只在文首加状态横幅，不改写历史正文。
2. **变更同步**：修改命令契约、数据库字段、路由或版本号时，同步更新本文件对应表格与附录 A。
3. **版本一致**：升级版本时同时更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、两个 lockfile 与 `AppShell.tsx` 的 `VERSION`。
4. **测试数字**：以实际 `cargo test` 输出为准，不手写估算；当前为 171（169+1+1）。
5. **链接**：文档间相对链接以 `docs/` 为基准；避免 `../superpowers/...` 这类越级路径。
6. **标点**：中文正文使用全角标点；代码/命令/路径保持半角。
