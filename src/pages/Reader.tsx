import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Languages,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  api,
  isTransEnabled,
  isWebtoonEnabled,
  onExperimentalChange,
  type BookInfo,
  type OcrResult,
  type PageEntry,
  type TranslateResult,
} from "../lib/tauri";
import PixelPet from "../components/PixelPet";
import ErrorState from "../components/ErrorState";
import { Toaster, toast, toastErr } from "../components/Toast";
import { cn } from "../lib/utils";
import {
  isSoloCover,
  spreadFor,
  stepPage,
  type Direction,
  type PageMode,
} from "../components/Reader/spread";
import { READER_SHORTCUTS } from "../components/Reader/shortcuts";
import WebtoonView, { type WebtoonHandle } from "../components/Reader/Webtoon";
import ReaderHudTop from "../components/Reader/ReaderHudTop";
import ReaderDock from "../components/Reader/ReaderDock";
import ProgressScrubber, {
  type ScrubPreview,
} from "../components/Reader/ProgressScrubber";
import TabSwitcher from "../components/Reader/TabSwitcher";
import { useWorkspace } from "../features/workspace/WorkspaceContext";
import {
  isUsable,
  normPoint,
  rectFromPoints,
  type Rect,
} from "../components/Reader/region";
import "../components/Reader.css";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_EDGE = 1920;
const HIDE_MS = 1500;
const SAVE_DEBOUNCE_MS = 500;

const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

function loadPrefs(): { mode: PageMode; dir: Direction } {
  try {
    const mode =
      localStorage.getItem("mr-reader-mode") === "double" ? "double" : "single";
    const dir = localStorage.getItem("mr-reader-dir") === "ltr" ? "ltr" : "rtl";
    return { mode: mode as PageMode, dir: dir as Direction };
  } catch {
    return { mode: "single", dir: "rtl" };
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
  // 本次挂载的会话快照（页签切回时恢复页码/版式/方向/条漫位置）；只在首次渲染取一次。
  const initialSnapRef = useRef(ws.getSnapshot(bookId));
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);

  const [book, setBook] = useState<BookInfo | null>(null);
  const [bookState, setBookState] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  const [page, setPage] = useState(0);
  const [imgs, setImgs] = useState<Record<number, string>>({});
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [prefs, setPrefs] = useState(loadPrefs);
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

  /* ---------- 阶段三:选区翻译 ---------- */
  // 实验性开关（镜像 + 后端刷新 + 订阅）：关闭时入口隐藏、快捷键失效。
  const [transOn, setTransOn] = useState(isTransEnabled());
  const [wtOn, setWtOn] = useState(isWebtoonEnabled());
  useEffect(() => {
    // 首次读取会刷新 localStorage 镜像；镜像就绪后回灌，避免首启动时开关已开但按钮仍禁用。
    api.getSettings().then(
      () => {
        setTransOn(isTransEnabled());
        setWtOn(isWebtoonEnabled());
      },
      () => {},
    );
    return onExperimentalChange(() => {
      setTransOn(isTransEnabled());
      setWtOn(isWebtoonEnabled());
    });
  }, []);
  // 开关中途关闭时退出选区模式。
  useEffect(() => {
    if (!transOn && regionRef.current) exitRegion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transOn]);
  const [regionMode, setRegionMode] = useState(false);
  const [selPx, setSelPx] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [ocrRes, setOcrRes] = useState<OcrResult | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [transRes, setTransRes] = useState<TranslateResult | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const selDragRef = useRef<{
    idx: number;
    el: DOMRect;
    ax: number;
    ay: number;
    pid: number;
  } | null>(null);
  const regionRef = useRef(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const hudHoverRef = useRef(false);
  const overlayRef = useRef(false);
  const requestedRef = useRef<Set<string>>(new Set());
  // 每页当前缓存图片对应的请求尺寸 key（`${idx}@${w}x${h}`），用于
  // 缩放/resize 后静默升级清晰度而不闪烁。
  const imgKeyRef = useRef<Record<number, string>>({});
  const uiLockRef = useRef(false);
  // 生效版式：按书记忆优先，否则全局偏好；条漫开关关闭或本书不支持条漫时回退到分页。
  const rawMode: PageMode = bookMode ?? prefs.mode;
  const webtoonAllowed = wtOn && (book?.webtoonReady !== false);
  const mode: PageMode =
    !webtoonAllowed && rawMode === "webtoon" ? prefs.mode : rawMode;
  const trackRef = useRef({
    book: null as BookInfo | null,
    page: 0,
    mode: "single" as PageMode,
    dir: "rtl" as Direction,
    zoom: 1,
    sizeTick: 0,
  });
  trackRef.current = {
    book,
    page,
    mode,
    dir: prefs.dir,
    zoom,
    sizeTick,
  };

  const n = book?.pageCount ?? 0;
  const spread = spreadFor(page, n, mode, prefs.dir);
  const solo = isSoloCover(spread, mode, prefs.dir);
  const canPrev = n > 0 && stepPage(page, n, mode, prefs.dir, -1) !== page;
  const canNext = n > 0 && stepPage(page, n, mode, prefs.dir, 1) !== page;
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
  const nextTitle = nextBook?.title ?? "待解析";

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
          toastErr("resolve_online_url", e);
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
          toast("没有找到下一话");
        }
      } catch (e) {
        toastErr("get_next_book", e);
      }
    } finally {
      setNextBusy(false);
    }
  }, [nav, nextBusy, nextBook, nextProbe.id, ws]);

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
    try {
      const saved = localStorage.getItem(`mr-wt-${bookId}`);
      setBookMode(saved === "webtoon" || saved === "single" || saved === "double" ? saved : null);
    } catch {
      setBookMode(null);
    }
    requestedRef.current.clear();
    api
      .getBook(bookId)
      .then(
        (b) => {
          if (!alive) return;
          if (!b || b.pageCount <= 0) {
            setBook(b ?? null);
            setBookState(b ? "ready" : "missing");
            return;
          }
          setBook(b);
          ws.reportBook(b.id, b.title);
          // 页码以「内存快照」与「后端 updated_at（set_progress 会刷新）」的较新者为准；
          // 版式/方向仍取快照，因为后端不存这两项。
          const snap = initialSnapRef.current;
          const snapNewer =
            snap !== null && snap.at >= progressUpdatedAt(b.updatedAt);
          const basePage = snapNewer ? snap.page : b.currentPage;
          const safePage = Math.max(0, Math.min(b.pageCount - 1, basePage));
          // 页目录跳转：?page=N（1-based）优先于阅读进度，只生效一次。
          const hashQuery = window.location.hash.includes("?")
            ? new URLSearchParams(window.location.hash.split("?")[1])
            : null;
          const requestedPage = hashQuery ? Number(hashQuery.get("page")) : NaN;
          const jumpRequested =
            Number.isInteger(requestedPage) &&
            requestedPage >= 1 &&
            requestedPage <= b.pageCount;
          const initialPage = jumpRequested ? requestedPage - 1 : safePage;
          if (jumpRequested) {
            window.history.replaceState(null, "", `#/reader/${encodeURIComponent(b.id)}`);
          }
          const basePct = snapNewer
            ? snap.mode === "webtoon"
              ? snap.scrollPct
              : -1
            : b.scrollPct;
          setPage(initialPage);
          setRestorePct(
            basePct >= 0 ? Math.min(1, Math.max(0, basePct)) : -1,
          );
          if (snap) {
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
          setBookState("ready");
        },
        (e) => {
          if (!alive) return;
          setBookState("missing");
          toastErr("get_book", e);
        },
      )
      .catch(() => {
        if (alive) setBookState("missing");
      });
    return () => {
      alive = false;
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
      if (tabOpen && (t.mode !== "webtoon" || wtKnownRef.current)) {
        ws.reportSnapshot(t.book.id, {
          page: livePage,
          scrollPct: livePct,
          mode: t.mode,
          dir: t.dir,
        });
      }
      if (t.mode !== "webtoon") {
        void api.setProgress(t.book.id, t.page).catch(() => {});
      }
    };
  }, [bookId]);

  /* ---------- viewport-sized request (dpr * zoom, capped 1920) ----------
     targetSize rounds to 64px buckets so pinch/zoom settling does not
     spam distinct get_page sizes (each is a separate cache key). */
  const targetSize = useCallback((): { w: number; h: number } => {
    const t = trackRef.current;
    const el = canvasRef.current;
    const vw = el?.clientWidth || window.innerWidth;
    const vh = el?.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const boost = t.zoom > 1.25 ? Math.min(t.zoom, 2) : 1;
    const per = spreadFor(t.page, t.book?.pageCount ?? 0, t.mode, t.dir).length;
    const bucket = (v: number) =>
      Math.min(MAX_EDGE, Math.max(64, Math.round(v / 64) * 64)) || 64;
    const w = bucket(((vw * dpr * boost) / Math.max(1, per)) || 0);
    const h = bucket(vh * dpr * boost);
    void t.sizeTick;
    return { w, h };
  }, []);

  const fetchIdx = useCallback(
    (idx: number, opts?: { silent?: boolean; force?: boolean }) => {
      const b = trackRef.current.book;
      if (!b || idx < 0 || idx >= b.pageCount) return;
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
          // 条漫自动建议：首屏出现 高/宽 > 3 的长条画面且本书未记忆过选择。
          // 实验开关关闭时不提示（isWebtoonEnabled 读镜像，避免闭包过期）。
          if (
            isWebtoonEnabled() &&
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
          if (!opts?.silent) toastErr("get_page", e);
        },
      );
    },
    [targetSize],
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
  }, [bookState, book, page, mode, prefs.dir, sizeTick]);

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
      const vis = new Set(spreadFor(t.page, n, t.mode, t.dir));
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
        .catch((e) => toastErr("set_progress", e));
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
    } catch {
      /* ignore */
    }
  }, [prefs]);

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
    const panel = ocrBusy || ocrRes !== null || transBusy || transRes !== null;
    const overlay =
      tocOpen || setOpen || panel || shortcutsOpen || moreOpen || tabsMenuOpen;
    overlayRef.current = overlay;
    uiLockRef.current = overlay || regionMode;
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
    regionMode,
    ocrBusy,
    ocrRes,
    transBusy,
    transRes,
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
      if (!t.book || t.book.pageCount === 0) return;
      if (t.mode === "webtoon") {
        wtHandle.current?.scrollByViewport(delta * 0.85);
        poke();
        return;
      }
      setPage((p) => stepPage(p, t.book!.pageCount, t.mode, t.dir, delta));
      setPan({ x: 0, y: 0 });
      poke();
    },
    [poke],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      const t = trackRef.current;
      if (!t.book || t.book.pageCount === 0) return;
      const target = Math.max(0, Math.min(t.book.pageCount - 1, idx));
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

  /* ---------- 版式（三态，按书记忆；条漫受实验开关与本书可用性门控） ---------- */
  const setMode = useCallback(
    (m: PageMode) => {
      if (m === "webtoon" && !webtoonAllowed) return;
      const t = trackRef.current;
      // 条漫 → 分页：带上滚动位置对应的页码，位置无缝衔接。
      if (t.mode === "webtoon" && m !== "webtoon" && t.book) {
        setPage(Math.max(0, Math.min(t.book.pageCount - 1, wtProgressRef.current.page)));
        setPan({ x: 0, y: 0 });
      }
      try {
        localStorage.setItem(`mr-wt-${bookId}`, m);
      } catch {
        /* 忽略 */
      }
      setBookMode(m);
      if (m !== "webtoon") setPrefs((p) => ({ ...p, mode: m }));
      setPan({ x: 0, y: 0 });
      poke();
    },
    [bookId, poke, webtoonAllowed],
  );

  const toggleMode = useCallback(() => {
    const cur = trackRef.current.mode;
    const canWebtoon = wtOn && book?.webtoonReady !== false;
    const cycle: PageMode[] = canWebtoon
      ? ["single", "double", "webtoon"]
      : ["single", "double"];
    const idx = cycle.indexOf(cur);
    setMode(cycle[(idx + 1) % cycle.length]);
  }, [setMode, wtOn, book]);

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
            .catch((e) => toastErr("set_progress", e));
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

  /* ---------- 阶段三:选区翻译动作 ---------- */
  // 请求序号:新动作/退出都会使在途请求的回包作废,防止旧结果覆盖新状态。
  const reqSeq = useRef(0);

  const exitRegion = useCallback(() => {
    reqSeq.current += 1;
    setRegionMode(false);
    setSelPx(null);
    selDragRef.current = null;
    setOcrRes(null);
    setTransRes(null);
    setOcrBusy(false);
    setTransBusy(false);
    regionRef.current = false;
    poke();
  }, [poke]);

  const toggleRegion = useCallback(() => {
    setMoreOpen(false);
    if (regionRef.current) {
      exitRegion();
    } else {
      setRegionMode(true);
      regionRef.current = true;
      setTocOpen(false);
      setSetOpen(false);
      poke();
    }
  }, [exitRegion, poke]);

  const runOcr = useCallback(
    (idx: number, rect: Rect) => {
      const seq = ++reqSeq.current;
      setOcrBusy(true);
      setOcrRes(null);
      setTransRes(null);
      api
        .ocrRegion(bookId, idx, rect)
        .then(
          (res) => {
            if (seq === reqSeq.current) setOcrRes(res);
          },
          (e) => {
            if (seq === reqSeq.current) toastErr("ocr_region", e);
          },
        )
        .finally(() => {
          if (seq === reqSeq.current) setOcrBusy(false);
        });
    },
    [bookId],
  );

  const doTranslate = useCallback(() => {
    if (!ocrRes?.text) return;
    const seq = ++reqSeq.current;
    setTransBusy(true);
    setTransRes(null);
    api
      .translateRegion(ocrRes.text)
      .then(
        (res) => {
          if (seq === reqSeq.current) setTransRes(res);
        },
        (e) => {
          if (seq === reqSeq.current) toastErr("translate_region", e);
        },
      )
      .finally(() => {
        if (seq === reqSeq.current) setTransBusy(false);
      });
  }, [ocrRes]);

  const copyOcr = useCallback(() => {
    const t = ocrRes?.text ?? transRes?.translated ?? "";
    if (!t) return;
    navigator.clipboard.writeText(t).then(
      () => toast("已复制"),
      () => toastErr("clipboard", "复制失败"),
    );
  }, [ocrRes, transRes]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      const tag = el?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (el?.isContentEditable ?? false)
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
        case "o":
        case "O":
          // 阶段三:选区翻译开关(带修饰键时不劫持,如 Ctrl+O);实验性关闭时失效。
          if (transOn && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            toggleRegion();
          }
          break;
        case "Escape":
          // 页签菜单开着先关菜单;选区开着先退选区,弹层开着先关弹层,否则返回书库。
          if (tabsMenuOpen) {
            setTabsMenuOpen(false);
          } else if (regionRef.current) {
            exitRegion();
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
          if (t.book) jumpTo(t.book.pageCount - 1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    go,
    jumpTo,
    toggleMode,
    toggleRegion,
    exitRegion,
    nav,
    transOn,
    showNextChapter,
    goNextChapter,
    ws,
    tabsMenuOpen,
  ]);

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
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0025));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return; // 条漫滚动容器自管
    // 阶段三:选区模式下,单指在页图上按下 → 开始框选(不影响双指缩放)。
    if (regionMode && e.pointerType !== "touch" && e.button === 0) {
      const img = (e.target as HTMLElement).closest("img");
      if (img) {
        // 捕获指针:拖到工具栏/浮层上松手也能收到 pointerup,避免状态卡死。
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const r = img.getBoundingClientRect();
        const p = normPoint(r, e.clientX, e.clientY);
        selDragRef.current = {
          idx: Number(img.dataset.idx),
          el: r,
          ax: p.x,
          ay: p.y,
          pid: e.pointerId,
        };
        setSelPx({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
        return;
      }
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    } else if (pointers.current.size === 1 && !selDragRef.current) {
      tap.current = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    }
    poke();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return;
    // 阶段三:框选拖动(不进入 pan/pinch 分支)。
    if (selDragRef.current && selDragRef.current.pid === e.pointerId) {
      const d = selDragRef.current;
      const p = normPoint(d.el, e.clientX, e.clientY);
      const r = rectFromPoints(d.ax, d.ay, p.x, p.y);
      setSelPx({
        left: d.el.left + r.x * d.el.width,
        top: d.el.top + r.y * d.el.height,
        width: r.w * d.el.width,
        height: r.h * d.el.height,
      });
      return;
    }
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
    } else if (trackRef.current.zoom > 1) {
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    poke();
  };

  const endPointer = (e: React.PointerEvent) => {
    if (trackRef.current.mode === "webtoon") return;
    // 阶段三:框选收尾 → 发起 OCR。
    if (selDragRef.current && selDragRef.current.pid === e.pointerId) {
      const d = selDragRef.current;
      selDragRef.current = null;
      setSelPx(null);
      const p = normPoint(d.el, e.clientX, e.clientY);
      const rect = rectFromPoints(d.ax, d.ay, p.x, p.y);
      if (isUsable(rect) && !Number.isNaN(d.idx)) runOcr(d.idx, rect);
      return;
    }
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
    poke();
  }, [poke]);

  /* ---------- toc ---------- */
  const openToc = () => {
    setShortcutsOpen(false);
    setSetOpen(false);
    setMoreOpen(false);
    setTocShown(200);
    setTocOpen((o) => !o);
    if ((!entries || entriesError) && !entriesLoading) {
      setEntriesLoading(true);
      setEntriesError(false);
      api.listEntries(bookId).then(
        (list) => {
          setEntries(list);
          setEntriesLoading(false);
        },
        (e) => {
          setEntriesLoading(false);
          setEntriesError(true);
          toastErr("list_entries", e);
        },
      );
    }
  };

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
      setScrub({ label: `第 ${idx + 1} 页`, thumb: imgs[idx] ?? null });
    },
    [mode, n, imgs],
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
    if (!b || idx < 0 || idx >= b.pageCount) return;
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

  const toggleSettings = useCallback(() => {
    setSetOpen((o) => !o);
    setTocOpen(false);
    setShortcutsOpen(false);
    setMoreOpen(false);
  }, []);  const toggleShortcuts = useCallback(() => {
    setShortcutsOpen((v) => !v);
    setTocOpen(false);
    setSetOpen(false);
    setMoreOpen(false);
  }, []);

  const dirRtl = prefs.dir === "rtl";
  const spreadSet = new Set(spread);
  // spreadFor 已是视觉左→右顺序，DOM 顺序即视觉顺序，不再翻转。
  const ordered = spread;

  return (
    <div className={`reader-root${uiVisible ? "" : " chrome-hidden"}`}>
      {/* canvas */}
      <div
        ref={canvasRef}
        className={`reader-canvas${regionMode ? " region-mode" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={resetView}
      >
        {bookState === "loading" ? (
          <div className="reader-center">
            <PixelPet mode="loading" message="正在打开" />
          </div>
        ) : bookState === "missing" || !book ? (
          <div className="reader-center">
            <div className="reader-err">
              <PixelPet mode="empty" message="没找到这本书" />
              <button onClick={() => nav("/")}>
                <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> 返回书库
              </button>
            </div>
          </div>
        ) : n === 0 ? (
          <div className="reader-center">
            <div className="reader-err">
              <PixelPet mode="empty" message="这本书没有可读页面" />
              <button onClick={() => nav("/")}>
                <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> 返回书库
              </button>
            </div>
          </div>
        ) : mode === "webtoon" && book ? (
          <WebtoonView
            ref={wtHandle}
            book={book}
            startPage={page}
            restorePct={restorePct}
            onProgress={commitWt}
            onTap={tapToggle}
            onScrollStart={handleWebtoonScrollStart}
          />
        ) : (
          <div
            className={`reader-pages${mode === "double" ? " reader-double" : ""}${solo ? " solo" : ""}`}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            }}
          >
            {ordered.map((idx) => (
              <div
                key={idx}
                className={`reader-cell${spread.length === 1 ? " solo-one" : ""}`}
              >
                {imgs[idx] ? (
                  <img
                    key={idx}
                    src={imgs[idx]}
                    alt={`第 ${idx + 1} 页`}
                    draggable={false}
                    className="reader-img fade-in"
                    data-idx={idx}
                    onDragStart={(e) => e.preventDefault()}
                  />
                ) : failed[idx] ? (
                  <div className="reader-err">
                    <PixelPet mode="empty" message={`第 ${idx + 1} 页缺页`} />
                    <button onClick={() => retryIdx(idx)}>
                      <RefreshCw size={14} style={{ verticalAlign: -2 }} /> 重试
                    </button>
                  </div>
                ) : (
                  <PixelPet mode="loading" message={`正在加载第 ${idx + 1} 页`} />
                )}
              </div>
            ))}
          </div>
        )}
        {selPx && (
          <div
            className="region-overlay"
            style={{
              left: selPx.left,
              top: selPx.top,
              width: selPx.width,
              height: selPx.height,
            }}
          />
        )}
      </div>

      {/* 顶部拖拽带：HUD 隐藏后仍能拖动窗口 / 从顶部边缘唤出 */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="absolute inset-x-0 top-0 z-20 h-2"
      />

      <ReaderHudTop
        title={book?.title ?? (bookState === "loading" ? "正在打开…" : "未知书籍")}
        zoom={zoom}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        hidden={!uiVisible}
        tabsSlot={
          ws.tabsEnabled ? (
            <TabSwitcher open={tabsMenuOpen} onOpenChange={setTabsMenuOpen} />
          ) : undefined
        }
        onBack={() => nav("/")}
        onZoom={(factor) =>
          zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor)
        }
        onReset={resetView}
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
        webtoonReason={
          wtOn ? "本书不支持条漫模式" : "条漫模式未开启（设置 → 实验性功能）"
        }
        onMode={setMode}
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
        transOn={transOn}
        regionMode={regionMode}
        onRegion={toggleRegion}
        regionDisabledReason={
          mode === "webtoon" ? "条漫模式暂不支持选区翻译" : null
        }
        slider={
          <ProgressScrubber
            value={sliderValue}
            max={sliderMax}
            min={0}
            step={1}
            disabled={n === 0}
            ariaLabel="阅读进度"
            preview={scrub}
            onScrub={onScrub}
            onCommit={onCommitScrub}
            className="mx-1"
          />
        }
        pageLabel={
          mode === "webtoon" ? (
            <>
              <span className="text-ink">
                {Math.round(wtProgress.pct * 100)}%
              </span>
              <span className="px-1 text-ink-muted/70">·</span>
              {Math.min(n, wtProgress.page + 1)}/{n}
            </>
          ) : (
            <>
              <span className="text-[13px] font-semibold text-ink">
                {n > 0 ? page + 1 : "–"}
              </span>
              <span className="px-0.5">/</span>
              {n > 0 ? n : "–"}
            </>
          )
        }
      />

      {/* 页目录面板：窗口化渲染（先 200 项，可继续加载） */}
      {tocOpen && (
        <div
          data-reader-hud
          className="glass hairline absolute right-3 top-16 bottom-24 z-40 flex w-[min(340px,86vw)] flex-col overflow-hidden rounded-xl text-ink shadow-2xl"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
            <span className="text-[12px] font-medium">页目录</span>
            <span className="mono text-[11px] text-ink-muted">
              {entries ? entries.length : "…"}
            </span>
            <button
              type="button"
              className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => setTocOpen(false)}
              aria-label="关闭页目录"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {entriesError ? (
              <ErrorState message="目录加载失败" onRetry={openToc} />
            ) : entriesLoading || !entries ? (
              <PixelPet mode="loading" message="正在加载目录" />
            ) : entries.length === 0 ? (
              <PixelPet mode="empty" message="暂无目录" />
            ) : (
              <>
                {entries.slice(0, tocShown).map((en) => (
                  <button
                    key={en.index}
                    type="button"
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md border border-transparent px-2 py-2 text-left text-[12px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                      spreadSet.has(en.index) && "border-brand/60 bg-accent",
                    )}
                    onClick={() => jumpTo(en.index)}
                    title={`跳到第 ${en.index + 1} 页`}
                  >
                    <span className="mono w-9 shrink-0 text-right text-[11px] text-brand">
                      {en.index + 1}
                    </span>
                    <span className="truncate text-ink-muted">{en.name}</span>
                  </button>
                ))}
                {entries.length > tocShown && (
                  <button
                    type="button"
                    className="mx-auto mt-1 flex min-h-8 w-fit items-center justify-center rounded-md border border-hairline px-3 text-[11px] text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    onClick={() => setTocShown((v) => v + 200)}
                  >
                    加载更多（剩余 {entries.length - tocShown} 页）
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 阅读设置面板（方向/版式/缩放；快捷键提示留在底部） */}
      {setOpen && (
        <div
          data-reader-hud
          className="glass hairline absolute bottom-20 left-1/2 z-40 flex w-[min(380px,92vw)] -translate-x-1/2 flex-col gap-3 rounded-xl p-3 text-ink shadow-2xl"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink-muted">版式</span>
            <div
              className="flex items-center gap-0.5 rounded-lg border border-hairline p-0.5"
              role="group"
              aria-label="版式"
            >
              {(wtOn && book?.webtoonReady !== false
                ? (["single", "double", "webtoon"] as const)
                : (["single", "double"] as const)
              ).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  className={cn(
                    "h-8 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                    mode === m
                      ? "bg-brand text-white"
                      : "text-ink-muted hover:bg-accent hover:text-ink",
                  )}
                  onClick={() => setMode(m)}
                >
                  {m === "single" ? "单页" : m === "double" ? "双页" : "条漫"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink-muted">翻页方向</span>
            <div
              className="flex items-center gap-0.5 rounded-lg border border-hairline p-0.5"
              role="group"
              aria-label="翻页方向"
            >
              <button
                type="button"
                aria-pressed={dirRtl}
                className={cn(
                  "h-8 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  dirRtl
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-accent hover:text-ink",
                )}
                onClick={() => setPrefs((p) => ({ ...p, dir: "rtl" }))}
              >
                日式右开
              </button>
              <button
                type="button"
                aria-pressed={!dirRtl}
                className={cn(
                  "h-8 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  !dirRtl
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-accent hover:text-ink",
                )}
                onClick={() => setPrefs((p) => ({ ...p, dir: "ltr" }))}
              >
                西式左开
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink-muted">
              缩放{" "}
              <span className="mono text-ink">{Math.round(zoom * 100)}%</span>
            </span>
            <input
              type="range"
              className="w-[150px] accent-brand"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(clampZoom(Number(e.currentTarget.value)))}
              aria-label="缩放"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            ←/→ 翻页（右开时 ← 为下一页）· Space 下一页 · Shift+Space 上一页
            <br />
            f 切换版式 · Ctrl+滚轮/双指缩放 · 拖拽平移 · 双击重置 · Esc 返回
          </p>
        </div>
      )}

      {/* 快捷键速查表（? 呼出） */}
      {shortcutsOpen && (
        <div
          data-reader-hud
          className="glass hairline absolute bottom-20 left-1/2 z-40 w-[min(380px,92vw)] -translate-x-1/2 rounded-xl p-3 text-ink shadow-2xl"
        >
          <h4 className="mb-2 text-[12px] font-semibold">快捷键速查</h4>
          <div className="flex flex-col gap-1">
            {READER_SHORTCUTS.map((s) => (
              <div key={s.keys} className="flex items-baseline gap-3 text-[12px]">
                <span className="mono min-w-[128px] shrink-0 font-semibold text-ink">
                  {s.keys}
                </span>
                <span className="text-ink-muted">{s.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showNextChapter && (
        <button
          data-reader-hud
          className="reader-next-pill"
          type="button"
          onClick={() => void goNextChapter()}
          disabled={nextBusy}
        >
          <span className="reader-next-kicker">本话已读完</span>
          <span className="reader-next-title">
            {nextBusy ? (
              <>
                <Loader2 size={14} className="rr-spin" />
                <span className="reader-next-name">正在载入下一话…</span>
              </>
            ) : (
              <>
                <span className="reader-next-name">下一话：{nextTitle}</span>
                <ArrowRight size={15} />
              </>
            )}
          </span>
        </button>
      )}

      {/* 阶段三:选区结果面板 */}
      {regionMode && (ocrBusy || ocrRes || transBusy || transRes) && (
        <div data-reader-hud className="reader-region fade-in">
          <div className="rr-head">
            <span>
              选区 OCR
              {ocrBusy ? " · 识别中…" : ocrRes ? ` · ${ocrRes.elapsedMs} ms` : ""}
            </span>
            <span style={{ display: "flex", gap: 2 }}>
              <button
                className="rbtn"
                onClick={copyOcr}
                title="复制"
                disabled={!ocrRes && !transRes}
              >
                <Copy size={14} />
              </button>
              <button className="rbtn" onClick={exitRegion} title="关闭并退出选区 (Esc)">
                <X size={14} />
              </button>
            </span>
          </div>
          <div className="rr-text mono">
            {ocrBusy ? "…" : ocrRes?.text || "未识别到文本"}
          </div>
          <div className="rr-actions">
            <button
              className="rbtn rr-translate"
              onClick={doTranslate}
              disabled={transBusy || !ocrRes?.text}
            >
              {transBusy ? <RefreshCw size={14} className="rr-spin" /> : <Languages size={14} />}
              {transBusy ? "翻译中…" : "翻译"}
            </button>
            {transRes && (
              <span className="rr-meta mono">
                {transRes.model} · {transRes.elapsedMs} ms
              </span>
            )}
          </div>
          {transRes && <div className="rr-text rr-trans">{transRes.translated}</div>}
        </div>
      )}

      {/* 条漫自动建议：检测到长条画面且本书未记忆过选择（受实验开关与本书可用性门控） */}
      {wtOn && book?.webtoonReady !== false && wtSuggest && mode !== "webtoon" && (
        <div data-reader-hud className="wt-suggest glass-bar fade-in">
          <span>检测到长条画面，是否切换条漫模式？</span>
          <button
            className="rbtn mono"
            style={{ fontSize: 11, padding: "5px 9px" }}
            onClick={() => {
              setMode("webtoon");
              setWtSuggest(false);
            }}
          >
            切换条漫
          </button>
          <button
            className="rbtn mono"
            style={{ fontSize: 11, padding: "5px 9px" }}
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
            保持分页
          </button>
        </div>
      )}

      <Toaster />
    </div>
  );
}
