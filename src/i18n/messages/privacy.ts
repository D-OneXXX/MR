/**
 * Privacy statement, first-run acknowledgement and local security audit strings.
 * Owned by the privacy feature. All six objects must stay in sync.
 */
const zhCN = {
  "privacy.tab": "隐私安全",
  "privacy.title": "隐私与安全",
  "privacy.description":
    "Moyu 是本地优先的阅读器：书库、进度、统计与缓存都在本机。下面列出数据边界，并提供真实的本机安全自检。",
  "privacy.badge": "Local-first",
  "privacy.statement.title": "隐私承诺",
  "privacy.statement.summary":
    "没有账户，没有后台遥测，也不会把阅读内容、书库或统计数据上传到任何服务器。",
  "privacy.storage.title": "本地存储项",
  "privacy.storage.books":
    "书库索引、封面与书籍元数据，保存在本机 SQLite（library.db）。",
  "privacy.storage.progress":
    "阅读进度、阅读历史与统计，同样只写入本机 SQLite。",
  "privacy.storage.cache":
    "页面、缩略图、条漫切片与在线原图缓存，保存在本机应用数据目录。",
  "privacy.storage.settings":
    "主题、界面语言、阅读偏好与更新偏好，保存在本机 SQLite 或 localStorage。",
  "privacy.network.title": "联网触发项",
  "privacy.network.online":
    "在线 URL 直读与内嵌浏览器：仅访问你主动输入的目标站点；不注入采集脚本，也不主动采集或导出第三方 Cookie。站点 Cookie 由隔离 WebView 管理，可随时一键擦除。",
  "privacy.network.updates":
    "检查软件更新：仅在你配置更新清单地址后，访问该 HTTPS 清单与安装包地址。",
  "privacy.network.none": "除以上两项外，应用不发起后台网络请求。",
  "privacy.dialog.title": "欢迎使用 Moyu",
  "privacy.dialog.subtitle": "开始之前，用半分钟了解你的数据边界。",
  "privacy.dialog.localTitle": "100% 本地",
  "privacy.dialog.localBody":
    "书库、阅读进度、统计与图片缓存都只保存在这台设备上。",
  "privacy.dialog.networkTitle": "只在必要时联网",
  "privacy.dialog.networkBody":
    "只有你主动使用在线直读、内嵌浏览器，或配置并检查软件更新时才会发起网络请求。",
  "privacy.dialog.noTelemetry":
    "没有账户、没有遥测、没有静默上传。",
  "privacy.dialog.ack": "我知道了",
  "privacy.dialog.openSettings": "查看隐私与安全",
  "privacy.dialog.policyVersion": "声明版本 {version}",
  "privacy.dialog.close": "关闭隐私声明",
  "privacy.statement.showDialog": "重新查看启动声明",
  "privacy.dialog.reopen": "隐私声明",
  "privacy.audit.title": "本地安全检查",
  "privacy.audit.description":
    "读取当前构建配置、窗口权限、网络设置与缓存状态；检查只在本机完成，结果不会上传。",
  "privacy.audit.run": "一键安全自检",
  "privacy.audit.running": "正在检查…",
  "privacy.audit.checkedAt": "检查于 {time}",
  "privacy.audit.overall.pass": "安全状态良好",
  "privacy.audit.overall.warn": "有需要注意的项目",
  "privacy.audit.overall.fail": "存在高风险项目",
  "privacy.audit.overall.unknown": "尚未检查",
  "privacy.audit.update.title": "更新包签名与完整性",
  "privacy.audit.update.pass":
    "已配置 Minisign 公钥；SHA-256 与签名在安装前强制校验。",
  "privacy.audit.update.warn":
    "SHA-256 已强制校验，但当前构建未配置签名公钥；非本机更新会被拒绝。",
  "privacy.audit.update.httpsWarn":
    "更新源未使用 HTTPS，仅本机回环调试允许。",
  "privacy.audit.update.fail":
    "更新地址无效或未使用 HTTPS（本机回环除外）。",
  "privacy.audit.update.notConfigured":
    "尚未配置更新清单地址；不会发起更新请求。",
  "privacy.audit.isolation.title": "在线源与 WebView 隔离",
  "privacy.audit.isolation.pass":
    "内嵌浏览器为独立 WebView，未获得 Tauri 能力；外部页面无法调用本地命令。",
  "privacy.audit.isolation.warn":
    "窗口能力已隔离，但主界面未配置 CSP；建议在发布前收紧。",
  "privacy.audit.isolation.fail":
    "检测到远程 WebView 能力或远程 IPC 放行，请立即修复。",
  "privacy.audit.network.title": "网络与代理安全",
  "privacy.audit.network.direct":
    "当前为直连；在线请求支持并优先使用 HTTPS。",
  "privacy.audit.network.proxy":
    "当前代理：{proxy}。请只使用你信任的代理。",
  "privacy.audit.network.insecure":
    "当前代理不是 HTTPS/加密代理，流量可能以明文经过代理。",
  "privacy.audit.network.invalid":
    "代理地址格式无效，请先在在线源设置中修正。",
  "privacy.audit.storage.title": "本地存储与缓存",
  "privacy.audit.storage.summary":
    "图片缓存 {memory}，磁盘渲染缓存 {disk}；会话请求头仅驻留内存。",
  "privacy.audit.storage.fail": "无法读取缓存状态。",
  "privacy.audit.details": "证据详情",
  "privacy.audit.evidence.capabilities": "能力窗口：{value}",
  "privacy.audit.evidence.remote": "远程能力：{value}",
  "privacy.audit.evidence.csp": "CSP：{value}",
  "privacy.audit.evidence.signature": "签名公钥：{value}",
  "privacy.audit.evidence.https": "HTTPS：{value}",
  "privacy.audit.loopback": "本机回环（允许）",
  "privacy.audit.evidence.webviews": "活动 WebView：{value}",
  "privacy.audit.evidence.sha": "SHA-256：{value}",
  "privacy.audit.evidence.keySource": "公钥来源：{value}",
  "privacy.audit.keySource.config": "构建配置（tauri.conf.json）",
  "privacy.audit.keySource.build": "构建期注入（MR_UPDATE_PUBKEY）",
  "privacy.audit.keySource.none": "未配置",
  "privacy.audit.evidence.mode": "连接模式：{value}",
  "privacy.audit.evidence.scheme": "代理协议：{value}",
  "privacy.audit.evidence.sessionHeaders": "内存会话请求头：{value}",
  "privacy.audit.evidence.memoryBytes": "内存缓存：{value} B",
  "privacy.audit.evidence.diskBytes": "磁盘缓存：{value} B",
  "privacy.audit.enabled": "已启用",
  "privacy.audit.disabled": "未启用",
  "privacy.audit.direct": "直连",
  "privacy.audit.proxyMode": "代理",
  "privacy.audit.clear": "擦除在线痕迹与缓存",
  "privacy.audit.clearing": "正在擦除…",
  "privacy.audit.clearHint":
    "清除 WebView Cookie 与站点存储、页面/缩略图/条漫缓存，并释放内存中的会话请求头。本地书库与阅读进度保留。",
  "privacy.audit.clearTitle": "清除在线痕迹？",
  "privacy.audit.clearBody":
    "所有站点将退出登录，图片缓存会被清空。书库、阅读进度与本地设置不会删除。",
  "privacy.guard.title": "卡死保护与安全模式",
  "privacy.guard.description":
    "心跳看门狗与暴躁点击感知为常开保护；安全模式可在此手动进入或退出。",
  "privacy.guard.alwaysOn": "常开保护",
  "privacy.guard.watchdog": "心跳看门狗",
  "privacy.guard.watchdogDesc":
    "界面无响应时仅打开独立恢复窗口等待你选择，绝不自动重建主窗口。",
  "privacy.guard.rage": "暴躁点击感知",
  "privacy.guard.rageDesc":
    "连续快速点击会被视为卡死信号，只用于唤起恢复窗口，不做任何自动操作。",
  "privacy.guard.safeModeRow": "安全模式",
  "privacy.guard.safeModeDesc":
    "进入后暂停在线功能并锁定基础单页模式，用于排查问题；退出会重启应用。",
  "privacy.guard.safeModeOn": "已激活",
  "privacy.guard.safeModeOff": "未激活",
  "privacy.guard.enter": "手动进入安全模式",
  "privacy.guard.entering": "正在进入…",
  "privacy.audit.clearAction": "立即清除",
  "privacy.audit.cleared":
    "已清理 {webviews} 个 WebView 的浏览数据，并释放 {size} 缓存。",
  "privacy.audit.error": "安全自检失败：{detail}",
  "privacy.audit.retry": "重新检查",
  "privacy.audit.noUpload": "检查结果只在本机显示，不会上传。",
  "privacy.status.pass": "通过",
  "privacy.status.warn": "注意",
  "privacy.status.fail": "风险",
  "privacy.status.unknown": "未知",
  "privacy.toast.cleared": "在线痕迹与缓存已清理。",
  "privacy.toast.clearFailed": "清理失败：{detail}",
  "privacy.toast.auditFailed": "安全自检失败：{detail}",
  "privacy.security.windowsTitle": "Windows 安全与更新完整性",
  "privacy.security.windowsBody":
    "更新包先下载到系统临时目录，再通过 SHA-256 与 minisign 签名校验；只有全部校验通过，才会由标准安装器以事务方式替换正在运行的程序，绝不在内存中覆写运行中的可执行文件。任何一项校验失败都会立即拒绝安装，并删除已下载的半成品文件。",
  "privacy.security.windowsBadgeIntegrity": "SHA-256 + Minisign 校验",
  "privacy.security.windowsBadgeTransaction": "安装器事务替换",
  "privacy.security.windowsSmartScreenTitle": "SmartScreen 拦截与放行",
  "privacy.security.windowsSmartScreen":
    "本地构建与自签名构建没有受信任的代码签名，Windows SmartScreen 会把它们当作「不受信任的应用」拦下，这是预期行为，不是病毒提示。要放行请按下面的顺序操作；若你更信任正式发布的签名版本，请改用官方发行渠道获取。",
  "privacy.security.windowsStepLaunch": "双击安装包",
  "privacy.security.windowsStepInfo": "更多信息",
  "privacy.security.windowsStepRun": "仍要运行",
  "privacy.security.windowsTempTitle": "下载与解压目录",
  "privacy.security.windowsTemp":
    "更新包请下载并解压到系统临时目录或应用专属的 staging 目录，不要放在「下载」文件夹里。下载目录会被实时扫描，也常被同步盘接管，落在这里的安装包更容易被误判或直接锁定。",
  "privacy.security.windowsAllowlistTitle": "杀毒软件白名单",
  "privacy.security.windowsAllowlist":
    "可以把应用数据目录与缓存目录一起加入杀毒软件的排除项或白名单。数据目录存放书库数据库（library.db）、日志与下载文件，缓存目录存放图片与渲染缓存；两者都不保存任何账号凭据。加入白名单后，日常扫描就不会再反复锁定这些文件。",
} as const;

const en: Record<keyof typeof zhCN, string> = {
  "privacy.tab": "Privacy",
  "privacy.title": "Privacy & security",
  "privacy.description":
    "Moyu is local-first: your library, progress, stats and cache stay on this device. Here is the data boundary, plus a real local security self-check.",
  "privacy.badge": "Local-first",
  "privacy.statement.title": "Privacy promise",
  "privacy.statement.summary":
    "No account, no background telemetry, and no upload of reading content, library data or statistics.",
  "privacy.storage.title": "Stored locally",
  "privacy.storage.books":
    "Library index, covers and book metadata in the local SQLite database (library.db).",
  "privacy.storage.progress":
    "Reading progress, history and statistics, also written only to local SQLite.",
  "privacy.storage.cache":
    "Page, thumbnail, webtoon tile and online-original caches in the local app data directory.",
  "privacy.storage.settings":
    "Theme, UI language, reading preferences and update preferences in local SQLite or localStorage.",
  "privacy.network.title": "When the network is used",
  "privacy.network.online":
    "Online URL reading and the embedded browser: only sites you enter yourself. No scraping scripts are injected and third-party cookies are never collected or exported by the app. Site cookies live in the isolated WebView and can be erased at any time.",
  "privacy.network.updates":
    "Update checks: only after you configure a manifest URL; only that HTTPS manifest and installer are contacted.",
  "privacy.network.none":
    "Beyond these two cases, the app makes no background network requests.",
  "privacy.dialog.title": "Welcome to Moyu",
  "privacy.dialog.subtitle":
    "Before you start, here is a 30-second overview of your data boundary.",
  "privacy.dialog.localTitle": "100% local",
  "privacy.dialog.localBody":
    "Your library, reading progress, statistics and image cache stay on this device.",
  "privacy.dialog.networkTitle": "Network only when needed",
  "privacy.dialog.networkBody":
    "Requests happen only when you use online reading, the embedded browser, or configure and check for updates.",
  "privacy.dialog.noTelemetry":
    "No account, no telemetry, no silent uploads.",
  "privacy.dialog.ack": "Got it",
  "privacy.dialog.openSettings": "Review privacy & security",
  "privacy.dialog.policyVersion": "Policy version {version}",
  "privacy.dialog.close": "Close privacy statement",
  "privacy.statement.showDialog": "Show the welcome statement again",
  "privacy.dialog.reopen": "Privacy statement",
  "privacy.audit.title": "Local security check",
  "privacy.audit.description":
    "Reads this build's configuration, window permissions, network settings and cache state. Everything stays on this device.",
  "privacy.audit.run": "Run security check",
  "privacy.audit.running": "Checking…",
  "privacy.audit.checkedAt": "Checked {time}",
  "privacy.audit.overall.pass": "Security looks good",
  "privacy.audit.overall.warn": "Some items need attention",
  "privacy.audit.overall.fail": "High-risk items found",
  "privacy.audit.overall.unknown": "Not checked yet",
  "privacy.audit.update.title": "Update signing and integrity",
  "privacy.audit.update.pass":
    "A Minisign public key is configured; SHA-256 and signatures are mandatory before install.",
  "privacy.audit.update.warn":
    "SHA-256 is enforced, but this build has no signing public key; non-local updates are refused.",
  "privacy.audit.update.httpsWarn":
    "The update source is not HTTPS; only local loopback debugging is allowed.",
  "privacy.audit.update.fail":
    "The update URL is invalid or not HTTPS (local loopback excepted).",
  "privacy.audit.update.notConfigured":
    "No update manifest is configured; no update requests will be made.",
  "privacy.audit.isolation.title": "Online source and WebView isolation",
  "privacy.audit.isolation.pass":
    "The embedded browser is a separate WebView with no Tauri capabilities; external pages cannot call local commands.",
  "privacy.audit.isolation.warn":
    "Window capabilities are isolated, but the main UI has no CSP; tighten it before release.",
  "privacy.audit.isolation.fail":
    "Remote WebView capabilities or remote IPC access were detected. Fix immediately.",
  "privacy.audit.network.title": "Network and proxy safety",
  "privacy.audit.network.direct":
    "Direct connection. Online requests support and prefer HTTPS.",
  "privacy.audit.network.proxy":
    "Current proxy: {proxy}. Only use a proxy you trust.",
  "privacy.audit.network.insecure":
    "The proxy is not HTTPS/encrypted; traffic may cross it in clear text.",
  "privacy.audit.network.invalid":
    "The proxy address is invalid; fix it in Online source settings first.",
  "privacy.audit.storage.title": "Local storage and cache",
  "privacy.audit.storage.summary":
    "Image cache {memory}; disk render cache {disk}. Session headers live only in memory.",
  "privacy.audit.storage.fail": "Could not read cache state.",
  "privacy.audit.details": "Evidence",
  "privacy.audit.evidence.capabilities": "Capability windows: {value}",
  "privacy.audit.evidence.remote": "Remote capabilities: {value}",
  "privacy.audit.evidence.csp": "CSP: {value}",
  "privacy.audit.evidence.signature": "Signing key: {value}",
  "privacy.audit.evidence.https": "HTTPS: {value}",
  "privacy.audit.loopback": "Local loopback (allowed)",
  "privacy.audit.evidence.webviews": "Active WebViews: {value}",
  "privacy.audit.evidence.sha": "SHA-256: {value}",
  "privacy.audit.evidence.keySource": "Signing key source: {value}",
  "privacy.audit.keySource.config": "Build config (tauri.conf.json)",
  "privacy.audit.keySource.build": "Build-time injection (MR_UPDATE_PUBKEY)",
  "privacy.audit.keySource.none": "Not configured",
  "privacy.audit.evidence.mode": "Connection mode: {value}",
  "privacy.audit.evidence.scheme": "Proxy scheme: {value}",
  "privacy.audit.evidence.sessionHeaders": "In-memory session headers: {value}",
  "privacy.audit.evidence.memoryBytes": "Memory cache: {value} B",
  "privacy.audit.evidence.diskBytes": "Disk cache: {value} B",
  "privacy.audit.enabled": "Enabled",
  "privacy.audit.disabled": "Disabled",
  "privacy.audit.direct": "Direct",
  "privacy.audit.proxyMode": "Proxy",
  "privacy.audit.clear": "Erase online traces and cache",
  "privacy.audit.clearing": "Erasing…",
  "privacy.audit.clearHint":
    "Clears WebView cookies and site storage, page/thumbnail/webtoon caches, and releases in-memory session headers. Your library and reading progress are preserved.",
  "privacy.audit.clearTitle": "Clear online traces?",
  "privacy.audit.clearBody":
    "All sites will be signed out and image caches cleared. Your library, reading progress and local settings are kept.",
  "privacy.guard.title": "Crash guard & safe mode",
  "privacy.guard.description":
    "The heartbeat watchdog and rage-click sensing are always-on protections; safe mode can be entered or exited here.",
  "privacy.guard.alwaysOn": "Always on",
  "privacy.guard.watchdog": "Heartbeat watchdog",
  "privacy.guard.watchdogDesc":
    "When the UI stops responding it only opens the independent recovery window and waits for your choice — it never rebuilds the main window on its own.",
  "privacy.guard.rage": "Rage-click sensing",
  "privacy.guard.rageDesc":
    "Rapid repeated clicks are treated as a hang signal and only summon the recovery window; no automatic action is taken.",
  "privacy.guard.safeModeRow": "Safe mode",
  "privacy.guard.safeModeDesc":
    "Entering pauses online features and locks the reader to basic single-page mode for troubleshooting; exiting reloads the app.",
  "privacy.guard.safeModeOn": "Active",
  "privacy.guard.safeModeOff": "Inactive",
  "privacy.guard.enter": "Enter safe mode manually",
  "privacy.guard.entering": "Entering…",
  "privacy.audit.clearAction": "Clear now",
  "privacy.audit.cleared":
    "Cleared browsing data from {webviews} WebView(s) and released {size} of cache.",
  "privacy.audit.error": "Security check failed: {detail}",
  "privacy.audit.retry": "Check again",
  "privacy.audit.noUpload":
    "Results are shown locally only and are never uploaded.",
  "privacy.status.pass": "Pass",
  "privacy.status.warn": "Attention",
  "privacy.status.fail": "Risk",
  "privacy.status.unknown": "Unknown",
  "privacy.toast.cleared": "Online traces and cache cleared.",
  "privacy.toast.clearFailed": "Cleanup failed: {detail}",
  "privacy.toast.auditFailed": "Security check failed: {detail}",
  "privacy.security.windowsTitle": "Windows security and update integrity",
  "privacy.security.windowsBody":
    "Update packages are downloaded to the system temp directory first, then verified with SHA-256 and a minisign signature. Only when every check passes does the standard installer replace the running program transactionally; the running executable is never overwritten in memory. If any check fails, the install is refused and the half-downloaded file is deleted.",
  "privacy.security.windowsBadgeIntegrity": "SHA-256 + Minisign verified",
  "privacy.security.windowsBadgeTransaction": "Transactional installer swap",
  "privacy.security.windowsSmartScreenTitle": "SmartScreen warnings and how to allow the app",
  "privacy.security.windowsSmartScreen":
    "Local and self-signed builds carry no trusted code signature, so Windows SmartScreen flags them as an unrecognized app. That is expected behaviour, not a malware warning. Allow it with the steps below; if you prefer a trusted signed release, get the app from the official release channel instead.",
  "privacy.security.windowsStepLaunch": "Double-click installer",
  "privacy.security.windowsStepInfo": "More info",
  "privacy.security.windowsStepRun": "Run anyway",
  "privacy.security.windowsTempTitle": "Download and extraction folders",
  "privacy.security.windowsTemp":
    "Download and unpack updates into the system temp directory or the app's own staging directory, not into the Downloads folder. Downloads is scanned in real time and is often synced to the cloud, so installers left there are more likely to be misclassified or locked outright.",
  "privacy.security.windowsAllowlistTitle": "Antivirus allowlist",
  "privacy.security.windowsAllowlist":
    "You can add both the app data folder and the cache folder to your antivirus exclusions or allowlist. The data folder holds the library database (library.db), logs and downloaded files; the cache folder holds image and render caches. Neither ever stores account credentials, and allowlisting them stops scheduled scans from repeatedly locking these files.",
};

const zhTW: Record<keyof typeof zhCN, string> = {
  "privacy.tab": "隱私安全",
  "privacy.title": "隱私與安全",
  "privacy.description":
    "Moyu 是本機優先的閱讀器：書庫、進度、統計與快取都留在這台裝置上。以下說明資料邊界，並提供實際的本機安全自我檢查。",
  "privacy.badge": "本機優先",
  "privacy.statement.title": "隱私承諾",
  "privacy.statement.summary":
    "沒有帳號、沒有背景遙測，也不會把閱讀內容、書庫資料或統計上傳到任何伺服器。",
  "privacy.storage.title": "本機儲存項目",
  "privacy.storage.books":
    "書庫索引、封面與書籍中繼資料，儲存在本機 SQLite（library.db）。",
  "privacy.storage.progress":
    "閱讀進度、閱讀紀錄與統計，同樣只寫入本機 SQLite。",
  "privacy.storage.cache":
    "頁面、縮圖、條漫切片與線上原圖快取，儲存在本機應用程式資料目錄。",
  "privacy.storage.settings":
    "主題、介面語言、閱讀偏好與更新偏好，儲存在本機 SQLite 或 localStorage。",
  "privacy.network.title": "連網觸發項目",
  "privacy.network.online":
    "線上網址直讀與內嵌瀏覽器：只造訪你主動輸入的目標網站；不注入擷取腳本，應用程式也不會主動蒐集或匯出第三方 Cookie。網站 Cookie 由隔離的 WebView 管理，可隨時一鍵擦除。",
  "privacy.network.updates":
    "檢查軟體更新：只在你設定更新清單網址後，存取該 HTTPS 清單與安裝程式網址。",
  "privacy.network.none":
    "除了上述兩種情況，應用程式不會發起背景網路請求。",
  "privacy.dialog.title": "歡迎使用 Moyu",
  "privacy.dialog.subtitle": "開始之前，花半分鐘了解你的資料邊界。",
  "privacy.dialog.localTitle": "100% 本機",
  "privacy.dialog.localBody":
    "書庫、閱讀進度、統計與圖片快取都只保存在這台裝置上。",
  "privacy.dialog.networkTitle": "只在必要時連網",
  "privacy.dialog.networkBody":
    "只有在你主動使用線上直讀、內嵌瀏覽器，或設定並檢查軟體更新時，才會發起網路請求。",
  "privacy.dialog.noTelemetry": "沒有帳號、沒有遙測、沒有暗中上傳。",
  "privacy.dialog.ack": "我知道了",
  "privacy.dialog.openSettings": "查看隱私與安全",
  "privacy.dialog.policyVersion": "聲明版本 {version}",
  "privacy.dialog.close": "關閉隱私聲明",
  "privacy.statement.showDialog": "重新查看啟動聲明",
  "privacy.dialog.reopen": "隱私聲明",
  "privacy.audit.title": "本機安全檢查",
  "privacy.audit.description":
    "讀取目前建置設定、視窗權限、網路設定與快取狀態；檢查只在本機完成，結果不會上傳。",
  "privacy.audit.run": "執行安全自我檢查",
  "privacy.audit.running": "正在檢查…",
  "privacy.audit.checkedAt": "檢查於 {time}",
  "privacy.audit.overall.pass": "安全狀態良好",
  "privacy.audit.overall.warn": "有需要注意的項目",
  "privacy.audit.overall.fail": "存在高風險項目",
  "privacy.audit.overall.unknown": "尚未檢查",
  "privacy.audit.update.title": "更新套件簽章與完整性",
  "privacy.audit.update.pass":
    "已設定 Minisign 公開金鑰；安裝前會強制驗證 SHA-256 與簽章。",
  "privacy.audit.update.warn":
    "SHA-256 已強制驗證，但目前建置未設定簽章公開金鑰；非本機更新會被拒絕。",
  "privacy.audit.update.httpsWarn":
    "更新來源未使用 HTTPS，僅允許本機回環偵錯。",
  "privacy.audit.update.fail":
    "更新位址無效或未使用 HTTPS（本機回環除外）。",
  "privacy.audit.update.notConfigured":
    "尚未設定更新清單網址；不會發起更新請求。",
  "privacy.audit.isolation.title": "線上來源與 WebView 隔離",
  "privacy.audit.isolation.pass":
    "內嵌瀏覽器是獨立 WebView，未取得 Tauri 能力；外部頁面無法呼叫本機命令。",
  "privacy.audit.isolation.warn":
    "視窗能力已隔離，但主介面未設定 CSP；建議在發布前收緊。",
  "privacy.audit.isolation.fail":
    "偵測到遠端 WebView 能力或遠端 IPC 放行，請立即修正。",
  "privacy.audit.network.title": "網路與代理安全",
  "privacy.audit.network.direct":
    "目前為直連；線上請求支援並優先使用 HTTPS。",
  "privacy.audit.network.proxy":
    "目前代理：{proxy}。請只使用你信任的代理。",
  "privacy.audit.network.insecure":
    "目前代理不是 HTTPS／加密代理，流量可能以明文經過代理。",
  "privacy.audit.network.invalid":
    "代理位址格式無效，請先在線上來源設定中修正。",
  "privacy.audit.storage.title": "本機儲存與快取",
  "privacy.audit.storage.summary":
    "圖片快取 {memory}，磁碟渲染快取 {disk}；工作階段請求標頭只留在記憶體。",
  "privacy.audit.storage.fail": "無法讀取快取狀態。",
  "privacy.audit.details": "證據詳情",
  "privacy.audit.evidence.capabilities": "能力視窗：{value}",
  "privacy.audit.evidence.remote": "遠端能力：{value}",
  "privacy.audit.evidence.csp": "CSP：{value}",
  "privacy.audit.evidence.signature": "簽章公開金鑰：{value}",
  "privacy.audit.evidence.https": "HTTPS：{value}",
  "privacy.audit.loopback": "本機回環（允許）",
  "privacy.audit.evidence.webviews": "作用中 WebView：{value}",
  "privacy.audit.evidence.sha": "SHA-256：{value}",
  "privacy.audit.evidence.keySource": "公鑰來源：{value}",
  "privacy.audit.keySource.config": "建置設定（tauri.conf.json）",
  "privacy.audit.keySource.build": "建置期注入（MR_UPDATE_PUBKEY）",
  "privacy.audit.keySource.none": "未設定",
  "privacy.audit.evidence.mode": "連線模式：{value}",
  "privacy.audit.evidence.scheme": "代理協定：{value}",
  "privacy.audit.evidence.sessionHeaders": "記憶體工作階段標頭：{value}",
  "privacy.audit.evidence.memoryBytes": "記憶體快取：{value} B",
  "privacy.audit.evidence.diskBytes": "磁碟快取：{value} B",
  "privacy.audit.enabled": "已啟用",
  "privacy.audit.disabled": "未啟用",
  "privacy.audit.direct": "直連",
  "privacy.audit.proxyMode": "代理",
  "privacy.audit.clear": "擦除線上痕跡與快取",
  "privacy.audit.clearing": "正在擦除…",
  "privacy.audit.clearHint":
    "清除 WebView Cookie 與網站儲存、頁面／縮圖／條漫快取，並釋放記憶體中的工作階段請求標頭。本機書庫與閱讀進度會保留。",
  "privacy.audit.clearTitle": "清除線上痕跡？",
  "privacy.audit.clearBody":
    "所有網站將登出，圖片快取會被清空。書庫、閱讀進度與本機設定不會刪除。",
  "privacy.guard.title": "卡死保護與安全模式",
  "privacy.guard.description":
    "心跳看門狗與暴躁點擊感知為常開保護；安全模式可在此手動進入或退出。",
  "privacy.guard.alwaysOn": "常開保護",
  "privacy.guard.watchdog": "心跳看門狗",
  "privacy.guard.watchdogDesc":
    "介面無回應時僅開啟獨立恢復視窗等待你選擇，絕不自動重建主視窗。",
  "privacy.guard.rage": "暴躁點擊感知",
  "privacy.guard.rageDesc":
    "連續快速點擊會被視為卡死訊號，只用於喚起恢復視窗，不做任何自動操作。",
  "privacy.guard.safeModeRow": "安全模式",
  "privacy.guard.safeModeDesc":
    "進入後暫停線上功能並鎖定基礎單頁模式，用於排查問題；退出會重新啟動應用程式。",
  "privacy.guard.safeModeOn": "已啟用",
  "privacy.guard.safeModeOff": "未啟用",
  "privacy.guard.enter": "手動進入安全模式",
  "privacy.guard.entering": "正在進入…",
  "privacy.audit.clearAction": "立即清除",
  "privacy.audit.cleared":
    "已清理 {webviews} 個 WebView 的瀏覽資料，並釋放 {size} 快取。",
  "privacy.audit.error": "安全自我檢查失敗：{detail}",
  "privacy.audit.retry": "重新檢查",
  "privacy.audit.noUpload": "檢查結果只在本機顯示，不會上傳。",
  "privacy.status.pass": "通過",
  "privacy.status.warn": "注意",
  "privacy.status.fail": "風險",
  "privacy.status.unknown": "未知",
  "privacy.toast.cleared": "線上痕跡與快取已清理。",
  "privacy.toast.clearFailed": "清理失敗：{detail}",
  "privacy.toast.auditFailed": "安全自我檢查失敗：{detail}",
  "privacy.security.windowsTitle": "Windows 安全與更新完整性",
  "privacy.security.windowsBody":
    "更新套件會先下載到系統暫存目錄，再通過 SHA-256 與 minisign 簽章驗證；只有所有驗證都通過，才會由標準安裝程式以交易式的方式替換執行中的程式，絕不在記憶體中覆寫執行中的執行檔。任何一項驗證失敗都會立即拒絕安裝，並刪除已下載的半成品檔案。",
  "privacy.security.windowsBadgeIntegrity": "SHA-256 + Minisign 驗證",
  "privacy.security.windowsBadgeTransaction": "安裝程式交易式替換",
  "privacy.security.windowsSmartScreenTitle": "SmartScreen 攔截與放行",
  "privacy.security.windowsSmartScreen":
    "本機建置與自我簽章的建置沒有受信任的程式碼簽章，Windows SmartScreen 會把它們視為「不受信任的應用程式」而攔下，這是預期行為，並非病毒提示。要放行請依下列順序操作；若你更信任正式發行的簽章版本，請改從官方發行管道取得。",
  "privacy.security.windowsStepLaunch": "按兩下安裝檔",
  "privacy.security.windowsStepInfo": "更多資訊",
  "privacy.security.windowsStepRun": "仍要執行",
  "privacy.security.windowsTempTitle": "下載與解壓縮目錄",
  "privacy.security.windowsTemp":
    "更新套件請下載並解壓縮到系統暫存目錄或應用程式專屬的 staging 目錄，不要放在「下載」資料夾。下載資料夾會被即時掃描，也常被同步軟體接管，放在那裡的安裝檔更容易被誤判或直接鎖定。",
  "privacy.security.windowsAllowlistTitle": "防毒軟體白名單",
  "privacy.security.windowsAllowlist":
    "可以把應用程式資料目錄與快取目錄一起加入防毒軟體的排除項目或白名單。資料目錄存放書庫資料庫（library.db）、日誌與下載檔案，快取目錄存放圖片與算繪快取；兩者都不會儲存任何帳號憑證。加入白名單後，日常掃描就不會再反覆鎖定這些檔案。",
};

const es: Record<keyof typeof zhCN, string> = {
  "privacy.tab": "Privacidad",
  "privacy.title": "Privacidad y seguridad",
  "privacy.description":
    "Moyu es local-first: tu biblioteca, tu progreso, tus estadísticas y la caché se quedan en este dispositivo. Aquí tienes los límites de tus datos y una comprobación de seguridad local real.",
  "privacy.badge": "Prioridad local",
  "privacy.statement.title": "Compromiso de privacidad",
  "privacy.statement.summary":
    "Sin cuenta, sin telemetría en segundo plano y sin subir contenido de lectura, datos de la biblioteca ni estadísticas.",
  "privacy.storage.title": "Datos guardados en local",
  "privacy.storage.books":
    "Índice de la biblioteca, portadas y metadatos de los libros en la base de datos SQLite local (library.db).",
  "privacy.storage.progress":
    "Progreso de lectura, historial y estadísticas, también solo en SQLite local.",
  "privacy.storage.cache":
    "Caché de páginas, miniaturas, viñetas de webtoon y originales en línea en el directorio local de datos de la aplicación.",
  "privacy.storage.settings":
    "Tema, idioma de la interfaz, preferencias de lectura y de actualización en SQLite local o localStorage.",
  "privacy.network.title": "Cuándo se usa la red",
  "privacy.network.online":
    "Lectura directa de URL en línea y navegador integrado: solo los sitios que introduces tú. No se inyectan scripts de extracción y la aplicación nunca recopila ni exporta cookies de terceros. Las cookies de los sitios viven en el WebView aislado y pueden borrarse en cualquier momento.",
  "privacy.network.updates":
    "Búsqueda de actualizaciones: solo tras configurar una URL de manifiesto; solo se contacta con ese manifiesto HTTPS y el instalador.",
  "privacy.network.none":
    "Aparte de estos dos casos, la aplicación no hace solicitudes de red en segundo plano.",
  "privacy.dialog.title": "Te damos la bienvenida a Moyu",
  "privacy.dialog.subtitle":
    "Antes de empezar, un resumen de 30 segundos sobre el límite de tus datos.",
  "privacy.dialog.localTitle": "100 % local",
  "privacy.dialog.localBody":
    "Tu biblioteca, progreso de lectura, estadísticas y caché de imágenes se quedan en este dispositivo.",
  "privacy.dialog.networkTitle": "Red solo cuando haga falta",
  "privacy.dialog.networkBody":
    "Solo se hacen solicitudes cuando usas la lectura en línea, el navegador integrado o configuras y compruebas actualizaciones.",
  "privacy.dialog.noTelemetry":
    "Sin cuenta, sin telemetría, sin subidas silenciosas.",
  "privacy.dialog.ack": "Entendido",
  "privacy.dialog.openSettings": "Revisar privacidad y seguridad",
  "privacy.dialog.policyVersion": "Versión de la política {version}",
  "privacy.dialog.close": "Cerrar la declaración de privacidad",
  "privacy.statement.showDialog":
    "Volver a mostrar el mensaje de bienvenida",
  "privacy.dialog.reopen": "Declaración de privacidad",
  "privacy.audit.title": "Comprobación de seguridad local",
  "privacy.audit.description":
    "Lee la configuración de esta compilación, los permisos de ventana, los ajustes de red y el estado de la caché. Todo se queda en este dispositivo.",
  "privacy.audit.run": "Ejecutar comprobación",
  "privacy.audit.running": "Comprobando…",
  "privacy.audit.checkedAt": "Comprobado {time}",
  "privacy.audit.overall.pass": "La seguridad parece correcta",
  "privacy.audit.overall.warn": "Hay elementos que requieren atención",
  "privacy.audit.overall.fail":
    "Se han encontrado elementos de alto riesgo",
  "privacy.audit.overall.unknown": "Aún sin comprobar",
  "privacy.audit.update.title": "Firma e integridad de las actualizaciones",
  "privacy.audit.update.pass":
    "Hay una clave pública Minisign configurada; SHA-256 y las firmas son obligatorios antes de instalar.",
  "privacy.audit.update.warn":
    "SHA-256 se aplica, pero esta compilación no tiene clave pública de firma; se rechazan las actualizaciones que no sean locales.",
  "privacy.audit.update.httpsWarn":
    "La fuente de actualizaciones no usa HTTPS; solo se permite la depuración en loopback local.",
  "privacy.audit.update.fail":
    "La URL de actualización no es válida o no usa HTTPS (se exceptúa el bucle local).",
  "privacy.audit.update.notConfigured":
    "No hay manifiesto de actualizaciones configurado; no se harán solicitudes de actualización.",
  "privacy.audit.isolation.title":
    "Aislamiento de fuentes en línea y WebView",
  "privacy.audit.isolation.pass":
    "El navegador integrado es un WebView independiente sin capacidades de Tauri; las páginas externas no pueden llamar a comandos locales.",
  "privacy.audit.isolation.warn":
    "Las capacidades de ventana están aisladas, pero la interfaz principal no tiene CSP; conviene endurecerla antes de publicar.",
  "privacy.audit.isolation.fail":
    "Se han detectado capacidades de WebView remoto o acceso IPC remoto. Corrígelo de inmediato.",
  "privacy.audit.network.title": "Seguridad de red y proxy",
  "privacy.audit.network.direct":
    "Conexión directa. Las solicitudes en línea admiten HTTPS y lo prefieren.",
  "privacy.audit.network.proxy":
    "Proxy actual: {proxy}. Usa solo un proxy de confianza.",
  "privacy.audit.network.insecure":
    "El proxy no es HTTPS/cifrado; el tráfico puede pasar por él en texto claro.",
  "privacy.audit.network.invalid":
    "La dirección del proxy no es válida; corrígela antes en los ajustes de Fuente en línea.",
  "privacy.audit.storage.title": "Almacenamiento local y caché",
  "privacy.audit.storage.summary":
    "Caché de imágenes {memory}; caché de renderizado en disco {disk}. Las cabeceras de sesión solo residen en memoria.",
  "privacy.audit.storage.fail": "No se pudo leer el estado de la caché.",
  "privacy.audit.details": "Evidencias",
  "privacy.audit.evidence.capabilities":
    "Ventanas con capacidades: {value}",
  "privacy.audit.evidence.remote": "Capacidades remotas: {value}",
  "privacy.audit.evidence.csp": "CSP: {value}",
  "privacy.audit.evidence.signature": "Clave pública de firma: {value}",
  "privacy.audit.evidence.https": "HTTPS: {value}",
  "privacy.audit.loopback": "Bucle local (permitido)",
  "privacy.audit.evidence.webviews": "WebViews activos: {value}",
  "privacy.audit.evidence.sha": "SHA-256: {value}",
  "privacy.audit.evidence.keySource": "Origen de la clave: {value}",
  "privacy.audit.keySource.config": "Configuración de compilación (tauri.conf.json)",
  "privacy.audit.keySource.build": "Inyección en tiempo de compilación (MR_UPDATE_PUBKEY)",
  "privacy.audit.keySource.none": "Sin configurar",
  "privacy.audit.evidence.mode": "Modo de conexión: {value}",
  "privacy.audit.evidence.scheme": "Esquema del proxy: {value}",
  "privacy.audit.evidence.sessionHeaders": "Cabeceras de sesión en memoria: {value}",
  "privacy.audit.evidence.memoryBytes": "Caché en memoria: {value} B",
  "privacy.audit.evidence.diskBytes": "Caché en disco: {value} B",
  "privacy.audit.enabled": "Activado",
  "privacy.audit.disabled": "Desactivado",
  "privacy.audit.direct": "Directo",
  "privacy.audit.proxyMode": "Proxy",
  "privacy.audit.clear": "Borrar rastros en línea y caché",
  "privacy.audit.clearing": "Borrando…",
  "privacy.audit.clearHint":
    "Borra las cookies y el almacenamiento de sitios del WebView, las cachés de páginas, miniaturas y webtoon, y libera las cabeceras de sesión en memoria. Tu biblioteca y tu progreso de lectura se conservan.",
  "privacy.audit.clearTitle": "¿Borrar los rastros en línea?",
  "privacy.audit.clearBody":
    "Todos los sitios cerrarán sesión y se vaciarán las cachés de imágenes. Tu biblioteca, tu progreso de lectura y los ajustes locales se conservan.",
  "privacy.guard.title": "Protección ante cuellos y modo seguro",
  "privacy.guard.description":
    "El vigilante de latido y la detección de clics frustrados son protecciones siempre activas; el modo seguro se puede activar o desactivar aquí.",
  "privacy.guard.alwaysOn": "Siempre activo",
  "privacy.guard.watchdog": "Vigilante de latido",
  "privacy.guard.watchdogDesc":
    "Si la interfaz deja de responder, solo abre la ventana de recuperación independiente y espera tu elección; nunca reconstruye la ventana principal por su cuenta.",
  "privacy.guard.rage": "Detección de clics frustrados",
  "privacy.guard.rageDesc":
    "Los clics rápidos y repetidos se tratan como señal de cuello y solo invocan la ventana de recuperación; no se ejecuta ninguna acción automática.",
  "privacy.guard.safeModeRow": "Modo seguro",
  "privacy.guard.safeModeDesc":
    "Al activarlo se pausan las funciones en línea y se bloquea el lector en modo de página única para diagnosticar; al salir se reinicia la app.",
  "privacy.guard.safeModeOn": "Activo",
  "privacy.guard.safeModeOff": "Inactivo",
  "privacy.guard.enter": "Activar modo seguro",
  "privacy.guard.entering": "Activando…",
  "privacy.audit.clearAction": "Borrar ahora",
  "privacy.audit.cleared":
    "Se borraron los datos de navegación de {webviews} WebView y se liberaron {size} de caché.",
  "privacy.audit.error": "La comprobación de seguridad falló: {detail}",
  "privacy.audit.retry": "Comprobar de nuevo",
  "privacy.audit.noUpload":
    "Los resultados solo se muestran en local y nunca se suben.",
  "privacy.status.pass": "Correcto",
  "privacy.status.warn": "Atención",
  "privacy.status.fail": "Riesgo",
  "privacy.status.unknown": "Desconocido",
  "privacy.toast.cleared": "Rastros en línea y caché borrados.",
  "privacy.toast.clearFailed": "Error al borrar: {detail}",
  "privacy.toast.auditFailed":
    "La comprobación de seguridad falló: {detail}",
  "privacy.security.windowsTitle": "Seguridad de Windows e integridad de las actualizaciones",
  "privacy.security.windowsBody":
    "Los paquetes de actualización se descargan primero a la carpeta temporal del sistema y después se verifican con SHA-256 y una firma minisign. Solo cuando todas las comprobaciones pasan, el instalador estándar sustituye el programa en ejecución de forma transaccional; el ejecutable en marcha nunca se sobrescribe en memoria. Si una comprobación falla, la instalación se rechaza y se borra el archivo a medio descargar.",
  "privacy.security.windowsBadgeIntegrity": "Verificación SHA-256 + Minisign",
  "privacy.security.windowsBadgeTransaction": "Sustitución transaccional del instalador",
  "privacy.security.windowsSmartScreenTitle": "Avisos de SmartScreen y cómo permitir la aplicación",
  "privacy.security.windowsSmartScreen":
    "Las compilaciones locales o firmadas por el propio autor no llevan una firma de código de confianza, así que Windows SmartScreen las marca como aplicación no reconocida. Es el comportamiento esperado, no un aviso de malware. Permítela con los pasos de abajo; si prefieres una versión firmada de confianza, obtén la aplicación del canal oficial de publicación.",
  "privacy.security.windowsStepLaunch": "Doble clic en el instalador",
  "privacy.security.windowsStepInfo": "Más información",
  "privacy.security.windowsStepRun": "Ejecutar de todas formas",
  "privacy.security.windowsTempTitle": "Carpetas de descarga y extracción",
  "privacy.security.windowsTemp":
    "Descarga y descomprime las actualizaciones en la carpeta temporal del sistema o en el directorio de preparación propio de la aplicación, no en la carpeta de Descargas. Descargas se analiza en tiempo real y suele sincronizarse con la nube, por lo que los instaladores que se quedan ahí se confunden o se bloquean con más facilidad.",
  "privacy.security.windowsAllowlistTitle": "Lista blanca del antivirus",
  "privacy.security.windowsAllowlist":
    "Puedes añadir tanto la carpeta de datos como la de caché de la aplicación a las exclusiones o a la lista blanca de tu antivirus. La carpeta de datos guarda la base de datos de la biblioteca (library.db), los registros y los archivos descargados; la de caché guarda las cachés de imágenes y de renderizado. Ninguna almacena credenciales, y excluirlas evita que los análisis programados bloqueen estos archivos una y otra vez.",
};

const ja: Record<keyof typeof zhCN, string> = {
  "privacy.tab": "プライバシー",
  "privacy.title": "プライバシーとセキュリティ",
  "privacy.description":
    "Moyu はローカル優先のリーダーです。書庫、読書進捗、統計、キャッシュはすべてこの端末に保存されます。以下ではデータの境界を示し、実際のローカルセキュリティチェックも提供します。",
  "privacy.badge": "ローカル優先",
  "privacy.statement.title": "プライバシーへの約束",
  "privacy.statement.summary":
    "アカウントなし、バックグラウンドのテレメトリなし、読書内容・書庫データ・統計のアップロードも一切ありません。",
  "privacy.storage.title": "ローカルに保存されるデータ",
  "privacy.storage.books":
    "書庫の索引、表紙、書籍メタデータはローカルの SQLite（library.db）に保存されます。",
  "privacy.storage.progress":
    "読書進捗、読書履歴、統計もローカルの SQLite にのみ書き込まれます。",
  "privacy.storage.cache":
    "ページ、サムネイル、Webtoon タイル、オンライン原画のキャッシュは、ローカルのアプリデータディレクトリに保存されます。",
  "privacy.storage.settings":
    "テーマ、UI 言語、読書設定、更新設定は、ローカルの SQLite または localStorage に保存されます。",
  "privacy.network.title": "ネットワークを使う場面",
  "privacy.network.online":
    "オンライン URL の直読と内蔵ブラウザ：アクセスするのは、自分で入力したサイトだけです。収集スクリプトは挿入せず、アプリがサードパーティ Cookie を収集・外部送信することもありません。サイトの Cookie は分離された WebView 内に保持され、いつでも消去できます。",
  "privacy.network.updates":
    "アップデートの確認：更新マニフェストの URL を設定した場合に限り、その HTTPS マニフェストとインストーラーだけにアクセスします。",
  "privacy.network.none":
    "上記の 2 つの場合を除き、アプリはバックグラウンドでネットワークリクエストを送信しません。",
  "privacy.dialog.title": "Moyu へようこそ",
  "privacy.dialog.subtitle":
    "始める前に、30 秒でデータの境界を確認しましょう。",
  "privacy.dialog.localTitle": "100% ローカル",
  "privacy.dialog.localBody":
    "書庫、読書進捗、統計、画像キャッシュは、すべてこの端末に保存されます。",
  "privacy.dialog.networkTitle": "ネットワークは必要なときだけ",
  "privacy.dialog.networkBody":
    "オンライン直読、内蔵ブラウザの利用、または更新の設定と確認を行ったときにだけ、リクエストが発生します。",
  "privacy.dialog.noTelemetry":
    "アカウントなし、テレメトリなし、無断アップロードなし。",
  "privacy.dialog.ack": "了解",
  "privacy.dialog.openSettings": "プライバシーとセキュリティを確認",
  "privacy.dialog.policyVersion": "ポリシーバージョン {version}",
  "privacy.dialog.close": "プライバシー声明を閉じる",
  "privacy.statement.showDialog": "起動時の声明をもう一度表示",
  "privacy.dialog.reopen": "プライバシー声明",
  "privacy.audit.title": "ローカルセキュリティチェック",
  "privacy.audit.description":
    "現在のビルド設定、ウィンドウ権限、ネットワーク設定、キャッシュ状態を読み取ります。チェックはこの端末内で完結し、結果はアップロードされません。",
  "privacy.audit.run": "セキュリティチェックを実行",
  "privacy.audit.running": "チェック中…",
  "privacy.audit.checkedAt": "{time} にチェック",
  "privacy.audit.overall.pass": "セキュリティ状態は良好です",
  "privacy.audit.overall.warn": "確認が必要な項目があります",
  "privacy.audit.overall.fail": "高リスクの項目があります",
  "privacy.audit.overall.unknown": "未チェック",
  "privacy.audit.update.title": "更新パッケージの署名と整合性",
  "privacy.audit.update.pass":
    "Minisign 公開鍵が設定されています。SHA-256 と署名はインストール前に必須です。",
  "privacy.audit.update.warn":
    "SHA-256 は必須ですが、このビルドには署名用公開鍵がありません。ローカル以外の更新は拒否されます。",
  "privacy.audit.update.httpsWarn":
    "更新元が HTTPS ではありません。ローカルのループバックでのデバッグのみ許可されています。",
  "privacy.audit.update.fail":
    "更新 URL が無効か、HTTPS を使用していません（ローカルループバックを除く）。",
  "privacy.audit.update.notConfigured":
    "更新マニフェストが設定されていません。更新リクエストは送信されません。",
  "privacy.audit.isolation.title": "オンラインソースと WebView の分離",
  "privacy.audit.isolation.pass":
    "内蔵ブラウザは独立した WebView で、Tauri の権限を持ちません。外部ページからローカルコマンドを呼び出すことはできません。",
  "privacy.audit.isolation.warn":
    "ウィンドウ権限は分離されていますが、メイン UI に CSP がありません。リリース前に強化してください。",
  "privacy.audit.isolation.fail":
    "リモート WebView の権限、またはリモート IPC の許可を検出しました。直ちに修正してください。",
  "privacy.audit.network.title": "ネットワークとプロキシの安全性",
  "privacy.audit.network.direct":
    "現在は直接接続です。オンラインリクエストは HTTPS に対応し、優先的に使用します。",
  "privacy.audit.network.proxy":
    "現在のプロキシ：{proxy}。信頼できるプロキシだけを使用してください。",
  "privacy.audit.network.insecure":
    "現在のプロキシは HTTPS／暗号化プロキシではありません。通信が平文でプロキシを通過する可能性があります。",
  "privacy.audit.network.invalid":
    "プロキシのアドレス形式が正しくありません。先にオンラインソース設定で修正してください。",
  "privacy.audit.storage.title": "ローカルストレージとキャッシュ",
  "privacy.audit.storage.summary":
    "画像キャッシュ {memory}、ディスクのレンダーキャッシュ {disk}。セッションのリクエストヘッダーはメモリ上にのみ保持されます。",
  "privacy.audit.storage.fail": "キャッシュ状態を読み取れませんでした。",
  "privacy.audit.details": "証拠の詳細",
  "privacy.audit.evidence.capabilities": "権限付きウィンドウ：{value}",
  "privacy.audit.evidence.remote": "リモート権限：{value}",
  "privacy.audit.evidence.csp": "CSP：{value}",
  "privacy.audit.evidence.signature": "署名公開鍵：{value}",
  "privacy.audit.evidence.https": "HTTPS：{value}",
  "privacy.audit.loopback": "ローカルループバック（許可）",
  "privacy.audit.evidence.webviews": "アクティブな WebView：{value}",
  "privacy.audit.evidence.sha": "SHA-256：{value}",
  "privacy.audit.evidence.keySource": "公開鍵の取得元：{value}",
  "privacy.audit.keySource.config": "ビルド設定 (tauri.conf.json)",
  "privacy.audit.keySource.build": "ビルド時注入 (MR_UPDATE_PUBKEY)",
  "privacy.audit.keySource.none": "未設定",
  "privacy.audit.evidence.mode": "接続モード：{value}",
  "privacy.audit.evidence.scheme": "プロキシ方式：{value}",
  "privacy.audit.evidence.sessionHeaders": "メモリ内セッションヘッダー：{value}",
  "privacy.audit.evidence.memoryBytes": "メモリキャッシュ：{value} B",
  "privacy.audit.evidence.diskBytes": "ディスクキャッシュ：{value} B",
  "privacy.audit.enabled": "有効",
  "privacy.audit.disabled": "無効",
  "privacy.audit.direct": "直接",
  "privacy.audit.proxyMode": "プロキシ",
  "privacy.audit.clear": "オンラインの痕跡とキャッシュを消去",
  "privacy.audit.clearing": "消去中…",
  "privacy.audit.clearHint":
    "WebView の Cookie とサイトストレージ、ページ／サムネイル／Webtoon のキャッシュを消去し、メモリ内のセッションリクエストヘッダーを解放します。ローカルの書庫と読書進捗は保持されます。",
  "privacy.audit.clearTitle": "オンラインの痕跡を消去しますか？",
  "privacy.audit.clearBody":
    "すべてのサイトからログアウトし、画像キャッシュを空にします。書庫、読書進捗、ローカル設定は削除されません。",
  "privacy.guard.title": "フリーズ保護とセーフモード",
  "privacy.guard.description":
    "ハートビートウォッチドッグと連打検知は常時有効な保護です。セーフモードはここで手動切り替えできます。",
  "privacy.guard.alwaysOn": "常時有効",
  "privacy.guard.watchdog": "ハートビートウォッチドッグ",
  "privacy.guard.watchdogDesc":
    "UI が応答しなくなった場合、独立した復旧ウィンドウを開いて選択を待つだけで、メインウィンドウを自動再構築しません。",
  "privacy.guard.rage": "連打（rage click）検知",
  "privacy.guard.rageDesc":
    "短時間の連続クリックはフリーズのシグナルとみなされ、復旧ウィンドウを呼び出すだけです。自動操作は行いません。",
  "privacy.guard.safeModeRow": "セーフモード",
  "privacy.guard.safeModeDesc":
    "有効にするとオンライン機能を停止し、基本的な単ページ表示に固定して原因を切り分けます。終了するとアプリが再読み込みされます。",
  "privacy.guard.safeModeOn": "有効",
  "privacy.guard.safeModeOff": "無効",
  "privacy.guard.enter": "セーフモードを手動で有効化",
  "privacy.guard.entering": "有効化中…",
  "privacy.audit.clearAction": "今すぐ消去",
  "privacy.audit.cleared":
    "{webviews} 個の WebView の閲覧データを消去し、{size} のキャッシュを解放しました。",
  "privacy.audit.error": "セキュリティチェックに失敗しました：{detail}",
  "privacy.audit.retry": "再チェック",
  "privacy.audit.noUpload":
    "結果はこの端末でのみ表示され、アップロードされません。",
  "privacy.status.pass": "合格",
  "privacy.status.warn": "注意",
  "privacy.status.fail": "リスク",
  "privacy.status.unknown": "不明",
  "privacy.toast.cleared": "オンラインの痕跡とキャッシュを消去しました。",
  "privacy.toast.clearFailed": "消去に失敗しました：{detail}",
  "privacy.toast.auditFailed":
    "セキュリティチェックに失敗しました：{detail}",
  "privacy.security.windowsTitle": "Windows のセキュリティと更新の完全性",
  "privacy.security.windowsBody":
    "更新パッケージはまずシステムの一時フォルダへダウンロードされ、SHA-256 と minisign 署名で検証されます。すべての検査に通ったときだけ、標準のインストーラーがトランザクション方式で実行中のプログラムを置き換え、実行中の実行ファイルがメモリ上で上書きされることはありません。いずれかの検査に失敗した場合はインストールを拒否し、途中までダウンロードしたファイルを削除します。",
  "privacy.security.windowsBadgeIntegrity": "SHA-256 と Minisign で検証",
  "privacy.security.windowsBadgeTransaction": "インストーラーによるトランザクション置換",
  "privacy.security.windowsSmartScreenTitle": "SmartScreen の警告と許可する手順",
  "privacy.security.windowsSmartScreen":
    "ローカルビルドや自己署名ビルドには信頼されたコード署名がないため、Windows SmartScreen が「認識されていないアプリ」として警告します。これは想定どおりの動作で、ウイルス通知ではありません。下の手順で許可してください。より信頼性の高い正式署名の版をご希望なら、公式の配布チャンネルから入手してください。",
  "privacy.security.windowsStepLaunch": "インストーラーをダブルクリック",
  "privacy.security.windowsStepInfo": "詳細情報",
  "privacy.security.windowsStepRun": "実行する",
  "privacy.security.windowsTempTitle": "ダウンロードと展開の保存先",
  "privacy.security.windowsTemp":
    "更新パッケージは「ダウンロード」フォルダーではなく、システムの一時フォルダーかアプリ専用のステージングディレクトリへ展開してください。「ダウンロード」フォルダーはリアルタイムスキャンやクラウド同期の対象になりやすく、置かれたインストーラーが誤検知やロックの対象になりがちです。",
  "privacy.security.windowsAllowlistTitle": "アンチウイルス製品の許可リスト",
  "privacy.security.windowsAllowlist":
    "アプリのデータフォルダーとキャッシュフォルダーの両方を、アンチウイルス製品の除外項目や許可リストへ追加できます。データフォルダーには書庫データベース（library.db）、ログ、ダウンロードしたファイルが、キャッシュフォルダーには画像キャッシュとレンダーキャッシュが保存されます。どちらにもアカウントの資格情報は含まれず、追加すればスケジュールスキャンがこれらのファイルを繰り返しロックしなくなります。",
};

const ko: Record<keyof typeof zhCN, string> = {
  "privacy.tab": "개인정보",
  "privacy.title": "개인정보 보호 및 보안",
  "privacy.description":
    "Moyu는 로컬 우선 리더입니다. 서재, 읽기 진행률, 통계, 캐시가 모두 이 기기에 저장됩니다. 아래에서 데이터 경계를 설명하고, 실제 로컬 보안 자가 점검도 제공합니다.",
  "privacy.badge": "로컬 우선",
  "privacy.statement.title": "개인정보 보호 약속",
  "privacy.statement.summary":
    "계정도, 백그라운드 텔레메트리도, 읽기 콘텐츠나 서재 데이터·통계 업로드도 없습니다.",
  "privacy.storage.title": "로컬에 저장되는 항목",
  "privacy.storage.books":
    "서재 색인, 표지, 도서 메타데이터는 로컬 SQLite(library.db)에 저장됩니다.",
  "privacy.storage.progress":
    "읽기 진행률, 읽기 기록, 통계도 로컬 SQLite에만 기록됩니다.",
  "privacy.storage.cache":
    "페이지, 썸네일, 웹툰 타일, 온라인 원본 캐시는 로컬 앱 데이터 디렉터리에 저장됩니다.",
  "privacy.storage.settings":
    "테마, UI 언어, 읽기 설정, 업데이트 설정은 로컬 SQLite 또는 localStorage에 저장됩니다.",
  "privacy.network.title": "네트워크를 사용하는 경우",
  "privacy.network.online":
    "온라인 URL 바로 읽기와 내장 브라우저: 사용자가 직접 입력한 사이트만 방문합니다. 수집 스크립트를 주입하지 않으며, 앱이 타사 쿠키를 수집하거나 내보내지도 않습니다. 사이트 쿠키는 격리된 WebView에 보관되며 언제든 지울 수 있습니다.",
  "privacy.network.updates":
    "업데이트 확인: 업데이트 매니페스트 URL을 설정한 경우에만 해당 HTTPS 매니페스트와 설치 프로그램에 접속합니다.",
  "privacy.network.none":
    "위의 두 경우를 제외하면 앱은 백그라운드 네트워크 요청을 보내지 않습니다.",
  "privacy.dialog.title": "Moyu에 오신 것을 환영합니다",
  "privacy.dialog.subtitle":
    "시작하기 전에 30초 동안 데이터 경계를 확인해 보세요.",
  "privacy.dialog.localTitle": "100% 로컬",
  "privacy.dialog.localBody":
    "서재, 읽기 진행률, 통계, 이미지 캐시는 모두 이 기기에만 저장됩니다.",
  "privacy.dialog.networkTitle": "네트워크는 필요할 때만",
  "privacy.dialog.networkBody":
    "온라인 바로 읽기, 내장 브라우저 사용, 업데이트 설정·확인 중 하나를 할 때만 네트워크 요청이 발생합니다.",
  "privacy.dialog.noTelemetry":
    "계정도, 텔레메트리도, 몰래 업로드하는 일도 없습니다.",
  "privacy.dialog.ack": "확인",
  "privacy.dialog.openSettings": "개인정보 보호 및 보안 보기",
  "privacy.dialog.policyVersion": "정책 버전 {version}",
  "privacy.dialog.close": "개인정보 보호 방침 닫기",
  "privacy.statement.showDialog": "시작 안내 다시 보기",
  "privacy.dialog.reopen": "개인정보 보호 방침",
  "privacy.audit.title": "로컬 보안 점검",
  "privacy.audit.description":
    "현재 빌드 설정, 창 권한, 네트워크 설정, 캐시 상태를 읽습니다. 점검은 이 기기에서만 이루어지며 결과는 업로드되지 않습니다.",
  "privacy.audit.run": "보안 자가 점검 실행",
  "privacy.audit.running": "점검 중…",
  "privacy.audit.checkedAt": "{time}에 점검",
  "privacy.audit.overall.pass": "보안 상태 양호",
  "privacy.audit.overall.warn": "확인이 필요한 항목이 있습니다",
  "privacy.audit.overall.fail": "고위험 항목이 있습니다",
  "privacy.audit.overall.unknown": "아직 점검하지 않음",
  "privacy.audit.update.title": "업데이트 패키지 서명 및 무결성",
  "privacy.audit.update.pass":
    "Minisign 공개 키가 설정되어 있으며, 설치 전에 SHA-256과 서명을 필수로 검증합니다.",
  "privacy.audit.update.warn":
    "SHA-256은 검증되지만 이 빌드에는 서명 공개 키가 없습니다. 로컬이 아닌 업데이트는 거부됩니다.",
  "privacy.audit.update.httpsWarn":
    "업데이트 소스가 HTTPS가 아닙니다. 로컬 루프백 디버깅만 허용됩니다.",
  "privacy.audit.update.fail":
    "업데이트 URL이 유효하지 않거나 HTTPS를 사용하지 않습니다(로컬 루프백 제외).",
  "privacy.audit.update.notConfigured":
    "업데이트 매니페스트 URL이 설정되지 않았습니다. 업데이트 요청을 보내지 않습니다.",
  "privacy.audit.isolation.title": "온라인 소스와 WebView 격리",
  "privacy.audit.isolation.pass":
    "내장 브라우저는 Tauri 권한이 없는 별도 WebView이며, 외부 페이지는 로컬 명령을 호출할 수 없습니다.",
  "privacy.audit.isolation.warn":
    "창 권한은 격리되어 있지만 메인 UI에 CSP가 없습니다. 출시 전에 강화하세요.",
  "privacy.audit.isolation.fail":
    "원격 WebView 권한 또는 원격 IPC 허용이 감지되었습니다. 즉시 수정하세요.",
  "privacy.audit.network.title": "네트워크 및 프록시 보안",
  "privacy.audit.network.direct":
    "현재 직접 연결입니다. 온라인 요청은 HTTPS를 지원하고 우선 사용합니다.",
  "privacy.audit.network.proxy":
    "현재 프록시: {proxy}. 신뢰하는 프록시만 사용하세요.",
  "privacy.audit.network.insecure":
    "현재 프록시는 HTTPS/암호화 프록시가 아니며, 트래픽이 평문으로 프록시를 지날 수 있습니다.",
  "privacy.audit.network.invalid":
    "프록시 주소 형식이 올바르지 않습니다. 먼저 온라인 소스 설정에서 수정하세요.",
  "privacy.audit.storage.title": "로컬 저장소 및 캐시",
  "privacy.audit.storage.summary":
    "이미지 캐시 {memory}, 디스크 렌더 캐시 {disk}. 세션 요청 헤더는 메모리에만 남습니다.",
  "privacy.audit.storage.fail": "캐시 상태를 읽을 수 없습니다.",
  "privacy.audit.details": "증거 상세",
  "privacy.audit.evidence.capabilities": "권한이 부여된 창: {value}",
  "privacy.audit.evidence.remote": "원격 권한: {value}",
  "privacy.audit.evidence.csp": "CSP: {value}",
  "privacy.audit.evidence.signature": "서명 공개 키: {value}",
  "privacy.audit.evidence.https": "HTTPS: {value}",
  "privacy.audit.loopback": "로컬 루프백(허용)",
  "privacy.audit.evidence.webviews": "활성 WebView: {value}",
  "privacy.audit.evidence.sha": "SHA-256: {value}",
  "privacy.audit.evidence.keySource": "공개 키 출처: {value}",
  "privacy.audit.keySource.config": "빌드 설정 (tauri.conf.json)",
  "privacy.audit.keySource.build": "빌드 시 주입 (MR_UPDATE_PUBKEY)",
  "privacy.audit.keySource.none": "설정되지 않음",
  "privacy.audit.evidence.mode": "연결 모드: {value}",
  "privacy.audit.evidence.scheme": "프록시 방식: {value}",
  "privacy.audit.evidence.sessionHeaders": "메모리 세션 헤더: {value}",
  "privacy.audit.evidence.memoryBytes": "메모리 캐시: {value} B",
  "privacy.audit.evidence.diskBytes": "디스크 캐시: {value} B",
  "privacy.audit.enabled": "사용",
  "privacy.audit.disabled": "사용 안 함",
  "privacy.audit.direct": "직접 연결",
  "privacy.audit.proxyMode": "프록시",
  "privacy.audit.clear": "온라인 흔적과 캐시 삭제",
  "privacy.audit.clearing": "삭제 중…",
  "privacy.audit.clearHint":
    "WebView 쿠키와 사이트 저장소, 페이지·썸네일·웹툰 캐시를 지우고 메모리의 세션 요청 헤더를 해제합니다. 로컬 서재와 읽기 진행률은 유지됩니다.",
  "privacy.audit.clearTitle": "온라인 흔적을 삭제할까요?",
  "privacy.audit.clearBody":
    "모든 사이트에서 로그아웃되고 이미지 캐시가 비워집니다. 서재, 읽기 진행률, 로컬 설정은 삭제되지 않습니다.",
  "privacy.guard.title": "멈춤 보호와 안전 모드",
  "privacy.guard.description":
    "하트비트 와치독과 격렬 클릭 감지는 항상 켜진 보호입니다. 안전 모드는 여기서 수동으로 켜고 끌 수 있습니다.",
  "privacy.guard.alwaysOn": "상시 작동",
  "privacy.guard.watchdog": "하트비트 와치독",
  "privacy.guard.watchdogDesc":
    "UI가 응답하지 않으면 독립 복구 창만 열고 선택을 기다립니다. 메인 창을 스스로 다시 만들지 않습니다.",
  "privacy.guard.rage": "격렬 클릭 감지",
  "privacy.guard.rageDesc":
    "빠른 연속 클릭은 멈춤 신호로 간주되어 복구 창을 불러올 뿐, 자동 조치는 하지 않습니다.",
  "privacy.guard.safeModeRow": "안전 모드",
  "privacy.guard.safeModeDesc":
    "켜면 온라인 기능이 일시 중지되고 기본 단일 페이지 모드로 고정되어 문제를 좁힐 수 있습니다. 끄면 앱이 다시 로드됩니다.",
  "privacy.guard.safeModeOn": "활성",
  "privacy.guard.safeModeOff": "비활성",
  "privacy.guard.enter": "안전 모드 수동 진입",
  "privacy.guard.entering": "진입 중…",
  "privacy.audit.clearAction": "지금 삭제",
  "privacy.audit.cleared":
    "WebView {webviews}개의 탐색 데이터를 지우고 {size} 캐시를 해제했습니다.",
  "privacy.audit.error": "보안 점검 실패: {detail}",
  "privacy.audit.retry": "다시 점검",
  "privacy.audit.noUpload":
    "결과는 이 기기에만 표시되며 업로드되지 않습니다.",
  "privacy.status.pass": "통과",
  "privacy.status.warn": "주의",
  "privacy.status.fail": "위험",
  "privacy.status.unknown": "알 수 없음",
  "privacy.toast.cleared": "온라인 흔적과 캐시를 삭제했습니다.",
  "privacy.toast.clearFailed": "삭제 실패: {detail}",
  "privacy.toast.auditFailed": "보안 점검 실패: {detail}",
  "privacy.security.windowsTitle": "Windows 보안 및 업데이트 무결성",
  "privacy.security.windowsBody":
    "업데이트 패키지는 먼저 시스템 임시 폴더에 다운로드된 뒤 SHA-256과 minisign 서명으로 검증됩니다. 모든 검사를 통과한 경우에만 표준 설치 프로그램이 트랜잭션 방식으로 실행 중인 프로그램을 교체하며, 실행 중인 실행 파일을 메모리에서 덮어쓰는 일은 없습니다. 검사 하나라도 실패하면 설치를 거부하고, 내려받다 만 파일을 삭제합니다.",
  "privacy.security.windowsBadgeIntegrity": "SHA-256 + Minisign 검증",
  "privacy.security.windowsBadgeTransaction": "설치 프로그램 트랜잭션 교체",
  "privacy.security.windowsSmartScreenTitle": "SmartScreen 경고와 실행 허용 방법",
  "privacy.security.windowsSmartScreen":
    "로컬 빌드나 자체 서명 빌드에는 신뢰할 수 있는 코드 서명이 없으므로 Windows SmartScreen가 '알 수 없는 앱'으로 경고합니다. 이는 정상적인 동작이며 바이러스 경고가 아닙니다. 아래 순서대로 허용하세요. 신뢰할 수 있는 정식 서명 빌드를 원하시면 공식 배포 경로에서 받아 주세요.",
  "privacy.security.windowsStepLaunch": "설치 프로그램을 두 번 클릭",
  "privacy.security.windowsStepInfo": "자세한 정보",
  "privacy.security.windowsStepRun": "그래도 실행",
  "privacy.security.windowsTempTitle": "다운로드 및 압축 풀기 폴더",
  "privacy.security.windowsTemp":
    "업데이트 패키지는 '다운로드' 폴더가 아니라 시스템 임시 폴더나 앱 전용 스테이징 디렉터리에 풀어 주세요. '다운로드' 폴더는 실시간 검사와 클라우드 동기화가 자주 걸리는 위치라, 그곳에 남은 설치 프로그램이 오탐으로 차단되기 쉽습니다.",
  "privacy.security.windowsAllowlistTitle": "바이러스 방어 프로그램 허용 목록",
  "privacy.security.windowsAllowlist":
    "앱 데이터 폴더와 캐시 폴더를 함께 바이러스 방어 프로그램의 예외 항목이나 허용 목록에 추가할 수 있습니다. 데이터 폴더에는 서재 데이터베이스(library.db), 로그, 다운로드한 파일이, 캐시 폴더에는 이미지 및 렌더 캐시가 보관됩니다. 두 폴더 모두 계정 자격 증명을 저장하지 않으며, 허용 목록에 추가하면 주기적 검사에서 이 파일들이 반복적으로 잠기지 않습니다.",
};

export const privacyMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
};
