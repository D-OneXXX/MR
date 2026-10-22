/**
 * Software update strings (settings panel, startup toasts, recovery states).
 * Owned by the update feature. All six objects must stay in sync.
 */
const zhCN = {
  "updates.tab": "软件更新",
  "updates.title": "软件更新",
  "updates.description":
    "优先使用轻量增量补丁；跨大版本或补丁不可用时自动改用全量安装包。",
  "updates.version.label": "版本信息",
  "updates.version.current": "当前版本",
  "updates.version.baseline": "构建基线",
  "updates.version.target": "运行平台",
  "updates.version.channel": "更新通道",
  "updates.version.signature": "签名校验",
  "updates.channel.stable": "稳定通道",
  "updates.channel.beta": "测试通道",
  "updates.channel.hint":
    "通道会替换清单地址中的 {channel} 占位符；没有占位符时仅作为展示信息。",
  "updates.source.label": "更新清单地址",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "必须使用 HTTPS；仅为本机调试允许 http://127.0.0.1。地址与通道自动保存在本机。",
  "updates.source.empty": "填写更新清单地址后才能检查更新。",
  "updates.status.idle": "尚未检查更新",
  "updates.check": "检查更新",
  "updates.checking": "正在检查…",
  "updates.upToDate": "已是最新版本",
  "updates.upToDateDetail": "当前 v{version} 已是所选通道的最新版本。",
  "updates.available": "发现新版本 v{version}",
  "updates.availableDetail": "更新包已通过传输策略校验，可开始下载。",
  "updates.lastChecked": "最近检查：{time}",
  "updates.neverChecked": "尚未检查",
  "updates.type.patch": "补丁更新",
  "updates.type.full": "全量更新",
  "updates.patchSize": "补丁更新 · 约 {size}",
  "updates.fullSize": "全量更新 · 约 {size}",
  "updates.sizeUnknown": "大小未知",
  "updates.patchBaseline": "补丁基线 v{version}",
  "updates.mandatory": "重要更新",
  "updates.releasedAt": "发布于 {date}",
  "updates.notes.title": "更新日志",
  "updates.notes.empty": "本次发布未提供更新说明。",
  "updates.fallback.title": "为什么选择全量包",
  "updates.fallback.no-patch": "发布方未提供可用的增量补丁。",
  "updates.fallback.version-mismatch":
    "当前版本与补丁基线不一致，自动改用全量包。",
  "updates.fallback.major-upgrade": "跨大版本升级需要全量安装包。",
  "updates.fallback.multi-minor": "跨越多个次版本升级需要全量安装包。",
  "updates.fallback.patch-available":
    "当前版本符合补丁基线，优先下载增量补丁。",
  "updates.download": "下载更新",
  "updates.downloadPatch": "下载补丁",
  "updates.downloadFull": "下载全量包",
  "updates.downloading": "正在下载 {kind}",
  "updates.downloadingHint": "下载完成后会自动进行 SHA-256 与签名校验。",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "取消下载",
  "updates.cancelling": "正在取消…",
  "updates.cancelled": "已取消下载，当前安装保持不变。",
  "updates.verifying": "正在校验更新包…",
  "updates.verifyingHint": "正在核对 SHA-256 与发布方签名。",
  "updates.ready": "校验完成，重启以应用更新",
  "updates.readyDetail":
    "{kind} v{version} 已通过完整性校验。点击后将关闭应用并启动安装程序，书库与阅读进度不受影响。",
  "updates.install": "安装并重启",
  "updates.installing": "正在启动安装程序…",
  "updates.installHint":
    "安装程序会自行完成替换并重新启动 MangaReader。",
  "updates.retry": "重试下载",
  "updates.retryPatch": "重试补丁下载",
  "updates.switchFull": "切换为全量包",
  "updates.error.title": "更新未完成",
  "updates.error.detail": "详情：{detail}",
  "updates.error.network":
    "下载或校验失败，当前已安装版本未被修改。你可以重试或改用全量包。",
  "updates.error.config": "更新源或签名配置不完整，请检查清单地址与构建公钥。",
  "updates.error.install": "安装程序启动失败，当前版本未受影响。",
  "updates.previousFailed.title": "上次更新未生效",
  "updates.previousFailed.body":
    "更新 v{version} 未成功应用，当前仍为 v{current}。你可以重新检查更新，或改用全量包。",
  "updates.previousFailed.check": "重新检查",
  "updates.previousFailed.dismiss": "忽略",
  "updates.auto.title": "自动更新",
  "updates.auto.check": "启动时自动检查更新",
  "updates.auto.checkHint":
    "启动后在后台读取一次清单；只有填写更新源时才会联网。",
  "updates.auto.download": "在后台自动下载补丁",
  "updates.auto.downloadHint":
    "只自动下载补丁并通过校验，安装前仍会在此页确认。",
  "updates.security.title": "签名与传输",
  "updates.security.signatureOn": "已配置 Minisign 公钥，更新包必须签名。",
  "updates.security.signatureOff":
    "本构建未配置更新公钥；生产更新会被拒绝，仅本机调试可下载未签名包。",
  "updates.security.sha": "SHA-256 强制校验，失败即删除下载文件。",
  "updates.security.https":
    "清单与安装包只允许 HTTPS（本机回环调试除外）。",
  "updates.security.note":
    "签名公钥通过构建变量 MR_UPDATE_PUBKEY 注入，不会从更新清单读取。",
  "updates.toast.available": "发现新版本 v{version}，可在设置中更新。",
  "updates.toast.ready": "更新已下载并通过校验，可在设置中安装。",
  "updates.toast.autoFailed": "自动检查更新失败：{detail}",
  "updates.toast.checkFailed": "检查更新失败：{detail}",
  "updates.toast.cancelled": "已取消更新下载。",
  "updates.toast.install": "安装程序已启动，应用即将退出。",
  "updates.tabAria": "软件更新设置分区",
  "updates.progressLabel": "更新下载进度",
  "updates.securityConfigured": "已配置",
  "updates.securityMissing": "未配置",
  "updates.mb": "{value} MB",
} as const;

const en: Record<keyof typeof zhCN, string> = {
  "updates.tab": "Updates",
  "updates.title": "Software updates",
  "updates.description":
    "Prefer a lightweight delta patch; fall back to the full installer for major upgrades or when a patch is unavailable.",
  "updates.version.label": "Version information",
  "updates.version.current": "Current version",
  "updates.version.baseline": "Build baseline",
  "updates.version.target": "Platform",
  "updates.version.channel": "Update channel",
  "updates.version.signature": "Signature check",
  "updates.channel.stable": "Stable",
  "updates.channel.beta": "Beta",
  "updates.channel.hint":
    "The channel replaces the {channel} placeholder in the manifest URL; without a placeholder it is informational only.",
  "updates.source.label": "Update manifest URL",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "HTTPS is required; http://127.0.0.1 is allowed for local testing only. URL and channel are stored on this device.",
  "updates.source.empty": "Enter a manifest URL before checking for updates.",
  "updates.status.idle": "No update check yet",
  "updates.check": "Check for updates",
  "updates.checking": "Checking…",
  "updates.upToDate": "You're up to date",
  "updates.upToDateDetail":
    "v{version} is the latest version on the selected channel.",
  "updates.available": "v{version} is available",
  "updates.availableDetail":
    "The release passed transport policy checks and is ready to download.",
  "updates.lastChecked": "Last checked: {time}",
  "updates.neverChecked": "Never checked",
  "updates.type.patch": "Patch update",
  "updates.type.full": "Full update",
  "updates.patchSize": "Patch update · about {size}",
  "updates.fullSize": "Full update · about {size}",
  "updates.sizeUnknown": "Size unknown",
  "updates.patchBaseline": "Patch baseline v{version}",
  "updates.mandatory": "Important update",
  "updates.releasedAt": "Released {date}",
  "updates.notes.title": "Release notes",
  "updates.notes.empty": "No release notes were provided.",
  "updates.fallback.title": "Why this package",
  "updates.fallback.no-patch":
    "The publisher did not provide a usable delta patch.",
  "updates.fallback.version-mismatch":
    "This version does not match the patch baseline, so the full installer is used.",
  "updates.fallback.major-upgrade":
    "Major version upgrades require the full installer.",
  "updates.fallback.multi-minor":
    "Skipping multiple minor versions requires the full installer.",
  "updates.fallback.patch-available":
    "This version matches the patch baseline; the delta patch is preferred.",
  "updates.download": "Download update",
  "updates.downloadPatch": "Download patch",
  "updates.downloadFull": "Download full package",
  "updates.downloading": "Downloading {kind}",
  "updates.downloadingHint":
    "SHA-256 and signature verification run automatically after download.",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "Cancel download",
  "updates.cancelling": "Cancelling…",
  "updates.cancelled":
    "Download cancelled. The installed version is unchanged.",
  "updates.verifying": "Verifying the update package…",
  "updates.verifyingHint": "Checking SHA-256 and the publisher signature.",
  "updates.ready": "Verified — restart to apply the update",
  "updates.readyDetail":
    "{kind} v{version} passed integrity checks. Clicking install closes the app and launches the installer; your library and reading progress are untouched.",
  "updates.install": "Install and restart",
  "updates.installing": "Launching the installer…",
  "updates.installHint":
    "The installer replaces the app and restarts MangaReader automatically.",
  "updates.retry": "Retry download",
  "updates.retryPatch": "Retry patch download",
  "updates.switchFull": "Switch to full package",
  "updates.error.title": "Update incomplete",
  "updates.error.detail": "Details: {detail}",
  "updates.error.network":
    "Download or verification failed. Your installed version is untouched. Retry or switch to the full package.",
  "updates.error.config":
    "The update source or signing setup is incomplete. Check the manifest URL and build public key.",
  "updates.error.install":
    "The installer could not be launched. The current version is unaffected.",
  "updates.previousFailed.title": "The last update did not apply",
  "updates.previousFailed.body":
    "Update v{version} did not apply; you are still on v{current}. Check again, or switch to the full package.",
  "updates.previousFailed.check": "Check again",
  "updates.previousFailed.dismiss": "Dismiss",
  "updates.auto.title": "Automatic updates",
  "updates.auto.check": "Check for updates at startup",
  "updates.auto.checkHint":
    "Reads the manifest once in the background after launch; network access only happens when a source is configured.",
  "updates.auto.download": "Download patches in the background",
  "updates.auto.downloadHint":
    "Only the patch is downloaded and verified automatically; installation always requires confirmation here.",
  "updates.security.title": "Signing and transport",
  "updates.security.signatureOn":
    "A Minisign public key is configured; update packages must be signed.",
  "updates.security.signatureOff":
    "This build has no update public key. Production updates are refused; only local tests may download unsigned packages.",
  "updates.security.sha":
    "SHA-256 is mandatory; failed downloads are deleted.",
  "updates.security.https":
    "Manifests and installers require HTTPS (local loopback debugging excepted).",
  "updates.security.note":
    "The signing key is injected at build time via MR_UPDATE_PUBKEY and is never read from the manifest.",
  "updates.toast.available":
    "v{version} is available. Open Settings to update.",
  "updates.toast.ready":
    "The update was downloaded and verified. Open Settings to install it.",
  "updates.toast.autoFailed": "Automatic update check failed: {detail}",
  "updates.toast.checkFailed": "Update check failed: {detail}",
  "updates.toast.cancelled": "Update download cancelled.",
  "updates.toast.install":
    "The installer has started. MangaReader will now close.",
  "updates.tabAria": "Software update settings section",
  "updates.progressLabel": "Update download progress",
  "updates.securityConfigured": "Configured",
  "updates.securityMissing": "Not configured",
  "updates.mb": "{value} MB",
};

const zhTW: Record<keyof typeof zhCN, string> = {
  "updates.tab": "軟體更新",
  "updates.title": "軟體更新",
  "updates.description":
    "優先使用輕量增量補丁；跨大版本或補丁無法使用時，自動改用完整安裝包。",
  "updates.version.label": "版本資訊",
  "updates.version.current": "目前版本",
  "updates.version.baseline": "建置基準",
  "updates.version.target": "執行平台",
  "updates.version.channel": "更新通道",
  "updates.version.signature": "簽章驗證",
  "updates.channel.stable": "穩定通道",
  "updates.channel.beta": "測試通道",
  "updates.channel.hint":
    "通道會取代清單網址中的 {channel} 預留位置；若無預留位置，僅供顯示參考。",
  "updates.source.label": "更新清單網址",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "必須使用 HTTPS；僅本機回送偵錯允許 http://127.0.0.1。網址與通道會自動儲存在本機。",
  "updates.source.empty": "請填寫更新清單網址後再檢查更新。",
  "updates.status.idle": "尚未檢查更新",
  "updates.check": "檢查更新",
  "updates.checking": "正在檢查…",
  "updates.upToDate": "已是最新版本",
  "updates.upToDateDetail": "目前 v{version} 已是所選通道的最新版本。",
  "updates.available": "發現新版本 v{version}",
  "updates.availableDetail": "更新包已通過傳輸原則驗證，可以開始下載。",
  "updates.lastChecked": "最近檢查：{time}",
  "updates.neverChecked": "尚未檢查",
  "updates.type.patch": "補丁更新",
  "updates.type.full": "完整更新",
  "updates.patchSize": "補丁更新 · 約 {size}",
  "updates.fullSize": "完整更新 · 約 {size}",
  "updates.sizeUnknown": "大小未知",
  "updates.patchBaseline": "補丁基準 v{version}",
  "updates.mandatory": "重要更新",
  "updates.releasedAt": "發布於 {date}",
  "updates.notes.title": "更新說明",
  "updates.notes.empty": "本次發布未提供更新說明。",
  "updates.fallback.title": "為何選擇完整安裝包",
  "updates.fallback.no-patch": "發布者未提供可用的增量補丁。",
  "updates.fallback.version-mismatch":
    "目前版本與補丁基準不符，已自動改用完整安裝包。",
  "updates.fallback.major-upgrade": "跨大版本升級需要完整安裝包。",
  "updates.fallback.multi-minor": "跨越多個次版本升級需要完整安裝包。",
  "updates.fallback.patch-available":
    "目前版本符合補丁基準，將優先下載增量補丁。",
  "updates.download": "下載更新",
  "updates.downloadPatch": "下載補丁",
  "updates.downloadFull": "下載完整安裝包",
  "updates.downloading": "正在下載{kind}",
  "updates.downloadingHint": "下載完成後會自動進行 SHA-256 與簽章驗證。",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "取消下載",
  "updates.cancelling": "正在取消…",
  "updates.cancelled": "已取消下載，目前安裝的版本維持不變。",
  "updates.verifying": "正在驗證更新包…",
  "updates.verifyingHint": "正在核對 SHA-256 與發布者簽章。",
  "updates.ready": "驗證完成，重新啟動以套用更新",
  "updates.readyDetail":
    "{kind} v{version} 已通過完整性驗證。點擊後將關閉應用程式並啟動安裝程式，書庫與閱讀進度不受影響。",
  "updates.install": "安裝並重新啟動",
  "updates.installing": "正在啟動安裝程式…",
  "updates.installHint":
    "安裝程式會自行完成取代並重新啟動 MangaReader。",
  "updates.retry": "重試下載",
  "updates.retryPatch": "重試補丁下載",
  "updates.switchFull": "切換為完整安裝包",
  "updates.error.title": "更新未完成",
  "updates.error.detail": "詳細資訊：{detail}",
  "updates.error.network":
    "下載或驗證失敗，目前安裝的版本未被修改。你可以重試或改用完整安裝包。",
  "updates.error.config": "更新來源或簽章設定不完整，請檢查清單網址與建置公鑰。",
  "updates.error.install": "安裝程式啟動失敗，目前版本未受影響。",
  "updates.previousFailed.title": "上次更新未生效",
  "updates.previousFailed.body":
    "更新 v{version} 未成功套用，目前仍為 v{current}。你可以重新檢查更新，或改用完整安裝包。",
  "updates.previousFailed.check": "重新檢查",
  "updates.previousFailed.dismiss": "忽略",
  "updates.auto.title": "自動更新",
  "updates.auto.check": "啟動時自動檢查更新",
  "updates.auto.checkHint":
    "啟動後會在背景讀取一次清單；只有在設定更新來源時才會連線網路。",
  "updates.auto.download": "在背景下載補丁",
  "updates.auto.downloadHint":
    "只會自動下載補丁並通過驗證，安裝前仍須在此頁確認。",
  "updates.security.title": "簽章與傳輸",
  "updates.security.signatureOn": "已設定 Minisign 公鑰，更新包必須簽章。",
  "updates.security.signatureOff":
    "此建置未設定更新公鑰；正式版更新會被拒絕，僅本機測試可下載未簽章套件。",
  "updates.security.sha": "強制驗證 SHA-256，失敗即刪除下載檔案。",
  "updates.security.https":
    "清單與安裝程式僅允許 HTTPS（本機回送偵錯除外）。",
  "updates.security.note":
    "簽章公鑰透過建置變數 MR_UPDATE_PUBKEY 注入，不會從更新清單讀取。",
  "updates.toast.available": "發現新版本 v{version}，可在設定中更新。",
  "updates.toast.ready": "更新已下載並通過驗證，可在設定中安裝。",
  "updates.toast.autoFailed": "自動檢查更新失敗：{detail}",
  "updates.toast.checkFailed": "檢查更新失敗：{detail}",
  "updates.toast.cancelled": "已取消更新下載。",
  "updates.toast.install": "安裝程式已啟動，應用程式即將關閉。",
  "updates.tabAria": "軟體更新設定區段",
  "updates.progressLabel": "更新下載進度",
  "updates.securityConfigured": "已設定",
  "updates.securityMissing": "未設定",
  "updates.mb": "{value} MB",
};
const es: Record<keyof typeof zhCN, string> = {
  "updates.tab": "Actualizar",
  "updates.title": "Actualizaciones de software",
  "updates.description":
    "Se prefiere un parche delta ligero; si no hay parche o se trata de una actualización mayor, se usa el instalador completo.",
  "updates.version.label": "Información de versión",
  "updates.version.current": "Versión actual",
  "updates.version.baseline": "Base de compilación",
  "updates.version.target": "Plataforma",
  "updates.version.channel": "Canal de actualización",
  "updates.version.signature": "Verificación de firma",
  "updates.channel.stable": "Canal estable",
  "updates.channel.beta": "Canal beta",
  "updates.channel.hint":
    "El canal sustituye el marcador {channel} de la URL del manifiesto; si no hay marcador, solo es informativo.",
  "updates.source.label": "URL del manifiesto de actualización",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "Se requiere HTTPS; http://127.0.0.1 solo se permite para pruebas locales. La URL y el canal se guardan en este dispositivo.",
  "updates.source.empty": "Introduce la URL del manifiesto antes de buscar actualizaciones.",
  "updates.status.idle": "Aún no se han buscado actualizaciones",
  "updates.check": "Buscar actualizaciones",
  "updates.checking": "Buscando…",
  "updates.upToDate": "Estás al día",
  "updates.upToDateDetail":
    "v{version} es la última versión del canal seleccionado.",
  "updates.available": "v{version} está disponible",
  "updates.availableDetail":
    "La versión superó las comprobaciones de política de transporte y está lista para descargarse.",
  "updates.lastChecked": "Última comprobación: {time}",
  "updates.neverChecked": "Nunca comprobado",
  "updates.type.patch": "Actualización por parche",
  "updates.type.full": "Actualización completa",
  "updates.patchSize": "Actualización por parche · aprox. {size}",
  "updates.fullSize": "Actualización completa · aprox. {size}",
  "updates.sizeUnknown": "Tamaño desconocido",
  "updates.patchBaseline": "Base del parche v{version}",
  "updates.mandatory": "Actualización importante",
  "updates.releasedAt": "Publicada el {date}",
  "updates.notes.title": "Notas de la versión",
  "updates.notes.empty": "Esta versión no incluye notas.",
  "updates.fallback.title": "Por qué este paquete",
  "updates.fallback.no-patch":
    "El editor no proporcionó un parche delta utilizable.",
  "updates.fallback.version-mismatch":
    "Esta versión no coincide con la base del parche, así que se usa el instalador completo.",
  "updates.fallback.major-upgrade":
    "Las actualizaciones de versión mayor requieren el instalador completo.",
  "updates.fallback.multi-minor":
    "Saltar varias versiones menores requiere el instalador completo.",
  "updates.fallback.patch-available":
    "Esta versión coincide con la base del parche; se prefiere el parche delta.",
  "updates.download": "Descargar actualización",
  "updates.downloadPatch": "Descargar parche",
  "updates.downloadFull": "Descargar paquete completo",
  "updates.downloading": "Descargando {kind}",
  "updates.downloadingHint":
    "La verificación SHA-256 y de firma se ejecuta automáticamente al terminar la descarga.",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "Cancelar descarga",
  "updates.cancelling": "Cancelando…",
  "updates.cancelled":
    "Descarga cancelada. La versión instalada no ha cambiado.",
  "updates.verifying": "Verificando el paquete de actualización…",
  "updates.verifyingHint": "Comprobando SHA-256 y la firma del editor.",
  "updates.ready": "Verificado: reinicia para aplicar la actualización",
  "updates.readyDetail":
    "{kind} v{version} superó las comprobaciones de integridad. Al hacer clic se cierra la aplicación y se inicia el instalador; tu biblioteca y tu progreso de lectura no se modifican.",
  "updates.install": "Instalar y reiniciar",
  "updates.installing": "Iniciando el instalador…",
  "updates.installHint":
    "El instalador reemplaza la aplicación y reinicia MangaReader automáticamente.",
  "updates.retry": "Reintentar descarga",
  "updates.retryPatch": "Reintentar descarga del parche",
  "updates.switchFull": "Cambiar al paquete completo",
  "updates.error.title": "Actualización incompleta",
  "updates.error.detail": "Detalles: {detail}",
  "updates.error.network":
    "Error de descarga o verificación. La versión instalada no se ha modificado. Reinténtalo o cambia al paquete completo.",
  "updates.error.config":
    "La fuente de actualización o la configuración de firma está incompleta. Revisa la URL del manifiesto y la clave pública de compilación.",
  "updates.error.install":
    "No se pudo iniciar el instalador. La versión actual no se ha visto afectada.",
  "updates.previousFailed.title": "La última actualización no se aplicó",
  "updates.previousFailed.body":
    "La actualización v{version} no se aplicó; sigues en v{current}. Vuelve a comprobar o cambia al paquete completo.",
  "updates.previousFailed.check": "Comprobar de nuevo",
  "updates.previousFailed.dismiss": "Descartar",
  "updates.auto.title": "Actualizaciones automáticas",
  "updates.auto.check": "Buscar actualizaciones al iniciar",
  "updates.auto.checkHint":
    "Lee el manifiesto una vez en segundo plano tras el inicio; solo se accede a la red si hay una fuente configurada.",
  "updates.auto.download": "Descargar parches en segundo plano",
  "updates.auto.downloadHint":
    "Solo se descarga y verifica el parche automáticamente; la instalación siempre requiere confirmación aquí.",
  "updates.security.title": "Firma y transporte",
  "updates.security.signatureOn":
    "Hay una clave pública Minisign configurada; los paquetes de actualización deben estar firmados.",
  "updates.security.signatureOff":
    "Esta compilación no tiene clave pública de actualización. Las actualizaciones de producción se rechazan; solo las pruebas locales pueden descargar paquetes sin firmar.",
  "updates.security.sha":
    "SHA-256 es obligatorio; las descargas fallidas se eliminan.",
  "updates.security.https":
    "Los manifiestos e instaladores requieren HTTPS (salvo depuración en bucle local).",
  "updates.security.note":
    "La clave de firma se inyecta en la compilación mediante MR_UPDATE_PUBKEY y nunca se lee del manifiesto.",
  "updates.toast.available":
    "v{version} está disponible. Abre Ajustes para actualizar.",
  "updates.toast.ready":
    "La actualización se descargó y verificó. Abre Ajustes para instalarla.",
  "updates.toast.autoFailed": "Error en la búsqueda automática de actualizaciones: {detail}",
  "updates.toast.checkFailed": "Error al buscar actualizaciones: {detail}",
  "updates.toast.cancelled": "Descarga de actualización cancelada.",
  "updates.toast.install":
    "El instalador se ha iniciado. MangaReader se cerrará ahora.",
  "updates.tabAria": "Sección de ajustes de actualizaciones de software",
  "updates.progressLabel": "Progreso de descarga de la actualización",
  "updates.securityConfigured": "Configurado",
  "updates.securityMissing": "No configurado",
  "updates.mb": "{value} MB",
};
const ja: Record<keyof typeof zhCN, string> = {
  "updates.tab": "更新",
  "updates.title": "ソフトウェアアップデート",
  "updates.description":
    "軽量な差分パッチを優先し、メジャーアップデートやパッチが利用できない場合は完全インストーラーに切り替えます。",
  "updates.version.label": "バージョン情報",
  "updates.version.current": "現在のバージョン",
  "updates.version.baseline": "ビルドベースライン",
  "updates.version.target": "実行プラットフォーム",
  "updates.version.channel": "更新チャネル",
  "updates.version.signature": "署名検証",
  "updates.channel.stable": "安定版チャネル",
  "updates.channel.beta": "ベータチャネル",
  "updates.channel.hint":
    "チャネルはマニフェスト URL の {channel} プレースホルダーを置き換えます。プレースホルダーがない場合は表示のみです。",
  "updates.source.label": "更新マニフェスト URL",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "HTTPS が必須です。ローカルでのデバッグに限り http://127.0.0.1 を許可します。URL とチャネルはこの端末に保存されます。",
  "updates.source.empty": "更新を確認する前にマニフェスト URL を入力してください。",
  "updates.status.idle": "まだ更新を確認していません",
  "updates.check": "更新を確認",
  "updates.checking": "確認中…",
  "updates.upToDate": "最新バージョンです",
  "updates.upToDateDetail":
    "現在の v{version} は選択したチャネルの最新バージョンです。",
  "updates.available": "新しいバージョン v{version} があります",
  "updates.availableDetail":
    "リリースは転送ポリシーの検証に合格し、ダウンロードの準備ができました。",
  "updates.lastChecked": "最終確認: {time}",
  "updates.neverChecked": "未確認",
  "updates.type.patch": "差分アップデート",
  "updates.type.full": "完全アップデート",
  "updates.patchSize": "差分アップデート · 約 {size}",
  "updates.fullSize": "完全アップデート · 約 {size}",
  "updates.sizeUnknown": "サイズ不明",
  "updates.patchBaseline": "パッチベースライン v{version}",
  "updates.mandatory": "重要な更新",
  "updates.releasedAt": "{date} 公開",
  "updates.notes.title": "リリースノート",
  "updates.notes.empty": "このリリースには説明がありません。",
  "updates.fallback.title": "このパッケージが選ばれた理由",
  "updates.fallback.no-patch":
    "配信元が利用可能な差分パッチを提供していません。",
  "updates.fallback.version-mismatch":
    "現在のバージョンがパッチベースラインと一致しないため、完全インストーラーに切り替えました。",
  "updates.fallback.major-upgrade":
    "メジャーバージョンへのアップグレードには完全インストーラーが必要です。",
  "updates.fallback.multi-minor":
    "複数のマイナーバージョンを飛ばす場合は完全インストーラーが必要です。",
  "updates.fallback.patch-available":
    "現在のバージョンはパッチベースラインに一致するため、差分パッチを優先します。",
  "updates.download": "更新をダウンロード",
  "updates.downloadPatch": "パッチをダウンロード",
  "updates.downloadFull": "完全インストーラーをダウンロード",
  "updates.downloading": "{kind}をダウンロードしています",
  "updates.downloadingHint":
    "ダウンロード完了後、SHA-256 と署名の検証が自動で実行されます。",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "ダウンロードをキャンセル",
  "updates.cancelling": "キャンセル中…",
  "updates.cancelled":
    "ダウンロードをキャンセルしました。現在のインストールは変更されていません。",
  "updates.verifying": "更新パッケージを検証しています…",
  "updates.verifyingHint": "SHA-256 と配信元の署名を照合しています。",
  "updates.ready": "検証完了。再起動して更新を適用します",
  "updates.readyDetail":
    "{kind} v{version} は整合性検証に合格しました。クリックするとアプリを閉じてインストーラーを起動します。ライブラリと読書の進捗は影響を受けません。",
  "updates.install": "インストールして再起動",
  "updates.installing": "インストーラーを起動しています…",
  "updates.installHint":
    "インストーラーが自動的に置き換えを行い、MangaReader を再起動します。",
  "updates.retry": "ダウンロードを再試行",
  "updates.retryPatch": "パッチのダウンロードを再試行",
  "updates.switchFull": "完全インストーラーに切り替え",
  "updates.error.title": "更新が完了しませんでした",
  "updates.error.detail": "詳細: {detail}",
  "updates.error.network":
    "ダウンロードまたは検証に失敗しました。インストール済みのバージョンは変更されていません。再試行するか、完全インストーラーに切り替えてください。",
  "updates.error.config":
    "更新ソースまたは署名設定が不完全です。マニフェスト URL とビルド用公開鍵を確認してください。",
  "updates.error.install":
    "インストーラーを起動できませんでした。現在のバージョンは影響を受けません。",
  "updates.previousFailed.title": "前回の更新は適用されませんでした",
  "updates.previousFailed.body":
    "更新 v{version} を適用できませんでした。現在は v{current} のままです。再確認するか、完全インストーラーに切り替えてください。",
  "updates.previousFailed.check": "再確認",
  "updates.previousFailed.dismiss": "閉じる",
  "updates.auto.title": "自動更新",
  "updates.auto.check": "起動時に更新を確認する",
  "updates.auto.checkHint":
    "起動後にバックグラウンドでマニフェストを一度読み込みます。ネットワーク接続は更新ソースが設定されている場合のみ行われます。",
  "updates.auto.download": "バックグラウンドでパッチをダウンロード",
  "updates.auto.downloadHint":
    "パッチのダウンロードと検証のみ自動で行います。インストール前には必ずこの画面で確認します。",
  "updates.security.title": "署名と転送",
  "updates.security.signatureOn":
    "Minisign 公開鍵が設定されています。更新パッケージには署名が必要です。",
  "updates.security.signatureOff":
    "このビルドには更新用公開鍵がありません。本番の更新は拒否され、ローカルテストのみ署名なしパッケージをダウンロードできます。",
  "updates.security.sha":
    "SHA-256 は必須です。失敗したダウンロードは削除されます。",
  "updates.security.https":
    "マニフェストとインストーラーは HTTPS が必須です（ローカルループバックでのデバッグを除く）。",
  "updates.security.note":
    "署名鍵はビルド変数 MR_UPDATE_PUBKEY で注入され、マニフェストからは読み取られません。",
  "updates.toast.available":
    "新しいバージョン v{version} があります。設定から更新できます。",
  "updates.toast.ready":
    "更新はダウンロードと検証を完了しました。設定からインストールできます。",
  "updates.toast.autoFailed": "自動更新の確認に失敗しました: {detail}",
  "updates.toast.checkFailed": "更新の確認に失敗しました: {detail}",
  "updates.toast.cancelled": "更新のダウンロードをキャンセルしました。",
  "updates.toast.install":
    "インストーラーを起動しました。まもなくアプリを終了します。",
  "updates.tabAria": "ソフトウェアアップデート設定セクション",
  "updates.progressLabel": "更新のダウンロード進捗",
  "updates.securityConfigured": "設定済み",
  "updates.securityMissing": "未設定",
  "updates.mb": "{value} MB",
};
const ko: Record<keyof typeof zhCN, string> = {
  "updates.tab": "업데이트",
  "updates.title": "소프트웨어 업데이트",
  "updates.description":
    "가벼운 델타 패치를 우선 사용하며, 메이저 업그레이드이거나 패치를 사용할 수 없으면 전체 설치 프로그램으로 전환합니다.",
  "updates.version.label": "버전 정보",
  "updates.version.current": "현재 버전",
  "updates.version.baseline": "빌드 기준",
  "updates.version.target": "실행 플랫폼",
  "updates.version.channel": "업데이트 채널",
  "updates.version.signature": "서명 확인",
  "updates.channel.stable": "안정 채널",
  "updates.channel.beta": "베타 채널",
  "updates.channel.hint":
    "채널은 매니페스트 URL의 {channel} 자리표시자를 대체합니다. 자리표시자가 없으면 표시용으로만 사용됩니다.",
  "updates.source.label": "업데이트 매니페스트 URL",
  "updates.source.placeholder":
    "https://updates.example.com/{channel}/latest.json",
  "updates.source.hint":
    "HTTPS가 필요하며, 로컬 디버깅에 한해 http://127.0.0.1을 허용합니다. URL과 채널은 이 기기에 저장됩니다.",
  "updates.source.empty": "업데이트를 확인하려면 먼저 매니페스트 URL을 입력하세요.",
  "updates.status.idle": "아직 업데이트를 확인하지 않음",
  "updates.check": "업데이트 확인",
  "updates.checking": "확인 중…",
  "updates.upToDate": "최신 버전입니다",
  "updates.upToDateDetail":
    "현재 v{version}은(는) 선택한 채널의 최신 버전입니다.",
  "updates.available": "새 버전 v{version} 사용 가능",
  "updates.availableDetail":
    "릴리스가 전송 정책 검사를 통과했으며 다운로드할 준비가 되었습니다.",
  "updates.lastChecked": "마지막 확인: {time}",
  "updates.neverChecked": "확인한 적 없음",
  "updates.type.patch": "패치 업데이트",
  "updates.type.full": "전체 업데이트",
  "updates.patchSize": "패치 업데이트 · 약 {size}",
  "updates.fullSize": "전체 업데이트 · 약 {size}",
  "updates.sizeUnknown": "크기 알 수 없음",
  "updates.patchBaseline": "패치 기준 v{version}",
  "updates.mandatory": "중요 업데이트",
  "updates.releasedAt": "{date} 공개",
  "updates.notes.title": "릴리스 노트",
  "updates.notes.empty": "이 릴리스에는 설명이 제공되지 않았습니다.",
  "updates.fallback.title": "전체 설치 프로그램을 선택한 이유",
  "updates.fallback.no-patch":
    "배포자가 사용 가능한 델타 패치를 제공하지 않았습니다.",
  "updates.fallback.version-mismatch":
    "현재 버전이 패치 기준과 일치하지 않아 전체 설치 프로그램으로 전환했습니다.",
  "updates.fallback.major-upgrade":
    "메이저 버전 업그레이드에는 전체 설치 프로그램이 필요합니다.",
  "updates.fallback.multi-minor":
    "여러 마이너 버전을 건너뛰려면 전체 설치 프로그램이 필요합니다.",
  "updates.fallback.patch-available":
    "현재 버전이 패치 기준과 일치하므로 델타 패치를 우선 사용합니다.",
  "updates.download": "업데이트 다운로드",
  "updates.downloadPatch": "패치 다운로드",
  "updates.downloadFull": "전체 설치 프로그램 다운로드",
  "updates.downloading": "{kind} 다운로드 중",
  "updates.downloadingHint":
    "다운로드가 끝나면 SHA-256 및 서명 확인이 자동으로 실행됩니다.",
  "updates.downloadProgress": "{percent}%",
  "updates.downloadBytes": "{done} / {total}",
  "updates.downloadSpeed": "{speed}/s",
  "updates.cancel": "다운로드 취소",
  "updates.cancelling": "취소 중…",
  "updates.cancelled":
    "다운로드를 취소했습니다. 현재 설치된 버전은 변경되지 않습니다.",
  "updates.verifying": "업데이트 패키지를 확인하는 중…",
  "updates.verifyingHint": "SHA-256과 배포자 서명을 대조하는 중입니다.",
  "updates.ready": "확인 완료 — 업데이트를 적용하려면 다시 시작하세요",
  "updates.readyDetail":
    "{kind} v{version}이(가) 무결성 검사를 통과했습니다. 설치를 클릭하면 앱이 종료되고 설치 프로그램이 실행됩니다. 라이브러리와 읽기 진행률은 영향을 받지 않습니다.",
  "updates.install": "설치 후 다시 시작",
  "updates.installing": "설치 프로그램을 실행하는 중…",
  "updates.installHint":
    "설치 프로그램이 자동으로 앱을 교체하고 MangaReader를 다시 시작합니다.",
  "updates.retry": "다운로드 다시 시도",
  "updates.retryPatch": "패치 다운로드 다시 시도",
  "updates.switchFull": "전체 설치 프로그램으로 전환",
  "updates.error.title": "업데이트가 완료되지 않음",
  "updates.error.detail": "상세 정보: {detail}",
  "updates.error.network":
    "다운로드 또는 확인에 실패했습니다. 설치된 버전은 변경되지 않았습니다. 다시 시도하거나 전체 설치 프로그램으로 전환하세요.",
  "updates.error.config":
    "업데이트 소스 또는 서명 구성이 불완전합니다. 매니페스트 URL과 빌드 공개 키를 확인하세요.",
  "updates.error.install":
    "설치 프로그램을 실행하지 못했습니다. 현재 버전은 영향을 받지 않습니다.",
  "updates.previousFailed.title": "지난 업데이트가 적용되지 않았습니다",
  "updates.previousFailed.body":
    "업데이트 v{version}이(가) 적용되지 않아 현재 v{current}입니다. 다시 확인하거나 전체 설치 프로그램으로 전환하세요.",
  "updates.previousFailed.check": "다시 확인",
  "updates.previousFailed.dismiss": "무시",
  "updates.auto.title": "자동 업데이트",
  "updates.auto.check": "시작할 때 업데이트 확인",
  "updates.auto.checkHint":
    "시작 후 백그라운드에서 매니페스트를 한 번 읽습니다. 네트워크 연결은 업데이트 소스가 설정된 경우에만 이루어집니다.",
  "updates.auto.download": "백그라운드에서 패치 다운로드",
  "updates.auto.downloadHint":
    "패치만 자동으로 다운로드하고 확인하며, 설치 전에는 항상 이 화면에서 확인합니다.",
  "updates.security.title": "서명 및 전송",
  "updates.security.signatureOn":
    "Minisign 공개 키가 구성되어 있으며 업데이트 패키지에는 서명이 필요합니다.",
  "updates.security.signatureOff":
    "이 빌드에는 업데이트 공개 키가 없습니다. 프로덕션 업데이트는 거부되며 로컬 테스트에서만 서명 없는 패키지를 다운로드할 수 있습니다.",
  "updates.security.sha":
    "SHA-256 확인이 필수이며, 실패한 다운로드는 삭제됩니다.",
  "updates.security.https":
    "매니페스트와 설치 프로그램은 HTTPS가 필요합니다(로컬 루프백 디버깅 제외).",
  "updates.security.note":
    "서명 키는 빌드 변수 MR_UPDATE_PUBKEY로 주입되며 매니페스트에서 읽지 않습니다.",
  "updates.toast.available":
    "새 버전 v{version}이(가) 있습니다. 설정에서 업데이트하세요.",
  "updates.toast.ready":
    "업데이트가 다운로드 및 확인되었습니다. 설정에서 설치하세요.",
  "updates.toast.autoFailed": "자동 업데이트 확인 실패: {detail}",
  "updates.toast.checkFailed": "업데이트 확인 실패: {detail}",
  "updates.toast.cancelled": "업데이트 다운로드를 취소했습니다.",
  "updates.toast.install":
    "설치 프로그램이 시작되었습니다. 앱이 곧 종료됩니다.",
  "updates.tabAria": "소프트웨어 업데이트 설정 섹션",
  "updates.progressLabel": "업데이트 다운로드 진행률",
  "updates.securityConfigured": "구성됨",
  "updates.securityMissing": "구성되지 않음",
  "updates.mb": "{value} MB",
};

export const updatesMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
};
