<p align="center">
  <img src="docs/assets/logo.png" width="96" height="96" alt="Moyu 图标">
</p>

<h1 align="center">Moyu</h1>

<p align="center">
  <strong>本地优先的 Windows / Linux 桌面漫画阅读器。</strong><br>
  Moyu 是一款免费的桌面漫画阅读与书库管理软件。<br>
  书库留在你的磁盘上。无账号、无云端书库、不内置漫画源。
</p>

<p align="center">
  <a href="https://github.com/D-OneXXX/Moyu/releases">下载</a>
  ·
  <a href="README.md">English</a>
  ·
  <a href="docs/ARCHITECTURE.md">架构说明</a>
  ·
  <a href="https://github.com/D-OneXXX/Moyu/issues">支持</a>
</p>

<p align="center">
  <img alt="Windows 与 Linux" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-38A8F8">
  <img alt="PolyForm 非商业许可 1.0.0" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-09090B">
</p>

## 产品预览

<p align="center">
  <img src="docs/assets/screenshots/library.png" width="49%" alt="Moyu 书库，展示三本合成示例书">
  <img src="docs/assets/screenshots/settings.png" width="49%" alt="Moyu 外观与语言设置">
</p>
<p align="center">
  <img src="docs/assets/screenshots/reader.png" width="82%" alt="Moyu 阅读器，展示原创合成漫画页面">
</p>
<p align="center">
  <sub>截图来自真实应用，使用隔离的演示书库与原创合成示例页面；不包含任何个人书库数据。</sub>
</p>

## 功能

- **书库留在本地。** 导入文件夹、ZIP、CBZ 或本地 PDF；递归扫描、按系列聚合章节、搜索与筛选，
  不需要把书库发到任何服务器。
- **按自己的方式阅读。** 单页、双页与连续条漫模式；RTL/LTR 方向；缩放与平移；
  多页签；下一话无缝连看。
- **PDF 原地阅读。** 本地 PDF 在同一个阅读器里打开，支持翻页、缩放、适应页面/适应宽度，
  并记住阅读位置。渲染完全由随包内置的 PDF 引擎在本机完成——不上传、不联网。
- **从上次的位置继续。** 记住阅读进度与条漫滚动位置；源文件移动后可重新定位，
  已读进度、条漫偏移与阅读统计都会保留。
- **自然排序。** 页码与章节标题按数字段排序，而不是按原始文件名排序；
  文件夹和压缩包内的 `1, 2, 10` 不会乱序。
- **按你的条件在线阅读。** 打开受支持的 JSON 清单或 HTML 图集 URL，或浏览公开
  Telegram 频道。会话请求头可以只驻留内存，绝不写入书库数据库或日志。
- **为超大图片设计的阅读器。** 超高条漫页面先切片再渲染，在桌面 WebView 中也能稳定阅读。
- **本地缓存与备份。** 可配置的磁盘缓存限制派生图片占用；导出 `.mrbackup`
  可把书库元数据、进度、统计和偏好迁移到另一台机器。
- **六种界面语言与双主题。** English、简体中文、繁體中文、Español、日本語、한국어；
  明亮、深色或跟随系统。

## 支持平台

| 平台 | 安装包 | 说明 |
|---|---|---|
| **Windows x64** | NSIS 安装器 | 主力平台；支持 `.cbz` / `.zip` 文件关联与单实例唤醒。 |
| **Linux x86_64** | `.deb`、`.rpm`、`.AppImage` | 长期稳定通道，只推送高危安全与崩溃修复。系统包安装不会由应用原地自我替换；AppImage 可使用应用内更新。 |

macOS 与 ARM64 构建不在当前发布范围内。

## 下载

正式构建通过 GitHub Releases 分发：

**[查看 Releases →](https://github.com/D-OneXXX/Moyu/releases)**

一次发布通常包含：

- Windows：NSIS 安装器。
- Linux：`.deb`、`.rpm` 与 `.AppImage`。
- Tauri 更新清单与签名文件，与安装包一起发布。

如果暂时没有公开构建，可使用下方开发说明从源码构建。

## 安装

### Windows

1. 从最新 Release 下载 NSIS 安装器。
2. 运行安装器，选择安装范围与语言。
3. 启动 **Moyu**，添加文件夹或压缩包，然后选择一本书。

Windows 安装器**未做 Authenticode 代码签名**，SmartScreen 可能弹出提示；运行前请确认
安装器来自本仓库的 Releases 页面。更新包使用独立的 Tauri 更新签名。

### Linux

- 使用发行版包管理器安装 `.deb` 或 `.rpm`。
- AppImage 需要先赋予执行权限（`chmod +x MangaReader*.AppImage`），然后直接运行。
- 系统包安装不会由应用原地替换；请通过包管理器安装更新。AppImage 可使用应用内更新。

Windows 的书库数据位于 `%APPDATA%\com.local.manga-reader`，缓存位于
`%LOCALAPPDATA%\com.local.manga-reader`。具体数据/缓存位置可在
**设置 → 存储与数据** 查看。卸载可通过 Windows **设置 → 应用** 或 Linux 包管理器完成；
如需同时删除本地元数据与进度，请手动移除数据目录。

## 名称与升级兼容性

应用内名称是 **Moyu**。对于已有安装，安装器的产品身份、`.cbz` / `.zip` 文件关联的注册名、
数据目录（`com.local.manga-reader`）、更新签名与更新端点以及部分产物文件名会保留旧名
**MangaReader**，以便升级、既有文件关联与已有用户数据保持完整。

## 快速开始

1. 点击 **添加文件夹** 或 **添加书籍**，选择文件夹、ZIP、CBZ 或 PDF 文件。
2. 点击封面查看详情，双击或按 **Shift+Enter** 开始阅读。
3. 在阅读器中切换单页、双页或条漫布局。
   PDF 始终使用单页 PDF 版式，并提供「适应页面 / 适应宽度」。
4. 在 **设置 → 常规与外观** 中调整主题、界面语言与阅读偏好。
5. 如需在线阅读，使用浏览器/在线入口打开你有权访问的 URL。
   Moyu 不内置漫画源或订阅列表。

## 配置

- **外观与语言** — 明亮、深色或跟随系统；六种界面语言。
- **存储与数据** — 缓存占用与上限、备份导出、清理。
- **网络与来源** — 代理模式、在线阅读控制、请求头作用范围。
- **隐私与安全** — 本地数据政策、诊断与安全控制。
- **关于与维护** — 版本、构建来源、更新与支持入口。

在线会话请求头可以限制为仅驻留内存，不写入 SQLite、日志、备份文件或诊断包。

## 常见问题

**Moyu 会上传我的书库吗？**

不会。书库数据库、进度、缓存与阅读统计都留在本机；没有账号体系或云同步。

**支持哪些格式？**

图片文件夹、ZIP、CBZ 与本地 PDF。其他压缩格式不在当前范围内。

**支持带密码的 PDF 吗？**

不支持。带口令的 PDF 会被识别并给出明确提示；Moyu 既不询问口令，也不保存口令。
请先去掉口令再导入。

**打开 PDF 会联网吗？**

不会。文件从本机读取，由随包内置的 PDF 引擎在应用窗口内渲染。关闭阅读器只会释放当前
这份文档的引用，文档本身可能仍留在容量受限的缓存里（最多同时保留 4 份，每份一个独立
渲染线程）；超出容量后按最近最少使用淘汰，被淘汰的文档与其渲染线程会真正释放。
文档内嵌脚本不会被执行，PDF 也不能让应用去拉取外部资源。

**导入后移动了书，进度会丢吗？**

不会。使用失效路径重定位流程，已有进度、条漫位置和阅读统计都会保留。

**数据存在哪里？**

Windows 书库数据在 `%APPDATA%\com.local.manga-reader`，缓存在
`%LOCALAPPDATA%\com.local.manga-reader`。应用内 **存储与数据** 设置会显示实际位置。

**更新如何工作？**

打开 **设置 → 关于与维护** 手动检查更新。应用不会静默重启或强制切换阅读模式。
Windows 走常规发布通道；Linux 走高危修复通道。

**为什么 Windows SmartScreen 会警告？**

Windows 安装器未做 Authenticode 代码签名。它和更新包签名是两套独立机制，
更新签名由应用自身校验。

**内置漫画源吗？**

不内置。你提供本地文件或你有权访问的 URL；项目不附带出版社目录或汉化源。

**如何卸载？**

Windows 使用 **设置 → 应用**，Linux 使用包管理器。本地数据不会自动删除；
如需彻底清理，请手动移除数据目录。

## 支持

- 问题与功能请求：[GitHub Issues](https://github.com/D-OneXXX/Moyu/issues)
- 安全报告：[GitHub Security Advisories](https://github.com/D-OneXXX/Moyu/security/advisories/new)

报告问题时请附上应用版本、操作系统、**关于与维护** 中显示的构建来源，以及复现步骤。
发布日志或截图前，请移除个人路径、书名、Cookie、Token 和完整 URL。

## 许可证

Moyu 可免费用于个人及其他非商业用途，许可为 **PolyForm Noncommercial License 1.0.0**。
项目属于**源码可见**，**不是 OSI 开源项目**；本许可证不授予商业使用权。

- [LICENSE](LICENSE)
- [NOTICE.md](NOTICE.md) — 必需声明、构建来源指纹与更新通道
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — 字体、图标与依赖声明

## 语言

- 英文（规范版本）：[README.md](README.md)
- 简体中文（本文件）

应用界面还包含繁體中文、Español、日本語与한국어。

## 开发

要求：Node.js 22+、稳定版 Rust 工具链、Windows WebView2，以及 Tauri 2 在 Linux 上常用的
构建依赖。

```bash
npm install
npm run tauri dev     # Vite :1420 + 桌面窗口
npm run build         # 版本门禁 + TypeScript + 生产前端构建
```

```bash
npx tsc --noEmit
cargo test --lib --manifest-path src-tauri/Cargo.toml
node tests/qa/run-qa.mjs --suite=static
```

QA 测试框架使用隔离的数据与缓存目录启动应用，**不要指向真实书库**。完整套件用
`node tests/qa/run-qa.mjs`（需要 Node.js 22+），`--suite=static` 是快速门禁；框架会隔离应用数据
目录、渲染与在线缓存目录以及 WebView2 用户目录。运行架构与数据存放位置见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

问题反馈与发布反馈欢迎提交到 Issue 跟踪器；安全问题请遵循 `SECURITY.md`。

---

Moyu 不隶属于任何漫画出版社、汉化组或在线来源。你需对自己导入或访问的内容负责。
