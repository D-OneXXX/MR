/**
 * Library grid, cards, filters and selection strings.
 * Owned by the library grid conversion. All six objects must stay in sync.
 */
const zhCN = {
  "library.summary": "共 {total} 本 · 在读 {reading} · 今日 {today} 页",
  "library.searchPlaceholder": "搜索书名、合集…（Ctrl+K）",
  "library.searchAria": "搜索书名",
  "library.sourceFilterAria": "来源筛选",
  "library.groupAria": "合集显示方式",
  "library.groupSeries": "按合集",
  "library.groupSeriesTitle": "同一合集只显示代表卡",
  "library.flat": "平铺",
  "library.flatTitle": "逐个章节平铺显示",
  "library.addBooks": "添加书籍",
  "library.addBooksTitle": "选择压缩包（zip / cbz）导入",
  "library.addFolder": "添加文件夹",
  "library.addFolderTitle": "选择一个文件夹（其内容 = 一本书）",
  "library.onlineRead": "在线直读",
  "library.onlineReadTitleOn": "从链接或配对导入在线漫画",
  "library.onlineReadTitleOff": "请先在设置中开启实验性在线直读",
  "library.manage": "管理",
  "library.done": "完成",
  "library.manageTitle": "多选后可批量移除或删除",
  "library.countGroups": "{count} 组",
  "library.countBooks": "{count} 本",
  "library.loadMore": "再加载 {count} 本",
  "library.loadingAria": "正在载入书架",
  "library.loadFailed": "书库加载失败：{error}",
  "library.emptySearch": "没有搜到，去换个关键词吧",
  "library.emptyFilter": "当前来源筛选下还没有书，切换到「全部」看看",
  "library.emptyLibrary":
    "书架还是空的——拖入 cbz/zip 或文件夹，或点「添加书籍」",
  "library.dragHint": "也可以直接把 zip / cbz 压缩包或文件夹拖进窗口导入",
  "library.cardHint":
    "单击封面查看详情，双击或 Shift+Enter 开始阅读；右键封面可移除或删除源文件。",
  "library.selected": "已选",
  "library.bulkAria": "批量操作",
  "library.exitSelectAria": "取消多选",
  "library.removeRecords": "移除记录",
  "library.deleteMixed": "删除 / 彻底移除…",
  "library.deleteOnline": "彻底移除…",
  "library.deleteLocal": "删除源文件…",
  "library.removed": "已移除 {count} 本：源文件保留，重新导入可续读",
  "library.deletedOnlineOnly": "已彻底移除 {count} 本在线书，远程源未删除",
  "library.deletedMixed":
    "已删除源文件 {files} 个，并彻底移除 {count} 本在线书（远程源未删除），全部记录已清理",
  "library.deletedLocal": "已删除源文件 {files} 个并清理全部记录",
  "library.deletedNone": "没有源文件被删除",
  "library.enableOnlineFirst": "请先在设置中开启实验性「在线直读」",
  "card.readPages": "已读 {current} / {total} 页",
  "card.notStarted": "{total} 页 · 未开始",
  "card.ariaStatusRead": "已读 {current}/{total} 页",
  "card.ariaStatusNotStarted": "{total} 页，未开始",
  "card.ariaSeries": "，合集 {count} 话",
  "card.ariaOnline": "，在线直读",
  "card.ariaHintSelect": "空格切换选择",
  "card.ariaHintOpen": "回车查看详情，Shift 加回车阅读",
  "card.ariaLabel": "{title}，{status}{series}{online}{missing}。{hint}",
  "card.titleSelect": "{title}（单击勾选）",
  "card.titleOpen": "{title}（单击查看详情，双击进入阅读）",
  "card.seriesBadge": "合集 · {count} 话",
  "card.progress": "{percent}%",
  "card.missing": "文件位置已变更",
  "card.ariaMissing": "文件位置已变更，需要重新指定",
  "relocate.description":
    "源文件已被移动或重命名。重新指定位置后，阅读进度、条漫偏移与阅读统计会原样保留。",
  "relocate.currentPath": "原位置：{name}",
  "relocate.choose": "重新指定文件位置",
  "relocate.remove": "从书库移除",
  "relocate.success": "已重新定位「{title}」，阅读进度已保留",
  "book.missingNotice":
    "源文件已被移动或重命名。重新指定位置后，阅读进度与统计不会丢失。",
  "openWith.failed": "无法打开「{name}」：文件不存在或格式不受支持",
  "openWith.safeMode":
    "安全模式已开启，文件已导入书库；关闭安全模式后再阅读。",
  "menu.aria": "书籍操作",
  "menu.details": "查看详情",
  "menu.continue": "继续阅读",
  "menu.remove": "移除记录",
  "menu.deleteLocal": "删除源文件…",
  "menu.deleteOnline": "彻底移除…",
  "confirm.titleMixed":
    "删除本地源文件 / 彻底移除在线书（{count} 本 · 共 {pages} 页）？",
  "confirm.titleOnline": "彻底移除（{count} 本 · 共 {pages} 页）？",
  "confirm.titleLocal": "删除源文件（{count} 本 · 共 {pages} 页）？",
  "confirm.messageMixed":
    "将永久删除 {local} 本本地书的源文件（从磁盘移除），并彻底移除 {online} 本在线书；在线书的远程源不会被删除。以上书籍的进度、缩略图与派生缓存等全部本地记录都会清理。此操作不可逆。",
  "confirm.messageOnline":
    "将从书库移除以下在线书，并清理进度、缩略图与派生缓存等全部本地记录；不会删除远程源。此操作不可逆。",
  "confirm.messageLocal":
    "将从磁盘永久删除以下源文件/文件夹，并清理该书的进度、缩略图与派生缓存等全部本地记录。此操作不可逆。",
  "confirm.confirmMixed": "删除 / 彻底移除",
  "confirm.confirmOnline": "彻底移除",
  "confirm.confirmLocal": "永久删除",
  "confirm.pathLine": "【{source}】{name}（{pages} 页）",
  "import.progress": "正在导入 {done} / {total}",
  "import.complete": "导入完成：{summary}",
  "import.added": "新增 {count}",
  "import.restored": "恢复 {count}（进度保留）",
  "import.inLibrary": "已在书库 {count}",
  "import.failed": "失败 {count}",
  "import.itemFailed": "{path}：{message}",
  "import.failedFallback": "导入失败",
  "import.filesTitle": "选择漫画压缩包（zip / cbz，可多选）",
  "import.filesFilter": "漫画压缩包",
  "import.folderTitle": "选择漫画文件夹（一个文件夹 = 一本书，可多选）",
  "import.pickerUnavailable": "文件选择器不可用，请改用拖拽导入",
  "import.folderPickerUnavailable": "文件夹选择器不可用，请改用拖拽导入",
  "import.dropTitle": "松开即可导入",
  "import.dropHint": "支持 zip / cbz 压缩包与文件夹，可一次拖入多个",
} as const;

type LibraryMessages = { [K in keyof typeof zhCN]: string };

const zhTW: LibraryMessages = {
  "library.summary": "共 {total} 本 · 在讀 {reading} · 今日 {today} 頁",
  "library.searchPlaceholder": "搜尋書名、合集…（Ctrl+K）",
  "library.searchAria": "搜尋書名",
  "library.sourceFilterAria": "來源篩選",
  "library.groupAria": "合集顯示方式",
  "library.groupSeries": "依合集",
  "library.groupSeriesTitle": "同一合集只顯示代表卡",
  "library.flat": "並排",
  "library.flatTitle": "逐個章節並排顯示",
  "library.addBooks": "新增書籍",
  "library.addBooksTitle": "選擇壓縮檔（zip / cbz）匯入",
  "library.addFolder": "新增資料夾",
  "library.addFolderTitle": "選擇一個資料夾（其內容 = 一本書）",
  "library.onlineRead": "線上直讀",
  "library.onlineReadTitleOn": "從連結或配對匯入線上漫畫",
  "library.onlineReadTitleOff": "請先在設定中開啟實驗性線上直讀",
  "library.manage": "管理",
  "library.done": "完成",
  "library.manageTitle": "多選後可批次移除或刪除",
  "library.countGroups": "{count} 組",
  "library.countBooks": "{count} 本",
  "library.loadMore": "再載入 {count} 本",
  "library.loadingAria": "正在載入書架",
  "library.loadFailed": "書庫載入失敗：{error}",
  "library.emptySearch": "沒有搜尋到，換個關鍵字試試",
  "library.emptyFilter": "目前來源篩選下還沒有書，切換到「全部」看看",
  "library.emptyLibrary":
    "書架還是空的——拖入 cbz/zip 或資料夾，或點「新增書籍」",
  "library.dragHint": "也可以直接把 zip / cbz 壓縮檔或資料夾拖進視窗匯入",
  "library.cardHint":
    "按一下封面查看詳情，連按兩下或 Shift+Enter 開始閱讀；在封面上按右鍵可移除或刪除來源檔案。",
  "library.selected": "已選",
  "library.bulkAria": "批次操作",
  "library.exitSelectAria": "取消多選",
  "library.removeRecords": "移除紀錄",
  "library.deleteMixed": "刪除 / 徹底移除…",
  "library.deleteOnline": "徹底移除…",
  "library.deleteLocal": "刪除來源檔案…",
  "library.removed": "已移除 {count} 本：來源檔案保留，重新匯入可續讀",
  "library.deletedOnlineOnly": "已徹底移除 {count} 本線上書，遠端來源未刪除",
  "library.deletedMixed":
    "已刪除來源檔案 {files} 個，並徹底移除 {count} 本線上書（遠端來源未刪除），全部紀錄已清理",
  "library.deletedLocal": "已刪除來源檔案 {files} 個並清理全部紀錄",
  "library.deletedNone": "沒有來源檔案被刪除",
  "library.enableOnlineFirst": "請先在設定中開啟實驗性「線上直讀」",
  "card.readPages": "已讀 {current} / {total} 頁",
  "card.notStarted": "{total} 頁 · 未開始",
  "card.ariaStatusRead": "已讀 {current}/{total} 頁",
  "card.ariaStatusNotStarted": "{total} 頁，未開始",
  "card.ariaSeries": "，合集 {count} 話",
  "card.ariaOnline": "，線上直讀",
  "card.ariaHintSelect": "空格切換選取",
  "card.ariaHintOpen": "Enter 查看詳情，Shift+Enter 閱讀",
  "card.ariaLabel": "{title}，{status}{series}{online}{missing}。{hint}",
  "card.titleSelect": "{title}（按一下勾選）",
  "card.titleOpen": "{title}（按一下查看詳情，連按兩下開始閱讀）",
  "card.seriesBadge": "合集 · {count} 話",
  "card.progress": "{percent}%",
  "card.missing": "檔案位置已變更",
  "card.ariaMissing": "檔案位置已變更，需要重新指定",
  "relocate.description":
    "來源檔案已被移動或重新命名。重新指定位置後，閱讀進度、條漫偏移與閱讀統計會原樣保留。",
  "relocate.currentPath": "原位置：{name}",
  "relocate.choose": "重新指定檔案位置",
  "relocate.remove": "從書庫移除",
  "relocate.success": "已重新定位「{title}」，閱讀進度已保留",
  "book.missingNotice":
    "來源檔案已被移動或重新命名。重新指定位置後，閱讀進度與統計不會遺失。",
  "openWith.failed": "無法開啟「{name}」：檔案不存在或格式不受支援",
  "openWith.safeMode":
    "安全模式已開啟，檔案已匯入書庫；關閉安全模式後再閱讀。",
  "menu.aria": "書籍操作",
  "menu.details": "查看詳情",
  "menu.continue": "繼續閱讀",
  "menu.remove": "移除紀錄",
  "menu.deleteLocal": "刪除來源檔案…",
  "menu.deleteOnline": "徹底移除…",
  "confirm.titleMixed":
    "刪除本機來源檔案 / 徹底移除線上書（{count} 本 · 共 {pages} 頁）？",
  "confirm.titleOnline": "徹底移除（{count} 本 · 共 {pages} 頁）？",
  "confirm.titleLocal": "刪除來源檔案（{count} 本 · 共 {pages} 頁）？",
  "confirm.messageMixed":
    "將永久刪除 {local} 本本機書的來源檔案（從磁碟移除），並徹底移除 {online} 本線上書；線上書的遠端來源不會被刪除。以上書籍的進度、縮圖與衍生快取等全部本機紀錄都會清理。此操作不可逆。",
  "confirm.messageOnline":
    "將從書庫移除以下線上書，並清理進度、縮圖與衍生快取等全部本機紀錄；不會刪除遠端來源。此操作不可逆。",
  "confirm.messageLocal":
    "將從磁碟永久刪除以下來源檔案/資料夾，並清理該書的進度、縮圖與衍生快取等全部本機紀錄。此操作不可逆。",
  "confirm.confirmMixed": "刪除 / 徹底移除",
  "confirm.confirmOnline": "徹底移除",
  "confirm.confirmLocal": "永久刪除",
  "confirm.pathLine": "【{source}】{name}（{pages} 頁）",
  "import.progress": "正在匯入 {done} / {total}",
  "import.complete": "匯入完成：{summary}",
  "import.added": "新增 {count}",
  "import.restored": "恢復 {count}（進度保留）",
  "import.inLibrary": "已在書庫 {count}",
  "import.failed": "失敗 {count}",
  "import.itemFailed": "{path}：{message}",
  "import.failedFallback": "匯入失敗",
  "import.filesTitle": "選擇漫畫壓縮檔（zip / cbz，可多選）",
  "import.filesFilter": "漫畫壓縮檔",
  "import.folderTitle": "選擇漫畫資料夾（一個資料夾 = 一本書，可多選）",
  "import.pickerUnavailable": "檔案選擇器不可用，請改用拖曳匯入",
  "import.folderPickerUnavailable": "資料夾選擇器不可用，請改用拖曳匯入",
  "import.dropTitle": "放開即可匯入",
  "import.dropHint": "支援 zip / cbz 壓縮檔與資料夾，可一次拖入多個",
};

const en: LibraryMessages = {
  "library.summary": "Books {total} · Reading {reading} · Today {today} pages",
  "library.searchPlaceholder": "Search titles, series… (Ctrl+K)",
  "library.searchAria": "Search titles",
  "library.sourceFilterAria": "Source filter",
  "library.groupAria": "Series display",
  "library.groupSeries": "By series",
  "library.groupSeriesTitle": "Show one card per series",
  "library.flat": "Flat",
  "library.flatTitle": "Show every chapter as a card",
  "library.addBooks": "Add books",
  "library.addBooksTitle": "Choose archives (zip / cbz) to import",
  "library.addFolder": "Add folder",
  "library.addFolderTitle": "Choose a folder (its contents = one book)",
  "library.onlineRead": "Read online",
  "library.onlineReadTitleOn": "Import online manga from a link or pairing",
  "library.onlineReadTitleOff":
    "Enable experimental online reading in Settings first",
  "library.manage": "Manage",
  "library.done": "Done",
  "library.manageTitle": "Select multiple books to remove or delete",
  "library.countGroups": "{count} series",
  "library.countBooks": "{count} books",
  "library.loadMore": "Load {count} more",
  "library.loadingAria": "Loading shelf",
  "library.loadFailed": "Failed to load library: {error}",
  "library.emptySearch": "No matches — try another keyword",
  "library.emptyFilter": "No books for this source filter — switch to “All”",
  "library.emptyLibrary":
    "The shelf is empty — drop cbz/zip files or a folder, or click “Add books”",
  "library.dragHint":
    "You can also drag zip / cbz archives or folders into the window to import",
  "library.cardHint":
    "Click a cover for details, double-click or press Shift+Enter to read; right-click a cover to remove or delete the source.",
  "library.selected": "selected",
  "library.bulkAria": "Bulk actions",
  "library.exitSelectAria": "Exit selection",
  "library.removeRecords": "Remove records",
  "library.deleteMixed": "Delete / remove…",
  "library.deleteOnline": "Remove completely…",
  "library.deleteLocal": "Delete source files…",
  "library.removed":
    "Removed {count} books: source files kept, re-import to resume",
  "library.deletedOnlineOnly":
    "Removed {count} online books completely; remote sources were not deleted",
  "library.deletedMixed":
    "Deleted {files} source files and removed {count} online books completely (remote sources kept); all records cleared",
  "library.deletedLocal": "Deleted {files} source files and cleared all records",
  "library.deletedNone": "No source files were deleted",
  "library.enableOnlineFirst":
    "Enable experimental “Read online” in Settings first",
  "card.readPages": "Read {current} / {total} pages",
  "card.notStarted": "{total} pages · Not started",
  "card.ariaStatusRead": "Read {current}/{total} pages",
  "card.ariaStatusNotStarted": "{total} pages, not started",
  "card.ariaSeries": ", series of {count} chapters",
  "card.ariaOnline": ", online",
  "card.ariaHintSelect": "Space toggles selection",
  "card.ariaHintOpen": "Enter opens details, Shift+Enter reads",
  "card.ariaLabel": "{title}. {status}{series}{online}{missing}. {hint}",
  "card.titleSelect": "{title} (click to select)",
  "card.titleOpen": "{title} (click for details, double-click to read)",
  "card.seriesBadge": "Series · {count} chapters",
  "card.progress": "{percent}%",
  "card.missing": "File location changed",
  "card.ariaMissing": "File location changed; relocation required",
  "relocate.description":
    "The source file was moved or renamed. Relink it to keep your reading progress, webtoon offset and statistics intact.",
  "relocate.currentPath": "Previous location: {name}",
  "relocate.choose": "Relink file location",
  "relocate.remove": "Remove from library",
  "relocate.success": "Relinked “{title}”; reading progress was preserved",
  "book.missingNotice":
    "The source file was moved or renamed. Relink it and your progress and statistics stay intact.",
  "openWith.failed":
    "Could not open “{name}”: the file is missing or unsupported",
  "openWith.safeMode":
    "Safe mode is on. The file was added to your library; turn off safe mode to read it.",
  "menu.aria": "Book actions",
  "menu.details": "View details",
  "menu.continue": "Continue reading",
  "menu.remove": "Remove record",
  "menu.deleteLocal": "Delete source files…",
  "menu.deleteOnline": "Remove completely…",
  "confirm.titleMixed":
    "Delete local source files / remove online books (books {count} · pages {pages})?",
  "confirm.titleOnline":
    "Remove completely (books {count} · pages {pages})?",
  "confirm.titleLocal": "Delete source files (books {count} · pages {pages})?",
  "confirm.messageMixed":
    "This permanently deletes the source files of {local} local books (removed from disk) and completely removes {online} online books; remote sources for online books are not deleted. All local records for these books — progress, thumbnails and derived caches — will be cleared. This cannot be undone.",
  "confirm.messageOnline":
    "The following online books will be removed from the library and all local records — progress, thumbnails and derived caches — will be cleared; remote sources are not deleted. This cannot be undone.",
  "confirm.messageLocal":
    "The following source files/folders will be permanently deleted from disk and all local records for these books — progress, thumbnails and derived caches — will be cleared. This cannot be undone.",
  "confirm.confirmMixed": "Delete / remove",
  "confirm.confirmOnline": "Remove completely",
  "confirm.confirmLocal": "Delete permanently",
  "confirm.pathLine": "[{source}] {name} ({pages} pages)",
  "import.progress": "Importing {done} / {total}",
  "import.complete": "Import complete: {summary}",
  "import.added": "Added {count}",
  "import.restored": "Restored {count} (progress kept)",
  "import.inLibrary": "Already in library {count}",
  "import.failed": "Failed {count}",
  "import.itemFailed": "{path}: {message}",
  "import.failedFallback": "Import failed",
  "import.filesTitle": "Choose manga archives (zip / cbz, multiple allowed)",
  "import.filesFilter": "Manga archives",
  "import.folderTitle":
    "Choose manga folders (one folder = one book, multiple allowed)",
  "import.pickerUnavailable":
    "File picker unavailable — drag files in instead",
  "import.folderPickerUnavailable":
    "Folder picker unavailable — drag folders in instead",
  "import.dropTitle": "Drop to import",
  "import.dropHint":
    "Supports zip / cbz archives and folders, multiple at once",
};

const es: LibraryMessages = {
  "library.summary": "Libros {total} · Leyendo {reading} · Hoy {today} págs.",
  "library.searchPlaceholder": "Buscar títulos, series… (Ctrl+K)",
  "library.searchAria": "Buscar títulos",
  "library.sourceFilterAria": "Filtro de origen",
  "library.groupAria": "Visualización de series",
  "library.groupSeries": "Por serie",
  "library.groupSeriesTitle": "Mostrar una tarjeta por serie",
  "library.flat": "Lista",
  "library.flatTitle": "Mostrar cada capítulo como tarjeta",
  "library.addBooks": "Añadir libros",
  "library.addBooksTitle": "Elegir archivos (zip / cbz) para importar",
  "library.addFolder": "Añadir carpeta",
  "library.addFolderTitle": "Elegir una carpeta (su contenido = un libro)",
  "library.onlineRead": "Leer en línea",
  "library.onlineReadTitleOn":
    "Importar manga en línea desde un enlace o emparejamiento",
  "library.onlineReadTitleOff":
    "Activa primero la lectura en línea experimental en Ajustes",
  "library.manage": "Gestionar",
  "library.done": "Listo",
  "library.manageTitle":
    "Selecciona varios libros para quitarlos o eliminarlos",
  "library.countGroups": "{count} series",
  "library.countBooks": "{count} libros",
  "library.loadMore": "Cargar {count} más",
  "library.loadingAria": "Cargando estantería",
  "library.loadFailed": "Error al cargar la biblioteca: {error}",
  "library.emptySearch": "Sin resultados: prueba otra palabra clave",
  "library.emptyFilter":
    "No hay libros con este filtro de origen: cambia a «Todo»",
  "library.emptyLibrary":
    "La estantería está vacía: arrastra cbz/zip o una carpeta, o pulsa «Añadir libros»",
  "library.dragHint":
    "También puedes arrastrar archivos zip / cbz o carpetas a la ventana para importarlos",
  "library.cardHint":
    "Haz clic en una portada para ver los detalles; doble clic o Mayús+Intro para leer; clic derecho para quitar o eliminar el origen.",
  "library.selected": "seleccionados",
  "library.bulkAria": "Acciones en lote",
  "library.exitSelectAria": "Salir de la selección",
  "library.removeRecords": "Quitar registros",
  "library.deleteMixed": "Eliminar / quitar…",
  "library.deleteOnline": "Quitar por completo…",
  "library.deleteLocal": "Eliminar archivos de origen…",
  "library.removed":
    "Se quitaron {count} libros: los archivos de origen se conservan; vuelve a importarlos para continuar",
  "library.deletedOnlineOnly":
    "Se quitaron por completo {count} libros en línea; los orígenes remotos no se eliminaron",
  "library.deletedMixed":
    "Se eliminaron {files} archivos de origen y se quitaron por completo {count} libros en línea (orígenes remotos conservados); todos los registros se borraron",
  "library.deletedLocal":
    "Se eliminaron {files} archivos de origen y se borraron todos los registros",
  "library.deletedNone": "No se eliminó ningún archivo de origen",
  "library.enableOnlineFirst":
    "Activa primero la lectura en línea experimental «Leer en línea» en Ajustes",
  "card.readPages": "Leídas {current} / {total} páginas",
  "card.notStarted": "{total} páginas · Sin empezar",
  "card.ariaStatusRead": "Leídas {current}/{total} páginas",
  "card.ariaStatusNotStarted": "{total} páginas, sin empezar",
  "card.ariaSeries": ", serie de {count} capítulos",
  "card.ariaOnline": ", en línea",
  "card.ariaHintSelect": "Espacio alterna la selección",
  "card.ariaHintOpen": "Intro abre los detalles, Mayús+Intro lee",
  "card.ariaLabel": "{title}. {status}{series}{online}{missing}. {hint}",
  "card.titleSelect": "{title} (clic para seleccionar)",
  "card.titleOpen": "{title} (clic para detalles, doble clic para leer)",
  "card.seriesBadge": "Serie · {count} capítulos",
  "card.progress": "{percent}%",
  "card.missing": "Ubicación del archivo cambiada",
  "card.ariaMissing": "Ubicación del archivo cambiada; se requiere reubicarlo",
  "relocate.description":
    "El archivo de origen se movió o cambió de nombre. Vuelve a vincularlo para conservar el progreso, el desplazamiento y las estadísticas.",
  "relocate.currentPath": "Ubicación anterior: {name}",
  "relocate.choose": "Volver a vincular ubicación",
  "relocate.remove": "Quitar de la biblioteca",
  "relocate.success": "Se volvió a vincular «{title}»; el progreso se conservó",
  "book.missingNotice":
    "El archivo de origen se movió o cambió de nombre. Vuelve a vincularlo y tu progreso y estadísticas se conservarán.",
  "openWith.failed":
    "No se pudo abrir «{name}»: el archivo no existe o no es compatible",
  "openWith.safeMode":
    "El modo seguro está activo. El archivo se añadió a la biblioteca; desactívalo para leerlo.",
  "menu.aria": "Acciones del libro",
  "menu.details": "Ver detalles",
  "menu.continue": "Continuar leyendo",
  "menu.remove": "Quitar registro",
  "menu.deleteLocal": "Eliminar archivos de origen…",
  "menu.deleteOnline": "Quitar por completo…",
  "confirm.titleMixed":
    "¿Eliminar archivos locales / quitar libros en línea? (libros {count} · págs. {pages})",
  "confirm.titleOnline":
    "¿Quitar por completo? (libros {count} · págs. {pages})",
  "confirm.titleLocal":
    "¿Eliminar archivos de origen? (libros {count} · págs. {pages})",
  "confirm.messageMixed":
    "Se eliminarán permanentemente los archivos de origen de {local} libros locales (se borran del disco) y se quitarán por completo {online} libros en línea; los orígenes remotos de los libros en línea no se eliminarán. Se borrarán todos los registros locales de estos libros: progreso, miniaturas y cachés derivadas. Esta acción no se puede deshacer.",
  "confirm.messageOnline":
    "Los siguientes libros en línea se quitarán de la biblioteca y se borrarán todos los registros locales: progreso, miniaturas y cachés derivadas; los orígenes remotos no se eliminarán. Esta acción no se puede deshacer.",
  "confirm.messageLocal":
    "Los siguientes archivos o carpetas de origen se eliminarán permanentemente del disco y se borrarán todos los registros locales de estos libros: progreso, miniaturas y cachés derivadas. Esta acción no se puede deshacer.",
  "confirm.confirmMixed": "Eliminar / quitar",
  "confirm.confirmOnline": "Quitar por completo",
  "confirm.confirmLocal": "Eliminar permanentemente",
  "confirm.pathLine": "[{source}] {name} ({pages} págs.)",
  "import.progress": "Importando {done} / {total}",
  "import.complete": "Importación completada: {summary}",
  "import.added": "Añadidos {count}",
  "import.restored": "Restaurados {count} (progreso conservado)",
  "import.inLibrary": "Ya en la biblioteca {count}",
  "import.failed": "Fallidos {count}",
  "import.itemFailed": "{path}: {message}",
  "import.failedFallback": "Error al importar",
  "import.filesTitle":
    "Elegir archivos de manga (zip / cbz, se permiten varios)",
  "import.filesFilter": "Archivos de manga",
  "import.folderTitle":
    "Elegir carpetas de manga (una carpeta = un libro, se permiten varias)",
  "import.pickerUnavailable":
    "Selector de archivos no disponible: arrastra los archivos",
  "import.folderPickerUnavailable":
    "Selector de carpetas no disponible: arrastra las carpetas",
  "import.dropTitle": "Suelta para importar",
  "import.dropHint":
    "Admite archivos zip / cbz y carpetas, varios a la vez",
};

const ja: LibraryMessages = {
  "library.summary": "全 {total} 冊 · 読書中 {reading} · 今日 {today} ページ",
  "library.searchPlaceholder": "タイトル・シリーズを検索…（Ctrl+K）",
  "library.searchAria": "タイトルを検索",
  "library.sourceFilterAria": "ソースフィルター",
  "library.groupAria": "シリーズ表示",
  "library.groupSeries": "シリーズごと",
  "library.groupSeriesTitle": "同じシリーズは代表カードのみ表示",
  "library.flat": "フラット",
  "library.flatTitle": "各話を並べて表示",
  "library.addBooks": "本を追加",
  "library.addBooksTitle": "アーカイブ（zip / cbz）を選択して読み込む",
  "library.addFolder": "フォルダーを追加",
  "library.addFolderTitle": "フォルダーを選択（中身が 1 冊になります）",
  "library.onlineRead": "オンライン閲覧",
  "library.onlineReadTitleOn":
    "リンクまたはペアリングからオンライン漫画を読み込む",
  "library.onlineReadTitleOff":
    "先に設定で実験的なオンライン閲覧を有効にしてください",
  "library.manage": "管理",
  "library.done": "完了",
  "library.manageTitle": "複数選択して一括削除やソース削除ができます",
  "library.countGroups": "{count} シリーズ",
  "library.countBooks": "{count} 冊",
  "library.loadMore": "さらに {count} 冊読み込む",
  "library.loadingAria": "書架を読み込み中",
  "library.loadFailed": "書庫の読み込みに失敗しました：{error}",
  "library.emptySearch": "見つかりませんでした。別の言葉で検索してください",
  "library.emptyFilter":
    "このソースフィルターには本がありません。「すべて」に切り替えてください",
  "library.emptyLibrary":
    "書架は空です。cbz/zip やフォルダーをドロップするか、「本を追加」をクリックしてください",
  "library.dragHint":
    "zip / cbz アーカイブやフォルダーをウィンドウにドラッグして読み込むこともできます",
  "library.cardHint":
    "表紙をクリックで詳細、ダブルクリックまたは Shift+Enter で読書開始。表紙を右クリックすると記録の削除やソースの削除ができます。",
  "library.selected": "選択中",
  "library.bulkAria": "一括操作",
  "library.exitSelectAria": "選択を解除",
  "library.removeRecords": "記録を削除",
  "library.deleteMixed": "削除 / 完全削除…",
  "library.deleteOnline": "完全に削除…",
  "library.deleteLocal": "ソースファイルを削除…",
  "library.removed":
    "{count} 冊を削除しました。ソースファイルは保持され、再読み込みで続きから読めます",
  "library.deletedOnlineOnly":
    "オンライン本 {count} 冊を完全に削除しました（リモートソースは削除されていません）",
  "library.deletedMixed":
    "ソースファイル {files} 個を削除し、オンライン本 {count} 冊を完全に削除しました（リモートソースは保持）。すべての記録を消去しました",
  "library.deletedLocal":
    "ソースファイル {files} 個を削除し、すべての記録を消去しました",
  "library.deletedNone": "削除されたソースファイルはありません",
  "library.enableOnlineFirst":
    "先に設定で実験的な「オンライン閲覧」を有効にしてください",
  "card.readPages": "{current} / {total} ページ読了",
  "card.notStarted": "{total} ページ · 未読",
  "card.ariaStatusRead": "{current}/{total} ページ読了",
  "card.ariaStatusNotStarted": "{total} ページ、未読",
  "card.ariaSeries": "、シリーズ {count} 話",
  "card.ariaOnline": "、オンライン",
  "card.ariaHintSelect": "スペースで選択を切り替え",
  "card.ariaHintOpen": "Enter で詳細、Shift+Enter で読書",
  "card.ariaLabel": "『{title}』{status}{series}{online}{missing}。{hint}",
  "card.titleSelect": "『{title}』（クリックで選択）",
  "card.titleOpen": "『{title}』（クリックで詳細、ダブルクリックで読書）",
  "card.seriesBadge": "シリーズ · {count} 話",
  "card.progress": "{percent}%",
  "card.missing": "ファイルの場所が変更されました",
  "card.ariaMissing": "ファイルの場所が変更されました。再指定が必要です",
  "relocate.description":
    "元のファイルが移動または名前変更されました。場所を再指定すると、読書進度・縦読み位置・統計はそのまま保持されます。",
  "relocate.currentPath": "元の場所：{name}",
  "relocate.choose": "ファイルの場所を再指定",
  "relocate.remove": "ライブラリから削除",
  "relocate.success":
    "「{title}」の場所を再指定しました。読書進度は保持されています",
  "book.missingNotice":
    "元のファイルが移動または名前変更されました。場所を再指定すれば、読書進度と統計は失われません。",
  "openWith.failed":
    "「{name}」を開けません：ファイルが存在しないか、形式に対応していません",
  "openWith.safeMode":
    "セーフモードが有効です。ファイルはライブラリに追加されました。セーフモードを解除してから読んでください。",
  "menu.aria": "本の操作",
  "menu.details": "詳細を表示",
  "menu.continue": "続きを読む",
  "menu.remove": "記録を削除",
  "menu.deleteLocal": "ソースファイルを削除…",
  "menu.deleteOnline": "完全に削除…",
  "confirm.titleMixed":
    "ローカルソースを削除 / オンライン本を完全削除（{count} 冊 · 全 {pages} ページ）？",
  "confirm.titleOnline":
    "完全に削除（{count} 冊 · 全 {pages} ページ）？",
  "confirm.titleLocal": "ソースファイルを削除（{count} 冊 · 全 {pages} ページ）？",
  "confirm.messageMixed":
    "ローカル本 {local} 冊のソースファイルをディスクから完全に削除し、オンライン本 {online} 冊を完全に削除します。オンライン本のリモートソースは削除されません。これらの本の進捗、サムネイル、派生キャッシュなど、すべてのローカル記録が消去されます。この操作は元に戻せません。",
  "confirm.messageOnline":
    "以下のオンライン本を書庫から削除し、進捗、サムネイル、派生キャッシュなど、すべてのローカル記録を消去します。リモートソースは削除されません。この操作は元に戻せません。",
  "confirm.messageLocal":
    "以下のソースファイル/フォルダーをディスクから完全に削除し、これらの本の進捗、サムネイル、派生キャッシュなど、すべてのローカル記録を消去します。この操作は元に戻せません。",
  "confirm.confirmMixed": "削除 / 完全削除",
  "confirm.confirmOnline": "完全に削除",
  "confirm.confirmLocal": "完全に削除",
  "confirm.pathLine": "【{source}】{name}（{pages} ページ）",
  "import.progress": "読み込み中 {done} / {total}",
  "import.complete": "読み込み完了：{summary}",
  "import.added": "新規 {count}",
  "import.restored": "復元 {count}（進捗保持）",
  "import.inLibrary": "書庫にあり {count}",
  "import.failed": "失敗 {count}",
  "import.itemFailed": "{path}：{message}",
  "import.failedFallback": "読み込みに失敗しました",
  "import.filesTitle": "漫画アーカイブを選択（zip / cbz、複数可）",
  "import.filesFilter": "漫画アーカイブ",
  "import.folderTitle": "漫画フォルダーを選択（1 フォルダー = 1 冊、複数可）",
  "import.pickerUnavailable":
    "ファイル選択を利用できません。ドラッグで読み込んでください",
  "import.folderPickerUnavailable":
    "フォルダー選択を利用できません。ドラッグで読み込んでください",
  "import.dropTitle": "ドロップして読み込む",
  "import.dropHint":
    "zip / cbz アーカイブとフォルダーに対応、複数まとめてドロップできます",
};

const ko: LibraryMessages = {
  "library.summary": "전체 {total}권 · 읽는 중 {reading} · 오늘 {today}페이지",
  "library.searchPlaceholder": "제목, 시리즈 검색… (Ctrl+K)",
  "library.searchAria": "제목 검색",
  "library.sourceFilterAria": "출처 필터",
  "library.groupAria": "시리즈 표시",
  "library.groupSeries": "시리즈별",
  "library.groupSeriesTitle": "같은 시리즈는 대표 카드만 표시",
  "library.flat": "펼치기",
  "library.flatTitle": "각 화를 개별 카드로 표시",
  "library.addBooks": "책 추가",
  "library.addBooksTitle": "가져올 압축 파일(zip / cbz) 선택",
  "library.addFolder": "폴더 추가",
  "library.addFolderTitle": "폴더 선택(폴더 내용 = 책 한 권)",
  "library.onlineRead": "온라인 읽기",
  "library.onlineReadTitleOn":
    "링크 또는 페어링에서 온라인 만화 가져오기",
  "library.onlineReadTitleOff":
    "먼저 설정에서 실험적 온라인 읽기를 켜세요",
  "library.manage": "관리",
  "library.done": "완료",
  "library.manageTitle":
    "여러 권을 선택해 일괄 제거하거나 삭제할 수 있습니다",
  "library.countGroups": "{count} 시리즈",
  "library.countBooks": "{count}권",
  "library.loadMore": "{count}권 더 불러오기",
  "library.loadingAria": "책장 불러오는 중",
  "library.loadFailed": "서재를 불러오지 못했습니다: {error}",
  "library.emptySearch": "검색 결과가 없습니다. 다른 검색어를 입력해 보세요",
  "library.emptyFilter":
    "이 출처 필터에 책이 없습니다. “전체”로 전환해 보세요",
  "library.emptyLibrary":
    "책장이 비어 있습니다. cbz/zip 또는 폴더를 끌어다 놓거나 “책 추가”를 누르세요",
  "library.dragHint":
    "zip / cbz 압축 파일이나 폴더를 창으로 끌어다 놓아 가져올 수도 있습니다",
  "library.cardHint":
    "표지를 클릭하면 상세 정보, 더블 클릭 또는 Shift+Enter로 읽기 시작, 표지를 마우스 오른쪽 버튼으로 클릭하면 기록을 제거하거나 원본을 삭제할 수 있습니다.",
  "library.selected": "선택됨",
  "library.bulkAria": "일괄 작업",
  "library.exitSelectAria": "선택 해제",
  "library.removeRecords": "기록 제거",
  "library.deleteMixed": "삭제 / 완전 제거…",
  "library.deleteOnline": "완전 제거…",
  "library.deleteLocal": "원본 파일 삭제…",
  "library.removed":
    "{count}권을 제거했습니다. 원본 파일은 유지되며 다시 가져오면 이어서 읽을 수 있습니다",
  "library.deletedOnlineOnly":
    "온라인 책 {count}권을 완전히 제거했습니다(원격 소스는 삭제되지 않음)",
  "library.deletedMixed":
    "원본 파일 {files}개를 삭제하고 온라인 책 {count}권을 완전히 제거했습니다(원격 소스 유지). 모든 기록이 정리되었습니다",
  "library.deletedLocal":
    "원본 파일 {files}개를 삭제하고 모든 기록을 정리했습니다",
  "library.deletedNone": "삭제된 원본 파일이 없습니다",
  "library.enableOnlineFirst":
    "먼저 설정에서 실험적 “온라인 읽기”를 켜세요",
  "card.readPages": "{current} / {total}페이지 읽음",
  "card.notStarted": "{total}페이지 · 시작 전",
  "card.ariaStatusRead": "{current}/{total}페이지 읽음",
  "card.ariaStatusNotStarted": "{total}페이지, 시작 전",
  "card.ariaSeries": ", 시리즈 {count}화",
  "card.ariaOnline": ", 온라인",
  "card.ariaHintSelect": "스페이스로 선택 전환",
  "card.ariaHintOpen": "Enter로 상세 정보, Shift+Enter로 읽기",
  "card.ariaLabel": "{title}. {status}{series}{online}{missing}. {hint}",
  "card.titleSelect": "{title} (클릭하여 선택)",
  "card.titleOpen": "{title} (클릭: 상세 정보, 더블 클릭: 읽기)",
  "card.seriesBadge": "시리즈 · {count}화",
  "card.progress": "{percent}%",
  "card.missing": "파일 위치가 변경됨",
  "card.ariaMissing": "파일 위치가 변경되었습니다. 위치를 다시 지정해야 합니다",
  "relocate.description":
    "원본 파일이 이동되었거나 이름이 바뀌었습니다. 위치를 다시 지정하면 읽기 진행률, 웹툰 위치, 통계가 그대로 유지됩니다.",
  "relocate.currentPath": "이전 위치: {name}",
  "relocate.choose": "파일 위치 다시 지정",
  "relocate.remove": "라이브러리에서 제거",
  "relocate.success":
    "“{title}” 위치를 다시 지정했습니다. 읽기 진행률이 유지되었습니다",
  "book.missingNotice":
    "원본 파일이 이동되었거나 이름이 바뀌었습니다. 위치를 다시 지정하면 읽기 진행률과 통계가 유지됩니다.",
  "openWith.failed":
    "“{name}”을(를) 열 수 없습니다. 파일이 없거나 지원되지 않는 형식입니다",
  "openWith.safeMode":
    "안전 모드가 켜져 있습니다. 파일이 라이브러리에 추가되었습니다. 안전 모드를 끈 후 읽어 주세요.",
  "menu.aria": "책 작업",
  "menu.details": "상세 보기",
  "menu.continue": "이어 읽기",
  "menu.remove": "기록 제거",
  "menu.deleteLocal": "원본 파일 삭제…",
  "menu.deleteOnline": "완전 제거…",
  "confirm.titleMixed":
    "로컬 원본 삭제 / 온라인 책 완전 제거(책 {count}권 · 총 {pages}페이지)?",
  "confirm.titleOnline":
    "완전 제거(책 {count}권 · 총 {pages}페이지)?",
  "confirm.titleLocal":
    "원본 파일 삭제(책 {count}권 · 총 {pages}페이지)?",
  "confirm.messageMixed":
    "로컬 책 {local}권의 원본 파일을 디스크에서 영구 삭제하고 온라인 책 {online}권을 완전히 제거합니다. 온라인 책의 원격 소스는 삭제되지 않습니다. 이 책들의 진행률, 썸네일, 파생 캐시 등 모든 로컬 기록이 정리됩니다. 이 작업은 되돌릴 수 없습니다.",
  "confirm.messageOnline":
    "다음 온라인 책을 서재에서 제거하고 진행률, 썸네일, 파생 캐시 등 모든 로컬 기록을 정리합니다. 원격 소스는 삭제되지 않습니다. 이 작업은 되돌릴 수 없습니다.",
  "confirm.messageLocal":
    "다음 원본 파일/폴더를 디스크에서 영구 삭제하고 이 책들의 진행률, 썸네일, 파생 캐시 등 모든 로컬 기록을 정리합니다. 이 작업은 되돌릴 수 없습니다.",
  "confirm.confirmMixed": "삭제 / 완전 제거",
  "confirm.confirmOnline": "완전 제거",
  "confirm.confirmLocal": "영구 삭제",
  "confirm.pathLine": "[{source}] {name} ({pages}페이지)",
  "import.progress": "가져오는 중 {done} / {total}",
  "import.complete": "가져오기 완료: {summary}",
  "import.added": "추가 {count}",
  "import.restored": "복원 {count}(진행률 유지)",
  "import.inLibrary": "서재에 있음 {count}",
  "import.failed": "실패 {count}",
  "import.itemFailed": "{path}: {message}",
  "import.failedFallback": "가져오기 실패",
  "import.filesTitle": "만화 압축 파일 선택(zip / cbz, 여러 개 가능)",
  "import.filesFilter": "만화 압축 파일",
  "import.folderTitle":
    "만화 폴더 선택(폴더 하나 = 책 한 권, 여러 개 가능)",
  "import.pickerUnavailable":
    "파일 선택기를 사용할 수 없습니다. 파일을 끌어다 놓으세요",
  "import.folderPickerUnavailable":
    "폴더 선택기를 사용할 수 없습니다. 폴더를 끌어다 놓으세요",
  "import.dropTitle": "놓으면 가져옵니다",
  "import.dropHint":
    "zip / cbz 압축 파일과 폴더를 지원하며 여러 개를 한 번에 놓을 수 있습니다",
};

export const libraryMessages = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  es,
  ja,
  ko,
} as const;
