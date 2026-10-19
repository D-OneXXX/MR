# URL 在线漫画直读（第一阶段：JSON 清单 + 单页 HTML 图集）设计

- 日期：2026-10-19
- 状态：已批准（2026-10-19）
- 适用基线：`065776c`
- 相关文档：[技术文档](../../TECHNICAL.md)、[Sidecar 契约](../../sidecar-api.md)、[冒烟报告](../../smoke-test-report-2026-10-19.md)

> **2026-10-19 修订（已批准）**：在 JSON 清单之外增加“单页 HTML 直铺图集”和“手动请求头”。仍然**不做** EH/ExHentai/JMComic 的站点适配、分页查看器链路（`/g/`、`/s/`）、主图推导、图片切条反混淆（`slice_aid`/MD5）、自动登录、反爬或 JS 渲染。该修订覆盖下文中“只支持 JSON”“完全不做 Cookie”“不解析 HTML”的旧表述。

## 1. 背景与目标

MangaReader 目前只支持本地图片文件夹与 `.zip`/`.cbz`。本阶段新增“URL 在线直读”的第一条合规链路：用户提供一个 **JSON 清单 URL**，应用解析清单、入库，并在现有阅读器中直接阅读图片。

目标：

1. 在线书与本地书共用同一套书库、阅读器、缓存、OCR、翻译工作台与批量队列。
2. 在线页面只在真正需要时下载；已读页面命中 L2 后可离线回翻。
3. 通过 Provider 与 Transport 抽象，为后续 OPDS / Komga / Kavita 留出扩展点。
4. 全程实验功能门控，默认关闭；不改变现有本地书行为。

## 2. 合规边界与非目标

本阶段明确**不做**：

- E-Hentai / ExHentai / JMComic 的站点适配、分页查看器链路（`/g/`、`/s/`）、主图推导、图片切条反混淆（`slice_aid`/MD5）、反爬绕过；
- 自动登录、账号密码、验证码、全局 Cookie jar；
- 执行 JavaScript 或依赖 JS 渲染的页面；
- OPDS / Komga / Kavita（推迟到 1.1）；
- 动漫视频播放（仅保留 `source_type='anime'` 类型值，不加可见路由）；
- 下载整本、离线批量缓存、在线书自动刷新。

允许：

- 用户有权访问的公开 JSON 清单 URL；
- 单页 HTML 直铺图集：从公开/授权页面提取直接图片地址（`img src` / `data-src` / `data-original`），不跟随分页查看器链路；
- 清单/HTML 页面中指向的公网或局域网图片直链；
- 用户为自建/授权网关手动填写 Cookie / Authorization / 自定义请求头；
- 图片请求默认携带页面来源的 `Referer` / `Origin`（用户显式提供的头优先）；
- 通过 HTTP/HTTPS/SOCKS5 代理访问；
- 使用现有 L1/L2 缓存、阅读器、OCR 与翻译链路。

## 3. 已确认决策

| 决策 | 结论 |
|---|---|
| 首期来源 | JSON 清单 + 单页 HTML 直铺图集 |
| 输入格式 | JSON 清单；JSON 解析失败时回退单页 HTML 直接图片提取；不跟随分页查看器 |
| Cookie / 登录 | 仅手动 `onlineHeaders`（用户自建/授权源）；不做自动登录/Cookie jar |
| 请求头 | `onlineHeaders`：JSON 对象或单行 Cookie；图片请求自动带 Referer/Origin |
| 切片反混淆 | 不做 `slice_aid` / MD5 切条还原 |
| 同步 `ImageSource` | 保持同步；页面下载走阻塞 HTTP |
| 阻塞 HTTP 库 | `ureq`（纯阻塞，支持 HTTP CONNECT / SOCKS4/5）；不用 `reqwest::blocking` |
| 在线书 ID | `sha256(规范化清单 URL)` |
| 在线书路径 | 规范化清单 URL 存入 `books.path` |
| 实验开关 | `experimentalOnline`，默认 `false`，镜像 `mr-exp-online` |
| 条漫尺寸 | 清单可选 `width`/`height`；任一页缺失则 `webtoonReady=false` |
| 在线书删除 | 软删/彻底移除；彻底移除不删除远程源 |
| 开关关闭 | 仅隐藏导入入口与设置卡片；已导入在线书仍可读 |
| anime | 只保留类型值，不实现 UI/路由 |

## 4. 架构

### 4.1 模块图

```mermaid
flowchart LR
  UI["Library / Settings / Reader"] -->|invoke| CMD["commands.rs"]
  CMD --> RESOLVE["online::resolve_online_url"]
  CMD --> PAGE["get_page / get_thumbnail / get_webtoon_tile"]
  CMD --> WORK["ocr_region / wb_* / batch"]
  RESOLVE --> PROV["DirectImageProvider"]
  PROV --> HTTP["HttpTransport (ureq)"]
  PAGE --> HANDLE["AppState::source_handle_for_book"]
  WORK --> HANDLE
  HANDLE --> LOCAL["SourceHandle::Local"]
  HANDLE --> ONLINE["SourceHandle::Online"]
  ONLINE --> HTTP
  ONLINE --> PIPE["现有 pipeline + L1/L2 缓存"]
  LOCAL --> PIPE
  CMD --> DB[("SQLite books / page_ocr / trans_cache")]
```

### 4.2 新增模块

```text
src-tauri/src/online/
├── mod.rs        # 公共类型、Provider trait、resolve 调度
├── http.rs       # HttpTransport trait + UreqTransport + 代理/超时/重试/大小限制
└── direct.rs     # DirectImageProvider：JSON 清单解析、PageRef、OnlineSource 构造
```

### 4.3 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| `online/mod.rs` | 规范化 URL、选择 Provider、`OnlineBookMeta`、错误类型 | 具体 HTTP 实现、页面渲染 |
| `online/http.rs` | 发出阻塞 GET、代理、超时、重定向、状态码、大小上限、重试 | 解析清单、写数据库 |
| `online/direct.rs` | 校验 JSON、生成页列表、计算 manifest hash、构造 `OnlineSource` | 书库 UI、缓存淘汰 |
| `source.rs` | `OnlineSource` 实现 `ImageSource`；`SourceHandle` 增加 Online 分支 | 解析清单 |
| `commands.rs` | 新命令、统一按 bookId 打开源、在线预取/删除/条漫布局分支 | 站点解析 |
| `db.rs` | 列迁移、在线 upsert、派生缓存清理、硬删级联 | 网络请求 |
| 前端 | URL 模态框、设置卡片、徽标、条漫门控、删除文案 | 下载与解析逻辑 |

## 5. 数据模型与迁移

### 5.1 books 新增列

```sql
ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local';
ALTER TABLE books ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
```

迁移方式：`pragma_table_info('books')` 检测缺列后执行，幂等；旧库所有行自动成为 `source_type='local'`、`meta_json='{}'`。

`source_type` 取值：

- `local`：本地文件夹 / zip / cbz；
- `generic_manga`：本阶段 JSON 清单直链；
- `anime`：第二阶段预留，不允许通过本阶段命令写入。

### 5.2 `BookInfo` 契约

Rust 与 `src/lib/tauri.ts` 同步增加：

```ts
sourceType: string;      // local | generic_manga | anime | 未来扩展
webtoonReady: boolean;   // 本地书 true；在线书取决于清单尺寸
```

规则：

- `sourceType` 直接读 `books.source_type`。
- `webtoonReady`：
  - `local` → `true`；
  - 在线书 → `meta_json.pages` 全部具有正数 `width` 与 `height` 时为 `true`，否则 `false`；
  - `meta_json` 解析失败 → `webtoonReady=false`，并写 `app.log`，不让整个 `list_books` 失败。
- `meta_json` 不通过 `BookInfo` 暴露；页面 URL 与凭据类信息不进入前端契约。

### 5.3 `meta_json` 形状

```json
{
  "schema": 1,
  "manifestHash": "sha256-hex",
  "fetchedAt": "2026-10-19 10:00:00",
  "pages": [
    { "url": "https://cdn.example.com/001.jpg" },
    { "url": "https://cdn.example.com/002.jpg", "width": 1200, "height": 1800 }
  ]
}
```

- `pages` 顺序即阅读顺序。
- 页面宽高可缺失；缺失或非正数视为未知。
- 不存 Cookie、账号、代理凭据。
- `manifestHash` 覆盖标题与规范化 pages，用于判断是否需要失效派生缓存。

### 5.4 入库与更新

新增 `db::upsert_online_book`：

- `source_type='generic_manga'`；
- 同路径已存在时：
  - `removed=0`（恢复软删）；
  - 更新 `title`、`page_count`、`meta_json`、`updated_at`；
  - **保留** `current_page` 与 `scroll_pct`；
  - 若 `current_page >= page_count`，钳制到 `page_count - 1`；
- 不存在时插入新行。

`db::upsert_book` 保持现有本地签名与行为，内部使用默认 `source_type='local'`、`meta_json='{}'`。

### 5.5 清单变化时的缓存失效

`resolve_online_url` 比较旧 `meta_json.manifestHash` 与新值：

- 相同 → 幂等更新，不清缓存，只刷新 `fetchedAt`。
- 不同：
  1. 若该书存在 `queued/running/paused` 批量任务，返回错误：“清单已变化，请先取消该书的批量任务再更新”；
  2. 清 `page_ocr` 与 `trans_cache`（该书）；
  3. 清 L1 `ImageCache`、L2 `RenderCache`、条漫布局缓存；
  4. 从 `AppState.sources` 常开池移除该书，确保下次读取使用新 `meta_json`；
  5. 保留 `reading_log` 历史；
  6. 按新页数钳制进度。

新增 DB 辅助：`clear_book_derived(conn, book_id)` 删除 `page_ocr` 与 `trans_cache`；不删除 `reading_log`。

## 6. JSON 清单契约

### 6.1 顶层

```json
{
  "version": 1,
  "title": "Example Gallery",
  "pages": ["https://cdn.example.com/001.jpg"]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | 否 | 出现时必须为 `1` |
| `title` | 否 | 字符串；trim 后空则从 URL 路径推导（无可用路径时用 host）；超过 200 字符截断 |
| `pages` | 是 | 数组，1–5000 项 |

### 6.2 页面项

字符串形式：图片绝对 URL。

对象形式：

```json
{ "url": "https://cdn.example.com/002.jpg", "width": 1200, "height": 1800 }
```

规则：

- `url`：绝对 `http/https`，无内嵌 username/password，长度 ≤2048；
- `width`/`height`：可选；两者都是正数才写入 `meta_json`，任一缺失或非正数则两者都不写入，视为尺寸未知；
- 单页 URL 非法 → **整份清单拒绝**，避免半本书入库；
- 重复 URL 允许，保持原顺序。

### 6.3 响应与解析

- 请求上限 2MB；
- 接受 `application/json`、`text/json`、`text/plain` 或缺失 Content-Type；
- 实际以 JSON 解析成功为准；
- 顶层必须是对象，`pages` 必须是数组；
- 解析后生成规范化 pages（仅保留 `url`、有效宽高），并计算：
  - `manifestHash = sha256(serde_json::to_string(规范化 {title, pages}))`；
  - `title` 使用**最终生效标题**（用户提供或从 URL 推导），字段顺序固定为 `title`、`pages`，页面对象字段顺序固定为 `url`、`width`、`height`；
  - `fetchedAt` 不参与哈希，纯元数据变化不会触发缓存失效。
- 页名由 URL path 的文件名推导（百分号解码后）；无文件名时使用 `第 N 页`。

### 6.4 URL 规范化

清单 URL 与页面 URL 均执行：

1. trim；
2. 解析为绝对 URL；
3. scheme 必须为 `http` 或 `https`；
4. 拒绝 username/password；
5. host 小写（由 `url` crate 处理）；
6. 移除 fragment；
7. 保留 query。

`book.id = sha256(canonical_url)`。

### 6.5 单页 HTML 图集（回退解析）

当 `resolve_online_url` 拉取到内容后，先尝试 JSON 清单；失败则尝试单页 HTML 直铺图集：

- 只在**当前这一个 HTML 页面**内提取图片，不跟随 `/g/`、`/s/` 等分页查看器链路，不在后续页面继续抓取；
- 标题：`<title>` 文本，去标签与常见实体，trim 后 ≤200 字符；缺失则从 URL 推导；
- 图片：扫描 `<img>`，按 `data-src` → `data-original` → `src` 的优先级取第一个非空地址；相对路径用 `page_url.join()` 转绝对；仅保留 `http/https`；跳过 `data:`、`blob:`、`javascript:`；按出现顺序去重；1–5000 张；
- 不推断“页面内最大主图”，不执行脚本，不解析分页链接；
- 没有可用图片 → 返回“未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围”；
- 结果写入同一个 `StoredMeta`，`source_type='generic_manga'`；HTML 无法提供可靠宽高，`webtoonReady=false`；
- `manifestHash` 仍按最终标题 + pages 计算；页面 URL 变化会触发缓存失效。

## 7. HTTP 传输

### 7.1 抽象

```rust
pub trait HttpTransport: Send + Sync {
    fn get(
        &self,
        url: &str,
        max_bytes: usize,
        referer: Option<&str>,
    ) -> Result<HttpResponse, OnlineError>;
}

pub struct HttpResponse {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}
```

- 生产实现：`UreqTransport`；构造参数为 `proxy` 与 `onlineHeaders`；
- 测试实现：`FakeTransport`，按 URL/次数返回脚本化响应，不访问网络；
- 语义：`get` 对所有 HTTP 响应返回 `Ok(HttpResponse)`（含 4xx/5xx）；429/5xx 的重试在 transport 内部完成，最终非 2xx 仍由上层转成可读错误；网络失败、超时、重定向超限、响应超限返回 `Err(OnlineError)`；
- 请求头：
  - `onlineHeaders` 为空 → 不附加自定义头；
  - 以 `{` 开头 → 按 JSON 对象解析 `{ "Cookie": "...", "Authorization": "..." }`；
  - 否则视为单行 Cookie 值，等价于 `Cookie: <value>`；
  - 拒绝包含 CR/LF 的值，拒绝 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding`；
  - `referer` 非空时，自动附加 `Referer: <page_url>` 与 `Origin: <scheme://host>`；用户在 `onlineHeaders` 中显式提供的 `Referer`/`Origin` 优先；
  - 清单请求 `referer=None`；图片请求传画廊/HTML 页面 URL。

### 7.2 生产实现

- 库：`ureq`，启用 SOCKS 代理 feature；使用 rustls TLS。
- 代理：
  - 空 → 直连；
  - `http://host:port` / `https://host:port` → HTTP CONNECT；
  - `socks5://host:port` → SOCKS5；
  - 拒绝 URL 内嵌认证信息；无效代理在发起请求前报错。
- 超时：连接 10s，单次请求总计 30s（本阶段不新增设置项）。
- 重定向：最多 5 跳；最终 URL 复验 `http/https`；不接受非 HTTP(S) 重定向。
- User-Agent：固定 `MangaReader/0.1 online-direct`；不伪造浏览器 UA。
- 请求头：默认不发送 Cookie；仅当用户手动配置 `onlineHeaders` 时附加。图片请求自动带页面来源的 `Referer`/`Origin`，用户显式配置优先。
- 响应大小：清单/HTML ≤2MB；页面 ≤32MB；超过立即终止并报错。
- 页面响应：
  - 状态 200；
  - Content-Type 可为 `image/jpeg/png/gif/webp` 或 `application/octet-stream`；
  - 以图片魔数（`image::guess_format`）为准；HTML/JSON/文本一律不进入图片解码路径（HTML 只在图集解析阶段处理）。
- 重试：
  - 429、500、502、503、504 最多重试 2 次；
  - 退避 500ms、1500ms；
  - 若存在 `Retry-After`，采用其秒数，最大 5s；
  - 404/403/401 等 4xx 不重试（408、429 除外）。

### 7.3 错误

新增 `BackendError::Network(String)`，用于网络/HTTP/代理/大小/内容类型错误；最终仍以字符串传给前端。`app.log` 记录 scope、页索引、状态码与主机，不记录完整 query（避免清单 token 泄漏）。

## 8. Provider 与 OnlineSource

### 8.1 公共类型

```rust
pub struct OnlineBookMeta {
    pub canonical_url: String,
    pub source_type: String,   // 本阶段固定 "generic_manga"
    pub title: String,
    pub page_count: usize,
    pub meta_json: String,
}

pub trait OnlineProvider {
    fn can_handle(&self, url: &url::Url) -> bool;
    fn resolve(
        &self,
        http: &dyn HttpTransport,
        url: &url::Url,
    ) -> Result<OnlineBookMeta, BackendError>;
    fn open_source(
        &self,
        meta: &OnlineBookMeta,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
    ) -> Result<OnlineSource, BackendError>;
}
```

本阶段注册 `DirectImageProvider`（JSON）与 `HtmlGalleryProvider`（单页 HTML 直铺图集），由 `online::resolve` 统一拉取一次后先试 JSON、再试 HTML；两者都不匹配则报错。未来 OPDS Provider 可按 scheme/host/路径优先匹配。实现上 `OnlineProvider` 只承担 `resolve`，`OnlineSource` 由 `source.rs` / `AppState` 构造，以避免模块环依赖。

### 8.2 `OnlineSource`

实现现有 `ImageSource`：

```rust
pub struct OnlineSource {
    pages: Vec<PageRef>,
    http: Arc<dyn HttpTransport>,
    permits: Arc<BlockingSemaphore>,
    referer: String,
}
```

- `page_count` = `pages.len()`；
- `read_raw` 调用 `http.get(url, PAGE_MAX_BYTES, Some(&self.referer))`；`referer` 为规范化后的清单/HTML 页面 URL；
- `entry_names` = URL 文件名或 `第 N 页`；
- `read_raw(index)`：
  1. 取页 URL；
  2. 获取并发许可；
  3. `http.get(url, 32MB)`；
  4. 校验状态/大小/魔数；
  5. 返回 `RawPage { bytes, ext }`；
- `OnlineSource` 必须 `Send + Sync`；
- 构造只发生在 `spawn_blocking` 内，`UreqTransport` 不依赖 Tokio runtime。

### 8.3 并发信号量

- `onlineConcurrency` 默认 3，钳制 1–8；
- 每本在线书一个信号量（`Mutex<usize> + Condvar` 或等价阻塞实现）；
- 覆盖所有 `read_raw` 调用：主请求、后台预取、工作台、OCR、批量；
- 页面读取失败必须释放许可（RAII）；
- 图片请求的 `referer` 固定为该书规范化页面 URL；`onlineHeaders` 中的显式 `Referer`/`Origin` 优先。

### 8.4 统一打开源

新增 `AppState::source_handle_for_book(book_id) -> Result<Arc<SourceHandle>, BackendError>`：

1. 查 `books` 行（path、source_type、meta_json）；
2. 命中 16 本常开池则复用；
3. `local` → `SourceHandle::open(path)`；
4. 在线 → 解析 `meta_json`，用 `onlineProxy` + `onlineHeaders` 构造 `UreqTransport`，再把 `path` 作为 `referer`、`online_concurrency as usize` 作为并发数构造 `OnlineSource`；
5. 池满时沿用现有“整体清空重开”策略。

替换以下调用点：

- `get_page`、`get_thumbnail`、`get_webtoon_tile`；
- `list_entries`；
- `ocr_region`；
- `workbench::load_page_png`（改为按 bookId+page 取源）；
- `batch::process_page`；
- `get_webtoon_layout`（在线分支不打开源，只读 meta）。

`SourceHandle::read_partial` 对在线源返回“在线源不支持 header 探测”；`get_webtoon_layout` 的在线分支必须在此之前分支，不能调用它。

## 9. 流程

### 9.1 导入

1. 前端校验非空 URL，调用 `resolve_online_url`。
2. 后端：
   - 规范化 URL；
   - 校验代理与 `onlineHeaders`；
   - `blocking` 中执行 `online::resolve`（先 JSON，失败后单页 HTML）；
   - 成功则写入/恢复书库；
   - 清单哈希变化时执行缓存失效；
   - 返回 `BookInfo`。
3. 前端按用户选择：
   - 直接阅读 → `navigate('/reader/{id}')`；
   - 仅加入书库 → 关闭模态框并刷新。
4. 失败不写库；错误同时展示在模态框与 toast。

### 9.2 阅读

1. `get_page` 先查 L1/L2；命中直接返回。
2. 未命中 → `source_handle_for_book` → `OnlineSource::read_raw`。
3. 下载、校验、pipeline 解码、L2 落盘、L1 写入。
4. 返回 `PageImage`。
5. 在线源后台只预取 +1、+2；前端 `Reader` 的 idle 预取对在线书从 ±3 缩到 +1/+2。

### 9.3 缩略图

- 复用 `get_thumbnail`，实际取第 1 页；L2 键 `(book, 0, edge, edge)`；
- 网络失败返回错误，BookCard 显示占位图标，不阻塞书库列表。

### 9.4 条漫

- `get_webtoon_layout`：
  - 本地：现有 header 解析；
  - 在线：读 `meta_json` 宽高，不联网；
  - 任一页宽高未知 → 返回错误“该在线书籍缺少页面尺寸，无法使用条漫模式”；
- `get_webtoon_tile`：复用现有整页物化 + 切片 + L1/L2；
- `BookInfo.webtoonReady=false` 时：
  - Reader 禁用条漫按钮与“检测到长条画面”建议；
  - 即使绕过 UI，后端仍返回可读错误。

### 9.5 OCR / 工作台 / 批量

- `ocr_region` 使用 `source_handle_for_book`，下载原图后裁剪，与本地书一致。
- 工作台 `wb_detect` / `wb_ocr` / `wb_inpaint` 通过按 bookId 打开源读取原图。
- 批量 `batch::process_page` 通过同一辅助函数读取页面；在线下载受并发信号量限制。
- 翻译缓存、页 OCR 存档、批量任务表沿用现状；在线书与本地书共用。

### 9.6 删除

- “移除”：`removed=1`，保留进度与源 URL；重新导入恢复。
- “彻底移除”：
  - 在线书：跳过文件系统删除，硬删 `books` 并级联清理 `reading_log`、`page_ocr`、`trans_cache`、`batch_jobs`；
  - 同时清 L1/L2/条漫布局，并从 `AppState.sources` 移除该书句柄；
  - `deleted_files=0`。
- 本地书保持现有逻辑。
- 前端右键菜单：
  - 本地：“移除 / 删除源文件…”；
  - 在线：“移除 / 彻底移除…”，确认文案说明不删除远程源。

## 10. Tauri 命令契约

### 10.1 新增

| 命令 | 参数 | 返回 |
|---|---|---|
| `resolve_online_url` | `url: string` | `BookInfo` |
| `test_online_connection` | `url: string` | `{ok, title, pageCount, elapsedMs, message}` |

`resolve_online_url` 行为：

- 仅当 `experimentalOnline=true` 时可用；关闭时返回“在线直读未开启”；
- URL 非法、代理非法、网络失败、清单不合法 → `Err(string)`；
- 成功 → 入库/恢复并返回完整 `BookInfo`；
- 幂等；清单未变不失效缓存；
- 读取已入库在线书不受开关影响。

`test_online_connection` 同样要求 `experimentalOnline=true`；它只解析，不写库。

`test_online_connection` 行为：

- 只解析，不写库；
- 成功返回标题、页数、耗时；
- 失败返回 `Err(string)`，前端展示。
- 请求代理与并发设置来自当前 `Settings`，但单次探测不使用页面并发信号量。

### 10.2 行为变更

| 命令 | 变更 |
|---|---|
| `get_page` | 内部按 bookId 打开本地/在线源；签名不变 |
| `get_thumbnail` | 同上 |
| `get_webtoon_layout` | 在线书读 meta 尺寸；缺尺寸报错 |
| `get_webtoon_tile` | 内部支持在线源 |
| `list_entries` | 在线书由 meta 生成页名；不联网 |
| `ocr_region` | 内部支持在线源 |
| `wb_detect` / `wb_ocr` / `wb_inpaint` | 内部支持在线源 |
| `remove_books` | 在线书跳过物理文件删除 |
| `list_books` / `get_book` | 返回 `sourceType`、`webtoonReady` |

## 11. 前端

### 11.1 契约与镜像

`src/lib/tauri.ts`：

- `BookInfo` 增加 `sourceType`、`webtoonReady`；
- `Settings` 增加 `experimentalOnline`、`onlineProxy`、`onlineConcurrency`、`onlineHeaders`；
- 新增 `OnlineProbe` 类型；
- 新增 API：
  ```ts
  resolveOnlineUrl: (url: string) => invoke<BookInfo>("resolve_online_url", { url }),
  testOnlineConnection: (url: string) => invoke<OnlineProbe>("test_online_connection", { url }),
  ```
- `applySettingsMirror` 写入 `mr-exp-online`；
- 新增 `isOnlineEnabled()`；`onExperimentalChange` 广播已存在，无需新事件。

### 11.2 Library

- 实验开关开启时，搜索栏右侧显示「URL 直读」按钮。
- 新增 `OnlineImportDialog` 组件（玻璃模态框）：
  - URL 输入；
  - 「测试」：调用 `test_online_connection`，展示“可解析 · 标题 · N 页”或错误；
  - 「仅加入书库」：调用 `resolve_online_url`，成功后关闭并刷新；
  - 「解析并直接阅读」：成功后导航到阅读器；
  - 解析中禁用按钮，显示 loading；
  - Esc / 遮罩关闭。
- 模态框不预览远程封面，避免额外网络请求；入库后由 BookCard 拉取第一页缩略图。

### 11.3 BookCard / DetailSheet / 删除

- `sourceType !== "local"`：
  - 封面右上角显示 `URL` 徽标；
  - 详情 sheet 显示来源类型；
  - 右键菜单显示「彻底移除…」；
  - ConfirmDialog 文案说明“只删除书库记录与本地缓存，不删除远程源”；
  - 调用 `removeBooks(ids, true)`，由后端跳过物理删除。
- 本地书 UI 不变。

### 11.4 Reader

- 从 `book.webtoonReady` 控制条漫选项与自动建议。
- `book.sourceType !== "local"` 时：
  - idle 预取只遍历当前页到 `page + 2`，不向后请求历史页；
  - 条漫布局失败时提示并回退单页；
  - 其余单/双页、缩放、选区 OCR、进度逻辑不变。

### 11.5 Settings

- 「实验性功能」新增「在线 URL 直读（JSON 清单 + HTML 图集）」开关：
  - 复用现有 `setExperimental` 持久化与广播；
  - 默认关闭。
- 新增「在线源与网络」卡片（仅开关开启时显示）：
  - 代理地址：空 / `http://` / `https://` / `socks5://`；
  - 并发数：1–8，默认 3；
  - 自定义请求头：JSON 对象或单行 Cookie；输入框与说明“仅用于你自建/有权访问的网关；会明文保存在本机”；
  - 测试 URL + 「测试连通性」；
  - 说明：支持 JSON 清单与单页 HTML 直铺图集；不支持分页查看器、图片切条反混淆、自动登录或 JS 渲染。
- 不新增 JM 域名或账号密码字段；`onlineHeaders` 只接受手动请求头。
- **Status 页面**：使用现有 `getSettings` 新增只读卡片“在线直读”，展示开关状态、代理是否配置（只显示 scheme/host，不回显完整凭据）、并发数；不新增全局测试按钮，连通性测试由 URL 模态框或设置卡片中的测试 URL 触发。

### 11.6 App.tsx

当前没有独立在线路由，因此不新增 `App.tsx` 路由守卫或死路由。门控落在：

- Library 的 URL 按钮；
- Settings 的在线卡片；
- Reader 的预取/条漫能力。

已导入在线书在开关关闭后仍可阅读。

## 12. 设置持久化

`Settings` 新增字段：

| 字段 | 默认 | 持久化键 |
|---|---|---|
| `experimentalOnline` | `false` | `experimental_online` |
| `onlineProxy` | `""` | `online_proxy` |
| `onlineConcurrency` | `3` | `online_concurrency` |
| `onlineHeaders` | `""` | `online_headers` |

同步更新：

- `Settings` 结构体与 `Default`；
- `hydrate_settings`；
- `settings_persist_pairs`；
- `DEFAULT_FORM`；
- 持久化键覆盖测试；
- `mr-exp-online` 镜像。

`onlineConcurrency` 在保存时钳制 1–8；`onlineProxy` 在保存时立即校验：空合法，非空必须是合法 `http/https/socks5` URL 且无内嵌凭据，否则 `set_settings` 返回错误。`onlineHeaders` 在保存时校验：JSON 分支必须是字符串键值对象；单行 Cookie 分支不得含 CR/LF；禁止 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding`。`onlineProxy`、`onlineConcurrency` 或 `onlineHeaders` 变化时清空 `AppState.sources` 常开池（本地与在线都重开），确保新配置立即生效。

## 13. 错误处理

| 场景 | 用户可见行为 | 后端 |
|---|---|---|
| URL 非 http/https / 带凭据 / 超长 | toast + 模态框内联错误 | 拒绝，不联网 |
| 代理非法 | 设置页/导入错误 | 拒绝，不联网 |
| 网络失败/超时 | “内容获取失败：…” | 不写库 |
| JSON 与 HTML 都无法解析 | “未找到可读图片；分页查看器或依赖 JS 的页面不在支持范围” | 不写库 |
| pages 空 / 超 5000 | 明确提示 | 不写库 |
| 任一页 URL 非法 | 指出第几页并拒绝整份清单 | 不写库 |
| 重复导入且未变化 | “已在书库，清单未变化” | 幂等，不失效缓存 |
| 清单变化但有活跃批量任务 | “请先取消批量任务” | 拒绝更新 |
| 单页 404/403 | “第 N 页加载失败：HTTP 404” | 当前页失败；L1/L2 不受影响 |
| 单页 429/5xx | 重试后仍失败则报错 | 2 次退避 |
| 图片 URL 返回 HTML/非图片/超 32MB | “URL 返回的不是图片/响应过大” | 拒绝，写日志 |
| 离线 | 已缓存页可读；未缓存页报网络错误 | — |

所有错误最终为字符串；前端继续使用 `toastErr(command, error)`。

## 14. 安全与隐私

- 仅允许 `http/https`；拒绝 `file:`、`data:`、`ftp:` 等。
- 拒绝 URL 内嵌 username/password；代理同样拒绝内嵌凭据。
- 不执行页面脚本；HTML 只做单页直铺图片提取，不跟随分页查看器、不推断主图。
- 默认不发送 Cookie；仅当用户手动配置 `onlineHeaders` 时附加。`onlineHeaders` 可能含 Cookie/Authorization，明文存于本机 SQLite，设置页必须提示风险；不读取浏览器 Cookie，不做自动登录或全局 Cookie jar。
- UA 固定为 `MangaReader/0.1 online-direct`；`Referer`/`Origin` 只由当前页面 URL 派生，用户显式提供的同名头优先；不伪造其他站点来源。
- 重定向 ≤5 跳，最终 URL 复验 scheme。
- 响应大小上限：清单/HTML 2MB、页面 32MB。
- 页面以魔数验证，Content-Type 仅作提示。
- 允许私网/loopback 地址（为用户自建源预留）；清单/HTML URL 与页面 URL 均视为用户信任输入。UI 在 URL 模态框中提示“只导入你信任的地址”。
- `app.log` 不记录完整 query/token；错误信息不回显 `onlineHeaders`。
- `meta_json` 不含 Cookie、账号、代理密码。
- 不做 JMComic 切条反混淆（`slice_aid`/MD5）；不做 EH/ExHentai 的 `/g/`/`/s/` 查看器链路。
- 在线书硬删不触碰远程源。

## 15. 测试矩阵

### 15.1 Rust 单元/集成

| 模块 | 用例 |
|---|---|
| URL/清单 | 规范化、fragment 移除、拒绝 userinfo/非 http(s)、字符串/对象页、标题回退、空/超 5000、非法页 URL、宽高只给一项、manifest hash 稳定性 |
| HTML 图集 | `<title>` 提取；`data-src`/`data-original`/`src` 优先级；相对路径 `join`；去重；非图片/data URI 跳过；无图片报错；只含查看器链接的页面不跟随 |
| `OnlineSource` | page_count/entry_names；read_raw 正确 URL + referer；Content-Type + 魔数；32MB 上限；429/5xx 重试；4xx 不重试；信号量并发不超过设置 |
| `HttpTransport` | 本地 stub server：200/404/429/503、重定向、超大响应、超时、代理解析（http/socks5）、自定义 header、Referer/Origin 自动附加与显式覆盖；不访问公网 |
| DB | 旧库迁移；在线 upsert；软删恢复；进度保留/钳制；清单变化清 `page_ocr/trans_cache`；有活跃批量任务时拒绝；硬删级联 |
| 命令辅助 | `source_handle_for_book` 本地/在线分支；在线 `read_partial` 返回不支持；`remove_books` 在线跳过物理删除 |
| 回归 | 现有 36 项测试全绿；本地源与缓存行为不变 |

### 15.2 前端

- `npx tsc --noEmit` 零错误；
- `npm run build` 通过；
- 手动验收：
  1. 开启实验开关，导入本地 stub 清单；
  2. 直接阅读，翻页，回翻命中 L2；
  3. 选区 OCR / 工作台载入在线页；
  4. 条漫：带宽高清单可用；缺宽高时按钮禁用；
  5. 移除与彻底移除；
  6. 关闭开关后已导入书仍可读，URL 入口消失；
  7. 无效代理/无效 URL/404 页的错误提示。

### 15.3 不测试

- 真实 EH/JM/ExHentai 站点；
- 真实公网图片站；
- 自动登录/反爬/JS 渲染页面；
- 分页查看器链路与图片切条反混淆；
- OPDS/Komga/Kavita；
- 动漫播放。

## 16. 已知限制与后续

- 页面 URL 过期后，需要重新导入同一 URL 刷新；第一版不提供单独“刷新清单”按钮。
- 没有原始页面字节缓存；清空 L2 后需重新下载。
- 阅读器 L2 存的是按视口尺寸渲染后的 JPEG；选区 OCR、工作台、批量读取原图时会再次下载该页（不走 L2），因此这些操作可能产生额外网络请求。
- 条漫要求清单提供宽高；HTML 图集没有可靠宽高，因此只能单/双页。
- 单页 HTML 图集不支持分页查看器、JS 渲染页面或主图推断；这类页面会返回“未找到可读图片”。
- `onlineHeaders` 明文保存，可能过期；用户需要自行更新。
- 在线批量预翻译逐页下载，速度受源站与 `onlineConcurrency` 限制。
- 1.1：OPDS / Komga / Kavita Provider（Basic/API Token，不使用浏览器 Cookie）。
- 第二阶段：`source_type='anime'` 的视频路由与播放器，不在本 spec 范围。

## 17. 文档与契约同步

实现时必须同步：

- `docs/TECHNICAL.md`：
  - 数据模型：新增 `source_type` / `meta_json`；
  - 设置表：新增四个字段；
  - 命令契约：新增两个命令、变更命令列表；
  - 架构：`online/` 模块与同步阻塞 HTTP 说明；
  - 已知限制；
- `src-tauri/src/lib.rs` 数据契约；
- `src/lib/tauri.ts`；
- `README.md` 功能/文档入口（如果新增用户可见入口）；
- 设计/实施文档索引（如需要）。

## 18. 验收标准

1. 旧库启动后自动迁移，本地书 `sourceType='local'`、`webtoonReady=true`，阅读/缓存/工作台无回归。
2. 开启实验开关后可导入合规 JSON 清单；导入后书库出现封面与 `URL` 徽标。
3. 单页/双页阅读正常；已读页二次打开命中 L2（断网可读）。
4. 选区 OCR、工作台载入、批量队列对在线页可用。
5. 清单含宽高时条漫可用；缺失时禁用并给出明确提示。
6. 重复导入同一清单幂等；清单变化时按规则失效派生缓存并保留进度。
7. “彻底移除”在线书不删除远程源，级联清理 DB 与缓存。
8. `cargo test`、`tsc --noEmit`、`npm run build` 全绿；自动化测试不访问公网。
9. 不出现 EH/JM 站点适配、分页查看器链路、切条反混淆、自动登录；HTML 仅做单页直铺图片提取；`onlineHeaders` 仅接受手动请求头。
10. 单页 HTML 直铺图集可导入；`data-src`/`data-original`/相对路径、自定义请求头、自动 Referer/Origin 生效；只有分页查看器链接的页面返回“未找到可读图片”。

## 附录 A：URL 规范化示例

| 输入 | 规范化结果 |
|---|---|
| ` HTTPS://Example.COM/gallery/123?x=1#frag ` | `https://example.com/gallery/123?x=1` |
| `http://example.com/a//b/` | `http://example.com/a//b/`（不合并路径） |
| `http://user:pass@example.com/a` | 拒绝（内嵌凭据） |
| `file:///C:/a.jpg` | 拒绝（scheme） |

## 附录 B：类型草图

```rust
pub struct PageRef {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub struct DirectManifest {
    pub version: Option<u32>,
    pub title: Option<String>,
    pub pages: Vec<PageRef>,
}

pub struct OnlineProbe {
    pub ok: bool,
    pub title: String,
    pub page_count: u32,
    pub elapsed_ms: u64,
    pub message: String,
}
```
