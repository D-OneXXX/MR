# Sidecar 接口契约

> 更新时间：2026-10-23（应用 0.12.1）
> 适用代码：`sidecar/`（Python，独立本地服务）；Tauri 仅做 HTTP 客户端，不把模型打进安装包。

sidecar 承载 ctd / mit48px / lama 三个 torch 模型，对外提供本地 HTTP。

## 运行形态

- 代码：`sidecar/`（本仓库，不进安装包），**自包含**：模型推理代码已内联进 `sidecar/vendor/`（自 BallonsTranslator / manga-image-translator / comic-text-detector / lama 移植的最小子集），运行时不再依赖本机安装的 BallonsTranslator。
- 解释器：`sidecar\.venv`（首次运行 `setup.bat` 从系统 Python 3.10+ 创建，并安装 torch CPU 等依赖）。
- 模型：`sidecar\models\` 由 `download_models.py` 按需下载（约 700 MB，一次性；`SIDECAR_MODELS` 可改路径），不打进安装包：
  - `comictextdetector.pt`（ctd）← HuggingFace `dreMaze/mit_models`
  - `mit48pxctc_ocr.ckpt` + `alphabet-all-v5.txt` ← HuggingFace `dreMaze/mit_models`（ocr-ctc.zip）
  - `lama_large_512px.ckpt` ← HuggingFace `dreMaze/AnimeMangaInpainting`
- 端口：`SIDECAR_PORT`（默认 **8500**）。设备：`SIDECAR_DEVICE`（默认 **cpu**）。
- 许可提示：上游模型代码含 GPL-3.0（manga-image-translator 系），sidecar 作为独立本地组件与 Tauri 应用分离；本地自用无分发问题，对外分发前需复核许可。
- 启动：首次 `sidecar\setup.bat` → 之后 `sidecar\launch.bat`。

## 契约（全部 JSON，UTF-8；错误一律 `{"error": "<中文可读>"}`）

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| GET `/health` | – | `{ok: bool, device: "cpu"\|"cuda", models: {detector: "ready"\|"missing"\|"not_loaded", ocr: …, inpaint: …}, detail?: string}` |
| POST `/v1/detect` | `{image: "<b64 png>"}` | `{boxes: [{x, y, w, h, score, vertical}], elapsedMs}` |
| POST `/v1/ocr` | `{image: "<b64 png>", boxes: [{x, y, w, h, vertical?}]}` | `{results: [{x, y, w, h, text}], elapsedMs}` |
| POST `/v1/inpaint` | `{image: "<b64 png>", boxes: [{x, y, w, h}]}` | `{image: "<b64 png>", elapsedMs}` |

- 坐标：均为**所提交图像的绝对像素**（整数，≥0）；缩放/归一化是调用方（Rust/前端）的责任。
- `vertical`：框内文字是否竖排（日漫常见）。detect 会返回；ocr 缺省按 `h > w` 推断。**mit48px 是单行模型**——多行气泡必须按行拆框传入，这正是工作台“两步工作流 + 人工修框”存在的原因。
- 状态码：
  - `200` 成功；
  - `400` 请求形状错误（`error` 说明）；
  - `500` 推理异常，包括模型缺失（`error` 会提示运行 `download_models.py` 下载）。
- 模型状态：`/health` 的 `models.*` 只会出现 `ready` / `missing` / `not_loaded`，不会出现 `loading`；`not_loaded` 表示服务已起、模型将在首次推理时加载。
- 幂等性：全部无状态；翻译不在 sidecar（由 Tauri 直连 OpenAI 兼容 LLM）。
- 超时：调用方控制（Rust 侧按 `sidecarTimeoutS`，默认 120s；lama CPU 可能较慢）。
- 烟测：`sidecar\smoke_test.py`（合成图直驱 pipeline）+ `/health` HTTP 冒烟。

## 显存/内存预算（验收项）

- 默认 CPU 推理：进程内存 ≈ ctd ~0.5 GB + mit48px ~0.3 GB + lama ~1.5 GB 峰值，与 LLM 5.78 GB 不冲突。
- `SIDECAR_DEVICE=cuda` 时三者合计 < 2 GB 显存，仅在用户确认 LLM 空闲时启用；`/health` 上报 device 供设置页展示。

## 与工作台选项的对应

| 工作台下拉框 | 槽位 | 实现 |
|---|---|---|
| 文本检测 | TextDetector | sidecar `/v1/detect`（ctd） |
| OCR | OcrProvider | sidecar `/v1/ocr`（mit48px）；另有 Windows 本地 OCR（WinRT）与通用 HTTP OCR（可用于任意兼容服务，含 PaddleOCR 部署） |
| 图像擦除 | InpaintProvider | sidecar `/v1/inpaint`（lama_large_512px） |
| 翻译 | TranslationProvider | OpenAI 兼容 LLM（默认 `http://localhost:8080/v1`） |

> 当前 `wb_detector` / `wb_ocr` / `wb_inpaint` 三个下拉值只做持久化与展示，命令固定调用上述 `/v1/*` 路径，不按 provider 切换。
