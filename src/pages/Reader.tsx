import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  FileWarning,
  Filter,
  Info,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  type BookInfo,
  type FilteredPage,
  type PageEntry,
} from "../lib/tauri";
import { cn } from "@/lib/utils";
import PixelPet from "../components/PixelPet";
import ErrorState from "../components/ErrorState";
import { Toaster, toast } from "../components/Toast";
import { translate, useI18n, type MessageKey } from "../i18n";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Slider } from "../components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  isSoloCover,
  isWideSolo,
  spreadFor,
  stepPage,
  type Direction,
  type PageDims,
  type PageMode,
  type SpreadOptions,
} from "../components/Reader/spread";
import { READER_SHORTCUTS } from "../components/Reader/shortcuts";
import WebtoonView, { type WebtoonHandle } from "../components/Reader/Webtoon";
import ReaderHudTop from "../components/Reader/ReaderHudTop";
import ReaderDock from "../components/Reader/ReaderDock";
import FilteredPagesSheet from "../components/Reader/FilteredPagesSheet";
import ProgressScrubber, {
  type ScrubPreview,
} from "../components/Reader/ProgressScrubber";
import TabSwitcher from "../components/Reader/TabSwitcher";
import { useWorkspace } from "../features/workspace/WorkspaceContext";
import { useSafeMode } from "../features/safeMode/SafeModeContext";
import { useGlobalShortcuts } from "../features/shortcuts/useGlobalShortcuts";
import { localizeBackendError, localizeStableErrorCode } from "../features/errors/localize";
import {
  computePdfTarget,
  isPdfRenderCancelled,
  mapPdfError,
  openPdfDocument,
  releasePdfDocument,
  renderPdfPage,
  type PdfDocumentHandle,
  type PdfErrorCode,
  type PdfFitMode,
  type PdfOutlineItem,
  type PdfRenderHandle,
} from "../features/pdf";
import {
  recordBreadcrumb,
  updateRuntimeContext,
} from "../features/resilience";
import "../components/Reader.css";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_EDGE = 1920;
const HIDE_MS = 1500;
const SAVE_DEBOUNCE_MS = 500;

const WT_WIDTH_KEY = "mr-reader-wt-width";
const WT_MIN_WIDTH = 50;
const WT_MAX_WIDTH = 150;
const WT_DEFAULT_WIDTH = 100;

/** PDF 适配模式（按书记忆）的 localStorage 键前缀。 */
const PDF_FIT_KEY_PREFIX = "mr-pdf-fit-";
/** PDF 画布单边上限（设备像素），与 features/pdf 的常量一致。 */
const PDF_MAX_EDGE = 4096;
/**
 * 阅读画布留给页面的内边距（Reader.css 的 .reader-cell：上下 60/96、左右 10）。
 * 只用于估算渲染分辨率，不参与布局。
 */
const PDF_CELL_PADDING_X = 20;
const PDF_CELL_PADDING_Y = 156;


const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const clampWtWidth = (v: number) =>
  Math.max(WT_MIN_WIDTH, Math.min(WT_MAX_WIDTH, Math.round(v)));
const sliderNumber = (v: number | readonly number[]): number =>
  Array.isArray(v) ? Number(v[0]) : Number(v);

/** 条漫阅读宽度（视口宽度的百分比）；持久化在 localStorage。 */
function loadWtWidth(): number {
  try {
    const raw = localStorage.getItem(WT_WIDTH_KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? clampWtWidth(v) : WT_DEFAULT_WIDTH;
  } catch {
    return WT_DEFAULT_WIDTH;
  }
}

/** PDF 适配模式（按书记忆）：整页 / 整宽。 */
function loadPdfFit(bookId: string): PdfFitMode {
  try {
    const raw = localStorage.getItem(`${PDF_FIT_KEY_PREFIX}${bookId}`);
    return raw === "width" ? "width" : "page";
  } catch {
    return "page";
  }
}

/** 记住 PDF 适配模式（只写枚举值，绝不写路径 / 书名）。 */
function savePdfFit(bookId: string, fit: PdfFitMode): void {
  try {
    localStorage.setItem(`${PDF_FIT_KEY_PREFIX}${bookId}`, fit);
  } catch {
    /* 忽略 */
  }
}

/** 画布里真正留给页面的尺寸（扣掉 .reader-cell 的内边距）。 */
function pdfContentBox(vw: number, vh: number): { width: number; height: number } {
  return {
    width: Math.max(1, vw - PDF_CELL_PADDING_X),
    height: Math.max(1, vh - PDF_CELL_PADDING_Y),
  };
}

/**
 * 把 PDF 书签树拍平成目录条目。
 *
 * 页码去重后按页序排列；标题为空时用调用方给的本地化兜底文案。
 */
function flattenPdfOutline(
  items: PdfOutlineItem[],
  fallback: (index: number) => string,
): PageEntry[] {
  const out: PageEntry[] = [];
  const seen = new Set<number>();
  const walk = (nodes: PdfOutlineItem[]) => {
    for (const node of nodes) {
      const index = node.pageIndex;
      if (index !== null && index >= 0 && !seen.has(index)) {
        seen.add(index);
        const title = node.title.trim();
        out.push({ index, name: title || fallback(index + 1) });
      }
      if (node.children.length) walk(node.children);
    }
  };
  walk(items);
  return out.sort((a, b) => a.index - b.index);
}

/** 后端错误详情原样保留，只本地化前缀。 */
function showFailure(prefixKey: MessageKey, detail: unknown): void {
  const prefix = translate(prefixKey);
  toast(
    typeof detail === "string" && detail
      ? translate("reader.error.detail", {
          prefix,
          detail: localizeBackendError(detail),
        })
      : prefix,
  );
}

/**
 * PDF 失败提示：只显示本地化文案。
 *
 * PDF.js 的异常是英文原文，后端错误也可能带中文；两者都先归一成稳定码，
 * 再由六语字典渲染，绝不把原始异常直出到界面。
 */
function showPdfFailure(code: PdfErrorCode): void {
  toast(
    translate("reader.error.detail", {
      prefix: translate("reader.error.loadPage"),
      detail: localizeStableErrorCode(code),
    }),
  );
}

interface ReaderPrefs {
  mode: PageMode;
  dir: Direction;
  /**
   * 双页模式「首页封面单独成页」：null = 未显式设置，跟随方向默认
   * （RTL 封面单页=日漫惯例，LTR 从 [0,1] 起对）。
   */
  cover: boolean | null;
}

function loadPrefs(): ReaderPrefs {
  try {
    const mode =
      localStorage.getItem("mr-reader-mode") === "double" ? "double" : "single";
    const dir = localStorage.getItem("mr-reader-dir") === "ltr" ? "ltr" : "rtl";
    const rawCover = localStorage.getItem("mr-reader-cover");
    const cover = rawCover === "1" ? true : rawCover === "0" ? false : null;
    return { mode: mode as PageMode, dir: dir as Direction, cover };
  } catch {
    return { mode: "single", dir: "rtl", cover: null };
  }
}

/** 后端 updated_at 为本地时间字符串；失败时回退 0，让快照优先。 */
function progressUpdatedAt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(
    value.includes("T") ? value : value.replace(" ", "T"),
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 真阅读器（暗色沉浸面）：全屏近黑画布，单/双页 + 日式 RTL，
 * Ctrl+滚轮/双指缩放 + 拖拽 + 双击重置，玻璃控制条 + 目录弹层，
 * 预加载仅 ±2 页，打开回上次页 + 防抖存进度。
 * 页码：内部 0-based（与 get_page/list_entries 对齐），展示 +1。
 */
export default function Reader() {
  const { id = "" } = useParams();
  const bookId = decodeURIComponent(id);
  const nav = useNavigate();
  const ws = useWorkspace();
  const { t } = useI18n();
  const { active: safeMode } = useSafeMode();
  // 本次挂载的会话快照（页签切回时恢复页码/版式/方向/条漫位置）；只在首次渲染取一次。
  const initialSnapRef = useRef(ws.getSnapshot(bookId));
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);

  const [book, setBook] = useState<BookInfo | null>(null);
  const [bookState, setBookState] = useState<
    "loading" | "ready" | "missing" | "blocked"
  >("loading");
  const [page, setPage] = useState(0);
  const [imgs, setImgs] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [prefs, setPrefs] = useState(loadPrefs);
  // 双页模式逐页原始尺寸（横向跨页大图独占判定）；按需加载，失败回落空表
  // （退回朴素配对，仅损失宽页独占，不影响阅读）。
  const [pageDims, setPageDims] = useState<PageDims | null>(null);
  // 按书记忆的版式（webtoon/single/double；null = 跟随全局偏好）。
  const [bookMode, setBookMode] = useState<PageMode | null>(null);
  const [wtSuggest, setWtSuggest] = useState(false);
  const [wtProgress, setWtProgress] = useState({ pct: 0, page: 0 });
  // 本次 Reader 生命周期内冻结的条漫恢复位置（-1 = 用进入页码）。
  const [restorePct, setRestorePct] = useState(-1);
  // 条漫进度的 ref 镜像：setMode 切走时需要读最新页码而无依赖抖动。
  const wtProgressRef = useRef({ pct: 0, page: 0 });
  // 是否已拿到可信的条漫位置（快照/后端/Webtoon 首帧上报）；false 时不写占位快照。
  const wtKnownRef = useRef(false);
  const wtHandle = useRef<WebtoonHandle | null>(null);
  const wtSuggestedRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [uiVisible, setUiVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [entries, setEntries] = useState<PageEntry[] | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sizeTick, setSizeTick] = useState(0);
  const [nextBusy, setNextBusy] = useState(false);
  // 「更多」Popover 与进度拖拽预览（预览只读已缓存图片，不发请求）。
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrub, setScrub] = useState<ScrubPreview | null>(null);
  const [tocShown, setTocShown] = useState(200);
  const [filtered, setFiltered] = useState<FilteredPage[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterMarkBusy, setFilterMarkBusy] = useState(false);
  const [filterRestoreBusy, setFilterRestoreBusy] = useState<number | null>(null);

  const [tocQuery, setTocQuery] = useState("");
  const [jumpPage, setJumpPage] = useState("");

  // ---------- PDF（PDF-2） ----------
  /** PDF 文档状态：解析中 / 可读 / 出错。 */
  const [pdfState, setPdfState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  /** PDF 打开失败的稳定错误码（界面只显示本地化文案）。 */
  const [pdfError, setPdfError] = useState<PdfErrorCode | null>(null);
  /** PDF 真实页数（pdf.js 解析结果；入库时页数留 0）。 */
  const [pdfPageCount, setPdfPageCount] = useState(0);
  /** PDF 适配模式（按书记忆）。 */
  const [pdfFit, setPdfFit] = useState<PdfFitMode>(() => loadPdfFit(bookId));

  // 条漫阅读宽度（% 视口宽，50..150，全局记忆）。
  const [wtWidth, setWtWidth] = useState(loadWtWidth);
  const applyWtWidth = useCallback((v: number) => {
    setWtWidth(clampWtWidth(v));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(WT_WIDTH_KEY, String(wtWidth));
    } catch {
      /* 忽略 */
    }
  }, [wtWidth]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const hudHoverRef = useRef(false);
  const overlayRef = useRef(false);
  const requestedRef = useRef<Set<string>>(new Set());
  // 每页当前缓存图片对应的请求尺寸 key（`${idx}@${w}x${h}`），用于
  // 缩放/resize 后静默升级清晰度而不闪烁。
  const imgKeyRef = useRef<Record<number, string>>({});
  const uiLockRef = useRef(false);
  // ---------- PDF 运行时句柄 ----------
  /** 已打开的 PDF 文档（页数、书签、渲染入口）。 */
  const pdfDocRef = useRef<PdfDocumentHandle | null>(null);
  /** 参考页尺寸（scale=1，PDF 点）：用来推导渲染分辨率。 */
  const pdfBoxRef = useRef<{ width: number; height: number } | null>(null);
  /** 在途的 PDF 渲染任务（按页下标）：翻页过快时取代旧任务。 */
  const pdfTasksRef = useRef<Map<number, PdfRenderHandle>>(new Map());
  // 生效版式：按书记忆优先，否则全局偏好；仅本书不支持条漫时回退到分页。
  const rawMode: PageMode = bookMode ?? prefs.mode;
  /** PDF 文档只有单页版式：双页 / 条漫一律不可用。 */
  const isPdfBook = book?.format === "pdf";
  const webtoonAllowed = book?.webtoonReady !== false && !isPdfBook;
  const doubleAllowed = !isPdfBook;
  /** 有效页数：PDF 以 pdf.js 解析出的真实页数为准（入库时页数留 0）。 */
  const n = isPdfBook ? pdfPageCount : (book?.pageCount ?? 0);
  const mode: PageMode = isPdfBook
    ? "single"
    : safeMode
      ? "single"
      : !webtoonAllowed && rawMode === "webtoon"
        ? prefs.mode
        : rawMode;
  const trackRef = useRef({
    book: null as BookInfo | null,
    page: 0,
    mode: "single" as PageMode,
    dir: "rtl" as Direction,
    zoom: 1,
    sizeTick: 0,
    isPdf: false,
    pageCount: 0,
    pdfFit: "page" as PdfFitMode,
  });
  trackRef.current = {
    book,
    page,
    mode,
    dir: prefs.dir,
    zoom,
    sizeTick,
    isPdf: isPdfBook,
    pageCount: n,
    pdfFit,
  };

  const currentFilterIndex = mode === "webtoon" ? wtProgress.page : page;
  // 双页配对选项：封面偏移（显式设置优先，缺省 RTL 封面单页）+ 宽页独占。
  const coverOffset = prefs.cover ?? prefs.dir === "rtl";
  const spreadOptions: SpreadOptions = useMemo(
    () => ({ dims: mode === "double" ? pageDims : null, coverOffset }),
    [mode, pageDims, coverOffset],
  );
  const spreadOptsRef = useRef<SpreadOptions>(spreadOptions);
  spreadOptsRef.current = spreadOptions;
  const spread = spreadFor(page, n, mode, prefs.dir, spreadOptions);
  const solo = isSoloCover(spread, mode, prefs.dir, spreadOptions);
  const wideSolo = isWideSolo(spread, mode, pageDims);
  const canPrev =
    n > 0 && stepPage(page, n, mode, prefs.dir, -1, spreadOptions) !== page;
  const canNext =
    n > 0 && stepPage(page, n, mode, prefs.dir, 1, spreadOptions) !== page;
  const atLastPage =
    bookState === "ready" &&
    book !== null &&
    n > 0 &&
    book.sourceType !== "local" &&
    (mode === "webtoon"
      ? wtProgress.pct >= 0.97
      : page >= n - 1 || spread.includes(n - 1));

  // 「下一话」只在确实存在下一话时出现：已入库的下一话（get_next_book）
  // 或尚未入库的下一话链接（book.nextUrl）。探针按 bookId 缓存，避免每次翻页重查。
  const [nextProbe, setNextProbe] = useState<{ id: string; book: BookInfo | null }>({
    id: "",
    book: null,
  });
  const nextProbeRef = useRef("");
  useEffect(() => {
    const id = book?.id ?? "";
    if (!id || book?.sourceType === "local" || !atLastPage) {
      nextProbeRef.current = "";
      setNextProbe((prev) => (prev.id === "" && prev.book === null ? prev : { id: "", book: null }));
      return;
    }
    if (nextProbeRef.current === id) return;
    nextProbeRef.current = id;
    void api
      .getNextBook(id)
      .then((next) => setNextProbe({ id, book: next }))
      .catch(() => setNextProbe({ id, book: null }));
  }, [book?.id, book?.sourceType, atLastPage]);
  const nextBook = nextProbe.id === (book?.id ?? "") ? nextProbe.book : null;
  const showNextChapter = atLastPage && (nextBook !== null || !!book?.nextUrl);
  const nextTitle = nextBook?.title ?? t("reader.next.pending");

  const goNextChapter = useCallback(async () => {
    const current = trackRef.current.book;
    if (!current || nextBusy) return;
    setNextBusy(true);
    try {
      const knownNext =
        nextBook && nextProbe.id === current.id ? nextBook : null;
      if (knownNext) {
        ws.replaceTab(current.id, knownNext.id);
        nav(`/reader/${encodeURIComponent(knownNext.id)}`, { replace: true });
        return;
      }
      if (current.nextUrl) {
        try {
          const resolved = await api.resolveOnlineUrl(current.nextUrl);
          ws.replaceTab(current.id, resolved.id);
          nav(`/reader/${encodeURIComponent(resolved.id)}`, { replace: true });
        } catch (e) {
          showFailure("reader.error.resolveNext", e);
        }
        return;
      }
      // 无已知下一话、也无 nextUrl 时，控制条兜底按钮再探一次。
      try {
        const probed = await api.getNextBook(current.id);
        if (probed) {
          ws.replaceTab(current.id, probed.id);
          nav(`/reader/${encodeURIComponent(probed.id)}`, { replace: true });
        } else {
          toast(t("reader.next.notFound"));
        }
      } catch (e) {
        showFailure("reader.error.probeNext", e);
      }
    } finally {
      setNextBusy(false);
    }
  }, [nav, nextBusy, nextBook, nextProbe.id, t, ws]);

  /* ---------- open book: get_book -> restore currentPage ---------- */
  useEffect(() => {
    let alive = true;
    setBookState("loading");
    setBook(null);
    setImgs({});
    setPending({});
    setFailed({});
    setEntries(null);
    setPage(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setWtSuggest(false);
    wtSuggestedRef.current = false;
    setRestorePct(-1);
    wtProgressRef.current = { pct: 0, page: 0 };
    wtKnownRef.current = false;
    setWtProgress({ pct: 0, page: 0 });
    // PDF 运行时状态：换书时全部复位（旧文档由清理函数释放）。
    setPdfState("idle");
    setPdfError(null);
    setPdfPageCount(0);
    pdfBoxRef.current = null;
    setPdfFit(loadPdfFit(bookId));
    try {
      const saved = localStorage.getItem(`mr-wt-${bookId}`);
      setBookMode(saved === "webtoon" || saved === "single" || saved === "double" ? saved : null);
    } catch {
      setBookMode(null);
    }
    requestedRef.current.clear();

    /**
     * 恢复阅读位置：页码以「内存快照」与「后端 updated_at」的较新者为准，
     * 并按真实页数钳制；PDF 的滚动百分比恒为 -1（只有页码位置）。
     */
    const applyRestore = (b: BookInfo, pageCount: number, isPdf: boolean) => {
      const snap = initialSnapRef.current;
      const snapNewer =
        snap !== null && snap.at >= progressUpdatedAt(b.updatedAt);
      const basePage = snapNewer ? snap.page : b.currentPage;
      const safePage = Math.max(0, Math.min(pageCount - 1, basePage));
      // 页目录跳转：?page=N（1-based）优先于阅读进度，只生效一次。
      const hashQuery = window.location.hash.includes("?")
        ? new URLSearchParams(window.location.hash.split("?")[1])
        : null;
      const requestedPage = hashQuery ? Number(hashQuery.get("page")) : NaN;
      const jumpRequested =
        Number.isInteger(requestedPage) &&
        requestedPage >= 1 &&
        requestedPage <= pageCount;
      const initialPage = jumpRequested ? requestedPage - 1 : safePage;
      if (jumpRequested) {
        window.history.replaceState(null, "", `#/reader/${encodeURIComponent(b.id)}`);
      }
      const basePct = isPdf
        ? -1
        : snapNewer
          ? snap.mode === "webtoon"
            ? snap.scrollPct
            : -1
          : b.scrollPct;
      setPage(initialPage);
      setRestorePct(
        basePct >= 0 ? Math.min(1, Math.max(0, basePct)) : -1,
      );
      if (snap && !isPdf) {
        if (
          snap.mode === "webtoon" ||
          snap.mode === "single" ||
          snap.mode === "double"
        ) {
          setBookMode(snap.mode);
        }
        setPrefs((p) => (p.dir === snap.dir ? p : { ...p, dir: snap.dir }));
      }
      if (basePct >= 0) {
        const pct = Math.min(1, Math.max(0, basePct));
        setWtProgress({ pct, page: initialPage });
        wtProgressRef.current = { pct, page: initialPage };
        wtKnownRef.current = true;
      }
    };

    api
      .getBook(bookId)
      .then(
        (b) => {
          if (!alive) return;
          if (!b) {
            setBookState("missing");
            return;
          }
          setBook(b);
          if (safeMode && b.sourceType !== "local") {
            setBookState("blocked");
            return;
          }
          ws.reportBook(b.id, b.title);
          // 方案 C：记录「最近打开」。只写 last_opened_at —— 不动 updated_at /
          // progress_rev，也不产生任何阅读历史事件。
          void api.markBookOpened(b.id).catch(() => {});
          // PDF（PDF-2）：页数由 pdf.js 解析，入库时留 0 —— 必须先打开文档
          // 才知道真实页数，页码恢复也按真实页数钳制。
          if (b.format === "pdf") {
            setPdfState("loading");
            void openPdfDocument(b.id).then(
              async (handle) => {
                if (!alive) {
                  releasePdfDocument(b.id);
                  return;
                }
                pdfDocRef.current = handle;
                setPdfState("ready");
                setPdfPageCount(handle.numPages);
                // 本地 book 同步真实页数：页码指示 / 进度滑杆 / 恢复位置共用它。
                setBook((prev) =>
                  prev && prev.id === b.id
                    ? { ...prev, pageCount: handle.numPages }
                    : prev,
                );
                // 回写真实页数（best effort；失败不影响阅读）。
                if (b.pageCount !== handle.numPages) {
                  void api
                    .setBookPageCount(b.id, handle.numPages)
                    .catch(() => {});
                }
                // 参考页尺寸（scale=1）：推导渲染分辨率用。
                try {
                  const first = await handle.getPage(0);
                  const viewport = first.getViewport({ scale: 1 });
                  if (alive) {
                    pdfBoxRef.current = {
                      width: viewport.width,
                      height: viewport.height,
                    };
                  }
                } catch {
                  pdfBoxRef.current = null;
                }
                recordBreadcrumb("pdf-open");
                applyRestore(b, handle.numPages, true);
                if (alive) setBookState("ready");
              },
              (e) => {
                if (!alive) return;
                const code = mapPdfError(e);
                setPdfState("error");
                setPdfError(code);
                recordBreadcrumb("pdf-open-failed");
                setBookState("ready");
              },
            );
            return;
          }
          if (b.pageCount <= 0) {
            setBookState("ready");
            return;
          }
          applyRestore(b, b.pageCount, false);
          setBookState("ready");
        },
        (e) => {
          if (!alive) return;
          setBookState("missing");
          showFailure("reader.error.loadBook", e);
        },
      )
      .catch(() => {
        if (alive) setBookState("missing");
      });
    return () => {
      alive = false;
      // PDF：取消在途渲染并释放文档引用（文档本体留在 LRU 里，页签切回不用重解析）。
      for (const task of pdfTasksRef.current.values()) task.cancel();
      pdfTasksRef.current.clear();
      const pdfDoc = pdfDocRef.current;
      pdfDocRef.current = null;
      if (pdfDoc) releasePdfDocument(pdfDoc.bookId);
      // 页签切换/关闭时立即落盘分页进度，避免 500ms 防抖被卸载取消而丢页。
      // 快照在 Reader 卸载时同步写一次，条漫使用 Webtoon 的最新 ref；
      // 尚未拿到可信条漫位置时不写占位 {0,0}。
      const t = trackRef.current;
      if (!t.book) return;
      const tabOpen = ws.isTabOpen(t.book.id);
      const latestWt =
        t.mode === "webtoon" ? wtHandle.current?.getProgress?.() : null;
      const livePct =
        t.mode === "webtoon"
          ? latestWt?.pct ?? wtProgressRef.current.pct
          : -1;
      const livePage =
        t.mode === "webtoon"
          ? latestWt?.page ?? wtProgressRef.current.page
          : t.page;
      // 页签关闭/替换后不要再复活 Workspace 已主动丢弃的快照。
      // 只有拿到可信页数才写位置：PDF 打开失败（加密 / 损坏 / 源文件消失）时
      // pageCount 仍是 0，t.page 还是初始的 0；此时写回会把用户之前
      // 已读到的位置抹掉，所以宁可不写。
      if (
        t.pageCount > 0 &&
        tabOpen &&
        (t.mode !== "webtoon" || wtKnownRef.current)
      ) {
        ws.reportSnapshot(t.book.id, {
          page: livePage,
          scrollPct: livePct,
          mode: t.mode,
          dir: t.dir,
        });
      }
      if (t.pageCount > 0 && t.mode !== "webtoon") {
        void api.setProgress(t.book.id, t.page).catch(() => {});
      }
    };
  }, [bookId]);

  /* ---------- viewport-sized request (dpr * zoom, capped 1920) ----------
     targetSize rounds to 64px buckets so pinch/zoom settling does not
     spam distinct get_page sizes (each is a separate cache key).
     PDF 走同一套 key 约定（`${idx}@${w}x${h}`），但目标框来自
     「参考页尺寸 × 适配模式 × 缩放」，并受单边 4096px 上限约束。 */
  const targetSize = useCallback((): { w: number; h: number } => {
    const t = trackRef.current;
    const el = canvasRef.current;
    const vw = el?.clientWidth || window.innerWidth;
    const vh = el?.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const boost = t.zoom > 1.25 ? Math.min(t.zoom, 2) : 1;
    const bucket = (v: number) =>
      Math.min(MAX_EDGE, Math.max(64, Math.round(v / 64) * 64)) || 64;
    if (t.isPdf) {
      const pdfBucket = (v: number) =>
        Math.min(PDF_MAX_EDGE, Math.max(64, Math.round(v / 64) * 64)) || 64;
      const box = pdfBoxRef.current;
      if (!box) {
        // 文档还没解析出来：先用视口盒占位，解析完成后会自动升级清晰度。
        return { w: pdfBucket(vw * dpr), h: pdfBucket(vh * dpr) };
      }
      const content = pdfContentBox(vw, vh);
      const target = computePdfTarget({
        page: box,
        viewportWidth: content.width,
        viewportHeight: content.height,
        fit: t.pdfFit,
        devicePixelRatio: dpr,
        zoom: t.zoom,
      });
      void t.sizeTick;
      return { w: pdfBucket(target.width), h: pdfBucket(target.height) };
    }
    const per = spreadFor(t.page, t.book?.pageCount ?? 0, t.mode, t.dir, spreadOptsRef.current)
      .length;
    const w = bucket(((vw * dpr * boost) / Math.max(1, per)) || 0);
    const h = bucket(vh * dpr * boost);
    void t.sizeTick;
    return { w, h };
  }, []);

  /* ---------- PDF 页渲染（取代图片页管线） ---------- */
  const loadPdfPage = useCallback(
    async (
      bookId: string,
      idx: number,
      key: string,
      w: number,
      h: number,
      opts?: { silent?: boolean },
    ) => {
      const doc = pdfDocRef.current;
      if (!doc) {
        requestedRef.current.delete(key);
        setFailed((f) => ({ ...f, [idx]: true }));
        if (!opts?.silent) showPdfFailure("pdf-render-unsupported");
        return;
      }
      // 同一页的旧渲染立刻作废：快速翻页时只保留最后一次请求。
      pdfTasksRef.current.get(idx)?.cancel();
      const handle = renderPdfPage(
        doc,
        idx,
        { width: w, height: h },
        trackRef.current.pdfFit,
      );
      pdfTasksRef.current.set(idx, handle);
      try {
        const rendered = await handle.promise;
        if (pdfTasksRef.current.get(idx) === handle) {
          pdfTasksRef.current.delete(idx);
        }
        if (trackRef.current.book?.id !== bookId) return;
        imgKeyRef.current[idx] = key;
        setImgs((prev) => ({ ...prev, [idx]: rendered.dataUrl }));
        setPending((p) => {
          if (!p[idx]) return p;
          const next = { ...p };
          delete next[idx];
          return next;
        });
      } catch (e) {
        if (pdfTasksRef.current.get(idx) === handle) {
          pdfTasksRef.current.delete(idx);
        }
        // 被新任务取代不算失败：不置 failed、不提示。
        if (isPdfRenderCancelled(e)) return;
        requestedRef.current.delete(key);
        if (trackRef.current.book?.id !== bookId) return;
        setPending((p) => {
          if (!p[idx]) return p;
          const next = { ...p };
          delete next[idx];
          return next;
        });
        setFailed((f) => ({ ...f, [idx]: true }));
        recordBreadcrumb("pdf-render-failed");
        if (!opts?.silent) showPdfFailure(mapPdfError(e));
      }
    },
    [],
  );

  const fetchIdx = useCallback(
    (idx: number, opts?: { silent?: boolean; force?: boolean }) => {
      const b = trackRef.current.book;
      if (!b || idx < 0 || idx >= trackRef.current.pageCount) return;
      const { w, h } = targetSize();
      const key = `${idx}@${w}x${h}`;
      if (requestedRef.current.has(key)) return;
      requestedRef.current.add(key);
      if (!opts?.silent) {
        setPending((p) => ({ ...p, [idx]: true }));
        setFailed((f) => {
          if (!f[idx]) return f;
          const next = { ...f };
          delete next[idx];
          return next;
        });
      }
      if (trackRef.current.isPdf) {
        void loadPdfPage(b.id, idx, key, w, h, opts);
        return;
      }
      api.getPage(b.id, idx, w, h).then(
        (img) => {
          if (trackRef.current.book?.id !== b.id) return;
          imgKeyRef.current[idx] = key;
          setImgs((prev) => ({ ...prev, [idx]: img.dataUrl }));
          setPending((p) => {
            if (!p[idx]) return p;
            const next = { ...p };
            delete next[idx];
            return next;
          });
          // 条漫自动建议：首屏出现 高/宽 > 3 的长条画面、本书支持条漫且未记忆过选择。
          if (
            b.webtoonReady !== false &&
            !wtSuggestedRef.current &&
            trackRef.current.mode !== "webtoon" &&
            img.origWidth > 0 &&
            img.origHeight / img.origWidth > 3
          ) {
            let asked = true;
            try {
              asked = localStorage.getItem(`mr-wt-${b.id}`) !== null;
            } catch {
              /* 忽略 */
            }
            if (!asked) {
              wtSuggestedRef.current = true;
              setWtSuggest(true);
            }
          }
        },
        (e) => {
          requestedRef.current.delete(key);
          if (trackRef.current.book?.id !== b.id) return;
          setPending((p) => {
            if (!p[idx]) return p;
            const next = { ...p };
            delete next[idx];
            return next;
          });
          setFailed((f) => ({ ...f, [idx]: true }));
          if (!opts?.silent) showFailure("reader.error.loadPage", e);
        },
      );
    },
    [loadPdfPage, targetSize],
  );

  /* ---------- load visible spread (+ silent sharpness upgrade) ---------- */
  useEffect(() => {
    if (bookState !== "ready" || !book || n === 0) return;
    if (mode === "webtoon") return; // 条漫由 WebtoonView 自管
    const { w, h } = targetSize();
    for (const idx of spread) {
      if (!imgs[idx] && !pending[idx]) {
        fetchIdx(idx);
      } else if (imgs[idx] && !failed[idx]) {
        // 缩放/resize 后的尺寸桶变化：静默升级清晰度，老图保留到新图到达。
        const key = `${idx}@${w}x${h}`;
        if (imgKeyRef.current[idx] !== key && !requestedRef.current.has(key)) {
          fetchIdx(idx, { silent: true });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookState, book, page, mode, prefs.dir, spreadOptions, sizeTick]);

  /* ---------- prune frontend urls outside the window ---------- */
  useEffect(() => {
    if (n === 0 || mode === "webtoon") return;
    setImgs((prev) => {
      const keep = new Set<number>();
      for (const i of spread) keep.add(i);
      for (let i = page - 3; i <= page + 3; i++) if (i >= 0 && i < n) keep.add(i);
      let drop = false;
      for (const k of Object.keys(prev)) if (!keep.has(Number(k))) { drop = true; break; }
      if (!drop) return prev;
      const next: Record<number, string> = {};
      for (const k of Object.keys(prev)) {
        const idx = Number(k);
        if (keep.has(idx)) {
          next[idx] = prev[idx];
          continue;
        }
        // 滑出窗口的页要同步释放请求去重 key：requestedRef 占位的
        // 前提是“请求在途或结果仍在 imgs”，否则回翻/跳页回到已淘汰页时
        // fetchIdx 会因 key 已存在而不再请求、也不置 pending，
        // 页面将永远停在“正在加载第 N 页”。
        delete imgKeyRef.current[idx];
        const prefix = `${idx}@`;
        for (const rk of [...requestedRef.current]) {
          if (rk.startsWith(prefix)) requestedRef.current.delete(rk);
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, n]);

  /* ---------- silent preload: 本地 current ±3；在线仅当前页起 +2（不回翻） ---------- */
  useEffect(() => {
    if (bookState !== "ready" || !book || n === 0) return;
    if (mode === "webtoon") return; // 条漫由 WebtoonView 预取
    const run = () => {
      const t = trackRef.current;
      if (!t.book || t.book.id !== book.id) return;
      const vis = new Set(
        spreadFor(t.page, n, t.mode, t.dir, spreadOptsRef.current),
      );
      const online = book.sourceType !== "local";
      const start = online ? t.page : t.page - 3;
      const end = online ? Math.min(n - 1, t.page + 2) : Math.min(n - 1, t.page + 3);
      for (let i = Math.max(0, start); i <= end; i++) {
        if (i < 0 || i >= n || vis.has(i)) continue;
        if (imgs[i]) continue;
        fetchIdx(i, { silent: true });
      }
    };
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (ric) {
      const hid = ric.call(window, run, { timeout: 250 });
      const cic = (
        window as unknown as { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback;
      return () => cic?.call(window, hid);
    }
    const t = window.setTimeout(run, 80);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookState, book, page, mode, prefs.dir, imgs]);

  /* ---------- debounced progress save ---------- */
  useEffect(() => {
    if (bookState !== "ready" || !book || n === 0) return;
    if (mode === "webtoon") return; // 条漫进度由 WebtoonView 提交
    const t = window.setTimeout(() => {
      api
        .setProgress(book.id, page)
        .then(() => {
          // 同步本地 book：分页阅读清掉条漫百分比（切条漫时走页码衔接）。
          setBook((b) =>
            b && b.id === book.id ? { ...b, currentPage: page, scrollPct: -1 } : b,
          );
        })
        .catch((e) => showFailure("reader.error.saveProgress", e));
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookState, book, page, n, mode]);

  /* ---------- 页签快照（只写工作区 ref，不触发重渲染） ---------- */
  useEffect(() => {
    if (!book) return;
    // 首次进入条漫且还没有可信位置时，不写 {0,0} 占位；等 Webtoon 首帧上报。
    if (mode === "webtoon" && !wtKnownRef.current) return;
    ws.reportSnapshot(book.id, {
      page: mode === "webtoon" ? wtProgress.page : page,
      scrollPct: mode === "webtoon" ? wtProgress.pct : -1,
      mode,
      dir: prefs.dir,
    });
  }, [book, page, mode, prefs.dir, wtProgress.page, wtProgress.pct, ws]);

  /* ---------- prefs persist ---------- */
  useEffect(() => {
    try {
      localStorage.setItem("mr-reader-mode", prefs.mode);
      localStorage.setItem("mr-reader-dir", prefs.dir);
      // 封面偏移只在用户显式切换后落盘（null = 跟随方向默认，不写键）。
      if (prefs.cover === null) localStorage.removeItem("mr-reader-cover");
      else localStorage.setItem("mr-reader-cover", prefs.cover ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [prefs]);

  /* ---------- double 模式逐页尺寸（宽页独占判定） ----------
     本地书只读每页 256KB 头部（后端 LRU 缓存），在线书读清单尺寸；
     失败静默回落朴素配对。换书清空，避免上一本的宽页表污染下一本。 */
  useEffect(() => {
    setPageDims(null);
  }, [bookId]);
  useEffect(() => {
    if (mode !== "double" || bookState !== "ready" || !book) return;
    let alive = true;
    api.getWebtoonLayout(book.id).then(
      (dims) => {
        if (!alive) return;
        const map: Map<number, readonly [number, number]> = new Map();
        for (const dim of dims) {
          if (dim.width > 0 && dim.height > 0) {
            map.set(dim.index, [dim.width, dim.height]);
          }
        }
        setPageDims(map.size ? map : null);
      },
      () => {
        if (alive) setPageDims(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [mode, bookState, book]);

  /* ---------- resize -> re-request at viewport size ---------- */
  useEffect(() => {
    let t = 0;
    const on = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setSizeTick((v) => v + 1), 250);
    };
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("resize", on);
      window.clearTimeout(t);
    };
  }, []);

  /* ---------- zoom settle -> re-request sharper tiles ---------- */
  const zoomSettle = useRef(0);
  useEffect(() => {
    window.clearTimeout(zoomSettle.current);
    zoomSettle.current = window.setTimeout(() => {
      if (trackRef.current.zoom > 1.25) setSizeTick((v) => v + 1);
    }, 400);
    return () => window.clearTimeout(zoomSettle.current);
  }, [zoom]);

  /* ---------- auto-hide chrome ---------- */
  const poke = useCallback(() => {
    setUiVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (uiLockRef.current) return;
      // 指针停在 HUD 上或键盘焦点在 HUD 内时不隐藏（focus-within 语义）。
      if (hudHoverRef.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest("[data-reader-hud]")) return;
      setUiVisible(false);
    }, HIDE_MS);
  }, []);

  // 条漫开始滚动时隐藏 HUD；锁定态、HUD hover、HUD 焦点内均不隐藏。
  const handleWebtoonScrollStart = useCallback(() => {
    if (uiLockRef.current || hudHoverRef.current) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("[data-reader-hud]")) return;
    window.clearTimeout(hideTimer.current);
    setUiVisible(false);
  }, []);

  useEffect(() => {
    const overlay =
      tocOpen ||
      setOpen ||
      shortcutsOpen ||
      moreOpen ||
      tabsMenuOpen ||
      filterOpen;
    overlayRef.current = overlay;
    uiLockRef.current = overlay;
    if (uiLockRef.current) {
      setUiVisible(true);
      window.clearTimeout(hideTimer.current);
    } else {
      poke();
    }
  }, [
    tocOpen,
    setOpen,
    shortcutsOpen,
    moreOpen,
    tabsMenuOpen,
    filterOpen,
    poke,
  ]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      hudHoverRef.current = !!t?.closest?.("[data-reader-hud]");
      poke();
    };
    poke();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", poke);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", poke);
      window.clearTimeout(hideTimer.current);
    };
  }, [poke]);

  /* ---------- navigation ---------- */
  const go = useCallback(
    (delta: 1 | -1) => {
      const t = trackRef.current;
      if (!t.book || t.pageCount === 0) return;
      if (t.mode === "webtoon") {
        wtHandle.current?.scrollByViewport(delta * 0.85);
        poke();
        return;
      }
      setPage((p) =>
        stepPage(p, t.pageCount, t.mode, t.dir, delta, spreadOptsRef.current),
      );
      setPan({ x: 0, y: 0 });
      poke();
    },
    [poke],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      const t = trackRef.current;
      if (!t.book || t.pageCount === 0) return;
      const target = Math.max(0, Math.min(t.pageCount - 1, idx));
      if (t.mode === "webtoon") {
        wtHandle.current?.scrollToPage(target);
      } else {
        setPage(target);
        setPan({ x: 0, y: 0 });
      }
      setTocOpen(false);
      poke();
    },
    [poke],
  );

  /* ---------- 版式（三态，按书记忆；条漫仅在本书不支持时禁用） ---------- */
  const setMode = useCallback(
    (m: PageMode) => {
      if (safeMode) return;
      if (m === "webtoon" && !webtoonAllowed) return;
      // PDF 只有单页版式：双页 / 条漫都不接受（不静默切换任何模式）。
      if (trackRef.current.isPdf && m !== "single") return;
      const t = trackRef.current;
      // 条漫 → 分页：优先取 Webtoon 的实时中心页；400ms 防抖 ref 可能
      // 落后于用户刚才的快速滚动。
      if (t.mode === "webtoon" && m !== "webtoon" && t.book) {
        const live = wtHandle.current?.getProgress?.();
        const livePage = live?.page ?? wtProgressRef.current.page;
        if (live) {
          wtProgressRef.current = { pct: live.pct, page: live.page };
          setWtProgress({ pct: live.pct, page: live.page });
          setBook((b) =>
            b ? { ...b, currentPage: live.page, scrollPct: live.pct } : b,
          );
        }
        setPage(Math.max(0, Math.min(t.pageCount - 1, livePage)));
        setPan({ x: 0, y: 0 });
      }
      // 再次进入条漫时按当前页衔接，不回到本次 Reader 生命周期最初保存的
      // scrollPct（那会让用户在单页/条漫间切换后跳回旧位置）。
      if (m === "webtoon" && t.mode !== "webtoon") {
        setRestorePct(-1);
      }
      try {
        localStorage.setItem(`mr-wt-${bookId}`, m);
      } catch {
        /* 忽略 */
      }
      setBookMode(m);
      if (m !== "webtoon") setPrefs((p) => ({ ...p, mode: m }));
      setPan({ x: 0, y: 0 });
      recordBreadcrumb("readerMode");
      poke();
    },
    [bookId, poke, webtoonAllowed, safeMode],
  );

  const toggleMode = useCallback(() => {
    if (safeMode) {
      toast(t("safeMode.readerLocked"));
      return;
    }
    // PDF：只有单页版式，循环切换没有意义 —— 直接说明原因。
    if (trackRef.current.isPdf) {
      toast(t("reader.pdf.mode.reason"));
      return;
    }
    const cur = trackRef.current.mode;
    const canWebtoon = book?.webtoonReady !== false;
    const cycle: PageMode[] = canWebtoon
      ? ["single", "double", "webtoon"]
      : ["single", "double"];
    const idx = cycle.indexOf(cur);
    setMode(cycle[(idx + 1) % cycle.length]);
  }, [setMode, book, safeMode, t]);

  /* ---------- PDF 适配模式（整页 / 整宽，按书记忆） ---------- */
  const applyPdfFit = useCallback(
    (fit: PdfFitMode) => {
      if (trackRef.current.pdfFit === fit) return;
      setPdfFit(fit);
      savePdfFit(bookId, fit);
      recordBreadcrumb("pdf-fit-change");
      // 目标框变了 → 触发一次静默重渲染（老图保留到新图到达）。
      setSizeTick((v) => v + 1);
      setPan({ x: 0, y: 0 });
      poke();
    },
    [bookId, poke],
  );

  /* ---------- 条漫进度提交（WebtoonView 内已节流） ---------- */
  const commitWt = useCallback(
    (pct: number, page: number, persist = true) => {
      wtKnownRef.current = true;
      wtProgressRef.current = { pct, page };
      setWtProgress({ pct, page });
      // 同步本地 book：切模式/重进条漫时能立刻拿到最新位置。
      setBook((b) => (b ? { ...b, currentPage: page, scrollPct: pct } : b));
      if (persist) {
        const bb = trackRef.current.book;
        if (bb) {
          api
            .setProgress(bb.id, page, pct)
            .catch((e) => showFailure("reader.error.saveProgress", e));
        }
      }
    },
    [],
  );

  const tapToggle = useCallback(() => {
    setUiVisible((v) => {
      if (v) {
        window.clearTimeout(hideTimer.current);
        return false;
      }
      poke();
      return true;
    });
  }, [poke]);

  // Runtime context for the isolated recovery window's diagnostic snapshot.
  useEffect(() => {
    if (!book) return;
    const timer = window.setTimeout(() => {
      updateRuntimeContext({ readerMode: mode, readerPage: page });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [book, mode, page]);

  /* ---------- keyboard（统一守卫：IME / 输入态 豁免） ----------
     全部走 useGlobalShortcuts：输入法组合中（isComposing / keyCode 229）
     与输入框焦点（input / textarea / select / contenteditable）一律放行，
     行为语义与迁移前完全一致。 */
  const onReaderKey = useCallback(
    (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Ctrl+W 在输入框内也必须拦截，避免 WebView2 直接关窗。
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === "w" || e.key === "W")
      ) {
        e.preventDefault();
        ws.closeActiveTab();
        return;
      }
      // 弹层/弹窗打开时，HUD 内的按键不再穿透到画布翻页（Esc 仍可关闭）。
      if (
        overlayRef.current &&
        e.key !== "Escape" &&
        !e.ctrlKey &&
        !e.metaKey &&
        (el?.closest("[data-reader-hud]") ?? false)
      ) {
        return;
      }
      // 工作区页签：Ctrl+1 书库、Ctrl+2… 阅读页签。
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          ws.activateIndex(Number(e.key));
          return;
        }
      }
      // Ctrl/Cmd/Alt 组合不是阅读快捷键（Ctrl+1…9 已在上方处理）；
      // 放行给浏览器/系统，避免 Ctrl+F、Ctrl+Space、Ctrl+← 被误当成翻页/切版式。
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = trackRef.current;
      // 注意：底部 <button> 聚焦时按空格会原生触发 click（=下一页），
      // 此时不再额外 go()，否则一次空格翻两页。
      const onBtn =
        el instanceof HTMLButtonElement || el instanceof HTMLDivElement;
      const fwd = e.key === "ArrowLeft" ? t.dir === "rtl" : t.dir === "ltr";
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          if (showNextChapter && fwd) {
            void goNextChapter();
            break;
          }
          go(fwd ? 1 : -1);
          break;
        }
        case " ":
          if (onBtn && el instanceof HTMLButtonElement) break;
          e.preventDefault();
          if (showNextChapter && !e.shiftKey) {
            void goNextChapter();
            break;
          }
          go(e.shiftKey ? -1 : 1);
          break;
        case "f":
        case "F":
          toggleMode();
          break;
        case "Escape":
          // 页签菜单开着先关菜单,弹层开着先关弹层,否则返回书库。
          if (tabsMenuOpen) {
            setTabsMenuOpen(false);
          } else if (overlayRef.current) {
            setTocOpen(false);
            setSetOpen(false);
            setShortcutsOpen(false);
            setMoreOpen(false);
          } else {
            nav("/");
          }
          break;
        case "?":
          // P1:快捷键速查表(设置页同源数据)。
          e.preventDefault();
          setShortcutsOpen((v) => !v);
          setMoreOpen(false);
          setTocOpen(false);
          setSetOpen(false);
          break;
        case "Home":
          e.preventDefault();
          jumpTo(0);
          break;
        case "End":
          e.preventDefault();
          if (t.book) jumpTo(t.pageCount - 1);
          break;
      }
    },
    [
      go,
      jumpTo,
      toggleMode,
      nav,
      showNextChapter,
      goNextChapter,
      ws,
      tabsMenuOpen,
    ],
  );

  // 快捷键表：m/M 目前没有绑定行为（速查表只列 f），但同样纳入守卫，
  // 保证输入态与输入法组合中不会触发任何全局动作。
  const readerShortcuts = useMemo(() => {
    const map: Record<string, (event: KeyboardEvent) => void> = {};
    for (const key of [
      " ",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "?",
      "Escape",
      "f",
      "F",
      "m",
      "M",
      "w",
      "W",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]) {
      map[key] = onReaderKey;
    }
    return map;
  }, [onReaderKey]);

  // 统一守卫：输入法组合中 / 输入框焦点一律放行；
  // w/W 例外（Ctrl+W 是窗口关闭保护，输入框内也必须拦截）。
  useGlobalShortcuts(readerShortcuts, { editableExempt: ["w", "W"] });

  /* ---------- zoom / pan / pinch (non-passive wheel) ---------- */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef({ dist: 0, mid: { x: 0, y: 0 } });
  const tap = useRef({ x: 0, y: 0, t: 0, id: -1 });

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    setZoom((z) => {
      const nz = clampZoom(z * factor);
      if (nz === z) return z;
      const k = nz / z;
      setPan((p) => ({ x: px + (p.x - px) * k, y: py + (p.y - py) * k }));
      return nz;
    });
    poke();
  }, [poke]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 条漫：Ctrl/Cmd+滚轮由 WebtoonView 自己处理为宽度缩放，不能走分页 zoom。
      if (trackRef.current.mode === "webtoon") {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0025));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return; // 条漫滚动容器自管
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    } else if (pointers.current.size === 1) {
      tap.current = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    }
    poke();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return;
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch.current.dist > 0 && dist > 0) {
        // 缩放：以画布中心为原点，老 pan + 手指位移，并绕当前触点修正。
        const factor = dist / pinch.current.dist;
        const el = canvasRef.current;
        const r = el?.getBoundingClientRect();
        const ox = r ? r.left + r.width / 2 : window.innerWidth / 2;
        const oy = r ? r.top + r.height / 2 : window.innerHeight / 2;
        setZoom((z) => {
          const nz = clampZoom(z * factor);
          if (nz === z) return z;
          const mx = mid.x - ox;
          const my = mid.y - oy;
          const pmx = pinch.current.mid.x - ox;
          const pmy = pinch.current.mid.y - oy;
          setPan((p) => ({
            x: p.x * (nz / z) + (mid.x - pinch.current.mid.x) + (mx - pmx),
            y: p.y * (nz / z) + (mid.y - pinch.current.mid.y) + (my - pmy),
          }));
          return nz;
        });
      }
      pinch.current = { dist, mid };
    } else if (
      trackRef.current.zoom > 1 ||
      // PDF 整宽模式：页宽铺满视口、高度溢出，靠拖拽看上下部分。
      (trackRef.current.isPdf && trackRef.current.pdfFit === "width")
    ) {
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    poke();
  };

  const endPointer = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current.dist = 0;
    // tap (no drag) toggles chrome
    if (
      e.pointerId === tap.current.id &&
      Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) < 6 &&
      Date.now() - tap.current.t < 400 &&
      (e.target as HTMLElement).closest("img") == null
    ) {
      setUiVisible((v) => {
        if (v) {
          window.clearTimeout(hideTimer.current);
          return false;
        }
        poke();
        return true;
      });
    }
    tap.current.id = -1;
  };

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // 条漫没有 paged transform，双击/重置回到默认宽度。
    if (trackRef.current.mode === "webtoon") setWtWidth(WT_DEFAULT_WIDTH);
    poke();
  }, [poke]);

  /* ---------- toc ---------- */
  const loadEntries = () => {
    if (entriesLoading) return;
    setEntriesLoading(true);
    setEntriesError(false);
    // PDF：后端不提供 list_entries（PDF 没有文件名清单），目录在前端本地生成。
    if (trackRef.current.isPdf) {
      void loadPdfEntries();
      return;
    }
    api.listEntries(bookId).then(
      (list) => {
        setEntries(list);
        setEntriesLoading(false);
      },
      (e) => {
        setEntriesLoading(false);
        setEntriesError(true);
        showFailure("reader.toc.loadFailed", e);
      },
    );
  };

  /**
   * PDF 目录：优先用文档自带书签（outline），没有书签时退化成逐页条目。
   *
   * 书签标题是文档内容（不翻译）；逐页条目走 i18n。
   */
  const loadPdfEntries = async () => {
    const doc = pdfDocRef.current;
    const count = trackRef.current.pageCount;
    if (!doc) {
      setEntriesLoading(false);
      setEntriesError(true);
      return;
    }
    try {
      const outline = await doc.getOutline();
      const list = flattenPdfOutline(outline, (page) =>
        t("reader.pdf.toc.page", { page }),
      );
      if (list.length > 0) {
        setEntries(list);
      } else {
        const pages: PageEntry[] = [];
        for (let i = 0; i < count; i += 1) {
          pages.push({ index: i, name: t("reader.pdf.toc.page", { page: i + 1 }) });
        }
        setEntries(pages);
      }
    } catch {
      setEntriesError(true);
    } finally {
      setEntriesLoading(false);
    }
  };

  /* ---------- 在线提纯：过滤抽屉 / 标记 / 恢复 ---------- */
  const refreshFiltered = useCallback(async (target?: BookInfo | null) => {
    const current = target ?? trackRef.current.book;
    if (!current || current.sourceType === "local") {
      setFiltered([]);
      return;
    }
    try {
      const list = await api.getFilteredPages(current.id);
      setFiltered(list);
    } catch {
      setFiltered([]);
    }
  }, []);

  useEffect(() => {
    void refreshFiltered();
  }, [book?.id, book?.sourceType, refreshFiltered]);

  const dropPagedCaches = useCallback(() => {
    setImgs({});
    setPending({});
    setFailed({});
    setEntries(null);
    requestedRef.current.clear();
    imgKeyRef.current = {};
  }, []);

  const applyFilteredBook = useCallback(
    async (updated: BookInfo, successKey: MessageKey) => {
      setBook(updated);
      const max = Math.max(0, updated.pageCount - 1);
      setPage((p) => Math.min(p, max));
      const nextWt = {
        pct: wtProgressRef.current.pct,
        page: Math.min(wtProgressRef.current.page, max),
      };
      wtProgressRef.current = nextWt;
      setWtProgress(nextWt);
      dropPagedCaches();
      await refreshFiltered(updated);
      toast(t(successKey));
    },
    [dropPagedCaches, refreshFiltered, t],
  );

  const markCurrentNonContent = useCallback(async () => {
    const current = trackRef.current.book;
    if (!current || current.sourceType === "local" || filterMarkBusy) return;
    setFilterMarkBusy(true);
    try {
      const updated = await api.markOnlinePageNonContent(
        current.id,
        currentFilterIndex,
      );
      await applyFilteredBook(updated, "reader.filter.markedToast");
    } catch (error) {
      showFailure("reader.filter.actionFailed", error);
    } finally {
      setFilterMarkBusy(false);
    }
  }, [applyFilteredBook, currentFilterIndex, filterMarkBusy]);

  const restoreFilteredPage = useCallback(
    async (index: number) => {
      const current = trackRef.current.book;
      if (!current || filterRestoreBusy !== null) return;
      setFilterRestoreBusy(index);
      try {
        const updated = await api.restoreOnlineFilteredPage(current.id, index);
        await applyFilteredBook(updated, "reader.filter.restoredToast");
      } catch (error) {
        showFailure("reader.filter.actionFailed", error);
      } finally {
        setFilterRestoreBusy(null);
      }
    },
    [applyFilteredBook, filterRestoreBusy],
  );

  const openToc = () => {
    setShortcutsOpen(false);
    setSetOpen(false);
    setMoreOpen(false);
    setTocShown(200);
    setTocQuery("");
    setJumpPage("");
    const next = !tocOpen;
    setTocOpen(next);
    if (next && (!entries || entriesError) && !entriesLoading) loadEntries();
  };

  const filteredEntries = useMemo(() => {
    const list = entries ?? [];
    const q = tocQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        String(entry.index + 1) === q,
    );
  }, [entries, tocQuery]);

  /* ---------- progress scrubber（拖拽预览不发请求；松手才跳页） ---------- */
  const pagedMax = Math.max(0, n - 1);
  const sliderMax = mode === "webtoon" ? 100 : pagedMax;
  const sliderValue =
    mode === "webtoon" ? Math.round(wtProgress.pct * 100) : Math.min(page, pagedMax);

  const onScrub = useCallback(
    (v: number) => {
      if (mode === "webtoon") {
        setScrub({ label: `${Math.round(v)}%`, thumb: null });
        return;
      }
      const idx = Math.max(0, Math.min(n - 1, Math.round(v)));
      // 只用已缓存图片；没有就只显示页码，绝不在这里发 get_page。
      setScrub({
        label: t("reader.page.label", { page: idx + 1 }),
        thumb: imgs[idx] ?? null,
      });
    },
    [mode, n, imgs, t],
  );

  const onCommitScrub = useCallback(
    (v: number) => {
      setScrub(null);
      if (mode === "webtoon") {
        wtHandle.current?.scrollToPct(v / 100);
        return;
      }
      jumpTo(Math.round(v));
    },
    [mode, jumpTo],
  );

  const retryIdx = (idx: number) => {
    const b = trackRef.current.book;
    if (!b || idx < 0 || idx >= trackRef.current.pageCount) return;
    const { w, h } = targetSize();
    requestedRef.current.delete(`${idx}@${w}x${h}`);
    setFailed((f) => {
      if (!f[idx]) return f;
      const next = { ...f };
      delete next[idx];
      return next;
    });
    fetchIdx(idx);
  };

  /** 唤醒自愈：丢弃该页全部尺寸桶的缓存图并静默重取（无 toast 打扰）。 */
  const healIdx = useCallback(
    (idx: number) => {
      const b = trackRef.current.book;
      if (!b || idx < 0 || idx >= trackRef.current.pageCount) return;
      for (const key of [...requestedRef.current]) {
        if (key.startsWith(`${idx}@`)) requestedRef.current.delete(key);
      }
      delete imgKeyRef.current[idx];
      setImgs((prev) => {
        if (!(idx in prev)) return prev;
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      fetchIdx(idx, { silent: true });
    },
    [fetchIdx],
  );

  /* ---------- 休眠唤醒 / 外接磁盘重连的视图自愈 ----------
     系统从睡眠恢复时 GPU 纹理可能被重置成空白图（complete 但内容丢失）
     或解码损坏。恢复可见时静默校验当前视口：未加载完、naturalWidth=0 或
     decode() 拒绝的页面无感重载；单次唤醒最多修复 2 页，防止连环重取。 */
  useEffect(() => {
    let timer = 0;
    const heal = () => {
      if (document.hidden) return;
      const root = canvasRef.current;
      if (!root || !root.isConnected) return;
      const candidates = Array.from(
        root.querySelectorAll<HTMLImageElement>("img.reader-img[data-idx]"),
      ).slice(0, 6);
      void Promise.allSettled(
        candidates.map(async (img) => {
          if (img.complete && img.naturalWidth === 0) return img;
          try {
            await img.decode();
            return null;
          } catch {
            return img;
          }
        }),
      ).then((results) => {
        if (!root.isConnected) return;
        const broken = results
          .map((r) => (r.status === "fulfilled" && r.value ? Number(r.value.dataset.idx) : NaN))
          .filter(Number.isInteger);
        for (const idx of broken.slice(0, 2)) healIdx(idx);
      });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(heal, 400);
    };
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    return () => {
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
      window.clearTimeout(timer);
    };
  }, [healIdx]);

  const toggleSettings = useCallback(() => {
    setSetOpen((o) => !o);
    setTocOpen(false);
    setShortcutsOpen(false);
    setMoreOpen(false);
  }, []);
  const toggleShortcuts = useCallback(() => {
    setShortcutsOpen((v) => !v);
    setTocOpen(false);
    setSetOpen(false);
    setMoreOpen(false);
  }, []);

  const dirRtl = prefs.dir === "rtl";
  /** 版式不可用的原因：PDF 用 PDF 专属原因，其余用条漫不支持的原因。 */
  const webtoonReason = isPdfBook
    ? t("reader.pdf.mode.reason")
    : t("reader.webtoon.unsupported");
  const doubleReason = t("reader.pdf.mode.reason");
  const activePages =
    mode === "webtoon" ? new Set([wtProgress.page]) : new Set(spread);
  // spreadFor 已是视觉左→右顺序，DOM 顺序即视觉顺序，不再翻转。
  const ordered = spread;

  const commitPageJump = () => {
    const requested = Number(jumpPage);
    if (!Number.isInteger(requested) || requested < 1 || requested > n) return;
    setJumpPage("");
    jumpTo(requested - 1);
  };

  return (
    <div className={`reader-root${uiVisible ? "" : " chrome-hidden"}`}>
      {/* canvas */}
      <div
        ref={canvasRef}
        className={cn(
          "reader-canvas",
          mode === "webtoon" && "reader-canvas-webtoon",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={resetView}
      >
        {bookState === "loading" ? (
          <div className="reader-center">
            <PixelPet mode="loading" message={t("reader.loading.opening")} />
          </div>
        ) : bookState === "blocked" ? (
          <div className="reader-center">
            <div className="reader-err max-w-md rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-hard">
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-border bg-warning text-background">
                <ShieldCheck className="size-5" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-extrabold">
                {t("safeMode.readerOnlineBlocked")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("safeMode.readerOnlineBlockedBody")}
              </p>
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> {t("reader.backToLibrary")}
              </Button>
            </div>
          </div>
        ) : bookState === "missing" || !book ? (
          <div className="reader-center">
            <div className="reader-err">
              <PixelPet mode="empty" message={t("reader.missingBook")} />
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> {t("reader.backToLibrary")}
              </Button>
            </div>
          </div>
        ) : pdfError ? (
          <div className="reader-center">
            <div
              className="reader-err max-w-md rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-hard"
              data-error-code={pdfError}
              data-testid="reader-pdf-error"
            >
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-border bg-warning text-background">
                <FileWarning className="size-5" aria-hidden />
              </span>
              <p className="mt-3 text-sm font-extrabold">
                {t("reader.pdf.errorTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {localizeStableErrorCode(pdfError)}
              </p>
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> {t("reader.backToLibrary")}
              </Button>
            </div>
          </div>
        ) : isPdfBook && pdfState === "loading" ? (
          <div className="reader-center">
            <PixelPet mode="loading" message={t("reader.pdf.opening")} />
          </div>
        ) : n === 0 ? (
          <div className="reader-center">
            <div className="reader-err">
              <PixelPet
                mode="empty"
                message={
                  // PDF：解析成功但页数为 0（异常文档），给出真实原因，
                  // 不能谎称「没有可读页面」。
                  book?.format === "pdf"
                    ? t("error.pdfRenderUnsupported")
                    : t("reader.emptyBook")
                }
              />
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> {t("reader.backToLibrary")}
              </Button>
            </div>
          </div>
        ) : mode === "webtoon" && book ? (
          <WebtoonView
            ref={wtHandle}
            book={book}
            startPage={page}
            restorePct={restorePct}
            widthPct={wtWidth}
            onWidthChange={applyWtWidth}
            onProgress={commitWt}
            onTap={tapToggle}
            onScrollStart={handleWebtoonScrollStart}
          />
        ) : (
          <div
            className={`reader-pages${mode === "double" ? " reader-double" : ""}${
              solo ? (dirRtl ? " solo" : " solo-center") : ""
            }${wideSolo ? " solo-center" : ""}`}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            }}
          >
            {ordered.map((idx) => (
              <div
                key={idx}
                className={`reader-cell${spread.length === 1 ? " solo-one" : ""}${
                  isPdfBook && pdfFit === "width" ? " reader-cell-pdf-width" : ""
                }`}
              >
                {imgs[idx] ? (
                  <img
                    key={idx}
                    src={imgs[idx]}
                    alt={t("reader.page.alt", { page: idx + 1 })}
                    draggable={false}
                    className={cn(
                      "reader-img fade-in",
                      isPdfBook && pdfFit === "width" && "reader-img-pdf-width",
                    )}
                    data-idx={idx}
                    onDragStart={(e) => e.preventDefault()}
                  />
                ) : failed[idx] ? (
                  <div className="reader-err">
                    <PixelPet
                      mode="empty"
                      message={t("reader.page.missing", { page: idx + 1 })}
                    />
                    <Button
                      variant="pill"
                      size="pill-sm"
                      onClick={() => retryIdx(idx)}
                    >
                      <RefreshCw className="size-3.5" /> {t("common.retry")}
                    </Button>
                  </div>
                ) : (
                  <PixelPet
                    mode="loading"
                    message={t("reader.page.loading", { page: idx + 1 })}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 顶部拖拽带：HUD 隐藏后仍能拖动窗口 / 从顶部边缘唤出 */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="absolute inset-x-0 top-0 z-20 h-2"
      />

      <ReaderHudTop
        title={
          book?.title ??
          (bookState === "loading"
            ? t("reader.loading.openingEllipsis")
            : t("reader.unknownBook"))
        }
        zoom={mode === "webtoon" ? wtWidth / 100 : zoom}
        minZoom={mode === "webtoon" ? WT_MIN_WIDTH / 100 : MIN_ZOOM}
        maxZoom={mode === "webtoon" ? WT_MAX_WIDTH / 100 : MAX_ZOOM}
        hidden={!uiVisible}
        tabsSlot={
          ws.tabsEnabled ? (
            <TabSwitcher open={tabsMenuOpen} onOpenChange={setTabsMenuOpen} />
          ) : undefined
        }
        filterSlot={
          book && book.sourceType !== "local" ? (
            <div className="flex items-center gap-0.5">
              {filtered.length > 0 ? (
                <Button
                  data-testid="reader-filter-count"
                  variant="pill-ghost"
                  size="pill-sm"
                  className="mono px-1.5 text-[10px]"
                  onClick={() => setFilterOpen(true)}
                  aria-label={t("reader.filter.filteredCount", {
                    count: filtered.length,
                  })}
                  title={t("reader.filter.drawerTitle")}
                >
                  <Filter className="size-3.5" />
                  {filtered.length}
                </Button>
              ) : null}
              <Button
                data-testid="reader-filter-mark"
                variant="pill-ghost"
                size="icon"
                onClick={() => void markCurrentNonContent()}
                disabled={filterMarkBusy}
                aria-label={t("reader.filter.markPage")}
                title={t("reader.filter.markPage")}
              >
                {filterMarkBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Ban className="size-4" />
                )}
              </Button>
            </div>
          ) : undefined
        }
        onBack={() => nav("/")}
        onZoom={(factor) => {
          if (mode === "webtoon") {
            applyWtWidth(wtWidth * factor);
            return;
          }
          zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
        }}
        onReset={
          mode === "webtoon"
            ? () => applyWtWidth(WT_DEFAULT_WIDTH)
            : resetView
        }
      />

      <ReaderDock
        hidden={!uiVisible}
        dir={prefs.dir}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        mode={mode}
        webtoonAllowed={webtoonAllowed}
        webtoonReason={webtoonReason}
        doubleAllowed={doubleAllowed}
        doubleReason={doubleReason}
        modeLocked={safeMode}
        onMode={setMode}
        coverOffset={coverOffset}
        onCoverOffset={(value) => setPrefs((p) => ({ ...p, cover: value }))}
        tocOpen={tocOpen}
        onToc={openToc}
        moreOpen={moreOpen}
        onMoreOpenChange={(open) => {
          setMoreOpen(open);
          if (open) {
            setTocOpen(false);
            setSetOpen(false);
            setShortcutsOpen(false);
          }
          poke();
        }}
        settingsOpen={setOpen}
        onSettings={toggleSettings}
        shortcutsOpen={shortcutsOpen}
        onShortcuts={toggleShortcuts}
        slider={
          <ProgressScrubber
            value={sliderValue}
            max={sliderMax}
            min={0}
            step={1}
            disabled={n === 0}
            ariaLabel={t("reader.progress.label")}
            preview={scrub}
            onScrub={onScrub}
            onCommit={onCommitScrub}
            className="mx-1"
          />
        }
        pageLabel={
          mode === "webtoon" ? (
            <>
              <span className="text-foreground">
                {Math.round(wtProgress.pct * 100)}%
              </span>
              <span className="px-1 text-muted-foreground/70">·</span>
              {Math.min(n, wtProgress.page + 1)}/{n}
            </>
          ) : (
            <>
              <span className="text-[12px] font-semibold text-foreground">
                {n > 0 ? page + 1 : "–"}
              </span>
              <span className="px-0.5">/</span>
              {n > 0 ? n : "–"}
            </>
          )
        }
      />

      <FilteredPagesSheet
        open={filterOpen}
        onOpenChange={setFilterOpen}
        bookId={book?.id ?? ""}
        items={filtered}
        restoringIndex={filterRestoreBusy}
        onRestore={(index) => void restoreFilteredPage(index)}
      />

      {/* 页目录：shadcn Sheet，搜索 + 窗口化 200 项 + 页码跳转 */}
      <Sheet
        open={tocOpen}
        onOpenChange={(open) => {
          setTocOpen(open);
          if (!open) setJumpPage("");
        }}
      >
        <SheetContent
          side="right"
          data-reader-hud
          className="reader-portal w-full! gap-0! border-l-border! bg-card! p-0! text-card-foreground! shadow-hard! sm:w-[420px]! sm:max-w-[420px]!"
        >
          <SheetHeader className="border-b border-border/70 px-5 py-4 pr-12">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-sm font-bold">
                {t("reader.toc.title")}
              </SheetTitle>
              <Badge
                variant="secondary"
                className="mono border-border/60 px-2 py-0.5 text-[10px]"
              >
                {entries ? filteredEntries.length : "…"}
              </Badge>
            </div>
            <SheetDescription className="text-[11px] text-muted-foreground">
              {t("reader.toc.description")}
            </SheetDescription>
          </SheetHeader>

          <div className="px-4 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={tocQuery}
                onChange={(e) => {
                  setTocQuery(e.currentTarget.value);
                  setTocShown(200);
                }}
                placeholder={t("reader.toc.searchPlaceholder")}
                aria-label={t("reader.toc.searchAria")}
                className="h-9 bg-background/40 pl-9 text-xs"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-2">
            <div className="flex flex-col gap-0.5 pb-3">
              {entriesError ? (
                <ErrorState message={t("reader.toc.loadFailed")} onRetry={loadEntries} />
              ) : entriesLoading || !entries ? (
                <div className="flex min-h-48 items-center justify-center">
                  <PixelPet mode="loading" message={t("reader.toc.loading")} />
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex min-h-48 items-center justify-center">
                  <PixelPet mode="empty" message={t("reader.toc.empty")} />
                </div>
              ) : (
                <>
                  {filteredEntries.slice(0, tocShown).map((en) => (
                    <button
                      key={en.index}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left text-[12px] outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset",
                        activePages.has(en.index) &&
                          "border-primary/40 bg-primary/10 text-foreground",
                      )}
                      onClick={() => jumpTo(en.index)}
                      title={t("reader.page.jumpTitle", { page: en.index + 1 })}
                    >
                      <span className="mono w-10 shrink-0 text-right text-[11px] tabular-nums text-primary">
                        {en.index + 1}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {en.name}
                      </span>
                    </button>
                  ))}
                  {filteredEntries.length > tocShown && (
                    <Button
                      variant="pill"
                      size="pill-sm"
                      className="mx-auto mt-2"
                      onClick={() => setTocShown((v) => v + 200)}
                    >
                      {t("reader.toc.loadMore", {
                        count: filteredEntries.length - tocShown,
                      })}
                    </Button>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
            <span className="text-[11px] text-muted-foreground">
              {t("reader.toc.jumpLabel")}
            </span>
            <Input
              type="number"
              min={1}
              max={Math.max(1, n)}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPageJump();
              }}
              aria-label={t("reader.toc.jumpAria")}
              placeholder={t("reader.toc.jumpPlaceholder")}
              className="mono h-9 w-20 text-center text-xs"
            />
            <span className="text-[11px] text-muted-foreground">/ {n || "–"}</span>
            <Button
              variant="pill-primary"
              size="pill-sm"
              className="ml-auto"
              onClick={commitPageJump}
              disabled={n === 0 || !jumpPage}
            >
              {t("reader.toc.jump")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* 阅读设置：shadcn Dialog + 胶囊分段控件 */}
      <Dialog open={setOpen} onOpenChange={setSetOpen}>
        <DialogContent
          data-reader-hud
          className="reader-portal max-w-[calc(100%-2rem)]! gap-0! overflow-hidden rounded-2xl! border! border-border! bg-card! p-0! text-card-foreground! shadow-hard! sm:max-w-[440px]!"
        >
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal className="size-4 text-primary" />
              {t("reader.settings.title")}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              {t("reader.settings.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t("reader.mode.group")}
              </span>
              <div
                className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                role="group"
                aria-label={t("reader.mode.group")}
              >
                {(
                  [
                    { key: "single", label: t("reader.mode.single") },
                    { key: "double", label: t("reader.mode.double") },
                    { key: "webtoon", label: t("reader.mode.webtoon") },
                  ] as const
                ).map(({ key, label }) => {
                  const disabled =
                    (safeMode && key !== "single") ||
                    (key === "double" && !doubleAllowed) ||
                    (key === "webtoon" && !webtoonAllowed);
                  return (
                    <Button
                      key={key}
                      type="button"
                      variant={mode === key ? "pill-primary" : "pill-ghost"}
                      size="pill-sm"
                      aria-pressed={mode === key}
                      disabled={disabled}
                      title={
                        disabled
                          ? safeMode
                            ? t("safeMode.readerLocked")
                            : key === "double" && !doubleAllowed
                              ? doubleReason
                              : webtoonReason
                          : t("reader.mode.switch", { mode: label })
                      }
                      onClick={() => setMode(key)}
                      className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                    >
                      {label}
                    </Button>
                  );
                })
              }
              </div>
              {safeMode ? (
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-warning">
                  {t("safeMode.readerLocked")}
                </p>
              ) : null}
            </div>

            {/* PDF 适配：整页 / 整宽（按书记忆） */}
            {isPdfBook ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("reader.pdf.fit.label")}
                  </span>
                  <div
                    className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                    role="group"
                    aria-label={t("reader.pdf.fit.label")}
                  >
                    <Button
                      type="button"
                      variant={pdfFit === "page" ? "pill-primary" : "pill-ghost"}
                      size="pill-sm"
                      data-testid="reader-pdf-fit-page"
                      aria-pressed={pdfFit === "page"}
                      onClick={() => applyPdfFit("page")}
                      className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                    >
                      {t("reader.pdf.fit.page")}
                    </Button>
                    <Button
                      type="button"
                      variant={pdfFit === "width" ? "pill-primary" : "pill-ghost"}
                      size="pill-sm"
                      data-testid="reader-pdf-fit-width"
                      aria-pressed={pdfFit === "width"}
                      onClick={() => applyPdfFit("width")}
                      className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                    >
                      {t("reader.pdf.fit.width")}
                    </Button>
                  </div>
                </div>
                <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                  {t("reader.pdf.fit.hint")}
                </p>
                {pdfPageCount > 0 ? (
                  <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                    {t("reader.pdf.pageCount", { count: pdfPageCount })}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t("reader.direction.label")}
              </span>
              <div
                className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                role="group"
                aria-label={t("reader.direction.label")}
              >
                <Button
                  type="button"
                  variant={dirRtl ? "pill-primary" : "pill-ghost"}
                  size="pill-sm"
                  aria-pressed={dirRtl}
                  onClick={() => setPrefs((p) => ({ ...p, dir: "rtl" }))}
                  className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                >
                  {t("reader.direction.rtl")}
                </Button>
                <Button
                  type="button"
                  variant={!dirRtl ? "pill-primary" : "pill-ghost"}
                  size="pill-sm"
                  aria-pressed={!dirRtl}
                  onClick={() => setPrefs((p) => ({ ...p, dir: "ltr" }))}
                  className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                >
                  {t("reader.direction.ltr")}
                </Button>
              </div>
            </div>

            {mode === "double" ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("reader.cover.label")}
                </span>
                <div
                  className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                  role="group"
                  aria-label={t("reader.cover.label")}
                >
                  <Button
                    type="button"
                    variant={!coverOffset ? "pill-primary" : "pill-ghost"}
                    size="pill-sm"
                    aria-pressed={!coverOffset}
                    onClick={() => setPrefs((p) => ({ ...p, cover: false }))}
                    className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                  >
                    {t("reader.cover.off")}
                  </Button>
                  <Button
                    type="button"
                    variant={coverOffset ? "pill-primary" : "pill-ghost"}
                    size="pill-sm"
                    aria-pressed={coverOffset}
                    onClick={() => setPrefs((p) => ({ ...p, cover: true }))}
                    className="h-8 whitespace-nowrap px-2.5 text-[11px]"
                  >
                    {t("reader.cover.on")}
                  </Button>
                </div>
              </div>
            ) : null}

            {mode === "webtoon" ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("reader.webtoon.widthLabel")}
                  </span>
                  <span className="mono text-xs tabular-nums text-foreground">
                    {t("reader.webtoon.widthValue", { value: wtWidth })}
                  </span>
                </div>
                <Slider
                  value={[wtWidth]}
                  min={WT_MIN_WIDTH}
                  max={WT_MAX_WIDTH}
                  step={1}
                  aria-label={t("reader.webtoon.widthLabel")}
                  getAriaLabel={() => t("reader.webtoon.widthLabel")}
                  onValueChange={(v) => applyWtWidth(sliderNumber(v))}
                  className="[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-thumb]]:size-4"
                />
                <Button
                  variant="pill"
                  size="pill-sm"
                  className="w-full"
                  onClick={() => applyWtWidth(WT_DEFAULT_WIDTH)}
                >
                  <RotateCcw className="size-3.5" />
                  {t("reader.webtoon.widthReset")}
                </Button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("reader.webtoon.widthHint")}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("reader.zoom.label")}
                  </span>
                  <span className="mono text-xs tabular-nums text-foreground">
                    {Math.round(zoom * 100)}%
                  </span>
                </div>
                <Slider
                  value={[zoom]}
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.1}
                  aria-label={t("reader.zoom.label")}
                  getAriaLabel={() => t("reader.zoom.label")}
                  onValueChange={(v) =>
                    setZoom(clampZoom(sliderNumber(v)))
                  }
                  className="[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-thumb]]:size-4"
                />
                <Button
                  variant="pill"
                  size="pill-sm"
                  className="w-full"
                  onClick={resetView}
                >
                  <Maximize2 className="size-3.5" />
                  {t("reader.zoom.fit")}
                </Button>
              </div>
            )}

            {!webtoonAllowed && (
              <p className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                {isPdfBook
                  ? t("reader.pdf.mode.note")
                  : t("reader.webtoon.unsupportedNote")}
              </p>
            )}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("reader.settings.hintPageKeys")}
              <br />
              {t("reader.settings.hintKeys")}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* 快捷键速查表（? 呼出） */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent
          data-reader-hud
          className="reader-portal max-w-[calc(100%-2rem)]! gap-0! overflow-hidden rounded-2xl! border! border-border! bg-card! p-0! text-card-foreground! shadow-hard! sm:max-w-[440px]!"
        >
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle className="text-sm font-bold">
              {t("reader.shortcuts.title")}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              {t("reader.shortcuts.description")}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[min(72vh,560px)] px-4 py-3">
            <div className="flex flex-col gap-1 pb-2">
              {READER_SHORTCUTS.map((s) => (
                <div
                  key={s.actionKey}
                  className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-[12px] odd:bg-muted/40"
                >
                  <kbd className="mono min-w-[124px] shrink-0 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                    {s.keysKey ? t(s.keysKey) : s.keys}
                  </kbd>
                  <span className="text-muted-foreground">{t(s.actionKey)}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {showNextChapter && (
        <div
          data-reader-hud
          className="absolute bottom-24 right-4 z-30 w-[min(340px,calc(100vw-2rem))]"
        >
          <button
            type="button"
            onClick={() => void goNextChapter()}
            disabled={nextBusy}
            className="group flex w-full items-center gap-3 rounded-2xl border border-border/80 bg-card/95 p-3.5 text-left text-card-foreground shadow-hard outline-none backdrop-blur-md transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait"
          >
            <span className="min-w-0 flex-1">
              <Badge
                variant="secondary"
                className="mb-1.5 border-border/60 px-2 py-0.5 text-[10px]"
              >
                {t("reader.next.finished")}
              </Badge>
              <span className="block truncate text-[13px] font-semibold">
                {nextBusy
                  ? t("reader.next.loading")
                  : t("reader.next.label", { title: nextTitle })}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {nextBusy ? t("reader.next.resolving") : t("reader.next.go")}
              </span>
            </span>
            <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-hard-sm">
              {nextBusy ? (
                <Loader2 className="reader-spin size-4" />
              ) : (
                <ArrowRight className="size-4" />
              )}
            </span>
          </button>
        </div>
      )}

      {/* 条漫自动建议：检测到长条画面且本书未记忆过选择 */}
      {book?.webtoonReady !== false && !safeMode && wtSuggest && mode !== "webtoon" && (
        <div
          data-reader-hud
          className="fade-in absolute bottom-24 left-1/2 z-30 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-border/80 bg-card/95 py-2 pl-4 pr-2 text-card-foreground shadow-hard-sm backdrop-blur-md"
        >
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("reader.suggest.text")}
          </span>
          <Button
            variant="pill-primary"
            size="pill-sm"
            onClick={() => {
              setMode("webtoon");
              setWtSuggest(false);
            }}
          >
            {t("reader.suggest.accept")}
          </Button>
          <Button
            variant="pill-ghost"
            size="pill-sm"
            onClick={() => {
              try {
                localStorage.setItem(`mr-wt-${bookId}`, prefs.mode);
              } catch {
                /* 忽略 */
              }
              setBookMode(prefs.mode);
              setWtSuggest(false);
            }}
          >
            {t("reader.suggest.decline")}
          </Button>
        </div>
      )}

      <Toaster />
    </div>
  );
}
