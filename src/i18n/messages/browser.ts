/**
 * Browser page strings.
 * Owned by the browser conversion. All six objects must stay in sync.
 */
const zhCN = {
  "browser.title": "浏览器",
  "browser.overline": "在线阅读",
  "browser.subtitle":
    "把在线漫画的清单或图集地址直接交给阅读器；也可以在独立的内嵌浏览器中打开页面，下载后导入书库。",
  "browser.capabilities": "支持 JSON 清单与单页 HTML 图集",
  "browser.urlPlaceholder":
    "粘贴清单或图集地址，例如 https://example.com/gallery.html",
  "browser.urlLabel": "在线直读地址",
  "browser.submitHint": "解析地址并进入阅读器",
  "browser.submitHintOff": "在线直读已在设置中关闭",
  "browser.resolving": "解析中",
  "browser.directRead": "直读",
  "browser.openEmbedded": "内嵌浏览器",
  "browser.openExternal": "系统浏览器",
  "browser.downloadHint": "内嵌窗口下载的 zip / cbz 可在下方导入",
  "browser.gateTitle": "在线直读未开启",
  "browser.gateBadge": "需在设置中启用",
  "browser.gateBody":
    "直读按钮暂不可用；内嵌浏览器与系统浏览器仍可打开页面，下载后可导入书库。",
  "browser.goSettings": "前往设置",
  "browser.emptyUrl": "请输入要打开的页面地址",
  "browser.invalidUrl": "地址无效，仅支持 http(s) 链接",
  "browser.directDisabled": "在线直读已在设置中关闭，无法解析该地址",
  "browser.fallbackHint": "可在内嵌浏览器中打开该页面后下载导入。",
  "browser.resolveFailed": "解析失败，请检查地址或网络设置",
  "browser.resolveFailedDetail": "解析失败：{error}",
  "browser.embeddedFailed": "打开内嵌浏览器失败",
  "browser.embeddedFailedDetail": "打开内嵌浏览器失败：{error}",
  "browser.externalFailed": "打开系统浏览器失败",
  "browser.externalFailedDetail": "打开系统浏览器失败：{error}",
  "browser.toastResolved": "已解析《{title}》，正在打开阅读器",
  "browser.toastEmbedded": "已在内嵌浏览器中打开",
  "browser.toastExternal": "已在系统浏览器中打开",
  "browser.toastImported": "已导入：{name}",
  "browser.toastNotImported": "未导入：{name}",
  "browser.toastDownloaded": "已下载：{name}",
  "browser.toastAddedToLibrary": "已加入书库",
  "browser.recentsTitle": "最近访问",
  "browser.recentsHint": "点击填入地址栏；仅展示脱敏地址",
  "browser.recentsEmpty": "暂无最近访问，直读或打开成功后会自动记录。",
  "browser.fillAddress": "填入地址栏",
  "browser.deleteRecent": "删除记录",
  "browser.deleteRecentAria": "删除最近访问：{name}",
  "browser.downloadsTitle": "下载",
  "browser.downloadsDesc": "内嵌浏览器下载的压缩包，导入后加入书库",
  "browser.refreshing": "刷新中",
  "browser.downloadsLoadFailed": "下载列表加载失败",
  "browser.downloadsLoadError": "下载列表加载失败：{error}",
  "browser.refreshFailed": "刷新失败",
  "browser.refreshFailedDetail": "刷新失败：{error}",
  "browser.downloadsLoading": "正在读取下载列表",
  "browser.downloadsEmpty":
    "暂无下载记录，在内嵌浏览器中下载 zip / cbz 后会自动出现在这里",
  "browser.imported": "已导入",
  "browser.notImported": "未导入",
  "browser.importing": "导入中",
  "browser.importAction": "导入",
  "browser.openFolder": "打开文件夹",
  "browser.openFolderTitle": "打开所在文件夹：{name}",
} as const;

type BrowserMessages = { [K in keyof typeof zhCN]: string };

const zhTW: BrowserMessages = {
  "browser.title": "瀏覽器",
  "browser.overline": "線上閱讀",
  "browser.subtitle":
    "將線上漫畫的清單或圖集網址直接交給閱讀器；也可以在獨立的內嵌瀏覽器中開啟頁面，下載後匯入書庫。",
  "browser.capabilities": "支援 JSON 清單與單頁 HTML 圖集",
  "browser.urlPlaceholder":
    "貼上清單或圖集網址，例如 https://example.com/gallery.html",
  "browser.urlLabel": "線上直讀網址",
  "browser.submitHint": "解析網址並進入閱讀器",
  "browser.submitHintOff": "線上直讀已在設定中關閉",
  "browser.resolving": "解析中",
  "browser.directRead": "直讀",
  "browser.openEmbedded": "內嵌瀏覽器",
  "browser.openExternal": "系統瀏覽器",
  "browser.downloadHint": "內嵌視窗下載的 zip / cbz 可在下方匯入",
  "browser.gateTitle": "線上直讀未開啟",
  "browser.gateBadge": "需在設定中啟用",
  "browser.gateBody":
    "直讀按鈕暫不可用；內嵌瀏覽器與系統瀏覽器仍可開啟頁面，下載後可匯入書庫。",
  "browser.goSettings": "前往設定",
  "browser.emptyUrl": "請輸入要開啟的頁面網址",
  "browser.invalidUrl": "網址無效，僅支援 http(s) 連結",
  "browser.directDisabled": "線上直讀已在設定中關閉，無法解析該網址",
  "browser.fallbackHint": "可在內嵌瀏覽器中開啟該頁面後下載匯入。",
  "browser.resolveFailed": "解析失敗，請檢查網址或網路設定",
  "browser.resolveFailedDetail": "解析失敗：{error}",
  "browser.embeddedFailed": "開啟內嵌瀏覽器失敗",
  "browser.embeddedFailedDetail": "開啟內嵌瀏覽器失敗：{error}",
  "browser.externalFailed": "開啟系統瀏覽器失敗",
  "browser.externalFailedDetail": "開啟系統瀏覽器失敗：{error}",
  "browser.toastResolved": "已解析《{title}》，正在開啟閱讀器",
  "browser.toastEmbedded": "已在內嵌瀏覽器中開啟",
  "browser.toastExternal": "已在系統瀏覽器中開啟",
  "browser.toastImported": "已匯入：{name}",
  "browser.toastNotImported": "未匯入：{name}",
  "browser.toastDownloaded": "已下載：{name}",
  "browser.toastAddedToLibrary": "已加入書庫",
  "browser.recentsTitle": "最近造訪",
  "browser.recentsHint": "點擊填入網址列；僅顯示遮罩網址",
  "browser.recentsEmpty": "尚無最近造訪，直讀或開啟成功後會自動記錄。",
  "browser.fillAddress": "填入網址列",
  "browser.deleteRecent": "刪除記錄",
  "browser.deleteRecentAria": "刪除最近造訪：{name}",
  "browser.downloadsTitle": "下載",
  "browser.downloadsDesc": "內嵌瀏覽器下載的壓縮檔，匯入後加入書庫",
  "browser.refreshing": "重新整理中",
  "browser.downloadsLoadFailed": "下載清單載入失敗",
  "browser.downloadsLoadError": "下載清單載入失敗：{error}",
  "browser.refreshFailed": "重新整理失敗",
  "browser.refreshFailedDetail": "重新整理失敗：{error}",
  "browser.downloadsLoading": "正在讀取下載清單",
  "browser.downloadsEmpty":
    "尚無下載記錄，在內嵌瀏覽器中下載 zip / cbz 後會自動出現在這裡",
  "browser.imported": "已匯入",
  "browser.notImported": "未匯入",
  "browser.importing": "匯入中",
  "browser.importAction": "匯入",
  "browser.openFolder": "開啟資料夾",
  "browser.openFolderTitle": "開啟所在資料夾：{name}",
};

const en: BrowserMessages = {
  "browser.title": "Browser",
  "browser.overline": "ONLINE READER",
  "browser.subtitle":
    "Send an online manga manifest or gallery URL straight to the reader, or open the page in the built-in browser and import the download into your library.",
  "browser.capabilities": "JSON manifests and single-page HTML galleries supported",
  "browser.urlPlaceholder":
    "Paste a manifest or gallery URL, e.g. https://example.com/gallery.html",
  "browser.urlLabel": "Online reader address",
  "browser.submitHint": "Resolve the URL and open the reader",
  "browser.submitHintOff": "Online reader is turned off in Settings",
  "browser.resolving": "Resolving",
  "browser.directRead": "Read",
  "browser.openEmbedded": "Built-in browser",
  "browser.openExternal": "System browser",
  "browser.downloadHint":
    "ZIP / CBZ files downloaded in the built-in browser can be imported below",
  "browser.gateTitle": "Online reader is off",
  "browser.gateBadge": "Enable in Settings",
  "browser.gateBody":
    "Direct read is unavailable for now; you can still open the page in the built-in or system browser and import the download into your library.",
  "browser.goSettings": "Go to Settings",
  "browser.emptyUrl": "Enter a page URL to open",
  "browser.invalidUrl": "Invalid URL — only http(s) links are supported",
  "browser.directDisabled":
    "Online reader is turned off in Settings, so this URL cannot be resolved",
  "browser.fallbackHint":
    "You can open the page in the built-in browser, then download and import it.",
  "browser.resolveFailed": "Could not resolve the URL. Check the address or network settings.",
  "browser.resolveFailedDetail": "Could not resolve the URL: {error}",
  "browser.embeddedFailed": "Could not open the built-in browser",
  "browser.embeddedFailedDetail": "Could not open the built-in browser: {error}",
  "browser.externalFailed": "Could not open the system browser",
  "browser.externalFailedDetail": "Could not open the system browser: {error}",
  "browser.toastResolved": "Resolved “{title}” — opening the reader",
  "browser.toastEmbedded": "Opened in the built-in browser",
  "browser.toastExternal": "Opened in the system browser",
  "browser.toastImported": "Imported: {name}",
  "browser.toastNotImported": "Not imported: {name}",
  "browser.toastDownloaded": "Downloaded: {name}",
  "browser.toastAddedToLibrary": "Added to library",
  "browser.recentsTitle": "Recent",
  "browser.recentsHint":
    "Click to fill the address bar; only sanitized addresses are shown",
  "browser.recentsEmpty":
    "No recent visits yet — successful reads or opens are recorded automatically.",
  "browser.fillAddress": "Fill the address bar",
  "browser.deleteRecent": "Delete entry",
  "browser.deleteRecentAria": "Delete recent visit: {name}",
  "browser.downloadsTitle": "Downloads",
  "browser.downloadsDesc":
    "Archives downloaded in the built-in browser can be imported into your library",
  "browser.refreshing": "Refreshing",
  "browser.downloadsLoadFailed": "Could not load downloads",
  "browser.downloadsLoadError": "Could not load downloads: {error}",
  "browser.refreshFailed": "Refresh failed",
  "browser.refreshFailedDetail": "Refresh failed: {error}",
  "browser.downloadsLoading": "Loading downloads",
  "browser.downloadsEmpty":
    "No downloads yet — ZIP / CBZ files downloaded in the built-in browser will appear here",
  "browser.imported": "Imported",
  "browser.notImported": "Not imported",
  "browser.importing": "Importing",
  "browser.importAction": "Import",
  "browser.openFolder": "Open folder",
  "browser.openFolderTitle": "Open containing folder: {name}",
};

const es: BrowserMessages = {
  "browser.title": "Navegador",
  "browser.overline": "LECTOR EN LÍNEA",
  "browser.subtitle":
    "Envía directamente al lector la URL de un manifiesto o galería de manga en línea; también puedes abrir la página en el navegador integrado e importar la descarga a la biblioteca.",
  "browser.capabilities":
    "Compatible con manifiestos JSON y galerías HTML de una página",
  "browser.urlPlaceholder":
    "Pega la URL de un manifiesto o galería, p. ej. https://example.com/gallery.html",
  "browser.urlLabel": "Dirección del lector en línea",
  "browser.submitHint": "Resolver la URL y abrir el lector",
  "browser.submitHintOff": "El lector en línea está desactivado en Ajustes",
  "browser.resolving": "Resolviendo",
  "browser.directRead": "Leer",
  "browser.openEmbedded": "Navegador integrado",
  "browser.openExternal": "Navegador del sistema",
  "browser.downloadHint":
    "Los archivos ZIP / CBZ descargados en el navegador integrado se pueden importar abajo",
  "browser.gateTitle": "El lector en línea está desactivado",
  "browser.gateBadge": "Actívalo en Ajustes",
  "browser.gateBody":
    "La lectura directa no está disponible por ahora; aún puedes abrir la página en el navegador integrado o del sistema e importar la descarga a la biblioteca.",
  "browser.goSettings": "Ir a Ajustes",
  "browser.emptyUrl": "Introduce la URL de la página que quieres abrir",
  "browser.invalidUrl": "URL no válida: solo se admiten enlaces http(s)",
  "browser.directDisabled":
    "El lector en línea está desactivado en Ajustes, así que no se puede resolver esta URL",
  "browser.fallbackHint":
    "Puedes abrir la página en el navegador integrado, descargarla e importarla.",
  "browser.resolveFailed":
    "No se pudo resolver la URL. Revisa la dirección o los ajustes de red.",
  "browser.resolveFailedDetail": "No se pudo resolver la URL: {error}",
  "browser.embeddedFailed": "No se pudo abrir el navegador integrado",
  "browser.embeddedFailedDetail":
    "No se pudo abrir el navegador integrado: {error}",
  "browser.externalFailed": "No se pudo abrir el navegador del sistema",
  "browser.externalFailedDetail":
    "No se pudo abrir el navegador del sistema: {error}",
  "browser.toastResolved": "«{title}» resuelto; abriendo el lector",
  "browser.toastEmbedded": "Abierto en el navegador integrado",
  "browser.toastExternal": "Abierto en el navegador del sistema",
  "browser.toastImported": "Importado: {name}",
  "browser.toastNotImported": "No importado: {name}",
  "browser.toastDownloaded": "Descargado: {name}",
  "browser.toastAddedToLibrary": "Añadido a la biblioteca",
  "browser.recentsTitle": "Recientes",
  "browser.recentsHint":
    "Haz clic para rellenar la barra de direcciones; solo se muestran direcciones ocultas",
  "browser.recentsEmpty":
    "Aún no hay visitas recientes; las lecturas o aperturas correctas se guardan automáticamente.",
  "browser.fillAddress": "Rellenar la barra de direcciones",
  "browser.deleteRecent": "Eliminar entrada",
  "browser.deleteRecentAria": "Eliminar visita reciente: {name}",
  "browser.downloadsTitle": "Descargas",
  "browser.downloadsDesc":
    "Los archivos descargados en el navegador integrado se pueden importar a la biblioteca",
  "browser.refreshing": "Actualizando",
  "browser.downloadsLoadFailed": "No se pudieron cargar las descargas",
  "browser.downloadsLoadError": "No se pudieron cargar las descargas: {error}",
  "browser.refreshFailed": "Error al actualizar",
  "browser.refreshFailedDetail": "Error al actualizar: {error}",
  "browser.downloadsLoading": "Cargando descargas",
  "browser.downloadsEmpty":
    "Aún no hay descargas; los archivos ZIP / CBZ descargados en el navegador integrado aparecerán aquí",
  "browser.imported": "Importado",
  "browser.notImported": "Sin importar",
  "browser.importing": "Importando",
  "browser.importAction": "Importar",
  "browser.openFolder": "Abrir carpeta",
  "browser.openFolderTitle": "Abrir carpeta contenedora: {name}",
};

const ja: BrowserMessages = {
  "browser.title": "ブラウザ",
  "browser.overline": "オンラインリーダー",
  "browser.subtitle":
    "オンライン漫画のマニフェストやギャラリーの URL をそのままリーダーへ。専用の内蔵ブラウザでページを開き、ダウンロード後に書庫へ取り込むこともできます。",
  "browser.capabilities": "JSON マニフェストと単一ページ HTML ギャラリーに対応",
  "browser.urlPlaceholder":
    "マニフェストまたはギャラリーの URL を貼り付け（例：https://example.com/gallery.html）",
  "browser.urlLabel": "オンライン閲覧の URL",
  "browser.submitHint": "URL を解析してリーダーを開く",
  "browser.submitHintOff": "オンライン閲覧は設定でオフになっています",
  "browser.resolving": "解析中",
  "browser.directRead": "直読",
  "browser.openEmbedded": "内蔵ブラウザ",
  "browser.openExternal": "システムブラウザ",
  "browser.downloadHint":
    "内蔵ブラウザでダウンロードした zip / cbz は下で取り込めます",
  "browser.gateTitle": "オンライン閲覧がオフです",
  "browser.gateBadge": "設定で有効にしてください",
  "browser.gateBody":
    "直読ボタンは現在使用できません。内蔵ブラウザやシステムブラウザでページを開き、ダウンロード後に書庫へ取り込めます。",
  "browser.goSettings": "設定へ移動",
  "browser.emptyUrl": "開くページの URL を入力してください",
  "browser.invalidUrl": "URL が無効です。http(s) リンクのみ対応しています",
  "browser.directDisabled":
    "オンライン閲覧が設定でオフのため、この URL は解析できません",
  "browser.fallbackHint":
    "内蔵ブラウザでページを開き、ダウンロードして取り込むこともできます。",
  "browser.resolveFailed":
    "解析に失敗しました。URL またはネットワーク設定を確認してください",
  "browser.resolveFailedDetail": "解析に失敗しました：{error}",
  "browser.embeddedFailed": "内蔵ブラウザを開けませんでした",
  "browser.embeddedFailedDetail": "内蔵ブラウザを開けませんでした：{error}",
  "browser.externalFailed": "システムブラウザを開けませんでした",
  "browser.externalFailedDetail":
    "システムブラウザを開けませんでした：{error}",
  "browser.toastResolved": "『{title}』を解析しました。リーダーを開きます",
  "browser.toastEmbedded": "内蔵ブラウザで開きました",
  "browser.toastExternal": "システムブラウザで開きました",
  "browser.toastImported": "取り込みました：{name}",
  "browser.toastNotImported": "取り込めませんでした：{name}",
  "browser.toastDownloaded": "ダウンロードしました：{name}",
  "browser.toastAddedToLibrary": "書庫に追加しました",
  "browser.recentsTitle": "最近の訪問",
  "browser.recentsHint":
    "クリックでアドレスバーに入力。表示は秘匿化された URL のみ",
  "browser.recentsEmpty":
    "最近の訪問はまだありません。直読やページを開くと自動的に記録されます。",
  "browser.fillAddress": "アドレスバーに入力",
  "browser.deleteRecent": "履歴を削除",
  "browser.deleteRecentAria": "最近の訪問を削除：{name}",
  "browser.downloadsTitle": "ダウンロード",
  "browser.downloadsDesc":
    "内蔵ブラウザでダウンロードしたアーカイブは、取り込むと書庫に追加されます",
  "browser.refreshing": "更新中",
  "browser.downloadsLoadFailed": "ダウンロード一覧を読み込めませんでした",
  "browser.downloadsLoadError":
    "ダウンロード一覧を読み込めませんでした：{error}",
  "browser.refreshFailed": "更新に失敗しました",
  "browser.refreshFailedDetail": "更新に失敗しました：{error}",
  "browser.downloadsLoading": "ダウンロード一覧を読み込み中",
  "browser.downloadsEmpty":
    "ダウンロード履歴はまだありません。内蔵ブラウザで zip / cbz をダウンロードするとここに表示されます",
  "browser.imported": "取り込み済み",
  "browser.notImported": "未取り込み",
  "browser.importing": "取り込み中",
  "browser.importAction": "取り込む",
  "browser.openFolder": "フォルダーを開く",
  "browser.openFolderTitle": "保存先フォルダーを開く：{name}",
};

const ko: BrowserMessages = {
  "browser.title": "브라우저",
  "browser.overline": "온라인 리더",
  "browser.subtitle":
    "온라인 만화의 매니페스트나 갤러리 주소를 리더로 바로 보낼 수 있습니다. 내장 브라우저에서 페이지를 열고 내려받은 파일을 서재로 가져올 수도 있습니다.",
  "browser.capabilities": "JSON 매니페스트 및 단일 페이지 HTML 갤러리 지원",
  "browser.urlPlaceholder":
    "매니페스트 또는 갤러리 주소를 붙여넣으세요. 예: https://example.com/gallery.html",
  "browser.urlLabel": "온라인 읽기 주소",
  "browser.submitHint": "주소를 분석해 리더로 이동",
  "browser.submitHintOff": "온라인 읽기가 설정에서 꺼져 있습니다",
  "browser.resolving": "분석 중",
  "browser.directRead": "바로 읽기",
  "browser.openEmbedded": "내장 브라우저",
  "browser.openExternal": "시스템 브라우저",
  "browser.downloadHint":
    "내장 브라우저에서 내려받은 zip / cbz 파일은 아래에서 가져올 수 있습니다",
  "browser.gateTitle": "온라인 읽기가 꺼져 있습니다",
  "browser.gateBadge": "설정에서 사용 설정 필요",
  "browser.gateBody":
    "바로 읽기 버튼은 지금 사용할 수 없습니다. 내장 브라우저나 시스템 브라우저로 페이지를 열고 내려받은 파일을 서재로 가져올 수 있습니다.",
  "browser.goSettings": "설정으로 이동",
  "browser.emptyUrl": "열 페이지 주소를 입력하세요",
  "browser.invalidUrl": "주소가 올바르지 않습니다. http(s) 링크만 지원합니다",
  "browser.directDisabled":
    "온라인 읽기가 설정에서 꺼져 있어 이 주소를 분석할 수 없습니다",
  "browser.fallbackHint":
    "내장 브라우저에서 페이지를 연 뒤 내려받아 가져올 수 있습니다.",
  "browser.resolveFailed":
    "주소를 분석하지 못했습니다. 주소나 네트워크 설정을 확인하세요",
  "browser.resolveFailedDetail": "주소 분석 실패: {error}",
  "browser.embeddedFailed": "내장 브라우저를 열지 못했습니다",
  "browser.embeddedFailedDetail": "내장 브라우저를 열지 못했습니다: {error}",
  "browser.externalFailed": "시스템 브라우저를 열지 못했습니다",
  "browser.externalFailedDetail":
    "시스템 브라우저를 열지 못했습니다: {error}",
  "browser.toastResolved": "“{title}” 분석 완료, 리더를 엽니다",
  "browser.toastEmbedded": "내장 브라우저에서 열었습니다",
  "browser.toastExternal": "시스템 브라우저에서 열었습니다",
  "browser.toastImported": "가져옴: {name}",
  "browser.toastNotImported": "가져오지 못함: {name}",
  "browser.toastDownloaded": "내려받음: {name}",
  "browser.toastAddedToLibrary": "서재에 추가됨",
  "browser.recentsTitle": "최근 방문",
  "browser.recentsHint":
    "클릭하면 주소창에 입력됩니다. 주소는 일부만 표시됩니다",
  "browser.recentsEmpty":
    "최근 방문이 없습니다. 바로 읽기나 페이지 열기에 성공하면 자동으로 기록됩니다.",
  "browser.fillAddress": "주소창에 입력",
  "browser.deleteRecent": "기록 삭제",
  "browser.deleteRecentAria": "최근 방문 삭제: {name}",
  "browser.downloadsTitle": "다운로드",
  "browser.downloadsDesc":
    "내장 브라우저에서 내려받은 압축 파일을 가져오면 서재에 추가됩니다",
  "browser.refreshing": "새로고침 중",
  "browser.downloadsLoadFailed": "다운로드 목록을 불러오지 못했습니다",
  "browser.downloadsLoadError": "다운로드 목록을 불러오지 못했습니다: {error}",
  "browser.refreshFailed": "새로고침 실패",
  "browser.refreshFailedDetail": "새로고침 실패: {error}",
  "browser.downloadsLoading": "다운로드 목록을 불러오는 중",
  "browser.downloadsEmpty":
    "다운로드 기록이 없습니다. 내장 브라우저에서 zip / cbz 파일을 내려받으면 여기에 표시됩니다",
  "browser.imported": "가져옴",
  "browser.notImported": "가져오지 않음",
  "browser.importing": "가져오는 중",
  "browser.importAction": "가져오기",
  "browser.openFolder": "폴더 열기",
  "browser.openFolderTitle": "저장 폴더 열기: {name}",
};

export const browserMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
