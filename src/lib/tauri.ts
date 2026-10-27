// Frozen invoke contract — mirrors src-tauri/src/lib.rs JSON shapes (camelCase).
import { invoke } from "@tauri-apps/api/core";

export interface BookInfo {
  id: string;
  title: string;
  path: string;
  pageCount: number;
  currentPage: number;
  updatedAt: string;
  /** 本地源路径已不存在（NotFound）；在线书恒为 false，需重新指定位置。 */
  missing: boolean;
  /** 条漫滚动偏移百分比（0..1）；-1 = 无条漫阅读记录。 */
  scrollPct: number;
  /** local | generic_manga | anime（预留）。 */
  sourceType: string;
  /** 来源格式：image（图片目录 / ZIP / CBZ）| pdf（PDF 文档，仅识别与导入，尚不可阅读）。 */
  format: string;
  /** 条漫是否可用：本地 true；在线取决于清单尺寸。 */
  webtoonReady: boolean;
  /** 同一系列的标识；用于下一话解析。 */
  seriesId?: string | null;
  /** 系列标题。 */
  seriesTitle?: string | null;
  /** 章节序号。 */
  chapterIndex?: number | null;
  /** 下一话来源 URL；无则 null/缺省。 */
  nextUrl?: string | null;
}

/** 在线图片提纯：被剔除的页面（保留原顺序，恢复时插回）。 */
export interface FilteredPage {
  url: string;
  width?: number | null;
  height?: number | null;
  reason: string;
  score: number;
  order: number;
  anchor?: {
    channel: string;
    messageId: number;
    photoIndex: number;
    refreshBase?: string | null;
  } | null;
  sha256?: string | null;
}

export interface OnlineFilterStats {
  siteProfiles: number;
  rules: number;
  blockedTotal: number;
  restoredTotal: number;
  lastUpdated?: string | null;
}

export type OnlineFilterRulePattern =
  | { kind: "urlTemplate"; template: string }
  | { kind: "exactUrl"; url: string }
  | { kind: "sha256"; hash: string }
  | { kind: "domClass"; value: string }
  | { kind: "size"; width: number; height: number };

export interface OnlineFilterRule {
  id: string;
  host: string;
  action: "block" | "allow";
  source: "user" | "learned" | "imported";
  pattern: OnlineFilterRulePattern;
  reason: string;
  createdAt: string;
  hits: number;
}

export type TelegramChapterKind = "telegraph" | "photos" | "document";

export interface TelegramDocument {
  url: string;
  filename: string;
  size?: number | null;
}

export interface TelegramChapter {
  id: string;
  title: string;
  url: string;
  messageId: number;
  pageCount?: number | null;
  kind: TelegramChapterKind;
  document?: TelegramDocument | null;
  grouped: boolean;
}

export interface TelegramChannel {
  channel: string;
  title: string;
  chapters: TelegramChapter[];
  before?: number | null;
  hasMore: boolean;
}

export interface PageEntry {
  index: number;
  name: string;
}

/** PDF 字节分块：把本地 PDF 按区间喂给前端 pdf.js。 */
export interface PdfChunk {
  /** 整个 PDF 文件的字节数（始终是真实大小，与请求区间无关）。 */
  total: number;
  /** 本次区间的原始字节（base64，无 data: 前缀）。 */
  data: string;
}

export interface PageImage {
  index: number;
  width: number;
  height: number;
  /** 源图原始尺寸（条漫建议/布局用）。 */
  origWidth: number;
  origHeight: number;
  mime: string;
  dataUrl: string;
}

/** 条漫布局：单页源图尺寸。 */
export interface PageDim {
  index: number;
  width: number;
  height: number;
}

/** 条漫切片目标高度（设备像素），与后端 pipeline::WEBTOON_TILE_H 一致。 */
export const WEBTOON_TILE_H = 2048;

export interface MemoryStats {
  processMb: number;
  cacheBytes: number;
  cacheLimitBytes: number;
  cachedPages: number;
  cachedThumbs: number;
  webtoonBytes: number;
  webtoonTiles: number;
  /** 统一磁盘缓存总占用（render + online 原图）。 */
  diskCacheBytes: number;
  /** 磁盘缓存上限（由 diskCacheBudgetMb 换算）。 */
  diskCacheLimitBytes: number;
  /** 磁盘缓存中渲染结果占用。 */
  renderCacheBytes: number;
  /** 磁盘缓存中在线原图占用。 */
  onlineCacheBytes: number;
}

export interface HeatDay {
  date: string;
  count: number;
}

export interface SeriesProgress {
  bookId: string;
  title: string;
  currentPage: number;
  pageCount: number;
}

export interface Dashboard {
  totalBooks: number;
  reading: number;
  todayPages: number;
  heatmap: HeatDay[];
  series: SeriesProgress[];
}

export interface BookDayPoint {
  bookId: string;
  date: string;
  pages: number;
}

export interface ScanResult {
  added: number;
  books: BookInfo[];
  errors: string[];
}

export interface ImportItemResult {
  path: string;
  /** added=已入库 / restored=恢复(进度保留) / skipped=已在书库中 / failed */
  status: string;
  message: string;
  book: BookInfo | null;
}

export interface ImportResult {
  items: ImportItemResult[];
  added: number;
  restored: number;
  skipped: number;
  failed: number;
}

export interface RemoveResult {
  removed: number;
  deletedFiles: number;
  errors: string[];
}

/**
 * 单实例直开队列中的一条请求（首次 CLI 启动 / 二次双击文件入队）。
 * `paths` 只用于展示 basename，不得原样落盘或写日志。
 */
export interface OpenWithRequest {
  paths: string[];
  /** 本次请求批量导入的成功 / 失败数量。 */
  imported: number;
  failed: number;
  /** 可立即打开的本地书；失败或被跳过时为 null。 */
  book: BookInfo | null;
  /** 后端失败代码（非中文原文）；成功时为 null。 */
  errorCode: string | null;
}

/** `clear_temp_cache` 结果：释放的字节数与删除的文件数。 */
export interface ClearCacheResult {
  bytesFreed: number;
  files: number;
}

export interface Settings {
  theme: string;
  /** 内存缓存预算（MB）。 */
  cacheBudgetMb: number;
  /** 统一磁盘缓存预算（MB，render + online 原图）。 */
  diskCacheBudgetMb: number;
  libraryDir: string;
  /** 实验性功能：条漫模式。默认关闭，关闭时版式只在单页/双页间切换。 */
  experimentalWebtoon: boolean;
  /** 实验性功能：URL 在线直读（JSON 清单 / 单页 HTML 图集）。默认关闭。 */
  experimentalOnline: boolean;
  /** 在线源 HTTP 代理（空=直连；http/https/socks5）。 */
  onlineProxy: string;
  /** 单本在线书页面下载并发（1-8）。 */
  onlineConcurrency: number;
  /** 手动请求头：JSON 对象或单行 Cookie；仅用于自建/授权源，明文存储。 */
  onlineHeaders: string;
}

/** 在线源连通性探测结果（只解析清单，不写库）。 */
export interface OnlineProbe {
  ok: boolean;
  title: string;
  pageCount: number;
  elapsedMs: number;
  message: string;
}

/** 内嵌浏览器下载项（后端扫描应用下载目录）。 */
export interface BrowserDownload {
  path: string;
  name: string;
  size: number;
  modified: string;
  imported: boolean;
}

/** `browser-download` 事件载荷。 */
export interface BrowserDownloadEvent {
  path: string;
  name: string;
  imported: boolean;
  bookId: string | null;
}

/** 外部浏览器配对桥接状态（与后端 HandoffStatus 一致）。 */
export interface HandoffStatus {
  active: boolean;
  port: number;
  pairingToken: string;
  callbackUrl: string;
  receivedChapters: number;
  allowSessionHeaders: boolean;
  script: string;
}

// ---------- 实验性功能镜像：同步读取 + 变更事件 ----------
// 设置的权威副本在 SQLite；这里维护 localStorage 镜像，让无法等待
// 异步 getSettings 的组件（阅读器/导航）能同步读取开关状态。

const EXP_WT_KEY = "mr-exp-wt";
const EXP_ONLINE_KEY = "mr-exp-online";

function applySettingsMirror(s: Settings) {
  try {
    localStorage.setItem(EXP_WT_KEY, s.experimentalWebtoon ? "1" : "0");
    localStorage.setItem(EXP_ONLINE_KEY, s.experimentalOnline ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

/** 同步读取实验性条漫模式开关（镜像）。 */
export function isWebtoonEnabled(): boolean {
  try {
    return localStorage.getItem(EXP_WT_KEY) === "1";
  } catch {
    return false;
  }
}

/** 同步读取在线直读开关（镜像）。 */
export function isOnlineEnabled(): boolean {
  try {
    return localStorage.getItem(EXP_ONLINE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 订阅设置变更（setSettings 成功后广播；回调里用 is*Enabled() 取最新值）。 */
export function onExperimentalChange(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener("mr-settings-changed", h);
  return () => window.removeEventListener("mr-settings-changed", h);
}

export const api = {
  // Tauri 2 参数键为驼峰(与 Rust snake_case 参数一一对应);单词参数两写等价。
  scanLibrary: (path: string) =>
    invoke<ScanResult>("scan_library", { path }),  // 导入书籍（文件/文件夹路径数组）：同路径去重（已在书库中），软删过的恢复并续读。
  importBooks: (paths: string[]) =>
    invoke<ImportResult>("import_books", { paths }),
  // 本地源路径丢失后的无损重定位：新 id = sha256(newPath)，进度/scrollPct/阅读日志由后端迁移。
  relocateBook: (bookId: string, newPath: string) =>
    invoke<BookInfo>("relocate_book", { bookId, newPath }),
  // 单实例直开队列：FIFO 取一条 pending 请求（无则 null）；前端需循环取到 null。
  takePendingOpen: () => invoke<OpenWithRequest | null>("take_pending_open"),
  // 移除（deleteSourceFiles=false，可逆）或删除源文件（true，不可逆+级联清理）。
  removeBooks: (ids: string[], deleteSourceFiles: boolean) =>
    invoke<RemoveResult>("remove_books", { ids, deleteSourceFiles }),
  listBooks: (query?: string) =>
    invoke<BookInfo[]>("list_books", { query: query ?? null }),
  getBook: (bookId: string) =>
    invoke<BookInfo>("get_book", { bookId }),
  listEntries: (bookId: string) =>
    invoke<PageEntry[]>("list_entries", { bookId }),
  getPage: (bookId: string, index: number, maxWidth?: number, maxHeight?: number) =>
    invoke<PageImage>("get_page", {
      bookId,
      index,
      maxWidth: maxWidth ?? null,
      maxHeight: maxHeight ?? null,
    }),
  getThumbnail: (bookId: string, maxSize?: number) =>
    invoke<PageImage>("get_thumbnail", { bookId, maxSize: maxSize ?? null }),
  // PDF（PDF-2）：按字节区间读取本地 PDF，喂给前端 pdf.js 解析。
  // length 会被后端钳制到 4 MiB；offset 越界返回空数据（视为 EOF）。
  getPdfChunk: (bookId: string, offset: number, length: number) =>
    invoke<PdfChunk>("get_pdf_chunk", { bookId, offset, length }),
  // 回写真实页数（PDF 导入时页数留 0）；只更新 books.page_count。
  setBookPageCount: (bookId: string, pageCount: number) =>
    invoke<void>("set_book_page_count", { bookId, pageCount }),
  // 写回前端渲染的 PDF 封面（裸 base64，JPEG/PNG）。
  putPdfThumbnail: (bookId: string, dataBase64: string) =>
    invoke<void>("put_pdf_thumbnail", { bookId, dataBase64 }),
  // 清空临时磁盘缓存（render + online 原图），返回释放体积与文件数。
  clearTempCache: () => invoke<ClearCacheResult>("clear_temp_cache"),
  getMemoryStats: () => invoke<MemoryStats>("get_memory_stats"),
  getDashboard: () => invoke<Dashboard>("get_dashboard"),
  // 逐日阅读页数：bookId=null 全局；Some(id) 只看该书。days 1..365。
  getReadingLog: (bookId: string | null, days: number) =>
    invoke<HeatDay[]>("get_reading_log", { bookId, days }),
  // 逐日逐书阅读页数（趋势堆叠图）。
  getReadingByBook: (days: number) =>
    invoke<BookDayPoint[]>("get_reading_by_book", { days }),
  setProgress: (bookId: string, page: number, scrollPct?: number) =>
    invoke<void>("set_progress", { bookId, page, scrollPct: scrollPct ?? null }),
  clearPages: () => invoke<void>("clear_pages"),
  // 条漫：整话逐页源尺寸（header 解析）+ 单切片获取。
  getWebtoonLayout: (bookId: string) =>
    invoke<PageDim[]>("get_webtoon_layout", { bookId }),
  getWebtoonTile: (bookId: string, index: number, tile: number, maxWidth: number) =>
    invoke<PageImage>("get_webtoon_tile", { bookId, index, tile, maxWidth }),
  getSettings: () =>
    invoke<Settings>("get_settings").then((s) => {
      applySettingsMirror(s);
      return s;
    }),
  setSettings: (settings: Settings) =>
    invoke<void>("set_settings", { settings }).then(() => {
      applySettingsMirror(settings);
      window.dispatchEvent(new CustomEvent("mr-settings-changed"));
    }),  // 解析 JSON 清单/单页 HTML 图集并入库或恢复；不改变已有书进度。
  resolveOnlineUrl: (url: string) =>
    invoke<BookInfo>("resolve_online_url", { url }),
  // 系统代理探测（只填入表单，不落库）。
  detectSystemProxy: () => invoke<string | null>("detect_system_proxy"),
  // 外部系统浏览器配对桥接：长驻监听，结果经 online-handoff-imported 回传。
  startBrowserHandoff: (allowSessionHeaders: boolean) =>
    invoke<HandoffStatus>("start_browser_handoff", { allowSessionHeaders }),
  stopBrowserHandoff: () => invoke<void>("stop_browser_handoff"),
  getBrowserHandoffStatus: () =>
    invoke<HandoffStatus>("get_browser_handoff_status"),
  // Telegram 公开频道/消息/Telegraph 直读（免登录，仅公开预览页）。
  resolveTelegramChannel: (url: string, before?: number | null) =>
    invoke<TelegramChannel>("resolve_telegram_channel", {
      url,
      before: before ?? null,
    }),
  downloadTelegramDocument: (url: string, filename: string) =>
    invoke<BookInfo>("download_telegram_document", { url, filename }),
  // 自学习提纯：统计、规则库、当前书被过滤页。
  getOnlineFilterStatus: () =>
    invoke<OnlineFilterStats>("get_online_filter_status"),
  listOnlineFilterRules: () =>
    invoke<OnlineFilterRule[]>("list_online_filter_rules"),
  exportOnlineFilterRules: () =>
    invoke<string>("export_online_filter_rules"),
  importOnlineFilterRules: (json: string) =>
    invoke<number>("import_online_filter_rules", { json }),
  resetOnlineFilterRules: () => invoke<void>("reset_online_filter_rules"),
  getFilteredPages: (bookId: string) =>
    invoke<FilteredPage[]>("get_filtered_pages", { bookId }),
  getFilteredPreview: (bookId: string, filteredIndex: number) =>
    invoke<PageImage>("get_filtered_preview", { bookId, filteredIndex }),
  markOnlinePageNonContent: (bookId: string, pageIndex: number) =>
    invoke<BookInfo>("mark_online_page_non_content", { bookId, pageIndex }),
  restoreOnlineFilteredPage: (bookId: string, filteredIndex: number) =>
    invoke<BookInfo>("restore_online_filtered_page", {
      bookId,
      filteredIndex,
    }),
  getSeriesBooks: (seriesId: string) =>
    invoke<BookInfo[]>("get_series_books", { seriesId }),
  getNextBook: (bookId: string) =>
    invoke<BookInfo | null>("get_next_book", { bookId }),
  // 会话级在线请求头（仅内存，不落库）。
  getSessionOnlineHeaders: () =>
    invoke<string | null>("get_session_online_headers"),
  setSessionOnlineHeaders: (value: string) =>
    invoke<void>("set_session_online_headers", { headers: value }),
  clearSessionOnlineHeaders: () =>
    invoke<void>("clear_session_online_headers"),
  // 内嵌浏览器（独立 WebviewWindow）：启动/导航、下载扫描与导入。
  openBrowserWindow: (url: string) =>
    invoke<void>("open_browser_window", { url }),
  navigateBrowser: (url: string) =>
    invoke<void>("navigate_browser", { url }),
  listBrowserDownloads: () =>
    invoke<BrowserDownload[]>("list_browser_downloads"),
  importBrowserDownload: (path: string) =>
    invoke<string | null>("import_browser_download", { path }),
};
