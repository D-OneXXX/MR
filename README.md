# MangaReader

本地优先的 Windows 桌面漫画阅读器：Tauri 2 + React 19 + TypeScript + Tailwind v4 前端，
Rust 后端（SQLite 书库 / 三级图片缓存 / 翻译工作台 / sidecar 检测-OCR-擦除）。
当前版本 **0.12.1**（在线提纯引擎 + Telegram 公开频道直读）。

## 功能概览

- **书库**：文件夹 / zip / cbz 导入、扫描、拖放、多选、软删/彻底删除；合集按系列聚合；
  宽屏三栏（导航轨 + 封面画布 + 右侧 Inspector），窄屏覆盖式详情。
- **阅读器**：单页 / 双页 / 条漫；日式 RTL 与西式 LTR；缩放 / 平移 / Pinch / 双击重置；
  选区 OCR + 翻译；多页签（最多 5 个）；「下一话」无缝连看；HUD/Dock 按需唤醒。
- **在线直读**（实验开关）：JSON 清单、单页 HTML 图集、多话合集；系列与下一话链路；
  请求头默认按 origin 作用域发送；支持“仅驻留内存”的会话请求头。
- **在线提纯与自学习**：多层启发式过滤 Logo/广告/二维码/头像；站点模板与用户标记本地学习；
  阅读器内可标记非正文、在“已过滤杂图”抽屉恢复并自动放宽阈值。
- **Telegram 公开频道**：免登录解析相册、Telegraph 章节与 zip/cbz 附件；支持历史分页与
  CDN 临时链接过期自愈。
- **外部浏览器协同导入**：本地长驻回环桥接（127.0.0.1，单会话 token），用户在系统浏览器
  手动推送已渲染图片列表；不注入页面脚本、不采集 Cookie。
- **内嵌通用浏览器**：独立窗口下载 zip/cbz 后自动导入并设只读；远程页面无 IPC 权限。
- **系统代理**：一键读取环境变量或 Windows 注册表，只填表单不落库。
- **AI 流水线**：文本检测（ctd）→ OCR（mit48px）→ 翻译（OpenAI 兼容 LLM）→ 擦除（LaMa）；
  逐页工作台、整话批量预翻译、术语表、数据看板与服务状态。

## 文档

- [技术文档](docs/TECHNICAL.md) —— 架构、数据模型、命令契约、实现细节、测试与限制
- [v3 设计记录](docs/superpowers/specs/2026-10-20-v3-cockpit-design.md)
- [在线直读设计（第一阶段）](docs/superpowers/specs/2026-10-19-online-direct-reader-design.md)
- [Sidecar 接口契约](docs/sidecar-api.md)
- [真机冒烟清单](docs/smoke-test.md)
- [历史冒烟报告（2026-10-19）](docs/smoke-test-report-2026-10-19.md)

## 开发

```bat
sidecar\launch.bat        :: 检测/OCR/擦除服务（:8500，契约见 docs/sidecar-api.md）
npm run tauri dev         :: 主应用（前端 :1420）
```

翻译 LLM 为外部应用（默认 `http://localhost:8080/v1`），需自行启动并在设置中填写模型名。

## 测试

```bat
cd src-tauri && cargo test      :: 234 项（当前单元/集成测试总数）
npx tsc --noEmit
node scripts\verify-spread.mjs
node scripts\verify-region.mjs
```

## 待办 · 冻结功能池（本阶段禁止实现）

以下功能已评估并**冻结**，进入任何“打磨/优化”阶段都不许顺手实现：

- [ ] 标签系统（自定义分类/颜色标签）
- [ ] 跨设备同步（进度/书库云同步）
- [ ] 阅读统计分享（数据页导出/分享卡片）
- [ ] 漫画源订阅（自动抓取/RSS/站点插件；手动 URL 直读不在此列）
- [ ] 云端模型（把检测/OCR/擦除/翻译切到云端 API 的选项）

有新想法先进本清单排队，明确立项后再解冻。
