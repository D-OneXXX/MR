# Sidecar 接口契约(阶段三)

执行 agent 定义并文档化(路线图指派)。sidecar 是独立 Python 服务,承载 ctd / mit48px / lama 三个 torch 模型,对外提供本地 HTTP;Tauri 只做 HTTP 客户端,不打模型进安装包。

## 运行形态

- 代码:`sidecar/`(本仓库,不进安装包),**自包含**:模型推理代码已内联进 `sidecar/vendor/`(自 BallonsTranslator / manga-image-translator / comic-text-detector / lama 移植的最小子集),运行时不再依赖本机安装的 BallonsTranslator。
- 解释器:`sidecar\.venv`(首次运行 `setup.bat` 从系统 Python 3.10+ 创建,并安装 torch CPU 等依赖)。
- 模型:`sidecar\models\` 由 `download_models.py` 按需下载(约 700MB,一次性;`SIDECAR_MODELS` 可改路径),不打进安装包:
  - comictextdetector.pt(ctd)← HuggingFace `dreMaze/mit_models`
  - mit48pxctc_ocr.ckpt + alphabet-all-v5.txt ← HuggingFace `dreMaze/mit_models`(ocr-ctc.zip)
  - lama_large_512px.ckpt ← HuggingFace `dreMaze/AnimeMangaInpainting`
- 端口:`SIDECAR_PORT`(默认 **8500**)。设备:`SIDECAR_DEVICE`(默认 **cpu**;RTX 4060 8GB 上 Index-Translate Q4_K_M 已占 ~5.78GB,sidecar 默认 CPU,错峰时可切 cuda)。
- 许可提示:上游模型代码含 GPL-3.0(manga-image-translator 系),sidecar 作为独立本地组件与 Tauri 应用分离;本地自用无分发问题,对外分发前需复核许可。
- 启动:首次 `sidecar\setup.bat` → 之后 `sidecar\launch.bat`。

## 契约(全部 JSON,UTF-8;错误一律 `{"error": "<中文可读>"}`)

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| GET `/health` | – | `{ok: bool, device: "cpu"\|"cuda", models: {detector: "ready"\|"loading"\|"not_loaded"\|"missing", ocr: …, inpaint: …}, detail?: string}` |
| POST `/v1/detect` | `{image: "<b64 png>"}` | `{boxes: [{x, y, w, h, score, vertical}], elapsedMs}` |
| POST `/v1/ocr` | `{image: "<b64 png>", boxes: [{x, y, w, h, vertical?}]}` | `{results: [{x, y, w, h, text}], elapsedMs}` |
| POST `/v1/inpaint` | `{image: "<b64 png>", boxes: [{x, y, w, h}]}` | `{image: "<b64 png>", elapsedMs}` |

- 坐标:均为**所提交图像的绝对像素**(整数,≥0);缩放/归一化是调用方(Rust/前端)的责任。
- `vertical`:框内文字是否竖排(日漫常见)。detect 会返回;ocr 缺省按 `h > w` 推断。**mit48px 是单行模型**——多行气泡必须按行拆框传入,这正是工作台"两步工作流 + 人工修框"存在的原因。
- 状态码:`200` 成功;`400` 请求形状错误(error 说明);`503` 模型未加载/缺失(error 说明如何修:如"模型缺失:<路径>,请放置模型文件或设 BT_ROOT");`500` 推理异常(含中文摘要,不静默)。
- 幂等性:全部无状态;翻译不做(翻译走 Index-Translate,由 Tauri 直连)。
- 超时:调用方控制(Rust 侧按设置 `sidecarTimeoutS`,默认 120s,lama CPU 可能较慢)。
- 烟测:`sidecar\smoke_test.py`(合成图直驱 pipeline,验证模型接线)+ `/health` HTTP 冒烟。

## 显存/内存预算(验收项)

- 默认 CPU 推理:进程内存 ≈ ctd ~0.5GB + mit48px ~0.3GB + lama ~1.5GB 峰值,与 LLM 5.78GB 不冲突。
- `SIDECAR_DEVICE=cuda` 时三者合计 < 2GB 显存,仅在用户确认 LLM 空闲时启用;`/health` 上报 device 供设置页展示。

## 与阅读器 provider 槽位的对应

| 工作台下拉框 | 槽位 | 实现 |
|---|---|---|
| 文本检测 | TextDetector | sidecar `/v1/detect`(ctd) |
| OCR | OcrProvider | sidecar `/v1/ocr`(mit48px);可选项:PaddleOCR HTTP、Windows 本地 OCR(已实现) |
| 图像擦除 | InpaintProvider | sidecar `/v1/inpaint`(lama_large_512px) |
| 翻译 | TranslationProvider | Index-Translate `http://localhost:8080/v1`(OpenAI 兼容,已实现) |
