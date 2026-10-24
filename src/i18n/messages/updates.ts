/**
 * Software update strings (unified settings card + native GitHub channel).
 * Owned by the update feature. All six objects must stay in sync.
 *
 * 更新端点在构建配置中锁死（Windows: GitHub Releases latest.json，
 * Linux: latest-linux-critical.json），不向用户暴露清单地址输入框。
 */
const zhCN = {
  "updates.title": "软件更新",
  "updates.description":
    "从 GitHub Releases 检查签名更新（优先增量补丁，跨版本自动回退全量包）；下载与安装均需您手动确认。",
  "updates.check": "检查更新",
  "updates.checking": "正在检查…",
  "updates.upToDate": "已是最新版本",
  "updates.available": "发现新版本 v{version}",
  "updates.lastChecked": "最近检查：{time}",
  "updates.releasedAt": "发布于 {date}",
  "updates.installing": "正在重启…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "大小未知",
  "updates.error.title": "更新未完成",
  "updates.securityConfigured": "已配置",
  "updates.securityMissing": "未配置",
  "updates.version.current": "当前版本",
  "updates.version.baseline": "构建基线",
  "updates.version.target": "运行平台",
  "updates.native.availableVersion": "可用版本",
  "updates.native.availableDetail":
    "已找到新版本，更新包会在安装前完成 Minisign 签名校验。",
  "updates.native.downloadInstall": "下载并安装",
  "updates.native.downloading": "正在下载更新包…",
  "updates.native.downloaded": "已下载 {size}",
  "updates.native.preparing": "正在校验并启动安装程序…",
  "updates.native.installed": "更新已安装",
  "updates.native.installedHint": "重启应用以完成安装；书库与阅读进度不受影响。",
  "updates.native.relaunch": "立即重启",
  "updates.native.upToDateDetail":
    "当前 v{version} 已是 GitHub 发布的最新版本。",
  "updates.native.statusIdle": "尚未检查 GitHub 更新",
  "updates.native.notes": "更新说明",
  "updates.native.signature": "Minisign 签名校验",
  "updates.native.progressLabel": "GitHub 更新下载进度",
  "updates.native.errorCheck": "无法连接 GitHub 更新服务，请检查网络后重试。",
  "updates.native.errorInstall": "下载或安装更新失败，当前版本未受影响。",
  "updates.native.errorRelaunch": "重启应用失败，请手动关闭并重新打开 MangaReader。",
  "updates.linux.manualTitle": "系统安装需要手动更新",
  "updates.linux.manualHint":
    "当前是 deb/rpm 系统安装，应用不能替换系统包文件。请下载新版本后用系统包管理器安装；AppImage 可直接下载运行。",
  "updates.linux.download": "打开下载页",
  "updates.linux.notes": "打开发行说明",
  "updates.linux.manualBlocked":
    "已阻止自动安装：系统安装必须手动更新。",
  "updates.linux.openFailed":
    "无法打开浏览器，请手动访问 GitHub Releases。",
  "updates.native.linuxCriticalChannel":
    "当前为 Linux 长期稳定分支：官方仅推送高危安全与崩溃修复补丁；日常功能扩展可由社区非商用修改提供。",
} as const;

const en: Record<keyof typeof zhCN, string> = {
  "updates.title": "Software updates",
  "updates.description":
    "Check for signed updates from GitHub Releases (incremental patches preferred, with automatic fallback to the full package across versions); both downloading and installing require your manual confirmation.",
  "updates.check": "Check for updates",
  "updates.checking": "Checking…",
  "updates.upToDate": "You're up to date",
  "updates.available": "v{version} is available",
  "updates.lastChecked": "Last checked: {time}",
  "updates.releasedAt": "Released {date}",
  "updates.installing": "Restarting…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "Size unknown",
  "updates.error.title": "Update incomplete",
  "updates.securityConfigured": "Configured",
  "updates.securityMissing": "Not configured",
  "updates.version.current": "Current version",
  "updates.version.baseline": "Build baseline",
  "updates.version.target": "Platform",
  "updates.native.availableVersion": "Available version",
  "updates.native.availableDetail":
    "A new version was found. The package is verified with its Minisign signature before installation.",
  "updates.native.downloadInstall": "Download and install",
  "updates.native.downloading": "Downloading the update package…",
  "updates.native.downloaded": "{size} downloaded",
  "updates.native.preparing": "Verifying and starting the installer…",
  "updates.native.installed": "Update installed",
  "updates.native.installedHint":
    "Restart the app to finish installing. Your library and reading progress are untouched.",
  "updates.native.relaunch": "Restart now",
  "updates.native.upToDateDetail":
    "v{version} is the latest version published on GitHub.",
  "updates.native.statusIdle": "GitHub updates not checked yet",
  "updates.native.notes": "Release notes",
  "updates.native.signature": "Minisign signature check",
  "updates.native.progressLabel": "GitHub update download progress",
  "updates.native.errorCheck":
    "Could not reach the GitHub update service. Check your connection and try again.",
  "updates.native.errorInstall":
    "Downloading or installing the update failed. Your current version is unaffected.",
  "updates.native.errorRelaunch":
    "Could not restart the app. Close and open MangaReader manually.",
  "updates.linux.manualTitle":
    "System installation requires a manual update",
  "updates.linux.manualHint":
    "This is a deb/rpm system installation; the app cannot replace system package files. Download the new version and install it with your package manager. AppImage builds can be downloaded and run directly.",
  "updates.linux.download": "Open download page",
  "updates.linux.notes": "Open release notes",
  "updates.linux.manualBlocked":
    "Automatic install blocked: system installations must be updated manually.",
  "updates.linux.openFailed":
    "Could not open the browser. Please visit GitHub Releases manually.",
  "updates.native.linuxCriticalChannel":
    "You are on the Linux long-term stability branch: official updates only deliver critical security and crash fixes. Day-to-day features can come from community non-commercial modifications.",
};

const zhTW: Record<keyof typeof zhCN, string> = {
  "updates.title": "軟體更新",
  "updates.description":
    "從 GitHub Releases 檢查簽署更新（優先增量補丁，跨版本自動回退全量包）；下載與安裝均需您手動確認。",
  "updates.check": "檢查更新",
  "updates.checking": "正在檢查…",
  "updates.upToDate": "已是最新版本",
  "updates.available": "發現新版本 v{version}",
  "updates.lastChecked": "最近檢查：{time}",
  "updates.releasedAt": "發布於 {date}",
  "updates.installing": "正在重新啟動…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "大小未知",
  "updates.error.title": "更新未完成",
  "updates.securityConfigured": "已設定",
  "updates.securityMissing": "未設定",
  "updates.version.current": "目前版本",
  "updates.version.baseline": "建置基準",
  "updates.version.target": "執行平台",
  "updates.native.availableVersion": "可用版本",
  "updates.native.availableDetail":
    "已找到新版本，更新包會在安裝前完成 Minisign 簽章驗證。",
  "updates.native.downloadInstall": "下載並安裝",
  "updates.native.downloading": "正在下載更新包…",
  "updates.native.downloaded": "已下載 {size}",
  "updates.native.preparing": "正在驗證並啟動安裝程式…",
  "updates.native.installed": "更新已安裝",
  "updates.native.installedHint": "重新啟動應用程式以完成安裝；書庫與閱讀進度不受影響。",
  "updates.native.relaunch": "立即重新啟動",
  "updates.native.upToDateDetail":
    "目前 v{version} 已是 GitHub 發布的最新版本。",
  "updates.native.statusIdle": "尚未檢查 GitHub 更新",
  "updates.native.notes": "更新說明",
  "updates.native.signature": "Minisign 簽章驗證",
  "updates.native.progressLabel": "GitHub 更新下載進度",
  "updates.native.errorCheck": "無法連線 GitHub 更新服務，請檢查網路後重試。",
  "updates.native.errorInstall": "下載或安裝更新失敗，目前版本未受影響。",
  "updates.native.errorRelaunch":
    "無法重新啟動應用程式，請手動關閉並重新開啟 MangaReader。",
  "updates.linux.manualTitle": "系統安裝需要手動更新",
  "updates.linux.manualHint":
    "目前是 deb/rpm 系統安裝，應用程式不能替換系統套件檔案。請下載新版本後用系統套件管理員安裝；AppImage 可直接下載執行。",
  "updates.linux.download": "開啟下載頁",
  "updates.linux.notes": "開啟發行說明",
  "updates.linux.manualBlocked":
    "已阻止自動安裝：系統安裝必須手動更新。",
  "updates.linux.openFailed":
    "無法開啟瀏覽器，請手動前往 GitHub Releases。",
  "updates.native.linuxCriticalChannel":
    "目前為 Linux 長期穩定分支：官方僅推送高危安全性與當機修復補丁；日常功能擴充可由社群非商業修改提供。",
};

const es: Record<keyof typeof zhCN, string> = {
  "updates.title": "Actualizaciones de software",
  "updates.description":
    "Comprueba actualizaciones firmadas desde GitHub Releases (prioriza los parches incrementales y recurre automáticamente al paquete completo entre versiones); tanto la descarga como la instalación requieren tu confirmación manual.",
  "updates.check": "Buscar actualizaciones",
  "updates.checking": "Buscando…",
  "updates.upToDate": "Estás al día",
  "updates.available": "v{version} está disponible",
  "updates.lastChecked": "Última comprobación: {time}",
  "updates.releasedAt": "Publicada el {date}",
  "updates.installing": "Reiniciando…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "Tamaño desconocido",
  "updates.error.title": "Actualización incompleta",
  "updates.securityConfigured": "Configurado",
  "updates.securityMissing": "No configurado",
  "updates.version.current": "Versión actual",
  "updates.version.baseline": "Base de compilación",
  "updates.version.target": "Plataforma",
  "updates.native.availableVersion": "Versión disponible",
  "updates.native.availableDetail":
    "Se encontró una nueva versión. El paquete se verifica con su firma Minisign antes de instalarse.",
  "updates.native.downloadInstall": "Descargar e instalar",
  "updates.native.downloading": "Descargando el paquete de actualización…",
  "updates.native.downloaded": "{size} descargados",
  "updates.native.preparing": "Verificando e iniciando el instalador…",
  "updates.native.installed": "Actualización instalada",
  "updates.native.installedHint":
    "Reinicia la aplicación para terminar la instalación. Tu biblioteca y tu progreso de lectura no se modifican.",
  "updates.native.relaunch": "Reiniciar ahora",
  "updates.native.upToDateDetail":
    "v{version} es la última versión publicada en GitHub.",
  "updates.native.statusIdle": "Aún no se han buscado actualizaciones de GitHub",
  "updates.native.notes": "Notas de la versión",
  "updates.native.signature": "Verificación de firma Minisign",
  "updates.native.progressLabel": "Progreso de descarga de la actualización de GitHub",
  "updates.native.errorCheck":
    "No se pudo contactar con el servicio de actualizaciones de GitHub. Revisa la conexión e inténtalo de nuevo.",
  "updates.native.errorInstall":
    "La descarga o instalación de la actualización falló. La versión actual no se ha modificado.",
  "updates.native.errorRelaunch":
    "No se pudo reiniciar la aplicación. Cierra y abre MangaReader manualmente.",
  "updates.linux.manualTitle":
    "La instalación del sistema requiere una actualización manual",
  "updates.linux.manualHint":
    "Es una instalación del sistema deb/rpm; la app no puede reemplazar los archivos del paquete. Descarga la nueva versión e instálala con el gestor de paquetes. Las versiones AppImage se pueden descargar y ejecutar directamente.",
  "updates.linux.download": "Abrir página de descarga",
  "updates.linux.notes": "Abrir notas de la versión",
  "updates.linux.manualBlocked":
    "Instalación automática bloqueada: las instalaciones del sistema deben actualizarse manualmente.",
  "updates.linux.openFailed":
    "No se pudo abrir el navegador. Visita GitHub Releases manualmente.",
  "updates.native.linuxCriticalChannel":
    "Estás en la rama Linux de estabilidad a largo plazo: las actualizaciones oficiales solo entregan parches críticos de seguridad y de fallos. Las funciones cotidianas pueden provenir de modificaciones comunitarias no comerciales.",
};

const ja: Record<keyof typeof zhCN, string> = {
  "updates.title": "ソフトウェアアップデート",
  "updates.description":
    "GitHub Releases から署名付きアップデートを確認します（増分パッチを優先し、バージョンをまたぐ場合は完全パッケージへ自動フォールバック）。ダウンロードとインストールには手動確認が必要です。",
  "updates.check": "更新を確認",
  "updates.checking": "確認中…",
  "updates.upToDate": "最新バージョンです",
  "updates.available": "新しいバージョン v{version} があります",
  "updates.lastChecked": "最終確認: {time}",
  "updates.releasedAt": "{date} 公開",
  "updates.installing": "再起動中…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "サイズ不明",
  "updates.error.title": "更新が完了しませんでした",
  "updates.securityConfigured": "設定済み",
  "updates.securityMissing": "未設定",
  "updates.version.current": "現在のバージョン",
  "updates.version.baseline": "ビルドベースライン",
  "updates.version.target": "実行プラットフォーム",
  "updates.native.availableVersion": "利用可能なバージョン",
  "updates.native.availableDetail":
    "新しいバージョンが見つかりました。インストール前に Minisign 署名を検証します。",
  "updates.native.downloadInstall": "ダウンロードしてインストール",
  "updates.native.downloading": "更新パッケージをダウンロードしています…",
  "updates.native.downloaded": "{size} ダウンロード済み",
  "updates.native.preparing": "検証してインストーラーを起動しています…",
  "updates.native.installed": "アップデートをインストールしました",
  "updates.native.installedHint":
    "インストールを完了するにはアプリを再起動してください。ライブラリと読書の進捗は影響を受けません。",
  "updates.native.relaunch": "今すぐ再起動",
  "updates.native.upToDateDetail":
    "現在の v{version} は GitHub で公開されている最新バージョンです。",
  "updates.native.statusIdle": "GitHub アップデートは未確認です",
  "updates.native.notes": "リリースノート",
  "updates.native.signature": "Minisign 署名検証",
  "updates.native.progressLabel": "GitHub アップデートのダウンロード進捗",
  "updates.native.errorCheck":
    "GitHub の更新サービスに接続できませんでした。ネットワークを確認して再試行してください。",
  "updates.native.errorInstall":
    "アップデートのダウンロードまたはインストールに失敗しました。現在のバージョンは影響を受けません。",
  "updates.native.errorRelaunch":
    "アプリを再起動できませんでした。MangaReader を手動で閉じて開き直してください。",
  "updates.linux.manualTitle":
    "システムインストールは手動更新が必要です",
  "updates.linux.manualHint":
    "これは deb/rpm のシステムインストールです。アプリはシステムパッケージのファイルを置き換えられません。新しいバージョンをダウンロードし、パッケージマネージャーでインストールしてください。AppImage は直接ダウンロードして実行できます。",
  "updates.linux.download": "ダウンロードページを開く",
  "updates.linux.notes": "リリースノートを開く",
  "updates.linux.manualBlocked":
    "自動インストールをブロックしました：システムインストールは手動で更新する必要があります。",
  "updates.linux.openFailed":
    "ブラウザーを開けませんでした。GitHub Releases に手動でアクセスしてください。",
  "updates.native.linuxCriticalChannel":
    "Linux 長期安定ブランチです。公式は重大なセキュリティ修正とクラッシュ修正のみを配信します。日常機能の拡張はコミュニティによる非商用改変で提供されます。",
};

const ko: Record<keyof typeof zhCN, string> = {
  "updates.title": "소프트웨어 업데이트",
  "updates.description":
    "GitHub Releases에서 서명된 업데이트를 확인합니다(증분 패치 우선, 버전을 건너뛰면 전체 패키지로 자동 전환). 다운로드와 설치는 모두 직접 확인이 필요합니다.",
  "updates.check": "업데이트 확인",
  "updates.checking": "확인 중…",
  "updates.upToDate": "최신 버전입니다",
  "updates.available": "새 버전 v{version} 사용 가능",
  "updates.lastChecked": "마지막 확인: {time}",
  "updates.releasedAt": "{date} 공개",
  "updates.installing": "다시 시작하는 중…",
  "updates.downloadProgress": "{percent}%",
  "updates.sizeUnknown": "크기 알 수 없음",
  "updates.error.title": "업데이트가 완료되지 않음",
  "updates.securityConfigured": "구성됨",
  "updates.securityMissing": "구성되지 않음",
  "updates.version.current": "현재 버전",
  "updates.version.baseline": "빌드 기준",
  "updates.version.target": "실행 플랫폼",
  "updates.native.availableVersion": "사용 가능한 버전",
  "updates.native.availableDetail":
    "새 버전을 찾았습니다. 설치 전에 Minisign 서명을 확인합니다.",
  "updates.native.downloadInstall": "다운로드 및 설치",
  "updates.native.downloading": "업데이트 패키지를 다운로드하는 중…",
  "updates.native.downloaded": "{size} 다운로드됨",
  "updates.native.preparing": "확인 후 설치 프로그램을 시작하는 중…",
  "updates.native.installed": "업데이트 설치됨",
  "updates.native.installedHint":
    "설치를 마치려면 앱을 다시 시작하세요. 라이브러리와 읽기 진행률은 영향을 받지 않습니다.",
  "updates.native.relaunch": "지금 다시 시작",
  "updates.native.upToDateDetail":
    "현재 v{version}은(는) GitHub에 공개된 최신 버전입니다.",
  "updates.native.statusIdle": "GitHub 업데이트를 아직 확인하지 않음",
  "updates.native.notes": "릴리스 노트",
  "updates.native.signature": "Minisign 서명 확인",
  "updates.native.progressLabel": "GitHub 업데이트 다운로드 진행률",
  "updates.native.errorCheck":
    "GitHub 업데이트 서비스에 연결하지 못했습니다. 네트워크를 확인한 후 다시 시도하세요.",
  "updates.native.errorInstall":
    "업데이트 다운로드 또는 설치에 실패했습니다. 현재 버전은 영향을 받지 않습니다.",
  "updates.native.errorRelaunch":
    "앱을 다시 시작하지 못했습니다. MangaReader를 직접 종료한 후 다시 여세요.",
  "updates.linux.manualTitle":
    "시스템 설치에는 수동 업데이트가 필요합니다",
  "updates.linux.manualHint":
    "deb/rpm 시스템 설치입니다. 앱은 시스템 패키지 파일을 교체할 수 없습니다. 새 버전을 다운로드해 패키지 관리자로 설치하세요. AppImage는 직접 다운로드해 실행할 수 있습니다.",
  "updates.linux.download": "다운로드 페이지 열기",
  "updates.linux.notes": "릴리스 노트 열기",
  "updates.linux.manualBlocked":
    "자동 설치를 차단했습니다. 시스템 설치는 수동으로 업데이트해야 합니다.",
  "updates.linux.openFailed":
    "브라우저를 열 수 없습니다. GitHub Releases를 직접 방문하세요.",
  "updates.native.linuxCriticalChannel":
    "Linux 장기 안정 브랜치입니다. 공식 업데이트는 중대 보안 및 크래시 수정만 전달하며, 일상 기능 확장은 커뮤니티 비상업 수정으로 제공될 수 있습니다.",
};

export const updatesMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
};
