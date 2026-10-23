# MangaReader QA 摘要（v0.14.0）

独立 QA 使用隔离数据目录与本地 stub，不触碰真实书库、不写用户数据。

## 最近一次运行

- 版本：`0.14.0`
- QA：**206/206（100%）**
- 运行时缺陷：P0=0 · P1=0 · P2=0 · P3=0
- 静态审计 backlog：**7 条 P3**（P0/P1/P2=0）
- Rust 单测：**233 passed**
- `tsc` / `npm run build` / 版本门禁：通过

生成的逐条报告在 `tests/qa/reports/latest.md`（构建产物，不提交）。

## 覆盖范围

- 静态与版本红线：三端版本、构建注入、错误行号、移除路由/素材扫描、无 Python/sidecar 自启。
- 视觉：双主题 × 六语种、900×600、溢出、Tabs 单行、对比度（含半透明背景合成）。
- 阅读器：文件夹/ZIP/CBZ、中文/空格/损坏压缩包、自然序（20 页无补零 CBZ、混合扩展名、
  多级目录、中文章节名）、单/双页/条漫、125 页快速滚动、宽度 50–150%、进度恢复。
- 在线：30 页正文 + Logo/广告/二维码/头像；跨页/横幅；推广图标记 → 新章节拦截 → 恢复；
  规则统计/导出；严格 Referer + 桌面 Chrome UA 防盗链图床；Telegram 频道分页、相册、
  Telegraph、压缩包、CDN 403 自愈、浏览器章节面板。
- 缓存：diskCacheBudgetMb 500–10240 持久化/即时生效、render + online 双 L2 写入、
  一键清理释放磁盘且保留 SQLite 阅读进度、清理后重新取页、设置页滑杆/进度/按钮可见。
- 隐私：路径/漫画名/Cookie/Token、JSON 引号键、诊断描述进入 Prompt 前脱敏、URL query 脱敏。
- 韧性：真实主线程死锁、独立恢复窗、重载视图、安全模式、连点、睡眠/唤醒不误判。
- 更新：SemVer 严格性、补丁/全量回退、清单/安装包签名、非 ASCII 路径安装脚本。

## 本轮（0.14.0）修复与加固

- 新增统一磁盘缓存：渲染成品 + 在线原图共用 500 MB–10 GB 软上限，读取刷新 mtime，
  启动/写盘 256 MB/每 5 分钟/退出时 LRU 淘汰；设置页可查看分项并一键清理。
- 在线原图按 `book + URL + Referer` SHA-256 落盘，路径不含原始 URL；不同书/Referer 隔离。
- 渲染缓存目录对非 64 位 hex 的 book_id 再哈希，阻止 `..`/绝对路径越出缓存根。
- 缓存根环境变量拒绝相对路径、文件系统根与数据目录祖先；清理命令不会误删 `library.db`。
- L2 成品 JPEG 命中先验格式；坏缓存删除并回退全管线，不再永久毒化页面/切片。
- 在线 UA 改为标准桌面 Chrome；单页请求保持章节/清单 Referer 与 Origin，复用代理。
- 自然序新增 `natural_cmp_path`：文件夹、ZIP/CBZ、嵌套目录、混合扩展名与章节列表统一；
  前端章节兜底排序启用 numeric collation。
- 清除在线痕迹后同步作废常开源句柄，避免继续复用内嵌旧 Cookie 的 transport。
- 启动链路确认无 Python/sidecar/8500 端口自启；删除遗留 `.gitignore` sidecar 条目。

## 剩余 P3 backlog

仅 7 条低优先级：条漫坏图重试、连点元素签名、构建哈希漂移、在线 link-local 拦截、
状态胶囊 tab、i18n 复数/小数、品牌残留 token。均不影响当前验收。

## 复现

```bat
cd src-tauri && cargo test --lib
npx tsc --noEmit
npm run test:version
node tests\qa\run-qa.mjs
```

真实 Telegram/第三方站点仍建议用你有权访问的频道手动冒烟；自动 QA 使用本地确定性预览 stub。
