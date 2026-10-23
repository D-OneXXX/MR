/**
 * Settings page and settings section strings.
 * Owned by the settings conversion. All six objects must stay in sync.
 */
const zhCN = {
  "settings.page.eyebrow": "偏好设置",
  "settings.page.description": "外观、在线源、阅读统计与缓存都在这台设备上管理。",
  "settings.page.localFirst": "本地优先",
  "settings.page.loading": "正在加载设置",

  "settings.tabs.label": "设置分区",
  "settings.tabs.general": "常规与外观",
  "settings.tabs.online": "在线源",
  "settings.tabs.reading": "统计",
  "settings.tabs.cache": "缓存",
  "settings.tabs.network": "网络与在线源",
  "settings.tabs.storage": "存储与数据",
  "settings.tabs.privacy": "隐私与安全",
  "settings.tabs.about": "关于与维护",

  "settings.shortcuts.title": "全局快捷键",
  "settings.shortcuts.description":
    "输入框聚焦或输入法组合中（isComposing / keyCode 229）时，除 Ctrl/Cmd+W 外，全局快捷键一律不触发。",
  "settings.shortcuts.note":
    "需要使用快捷键时请先离开输入框；Ctrl/Cmd+W（关闭窗口）是唯一例外。",
  "settings.shortcuts.command": "Ctrl/Cmd+K 打开命令中心",

  "settings.language.title": "界面语言",
  "settings.language.description":
    "选择界面语言；切换会立即生效并保存在本机，无需保存设置。",
  "settings.language.label": "显示语言",

  "settings.theme.title": "外观主题",
  "settings.theme.description":
    "选择界面配色；切换会立即生效，并同步到本地偏好与数据库。",
  "settings.theme.groupLabel": "主题模式",
  "settings.theme.systemHint": "随系统深浅色切换",
  "settings.theme.lightHint": "冰蓝画布",
  "settings.theme.darkHint": "深夜座舱",
  "settings.theme.systemNote":
    "「跟随系统」会随操作系统的深浅色自动切换。",

  "settings.experimental.title": "实验性功能",
  "settings.experimental.description":
    "默认关闭。开关切换会立即写入设置，不需要再点保存。",
  "settings.experimental.webtoonTitle": "条漫模式",
  "settings.experimental.webtoonDescription":
    "韩漫长条纵向连续滚动，在单页 / 双页之外提供第三版式。",
  "settings.experimental.note":
    "切换只更新这个开关，不会顺带保存本页其他未保存的修改。",

  "settings.toast.featureOn": "{feature}已开启",
  "settings.toast.featureOff": "{feature}已关闭",

  "settings.library.title": "书库目录",
  "settings.library.description":
    "指定漫画所在目录；扫描会把新书加入本机书库。",
  "settings.library.dirLabel": "扫描目录",
  "settings.library.dirPlaceholder": "D:\\Manga 或 /path/to/manga",
  "settings.library.pick": "选择",
  "settings.library.pickTitle": "选择漫画目录",
  "settings.library.clearDir": "清空目录",
  "settings.library.scanning": "扫描中…",
  "settings.library.scanNow": "立即扫描",
  "settings.library.scanHint":
    "扫描使用上方目录，无需先保存；结果会以提示显示。",

  "settings.about.title": "关于",
  "settings.about.description": "MangaReader 是一个本地优先的漫画阅读器。",
  "settings.about.version": "版本",
  "settings.about.commit": "构建提交",
  "settings.about.storage": "设置存储",
  "settings.about.storageValue": "本机 SQLite",
  "settings.about.dataFlow": "数据去向",
  "settings.about.dataFlowValue": "不离开设备",
  "settings.about.note":
    "设置与阅读记录保存在本机；扫描、在线请求与阅读都不会上传个人数据。",

  "settings.online.urlTitle": "在线 URL 直读",
  "settings.online.urlDescription":
    "支持 JSON 清单与单页 HTML 图集；关闭时书库与浏览器会提示先开启。",
  "settings.online.enableTitle": "启用在线源",
  "settings.online.enableDescription":
    "允许从在线清单 / 图集导入并阅读，导入的章节会进入本机书库。",
  "settings.online.enableNote":
    "切换会立即持久化；下方网络参数需点击底部「保存设置」后生效。",
  "settings.online.networkTitle": "网络与请求",
  "settings.online.networkDescription":
    "代理、并发与请求头会随在线请求发送；请只填写你信任的源或网关。",
  "settings.online.proxyLabel": "代理地址",
  "settings.online.proxyPlaceholder":
    "留空直连，或 http://127.0.0.1:7890",
  "settings.online.detectProxy": "系统代理",
  "settings.online.detectProxyTitle":
    "读取 Windows 系统代理并填入代理地址，不会自动保存",
  "settings.online.detecting": "检测中…",
  "settings.online.proxyHint": "支持 http / https / socks5；留空为直连。",
  "settings.online.concurrencyLabel": "页面并发",
  "settings.online.concurrencyPlaceholder": "选择并发数",
  "settings.online.concurrencyItem": "{count} 并发",
  "settings.online.concurrencyHint":
    "1–8；并发越高越快，也更容易被源限流。",
  "settings.online.headersLabel": "自定义请求头",
  "settings.online.sessionActive": "会话凭据生效中",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 或 session=...; token=...',
  "settings.online.headersHint":
    "请求头以明文保存在本机设置中，并会随请求发送到你配置的源或网关。",
  "settings.online.storageMode": "存储模式",
  "settings.online.storageModeDescription":
    "会话模式不写入数据库，退出应用即清除。",
  "settings.online.storageModeGroup": "请求头存储模式",
  "settings.online.memoryOnly": "仅驻留内存",
  "settings.online.persistLocal": "持久化到本地库",
  "settings.online.sessionPresent": "当前有请求头保存在进程内存中。",
  "settings.online.sessionAbsent": "当前没有会话请求头。",
  "settings.online.clearSession": "清空内存凭据",
  "settings.online.storageModeNote":
    "存储模式切换后需点击底部「保存设置」生效。",
  "settings.online.testTitle": "连通性测试",
  "settings.online.testDescription":
    "解析目标清单或图集，只做探测，不写入书库。",
  "settings.online.testUrlAria": "在线清单或图集测试 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "测试中…",
  "settings.online.testConnection": "测试连接",
  "settings.online.reachable": "可连接",
  "settings.online.testSummary": "{title} · {pages} 页 · {ms} ms",
  "settings.online.testHint":
    "测试使用已保存的代理与请求头；修改后请先保存设置。",

  "settings.stats.loadError": "阅读统计加载失败：{detail}",
  "settings.stats.loading": "正在汇总本机阅读记录…",
  "settings.stats.totalBooks": "总藏书",
  "settings.stats.reading": "在读",
  "settings.stats.todayPages": "今日阅读",
  "settings.stats.last7Pages": "近 7 天",
  "settings.stats.unitBooks": "本",
  "settings.stats.note":
    "只统计本机阅读记录中实际翻过的页面；未打开的书与未记录进度不计入。",

  "settings.cache.budgetTitle": "内存缓存预算",
  "settings.cache.budgetDescription":
    "内存预算越高，翻页越顺滑，但进程内存占用也越高。",
  "settings.cache.budgetLabel": "内存缓存预算",
  "settings.cache.budgetAria": "内存缓存预算（MB）",
  "settings.cache.budgetHint": "保存后立即套用到页面与缩略图的内存缓存。",
  "settings.cache.diskTitle": "磁盘缓存",
  "settings.cache.diskDescription":
    "渲染结果与在线原图共用同一份磁盘缓存，超出上限时会自动清理较旧的文件。",
  "settings.cache.diskLabel": "磁盘缓存上限",
  "settings.cache.diskAria": "磁盘缓存上限（MB）",
  "settings.cache.diskHint":
    "保存后立即套用；降低上限后，超出部分会在后续访问时清理。",
  "settings.cache.diskUsage": "磁盘占用",
  "settings.cache.diskRender": "渲染缓存",
  "settings.cache.diskOnline": "在线原图",
  "settings.cache.diskEmpty": "暂无磁盘缓存统计。",
  "settings.cache.memoryTitle": "内存使用",
  "settings.cache.memoryDescription": "本次运行的内存与缓存快照。",
  "settings.cache.budgetUsage": "内存预算使用",
  "settings.cache.process": "进程占用",
  "settings.cache.imageCache": "图片缓存",
  "settings.cache.cachedPages": "缓存页面",
  "settings.cache.cachedThumbs": "封面缩略图",
  "settings.cache.webtoonCache": "条漫缓存",
  "settings.cache.limit": "内存上限",
  "settings.cache.empty": "暂无内存统计。",
  "settings.cache.pagesValue": "{count} 页",
  "settings.cache.thumbsValue": "{count} 张",
  "settings.cache.webtoonValue": "{size} · {count} 片",
  "settings.cache.maintenanceTitle": "缓存维护",
  "settings.cache.maintenanceDescription":
    "清理后按需重建，不影响书库与阅读进度。",
  "settings.cache.clearThumbs": "清除封面缓存",
  "settings.cache.clearing": "清除中…",
  "settings.cache.clearPages": "清空页面缓存",
  "settings.cache.purging": "清理中…",
  "settings.cache.clearHint":
    "封面缓存清空后，重新进入书库会自动生成。",
  "settings.cache.clearTemp": "一键清空临时缓存",
  "settings.cache.clearingTemp": "正在清空…",
  "settings.cache.clearTempHint":
    "清除内存页缓存、渲染成品与在线原图；封面会按需重建，书库和阅读进度不受影响。",

  "settings.status.loading": "正在加载设置…",
  "settings.status.loadFailed": "设置未加载",
  "settings.status.saving": "正在保存设置…",
  "settings.status.dirty": "有未保存的更改",
  "settings.status.saved": "所有更改已保存",
  "settings.status.saveHint": "保存后写入本机设置",
  "settings.saveButton": "保存设置",

  "settings.errors.loadSettings": "读取设置失败",
  "settings.errors.loadStats": "统计读取失败",
  "settings.errors.connectTest": "连接测试失败",
  "settings.errors.loadSettingsDetail": "设置加载失败：{detail}",

  "settings.toast.scanDone": "扫描完成，书库共 {count} 本",
  "settings.toast.scanErrors": "有 {count} 个条目无法读取，已跳过",
  "settings.toast.proxyFilled": "已填入系统代理，保存后生效",
  "settings.toast.proxyNotFound": "未检测到开启的系统代理",
  "settings.toast.sessionCleared": "已清空内存凭据",
  "settings.toast.urlRequired": "请填写清单或图集 URL",
  "settings.toast.noReadablePages": "清单没有可读页面",
  "settings.toast.thumbsCleared":
    "已清除 {count} 个封面缓存，重新进入书库将自动重建",
  "settings.toast.pagesCleared": "页面缓存已清空",
  "settings.toast.tempCleared": "已清空临时缓存，释放 {size}",
  "settings.toast.saved": "设置已保存",

  "settings.backup.title": "本地备份与恢复",
  "settings.backup.description":
    "把书库索引、阅读进度与偏好打包成单个备份文件；恢复前请先导出当前数据。",
  "settings.backup.export": "导出本地备份 (.mrbackup / .zip)",
  "settings.backup.exporting": "正在导出…",
  "settings.backup.restore": "从备份恢复",
  "settings.backup.restoring": "正在恢复…",
  "settings.backup.saveTitle": "选择备份保存位置",
  "settings.backup.pickTitle": "选择备份文件",
  "settings.backup.filterName": "MangaReader 备份",
  "settings.backup.note":
    "备份包含书库索引、阅读进度、阅读统计、主题/语言/阅读器偏好与自学习过滤规则；不包含图片缓存、会话请求头、Cookie、过滤事件与内部版本标记。恢复会覆盖当前书库与阅读进度，建议先导出当前数据。",
  "settings.backup.confirmTitle": "从备份恢复？",
  "settings.backup.confirmMessage":
    "这会覆盖当前书库、阅读进度与偏好设置，且无法撤销。备份文件：{file}",
  "settings.backup.confirmRestore": "从备份恢复",
  "settings.backup.exported": "已导出备份：{books} 本 · {size}",
  "settings.backup.restored": "已从备份恢复：{books} 本 · {days} 天阅读记录",
  "settings.backup.applied": "已应用备份中的主题、语言与阅读器偏好",
  "settings.backup.error": "备份操作失败，请重试",
} as const;

type SettingsMessages = { [K in keyof typeof zhCN]: string };

const zhTW: SettingsMessages = {
  "settings.page.eyebrow": "偏好設定",
  "settings.page.description":
    "外觀、線上來源、閱讀統計與快取都在這台裝置上管理。",
  "settings.page.localFirst": "本機優先",
  "settings.page.loading": "正在載入設定",

  "settings.tabs.label": "設定分區",
  "settings.tabs.general": "一般與外觀",
  "settings.tabs.online": "線上來源",
  "settings.tabs.reading": "統計",
  "settings.tabs.cache": "快取",
  "settings.tabs.network": "網路與線上來源",
  "settings.tabs.storage": "儲存與資料",
  "settings.tabs.privacy": "隱私與安全",
  "settings.tabs.about": "關於與維護",

  "settings.shortcuts.title": "全域快速鍵",
  "settings.shortcuts.description":
    "輸入框聚焦或輸入法組字中（isComposing / keyCode 229）時，除 Ctrl/Cmd+W 外，全域快速鍵一律不觸發。",
  "settings.shortcuts.note":
    "需要使用快速鍵時請先離開輸入框；Ctrl/Cmd+W（關閉視窗）是唯一例外。",
  "settings.shortcuts.command": "Ctrl/Cmd+K 開啟命令中心",

  "settings.language.title": "介面語言",
  "settings.language.description":
    "選擇介面語言；切換會立即生效並儲存在本機，無需儲存設定。",
  "settings.language.label": "顯示語言",

  "settings.theme.title": "外觀主題",
  "settings.theme.description":
    "選擇介面配色；切換會立即生效，並同步到本機偏好與資料庫。",
  "settings.theme.groupLabel": "主題模式",
  "settings.theme.systemHint": "跟隨系統深淺色切換",
  "settings.theme.lightHint": "冰藍畫布",
  "settings.theme.darkHint": "深夜座艙",
  "settings.theme.systemNote":
    "「跟隨系統」會隨作業系統的深淺色自動切換。",

  "settings.experimental.title": "實驗性功能",
  "settings.experimental.description":
    "預設關閉。開關切換會立即寫入設定，不需要再按儲存。",
  "settings.experimental.webtoonTitle": "條漫模式",
  "settings.experimental.webtoonDescription":
    "韓漫長條縱向連續捲動，在單頁 / 雙頁之外提供第三種版面。",
  "settings.experimental.note":
    "切換只會更新這個開關，不會順帶儲存本頁其他未儲存的修改。",

  "settings.toast.featureOn": "{feature}已開啟",
  "settings.toast.featureOff": "{feature}已關閉",

  "settings.library.title": "書庫目錄",
  "settings.library.description":
    "指定漫畫所在目錄；掃描會把新書加入本機書庫。",
  "settings.library.dirLabel": "掃描目錄",
  "settings.library.dirPlaceholder": "D:\\Manga 或 /path/to/manga",
  "settings.library.pick": "選擇",
  "settings.library.pickTitle": "選擇漫畫目錄",
  "settings.library.clearDir": "清空目錄",
  "settings.library.scanning": "掃描中…",
  "settings.library.scanNow": "立即掃描",
  "settings.library.scanHint":
    "掃描使用上方目錄，無需先儲存；結果會以提示顯示。",

  "settings.about.title": "關於",
  "settings.about.description":
    "MangaReader 是一個本機優先的漫畫閱讀器。",
  "settings.about.version": "版本",
  "settings.about.commit": "建置提交",
  "settings.about.storage": "設定儲存",
  "settings.about.storageValue": "本機 SQLite",
  "settings.about.dataFlow": "資料去向",
  "settings.about.dataFlowValue": "不離開裝置",
  "settings.about.note":
    "設定與閱讀記錄保存在本機；掃描、線上請求與閱讀都不會上傳個人資料。",

  "settings.online.urlTitle": "線上 URL 直讀",
  "settings.online.urlDescription":
    "支援 JSON 清單與單頁 HTML 圖集；關閉時書庫與瀏覽器會提示先開啟。",
  "settings.online.enableTitle": "啟用線上來源",
  "settings.online.enableDescription":
    "允許從線上清單 / 圖集匯入並閱讀，匯入的章節會進入本機書庫。",
  "settings.online.enableNote":
    "切換會立即保存；下方網路參數需點擊底部「儲存設定」後生效。",
  "settings.online.networkTitle": "網路與請求",
  "settings.online.networkDescription":
    "代理、並行與請求標頭會隨線上請求傳送；請只填寫你信任的來源或閘道。",
  "settings.online.proxyLabel": "代理位址",
  "settings.online.proxyPlaceholder":
    "留空直連，或 http://127.0.0.1:7890",
  "settings.online.detectProxy": "系統代理",
  "settings.online.detectProxyTitle":
    "讀取 Windows 系統代理並填入代理位址，不會自動儲存",
  "settings.online.detecting": "偵測中…",
  "settings.online.proxyHint": "支援 http / https / socks5；留空為直連。",
  "settings.online.concurrencyLabel": "頁面並行",
  "settings.online.concurrencyPlaceholder": "選擇並行數",
  "settings.online.concurrencyItem": "{count} 並行",
  "settings.online.concurrencyHint":
    "1–8；並行越高越快，也更容易被來源限流。",
  "settings.online.headersLabel": "自訂請求標頭",
  "settings.online.sessionActive": "工作階段憑證生效中",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 或 session=...; token=...',
  "settings.online.headersHint":
    "請求標頭以明文保存在本機設定中，並會隨請求傳送到你設定的來源或閘道。",
  "settings.online.storageMode": "儲存模式",
  "settings.online.storageModeDescription":
    "工作階段模式不寫入資料庫，結束應用程式即清除。",
  "settings.online.storageModeGroup": "請求標頭儲存模式",
  "settings.online.memoryOnly": "僅駐留記憶體",
  "settings.online.persistLocal": "持久化到本機資料庫",
  "settings.online.sessionPresent":
    "目前有請求標頭保存在處理程序記憶體中。",
  "settings.online.sessionAbsent": "目前沒有工作階段請求標頭。",
  "settings.online.clearSession": "清空記憶體憑證",
  "settings.online.storageModeNote":
    "儲存模式切換後需點擊底部「儲存設定」生效。",
  "settings.online.testTitle": "連線測試",
  "settings.online.testDescription":
    "解析目標清單或圖集，只做探測，不寫入書庫。",
  "settings.online.testUrlAria": "線上清單或圖集測試 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "測試中…",
  "settings.online.testConnection": "測試連線",
  "settings.online.reachable": "可連線",
  "settings.online.testSummary": "{title} · {pages} 頁 · {ms} ms",
  "settings.online.testHint":
    "測試使用已儲存的代理與請求標頭；修改後請先儲存設定。",

  "settings.stats.loadError": "閱讀統計載入失敗：{detail}",
  "settings.stats.loading": "正在彙整本機閱讀記錄…",
  "settings.stats.totalBooks": "總藏書",
  "settings.stats.reading": "在讀",
  "settings.stats.todayPages": "今日閱讀",
  "settings.stats.last7Pages": "近 7 天",
  "settings.stats.unitBooks": "本",
  "settings.stats.note":
    "只統計本機閱讀記錄中實際翻過的頁面；未開啟的書與未記錄進度不計入。",

  "settings.cache.budgetTitle": "記憶體快取預算",
  "settings.cache.budgetDescription":
    "記憶體預算越高，翻頁越順暢，但處理程序記憶體占用也越高。",
  "settings.cache.budgetLabel": "記憶體快取預算",
  "settings.cache.budgetAria": "記憶體快取預算（MB）",
  "settings.cache.budgetHint": "儲存後立即套用到頁面與縮圖的記憶體快取。",
  "settings.cache.diskTitle": "磁碟快取",
  "settings.cache.diskDescription":
    "渲染結果與線上原圖共用同一份磁碟快取，超過上限時會自動清理較舊的檔案。",
  "settings.cache.diskLabel": "磁碟快取上限",
  "settings.cache.diskAria": "磁碟快取上限（MB）",
  "settings.cache.diskHint":
    "儲存後立即套用；調低上限後，超出部分會在後續存取時清理。",
  "settings.cache.diskUsage": "磁碟占用",
  "settings.cache.diskRender": "渲染快取",
  "settings.cache.diskOnline": "線上原圖",
  "settings.cache.diskEmpty": "暫無磁碟快取統計。",
  "settings.cache.memoryTitle": "記憶體使用",
  "settings.cache.memoryDescription": "本次執行的記憶體與快取快照。",
  "settings.cache.budgetUsage": "記憶體預算使用",
  "settings.cache.process": "處理程序占用",
  "settings.cache.imageCache": "圖片快取",
  "settings.cache.cachedPages": "快取頁面",
  "settings.cache.cachedThumbs": "封面縮圖",
  "settings.cache.webtoonCache": "條漫快取",
  "settings.cache.limit": "記憶體上限",
  "settings.cache.empty": "暫無記憶體統計。",
  "settings.cache.pagesValue": "{count} 頁",
  "settings.cache.thumbsValue": "{count} 張",
  "settings.cache.webtoonValue": "{size} · {count} 片",
  "settings.cache.maintenanceTitle": "快取維護",
  "settings.cache.maintenanceDescription":
    "清理後按需重建，不影響書庫與閱讀進度。",
  "settings.cache.clearThumbs": "清除封面快取",
  "settings.cache.clearing": "清除中…",
  "settings.cache.clearPages": "清空頁面快取",
  "settings.cache.purging": "清理中…",
  "settings.cache.clearHint":
    "封面快取清空後，重新進入書庫會自動產生。",
  "settings.cache.clearTemp": "一鍵清空臨時快取",
  "settings.cache.clearingTemp": "正在清空…",
  "settings.cache.clearTempHint":
    "清除記憶體頁面快取、渲染成品與線上原圖；封面會按需重建，書庫與閱讀進度不受影響。",

  "settings.status.loading": "正在載入設定…",
  "settings.status.loadFailed": "設定未載入",
  "settings.status.saving": "正在儲存設定…",
  "settings.status.dirty": "有未儲存的變更",
  "settings.status.saved": "所有變更已儲存",
  "settings.status.saveHint": "儲存後寫入本機設定",
  "settings.saveButton": "儲存設定",

  "settings.errors.loadSettings": "讀取設定失敗",
  "settings.errors.loadStats": "統計讀取失敗",
  "settings.errors.connectTest": "連線測試失敗",
  "settings.errors.loadSettingsDetail": "設定載入失敗：{detail}",

  "settings.toast.scanDone": "掃描完成，書庫共 {count} 本",
  "settings.toast.scanErrors": "有 {count} 個項目無法讀取，已跳過",
  "settings.toast.proxyFilled": "已填入系統代理，儲存後生效",
  "settings.toast.proxyNotFound": "未偵測到開啟的系統代理",
  "settings.toast.sessionCleared": "已清空記憶體憑證",
  "settings.toast.urlRequired": "請填寫清單或圖集 URL",
  "settings.toast.noReadablePages": "清單沒有可讀頁面",
  "settings.toast.thumbsCleared":
    "已清除 {count} 個封面快取，重新進入書庫將自動重建",
  "settings.toast.pagesCleared": "頁面快取已清空",
  "settings.toast.tempCleared": "已清空臨時快取，釋放 {size}",
  "settings.toast.saved": "設定已儲存",

  "settings.backup.title": "本機備份與還原",
  "settings.backup.description":
    "將書庫索引、閱讀進度與偏好打包成單一備份檔；還原前請先匯出目前資料。",
  "settings.backup.export": "匯出本機備份 (.mrbackup / .zip)",
  "settings.backup.exporting": "正在匯出…",
  "settings.backup.restore": "從備份還原",
  "settings.backup.restoring": "正在還原…",
  "settings.backup.saveTitle": "選擇備份儲存位置",
  "settings.backup.pickTitle": "選擇備份檔案",
  "settings.backup.filterName": "MangaReader 備份",
  "settings.backup.note":
    "備份包含書庫索引、閱讀進度、閱讀統計、主題/語言/閱讀器偏好與自學過濾規則；不包含圖片快取、工作階段請求標頭、Cookie、過濾事件與內部版本標記。還原會覆蓋目前的書庫與閱讀進度，建議先匯出目前資料。",
  "settings.backup.confirmTitle": "要從備份還原嗎？",
  "settings.backup.confirmMessage":
    "這會覆蓋目前的書庫、閱讀進度與偏好設定，且無法復原。備份檔案：{file}",
  "settings.backup.confirmRestore": "從備份還原",
  "settings.backup.exported": "已匯出備份：{books} 本 · {size}",
  "settings.backup.restored": "已從備份還原：{books} 本 · {days} 天閱讀記錄",
  "settings.backup.applied": "已套用備份中的主題、語言與閱讀器偏好",
  "settings.backup.error": "備份操作失敗，請再試一次",
};

const en: SettingsMessages = {
  "settings.page.eyebrow": "Preferences",
  "settings.page.description":
    "Appearance, online sources, reading stats and cache are managed on this device.",
  "settings.page.localFirst": "Local first",
  "settings.page.loading": "Loading settings",

  "settings.tabs.label": "Settings sections",
  "settings.tabs.general": "General & appearance",
  "settings.tabs.online": "Online",
  "settings.tabs.reading": "Stats",
  "settings.tabs.cache": "Cache",
  "settings.tabs.network": "Network & sources",
  "settings.tabs.storage": "Storage & data",
  "settings.tabs.privacy": "Privacy & security",
  "settings.tabs.about": "About & maintenance",

  "settings.shortcuts.title": "Global shortcuts",
  "settings.shortcuts.description":
    "While an input is focused or an IME is composing (isComposing / keyCode 229), no global shortcut fires except Ctrl/Cmd+W.",
  "settings.shortcuts.note":
    "Move focus out of the input first; Ctrl/Cmd+W (close window) is the only exception.",
  "settings.shortcuts.command": "Ctrl/Cmd+K opens the command center",

  "settings.language.title": "Interface language",
  "settings.language.description":
    "Choose the interface language. Changes apply instantly and are saved on this device; no save is needed.",
  "settings.language.label": "Display language",

  "settings.theme.title": "Appearance",
  "settings.theme.description":
    "Choose the interface palette. Changes apply instantly and sync to local preferences and the database.",
  "settings.theme.groupLabel": "Theme mode",
  "settings.theme.systemHint": "Follows system light/dark",
  "settings.theme.lightHint": "Ice-blue canvas",
  "settings.theme.darkHint": "Midnight cockpit",
  "settings.theme.systemNote":
    "“System” follows your operating system's light and dark appearance automatically.",

  "settings.experimental.title": "Experimental features",
  "settings.experimental.description":
    "Off by default. Toggling writes to settings immediately; no save is needed.",
  "settings.experimental.webtoonTitle": "Webtoon mode",
  "settings.experimental.webtoonDescription":
    "Continuous vertical scrolling for long-strip comics, a third layout beyond single and double page.",
  "settings.experimental.note":
    "Toggling only updates this switch; other unsaved changes on this page are not saved.",

  "settings.toast.featureOn": "{feature} enabled",
  "settings.toast.featureOff": "{feature} disabled",

  "settings.library.title": "Library folder",
  "settings.library.description":
    "Choose the folder containing your manga; scanning adds new books to this device's library.",
  "settings.library.dirLabel": "Scan folder",
  "settings.library.dirPlaceholder": "D:\\Manga or /path/to/manga",
  "settings.library.pick": "Browse",
  "settings.library.pickTitle": "Choose manga folder",
  "settings.library.clearDir": "Clear folder",
  "settings.library.scanning": "Scanning…",
  "settings.library.scanNow": "Scan now",
  "settings.library.scanHint":
    "Scanning uses the folder above; no save needed. Results appear as a notification.",

  "settings.about.title": "About",
  "settings.about.description": "MangaReader is a local-first manga reader.",
  "settings.about.version": "Version",
  "settings.about.commit": "Build commit",
  "settings.about.storage": "Settings storage",
  "settings.about.storageValue": "Local SQLite",
  "settings.about.dataFlow": "Data stays",
  "settings.about.dataFlowValue": "On this device",
  "settings.about.note":
    "Settings and reading history stay on this device. Scanning, online requests and reading never upload personal data.",

  "settings.online.urlTitle": "Online URL reading",
  "settings.online.urlDescription":
    "Supports JSON manifests and single-page HTML galleries. When off, the library and browser prompt you to enable it.",
  "settings.online.enableTitle": "Enable online sources",
  "settings.online.enableDescription":
    "Import and read from online manifests or galleries; imported chapters are added to this device's library.",
  "settings.online.enableNote":
    "Toggling persists immediately; network options below take effect after you click “Save settings”.",
  "settings.online.networkTitle": "Network & requests",
  "settings.online.networkDescription":
    "Proxy, concurrency and headers are sent with online requests. Only configure sources or gateways you trust.",
  "settings.online.proxyLabel": "Proxy address",
  "settings.online.proxyPlaceholder":
    "Leave empty for direct, or http://127.0.0.1:7890",
  "settings.online.detectProxy": "System proxy",
  "settings.online.detectProxyTitle":
    "Read the Windows system proxy into the proxy field; it is not saved automatically",
  "settings.online.detecting": "Detecting…",
  "settings.online.proxyHint":
    "Supports http / https / socks5; leave empty for a direct connection.",
  "settings.online.concurrencyLabel": "Page concurrency",
  "settings.online.concurrencyPlaceholder": "Select concurrency",
  "settings.online.concurrencyItem": "{count} concurrent",
  "settings.online.concurrencyHint":
    "1–8; higher concurrency is faster but more likely to be rate-limited by the source.",
  "settings.online.headersLabel": "Custom headers",
  "settings.online.sessionActive": "Session credentials active",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} or session=...; token=...',
  "settings.online.headersHint":
    "Headers are stored in plain text in local settings and sent with requests to the source or gateway you configure.",
  "settings.online.storageMode": "Storage mode",
  "settings.online.storageModeDescription":
    "Session mode is not written to the database and is cleared when the app exits.",
  "settings.online.storageModeGroup": "Header storage mode",
  "settings.online.memoryOnly": "Memory only",
  "settings.online.persistLocal": "Persist locally",
  "settings.online.sessionPresent":
    "Headers are currently stored in process memory.",
  "settings.online.sessionAbsent": "No session headers right now.",
  "settings.online.clearSession": "Clear memory credentials",
  "settings.online.storageModeNote":
    "After changing storage mode, click “Save settings” at the bottom to apply.",
  "settings.online.testTitle": "Connectivity test",
  "settings.online.testDescription":
    "Parses the target manifest or gallery as a probe only; nothing is written to the library.",
  "settings.online.testUrlAria": "Online manifest or gallery test URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "Testing…",
  "settings.online.testConnection": "Test connection",
  "settings.online.reachable": "Reachable",
  "settings.online.testSummary": "{title} · {pages} pages · {ms} ms",
  "settings.online.testHint":
    "The test uses saved proxy and headers; save your changes first.",

  "settings.stats.loadError": "Failed to load reading stats: {detail}",
  "settings.stats.loading": "Summarizing local reading history…",
  "settings.stats.totalBooks": "Total books",
  "settings.stats.reading": "Reading",
  "settings.stats.todayPages": "Pages today",
  "settings.stats.last7Pages": "Last 7 days",
  "settings.stats.unitBooks": "books",
  "settings.stats.note":
    "Only pages actually turned in local reading history are counted; unopened books and unrecorded progress are excluded.",

  "settings.cache.budgetTitle": "Memory cache budget",
  "settings.cache.budgetDescription":
    "A higher memory budget makes page turns smoother but increases process memory use.",
  "settings.cache.budgetLabel": "Memory cache budget",
  "settings.cache.budgetAria": "Memory cache budget (MB)",
  "settings.cache.budgetHint":
    "Applied to the in-memory page and thumbnail caches immediately after saving.",
  "settings.cache.diskTitle": "Disk cache",
  "settings.cache.diskDescription":
    "Rendered pages and online originals share one disk cache; older files are evicted automatically when the limit is exceeded.",
  "settings.cache.diskLabel": "Disk cache limit",
  "settings.cache.diskAria": "Disk cache limit (MB)",
  "settings.cache.diskHint":
    "Applied immediately after saving; lowering the limit cleans up excess files on later access.",
  "settings.cache.diskUsage": "Disk usage",
  "settings.cache.diskRender": "Render cache",
  "settings.cache.diskOnline": "Online originals",
  "settings.cache.diskEmpty": "No disk cache stats yet.",
  "settings.cache.memoryTitle": "Memory usage",
  "settings.cache.memoryDescription": "Memory and cache snapshot for this run.",
  "settings.cache.budgetUsage": "Memory budget usage",
  "settings.cache.process": "Process",
  "settings.cache.imageCache": "Image cache",
  "settings.cache.cachedPages": "Cached pages",
  "settings.cache.cachedThumbs": "Cover thumbnails",
  "settings.cache.webtoonCache": "Webtoon cache",
  "settings.cache.limit": "Memory limit",
  "settings.cache.empty": "No memory stats yet.",
  "settings.cache.pagesValue": "{count} pages",
  "settings.cache.thumbsValue": "{count} thumbs",
  "settings.cache.webtoonValue": "{size} · {count} tiles",
  "settings.cache.maintenanceTitle": "Cache maintenance",
  "settings.cache.maintenanceDescription":
    "Cleared items rebuild on demand without affecting the library or reading progress.",
  "settings.cache.clearThumbs": "Clear cover cache",
  "settings.cache.clearing": "Clearing…",
  "settings.cache.clearPages": "Clear page cache",
  "settings.cache.purging": "Purging…",
  "settings.cache.clearHint":
    "Cover thumbnails regenerate automatically the next time you open the library.",
  "settings.cache.clearTemp": "Clear temporary cache",
  "settings.cache.clearingTemp": "Clearing…",
  "settings.cache.clearTempHint":
    "Clears in-memory pages, rendered files and online originals; covers rebuild as needed, while the library and reading progress are unaffected.",

  "settings.status.loading": "Loading settings…",
  "settings.status.loadFailed": "Settings not loaded",
  "settings.status.saving": "Saving settings…",
  "settings.status.dirty": "Unsaved changes",
  "settings.status.saved": "All changes saved",
  "settings.status.saveHint": "Saved to this device's settings",
  "settings.saveButton": "Save settings",

  "settings.errors.loadSettings": "Failed to read settings",
  "settings.errors.loadStats": "Failed to read stats",
  "settings.errors.connectTest": "Connection test failed",
  "settings.errors.loadSettingsDetail": "Failed to load settings: {detail}",

  "settings.toast.scanDone": "Scan complete. {count} books in the library.",
  "settings.toast.scanErrors": "{count} entries could not be read and were skipped",
  "settings.toast.proxyFilled": "System proxy filled in; save to apply",
  "settings.toast.proxyNotFound": "No enabled system proxy detected",
  "settings.toast.sessionCleared": "Memory credentials cleared",
  "settings.toast.urlRequired": "Enter a manifest or gallery URL",
  "settings.toast.noReadablePages": "The manifest has no readable pages",
  "settings.toast.thumbsCleared":
    "Cleared {count} cover thumbnails; they will rebuild when you reopen the library",
  "settings.toast.pagesCleared": "Page cache cleared",
  "settings.toast.tempCleared": "Temporary cache cleared, {size} freed",
  "settings.toast.saved": "Settings saved",

  "settings.backup.title": "Local backup & restore",
  "settings.backup.description":
    "Pack the library index, reading progress and preferences into one backup file; export current data before restoring.",
  "settings.backup.export": "Export local backup (.mrbackup / .zip)",
  "settings.backup.exporting": "Exporting…",
  "settings.backup.restore": "Restore from backup",
  "settings.backup.restoring": "Restoring…",
  "settings.backup.saveTitle": "Choose where to save the backup",
  "settings.backup.pickTitle": "Choose a backup file",
  "settings.backup.filterName": "MangaReader backup",
  "settings.backup.note":
    "The backup contains the library index, reading progress, reading stats, theme/language/reader preferences and self-learned filter rules. It does not include image caches, session request headers, cookies, filter events or internal version markers. Restoring overwrites the current library and reading progress, so export first.",
  "settings.backup.confirmTitle": "Restore from this backup?",
  "settings.backup.confirmMessage":
    "This overwrites the current library, reading progress and preferences and cannot be undone. Backup file: {file}",
  "settings.backup.confirmRestore": "Restore backup",
  "settings.backup.exported": "Backup exported: {books} books · {size}",
  "settings.backup.restored":
    "Backup restored: {books} books · {days} reading days",
  "settings.backup.applied":
    "Theme, language and reader preferences from the backup were applied",
  "settings.backup.error": "Backup operation failed. Please try again.",
};

const es: SettingsMessages = {
  "settings.page.eyebrow": "Preferencias",
  "settings.page.description":
    "La apariencia, las fuentes en línea, las estadísticas y la caché se gestionan en este dispositivo.",
  "settings.page.localFirst": "Prioridad local",
  "settings.page.loading": "Cargando ajustes",

  "settings.tabs.label": "Secciones de ajustes",
  "settings.tabs.general": "General y apariencia",
  "settings.tabs.online": "En línea",
  "settings.tabs.reading": "Datos",
  "settings.tabs.cache": "Caché",
  "settings.tabs.network": "Red y fuentes",
  "settings.tabs.storage": "Almacenamiento y datos",
  "settings.tabs.privacy": "Privacidad y seguridad",
  "settings.tabs.about": "Acerca de y mantenimiento",

  "settings.shortcuts.title": "Atajos globales",
  "settings.shortcuts.description":
    "Con un campo enfocado o el IME en composición (isComposing / keyCode 229), ningún atajo global se activa salvo Ctrl/Cmd+W.",
  "settings.shortcuts.note":
    "Quita el foco del campo primero; Ctrl/Cmd+W (cerrar ventana) es la única excepción.",
  "settings.shortcuts.command": "Ctrl/Cmd+K abre el centro de comandos",

  "settings.language.title": "Idioma de la interfaz",
  "settings.language.description":
    "Elige el idioma de la interfaz. El cambio se aplica al instante y se guarda en este dispositivo; no hace falta guardar.",
  "settings.language.label": "Idioma mostrado",

  "settings.theme.title": "Apariencia",
  "settings.theme.description":
    "Elige la paleta de la interfaz. El cambio se aplica al instante y se sincroniza con las preferencias locales y la base de datos.",
  "settings.theme.groupLabel": "Modo de tema",
  "settings.theme.systemHint": "Sigue el claro/oscuro del sistema",
  "settings.theme.lightHint": "Lienzo azul hielo",
  "settings.theme.darkHint": "Cabina nocturna",
  "settings.theme.systemNote":
    "«Sistema» sigue automáticamente el modo claro u oscuro del sistema operativo.",

  "settings.experimental.title": "Funciones experimentales",
  "settings.experimental.description":
    "Desactivadas por defecto. Cada interruptor se guarda al instante; no hace falta guardar.",
  "settings.experimental.webtoonTitle": "Modo webtoon",
  "settings.experimental.webtoonDescription":
    "Desplazamiento vertical continuo para cómics de tira larga, un tercer diseño además de página única y doble.",
  "settings.experimental.note":
    "Cambiar este interruptor no guarda otros cambios sin guardar de esta página.",

  "settings.toast.featureOn": "Se activó «{feature}»",
  "settings.toast.featureOff": "Se desactivó «{feature}»",

  "settings.library.title": "Carpeta de la biblioteca",
  "settings.library.description":
    "Indica la carpeta donde están tus cómics; el escaneo añade libros nuevos a la biblioteca de este dispositivo.",
  "settings.library.dirLabel": "Carpeta de escaneo",
  "settings.library.dirPlaceholder": "D:\\Manga o /path/to/manga",
  "settings.library.pick": "Elegir",
  "settings.library.pickTitle": "Elegir carpeta de cómics",
  "settings.library.clearDir": "Vaciar carpeta",
  "settings.library.scanning": "Escaneando…",
  "settings.library.scanNow": "Escanear ahora",
  "settings.library.scanHint":
    "El escaneo usa la carpeta de arriba; no hace falta guardar. El resultado aparece como aviso.",

  "settings.about.title": "Acerca de",
  "settings.about.description":
    "MangaReader es un lector de cómics que prioriza lo local.",
  "settings.about.version": "Versión",
  "settings.about.commit": "Commit de compilación",
  "settings.about.storage": "Almacenamiento",
  "settings.about.storageValue": "SQLite local",
  "settings.about.dataFlow": "Ubicación de datos",
  "settings.about.dataFlowValue": "En este dispositivo",
  "settings.about.note":
    "Los ajustes y el historial de lectura permanecen en este dispositivo. El escaneo, las solicitudes en línea y la lectura nunca suben datos personales.",

  "settings.online.urlTitle": "Lectura por URL en línea",
  "settings.online.urlDescription":
    "Admite manifiestos JSON y galerías HTML de una página. Si está desactivado, la biblioteca y el navegador te piden activarlo.",
  "settings.online.enableTitle": "Activar fuentes en línea",
  "settings.online.enableDescription":
    "Permite importar y leer desde manifiestos o galerías en línea; los capítulos importados se añaden a la biblioteca local.",
  "settings.online.enableNote":
    "El interruptor se guarda al instante; los parámetros de red de abajo se aplican tras pulsar «Guardar ajustes».",
  "settings.online.networkTitle": "Red y solicitudes",
  "settings.online.networkDescription":
    "El proxy, la concurrencia y las cabeceras se envían con las solicitudes en línea. Configura solo fuentes o pasarelas de confianza.",
  "settings.online.proxyLabel": "Dirección del proxy",
  "settings.online.proxyPlaceholder":
    "Vacío para conexión directa, o http://127.0.0.1:7890",
  "settings.online.detectProxy": "Proxy del sistema",
  "settings.online.detectProxyTitle":
    "Lee el proxy del sistema de Windows y lo rellena; no se guarda automáticamente",
  "settings.online.detecting": "Detectando…",
  "settings.online.proxyHint":
    "Compatible con http / https / socks5; vacío para conexión directa.",
  "settings.online.concurrencyLabel": "Concurrencia de páginas",
  "settings.online.concurrencyPlaceholder": "Elegir concurrencia",
  "settings.online.concurrencyItem": "{count} en paralelo",
  "settings.online.concurrencyHint":
    "1–8; más concurrencia es más rápido, pero la fuente puede limitarte.",
  "settings.online.headersLabel": "Cabeceras personalizadas",
  "settings.online.sessionActive": "Credenciales de sesión activas",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} o session=...; token=...',
  "settings.online.headersHint":
    "Las cabeceras se guardan en texto plano en los ajustes locales y se envían con las solicitudes a la fuente o pasarela configurada.",
  "settings.online.storageMode": "Modo de almacenamiento",
  "settings.online.storageModeDescription":
    "El modo de sesión no se escribe en la base de datos y se borra al salir de la aplicación.",
  "settings.online.storageModeGroup": "Modo de almacenamiento de cabeceras",
  "settings.online.memoryOnly": "Solo en memoria",
  "settings.online.persistLocal": "Guardar en local",
  "settings.online.sessionPresent":
    "Ahora mismo hay cabeceras en la memoria del proceso.",
  "settings.online.sessionAbsent": "No hay cabeceras de sesión.",
  "settings.online.clearSession": "Borrar credenciales en memoria",
  "settings.online.storageModeNote":
    "Tras cambiar el modo, pulsa «Guardar ajustes» abajo para aplicarlo.",
  "settings.online.testTitle": "Prueba de conectividad",
  "settings.online.testDescription":
    "Analiza el manifiesto o la galería solo como prueba; no escribe en la biblioteca.",
  "settings.online.testUrlAria":
    "URL de prueba de manifiesto o galería en línea",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "Probando…",
  "settings.online.testConnection": "Probar conexión",
  "settings.online.reachable": "Accesible",
  "settings.online.testSummary": "{title} · {pages} páginas · {ms} ms",
  "settings.online.testHint":
    "La prueba usa el proxy y las cabeceras guardados; guarda los cambios primero.",

  "settings.stats.loadError": "Error al cargar estadísticas: {detail}",
  "settings.stats.loading": "Resumiendo el historial de lectura local…",
  "settings.stats.totalBooks": "Libros totales",
  "settings.stats.reading": "En lectura",
  "settings.stats.todayPages": "Páginas hoy",
  "settings.stats.last7Pages": "Últimos 7 días",
  "settings.stats.unitBooks": "libros",
  "settings.stats.note":
    "Solo se cuentan las páginas realmente pasadas en el historial local; los libros sin abrir y el progreso no registrado no cuentan.",

  "settings.cache.budgetTitle": "Presupuesto de caché en memoria",
  "settings.cache.budgetDescription":
    "Un presupuesto de memoria mayor hace más fluido el cambio de página, pero usa más memoria del proceso.",
  "settings.cache.budgetLabel": "Presupuesto de caché en memoria",
  "settings.cache.budgetAria": "Presupuesto de caché en memoria (MB)",
  "settings.cache.budgetHint":
    "Se aplica a la caché de páginas y miniaturas en memoria al guardar.",
  "settings.cache.diskTitle": "Caché en disco",
  "settings.cache.diskDescription":
    "Las páginas renderizadas y los originales en línea comparten una caché en disco; los archivos antiguos se eliminan al superar el límite.",
  "settings.cache.diskLabel": "Límite de caché en disco",
  "settings.cache.diskAria": "Límite de caché en disco (MB)",
  "settings.cache.diskHint":
    "Se aplica al guardar; al bajar el límite, el exceso se limpia en accesos posteriores.",
  "settings.cache.diskUsage": "Uso en disco",
  "settings.cache.diskRender": "Caché de renderizado",
  "settings.cache.diskOnline": "Originales en línea",
  "settings.cache.diskEmpty": "Aún no hay estadísticas de caché en disco.",
  "settings.cache.memoryTitle": "Uso de memoria",
  "settings.cache.memoryDescription":
    "Instantánea de memoria y caché de esta ejecución.",
  "settings.cache.budgetUsage": "Uso del presupuesto de memoria",
  "settings.cache.process": "Proceso",
  "settings.cache.imageCache": "Caché de imágenes",
  "settings.cache.cachedPages": "Páginas en caché",
  "settings.cache.cachedThumbs": "Miniaturas de portada",
  "settings.cache.webtoonCache": "Caché de webtoon",
  "settings.cache.limit": "Límite de memoria",
  "settings.cache.empty": "Aún no hay estadísticas de memoria.",
  "settings.cache.pagesValue": "{count} páginas",
  "settings.cache.thumbsValue": "{count} miniaturas",
  "settings.cache.webtoonValue": "{size} · {count} fragmentos",
  "settings.cache.maintenanceTitle": "Mantenimiento de caché",
  "settings.cache.maintenanceDescription":
    "Lo borrado se reconstruye cuando hace falta, sin afectar a la biblioteca ni al progreso.",
  "settings.cache.clearThumbs": "Borrar caché de portadas",
  "settings.cache.clearing": "Borrando…",
  "settings.cache.clearPages": "Vaciar caché de páginas",
  "settings.cache.purging": "Limpiando…",
  "settings.cache.clearHint":
    "Las miniaturas de portada se regeneran al volver a abrir la biblioteca.",
  "settings.cache.clearTemp": "Vaciar caché temporal",
  "settings.cache.clearingTemp": "Vaciando…",
  "settings.cache.clearTempHint":
    "Borra las páginas en memoria, los archivos renderizados y los originales en línea; las portadas se reconstruyen cuando haga falta y la biblioteca y el progreso no se ven afectados.",

  "settings.status.loading": "Cargando ajustes…",
  "settings.status.loadFailed": "Ajustes no cargados",
  "settings.status.saving": "Guardando ajustes…",
  "settings.status.dirty": "Cambios sin guardar",
  "settings.status.saved": "Todos los cambios guardados",
  "settings.status.saveHint": "Se guarda en los ajustes de este dispositivo",
  "settings.saveButton": "Guardar ajustes",

  "settings.errors.loadSettings": "Error al leer los ajustes",
  "settings.errors.loadStats": "Error al leer las estadísticas",
  "settings.errors.connectTest": "Error en la prueba de conexión",
  "settings.errors.loadSettingsDetail": "Error al cargar los ajustes: {detail}",

  "settings.toast.scanDone":
    "Escaneo completado. {count} libros en la biblioteca.",
  "settings.toast.scanErrors":
    "No se pudieron leer {count} entradas; se omitieron",
  "settings.toast.proxyFilled":
    "Proxy del sistema rellenado; guarda para aplicar",
  "settings.toast.proxyNotFound":
    "No se detectó ningún proxy del sistema activado",
  "settings.toast.sessionCleared": "Credenciales en memoria borradas",
  "settings.toast.urlRequired": "Introduce una URL de manifiesto o galería",
  "settings.toast.noReadablePages":
    "El manifiesto no tiene páginas legibles",
  "settings.toast.thumbsCleared":
    "Se borraron {count} miniaturas; se reconstruirán al reabrir la biblioteca",
  "settings.toast.pagesCleared": "Caché de páginas vaciada",
  "settings.toast.tempCleared":
    "Caché temporal vaciada; se liberaron {size}",
  "settings.toast.saved": "Ajustes guardados",

  "settings.backup.title": "Copia local y restauración",
  "settings.backup.description":
    "Empaqueta el índice de la biblioteca, el progreso de lectura y las preferencias en un solo archivo; exporta los datos actuales antes de restaurar.",
  "settings.backup.export": "Exportar copia local (.mrbackup / .zip)",
  "settings.backup.exporting": "Exportando…",
  "settings.backup.restore": "Restaurar desde copia",
  "settings.backup.restoring": "Restaurando…",
  "settings.backup.saveTitle": "Elegir dónde guardar la copia",
  "settings.backup.pickTitle": "Elegir un archivo de copia",
  "settings.backup.filterName": "Copia de MangaReader",
  "settings.backup.note":
    "La copia incluye el índice de la biblioteca, el progreso y las estadísticas de lectura, las preferencias de tema/idioma/lector y las reglas de filtrado aprendidas. No incluye cachés de imágenes, cabeceras de sesión, cookies, eventos de filtrado ni marcas internas de versión. Restaurar sobrescribe la biblioteca y el progreso actuales, así que exporta primero.",
  "settings.backup.confirmTitle": "¿Restaurar desde esta copia?",
  "settings.backup.confirmMessage":
    "Esto sobrescribe la biblioteca, el progreso de lectura y las preferencias actuales, y no se puede deshacer. Archivo: {file}",
  "settings.backup.confirmRestore": "Restaurar copia",
  "settings.backup.exported": "Copia exportada: {books} libros · {size}",
  "settings.backup.restored":
    "Copia restaurada: {books} libros · {days} días de lectura",
  "settings.backup.applied":
    "Se aplicaron el tema, el idioma y las preferencias de lectura de la copia",
  "settings.backup.error":
    "La operación de copia falló. Inténtalo de nuevo.",
};

const ja: SettingsMessages = {
  "settings.page.eyebrow": "環境設定",
  "settings.page.description":
    "外観、オンラインソース、読書統計、キャッシュはこのデバイスで管理されます。",
  "settings.page.localFirst": "ローカル優先",
  "settings.page.loading": "設定を読み込み中",

  "settings.tabs.label": "設定セクション",
  "settings.tabs.general": "一般と外観",
  "settings.tabs.online": "オンライン",
  "settings.tabs.reading": "統計",
  "settings.tabs.cache": "キャッシュ",
  "settings.tabs.network": "ネットワークとソース",
  "settings.tabs.storage": "ストレージとデータ",
  "settings.tabs.privacy": "プライバシーとセキュリティ",
  "settings.tabs.about": "情報とメンテナンス",

  "settings.shortcuts.title": "グローバルショートカット",
  "settings.shortcuts.description":
    "入力欄にフォーカスがある、または IME 変換中（isComposing / keyCode 229）は、Ctrl/Cmd+W 以外のグローバルショートカットは動作しません。",
  "settings.shortcuts.note":
    "ショートカットを使う前にフォーカスを外してください。Ctrl/Cmd+W（ウィンドウを閉じる）だけが例外です。",
  "settings.shortcuts.command": "Ctrl/Cmd+K でコマンドセンターを開く",

  "settings.language.title": "表示言語",
  "settings.language.description":
    "UI の言語を選択します。切り替えはすぐに反映され、このデバイスに保存されるため、保存操作は不要です。",
  "settings.language.label": "表示言語",

  "settings.theme.title": "外観テーマ",
  "settings.theme.description":
    "配色を選択します。切り替えはすぐに反映され、ローカル設定とデータベースに同期されます。",
  "settings.theme.groupLabel": "テーマモード",
  "settings.theme.systemHint": "システムの明暗に追従",
  "settings.theme.lightHint": "アイスブルーのキャンバス",
  "settings.theme.darkHint": "深夜のコックピット",
  "settings.theme.systemNote":
    "「システム」は OS のライト / ダークに合わせて自動で切り替わります。",

  "settings.experimental.title": "実験的機能",
  "settings.experimental.description":
    "既定ではオフです。スイッチの切り替えはすぐに設定へ保存され、保存操作は不要です。",
  "settings.experimental.webtoonTitle": "Webtoon モード",
  "settings.experimental.webtoonDescription":
    "縦長作品を途切れず縦スクロール。単ページ / 見開きに続く第 3 のレイアウトです。",
  "settings.experimental.note":
    "このスイッチのみを更新し、このページの他の未保存の変更は保存しません。",

  "settings.toast.featureOn": "{feature}をオンにしました",
  "settings.toast.featureOff": "{feature}をオフにしました",

  "settings.library.title": "ライブラリフォルダー",
  "settings.library.description":
    "漫画のあるフォルダーを指定します。スキャンで新しい本をこのデバイスのライブラリに追加します。",
  "settings.library.dirLabel": "スキャンフォルダー",
  "settings.library.dirPlaceholder": "D:\\Manga または /path/to/manga",
  "settings.library.pick": "選択",
  "settings.library.pickTitle": "漫画フォルダーを選択",
  "settings.library.clearDir": "フォルダーをクリア",
  "settings.library.scanning": "スキャン中…",
  "settings.library.scanNow": "今すぐスキャン",
  "settings.library.scanHint":
    "上のフォルダーを使ってスキャンします。保存は不要で、結果は通知で表示されます。",

  "settings.about.title": "このアプリについて",
  "settings.about.description":
    "MangaReader はローカル優先の漫画リーダーです。",
  "settings.about.version": "バージョン",
  "settings.about.commit": "ビルドコミット",
  "settings.about.storage": "設定の保存先",
  "settings.about.storageValue": "ローカル SQLite",
  "settings.about.dataFlow": "データの行き先",
  "settings.about.dataFlowValue": "デバイス内のみ",
  "settings.about.note":
    "設定と読書履歴はこのデバイスに保存されます。スキャン、オンラインリクエスト、閲覧で個人データをアップロードすることはありません。",

  "settings.online.urlTitle": "オンライン URL 直読み",
  "settings.online.urlDescription":
    "JSON マニフェストと単ページ HTML ギャラリーに対応。オフの場合、ライブラリとブラウザーで有効化を促します。",
  "settings.online.enableTitle": "オンラインソースを有効化",
  "settings.online.enableDescription":
    "オンラインのマニフェスト / ギャラリーからインポートして閲覧できます。取り込んだ話はローカルライブラリに追加されます。",
  "settings.online.enableNote":
    "切り替えはすぐに保存されます。下のネットワーク設定は下部の「設定を保存」で反映されます。",
  "settings.online.networkTitle": "ネットワークとリクエスト",
  "settings.online.networkDescription":
    "プロキシ、並列数、ヘッダーはオンラインリクエストとともに送信されます。信頼できるソースかゲートウェイのみ設定してください。",
  "settings.online.proxyLabel": "プロキシアドレス",
  "settings.online.proxyPlaceholder":
    "空欄で直接接続、または http://127.0.0.1:7890",
  "settings.online.detectProxy": "システムプロキシ",
  "settings.online.detectProxyTitle":
    "Windows のシステムプロキシを読み取って入力します。自動保存はされません",
  "settings.online.detecting": "検出中…",
  "settings.online.proxyHint":
    "http / https / socks5 に対応。空欄は直接接続です。",
  "settings.online.concurrencyLabel": "ページ並列数",
  "settings.online.concurrencyPlaceholder": "並列数を選択",
  "settings.online.concurrencyItem": "{count} 並列",
  "settings.online.concurrencyHint":
    "1–8。高いほど速くなりますが、ソース側の制限を受けやすくなります。",
  "settings.online.headersLabel": "カスタムヘッダー",
  "settings.online.sessionActive": "セッション認証情報が有効",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} または session=...; token=...',
  "settings.online.headersHint":
    "ヘッダーはローカル設定に平文で保存され、設定したソースやゲートウェイへのリクエストに付与されます。",
  "settings.online.storageMode": "保存モード",
  "settings.online.storageModeDescription":
    "セッションモードはデータベースに書き込まれず、アプリ終了時に消去されます。",
  "settings.online.storageModeGroup": "ヘッダーの保存モード",
  "settings.online.memoryOnly": "メモリのみ",
  "settings.online.persistLocal": "ローカルに保存",
  "settings.online.sessionPresent":
    "現在、ヘッダーはプロセスメモリに保存されています。",
  "settings.online.sessionAbsent": "現在セッションヘッダーはありません。",
  "settings.online.clearSession": "メモリ上の認証情報を消去",
  "settings.online.storageModeNote":
    "保存モードを切り替えたら、下部の「設定を保存」で反映してください。",
  "settings.online.testTitle": "接続テスト",
  "settings.online.testDescription":
    "対象のマニフェストやギャラリーを解析するだけで、ライブラリには書き込みません。",
  "settings.online.testUrlAria":
    "オンラインマニフェストまたはギャラリーのテスト URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "テスト中…",
  "settings.online.testConnection": "接続をテスト",
  "settings.online.reachable": "接続可能",
  "settings.online.testSummary": "{title} · {pages} ページ · {ms} ms",
  "settings.online.testHint":
    "テストは保存済みのプロキシとヘッダーを使用します。変更後は先に保存してください。",

  "settings.stats.loadError": "読書統計の読み込みに失敗しました：{detail}",
  "settings.stats.loading": "ローカルの読書履歴を集計中…",
  "settings.stats.totalBooks": "総蔵書",
  "settings.stats.reading": "読書中",
  "settings.stats.todayPages": "今日のページ",
  "settings.stats.last7Pages": "過去 7 日間",
  "settings.stats.unitBooks": "冊",
  "settings.stats.note":
    "ローカルの読書履歴で実際にめくったページのみを集計します。未開封の本や記録されていない進捗は含みません。",

  "settings.cache.budgetTitle": "メモリキャッシュ予算",
  "settings.cache.budgetDescription":
    "メモリ予算を増やすとページめくりが滑らかになりますが、プロセスのメモリ使用量も増えます。",
  "settings.cache.budgetLabel": "メモリキャッシュ予算",
  "settings.cache.budgetAria": "メモリキャッシュ予算（MB）",
  "settings.cache.budgetHint":
    "保存後、ページとサムネイルのメモリキャッシュにすぐ適用されます。",
  "settings.cache.diskTitle": "ディスクキャッシュ",
  "settings.cache.diskDescription":
    "レンダリング画像とオンライン原画は同じディスクキャッシュを共有し、上限を超えると古いファイルから自動削除されます。",
  "settings.cache.diskLabel": "ディスクキャッシュ上限",
  "settings.cache.diskAria": "ディスクキャッシュ上限（MB）",
  "settings.cache.diskHint":
    "保存後すぐに適用されます。上限を下げた場合、超過分は以降のアクセス時に整理されます。",
  "settings.cache.diskUsage": "ディスク使用量",
  "settings.cache.diskRender": "レンダリングキャッシュ",
  "settings.cache.diskOnline": "オンライン原画",
  "settings.cache.diskEmpty": "ディスクキャッシュの統計はまだありません。",
  "settings.cache.memoryTitle": "メモリ使用量",
  "settings.cache.memoryDescription":
    "今回の実行のメモリとキャッシュのスナップショット。",
  "settings.cache.budgetUsage": "メモリ予算の使用率",
  "settings.cache.process": "プロセス",
  "settings.cache.imageCache": "画像キャッシュ",
  "settings.cache.cachedPages": "キャッシュ済みページ",
  "settings.cache.cachedThumbs": "表紙サムネイル",
  "settings.cache.webtoonCache": "Webtoon キャッシュ",
  "settings.cache.limit": "メモリ上限",
  "settings.cache.empty": "メモリ統計はまだありません。",
  "settings.cache.pagesValue": "{count} ページ",
  "settings.cache.thumbsValue": "{count} 枚",
  "settings.cache.webtoonValue": "{size} · {count} タイル",
  "settings.cache.maintenanceTitle": "キャッシュの保守",
  "settings.cache.maintenanceDescription":
    "消去後は必要に応じて再構築され、ライブラリや読書進捗には影響しません。",
  "settings.cache.clearThumbs": "表紙キャッシュを消去",
  "settings.cache.clearing": "消去中…",
  "settings.cache.clearPages": "ページキャッシュを空にする",
  "settings.cache.purging": "クリーンアップ中…",
  "settings.cache.clearHint":
    "表紙キャッシュは、次にライブラリを開いたときに自動で再生成されます。",
  "settings.cache.clearTemp": "一時キャッシュを一括削除",
  "settings.cache.clearingTemp": "削除中…",
  "settings.cache.clearTempHint":
    "メモリ上のページ、レンダリング済みファイル、オンライン原画を削除します。表紙は必要に応じて再生成され、ライブラリと読書進捗には影響しません。",

  "settings.status.loading": "設定を読み込み中…",
  "settings.status.loadFailed": "設定が未読み込み",
  "settings.status.saving": "設定を保存中…",
  "settings.status.dirty": "未保存の変更があります",
  "settings.status.saved": "すべての変更を保存済み",
  "settings.status.saveHint": "保存するとこのデバイスの設定に書き込まれます",
  "settings.saveButton": "設定を保存",

  "settings.errors.loadSettings": "設定の読み取りに失敗しました",
  "settings.errors.loadStats": "統計の読み取りに失敗しました",
  "settings.errors.connectTest": "接続テストに失敗しました",
  "settings.errors.loadSettingsDetail":
    "設定の読み込みに失敗しました：{detail}",

  "settings.toast.scanDone":
    "スキャン完了。ライブラリに {count} 冊あります。",
  "settings.toast.scanErrors":
    "{count} 件を読み込めずスキップしました",
  "settings.toast.proxyFilled":
    "システムプロキシを入力しました。保存で反映されます",
  "settings.toast.proxyNotFound": "有効なシステムプロキシが見つかりません",
  "settings.toast.sessionCleared": "メモリ上の認証情報を消去しました",
  "settings.toast.urlRequired":
    "マニフェストまたはギャラリーの URL を入力してください",
  "settings.toast.noReadablePages":
    "マニフェストに読めるページがありません",
  "settings.toast.thumbsCleared":
    "{count} 件の表紙キャッシュを消去しました。ライブラリを開き直すと再生成されます",
  "settings.toast.pagesCleared": "ページキャッシュを空にしました",
  "settings.toast.tempCleared":
    "一時キャッシュを削除し、{size} を解放しました",
  "settings.toast.saved": "設定を保存しました",

  "settings.backup.title": "ローカルバックアップと復元",
  "settings.backup.description":
    "書庫インデックス、読書進捗、設定を 1 つのバックアップファイルにまとめます。復元の前に現在のデータをエクスポートしてください。",
  "settings.backup.export": "ローカルバックアップを書き出す (.mrbackup / .zip)",
  "settings.backup.exporting": "書き出し中…",
  "settings.backup.restore": "バックアップから復元",
  "settings.backup.restoring": "復元中…",
  "settings.backup.saveTitle": "バックアップの保存先を選択",
  "settings.backup.pickTitle": "バックアップファイルを選択",
  "settings.backup.filterName": "MangaReader バックアップ",
  "settings.backup.note":
    "バックアップには書庫インデックス、読書進捗、読書統計、テーマ/言語/リーダー設定、自動学習したフィルタールールが含まれます。画像キャッシュ、セッションのリクエストヘッダー、Cookie、フィルターイベント、内部バージョン印は含まれません。復元すると現在の書庫と読書進捗が上書きされるため、先に書き出すことをおすすめします。",
  "settings.backup.confirmTitle": "このバックアップから復元しますか？",
  "settings.backup.confirmMessage":
    "現在の書庫、読書進捗、設定が上書きされ、元に戻せません。バックアップファイル: {file}",
  "settings.backup.confirmRestore": "バックアップから復元",
  "settings.backup.exported": "バックアップを書き出しました: {books} 冊 · {size}",
  "settings.backup.restored":
    "バックアップから復元しました: {books} 冊 · {days} 日分の読書記録",
  "settings.backup.applied":
    "バックアップのテーマ、言語、リーダー設定を適用しました",
  "settings.backup.error":
    "バックアップ操作に失敗しました。もう一度お試しください。",
};

const ko: SettingsMessages = {
  "settings.page.eyebrow": "환경설정",
  "settings.page.description":
    "외형, 온라인 소스, 읽기 통계와 캐시를 이 기기에서 관리합니다.",
  "settings.page.localFirst": "로컬 우선",
  "settings.page.loading": "설정 불러오는 중",

  "settings.tabs.label": "설정 섹션",
  "settings.tabs.general": "일반 및 모양",
  "settings.tabs.online": "온라인",
  "settings.tabs.reading": "통계",
  "settings.tabs.cache": "캐시",
  "settings.tabs.network": "네트워크 및 소스",
  "settings.tabs.storage": "저장공간 및 데이터",
  "settings.tabs.privacy": "개인정보 및 보안",
  "settings.tabs.about": "정보 및 유지보수",

  "settings.shortcuts.title": "전역 단축키",
  "settings.shortcuts.description":
    "입력란에 포커스가 있거나 입력기 조합 중(isComposing / keyCode 229)이면 Ctrl/Cmd+W를 제외한 전역 단축키가 동작하지 않습니다.",
  "settings.shortcuts.note":
    "단축키를 쓰려면 먼저 입력란 밖으로 포커스를 옮기세요. Ctrl/Cmd+W(창 닫기)만 예외입니다.",
  "settings.shortcuts.command": "Ctrl/Cmd+K로 명령 센터 열기",

  "settings.language.title": "인터페이스 언어",
  "settings.language.description":
    "인터페이스 언어를 선택합니다. 변경 사항은 즉시 적용되고 이 기기에 저장되므로 따로 저장할 필요가 없습니다.",
  "settings.language.label": "표시 언어",

  "settings.theme.title": "외형 테마",
  "settings.theme.description":
    "인터페이스 색상을 선택합니다. 변경은 즉시 적용되며 로컬 환경설정과 데이터베이스에 동기화됩니다.",
  "settings.theme.groupLabel": "테마 모드",
  "settings.theme.systemHint": "시스템 밝기 모드 따름",
  "settings.theme.lightHint": "아이스 블루 캔버스",
  "settings.theme.darkHint": "한밤의 콕핏",
  "settings.theme.systemNote":
    "「시스템」은 운영체제의 라이트/다크 모드를 자동으로 따릅니다.",

  "settings.experimental.title": "실험적 기능",
  "settings.experimental.description":
    "기본적으로 꺼져 있습니다. 스위치를 바꾸면 즉시 설정에 기록되며 저장할 필요가 없습니다.",
  "settings.experimental.webtoonTitle": "웹툰 모드",
  "settings.experimental.webtoonDescription":
    "세로로 긴 작품을 끊김 없이 스크롤하는, 단일/양면 페이지에 이은 세 번째 레이아웃입니다.",
  "settings.experimental.note":
    "이 스위치만 갱신하며, 이 페이지의 다른 저장되지 않은 변경 사항은 저장하지 않습니다.",

  "settings.toast.featureOn": "{feature} 켜짐",
  "settings.toast.featureOff": "{feature} 꺼짐",

  "settings.library.title": "서재 폴더",
  "settings.library.description":
    "만화가 있는 폴더를 지정합니다. 스캔하면 새 책이 이 기기의 서재에 추가됩니다.",
  "settings.library.dirLabel": "스캔 폴더",
  "settings.library.dirPlaceholder": "D:\\Manga 또는 /path/to/manga",
  "settings.library.pick": "선택",
  "settings.library.pickTitle": "만화 폴더 선택",
  "settings.library.clearDir": "폴더 지우기",
  "settings.library.scanning": "스캔 중…",
  "settings.library.scanNow": "지금 스캔",
  "settings.library.scanHint":
    "위 폴더로 스캔하며 저장할 필요가 없습니다. 결과는 알림으로 표시됩니다.",

  "settings.about.title": "정보",
  "settings.about.description":
    "MangaReader는 로컬 우선 만화 리더입니다.",
  "settings.about.version": "버전",
  "settings.about.commit": "빌드 커밋",
  "settings.about.storage": "설정 저장 위치",
  "settings.about.storageValue": "로컬 SQLite",
  "settings.about.dataFlow": "데이터 위치",
  "settings.about.dataFlowValue": "기기를 벗어나지 않음",
  "settings.about.note":
    "설정과 읽기 기록은 이 기기에 저장됩니다. 스캔, 온라인 요청, 읽기 과정에서 개인 데이터를 업로드하지 않습니다.",

  "settings.online.urlTitle": "온라인 URL 바로 읽기",
  "settings.online.urlDescription":
    "JSON 매니페스트와 단일 페이지 HTML 갤러리를 지원합니다. 꺼져 있으면 서재와 브라우저에서 먼저 켜라는 안내가 표시됩니다.",
  "settings.online.enableTitle": "온라인 소스 사용",
  "settings.online.enableDescription":
    "온라인 매니페스트/갤러리에서 가져와 읽을 수 있으며, 가져온 화는 로컬 서재에 추가됩니다.",
  "settings.online.enableNote":
    "스위치는 즉시 저장됩니다. 아래 네트워크 설정은 하단의 「설정 저장」을 눌러야 적용됩니다.",
  "settings.online.networkTitle": "네트워크 및 요청",
  "settings.online.networkDescription":
    "프록시, 동시 연결 수, 헤더가 온라인 요청에 함께 전송됩니다. 신뢰할 수 있는 소스나 게이트웨이만 입력하세요.",
  "settings.online.proxyLabel": "프록시 주소",
  "settings.online.proxyPlaceholder":
    "비워 두면 직접 연결, 또는 http://127.0.0.1:7890",
  "settings.online.detectProxy": "시스템 프록시",
  "settings.online.detectProxyTitle":
    "Windows 시스템 프록시를 읽어 프록시 주소에 채웁니다. 자동으로 저장되지는 않습니다",
  "settings.online.detecting": "감지 중…",
  "settings.online.proxyHint":
    "http / https / socks5를 지원하며, 비워 두면 직접 연결합니다.",
  "settings.online.concurrencyLabel": "페이지 동시 연결",
  "settings.online.concurrencyPlaceholder": "동시 연결 수 선택",
  "settings.online.concurrencyItem": "{count}개 동시",
  "settings.online.concurrencyHint":
    "1–8. 높을수록 빠르지만 소스에서 속도 제한을 받기 쉽습니다.",
  "settings.online.headersLabel": "사용자 지정 헤더",
  "settings.online.sessionActive": "세션 자격 증명 사용 중",
  "settings.online.headersPlaceholder":
    '{"Authorization":"Bearer ..."} 또는 session=...; token=...',
  "settings.online.headersHint":
    "헤더는 로컬 설정에 평문으로 저장되며 설정한 소스나 게이트웨이로 보내는 요청에 포함됩니다.",
  "settings.online.storageMode": "저장 모드",
  "settings.online.storageModeDescription":
    "세션 모드는 데이터베이스에 기록되지 않으며 앱을 종료하면 지워집니다.",
  "settings.online.storageModeGroup": "헤더 저장 모드",
  "settings.online.memoryOnly": "메모리에만 보관",
  "settings.online.persistLocal": "로컬에 저장",
  "settings.online.sessionPresent":
    "현재 헤더가 프로세스 메모리에 저장되어 있습니다.",
  "settings.online.sessionAbsent": "현재 세션 헤더가 없습니다.",
  "settings.online.clearSession": "메모리 자격 증명 지우기",
  "settings.online.storageModeNote":
    "저장 모드를 바꾼 뒤 하단의 「설정 저장」을 눌러야 적용됩니다.",
  "settings.online.testTitle": "연결 테스트",
  "settings.online.testDescription":
    "대상 매니페스트나 갤러리를 분석만 하며 서재에 기록하지 않습니다.",
  "settings.online.testUrlAria":
    "온라인 매니페스트 또는 갤러리 테스트 URL",
  "settings.online.testUrlPlaceholder": "https://example.com/manifest.json",
  "settings.online.testing": "테스트 중…",
  "settings.online.testConnection": "연결 테스트",
  "settings.online.reachable": "연결 가능",
  "settings.online.testSummary": "{title} · {pages}페이지 · {ms} ms",
  "settings.online.testHint":
    "테스트에는 저장된 프록시와 헤더가 사용됩니다. 변경 후 먼저 저장하세요.",

  "settings.stats.loadError": "읽기 통계를 불러오지 못했습니다: {detail}",
  "settings.stats.loading": "로컬 읽기 기록을 집계하는 중…",
  "settings.stats.totalBooks": "총 장서",
  "settings.stats.reading": "읽는 중",
  "settings.stats.todayPages": "오늘 읽은 페이지",
  "settings.stats.last7Pages": "최근 7일",
  "settings.stats.unitBooks": "권",
  "settings.stats.note":
    "로컬 읽기 기록에서 실제로 넘긴 페이지만 집계합니다. 열지 않은 책과 기록되지 않은 진행률은 제외됩니다.",

  "settings.cache.budgetTitle": "메모리 캐시 예산",
  "settings.cache.budgetDescription":
    "메모리 예산이 높을수록 페이지 넘김이 부드러워지지만 프로세스 메모리 사용량도 늘어납니다.",
  "settings.cache.budgetLabel": "메모리 캐시 예산",
  "settings.cache.budgetAria": "메모리 캐시 예산(MB)",
  "settings.cache.budgetHint":
    "저장하면 페이지와 썸네일 메모리 캐시에 즉시 적용됩니다.",
  "settings.cache.diskTitle": "디스크 캐시",
  "settings.cache.diskDescription":
    "렌더링 이미지와 온라인 원본이 하나의 디스크 캐시를 공유하며, 한도를 넘으면 오래된 파일부터 자동으로 정리됩니다.",
  "settings.cache.diskLabel": "디스크 캐시 상한",
  "settings.cache.diskAria": "디스크 캐시 상한(MB)",
  "settings.cache.diskHint":
    "저장 후 즉시 적용됩니다. 상한을 낮추면 초과분은 이후 접근 시 정리됩니다.",
  "settings.cache.diskUsage": "디스크 사용량",
  "settings.cache.diskRender": "렌더링 캐시",
  "settings.cache.diskOnline": "온라인 원본",
  "settings.cache.diskEmpty": "아직 디스크 캐시 통계가 없습니다.",
  "settings.cache.memoryTitle": "메모리 사용량",
  "settings.cache.memoryDescription": "이번 실행의 메모리와 캐시 스냅숏입니다.",
  "settings.cache.budgetUsage": "메모리 예산 사용률",
  "settings.cache.process": "프로세스",
  "settings.cache.imageCache": "이미지 캐시",
  "settings.cache.cachedPages": "캐시된 페이지",
  "settings.cache.cachedThumbs": "표지 썸네일",
  "settings.cache.webtoonCache": "웹툰 캐시",
  "settings.cache.limit": "메모리 상한",
  "settings.cache.empty": "아직 메모리 통계가 없습니다.",
  "settings.cache.pagesValue": "{count}페이지",
  "settings.cache.thumbsValue": "{count}개",
  "settings.cache.webtoonValue": "{size} · {count} 타일",
  "settings.cache.maintenanceTitle": "캐시 관리",
  "settings.cache.maintenanceDescription":
    "삭제한 항목은 필요할 때 다시 생성되며 서재와 읽기 진행률에는 영향을 주지 않습니다.",
  "settings.cache.clearThumbs": "표지 캐시 지우기",
  "settings.cache.clearing": "지우는 중…",
  "settings.cache.clearPages": "페이지 캐시 비우기",
  "settings.cache.purging": "정리 중…",
  "settings.cache.clearHint":
    "표지 캐시는 서재에 다시 들어가면 자동으로 생성됩니다.",
  "settings.cache.clearTemp": "임시 캐시 한 번에 지우기",
  "settings.cache.clearingTemp": "지우는 중…",
  "settings.cache.clearTempHint":
    "메모리 페이지, 렌더링된 파일, 온라인 원본을 지웁니다. 표지는 필요할 때 다시 생성되며 서재와 읽기 진행률에는 영향을 주지 않습니다.",

  "settings.status.loading": "설정 불러오는 중…",
  "settings.status.loadFailed": "설정이 로드되지 않음",
  "settings.status.saving": "설정 저장 중…",
  "settings.status.dirty": "저장하지 않은 변경 사항 있음",
  "settings.status.saved": "모든 변경 사항 저장됨",
  "settings.status.saveHint": "저장하면 이 기기의 설정에 기록됩니다",
  "settings.saveButton": "설정 저장",

  "settings.errors.loadSettings": "설정을 읽지 못했습니다",
  "settings.errors.loadStats": "통계를 읽지 못했습니다",
  "settings.errors.connectTest": "연결 테스트 실패",
  "settings.errors.loadSettingsDetail":
    "설정을 불러오지 못했습니다: {detail}",

  "settings.toast.scanDone": "스캔 완료. 서재에 {count}권이 있습니다.",
  "settings.toast.scanErrors": "항목 {count}개를 읽지 못해 건너뛰었습니다",
  "settings.toast.proxyFilled":
    "시스템 프록시를 채웠습니다. 저장 후 적용됩니다",
  "settings.toast.proxyNotFound": "활성화된 시스템 프록시를 찾지 못했습니다",
  "settings.toast.sessionCleared": "메모리 자격 증명을 지웠습니다",
  "settings.toast.urlRequired": "매니페스트 또는 갤러리 URL을 입력하세요",
  "settings.toast.noReadablePages":
    "매니페스트에 읽을 수 있는 페이지가 없습니다",
  "settings.toast.thumbsCleared":
    "표지 캐시 {count}개를 지웠습니다. 서재에 다시 들어가면 자동으로 생성됩니다",
  "settings.toast.pagesCleared": "페이지 캐시를 비웠습니다",
  "settings.toast.tempCleared":
    "임시 캐시를 지우고 {size}를 확보했습니다",
  "settings.toast.saved": "설정이 저장되었습니다",

  "settings.backup.title": "로컬 백업 및 복원",
  "settings.backup.description":
    "서재 인덱스, 읽기 진행률, 환경설정을 하나의 백업 파일로 묶습니다. 복원 전에 현재 데이터를 내보내세요.",
  "settings.backup.export": "로컬 백업 내보내기 (.mrbackup / .zip)",
  "settings.backup.exporting": "내보내는 중…",
  "settings.backup.restore": "백업에서 복원",
  "settings.backup.restoring": "복원하는 중…",
  "settings.backup.saveTitle": "백업 저장 위치 선택",
  "settings.backup.pickTitle": "백업 파일 선택",
  "settings.backup.filterName": "MangaReader 백업",
  "settings.backup.note":
    "백업에는 서재 인덱스, 읽기 진행률, 읽기 통계, 테마/언어/리더 환경설정, 자체 학습 필터 규칙이 포함됩니다. 이미지 캐시, 세션 요청 헤더, 쿠키, 필터 이벤트, 내부 버전 표시는 포함되지 않습니다. 복원하면 현재 서재와 읽기 진행률을 덮어쓰므로 먼저 내보내는 것이 좋습니다.",
  "settings.backup.confirmTitle": "이 백업에서 복원할까요?",
  "settings.backup.confirmMessage":
    "현재 서재, 읽기 진행률, 환경설정을 덮어쓰며 되돌릴 수 없습니다. 백업 파일: {file}",
  "settings.backup.confirmRestore": "백업에서 복원",
  "settings.backup.exported": "백업을 내보냈습니다: {books}권 · {size}",
  "settings.backup.restored":
    "백업에서 복원했습니다: {books}권 · {days}일 읽기 기록",
  "settings.backup.applied":
    "백업의 테마, 언어, 리더 환경설정을 적용했습니다",
  "settings.backup.error": "백업 작업에 실패했습니다. 다시 시도하세요.",
};

export const settingsMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
