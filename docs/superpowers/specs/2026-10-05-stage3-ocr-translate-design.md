# 阶段三设计:框选 OCR + 翻译

> **历史设计（已实现）**：本文是 2026-10-05 阶段三的设计快照，功能已落地。
> 后续工作台、批量预翻译、术语表、OCR 存档等扩展以 [TECHNICAL.md](../../TECHNICAL.md) 为准。


日期:2026-10-05
状态:已定稿(用户未逐题确认,按冻结契约与代码内既有意图定夺;见"决策记录")

## 背景与现状

- 阶段一(后端管线:扫描/渲染/LRU 缓存/看板/设置)与阶段二(暗色沉浸阅读器:单双页/RTL/缩放平移/目录)已完成。
- `src-tauri/src/lib.rs` 已冻结阶段三数据契约:`RegionRect`、`OcrResult`、`TranslateResult`、`TransLogEntry`、`TransStats`;`Settings` 已含 `transEndpoint / transApiKey / transModel / transTemp / transTimeoutS / ocrEndpoint / ocrTimeoutS / srcLang / dstLang`。
- 设置页翻译区是占位;`ocrEndpoint` 占位文案写明"留空则用本地 OCR(阶段三)"。
- 既有不一致:`hydrate_settings` 读取 `trans_api_key`,但 `set_settings` 持久化清单漏掉该键;前端 `lib/tauri.ts` 的 `Settings` 也缺 `transApiKey` 字段。本阶段修复。

## 目标

阅读时对任意页拖一个矩形框,后端裁剪原图对应区域做 OCR,再交给 OpenAI 兼容的本地 LLM 翻译,结果浮层展示并可复制;调用成败与耗时入 SQLite 日志,设置页可见统计。全程使用设置页真实配置,无 mock。

## 非目标(YAGNI)

- 不做整页自动翻译/气泡替换渲染(后续阶段)。
- 不做翻译缓存与术语表。
- 不做 OCR 结果的版面重排,仅按 OCR 引擎返回顺序拼接文本。
- 不新增"检测 OCR 能力"命令;语言包缺失通过报错信息体现。

## 实现期决策补充(code review 后)

- **触屏不启用框选**:单指触屏保留给平移/翻页手势,框选仅鼠标/触控笔(实现为 `pointerType !== "touch"`);原设计"单指/左键拖拽"中的触屏部分不实现。
- **取消"点浮层外关闭"**:浮层外即画布,点击外部的语义应仍是画新选区;关闭走 Esc / X 按钮。
- **trans_log 滚动上限**:每次写入后裁剪到最近 5000 条,防无界增长。
- **选区拖拽期间捕获指针**(`setPointerCapture`),拖到工具栏上松手也能正常收尾。
- **在途请求序号守卫**:新框选/翻译/退出会使旧的在途回包作废,避免旧结果覆盖新状态或卡死工具栏显隐。

## 决策记录

1. **OCR 后端:本地 Windows OCR + HTTP 兜底(推荐方案,用户未作答)**。
   - `ocrEndpoint` 为空 → WinRT `Windows.Media.Ocr`(新依赖 `windows` crate,仅 Windows target):离线可用、零部署、符合"留空则用本地 OCR"的既有文案;日语识别质量一般,系统需装日语语言包,缺失时返回可读错误。
   - `ocrEndpoint` 非空 → POST `{"image": "<base64 png>"}` → 期望 `{"text": "..."}`(简单 JSON 协议,LLM 视觉模型或自建 OCR 服务都易适配)。
   - 备选"仅 HTTP"违背冻结意图,"视觉 LLM 直接识图"推翻 `OcrResult/RegionRect` 契约,均不取。
2. **翻译协议:OpenAI 兼容 `/chat/completions`**。endpoint 默认 `http://localhost:8080/v1`,拼 `{endpoint}/chat/completions`;`Authorization: Bearer <key>`(key 非空时);请求体 `model / temperature / messages`,system 提示"从 {srcLang} 翻译到 {dstLang},只输出译文";超时 `transTimeoutS`。`reqwest`(rustls)已在依赖中。
3. **API Key 持久化**:纳入 `set_settings` 持久化清单(本地单机 SQLite,明文可接受),修复 hydrate 读了却存不了的不一致。

## 架构

### 后端(src-tauri)

- **`db.rs` 扩展**:新表 `trans_log(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ok INTEGER, elapsed_ms INTEGER, created_at TEXT)`;`log_trans(conn, kind, ok, elapsed_ms)`;`trans_stats(conn) -> (ocr 聚合, trans 聚合, 最近 50 条)`。聚合全部用 SQL(count/avg/fail count)。
- **新模块 `ocr.rs`**(纯函数与副作用分离,便于测试):
  - `crop_to_png(raw: &RawPage, rect: &RegionRect) -> Result<Vec<u8>>`:解码原图 → 相对坐标裁剪(rect 各分量钳制到 0..1,宽高校验 ≥ 4px)→ 编码 PNG。
  - `ocr_local(png: &[u8], lang: &str) -> Result<String>`:WinRT 流程(SoftwareBitmap BGRA8 → OcrEngine::TryCreateFromLanguage(lang,回退用户语言包)→ RecognizeAsync → 拼接 Lines 文本);在 `spawn_blocking` 线程执行。
  - `ocr_http(client, endpoint, png, timeout) -> Result<String>`:上述 JSON 协议。
  - 单测:坐标钳制/小框拒绝/PNG 编码尺寸;WinRT 与 HTTP 不做单测(HTTP 协议纯函数化后测请求体组装)。
- **新模块 `translate.rs`**:
  - `build_request(settings, text) -> (url, json_body, headers)` 纯函数;`translate(client, settings, text) -> Result<(String, String /*model*/, u64 /*ms*/)>`。
  - 单测:URL 拼接(去尾斜杠)、请求体形状、响应解析( choices[0].message.content,缺失时报错)。
- **命令(`commands.rs`,注册进 `generate_handler`)**:
  - `ocr_region(book_id, index, rect: RegionRect) -> OcrResult`:从 `open_source(book.path)` 读原始页(不经过展示缩放,保证识别精度)→ `crop_to_png` → 按 `ocrEndpoint` 选择本地/HTTP → 记日志 → 返回 `{text, elapsedMs}`。
  - `translate_region(text) -> TranslateResult`:非空校验 → 调 `translate` → 记日志 → 返回 `{translated, model, elapsedMs}`。
  - `get_trans_stats() -> TransStats`:读库聚合 + recent 50(`{kind, ok, elapsedMs, createdAt}`)。
  - 三个命令均为 async + `spawn_blocking`(OCR/HTTP 不阻塞运行时);网络客户端 `reqwest::Client` 存入 `AppState`(惰性创建一次)。

### 前端(src)

- **`lib/tauri.ts`**:`Settings` 补 `transApiKey`;新增 `RegionRect/OcrResult/TranslateResult/TransStats` 类型与 `api.ocrRegion/translateRegion/getTransStats`。
- **新纯函数模块 `components/Reader/region.ts`**:`rectFromPoints(a, b)`(归一化、允许反向拖动)、`MIN_RECT = 0.012`(过小视为误触)、`rectArea`;配套 `scripts/verify-region.mjs`(沿用 `verify-spread.mjs` 的运行方式)。
- **`Reader.tsx` 选区模式**:
  - 悬浮工具栏加"选区翻译"开关(Languages 图标);开启后:页面 `cursor: crosshair`,单指/左键拖拽画选区(虚线框),此时禁用翻页拖拽与"点按切换工具栏"手势(以 `regionMode` 分支改写现有 pointer 处理);滚轮缩放保留。
  - 松开且 `rectArea ≥ MIN_RECT` 时,对**光标下的那张页图**(`img[data-idx]`)调 `ocr_region`;选区坐标相对该 `img` 的 bounding box(自动兼容双页 spread 与缩放)。
  - 结果浮层(底部悬浮卡片,沿用现有浮条样式):OCR 原文(可滚动)+ 耗时;"翻译"按钮 → `translate_region` → 显示译文 + 模型 + 耗时;"复制"按钮;ESC/点浮层外关闭并退出选区。
  - 失败走现有 toast(`toastErr`);请求期间按钮 loading,可重复发起(每次覆盖结果)。
- **`Settings.tsx`**:翻译卡片的"阶段三占位"徽标改为"阶段三";API Key 密码框接入 `form.transApiKey`(回显空、留空即不改的语义不做——直接整表保存,与现有整表保存一致);新增"翻译/OCR 使用统计"小块(get_trans_stats:调用数/失败/平均耗时,最近一条时间)。
- **样式**:全部走现有 `ui.css`/`Reader.css` 变量,不引入新依赖。

## 数据流

拖框(前端归一化坐标)→ `ocr_region`:书路径→打开源→原始页字节→裁剪 PNG→本地 WinRT 或 HTTP→文本+耗时,写 `trans_log(kind="ocr")` → 浮层展示 → "翻译"→ `translate_region`:OpenAI 兼容请求→译文+模型+耗时,写 `trans_log(kind="trans")` → 浮层展示;设置页随时可读 `get_trans_stats` 聚合。

## 错误处理

- 书/页不存在、rect 非法:命令返回可读中文错误,前端 toast。
- 本地 OCR 无对应语言包:`TryCreateFromLanguage` 失败 → 回退用户语言包 → 仍失败则报"系统缺少 {srcLang} OCR 语言包,请在系统设置中安装,或配置 OCR Endpoint"。
- HTTP OCR / 翻译:超时(按设置)、非 2xx、JSON 形状不符 → 带状态码/ bodies 摘要的报错。
- 数据库未初始化:沿既 `DbSlot` 行为,报"数据库尚未初始化"。

## 测试策略

- Rust `cargo test`:裁剪/钳制、PNG 编码、翻译请求体与响应解析、trans_log 聚合(内存 SQLite)。
- 前端:`tsc` 通过 + `node scripts/verify-region.mjs` 断言选区纯函数(与 verify-spread 同套路)。
- 手工验收路径:设置页保存 key/endpoint → 书库开书 → 开选区 → 框选气泡 → OCR → 翻译 → 复制;ESC 退出;统计数字增长。
