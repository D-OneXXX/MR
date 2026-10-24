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
- **CSP**：`app.security.csp` 不得为空。生产策略锁定
  `default-src 'self'; script-src 'self'; img-src 'self' data:;
  connect-src ipc: http://ipc.localhost http://tauri.localhost https://tauri.localhost;
  style-src 'self' 'unsafe-inline'`；Tauri 构建时会为内联脚本追加 sha256。
  `devCsp` 单独放行 Vite 的 localhost/WebSocket 与 `unsafe-eval`，生产 csp 不放宽。
  静态守卫 `static:csp` 无条件检查五项关键指令；生产构建冒烟验证 IPC、
  data URL 缩略图与阅读页图片均正常（CSP 违规数为 0）。

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
- **缓存写入可观测**：`cache_health` 进程级计数器累计 render/online 缓存写失败；首次失败
  写脱敏日志并 emit `cache-write-failed`，AppShell 六语 toast，诊断包
  `cacheWriteFailures` 可见。更新安装前通过 `platform::free_bytes` 检查系统临时目录
  剩余空间，<256MB 明确提示，不直出 `os error 112`。
- SQLite 所有生产连接统一经 `db::open`：`journal_mode=WAL`、`busy_timeout=5000`、
  `synchronous=NORMAL`、`foreign_keys=ON`，避免条漫滚动进度 / 规则落盘 / 缓存统计并发写入时锁库。
- 启动时在 `init_schema` 后执行 `PRAGMA quick_check`。打开/结构/完整性失败会写入
  `AppState` 稳定错误码（`db-open-failed` / `db-schema-failed` / `db-quick-check-failed`），
  前端 `DbRecoveryGate` 阻塞主界面并提供「从 .mrbackup 恢复数据库」「打开数据目录」
  「重新检查」，不再静默继续让全部命令报“数据库尚未初始化”。
- 启动恢复走 staging：先把备份恢复到 `library.recovery-*.db`，`wal_checkpoint(TRUNCATE)`
  后才隔离旧库（`*.corrupt-*`）并原子替换；失败时活库完全不动。`set_settings` 不再吞掉
  数据库错误，数据库不可用时必须显式失败。

环境变量：`MR_DATA_DIR`、`MR_RENDER_CACHE_DIR`、`MR_ONLINE_CACHE_DIR`、
`WEBVIEW2_USER_DATA_FOLDER`（主要用于 QA 隔离）。`MR_DATA_DIR` 隔离模式下缓存根为
`<MR_DATA_DIR>/cache`，且跳过旧数据目录迁移。

## 5. 数据模型

| 表 | 主键 | 内容 |
|---|---|---|
| `books` | `id` | path、title、page_count、current_page、scroll_pct、source_type、meta_json |
| `source_stats` | `book_id` | 压缩包增量扫描指纹（mtime/size），派生数据不进入备份 |
| `reading_log` | `(date, COALESCE(book_id,''))` | 逐日阅读页数；`book_id` 可空外键 |
| `settings` | `k` | 主题、缓存、目录、在线源等设置 |
| `app_meta` | `k` | last_run_version 等内部标记 |
| `online_filter_profiles` | `host` | 站点选择器、CDN 模板、宽度/aspect 区间、uses |
| `online_filter_rules` | `id` | block/allow + URL 模板/精确 URL/SHA-256/DOM class/尺寸 |
| `online_filter_events` | `id` | 脱敏 URL、原因、动作、尺寸、时间；最多 10000 条 |

- `BookInfo.path` 对在线书就是规范化 URL，`id = sha256(首次入库 path)`。
- **路径身份归一**：本地书导入/重定位先按精确 `sha256(path)` 查找，再按
  `normalize_path_identity` 兜底——Windows 统一 `/`→`\`、去尾部分隔符并忽略
  大小写；Unix 只去尾部 `/`（反斜杠是合法文件名）。同一文件的不同写法复用
  原 id 并刷新 path，不重复建书。在线 URL 不走该归一。
- `BookInfo.missing` 不落库：`list_books` / `get_book` 对本地源做一次
  `symlink_metadata`，仅 `NotFound` 标记为 `true`（权限/网络盘错误不误判）；
  在线书恒为 `false`。
- **无损重定位**：`relocate_book(bookId, newPath)` 在单事务内把 `books.id` 从
  `sha256(oldPath)` 改为 `sha256(newPath)`，同步迁移 `reading_log.book_id` 与
  `online_filter_events`，保留 `current_page` / `scroll_pct` / `updated_at` /
  `source_type` / `meta_json`，并按新页数钳制页码。移动/改名文件后重导入不会产生重复书。
  同日 `reading_log` 冲突按 `SUM` 合并：旧 id 与新 id 是同一实体书的两次登记，
  两段阅读页数都必须保留（此前取 MAX 会丢掉较少的一段）。
- 在线 `meta_json` 是 `StoredMeta`：`pages[]`、`filtered[]`、`filter_profile`、系列/下一话链路。
- `PageRef` 可带 `anchor { channel, messageId, photoIndex, refreshBase }`。
- `reading_log` 旧库迁移在单事务内完成；崩溃遗留的 `reading_log_legacy`
  会在下次启动合并后删除。旧形态（`book_id NOT NULL DEFAULT ''` + `(date, book_id)` 主键）
  由 `migrate_reading_log_foreign_key` 单事务重建为可空 `book_id REFERENCES books(id)
  ON DELETE CASCADE`：空串转为 NULL（承载迁移前的全局旧史），真实但已不存在的
  `book_id` 按孤儿丢弃；唯一性由表达式索引
  `idx_reading_log_book_date(date, COALESCE(book_id,''))` 保证。重建后的索引创建位于
  所有旧表迁移之后，兼容还没有 `book_id` 列的上古库。
- **进度写入事务**：`set_progress` 的页码更新与当日 `reading_log` 累加在同一事务提交，
  UPSERT 使用无 conflict target 的 `ON CONFLICT DO UPDATE`（匹配表达式唯一索引）；
  `remove_books`（软删/硬删）与 `relocate_book` 同样在单事务内完成。`relocate_book`
  改 `books.id` 前执行 `PRAGMA defer_foreign_keys=ON`，子行迁移完成后再统一校验外键。
- 页数缩小用 `MIN(current_page, page_count-1)` 钳制。
- **schema 版本**：`PRAGMA user_version` 由 `db::SCHEMA_VERSION`（当前 1）记录，
  只增不减，前向库保持更高值；迁移/建表完成后统一写入。退出时
  `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合并回主库并截断，失败不阻断退出。
- **在线页数护栏**：同一 URL 重新解析出的清单页数少于现有 `books.page_count`
  时，`upsert_resolved_meta` 直接拒绝覆盖并返回稳定码
  `online-page-count-drop`，旧清单、`current_page` 与 `scroll_pct` 原样保留；
  站点确实删页时由用户显式删除该书后重新导入。避免反爬误判/站点改版把
  用户进度钳到末页。
- **书库列表性能**：`books(removed, updated_at DESC)` 索引 `idx_books_list` 支撑
  默认倒序列表；`list_books` / `scan_library` 只把 SQL 放在 `DbSlot` 锁内，
  逐本 `symlink_metadata`、`meta_json` 解析与 `missing` 判定全部移到锁外，
  避免大书库刷新拖住阅读器高频 `set_progress`。`meta_json` 每本只解析一次，
  同时供条漫能力与系列字段复用。
- **增量扫描指纹**：`source_stats(book_id REFERENCES books(id) ON DELETE CASCADE
  ON UPDATE CASCADE, mtime, size)` 只记录压缩包单文件；重复导入时
  mtime 与字节数都未变则直接复用 `page_count`，不再解包。目录始终全量扫描
  （嵌套变更不会可靠反映到目录 mtime）；扫描失败会清掉旧指纹，文件回滚到旧
  mtime/size 时不会被误判为未变。备份/恢复不携带该派生表。

## 6. 后端模块

| 模块 | 职责 |
|---|---|
| `lib.rs` | 设置、启动迁移、命令注册、路径解析入口 |
| `paths.rs` | `app_data_dir` / `app_cache_dir` 锚点、旧库原子迁移与 `quick_check` |
| `db.rs` | SQLite schema、WAL + `busy_timeout=5000`、书库/进度/设置/统计/重定位事务 |
| `commands.rs` | 书库/取页/进度/设置/在线导入/过滤标记恢复/失效路径重定位 |
| `open_with.rs` | 文件关联与命令行参数过滤、单实例唤醒、待打开请求内存队列 |
| `backup.rs` | `.mrbackup` 导出/恢复、启动自检恢复、快照净化、完整性/计数校验、事务导入 |
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
- `get_filtered_preview` 与取页/切片共用 `pipeline::source_dimensions` header 预检
  （`MAX_SOURCE_PIXELS = 160M`），超巨图/解码炸弹在 `image::load_from_memory` 前拒绝，
  避免 `panic = abort` 下直接闪退。
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

### 6.3a ZIP/CBZ 条目名编码探测与伪装包嗅探（0.17.0）

- **条目名解码阶梯**（`source.rs::fixup_entry_name`）：原始字节合法 UTF-8 →
  原样；否则 GB18030（GBK 超集，中文 Windows 打包工具 CP936）与 Shift_JIS
  （日文原版 CP932）各解一次，优先无错者；两者都无错时按**全角假名出现率**
  裁决（Shift_JIS 含假名而 GB18030 不含 → 判日文包；半角片假名是 GBK 按 SJIS
  解出的典型噪声，不算证据）；都有替换字符 → 回退 zip crate 的 CP437。
  修复只影响展示名，`lookup` 恒用 zip crate 解码名保证读页 100% 命中，
  自然序不受影响。纯汉字日文名与中文名无法区分（无假名线索），按 GB18030 展示。
- **魔数嗅探**（`source.rs::sniff_archive_magic`）：打开 `.zip/.cbz` 前先读
  头 8 字节——`PK\x03\x04`/`PK\x05\x06`/`PK\x07\x08` 放行；`Rar!`
  （52 61 72 21）与 `7z\xBC\xAF\x27\x1C` 立即报结构化错误，不进入 zip
  解析。错误文案内嵌稳定码 `archive-disguised-rar` / `archive-disguised-7z` /
  `archive-not-zip`，前端 `localize.ts` 按码映射六语（zh 原文直出）。
- **加密检测**：条目收集改用 `by_index_raw`（只读中央目录不解密），命中
  加密标志（`entry.encrypted()`）即报 `archive-encrypted`，杜绝读页时爆出
  难懂的底层解密错误或前端无限转圈。

### 6.3b 前端错误本地化（P1.13）

- 所有用户可见错误（Toast、ErrorState、内联 `setError`/`setNotice`）都必须经
  `src/features/errors/localize.ts::localizeBackendError`：中文界面直出后端原文，
  其它语言按稳定码映射六语，未知中文错误统一为 `error.backendGeneric`，
  绝不把中文原样混进西语/日语/韩语界面。本次收口书库、详情 Sheet、设置页、
  浏览器页、隐私自检、安全模式胶囊、Webtoon 布局与目录（PageToc）等裸错误点。
- 后端稳定码继续扩表：备份（`backup-file-missing` / `backup-invalid-format` /
  `backup-unsupported-schema` / `backup-integrity-failed` / `backup-too-large` /
  `backup-restore-failed`）、在线（`online-url-invalid` /
  `online-blocked-address` / `online-too-many-pages` / `online-fetch-failed`）、
  更新（`update-unsupported-format`），全部进入六语字典。
- 导入失败聚合时先逐条本地化 `item.message`，再拼 `import.itemFailed`，
  避免把整句（含可能为 CJK 的本地路径）二次判为中文而退化成泛化提示。

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

- 导出：`VACUUM INTO` 生成一致性快照 → 净化（仅保留 settings 白名单
  `theme` / `cache_budget_mb` / `disk_cache_budget_mb` / `library_dir` /
  `experimental_webtoon`；删除 `online_headers`、`online_proxy`、
  `experimental_online`、`online_filter_events`、`app_meta`）→ `VACUUM` 抹除空闲页
  → `PRAGMA integrity_check` → 切 `journal_mode=DELETE` → 写入 zip
  （`manifest.json` + `library.db` + 可选 `preferences.json`）。目标文件先写同目录
  临时文件，再原子替换。
- 恢复：zip 条目数/大小/名称校验，缺 `manifest` 或路径穿越直接拒绝；`library.db`
  解压到系统临时目录，只读 `integrity_check`、必需表和列、manifest 计数全部通过后，
  才用 `ATTACH` + 单事务清空/复制核心表；失败 `ROLLBACK`，活库不动。
- **更新残留清理**：启动时删除系统临时目录 `mangareader-updates/` 内超过
  24 小时的文件；AppImage 运行态下同时删除已验证成功运行后的
  `.old-appimage` 回滚备份。只处理普通文件，不跟随符号链接、不创建目录。
- **构建基线与发布门禁**：`build.rs` 监听 `.git/HEAD`、`.git/index`、分支
  refs、前后端源码与依赖清单，工作区脏改会重算 `MR_BUILD_BASELINE`；发布
  与常规 CI 的静态守卫按 YAML steps 解析，测试/签名/审计标记不能靠注释蒙混。
  更新清单拉取有回环 mock server 单测（200 解析、503 拒绝）。
- **Webtoon 坏图失败态**：预解码显式 onerror 返回 false 并进入 `failed`；
  超时（8s）不当作错误，仍插入让浏览器继续解码；`<img>` 运行时 onError
  同样置失败，切片显示可点按重试按钮，不再永久空白。
- **原子导出**：`.mrbackup` 先写到目标同目录唯一隐藏临时文件，zip 完成后
  `flush + sync_all`，再直接 `rename` 覆盖旧备份并 fsync 父目录；不再先删旧文件，
  崩溃时最多留下临时文件，上一份可用备份始终存在。
- **旧版兼容**：0.16 形态备份（无 `source_stats`、旧 `reading_log`
  `(date, book_id)` 主键、空串全局史）可直接恢复；空串在复制时转 NULL，
  全局与按书页数都保留，目标库随后由 `init_schema` 补新表。
- **路径注入防线**：本地 `books.path` 必须绝对、存在，且为目录或 `.zip/.cbz`；
  命中系统根、系统目录、用户主目录/文档/桌面/下载等宽目录，或应用数据/缓存目录时，
  该行被跳过，写入 `skippedBooks` 报告（不回滚整包、不删除磁盘内容）。在线书 URL
  不做本地路径校验。
- 恢复范围：`books`、`reading_log`、`settings`（**只替换白名单键**，保留当前
  `online_headers` / `online_proxy` / `experimental_online` 等设备环境）、
  `online_filter_profiles`、`online_filter_rules`；**不含**缓存、Cookie、过滤事件、
  `app_meta`。`reading_log` 只复制白名单书与全局旧史，避免孤儿记录。恢复后刷新内存设置、
  缓存预算、内存/磁盘派生缓存与源句柄。
- **删除源文件锚定**：`remove_books(delete_source_files=true)` 在 `remove_dir_all` /
  `remove_file` 前复用同一安全路径判定；文件必须是压缩包，宽目录/系统目录/应用目录
  一律拒绝并回报错误，绝不因恶意备份路径误删用户目录。
- `preferences.json` 由前端白名单采集（主题/语言/阅读器偏好），后端只校验
  JSON 对象与大小并原样透传；恢复后前端写回 localStorage 并即时应用主题/语言。
- **跨版本前向兼容**（0.17.0）：manifest `schema` 高于当前程序时不再拒绝——
  serde 已忽略未知字段，`copy_sql` 显式列复制天然丢弃高版本新增表/列，仅提取
  核心（书库路径、章节进度、阅读统计、过滤规则）；恢复结果携带
  `forwardSchema` 标记，前端 toast 提示「已按兼容模式恢复」。`schema=0`
  仍拒绝。Windows 主线与 Linux 分支互导的 `.mrbackup` 双向可用。

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
- **SSRF 防护**：`normalize_url` / `ensure_http_url` 拒绝字面私网、link-local、
  169.254.169.254、::1、fc00::/7、fe80::/10；HTTP transport 在首跳与每一跳重定向
  都重新做 DNS 解析并校验全部地址。回环只允许 debug 测试/QA 通过
  `MR_ALLOW_LOOPBACK_ONLINE=1` 显式放行，release 构建永远关闭。
- 两目录由 `AppState::trim_disk_cache` 共用软上限（设置项 `diskCacheBudgetMb`，500–10240 MB）；
  读取刷新 mtime，按最旧优先淘汰；设置页可查看占用/分项并一键清空临时缓存。
- `clear_temp_cache` 同时清空内存页/缩略图/条漫切片与两个磁盘目录，但不删除 SQLite 的任何行。

### 7.7 请求头作用域

- 支持 JSON 对象或单行 Cookie；禁止 Host/Content-Length/Connection/Transfer-Encoding；
  拒绝 CRLF。
- 用户请求头只在同 origin 发送；跨 origin 丢弃，只保留派生 Referer/Origin。
- 会话请求头 `session_online_headers` 仅内存，绝不写 SQLite/日志。

## 8. 更新与版本

### 8.1 旧自定义补丁通道（已下线 IPC）

- **不再注册** `check_update` / `download_update` / `install_update` /
  `cancel_update` / `get_update_snapshot`；前端零调用。旧 `update.rs` 的清单
  格式与官方 `latest.json` 不兼容，继续暴露只会扩大攻击面。
- 保留 `get_app_info`（关于页/签名徽章）与用户点击的 `restart_app`；旧签名
  校验函数与负向测试作为回归资产保留，但无网络入口。
- SemVer 严格 `MAJOR.MINOR.PATCH`，拒绝 `1.2`、`01.2.3`、四段版本。
- 未配置 `MR_UPDATE_PUBKEY` 时只有回环清单允许无签名；远程清单/重定向一律拒绝。
- 安装包按 sha256 + minisign 校验；下载连接超时 20s，分块空闲超时，总上限 60 分钟。
- 安装使用 PowerShell `-EncodedCommand`（UTF-16LE），支持中文/emoji 路径；不写 UTF-8 `.cmd`。
- 若未来重新启用自定义通道，必须重新注册命令、注入公钥、统一清单格式并补前端
  接线；不得直接复用当前未注册状态。
- 0.17.0 起设置页**不再暴露更新清单地址输入框**：端点在构建配置中锁死
  （Windows: GitHub Releases `latest.json`，Linux: `latest-linux-critical.json`）。
  旧 `check_update` / `download_update` / `install_update` / `cancel_update` /
  `get_update_snapshot` 已不再注册；历史遗留的本机清单地址（`mr-update-prefs`）
  仅供「隐私与安全」审计评估回环策略，不构成可用更新通道。

### 8.2 官方 Tauri Updater / GitHub Releases（0.16.0）

- `bundle.createUpdaterArtifacts = true`；`plugins.updater.pubkey` 保存 minisign 公钥，
  `endpoints` 指向 `https://github.com/D-OneXXX/MR/releases/latest/download/latest.json`。
- 客户端「设置 → 关于与维护」为**唯一一张「软件更新」卡片**（0.17.0 合并
  双通道双卡片后）：手动检查（不自动轮询）、状态格展示 当前版本/可用版本/
  构建基线/运行平台、纯文本 notes、下载进度、安装完成提示；底部右侧
  `Minisign 签名校验` 徽章由 `get_app_info().signatureConfigured` 驱动
  （汇总 `tauri.conf.json plugins.updater.pubkey` 与 `MR_UPDATE_PUBKEY`，
  0.17.0 前只看后者导致「一边已配置一边未配置」的矛盾展示）；重启只在
  用户点击 `restart_app` 后发生。Windows 安装器退出/重启属于用户点击安装后的预期行为。
- CI（0.17.0 起拆分，见 §8.4）：`release-windows.yml` 在推送 `v*` 标签（排除
  `-linux*`）时：校验 tag 与 `package.json` 版本一致 →
  `npm ci` → `tauri-action@v1`（NSIS，`uploadUpdaterJson: true`）→ 上传签名安装包与
  `latest.json`。签名私钥由 `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 注入，**绝不入库**。
- 权限：仅 `capabilities/updater.json` 对 `main` 授予 `updater:default`；
  `restart_app` 是自研命令，不需要 `process:*`。
- **Linux 安装形态**：`platform::install_channel` 返回 `appimage` / `system` /
  `portable`。只有 AppImage 运行态允许调用 native `install()`；deb/rpm 系统安装
  强制渲染手动更新卡（打开下载页/发行说明），并阻断 install 命令，绝不替换
  `/usr` 下的包管理器文件。Linux 更新 URL 若没有 `.deb/.rpm/.AppImage` 后缀直接
  拒绝，不再回落 NSIS。稳定码 `linux-manual-install` 已进入六语 localize 表。
- `version:sync` 先校验全部文件再统一写入，失败回滚，不产生半迁移。

### 8.3 Windows NSIS 安装器与升级身份（0.16.0）

- `bundle.targets = ["nsis", "deb", "rpm", "appimage"]`；Windows 只产出 NSIS
  `*-setup.exe`，绝不产出 MSI。Tauri 在 Windows 上会忽略 deb/rpm/appimage；
  Linux 由 `tauri.linux.conf.json` 覆盖为 deb/rpm/appimage，避免跨平台构建 NSIS。
- `bundle.windows.nsis`：`installMode: "both"`（用户可选当前用户/全机安装，
  元数据写 HKCU 或 HKLM）、`compression: "lzma"`、`displayLanguageSelector: true`，
  内置 `SimpChinese` / `TradChinese` / `English` / `Spanish` / `Japanese` / `Korean`
  六种安装向导语言。
- `plugins.updater.windows.installMode: "passive"`：自动更新以被动模式运行 NSIS，
  只显示进度条与管理员授权（若原安装为全机模式），不弹出完整安装向导。
- **升级身份**：NSIS 的卸载/升级键为
  `Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`，快捷方式与
  文件关联都绑定 `${PRODUCTNAME}` 与稳定的主程序名。因此 `productName`（MangaReader）、
  `identifier`（com.local.manga-reader）与主程序名（显式锁定
  `mainBinaryName: "manga-reader-tauri"`）必须保持稳定；升级安装会复用
  `MANUPRODUCTKEY` 中记录的 `$INSTDIR`，在 update 模式下跳过快捷方式重建，
  文件关联则按当前配置重新登记。
- 静态守卫 `static:release-surface` 锁定 productName/identifier、targets、NSIS 六语、
  `.cbz/.zip` 关联、`plugins.updater.windows.installMode` 与签名 CI，防止误改断链。
- 已知上游限制：Tauri 内置的 NSIS 韩语 MUI 文件缺少 MultiUser 插件的 5 条
  「安装范围」文案，选择韩语时该页会回退英文；其余安装向导为韩语，语言选择与安装
  不受影响。Tauri 的 `customLanguageFiles` 在 `MUI_LANGUAGE` 之后才 include，
  无法补齐这些已冻结的 MUI 字符串，强行自定义只会留下无效配置。

### 8.3 Linux 更新策略（feat/linux-port）

- 安装形态由 Rust `platform::install_channel()` 判定，经 `get_app_info` 的
  `linuxInstall` 字段暴露：`appimage`（`APPIMAGE`+`APPDIR` 运行时注入）/
  `system`（exe 位于 `/usr`、`/opt`，deb/rpm 管辖）/ `portable` / 空串（非 Linux）。
- **AppImage 运行态**：自研更新通道新增 `appimage` 制品格式
  （`resolve_format` 识别 `.AppImage`/`deb`/`.rpm`）；`install_appimage`
  备份旧文件 → `replace_with_copy` 把新包复制到目标同目录隐藏临时文件 →
  `fsync` 文件与目录后原子改名 → 拉起新进程，任一步失败回滚，无需 root。
  下载目录与 AppImage 常位于不同挂载点，直接 `rename` 会 EXDEV；同目录
  复制也避免跨设备半截文件。
- **系统安装态（.deb/.rpm）**：应用绝不以 root 自居改 `/usr` 下文件；
  安装按钮替换为手动引导（`sudo apt install ./MangaReader_<v>_amd64.deb` /
  `sudo dnf install ./MangaReader-<v>-x86_64.rpm`），安装包暂存于
  `/tmp/mangareader-updates/`；同时提示 Ubuntu 22.04+ 运行 AppImage 需
  `libfuse2`。
- 打包目标经 `src-tauri/tauri.linux.conf.json` 平台 overlay 固定为
  `["deb","rpm","appimage"]`（Windows 的 `tauri.conf.json` 不受影响）；
  `.cbz`/`.zip` 的 MIME 关联（`application/vnd.comicbook+zip`）由
  `fileAssociations` 生成 `.desktop` 条目，支持文件管理器双击直开。

### 8.4 双端更新通道解耦与非商用授权（0.17.0）

- **通道拆分**：`tauri.linux.conf.json` 把 Linux 的 updater 端点覆盖为
  `latest-linux-critical.json`（Windows 保持 `latest.json`）。Linux 客户端
  更新面板常驻六语提示：长期稳定分支，官方仅推送高危安全/崩溃补丁。
- **CI 拆分**：`release-windows.yml`（`v*` 且非 `-linux*`，仅 windows-latest）
  与 `release-linux-critical.yml`（`v*-linux-sec*` 或手动 dispatch，
  ubuntu-22.04，`scripts/make-linux-critical-manifest.mjs` 生成清单）互不
  阻塞；两条流水线都会把另一通道的清单文件**接力携带**到新 Release，
  保证 `releases/latest/download/` 下两个 URL 永远可用。
- **构建来源指纹**：编译期 `MR_BUILD_ORIGIN`（官方 CI 注入 `official`，
  否则按 `community`）经 `get_app_info().buildOrigin` 与诊断快照
  `runtime.buildOrigin` 暴露；设置 → 关于与维护显示
  `Official Release` / `Community Modified Build (Non-Commercial)` 徽章，
  AI 排查提示词同步携带，防止社区魔改版缺陷混淆官方排查。
- **社区构建**：`npm run build:community`（`scripts/build-community.mjs`）
  在没有 `TAURI_SIGNING_PRIVATE_KEY` 时生成临时覆盖层
  `src-tauri/tauri.community.json`（`createUpdaterArtifacts=false`，已
  gitignore），一键产出本地 deb/rpm/AppImage；支持 `-- --bundles appimage`
  透传。
- **授权**：根目录 `LICENSE`（PolyForm Noncommercial 1.0.0）+ `NOTICE.md`
  （允许个人/社区查看、修改、适配（特别是 Linux 发行版）与非盈利分发；
  严禁商业售卖、付费订阅、捆绑商业推广、广告变现与商业内部部署）。
- 静态守卫 `static:release-surface` 同步升级：校验双流水线标记、
  Linux 端点、`MR_BUILD_ORIGIN: official` 注入与 macOS 残留（runner/darwin/icns）净空。

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
- **双页模式（0.17.0）**：配对由 `spread.ts` 统一组模型驱动——
  `get_webtoon_layout` 逐页原始宽高（本地书 256KB 头部探测，后端 LRU 缓存）
  供宽页独占判定（`width > height × 1.1` 自动独占一屏居中，绝不与相邻竖页
  强行并排）；「首页封面单独成页」开关（`mr-reader-cover`，sanitizer flag
  规则 + 备份偏好白名单）开启后第 1 页独占、`[2,3]/[4,5]` 起成对；缺省值
  保持历史行为（RTL 封面单页、LTR `[0,1]` 起对）。Dock 胶囊按钮与阅读
  设置弹层均可切换；`stepPage` 按组步进，落点取组内最小页下标。
- **休眠唤醒自愈（0.17.0）**：Reader 与 Webtoon 监听 `visibilitychange`/
  `focus`，恢复可见 400ms 后对视口内图片/切片做 `complete &&
  naturalWidth===0` 与 `decode()` 拒绝双重校验，坏图丢缓存**静默重取**
  （单次唤醒分页 ≤2 页、切片 ≤3 片，防连环重取）。
- 条漫：固定布局高度、DOM 窗口切片、滚动 120ms 空闲合流、最多 4 个在途请求；
  切换版式使用 Webtoon 实时中心页，避免 400ms 防抖导致进度回退。
- HUD/Dock 自动隐藏；过滤抽屉/目录/设置弹层会锁定 HUD。阅读器保持原有布局
  （经确认偏好原版）：底部 Dock 承载版式切换组——在线书 `webtoonReady=false`
  时条漫按钮禁用并提示原因——与封面偏移按钮；「阅读设置」弹层承载方向
  RTL/LTR（单页/双页均可用）与缩放/条漫宽度滑杆。
- **UI 去重配额（0.17.x 全站清剿）**：
  - 设置 5 分区卡片配额——常规与外观 3 卡（主题/语言/快捷键）、网络与在线源
    3 卡（代理胶囊组[跟随系统/手动/直连]+请求头 / 提纯引擎 / 在线直读开关）、
    存储与数据 3 卡（书库统计+目录扫描 / 缓存与 LRU 配额单滑杆单清空按钮 /
    备份恢复）、隐私与安全 2 卡（声明+安全自检+Windows 指引+清除痕迹合一 /
    卡死保护与安全模式）。内存预算滑杆、缩略图/页面缓存双按钮、连通性测试
    输入框均已删除。
  - 全站唯一一条在线直读地址栏在「浏览器」页；书库「在线直读」按钮与
    `OnlineImportDialog` 已删除，验证交接（配对桥）迁移为浏览器页常驻卡片，
    状态模块抽至 `src/features/online/handoffState.ts`（StatusPill 复用）。
    顶栏状态胶囊的「上次连通性」改由浏览器地址栏解析结果（成功/失败）写入。
  - 计数单复数：书库头部按 `count === 1` 使用 `library.countBooksOne` /
    `library.countGroupsOne`，英文/西语不再出现 “1 books / 1 libros”。
  - Toast 最多 3 条；批量操作条打开时通过 `--mr-toast-bottom` 把 toast
    抬到胶囊条上方，避免遮挡。
  - 章节自然序使用当前界面 locale 的 `localeCompare`（不再固定 `zh`）；
    MB 统计统一走 `Intl.NumberFormat`，西语显示小数逗号。
  - 书库导入入口唯一对：`[+ 导入文件夹]` `[+ 导入压缩包]`（顶栏）+ 整窗拖拽；
    空状态不再重复渲染第二组导入按钮。
  - 书库渐进窗口：首屏最多 60 张卡，底部哨兵进入视口（600px 提前量）或点击
    `library.loadMore` 按钮再追加 60 张；搜索/来源筛选/合集模式/安全模式变化时
    重置窗口。`BookCard` 用 `IntersectionObserver`（320px 提前量）才请求
    `get_thumbnail`，离屏卡片不占 IPC 与解码。
  - 应用级导入：`DropImportProvider` 挂在路由之外，Tauri drag-drop 在书库/
    阅读器/设置/浏览器都可用；全局 `importGuardRef` 单飞，重叠触发只提示
    六语 `import.busy`。书库按钮通过 `useDropImport` 共用同一实现，导入中
    两个按钮禁用；每个路径逐个 `import_books`，进度卡与失败聚合只有一份
    （多条失败额外提示 `import.moreFailures`），完成后广播书库刷新。
  - 前端不再调用的后端命令（保留注册、契约不变）：`test_online_connection`、
    `import_resolved_pages`、`resolve_online_batch`、`clear_thumbnail_cache`。
- 书库失效态：`BookInfo.missing` 为 true 时书卡显示「文件位置已变更」胶囊，
  单击/双击/回车都打开 `RelocateDialog`，不进入 Reader；详情 Sheet 同步显示
  重新指定/从书库移除两个胶囊按钮。
- `OpenWithBridge` 挂载在 WorkspaceProvider 内：启动与 `open-with-pending` 时
  循环消费 `take_pending_open`，有书则 `nav('/reader/:id')`，安全模式下只回书库。
- 设置 → 存储与数据新增 `DataBackupPanel`：导出/恢复胶囊按钮、保存/打开对话框、
  覆盖确认、偏好白名单应用、关闭旧页签并广播书库/设置刷新。
- 设置 → 关于与维护只有 GitHub 官方更新卡；所有文案六语齐全，不自动检查、
  不自动重启。旧自定义补丁通道不再有 UI 或 IPC 入口。

## 11. 命令契约

只读 / 书库：`scan_library`、`import_books`、`remove_books`、`list_books`、`get_book`、
`get_next_book`、`get_series_books`、`list_entries`、`get_page`、`get_thumbnail`、
`clear_thumbnail_cache`、`clear_temp_cache`、`get_webtoon_layout`、`get_webtoon_tile`、
`get_memory_stats`、`get_dashboard`、`get_reading_log`、`get_reading_by_book`、`set_progress`、
`clear_pages`、`relocate_book`、`take_pending_open`、`export_backup`、`import_backup`、
`get_db_health`、`open_data_dir`、`recover_database_from_backup`。

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
由 `.github/workflows/ci-linux-check.yml`（push/PR 到 `main`、`feat/linux-port`，
ubuntu-22.04）执行 `cargo check --all-targets`、`cargo clippy --all-targets
-- -D warnings`、`cargo test --lib`、`xvfb-run cargo test --test e2e_stage1
--test memory_budget`、前端 `tsc`/`vite build` 与 cargo/npm 审计报告；
`.github/workflows/ci-windows-check.yml` 在 windows-latest 跑同一套单测/集成/
静态 QA 门禁。纯逻辑（GBK 条目名修复、gsettings/kioslaverc 解析、DMABUF
决策表）写成跨平台纯函数，Windows 宿主单测同样覆盖。Dependabot 每周检查
npm / cargo / GitHub Actions 更新。已知 Vite 6.4.3 dev-server 与 React Router
6.x 的 advisory 需要跨大版本升级，审计先作为可见报告（`continue-on-error`），
不阻断打包产物构建。
发版流水线（0.17.0 起）拆分为 `release-windows.yml`（`windows-latest`，NSIS）与
`release-linux-critical.yml`（`ubuntu-22.04`，deb/rpm/AppImage，仅高危补丁标签），
互不阻塞。

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
  `ProxyType=1`）；解析为纯函数跨平台可测。探测命令走
  `spawn_blocking`，不再占用主线程；在线 HTTP transport 同时读取
  `NO_PROXY`/`no_proxy`，命中域名（含子域）、端口或 `*` 时改用独立直连
  agent，代理与直连保留同一超时/重定向/SSRF 校验。CIDR 规则明确忽略，
  不做半吊子解析。
- **唤醒与私有数据（P1.15）**：Linux watchdog 同时读取
  `CLOCK_BOOTTIME`（含 suspend）与 `Instant`；任一跳跃都按唤醒处理并重置
  心跳，避免睡眠前的旧心跳在唤醒瞬间误弹恢复窗。数据/缓存目录在 Unix
  下收紧为 0700，`library.db`/WAL/SHM 与备份解包临时库为 0600。
  书路径必须是 UTF-8（否则 `non-utf8-path` 显式拒绝），命令行
  `args_os` 中的非 UTF-8 参数只记日志并忽略，绝不做 lossy 后误当另一本书。
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
