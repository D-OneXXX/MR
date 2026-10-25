## 关联 Issue

Closes #

## 变更范围

<!-- 只描述本 Issue 范围内的改动。 -->

## 不包含

<!-- 明确列出本次不处理的相邻问题，避免范围膨胀。 -->

## 验证

- [ ] 已运行与本变更相关的定向测试
- [ ] 已运行 `npm run version:check`
- [ ] 已运行 `npm run test:version`
- [ ] 已运行 `npm run test:governance`
- [ ] 涉及前端时已运行 `npx tsc --noEmit` 与 `npm run build`
- [ ] 涉及 Rust 时已运行 `cargo test --lib`
- [ ] 涉及 Linux cfg 时已运行 `cargo check --all-targets` / clippy
- [ ] 涉及界面时已运行静态 QA 或完整 QA

```text
实际执行的命令与结果写在这里；不要只写“已测试”。
```

## 数据与隐私

- [ ] 不涉及书库、阅读进度、SQLite、备份、缓存或文件删除
- [ ] 涉及数据时已补迁移/恢复/升级测试
- [ ] 不新增未脱敏的路径、书名、Cookie、Token、请求头或完整 URL 日志
- [ ] 不改变 `session_online_headers` 仅驻留内存的约束

## 发布影响

- [ ] 不需要版本 bump
- [ ] 需要版本 bump，已用 `npm run version:sync -- X.Y.Z` 同步全部版本文件
- [ ] 影响 Updater / 签名 / 安装器 / 公开更新通道（需要单独发布审批）
- [ ] 影响 Windows / Linux 发布通道（说明具体影响）

## 风险与回滚

<!-- 最坏情况是什么；如何停止或回滚；是否需要用户数据保护措施。 -->

## Checklist

- [ ] PR 只包含关联 Issue 的范围，没有混入无关改动
- [ ] 一个文件只有一个写者，未覆盖他人未提交修改
- [ ] 未删除测试、未降低断言、未静默跳过失败检查
- [ ] 涉及 UI 时六语字典、双主题与 QA 已同步
- [ ] 涉及后端命令/数据结构时 `lib.rs` 与 `docs/TECHNICAL.md` 已同步
- [ ] 未在 Phase 1–3 推送 `v*` 发布 Tag
