# URL 在线漫画直读（JSON 清单）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MangaReader 增加第一条合规的 URL 在线直读链路：导入 JSON 清单、复用现有阅读器/缓存/OCR/工作台，并保持本地书行为不变。

**Architecture:** 保持现有同步 `ImageSource` 不变，新增 `online` 模块（Provider + 阻塞 `ureq` Transport + JSON 清单解析）；在线页面在 `read_raw` 中按需下载，渲染结果继续走现有 L1/L2。数据库给 `books` 增加 `source_type` / `meta_json`；命令层统一按 `bookId` 打开本地或在线源。

**Tech Stack:** Tauri 2、Rust 1.77+、ureq 2（默认 rustls，启用 json + socks-proxy）、url 2、percent-encoding 2、React 19、TypeScript 5.8。

**Spec:** [docs/superpowers/specs/2026-10-19-online-direct-reader-design.md](../specs/2026-10-19-online-direct-reader-design.md)

## Global Constraints

- 只实现 JSON 清单型直链图片集；禁止 EH/ExHentai/JMComic、Cookie、登录、HTML/JS 嗅探、反混淆或反爬绕过。
- 允许的 `source_type`：`local`、`generic_manga`、`anime`（仅预留，不写入）。
- 在线页面下载只允许 `http/https`；拒绝 URL 内嵌 username/password。
- 阻塞 HTTP 只用 `ureq`；不得引入 `reqwest::blocking`。
- `Settings` / `BookInfo` / 命令返回值继续使用 serde camelCase 契约；Rust 字段 snake_case。
- 自动测试不得访问公网；HTTP 测试只连 `127.0.0.1` 的临时 stub server。
- 每个任务结束前必须运行该任务列出的验证命令，并单独提交。
- 现有本地书、缓存、阅读器、OCR、工作台、批量队列行为不得回归；既有 36 项测试必须保持全绿。
- 不新增独立在线路由，不在 `App.tsx` 增加死守卫；开关门控落在 Library 入口、Settings 卡片、Reader 条漫能力。
- 所有新文案使用中文；不添加 emoji；不修改冻结功能池。

---

## File Structure

```text
src-tauri/
├── Cargo.toml                       # ureq/url/percent-encoding
├── src/
│   ├── lib.rs                       # Settings、BookInfo、OnlineProbe、mod online、命令注册
│   ├── source.rs                    # BackendError::Network、OnlineSource、SourceHandle::Online
│   ├── state.rs                     # AppState::source_handle_for_book
│   ├── db.rs                        # source_type/meta_json、在线 upsert、派生清理
│   ├── commands.rs                  # resolve/test、统一源打开、预取/删除/条漫分支
│   ├── workbench.rs                 # load_page_png_for_book
│   ├── batch.rs                     # 在线页读取
│   └── online/
│       ├── mod.rs                   # PageRef/StoredMeta/OnlineError/URL 工具/信号量
│       ├── http.rs                  # HttpTransport + UreqTransport
│       └── direct.rs                # DirectImageProvider
├── tests/                           # 现有测试保持通过
src/
├── lib/tauri.ts                     # 类型、API、mr-exp-online 镜像
├── pages/Library.tsx                # URL 入口、删除语义
├── pages/Settings.tsx               # 实验开关、在线卡片、测试连通性
├── pages/Status.tsx                 # 只读在线状态卡片
├── pages/Reader.tsx                 # webtoonReady 门控、在线预取窗口
└── components/
    ├── OnlineImportDialog.tsx       # 新组件
    ├── BookCard.tsx                 # URL 徽标
    ├── DetailSheet.tsx              # URL 徽标
    └── ui.css                       # 徽标/在线弹窗样式
docs/
├── TECHNICAL.md                     # 契约、数据模型、设置、命令、限制同步
└── superpowers/plans/2026-10-19-online-direct-reader.md
```

---

## Task 1: Settings 契约与依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/commands.rs`（既有测试模块）

**Interfaces:**
- Consumes: 无。
- Produces: `Settings.experimental_online: bool`、`Settings.online_proxy: String`、`Settings.online_concurrency: u32`；持久化键 `experimental_online` / `online_proxy` / `online_concurrency`。

- [ ] **Step 1: 在 Cargo.toml 增加依赖**

在 `[dependencies]` 的 `reqwest` 行之后加入：

```toml
# 在线源：同步阻塞 HTTP + URL 规范化 + 文件名解码
url = "2"
percent-encoding = "2"
ureq = { version = "2", features = ["json", "socks-proxy"] }
```

- [ ] **Step 2: 先写失败的持久化覆盖测试**

在 `src-tauri/src/commands.rs` 的 `persist_pairs_cover_every_hydrated_key` 测试键列表中加入：

```rust
            "experimental_online",
            "online_proxy",
            "online_concurrency",
```

- [ ] **Step 3: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml persist_pairs_cover_every_hydrated_key -v`  
Expected: FAIL，提示 persist 清单缺少 `experimental_online`。

- [ ] **Step 4: 修改 Settings 结构体与默认值**

在 `src-tauri/src/lib.rs` 的 `Settings` 字段末尾（`wb_inpaint` 之后）加入：

```rust
    /// 实验性功能：URL 在线直读（JSON 清单）。
    pub experimental_online: bool,
    /// 在线源 HTTP 代理（空=直连；http/https/socks5）。
    pub online_proxy: String,
    /// 单本在线书页面下载并发（1-8）。
    pub online_concurrency: u32,
```

在 `impl Default for Settings` 的 `wb_inpaint` 之后加入：

```rust
            experimental_online: false,
            online_proxy: String::new(),
            online_concurrency: 3,
```

- [ ] **Step 5: 在 hydrate_settings 中回读**

在 `hydrate_settings` 的 `wb_inpaint` 分支之后加入：

```rust
    if let Some(v) = get("experimental_online") {
        s.experimental_online = v == "true" || v == "1";
    }
    if let Some(v) = get("online_proxy") {
        s.online_proxy = v;
    }
    if let Some(v) = get("online_concurrency").and_then(|v| v.parse::<u32>().ok()) {
        s.online_concurrency = v.clamp(1, 8);
    }
```

- [ ] **Step 6: 在 settings_persist_pairs 中持久化**

在 `src-tauri/src/commands.rs` 的 `settings_persist_pairs` 末尾（`wb_inpaint` 之后）加入：

```rust
        ("experimental_online", if s.experimental_online { "true" } else { "false" }.to_string()),
        ("online_proxy", s.online_proxy.clone()),
        ("online_concurrency", s.online_concurrency.to_string()),
```

- [ ] **Step 7: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml persist_pairs_cover_every_hydrated_key -v`  
Expected: PASS。

- [ ] **Step 8: 运行全量后端测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 既有 36 项全绿。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat: 增加在线直读设置契约"
```

---

## Task 2: 在线公共类型、URL 工具与阻塞信号量

**Files:**
- Modify: `src-tauri/src/lib.rs`（`mod online;`）
- Modify: `src-tauri/src/source.rs`（`BackendError::Network`）
- Create: `src-tauri/src/online/mod.rs`
- Test: `src-tauri/src/online/mod.rs`

**Interfaces:**
- Consumes: `BackendError`。
- Produces:
  - `PageRef { url, width, height }`
  - `StoredMeta { schema, manifest_hash, fetched_at, pages }`
  - `OnlineError`
  - `normalize_url(&str) -> Result<Url, BackendError>`
  - `title_from_url(&Url) -> String`
  - `page_name(&PageRef, usize) -> String`
  - `validate_proxy(&str) -> Result<(), String>`
  - `BlockingSemaphore::new(usize) -> Self`、`acquire() -> SemaphoreGuard`

- [ ] **Step 1: 先写失败测试**

创建 `src-tauri/src/online/mod.rs`，只放测试与空声明，写入：

```rust
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_strips_fragment_and_rejects_file() {
        let u = normalize_url(" HTTPS://Example.COM/a?x=1#frag ").unwrap();
        assert_eq!(u.as_str(), "https://example.com/a?x=1");
        assert!(normalize_url("file:///C:/a.jpg").is_err());
        assert!(normalize_url("http://user:pass@example.com/a").is_err());
    }

    #[test]
    fn title_falls_back_to_path_then_host() {
        let u = url::Url::parse("https://example.com/gallery/123/").unwrap();
        assert_eq!(title_from_url(&u), "123");
        let u = url::Url::parse("https://example.com/").unwrap();
        assert_eq!(title_from_url(&u), "example.com");
    }

    #[test]
    fn page_name_uses_filename_or_index() {
        let p = PageRef { url: "https://x/a/001.jpg".into(), width: None, height: None };
        assert_eq!(page_name(&p, 0), "001.jpg");
        let p = PageRef { url: "https://x/".into(), width: None, height: None };
        assert_eq!(page_name(&p, 2), "第 3 页");
    }

    #[test]
    fn proxy_validation_accepts_empty_and_socks5() {
        assert!(validate_proxy("").is_ok());
        assert!(validate_proxy("socks5://127.0.0.1:1080").is_ok());
        assert!(validate_proxy("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy("ftp://127.0.0.1:21").is_err());
        assert!(validate_proxy("http://user:pass@127.0.0.1:7890").is_err());
    }

    #[test]
    fn semaphore_limits_concurrency() {
        let sem = Arc::new(BlockingSemaphore::new(1));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let sem = sem.clone();
            let active = active.clone();
            let peak = peak.clone();
            handles.push(std::thread::spawn(move || {
                let _guard = sem.acquire();
                let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::tests -v`  
Expected: 编译失败，`PageRef` / `normalize_url` 等未定义。

- [ ] **Step 3: 注册模块与错误变体**

在 `src-tauri/src/lib.rs` 的 `mod ocr;` 附近加入：

```rust
mod online;
```

在 `src-tauri/src/source.rs` 的 `BackendError` 中加入：

```rust
    #[error("网络错误：{0}")]
    Network(String),
```

- [ ] **Step 4: 实现 online/mod.rs**

在测试模块之前写入完整实现：

```rust
//! 在线源公共类型、URL 规范化、阻塞信号量与错误。

use std::sync::{Condvar, Mutex};

use crate::source::BackendError;

pub const MANIFEST_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const PAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PAGES: usize = 5000;
pub const ONLINE_UA: &str = "MangaReader/0.1 online-direct";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PageRef {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMeta {
    pub schema: u32,
    pub manifest_hash: String,
    pub fetched_at: String,
    pub pages: Vec<PageRef>,
}

#[derive(Debug, thiserror::Error)]
pub enum OnlineError {
    #[error("网络错误：{0}")]
    Network(String),
    #[error("代理无效：{0}")]
    Proxy(String),
    #[error("响应过大（上限 {0} 字节）")]
    TooLarge(usize),
}

impl From<OnlineError> for BackendError {
    fn from(e: OnlineError) -> Self {
        BackendError::Network(e.to_string())
    }
}

pub fn normalize_url(raw: &str) -> Result<url::Url, BackendError> {
    let raw = raw.trim();
    if raw.len() > 2048 {
        return Err(BackendError::Msg("URL 过长（上限 2048 字符）".into()));
    }
    let mut u = url::Url::parse(raw)
        .map_err(|e| BackendError::Msg(format!("URL 无效：{e}")))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(BackendError::Msg("仅支持 http/https URL".into()));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(BackendError::Msg("URL 不能包含用户名或密码".into()));
    }
    u.set_fragment(None);
    Ok(u)
}

pub fn title_from_url(u: &url::Url) -> String {
    u.path_segments()
        .and_then(|s| s.filter(|x| !x.is_empty()).last())
        .map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| u.host_str().unwrap_or("在线漫画").to_string())
}

pub fn page_name(p: &PageRef, index: usize) -> String {
    url::Url::parse(&p.url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|s| s.filter(|x| !x.is_empty()).last())
                .map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("第 {} 页", index + 1))
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn validate_proxy(raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(());
    }
    let u = url::Url::parse(raw).map_err(|e| format!("代理地址无效：{e}"))?;
    if !matches!(u.scheme(), "http" | "https" | "socks5") {
        return Err("代理仅支持 http/https/socks5".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("代理地址不能包含用户名或密码".into());
    }
    Ok(())
}

pub struct BlockingSemaphore {
    limit: usize,
    used: Mutex<usize>,
    cv: Condvar,
}

impl BlockingSemaphore {
    pub fn new(limit: usize) -> Self {
        Self {
            limit: limit.clamp(1, 8),
            used: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    pub fn acquire(&self) -> SemaphoreGuard<'_> {
        let mut used = self.used.lock().unwrap();
        while *used >= self.limit {
            used = self.cv.wait(used).unwrap();
        }
        *used += 1;
        SemaphoreGuard { sem: self }
    }

    fn release(&self) {
        let mut used = self.used.lock().unwrap();
        *used = used.saturating_sub(1);
        self.cv.notify_one();
    }
}

pub struct SemaphoreGuard<'a> {
    sem: &'a BlockingSemaphore,
}

impl Drop for SemaphoreGuard<'_> {
    fn drop(&mut self) {
        self.sem.release();
    }
}
```

- [ ] **Step 5: 运行 online 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::tests -v`  
Expected: 5 个测试 PASS。

- [ ] **Step 6: 运行全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 既有测试 + 新增 5 项全绿。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/source.rs src-tauri/src/online/mod.rs
git commit -m "feat: 增加在线源公共类型与 URL 工具"
```

---

## Task 3: 阻塞 HTTP Transport

**Files:**
- Create: `src-tauri/src/online/http.rs`
- Modify: `src-tauri/src/online/mod.rs`（`pub mod http;` 已存在）
- Modify: `src-tauri/src/commands.rs`（`set_settings` 校验/钳制/清源池）
- Test: `src-tauri/src/online/http.rs`

**Interfaces:**
- Consumes: `OnlineError`、`validate_proxy`、`ONLINE_UA`。
- Produces:
  - `HttpTransport::get(&self, url: &str, max_bytes: usize) -> Result<HttpResponse, OnlineError>`
  - `HttpResponse { status: u16, final_url: String, content_type: Option<String>, body: Vec<u8> }`
  - `UreqTransport::new(proxy: &str) -> Result<Self, OnlineError>`

- [ ] **Step 1: 先写失败的 transport 测试**

创建 `src-tauri/src/online/http.rs`，先写：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    fn spawn_server(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            for (status, ct, body) in responses {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    429 => "Too Many Requests",
                    503 => "Service Unavailable",
                    _ => "Error",
                };
                let headers = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                s.write_all(headers.as_bytes()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        (format!("http://{addr}/page"), h)
    }

    #[test]
    fn reads_200_and_preserves_404_status() {
        let (url, h) = spawn_server(vec![
            (200, "image/png", b"png-bytes".to_vec()),
            (404, "text/plain", b"missing".to_vec()),
        ]);
        let t = UreqTransport::new("").unwrap();
        let r = t.get(&url, 1024).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"png-bytes");
        let r = t.get(&url, 1024).unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, b"missing");
        h.join().unwrap();
    }

    #[test]
    fn retries_429_then_succeeds() {
        let (url, h) = spawn_server(vec![
            (429, "text/plain", b"slow".to_vec()),
            (200, "image/png", b"ok".to_vec()),
        ]);
        let t = UreqTransport::new("").unwrap();
        let r = t.get(&url, 1024).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"ok");
        h.join().unwrap();
    }

    #[test]
    fn rejects_body_larger_than_limit() {
        let (url, h) = spawn_server(vec![(200, "image/png", vec![0u8; 16])]);
        let t = UreqTransport::new("").unwrap();
        assert!(matches!(t.get(&url, 8), Err(OnlineError::TooLarge(8))));
        h.join().unwrap();
    }

    #[test]
    fn rejects_invalid_proxy() {
        assert!(UreqTransport::new("ftp://127.0.0.1:21").is_err());
        assert!(UreqTransport::new("http://user:pass@127.0.0.1:7890").is_err());
    }

    fn spawn_redirect() -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            s.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            let (mut s2, _) = listener.accept().unwrap();
            let _ = s2.read(&mut buf);
            s2.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            )
            .unwrap();
        });
        (format!("http://{addr}/start"), h)
    }

    #[test]
    fn follows_redirect_and_reports_final_url() {
        let (url, h) = spawn_redirect();
        let t = UreqTransport::new("").unwrap();
        let r = t.get(&url, 1024).unwrap();
        assert_eq!(r.status, 200);
        assert!(r.final_url.ends_with("/final"));
        h.join().unwrap();
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::http::tests -v`  
Expected: 编译失败，`UreqTransport` / `HttpResponse` 未定义。

- [ ] **Step 3: 注册 http 子模块**

在 `src-tauri/src/online/mod.rs` 顶部加入：

```rust
pub mod http;
```

- [ ] **Step 4: 实现 transport**

在测试模块之前写入：

```rust
//! 阻塞 HTTP Transport：ureq + 代理 + 重试 + 响应大小上限。

use std::io::Read;
use std::time::Duration;

use crate::online::{validate_proxy, OnlineError, ONLINE_UA};

pub struct HttpResponse {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub trait HttpTransport: Send + Sync {
    fn get(&self, url: &str, max_bytes: usize) -> Result<HttpResponse, OnlineError>;
}

pub struct UreqTransport {
    agent: ureq::Agent,
}

struct RawResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    body: Vec<u8>,
    retry_after_s: Option<u64>,
}

impl UreqTransport {
    pub fn new(proxy: &str) -> Result<Self, OnlineError> {
        validate_proxy(proxy).map_err(OnlineError::Proxy)?;
        let mut builder = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirects(5)
            .user_agent(ONLINE_UA);
        if !proxy.trim().is_empty() {
            let p = ureq::Proxy::new(proxy.trim())
                .map_err(|e| OnlineError::Proxy(e.to_string()))?;
            builder = builder.proxy(p);
        }
        Ok(Self { agent: builder.build() })
    }

    fn get_once(&self, url: &str, max_bytes: usize) -> Result<RawResponse, OnlineError> {
        match self.agent.get(url).call() {
            Ok(resp) => read_response(resp, max_bytes),
            Err(ureq::Error::Status(_, resp)) => read_response(resp, max_bytes),
            Err(ureq::Error::Transport(t)) => Err(OnlineError::Network(t.to_string())),
        }
    }
}

fn read_response(resp: ureq::Response, max_bytes: usize) -> Result<RawResponse, OnlineError> {
    let status = resp.status();
    let final_url = resp.get_url().to_string();
    if !url::Url::parse(&final_url)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false)
    {
        return Err(OnlineError::Network("重定向到非 HTTP(S) URL".into()));
    }
    let content_type = resp.header("content-type").map(str::to_string);
    let retry_after_s = resp
        .header("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let mut body = Vec::new();
    resp.into_reader()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| OnlineError::Network(e.to_string()))?;
    if body.len() > max_bytes {
        return Err(OnlineError::TooLarge(max_bytes));
    }
    Ok(RawResponse { status, final_url, content_type, body, retry_after_s })
}

fn should_retry(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

impl HttpTransport for UreqTransport {
    fn get(&self, url: &str, max_bytes: usize) -> Result<HttpResponse, OnlineError> {
        for attempt in 0..=2u32 {
            match self.get_once(url, max_bytes) {
                Ok(raw) if should_retry(raw.status) && attempt < 2 => {
                    let wait_ms = raw
                        .retry_after_s
                        .map(|s| s * 1000)
                        .unwrap_or(if attempt == 0 { 500 } else { 1500 })
                        .min(5000);
                    std::thread::sleep(Duration::from_millis(wait_ms));
                }
                Ok(raw) => {
                    return Ok(HttpResponse {
                        status: raw.status,
                        final_url: raw.final_url,
                        content_type: raw.content_type,
                        body: raw.body,
                    });
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("retry loop always returns")
    }
}
```

- [ ] **Step 4: 在 set_settings 中校验代理/钳制并发/清源池**

在 `src-tauri/src/commands.rs` 的 `set_settings` 改为：

```rust
#[tauri::command]
pub async fn set_settings(
    state: State<'_, Arc<AppState>>,
    mut settings: Settings,
) -> Result<(), String> {
    crate::online::validate_proxy(&settings.online_proxy)?;
    settings.online_concurrency = settings.online_concurrency.clamp(1, 8);

    let budget = (settings.cache_budget_mb.max(16) as u64) * 1024 * 1024;
    state.cache.set_budgets(budget);

    let old = state.settings.lock().clone();
    let online_conn_changed = old.online_proxy != settings.online_proxy
        || old.online_concurrency != settings.online_concurrency;

    let persist = settings_persist_pairs(&settings);
    let res = state.db.with(|conn| {
        for (k, v) in persist {
            db::set_setting(conn, k, &v).map_err(err)?;
        }
        Ok(())
    });
    *state.settings.lock() = settings;
    if online_conn_changed {
        state.sources.lock().clear();
    }
    match res {
        Ok(()) => Ok(()),
        Err(e) if e == "数据库尚未初始化" => Ok(()),
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 5: 运行 transport 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::http::tests -v`  
Expected: 5 个测试 PASS。

- [ ] **Step 6: 运行全量后端测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/online/http.rs src-tauri/src/online/mod.rs src-tauri/src/commands.rs
git commit -m "feat: 增加在线源阻塞 HTTP transport"
```

---

## Task 4: JSON 清单 Provider

**Files:**
- Create: `src-tauri/src/online/direct.rs`
- Modify: `src-tauri/src/online/mod.rs`（`pub mod direct;` 已存在）
- Test: `src-tauri/src/online/direct.rs`

**Interfaces:**
- Consumes: `HttpTransport`、`PageRef`、`StoredMeta`、`MAX_PAGES`、`MANIFEST_MAX_BYTES`、`normalize_url`、`title_from_url`、`truncate_chars`。
- Produces:
  - `OnlineBookMeta { canonical_url, source_type, title, page_count, meta_json }`
  - `DirectImageProvider::resolve(&dyn HttpTransport, &str) -> Result<OnlineBookMeta, BackendError>`

- [ ] **Step 1: 先写失败的清单测试**

创建 `src-tauri/src/online/direct.rs`，先写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::http::{HttpResponse, HttpTransport};
    use crate::online::{OnlineError, StoredMeta};

    struct FakeTransport {
        body: Vec<u8>,
    }

    impl HttpTransport for FakeTransport {
        fn get(&self, _url: &str, _max: usize) -> Result<HttpResponse, OnlineError> {
            Ok(HttpResponse {
                status: 200,
                final_url: "http://example.com/manifest.json".into(),
                content_type: Some("application/json".into()),
                body: self.body.clone(),
            })
        }
    }

    fn resolve(body: &str) -> Result<OnlineBookMeta, crate::source::BackendError> {
        DirectImageProvider.resolve(
            &FakeTransport { body: body.as_bytes().to_vec() },
            "http://example.com/manifest.json",
        )
    }

    #[test]
    fn resolves_string_and_object_pages() {
        let meta = resolve(
            r#"{"version":1,"title":"Test","pages":["http://x/1.jpg",{"url":"http://x/2.jpg","width":800,"height":1200}]}"#,
        )
        .unwrap();
        assert_eq!(meta.title, "Test");
        assert_eq!(meta.page_count, 2);
        assert_eq!(meta.source_type, "generic_manga");
        let stored: StoredMeta = serde_json::from_str(&meta.meta_json).unwrap();
        assert_eq!(stored.pages.len(), 2);
        assert_eq!(stored.pages[0].width, None);
        assert_eq!(stored.pages[1].width, Some(800));
        assert_eq!(stored.pages[1].height, Some(1200));
    }

    #[test]
    fn title_falls_back_and_truncates() {
        let meta = resolve(r#"{"pages":["http://x/1.jpg"]}"#).unwrap();
        assert_eq!(meta.title, "manifest.json");
        let long = "a".repeat(300);
        let meta = resolve(&format!(r#"{{"title":"{long}","pages":["http://x/1.jpg"]}}"#)).unwrap();
        assert_eq!(meta.title.chars().count(), 200);
    }

    #[test]
    fn rejects_bad_shapes_and_urls() {
        assert!(resolve(r#"{"pages":[]}"#).is_err());
        assert!(resolve(r#"{"version":2,"pages":["http://x/1.jpg"]}"#).is_err());
        assert!(resolve(r#"{"pages":["file:///x.jpg"]}"#).is_err());
        assert!(resolve(r#"{"pages":[{"url":"http://user:pass@x/1.jpg"}]}"#).is_err());
    }

    #[test]
    fn hash_is_stable_for_same_manifest() {
        let a = resolve(r#"{"title":"T","pages":["http://x/1.jpg"]}"#).unwrap();
        let b = resolve(r#"{"title":"T","pages":["http://x/1.jpg"]}"#).unwrap();
        let sa: StoredMeta = serde_json::from_str(&a.meta_json).unwrap();
        let sb: StoredMeta = serde_json::from_str(&b.meta_json).unwrap();
        assert_eq!(sa.manifest_hash, sb.manifest_hash);
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::direct::tests -v`  
Expected: 编译失败，`DirectImageProvider` 未定义。

- [ ] **Step 3: 注册 direct 子模块并实现 direct.rs**

在 `src-tauri/src/online/mod.rs` 顶部加入：

```rust
pub mod direct;
```

在 `src-tauri/src/online/direct.rs` 的测试模块之前写入：

```rust
//! JSON 清单型直链图片集 Provider。

use sha2::{Digest, Sha256};

use crate::online::http::HttpTransport;
use crate::online::{
    normalize_url, title_from_url, truncate_chars, PageRef, StoredMeta,
    MANIFEST_MAX_BYTES, MAX_PAGES,
};
use crate::source::BackendError;

#[derive(Debug, Clone)]
pub struct OnlineBookMeta {
    pub canonical_url: String,
    pub source_type: String,
    pub title: String,
    pub page_count: usize,
    pub meta_json: String,
}

#[derive(Debug, serde::Deserialize)]
struct RawManifest {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    title: Option<String>,
    pages: Vec<RawPageEntry>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum RawPageEntry {
    Url(String),
    Obj {
        url: String,
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
    },
}

#[derive(serde::Serialize)]
struct HashInput<'a> {
    title: &'a str,
    pages: &'a [PageRef],
}

pub struct DirectImageProvider;

impl DirectImageProvider {
    pub fn can_handle(&self, url: &url::Url) -> bool {
        matches!(url.scheme(), "http" | "https")
    }

    pub fn resolve(
        &self,
        http: &dyn HttpTransport,
        raw_url: &str,
    ) -> Result<OnlineBookMeta, BackendError> {
        let url = normalize_url(raw_url)?;
        if !self.can_handle(&url) {
            return Err(BackendError::Msg("仅支持 http/https 清单 URL".into()));
        }
        let resp = http.get(url.as_str(), MANIFEST_MAX_BYTES)?;
        if !(200..300).contains(&resp.status) {
            return Err(BackendError::Network(format!(
                "清单 HTTP {}：{}",
                resp.status,
                resp.final_url
            )));
        }
        let raw: RawManifest = serde_json::from_slice(&resp.body)
            .map_err(|e| BackendError::Msg(format!("清单格式不符：{e}")))?;
        if let Some(v) = raw.version {
            if v != 1 {
                return Err(BackendError::Msg(format!("不支持的清单版本：{v}")));
            }
        }
        if raw.pages.is_empty() {
            return Err(BackendError::Msg("清单 pages 不能为空".into()));
        }
        if raw.pages.len() > MAX_PAGES {
            return Err(BackendError::Msg(format!(
                "清单页数超过上限 {MAX_PAGES}"
            )));
        }
        let mut pages = Vec::with_capacity(raw.pages.len());
        for (i, entry) in raw.pages.into_iter().enumerate() {
            let (raw_page, width, height) = match entry {
                RawPageEntry::Url(url) => (url, None, None),
                RawPageEntry::Obj { url, width, height } => (url, width, height),
            };
            let page_url = normalize_url(&raw_page)
                .map_err(|e| BackendError::Msg(format!("第 {} 页 URL 非法：{e}", i + 1)))?;
            let (width, height) = match (width, height) {
                (Some(w), Some(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
                _ => (None, None),
            };
            pages.push(PageRef {
                url: page_url.to_string(),
                width,
                height,
            });
        }
        let title = raw
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| title_from_url(&url));
        let title = truncate_chars(&title, 200);
        let hash = {
            let mut h = Sha256::new();
            h.update(
                serde_json::to_string(&HashInput { title: &title, pages: &pages })
                    .map_err(|e| BackendError::Msg(format!("清单序列化失败：{e}")))?
                    .as_bytes(),
            );
            hex::encode(h.finalize())
        };
        let stored = StoredMeta {
            schema: 1,
            manifest_hash: hash,
            fetched_at: crate::db::now_str(),
            pages,
        };
        let meta_json = serde_json::to_string(&stored)
            .map_err(|e| BackendError::Msg(format!("清单元数据序列化失败：{e}")))?;
        Ok(OnlineBookMeta {
            canonical_url: url.to_string(),
            source_type: "generic_manga".into(),
            title,
            page_count: stored.pages.len(),
            meta_json,
        })
    }
}
```

注意：`resp` 的 `content_type` 与 `final_url` 字段用于错误信息；`OnlineError` 已通过 `?` 转成 `BackendError`。

- [ ] **Step 4: 运行 direct 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online::direct::tests -v`  
Expected: 4 个测试 PASS。

- [ ] **Step 5: 运行全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/online/direct.rs src-tauri/src/online/mod.rs
git commit -m "feat: 增加 JSON 清单在线 Provider"
```

---

## Task 5: 数据库迁移、BookInfo 与在线书入库

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/db.rs`、`src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `StoredMeta`。
- Produces:
  - `books.source_type` / `books.meta_json`
  - `BookRow.source_type` / `BookRow.meta_json`
  - `BookInfo.source_type` / `BookInfo.webtoon_ready`
  - `db::upsert_online_book`
  - `db::clear_book_derived`
  - `db::has_active_batch`
  - `commands::webtoon_ready`

- [ ] **Step 1: 先写失败的 DB 测试**

在 `db.rs` 的 `mod tests` 中加入：

```rust
    #[test]
    fn online_columns_migrate_and_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books(
                id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
                page_count INTEGER NOT NULL DEFAULT 0, current_page INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO books(id,path,title,page_count,current_page) VALUES('b1','p/b1','旧书',10,2);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        let old = get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(old.source_type, "local");
        assert_eq!(old.meta_json, "{}");

        let meta = r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg"}]}"#;
        upsert_online_book(&conn, "o1", "http://x/list.json", "在线", 3, "generic_manga", meta)
            .unwrap();
        let row = get_book(&conn, "o1").unwrap().unwrap();
        assert_eq!(row.source_type, "generic_manga");
        assert_eq!(row.meta_json, meta);
        assert_eq!(row.page_count, 3);
    }

    #[test]
    fn online_upsert_restores_and_clamps_progress() {
        let conn = mem();
        upsert_online_book(&conn, "o1", "http://x/a", "A", 5, "generic_manga", "{}").unwrap();
        set_progress(&conn, "o1", 4, None).unwrap();
        soft_remove_books(&conn, &["o1".into()]).unwrap();
        upsert_online_book(&conn, "o1", "http://x/a", "A2", 2, "generic_manga", "{}").unwrap();
        let row = get_book(&conn, "o1").unwrap().unwrap();
        assert_eq!(row.title, "A2");
        assert_eq!(row.page_count, 2);
        assert_eq!(row.current_page, 1);
        assert_eq!(row.source_type, "generic_manga");
        assert!(list_books(&conn, None).unwrap().iter().any(|b| b.id == "o1"));
    }

    #[test]
    fn clear_derived_and_active_batch() {
        let conn = mem();
        upsert_online_book(&conn, "o1", "http://x/a", "A", 2, "generic_manga", "{}").unwrap();
        save_page_ocr(&conn, "o1", 0, 10, 10, "[]", "[]").unwrap();
        cache_put(&conn, "k", "t", "o1").unwrap();
        assert!(has_active_batch(&conn, "o1").unwrap() == false);
        clear_book_derived(&conn, "o1").unwrap();
        assert!(get_page_ocr(&conn, "o1", 0).unwrap().is_none());
        assert!(cache_get(&conn, "k").unwrap().is_none());

        let id = batch_create(&conn, "o1", "A", 2).unwrap();
        batch_set_state(&conn, id, "running", "").unwrap();
        assert!(has_active_batch(&conn, "o1").unwrap());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests -v`  
Expected: 编译失败，字段/函数未定义。

- [ ] **Step 3: 修改 schema 与迁移**

在 `db.rs` 的 `CREATE TABLE books` 中加入：

```sql
            source_type TEXT NOT NULL DEFAULT 'local',
            meta_json TEXT NOT NULL DEFAULT '{}',
```

在 `migrate_book_columns` 的 `scroll_pct` 检查之后加入：

```rust
    let books_has_source: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='source_type'",
        [],
        |r| r.get(0),
    )?;
    if books_has_source == 0 {
        conn.execute(
            "ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'",
            [],
        )?;
    }
    let books_has_meta: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='meta_json'",
        [],
        |r| r.get(0),
    )?;
    if books_has_meta == 0 {
        conn.execute(
            "ALTER TABLE books ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'",
            [],
        )?;
    }
```

- [ ] **Step 4: 扩展 BookRow 与 SELECT**

`BookRow` 加入：

```rust
    pub source_type: String,
    pub meta_json: String,
```

`row_to_book` 在 `scroll_pct` 之后加入：

```rust
        source_type: row.get(7)?,
        meta_json: row.get(8)?,
```

把 `get_book` 与 `list_books` 的 SELECT 列表改为：

```sql
SELECT id, path, title, page_count, current_page, updated_at, scroll_pct, source_type, meta_json
```

两处 `list_books` 的 WHERE/ORDER 不变。

- [ ] **Step 5: 实现 upsert_online_book / clear_book_derived / has_active_batch**

在 `upsert_book` 之后加入：

```rust
/// 在线书入库/恢复：保留进度与条漫偏移；页数缩小时钳制 current_page。
pub fn upsert_online_book(
    conn: &Connection,
    id: &str,
    path: &str,
    title: &str,
    page_count: u32,
    source_type: &str,
    meta_json: &str,
) -> Result<(), BackendError> {
    let now = now_str();
    conn.execute(
        "INSERT INTO books(id, path, title, page_count, updated_at, source_type, meta_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, title=excluded.title,
            page_count=excluded.page_count, updated_at=excluded.updated_at,
            removed=0, source_type=excluded.source_type, meta_json=excluded.meta_json,
            current_page=MIN(books.current_page, excluded.page_count - 1)",
        params![id, path, title, page_count as i64, now, source_type, meta_json],
    )?;
    Ok(())
}

/// 清单变化时清掉该书的派生缓存（页 OCR 与翻译缓存）。
pub fn clear_book_derived(conn: &Connection, id: &str) -> Result<(), BackendError> {
    conn.execute("DELETE FROM page_ocr WHERE book_id=?1", params![id])?;
    conn.execute("DELETE FROM trans_cache WHERE book_id=?1", params![id])?;
    Ok(())
}

/// 是否存在 queued/running/paused 批量任务。
pub fn has_active_batch(conn: &Connection, book_id: &str) -> Result<bool, BackendError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM batch_jobs WHERE book_id=?1 AND state IN ('queued','running','paused')",
        params![book_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}
```

同时把 `upsert_book` 的 SQL 列与冲突更新补上 `source_type='local'`、`meta_json='{}'`，避免旧本地路径留下默认空值：

```rust
        "INSERT INTO books(id, path, title, page_count, updated_at, source_type, meta_json)
         VALUES (?1, ?2, ?3, ?4, ?5, 'local', '{}')
         ON CONFLICT(id) DO UPDATE SET
            path=excluded.path, title=excluded.title,
            page_count=excluded.page_count, updated_at=excluded.updated_at,
            removed=0, source_type='local', meta_json='{}'",
```

- [ ] **Step 6: 扩展 BookInfo 与 to_book_info**

在 `lib.rs` 的 `BookInfo` 中加入：

```rust
    /// local | generic_manga | anime（预留）。
    pub source_type: String,
    /// 条漫是否可用：本地 true；在线取决于清单尺寸。
    pub webtoon_ready: bool,
```

在 `commands.rs` 的 `to_book_info` 之前加入：

```rust
fn webtoon_ready(r: &db::BookRow) -> bool {
    if r.source_type == "local" {
        return true;
    }
    match serde_json::from_str::<crate::online::StoredMeta>(&r.meta_json) {
        Ok(meta) => {
            !meta.pages.is_empty()
                && meta
                    .pages
                    .iter()
                    .all(|p| p.width.unwrap_or(0) > 0 && p.height.unwrap_or(0) > 0)
        }
        Err(e) => {
            crate::logging::log_error(
                "online_meta",
                &format!("书籍 {} 元数据损坏：{e}", r.id),
            );
            false
        }
    }
}
```

在 `to_book_info` 的**第一行**加入（必须在移动 `r` 字段之前计算）：

```rust
    let webtoon_ready = webtoon_ready(&r);
```

然后在 `to_book_info` 返回值的字段列表末尾加入：

```rust
        source_type: r.source_type,
        webtoon_ready,
```

- [ ] **Step 7: 加入 commands 侧测试**

在 `commands.rs` 测试模块加入：

```rust
    #[test]
    fn book_info_webtoon_ready_depends_on_dims() {
        let local = db::BookRow {
            id: "l".into(), path: "p".into(), title: "L".into(),
            page_count: 1, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "local".into(), meta_json: "{}".into(),
        };
        assert!(to_book_info(local).webtoon_ready);

        let online = db::BookRow {
            id: "o".into(), path: "http://x/a".into(), title: "O".into(),
            page_count: 2, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200},{"url":"http://x/2.jpg"}]}"#.into(),
        };
        assert!(!to_book_info(online).webtoon_ready);

        let online_ok = db::BookRow {
            id: "o2".into(), path: "http://x/b".into(), title: "O2".into(),
            page_count: 1, current_page: 0, updated_at: String::new(),
            scroll_pct: -1.0, source_type: "generic_manga".into(),
            meta_json: r#"{"schema":1,"manifestHash":"h","fetchedAt":"t","pages":[{"url":"http://x/1.jpg","width":800,"height":1200}]}"#.into(),
        };
        assert!(to_book_info(online_ok).webtoon_ready);
    }
```

- [ ] **Step 8: 运行 DB 与 commands 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests commands::tests -v`  
Expected: 全部 PASS。

- [ ] **Step 9: 运行全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 全绿。

- [ ] **Step 10: 提交**

```bash
git add src-tauri/src/db.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat: 增加在线书数据模型与迁移"
```

---

## Task 6: OnlineSource、SourceHandle 与按书打开源

**Files:**
- Modify: `src-tauri/src/source.rs`
- Modify: `src-tauri/src/state.rs`
- Test: `src-tauri/src/source.rs`

**Interfaces:**
- Consumes: `PageRef`、`BlockingSemaphore`、`HttpTransport`、`PAGE_MAX_BYTES`、`StoredMeta`。
- Produces:
  - `OnlineSource::new(pages, http, concurrency)`
  - `SourceHandle::open_online(url, pages, http, concurrency)`
  - `AppState::source_handle_for_book(book_id) -> Result<Arc<SourceHandle>, BackendError>`

- [ ] **Step 1: 先写 OnlineSource 测试**

在 `source.rs` 的测试模块加入：

```rust
    struct FakeHttp {
        body: Vec<u8>,
    }

    impl crate::online::http::HttpTransport for FakeHttp {
        fn get(
            &self,
            _url: &str,
            _max_bytes: usize,
        ) -> Result<crate::online::http::HttpResponse, crate::online::OnlineError> {
            Ok(crate::online::http::HttpResponse {
                status: 200,
                final_url: "http://x/1.png".into(),
                content_type: Some("image/png".into()),
                body: self.body.clone(),
            })
        }
    }

    fn tiny_png() -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        buf
    }

    #[test]
    fn online_source_reads_pages_and_names() {
        let pages = vec![
            crate::online::PageRef {
                url: "http://x/001.png".into(),
                width: Some(1),
                height: Some(1),
            },
            crate::online::PageRef {
                url: "http://x/002.png".into(),
                width: None,
                height: None,
            },
        ];
        let src = super::OnlineSource::new(
            pages,
            std::sync::Arc::new(FakeHttp { body: tiny_png() }),
            2,
        );
        use super::ImageSource;
        assert_eq!(src.page_count().unwrap(), 2);
        assert_eq!(src.entry_names().unwrap(), vec!["001.png", "002.png"]);
        let raw = src.read_raw(0).unwrap();
        assert_eq!(raw.ext, "png");
        assert!(raw.bytes.starts_with(b"\x89PNG"));
        assert!(src.read_raw(2).is_err());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml source::tests -v`  
Expected: 编译失败，`OnlineSource` 未定义。

- [ ] **Step 3: 实现 OnlineSource 与 HandleKind::Online**

在 `source.rs` 顶部加入：

```rust
use std::sync::Arc;

use crate::online::http::HttpTransport;
use crate::online::{BlockingSemaphore, PageRef, PAGE_MAX_BYTES};
```

在 `SourceHandle` 之前加入：

```rust
/// 在线图片源：页列表来自 meta_json；read_raw 按需下载单页。
pub struct OnlineSource {
    pages: Vec<PageRef>,
    http: Arc<dyn HttpTransport>,
    permits: Arc<BlockingSemaphore>,
}

impl OnlineSource {
    pub fn new(pages: Vec<PageRef>, http: Arc<dyn HttpTransport>, concurrency: usize) -> Self {
        Self {
            pages,
            http,
            permits: Arc::new(BlockingSemaphore::new(concurrency)),
        }
    }
}

impl ImageSource for OnlineSource {
    fn page_count(&self) -> Result<usize, BackendError> {
        Ok(self.pages.len())
    }

    fn entry_names(&self) -> Result<Vec<String>, BackendError> {
        Ok(self
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| crate::online::page_name(p, i))
            .collect())
    }

    fn read_raw(&self, index: usize) -> Result<RawPage, BackendError> {
        let page = self
            .pages
            .get(index)
            .ok_or_else(|| BackendError::Msg(format!("页码越界：{index}")))?;
        let _guard = self.permits.acquire();
        let resp = self.http.get(&page.url, PAGE_MAX_BYTES)?;
        if !(200..300).contains(&resp.status) {
            let msg = format!("第 {} 页 HTTP {}", index + 1, resp.status);
            crate::logging::log_error("online_page", &msg);
            return Err(BackendError::Network(msg));
        }
        let fmt = match image::guess_format(&resp.body) {
            Ok(f) => f,
            Err(_) => {
                let msg = format!("第 {} 页返回的不是图片", index + 1);
                crate::logging::log_error("online_page", &msg);
                return Err(BackendError::Network(msg));
            }
        };
        let ext = match fmt {
            image::ImageFormat::Jpeg => "jpg",
            image::ImageFormat::Png => "png",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::WebP => "webp",
            _ => {
                return Err(BackendError::Network(format!(
                    "第 {} 页图片格式不支持",
                    index + 1
                )))
            }
        };
        Ok(RawPage { bytes: resp.body, ext: ext.into() })
    }
}
```

`HandleKind` 增加：

```rust
    Online(OnlineSource),
```

`SourceHandle` 增加：

```rust
    pub fn open_online(
        canonical_url: String,
        pages: Vec<PageRef>,
        http: Arc<dyn HttpTransport>,
        concurrency: usize,
    ) -> Result<Self, BackendError> {
        Ok(Self {
            path: PathBuf::from(canonical_url),
            kind: HandleKind::Online(OnlineSource::new(pages, http, concurrency)),
        })
    }
```

`page_count`、`entry_names`、`read_raw`、`read_partial` 增加 Online 分支：

```rust
            HandleKind::Online(s) => s.page_count(),
            HandleKind::Online(s) => s.entry_names(),
            HandleKind::Online(s) => s.read_raw(index),
            HandleKind::Online(_) => Err(BackendError::Msg(
                "在线源不支持 header 探测".into(),
            )),
```

- [ ] **Step 4: 实现 AppState::source_handle_for_book**

在 `state.rs` 的 `source_handle` 之后加入：

```rust
    /// 按 bookId 打开本地或在线源，并复用 16 本常开池。
    pub fn source_handle_for_book(
        &self,
        book_id: &str,
    ) -> Result<Arc<SourceHandle>, crate::source::BackendError> {
        {
            let pool = self.sources.lock();
            if let Some(h) = pool.get(book_id) {
                return Ok(h.clone());
            }
        }
        let (path, source_type, meta_json) = self
            .db
            .with(|conn| {
                crate::db::get_book(conn, book_id)
                    .map_err(|e| e.to_string())?
                    .map(|b| (b.path, b.source_type, b.meta_json))
                    .ok_or_else(|| "书籍不存在".to_string())
            })
            .map_err(crate::source::BackendError::Msg)?;

        let handle = if source_type == "local" {
            Arc::new(SourceHandle::open(std::path::Path::new(&path))?)
        } else if source_type == "generic_manga" {
            let stored: crate::online::StoredMeta = serde_json::from_str(&meta_json)
                .map_err(|e| {
                    crate::source::BackendError::Msg(format!("在线书元数据损坏：{e}"))
                })?;
            let s = self.settings.lock().clone();
            let transport = crate::online::http::UreqTransport::new(&s.online_proxy)?;
            Arc::new(SourceHandle::open_online(
                path,
                stored.pages,
                Arc::new(transport),
                s.online_concurrency,
            )?)
        } else if source_type == "anime" {
            return Err(crate::source::BackendError::Msg(
                "第二阶段视频源尚未实现".into(),
            ));
        } else {
            return Err(crate::source::BackendError::Msg(format!(
                "未知来源类型：{source_type}"
            )));
        };

        let mut pool = self.sources.lock();
        if pool.len() >= 16 {
            pool.clear();
        }
        pool.insert(book_id.to_string(), handle.clone());
        Ok(handle)
    }
```

- [ ] **Step 5: 运行 source 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml source::tests -v`  
Expected: 新测试 PASS，既有 source 测试 PASS。

- [ ] **Step 6: 检查编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`  
Expected: 通过（允许既有 warning）。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/source.rs src-tauri/src/state.rs
git commit -m "feat: 接入在线 ImageSource 与按书打开源"
```

---

## Task 7: 命令、预取、删除与工作台/批量接线

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/workbench.rs`
- Modify: `src-tauri/src/batch.rs`
- Test: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `DirectImageProvider`、`UreqTransport`、`StoredMeta`、`source_handle_for_book`、`db::upsert_online_book`、`db::clear_book_derived`、`db::has_active_batch`。
- Produces:
  - `resolve_online_url(url) -> BookInfo`
  - `test_online_connection(url) -> OnlineProbe`
  - 所有阅读/OCR/工作台/批量路径支持在线书
  - 在线书硬删不触碰远程源

- [ ] **Step 1: 先写失败的删除辅助测试**

在 `commands.rs` 测试模块加入：

```rust
    #[test]
    fn online_source_path_is_never_deleted() {
        let url = "https://example.com/gallery/1";
        assert_eq!(delete_source_if_local(url, "generic_manga").unwrap(), false);
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online_source_path_is_never_deleted -v`  
Expected: 编译失败，`delete_source_if_local` 未定义。

- [ ] **Step 3: 增加 OnlineProbe 与命令注册**

在 `lib.rs` 的数据契约区加入：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineProbe {
    pub ok: bool,
    pub title: String,
    pub page_count: u32,
    pub elapsed_ms: u64,
    pub message: String,
}
```

在 `generate_handler!` 末尾加入：

```rust
            commands::resolve_online_url,
            commands::test_online_connection
```

- [ ] **Step 4: 实现 resolve/test 命令与删除辅助**

在 `commands.rs` 顶部对 `crate` 的 `use` 导入列表中加入 `OnlineProbe`。

在 `set_settings` 之前加入：

```rust
/// 解析 JSON 清单并入库/恢复；不改变已存在书的阅读进度。
#[tauri::command]
pub async fn resolve_online_url(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<BookInfo, String> {
    let st = state.inner().clone();
    let (row, changed) = blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let http = crate::online::http::UreqTransport::new(&s.online_proxy)?;
        let meta = crate::online::direct::DirectImageProvider.resolve(&http, &url)?;
        let id = db::book_id_for_path(&meta.canonical_url);
        let old = st
            .db
            .with(|conn| db::get_book(conn, &id).map_err(|e| e.to_string()))
            .map_err(BackendError::Msg)?;
        let old_hash = old.as_ref().and_then(|b| {
            serde_json::from_str::<crate::online::StoredMeta>(&b.meta_json)
                .ok()
                .map(|m| m.manifest_hash)
        });
        let new_hash = serde_json::from_str::<crate::online::StoredMeta>(&meta.meta_json)
            .map_err(|e| BackendError::Msg(format!("内部元数据错误：{e}")))?
            .manifest_hash;
        let changed = old_hash.as_deref() != Some(new_hash.as_str());
        if changed && old.is_some() {
            let active = st
                .db
                .with(|conn| db::has_active_batch(conn, &id).map_err(|e| e.to_string()))
                .map_err(BackendError::Msg)?;
            if active {
                return Err(BackendError::Msg(
                    "清单已变化，请先取消该书的批量任务再更新".into(),
                ));
            }
        }
        st.db
            .with(|conn| {
                db::upsert_online_book(
                    conn,
                    &id,
                    &meta.canonical_url,
                    &meta.title,
                    meta.page_count as u32,
                    &meta.source_type,
                    &meta.meta_json,
                )
                .map_err(|e| e.to_string())
            })
            .map_err(BackendError::Msg)?;
        if changed && old.is_some() {
            st.db
                .with(|conn| db::clear_book_derived(conn, &id).map_err(|e| e.to_string()))
                .map_err(BackendError::Msg)?;
        }
        let row = st
            .db
            .with(|conn| db::get_book(conn, &id).map_err(|e| e.to_string()))
            .map_err(BackendError::Msg)?
            .ok_or_else(|| BackendError::Msg("在线书入库后回读失败".into()))?;
        Ok((row, changed))
    })
    .await?;

    if changed {
        state.cache.remove_book(&row.id);
        state.render.remove_book(&row.id);
        state.webtoon_layouts.lock().remove(&row.id);
        state.sources.lock().remove(&row.id);
    }
    Ok(to_book_info(row))
}

/// 只测试 JSON 清单 + 代理连通性，不写库。
#[tauri::command]
pub async fn test_online_connection(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<OnlineProbe, String> {
    let st = state.inner().clone();
    blocking(move || {
        let s = st.settings.lock().clone();
        if !s.experimental_online {
            return Err(BackendError::Msg("在线直读未开启".into()));
        }
        let http = crate::online::http::UreqTransport::new(&s.online_proxy)?;
        let t0 = Instant::now();
        let meta = crate::online::direct::DirectImageProvider.resolve(&http, &url)?;
        Ok(OnlineProbe {
            ok: true,
            title: meta.title,
            page_count: meta.page_count as u32,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            message: "可解析".into(),
        })
    })
    .await
}

/// 本地书删除源文件；在线书返回 false（不触碰远程源）。
fn delete_source_if_local(path: &str, source_type: &str) -> Result<bool, std::io::Error> {
    if source_type != "local" {
        return Ok(false);
    }
    let p = PathBuf::from(path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p)?;
        Ok(true)
    } else if p.is_file() {
        std::fs::remove_file(&p)?;
        Ok(true)
    } else {
        Ok(false)
    }
}
```

- [ ] **Step 5: 修改 remove_books 的硬删循环**

把 `remove_books` 硬删分支（`if delete_source_files` 内部）改为：

```rust
        if delete_source_files {
            let mut hard: Vec<String> = Vec::new();
            for id in &ids {
                let Some(b) = db::get_book(&conn, id)? else { continue };
                match delete_source_if_local(&b.path, &b.source_type) {
                    Ok(deleted) => {
                        if deleted {
                            deleted_files += 1;
                        }
                        hard.push(id.clone());
                    }
                    Err(e) => errors.push(format!("{}：{e}", b.path)),
                }
            }
            let n = db::hard_delete_books(&conn, &hard)?;
            Ok::<_, BackendError>((n, deleted_files, errors))
        } else {
            let n = db::soft_remove_books(&conn, &ids)?;
            Ok::<_, BackendError>((n, 0usize, errors))
        }
```

在 `remove_books` 结束后的清理循环中加入：

```rust
        state.sources.lock().remove(id);
```

即与 `state.cache.remove_book(id)` 并列。

- [ ] **Step 6: 修改 get_page 与预取**

把 `get_page` 中读取 `(path, title)` 改为：

```rust
    let (title, is_online) = state
        .db
        .with(|conn| {
            db::get_book(conn, &book_id)
                .map_err(err)?
                .map(|b| (b.title, b.source_type != "local"))
                .ok_or_else(|| "书籍不存在".to_string())
        })?;
```

把阻塞闭包中的：

```rust
        let handle = st.source_handle(&book, &task_path)?;
```

改为：

```rust
        let handle = st.source_handle_for_book(&book)?;
```

删除 `task_path` 变量；把最后一行改为：

```rust
    prefetch_neighbors(&state, &book_id, is_online, index, w, h);
```

把 `prefetch_neighbors` 的签名改为：

```rust
fn prefetch_neighbors(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
    is_online: bool,
    index: u32,
    w: u32,
    h: u32,
) {
```

其内部改为先取一次句柄：

```rust
    let st = state.inner().clone();
    let book = book_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let handle = match st.source_handle_for_book(&book) {
            Ok(h) => h,
            Err(_) => return,
        };
        let page_count = handle.page_count().unwrap_or(0) as i64;
        let (mw, mh) = (
            Some(w).filter(|v| *v > 0),
            Some(h).filter(|v| *v > 0),
        );
        let dirs: &[i64] = if is_online { &[1, 2] } else { &[1, -1, 2, -2] };
        for d in dirs {
            let target = index as i64 + d;
            if target < 0 || target >= page_count {
                continue;
            }
            let t = target as u32;
            if st.cache.get_page(&book, t, w, h).is_some() {
                continue;
            }
            let key = (book.clone(), t, w, h);
            if st.prefetching.lock().contains(&key) {
                continue;
            }
            st.prefetching.lock().insert(key.clone());
            let page = st
                .render
                .get(&book, t, w, h)
                .map(assembled_page)
                .unwrap_or_else(|| {
                    handle.read_raw(t as usize).and_then(|raw| {
                        let p = pipeline::render_raw(&raw, mw, mh)?;
                        st.render.put(&book, t, w, h, &p.bytes);
                        Ok(p)
                    })
                });
            if let Ok(p) = page {
                st.cache.put_page(&book, t, w, h, p);
            }
            st.prefetching.lock().remove(&key);
        }
    });
```

- [ ] **Step 7: 修改 get_thumbnail 与 get_webtoon_tile**

两处都删除 `path`/`task_path`，把 `st.source_handle(&book, &path)` / `(&book, &task_path)` 改为 `st.source_handle_for_book(&book)`；错误日志仍使用 `title`。

- [ ] **Step 8: 修改 get_webtoon_layout**

在函数开头读取整行：

```rust
    let row = state
        .db
        .with(|conn| db::get_book(conn, &book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    if row.source_type != "local" {
        let meta: crate::online::StoredMeta = serde_json::from_str(&row.meta_json)
            .map_err(|e| format!("在线书元数据损坏：{e}"))?;
        if meta.pages.is_empty()
            || meta
                .pages
                .iter()
                .any(|p| p.width.unwrap_or(0) == 0 || p.height.unwrap_or(0) == 0)
        {
            return Err("该在线书籍缺少页面尺寸，无法使用条漫模式".into());
        }
        return Ok(meta
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| PageDim {
                index: i as u32,
                width: p.width.unwrap(),
                height: p.height.unwrap(),
            })
            .collect());
    }
```

本地分支删除再次查 path 的代码，完整替换函数如下：

```rust
#[tauri::command]
pub async fn get_webtoon_layout(
    state: State<'_, Arc<AppState>>,
    book_id: String,
) -> Result<Vec<PageDim>, String> {
    if let Some(cached) = state.webtoon_layouts.lock().get(&book_id) {
        return Ok(cached
            .iter()
            .enumerate()
            .map(|(i, (w, h))| PageDim {
                index: i as u32,
                width: *w,
                height: *h,
            })
            .collect());
    }
    let row = state
        .db
        .with(|conn| db::get_book(conn, &book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    if row.source_type != "local" {
        let meta: crate::online::StoredMeta = serde_json::from_str(&row.meta_json)
            .map_err(|e| format!("在线书元数据损坏：{e}"))?;
        if meta.pages.is_empty()
            || meta
                .pages
                .iter()
                .any(|p| p.width.unwrap_or(0) == 0 || p.height.unwrap_or(0) == 0)
        {
            return Err("该在线书籍缺少页面尺寸，无法使用条漫模式".into());
        }
        return Ok(meta
            .pages
            .iter()
            .enumerate()
            .map(|(i, p)| PageDim {
                index: i as u32,
                width: p.width.unwrap(),
                height: p.height.unwrap(),
            })
            .collect());
    }
    let handle = state.source_handle_for_book(&book_id)?;
    let dims = blocking(move || {
        let count = handle.page_count()?;
        let mut out: Vec<(u32, u32)> = Vec::with_capacity(count);
        for i in 0..count {
            let dims: Option<(u32, u32)> = handle
                .read_partial(i as usize, 256 * 1024)
                .ok()
                .and_then(|partial| {
                    image::ImageReader::new(std::io::Cursor::new(&partial.bytes))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok())
                        .filter(|d| d.0 > 0 && d.1 > 0)
                });
            let (w, h) = match dims {
                Some(d) => d,
                None => {
                    let raw = handle.read_raw(i as usize)?;
                    image::ImageReader::new(std::io::Cursor::new(&raw.bytes))
                        .with_guessed_format()?
                        .into_dimensions()?
                }
            };
            out.push((w, h));
        }
        Ok(out)
    })
    .await?;
    state
        .webtoon_layouts
        .lock()
        .insert(book_id.clone(), Arc::new(dims.clone()));
    Ok(dims
        .iter()
        .enumerate()
        .map(|(i, (w, h))| PageDim {
            index: i as u32,
            width: *w,
            height: *h,
        })
        .collect())
}
```

上面的 `handle` 已包含全部本地读取逻辑；`state.webtoon_layouts` 的缓存与返回结构与原实现保持一致。

- [ ] **Step 9: 修改 list_entries 与 ocr_region**

`list_entries` 改为：

```rust
    let st = state.inner().clone();
    let bid = book_id.clone();
    blocking(move || {
        let handle = st.source_handle_for_book(&bid)?;
        Ok(handle
            .entry_names()?
            .into_iter()
            .enumerate()
            .map(|(i, name)| PageEntry {
                index: i as u32,
                name,
            })
            .collect())
    })
    .await
```

`ocr_region` 的裁剪闭包改为：

```rust
    let st = state.inner().clone();
    let bid = book_id.clone();
    let png = blocking(move || -> Result<Vec<u8>, BackendError> {
        let handle = st.source_handle_for_book(&bid)?;
        let count = handle.page_count()?;
        if index >= count as u32 {
            return Err(BackendError::Msg(format!(
                "页码 {index} 超出范围(共 {count} 页)"
            )));
        }
        let raw = handle.read_raw(index as usize)?;
        ocr::encode_png(&ocr::crop_dyn(&raw, &rect)?)
    })
    .await?;
```

删除原来的 `(path, endpoint, lang, timeout_s)` 五元组中的 `path`，只保留设置项。

- [ ] **Step 10: 修改工作台与批量读取**

在 `workbench.rs` 中把 `load_page_png` 替换为：

```rust
/// 按 bookId 读取原始分辨率整页 PNG（本地/在线共用）。
pub(crate) fn load_page_png_for_book(
    st: &Arc<AppState>,
    book_id: &str,
    index: u32,
) -> Result<PagePng, crate::source::BackendError> {
    let handle = st.source_handle_for_book(book_id)?;
    let count = handle.page_count()?;
    if index >= count as u32 {
        return Err(crate::source::BackendError::Msg(format!(
            "页码 {index} 超出范围(共 {count} 页)"
        )));
    }
    let raw = handle.read_raw(index as usize)?;
    let img = image::load_from_memory(&raw.bytes)?;
    let (width, height) = (img.width(), img.height());
    let png = ocr::encode_png(&img)?;
    Ok(PagePng { png, width, height })
}
```

把 `wb_ctx` 改为只返回 sidecar 设置：

```rust
fn wb_ctx(
    state: &State<'_, Arc<AppState>>,
    book_id: &str,
) -> Result<(String, u64), String> {
    let s = state.settings.lock().clone();
    state
        .db
        .with(|conn| db::get_book(conn, book_id).map_err(err))?
        .ok_or_else(|| "书籍不存在".to_string())?;
    Ok((s.sidecar_endpoint, s.sidecar_timeout_s))
}
```

把 `wb_detect` / `wb_ocr` / `wb_inpaint` 中的 `(path, endpoint, timeout)` 改为 `(endpoint, timeout)`，页面读取改为：

```rust
    let st = state.inner().clone();
    let bid = book_id.clone();
    let page = blocking(move || load_page_png_for_book(&st, &bid, index)).await?;
```

在 `batch.rs` 中：

```rust
use crate::workbench::{load_page_png_for_book, translate_texts_cached};
```

把 `process_page` 签名中的 `path: &str` 删除，页面读取改为：

```rust
            let st2 = Arc::clone(st);
            let bid = book_id.to_string();
            let page = blocking(move || load_page_png_for_book(&st2, &bid, index)).await?;
```

把 `run_job` 中的 `process_page(st, &job.book_id, &path, done)` 改为 `process_page(st, &job.book_id, done)`。`path` 仍用于书籍存在性检查，不删除。

- [ ] **Step 11: 运行删除辅助测试与全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml online_source_path_is_never_deleted -v`  
Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 全绿。

- [ ] **Step 12: 提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/workbench.rs src-tauri/src/batch.rs
git commit -m "feat: 接入在线源命令、预取与删除语义"
```

---

## Task 8: 前端契约、Settings 与 Status

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/Status.tsx`
- Test: `npx tsc --noEmit`、`npm run build`

**Interfaces:**
- Consumes: 新命令与 `BookInfo` 字段。
- Produces: `OnlineProbe`、`resolveOnlineUrl`、`testOnlineConnection`、`isOnlineEnabled()`、`mr-exp-online` 镜像、在线设置卡片、Status 只读卡片。

- [ ] **Step 1: 扩展 tauri.ts**

在 `BookInfo` 中加入：

```ts
  sourceType: string;
  webtoonReady: boolean;
```

在 `Settings` 中加入：

```ts
  experimentalOnline: boolean;
  onlineProxy: string;
  onlineConcurrency: number;
```

在 `SidecarHealth` 之后加入：

```ts
export interface OnlineProbe {
  ok: boolean;
  title: string;
  pageCount: number;
  elapsedMs: number;
  message: string;
}
```

在镜像常量与函数中加入：

```ts
const EXP_ONLINE_KEY = "mr-exp-online";

// 在 applySettingsMirror 内：
  try {
    localStorage.setItem(EXP_ONLINE_KEY, s.experimentalOnline ? "1" : "0");
  } catch {
    /* 忽略 */
  }

/** 同步读取在线直读开关（镜像）。 */
export function isOnlineEnabled(): boolean {
  try {
    return localStorage.getItem(EXP_ONLINE_KEY) === "1";
  } catch {
    return false;
  }
}
```

在 `api` 对象中加入：

```ts
  resolveOnlineUrl: (url: string) =>
    invoke<BookInfo>("resolve_online_url", { url }),
  testOnlineConnection: (url: string) =>
    invoke<OnlineProbe>("test_online_connection", { url }),
```

- [ ] **Step 2: 扩展 Settings 表单**

在 `Settings.tsx` 的 `DEFAULT_FORM` 中加入：

```ts
  experimentalOnline: false,
  onlineProxy: "",
  onlineConcurrency: 3,
```

把 `setExperimental` 的 key 类型改为：

```ts
    key: "experimentalTrans" | "experimentalWebtoon" | "experimentalOnline",
```

把 label 表达式改为：

```ts
    const label =
      key === "experimentalTrans"
        ? "翻译功能"
        : key === "experimentalWebtoon"
          ? "条漫模式"
          : "在线 URL 直读";
```

在实验性功能卡片中追加第三行（复用前两行结构）：

```tsx
        <div
          className="field-row"
          style={{ alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}
        >
          <span style={{ flex: 1 }}>
            在线 URL 直读（JSON 清单）
            <span className="badge" style={{ marginLeft: 8 }}>
              {form.experimentalOnline ? "已开启" : "未开启"}
            </span>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              只支持匿名 JSON 清单与直链图片；不支持 Cookie、登录或 HTML 嗅探。
            </p>
          </span>
          <button
            className={`btn${form.experimentalOnline ? " primary" : ""}`}
            onClick={() =>
              void setExperimental("experimentalOnline", !form.experimentalOnline)
            }
          >
            {form.experimentalOnline ? "关闭" : "开启"}
          </button>
        </div>
```

在组件状态区加入：

```ts
  const [onlineTestUrl, setOnlineTestUrl] = useState("");
  const [onlineProbe, setOnlineProbe] = useState<string | null>(null);
  const [testingOnline, setTestingOnline] = useState(false);
```

在 `onSave` 之前加入：

```ts
  const testOnline = async () => {
    if (!onlineTestUrl.trim()) {
      toast("请填写 JSON 清单 URL");
      return;
    }
    setTestingOnline(true);
    setOnlineProbe(null);
    try {
      const p = await api.testOnlineConnection(onlineTestUrl.trim());
      setOnlineProbe(`${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`);
    } catch (e) {
      toastErr("test_online_connection", e);
    } finally {
      setTestingOnline(false);
    }
  };
```

在翻译服务卡片之后、保存按钮之前加入：

```tsx
      {form.experimentalOnline && (
        <div className="card section-card">
          <h3 className="section-title">
            <Link2 size={15} /> 在线源与网络
          </h3>
          <p className="hint">
            当前仅支持 JSON 清单与直链图片。清单被视为用户信任输入；请只导入你信任的地址。
          </p>
          <div className="form-grid two" style={{ marginTop: 8 }}>
            <label className="field">
              <span>代理地址</span>
              <input
                className="input mono"
                value={form.onlineProxy}
                onChange={(e) => set("onlineProxy", e.currentTarget.value)}
                placeholder="留空直连，或 http://127.0.0.1:7890 / socks5://..."
              />
            </label>
            <label className="field">
              <span>并发数</span>
              <input
                className="input mono"
                type="number"
                min={1}
                max={8}
                value={form.onlineConcurrency}
                onChange={(e) =>
                  set("onlineConcurrency", Number(e.currentTarget.value) || 1)
                }
              />
            </label>
          </div>
          <div className="field-row" style={{ marginTop: 12 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              value={onlineTestUrl}
              onChange={(e) => setOnlineTestUrl(e.currentTarget.value)}
              placeholder="https://example.com/manifest.json"
              aria-label="在线清单测试 URL"
            />
            <button className="btn" onClick={() => void testOnline()} disabled={testingOnline}>
              {testingOnline ? "测试中…" : "测试连通性"}
            </button>
          </div>
          {onlineProbe && <p className="hint mono">{onlineProbe}</p>}
        </div>
      )}
```

在 `lucide-react` 导入中加入 `Link2`。

- [ ] **Step 3: Status 增加只读卡片**

在 `Status.tsx` 的 `lucide-react` 导入中加入 `Link2`，并在“翻译服务”卡片之后加入：

```tsx
      <div className="card section-card">
        <h3 className="section-title">
          <Link2 size={15} /> 在线直读
        </h3>
        <p className="hint mono">
          {settings?.experimentalOnline ? "已开启" : "未开启"} · 代理{" "}
          {settings?.onlineProxy ? "已配置" : "直连"} · 并发{" "}
          {settings?.onlineConcurrency ?? 3}
        </p>
      </div>
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit`  
Expected: 无错误。

Run: `npm run build`  
Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/lib/tauri.ts src/pages/Settings.tsx src/pages/Status.tsx
git commit -m "feat: 增加在线直读设置与状态入口"
```

---

## Task 9: Library URL 导入、徽标与删除语义

**Files:**
- Create: `src/components/OnlineImportDialog.tsx`
- Modify: `src/pages/Library.tsx`
- Modify: `src/components/BookCard.tsx`
- Modify: `src/components/DetailSheet.tsx`
- Modify: `src/components/ui.css`
- Test: `npx tsc --noEmit`、`npm run build`

**Interfaces:**
- Consumes: `api.resolveOnlineUrl`、`api.testOnlineConnection`、`isOnlineEnabled`、`sourceType`。
- Produces: URL 模态框、URL 徽标、在线“彻底移除”流程。

- [ ] **Step 1: 创建 OnlineImportDialog**

```tsx
import { useState } from "react";
import { Link2, Loader2, X } from "lucide-react";
import { api, type BookInfo } from "../lib/tauri";
import { toast, toastErr } from "./Toast";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
}

export default function OnlineImportDialog({ onClose, onImported, onRead }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "add" | "read" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const run = async (mode: "test" | "add" | "read") => {
    if (!url.trim()) {
      setErr("请输入 JSON 清单 URL");
      return;
    }
    setBusy(mode);
    setErr(null);
    setProbe(null);
    try {
      if (mode === "test") {
        const p = await api.testOnlineConnection(url.trim());
        setProbe(`${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`);
      } else {
        const b = await api.resolveOnlineUrl(url.trim());
        toast(`已加入：${b.title} · ${b.pageCount} 页`);
        onImported();
        if (mode === "read") onRead(b);
        onClose();
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : "操作失败";
      setErr(msg);
      toastErr("online", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose} role="presentation">
      <div
        className="dialog online-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="URL 在线直读"
        onClick={(e) => e.stopPropagation()}
      >
        <h4>
          <Link2 size={15} /> URL 在线直读
        </h4>
        <p className="hint">
          粘贴 JSON 清单地址。只导入你信任的清单；当前版本不支持 Cookie、登录或 HTML 嗅探。
        </p>
        <input
          className="input mono"
          autoFocus
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setErr(null);
            setProbe(null);
          }}
          placeholder="https://example.com/manifest.json"
          aria-label="JSON 清单 URL"
          onKeyDown={(e) => {
            if (e.key === "Enter") void run("read");
          }}
        />
        {err && <p className="hint online-error">{err}</p>}
        {probe && <p className="hint mono">{probe}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={() => void run("test")} disabled={busy !== null}>
            {busy === "test" ? <Loader2 size={14} className="online-spin" /> : null} 测试
          </button>
          <button className="btn" onClick={() => void run("add")} disabled={busy !== null}>
            {busy === "add" ? <Loader2 size={14} className="online-spin" /> : null} 仅加入书库
          </button>
          <button className="btn primary" onClick={() => void run("read")} disabled={busy !== null}>
            {busy === "read" ? <Loader2 size={14} className="online-spin" /> : null} 解析并直接阅读
          </button>
          <button className="btn" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 Library 接入**

在 `Library.tsx` 的 `lucide-react` 导入中加入 `Link2`；在 tauri 导入中加入 `isOnlineEnabled`、`onExperimentalChange`；导入新组件。

在状态区加入：

```ts
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled());
```

在 `useEffect(() => onTransToggle(setTransOn), []);` 附近加入：

```ts
  useEffect(() => onExperimentalChange(() => setOnlineOn(isOnlineEnabled())), []);
```

在 `lib-tools` 中加入按钮（放在搜索框之后、添加书籍之前）：

```tsx
          {onlineOn && (
            <button
              className="btn"
              onClick={() => setOnlineOpen(true)}
              title="从 JSON 清单 URL 导入"
            >
              <Link2 size={14} /> URL 直读
            </button>
          )}
```

在页面底部 `DetailSheet` 之前加入：

```tsx
      {onlineOpen && (
        <OnlineImportDialog
          onClose={() => setOnlineOpen(false)}
          onImported={() => void reload(debounced)}
          onRead={(b) => nav(`/reader/${encodeURIComponent(b.id)}`)}
        />
      )}
```

- [ ] **Step 3: 右键菜单与确认文案**

在 `Library.tsx` 的 `ctxBook` 右键菜单中，把：

```tsx
            {
              label: "删除源文件…",
              danger: true,
              onSelect: () => setConfirmDelete([ctxBook]),
            },
```

改为：

```tsx
            {
              label: ctxBook.sourceType === "local" ? "删除源文件…" : "彻底移除…",
              danger: true,
              onSelect: () => setConfirmDelete([ctxBook]),
            },
```

把删除确认的 JSX 改为：

```tsx
      {deleteTargets && deleteTargets.length > 0 && (
        <ConfirmDialog
          title={`${
            deleteTargets.some((b) => b.sourceType !== "local") ? "彻底移除" : "删除源文件"
          }（${deleteTargets.length} 本 · 共 ${deletePages} 页）？`}
          message={
            deleteTargets.some((b) => b.sourceType !== "local")
              ? "将从书库移除以下在线书，并清理进度、缩略图、翻译缓存等全部本地记录；不会删除远程源。此操作不可逆。"
              : "将从磁盘永久删除以下源文件/文件夹，并清理该书的进度、缩略图、翻译缓存等全部记录。此操作不可逆。"
          }
          paths={deleteTargets.map((b) => `${b.path}（${b.pageCount} 页）`)}
          confirmText={deleteTargets.some((b) => b.sourceType !== "local") ? "彻底移除" : "永久删除"}
          onConfirm={() => void doDeleteConfirmed()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
```

- [ ] **Step 4: BookCard 徽标**

在 `BookCard.tsx` 的封面 `img`/fallback 之后加入：

```tsx
      {book.sourceType !== "local" && (
        <span className="book-source-badge mono">URL</span>
      )}
```

- [ ] **Step 5: DetailSheet 徽标**

在 `DetailSheet.tsx` 的 `sheet-title` 之后加入：

```tsx
            {render.sourceType !== "local" && (
              <span className="badge mono" style={{ marginLeft: 8 }}>
                URL
              </span>
            )}
```

- [ ] **Step 6: 样式**

在 `ui.css` 末尾加入：

```css
/* 在线源：URL 徽标与导入弹窗 */
.book-source-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: rgba(77, 124, 254, 0.9);
  letter-spacing: 0.04em;
}
.online-dialog {
  width: min(560px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.online-error {
  color: #f87171;
}
.online-spin {
  animation: online-rot 0.9s linear infinite;
}
@keyframes online-rot {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 7: 类型检查与构建**

Run: `npx tsc --noEmit`  
Expected: 无错误。

Run: `npm run build`  
Expected: 构建成功。

- [ ] **Step 8: 提交**

```bash
git add src/components/OnlineImportDialog.tsx src/pages/Library.tsx src/components/BookCard.tsx src/components/DetailSheet.tsx src/components/ui.css
git commit -m "feat: 增加书库 URL 导入入口与在线书徽标"
```

---

## Task 10: Reader 条漫门控与在线预取窗口

**Files:**
- Modify: `src/pages/Reader.tsx`
- Test: `npx tsc --noEmit`、`npm run build`

**Interfaces:**
- Consumes: `BookInfo.webtoonReady`、`BookInfo.sourceType`。
- Produces: 在线书禁用条漫、预取限制 +1/+2。

- [ ] **Step 1: 条漫可用性计算**

把 `rawMode` / `mode` 的计算改为：

```tsx
  const rawMode: PageMode = bookMode ?? prefs.mode;
  const webtoonAllowed = wtOn && (book?.webtoonReady !== false);
  const mode: PageMode =
    !webtoonAllowed && rawMode === "webtoon" ? prefs.mode : rawMode;
```

- [ ] **Step 2: setMode / toggleMode 守卫**

`setMode` 开头改为：

```tsx
      if (m === "webtoon" && !webtoonAllowed) return;
```

`toggleMode` 改为：

```tsx
  const toggleMode = useCallback(() => {
    const cur = trackRef.current.mode;
    const canWebtoon = wtOn && book?.webtoonReady !== false;
    const cycle: PageMode[] = canWebtoon
      ? ["single", "double", "webtoon"]
      : ["single", "double"];
    const idx = cycle.indexOf(cur);
    setMode(cycle[(idx + 1) % cycle.length]);
  }, [setMode, wtOn, book]);
```

`setMode` 的依赖数组加入 `webtoonAllowed`（或 `book`）。

- [ ] **Step 3: 设置弹层与自动建议**

设置弹层的版式选项改为：

```tsx
              {(wtOn && book?.webtoonReady !== false
                ? (["single", "double", "webtoon"] as const)
                : (["single", "double"] as const)
              ).map((m) => (
```

自动建议条件中加入：

```tsx
      {wtOn && book?.webtoonReady !== false && wtSuggest && mode !== "webtoon" && (
```

- [ ] **Step 4: 在线预取窗口**

在静默预取 effect 中，把循环改为：

```tsx
      const radius = book.sourceType !== "local" ? 2 : 3;
      for (let i = t.page - radius; i <= t.page + radius; i++) {
```

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit`  
Expected: 无错误。

Run: `npm run build`  
Expected: 构建成功。

- [ ] **Step 6: 提交**

```bash
git add src/pages/Reader.tsx
git commit -m "feat: 在线书条漫门控与预取限制"
```

---

## Task 11: 文档同步与全量验收

**Files:**
- Modify: `docs/TECHNICAL.md`
- Modify: `README.md`（如需要新增用户入口说明）
- Test: `cargo test`、`npx tsc --noEmit`、脚本、`npm run build`、手工冒烟

**Interfaces:**
- Consumes: 所有已实现功能。
- Produces: 与实现一致的契约文档与验收记录。

- [ ] **Step 1: 更新 TECHNICAL.md**

按 spec 第 17 节同步：

1. 5.1 表说明中加入 `source_type` / `meta_json`；
2. 6.1 设置表加入三个字段；
3. 6.2 命令分组加入在线源；
4. 新增 6.12 小节，内容至少包含：
   - 只支持 JSON 清单；不支持 EH/JM/Cookie/HTML；
   - 同步 `ImageSource` + `ureq` 阻塞下载；
   - `book.path = 规范化清单 URL`，`book.id = sha256(path)`；
   - L1/L2 复用、`onlineConcurrency`、预取 +1/+2；
   - 清单变化清派生缓存；
   - 在线书删除不触碰远程源；
   - 条漫依赖清单宽高。
5. 7.2 页面职责表更新 Library/Reader/Settings/Status；
6. 附录 A 增加两个命令，`BookInfo` 增加两个字段；
7. 第 13 节已知问题加入：在线 OCR/工作台会重新下载原图、清单 URL 过期需重导入、OPDS 未实现。

- [ ] **Step 2: 更新 README**

在“文档”列表加入：

```markdown
- [在线直读设计（JSON 清单）](docs/superpowers/specs/2026-10-19-online-direct-reader-design.md)
```

如果实现完成后需要用户提示，可在 README 的“开发”段之后加入一句：“在线 URL 直读需在设置→实验性功能中开启，首期仅支持 JSON 清单。”

- [ ] **Step 3: 全量后端测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: 全绿；无网络访问。

- [ ] **Step 4: 前端检查**

Run: `npx tsc --noEmit`  
Expected: 无错误。

Run: `node scripts/verify-spread.mjs`  
Expected: `All RTL spread checks passed.`

Run: `node scripts/verify-region.mjs`  
Expected: `All region checks passed.`

Run: `npm run build`  
Expected: 构建成功。

- [ ] **Step 5: 手工冒烟**

准备本地 stub 清单（Windows Git Bash）：

```bash
TMP="$TEMP/mr-online-smoke"
mkdir -p "$TMP"
"C:/Users/Administrator/Desktop/manga-reader-tauri/sidecar/.venv/Scripts/python.exe" - <<'PY'
from PIL import Image
import os
root = os.path.join(os.environ["TEMP"], "mr-online-smoke")
for i, color in enumerate([(220, 40, 40), (40, 180, 80), (40, 80, 220)], 1):
    Image.new("RGB", (800, 1200), color).save(os.path.join(root, f"{i}.png"))
with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as f:
    f.write('{"version":1,"title":"在线冒烟","pages":[')
    f.write(",".join(f'{{"url":"http://127.0.0.1:8765/{i}.png","width":800,"height":1200}}' for i in range(1, 4)))
    f.write(']}')
PY
cd "$TMP" && "C:/Users/Administrator/Desktop/manga-reader-tauri/sidecar/.venv/Scripts/python.exe" -m http.server 8765
```

另开终端运行 `npm run tauri dev`，然后：

1. 设置 → 实验性功能 → 开启“在线 URL 直读”；保存。
2. 书库 → URL 直读 → 输入 `http://127.0.0.1:8765/manifest.json` → 测试 → 仅加入书库。
3. 打开该书，翻页；回翻第一页应命中 L2（可停掉 stub server 验证）。
4. 条漫按钮可用（清单带宽高）；切换条漫；再切回单页。
5. 工作台载入第 1 页 → 开始检测（sidecar 可用时）。
6. 右键在线书 → 彻底移除；确认不回显“删除源文件”，远程 stub 文件仍在。
7. 关闭实验开关：URL 按钮消失，已导入在线书仍可打开。
8. 输入一个 404/非 JSON URL，确认错误提示。

- [ ] **Step 6: 提交**

```bash
git add docs/TECHNICAL.md README.md
git commit -m "docs: 同步在线直读契约与限制"
```

---

## Self-Review

- **Spec coverage**：Task 1-2 覆盖设置/URL/信号量；Task 3 覆盖 HTTP/代理/重试/大小上限；Task 4 覆盖清单/哈希/宽高；Task 5 覆盖 DB/BookInfo/迁移/派生清理；Task 6 覆盖 OnlineSource/句柄池；Task 7 覆盖命令/预取/删除/工作台/批量；Task 8-10 覆盖前端；Task 11 覆盖文档与验收。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含实际代码或实际 diff。
- **Type consistency**：`PageRef`、`StoredMeta`、`OnlineBookMeta`、`HttpTransport::get`、`SourceHandle::open_online`、`source_handle_for_book`、`OnlineProbe`、`BookInfo.sourceType/webtoonReady` 在所有任务中名称一致。
- **Known deviations**：`OnlineProvider` 只保留 `resolve`，在线 Source 构造在 `AppState`/`source.rs` 完成；这不改变 spec 的行为边界，只减少模块环依赖。
- **No implementation yet**：本计划只定义实施步骤；执行前需用户选择执行方式。
