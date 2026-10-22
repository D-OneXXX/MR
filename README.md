# MangaReader

本地优先的 Windows 桌面漫画阅读器：Tauri 2 + React 19 + TypeScript 5.8 + Rust + SQLite。
当前版本 **0.13.0**。不登录、不上传书库、不内置漫画源订阅。

## 功能

- **书库**：文件夹 / zip / cbz 导入与递归扫描；合集按系列聚合；宽屏三栏（导航轨 + 封面 + Inspector），
  窄屏 Sheet；搜索、来源筛选、软删与彻底删除。
- **阅读器**：单页 / 双页 / 条漫；RTL / LTR；缩放、平移、双击重置；多页签；下一话无缝连看；
  条漫虚拟切片、滚动锚定和请求合流。
- **在线直读**：JSON 清单、单页 HTML 图集、多话合集；系列 / 下一话链路；代理与会话级请求头
  （仅内存，不落库）。
- **在线图片提纯**：URL / DOM / 尺寸 / 主序列聚类多阶段过滤；站点档案与用户规则本地学习；
  阅读器内可标记非正文、在过滤抽屉恢复并自动放宽阈值。
- **Telegram 公开频道**：免登录解析相册、Telegraph 章节、zip/cbz 附件；历史分页；
  CDN 临时链接过期后按消息锚点自愈。
- **内嵌浏览器**：独立无 IPC 权限 WebView；下载 zip/cbz 自动导入并设为只读。
- **更新与版本**：SemVer 单一事实源；PATCH 优先补丁、MINOR 可补丁、MAJOR 仅全量；
  清单与安装包签名校验；非 ASCII 路径兼容。
- **隐私与韧性**：诊断包 / Prompt 会脱敏路径与凭据；心跳看门狗、独立恢复窗口、安全模式；
  不静默重启、不后台上传。

## 文档

- [技术文档](docs/TECHNICAL.md)
- [QA 报告摘要](docs/QA.md)
- [真机冒烟清单](docs/smoke-test.md)

## 开发

```bat
npm install
npm run tauri dev       :: 前端 :1420 + Tauri 桌面窗口
npm run build           :: 版本门禁 + tsc + Vite 构建
```

版本号只改 `package.json`，然后运行：

```bat
npm run version:sync -- 0.13.1
npm run version:check
```

## 测试

```bat
cd src-tauri && cargo test --lib
npx tsc --noEmit
node tests\qa\run-qa.mjs
```

QA 使用隔离数据目录与本地 stub，不触碰真实用户书库。

## 冻结功能池

以下能力不在当前范围：

- 标签系统、跨设备同步、阅读统计分享
- 漫画源订阅 / RSS / 站点插件（手动 URL 与 Telegram 公开预览不在此列）
- 云端 OCR / 翻译 / 图像处理
