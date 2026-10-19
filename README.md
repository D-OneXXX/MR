# MangaReader

本地优先的漫画阅读器：Tauri 2 + React + TypeScript 前端，Rust 后端（SQLite 书库 /
三级图片缓存 / 翻译工作台 / sidecar 检测-OCR-擦除）。

## 文档

- [技术文档](docs/TECHNICAL.md)
- [Sidecar 接口契约](docs/sidecar-api.md)
- [真机冒烟清单](docs/smoke-test.md)
- [最近冒烟报告（2026-10-19）](docs/smoke-test-report-2026-10-19.md)

## 开发

```
sidecar\launch.bat        # 检测/OCR/擦除服务（:8500，契约见 docs/sidecar-api.md）
npm run tauri dev         # 主应用（前端 :1420）
Index-Translate           # 翻译 LLM（:8080，外部应用，用户自行启动）
```

测试：`cargo test`（src-tauri 下，含 200 页内存验收）；前端 `npx tsc --noEmit`。

## 待办 · 冻结功能池（本阶段禁止实现）

以下功能已评估并**冻结**，进入任何"打磨/优化"阶段都不许顺手实现：

- [ ] 标签系统（自定义分类/颜色标签）
- [ ] 跨设备同步（进度/书库云同步）
- [ ] 阅读统计分享（数据页导出/分享卡片）
- [ ] 漫画源订阅（在线源抓取、RSS、站点插件）
- [ ] 云端模型（把检测/OCR/擦除/翻译切到云端 API 的选项）

有新想法先进本清单排队，明确立项后再解冻。
