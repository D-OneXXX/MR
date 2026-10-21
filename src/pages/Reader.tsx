import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Info,
  Loader2,
  Maximize2,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  api,
  isWebtoonEnabled,
  onExperimentalChange,
  type BookInfo,
  type PageEntry,
} from "../lib/tauri";
import { cn } from "@/lib/utils";
import PixelPet from "../components/PixelPet";
import ErrorState from "../components/ErrorState";
import { Toaster, toast, toastErr } from "../components/Toast";
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
import "../components/Reader.css";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_EDGE = 1920;
const HIDE_MS = 1500;
const SAVE_DEBOUNCE_MS = 500;

const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const sliderNumber = (v: number | readonly number[]): number =>
  Array.isArray(v) ? Number(v[0]) : Number(v);

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

  const [tocQuery, setTocQuery] = useState("");
  const [jumpPage, setJumpPage] = useState("");

  const [wtOn, setWtOn] = useState(isWebtoonEnabled());
  useEffect(() => {
    // 首次读取会刷新 localStorage 镜像；镜像就绪后回灌，避免首启动时开关已开但按钮仍禁用。
    api.getSettings().then(
      () => {
        setWtOn(isWebtoonEnabled());
      },
      () => {},
    );
    return onExperimentalChange(() => {
      setWtOn(isWebtoonEnabled());
    });
  }, []);

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
    const overlay =
      tocOpen || setOpen || shortcutsOpen || moreOpen || tabsMenuOpen;
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
    nav,
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
    } else if (trackRef.current.zoom > 1) {
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
    poke();
  }, [poke]);

  /* ---------- toc ---------- */
  const loadEntries = () => {
    if (entriesLoading) return;
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
  };

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
  }, []);
  const toggleShortcuts = useCallback(() => {
    setShortcutsOpen((v) => !v);
    setTocOpen(false);
    setSetOpen(false);
    setMoreOpen(false);
  }, []);

  const dirRtl = prefs.dir === "rtl";
  const webtoonReason = wtOn
    ? "本书不支持条漫模式"
    : "条漫模式未开启（设置 → 实验性功能）";
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
        className="reader-canvas"
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
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> 返回书库
              </Button>
            </div>
          </div>
        ) : n === 0 ? (
          <div className="reader-center">
            <div className="reader-err">
              <PixelPet mode="empty" message="这本书没有可读页面" />
              <Button variant="pill" size="pill-sm" onClick={() => nav("/")}>
                <ArrowLeft className="size-3.5" /> 返回书库
              </Button>
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
                    <Button
                      variant="pill"
                      size="pill-sm"
                      onClick={() => retryIdx(idx)}
                    >
                      <RefreshCw className="size-3.5" /> 重试
                    </Button>
                  </div>
                ) : (
                  <PixelPet mode="loading" message={`正在加载第 ${idx + 1} 页`} />
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
        webtoonReason={webtoonReason}
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
              <SheetTitle className="text-sm font-bold">页目录</SheetTitle>
              <Badge
                variant="secondary"
                className="mono border-border/60 px-2 py-0.5 text-[10px]"
              >
                {entries ? filteredEntries.length : "…"}
              </Badge>
            </div>
            <SheetDescription className="text-[11px] text-muted-foreground">
              搜索页码或文件名，点击条目跳转。
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
                placeholder="搜索页码或文件名"
                aria-label="搜索页目录"
                className="h-9 bg-background/40 pl-9 text-xs"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1 px-2">
            <div className="flex flex-col gap-0.5 pb-3">
              {entriesError ? (
                <ErrorState message="目录加载失败" onRetry={loadEntries} />
              ) : entriesLoading || !entries ? (
                <div className="flex min-h-48 items-center justify-center">
                  <PixelPet mode="loading" message="正在加载目录" />
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex min-h-48 items-center justify-center">
                  <PixelPet mode="empty" message="没有匹配的页" />
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
                      title={`跳到第 ${en.index + 1} 页`}
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
                      加载更多（剩余 {filteredEntries.length - tocShown} 页）
                    </Button>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
            <span className="text-[11px] text-muted-foreground">跳至</span>
            <Input
              type="number"
              min={1}
              max={Math.max(1, n)}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPageJump();
              }}
              aria-label="跳至页码"
              placeholder="页码"
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
              跳转
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
              阅读设置
            </DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              版式、方向与缩放即时生效。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">版式</span>
              <div
                className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                role="group"
                aria-label="版式"
              >
                {(
                  [
                    { key: "single", label: "单页" },
                    { key: "double", label: "双页" },
                    { key: "webtoon", label: "条漫" },
                  ] as const
                ).map(({ key, label }) => {
                  const disabled = key === "webtoon" && !webtoonAllowed;
                  return (
                    <Button
                      key={key}
                      type="button"
                      variant={mode === key ? "pill-primary" : "pill-ghost"}
                      size="pill-sm"
                      aria-pressed={mode === key}
                      disabled={disabled}
                      title={disabled ? webtoonReason : `切换到${label}`}
                      onClick={() => setMode(key)}
                      className="h-8 px-2.5 text-[11px]"
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">翻页方向</span>
              <div
                className="flex items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
                role="group"
                aria-label="翻页方向"
              >
                <Button
                  type="button"
                  variant={dirRtl ? "pill-primary" : "pill-ghost"}
                  size="pill-sm"
                  aria-pressed={dirRtl}
                  onClick={() => setPrefs((p) => ({ ...p, dir: "rtl" }))}
                  className="h-8 px-2.5 text-[11px]"
                >
                  日式右开
                </Button>
                <Button
                  type="button"
                  variant={!dirRtl ? "pill-primary" : "pill-ghost"}
                  size="pill-sm"
                  aria-pressed={!dirRtl}
                  onClick={() => setPrefs((p) => ({ ...p, dir: "ltr" }))}
                  className="h-8 px-2.5 text-[11px]"
                >
                  西式左开
                </Button>
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">缩放</span>
                <span className="mono text-xs tabular-nums text-foreground">
                  {Math.round(zoom * 100)}%
                </span>
              </div>
              <Slider
                value={[zoom]}
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.1}
                aria-label="缩放"
                getAriaLabel={() => "缩放"}
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
                适应画布
              </Button>
            </div>

            {!webtoonAllowed && (
              <p className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                {wtOn
                  ? "本书不支持条漫模式。"
                  : "条漫模式未开启，可在 设置 → 实验性功能 中打开。"}
              </p>
            )}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              ←/→ 翻页（右开时 ← 为下一页）· Space 下一页 · Shift+Space 上一页
              <br />
              f 切换版式 · Ctrl+滚轮/双指缩放 · 拖拽平移 · 双击重置 · Esc 返回
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
            <DialogTitle className="text-sm font-bold">快捷键速查</DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground">
              阅读态快捷键（与设置页同源）。
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[min(72vh,560px)] px-4 py-3">
            <div className="flex flex-col gap-1 pb-2">
              {READER_SHORTCUTS.map((s) => (
                <div
                  key={s.keys}
                  className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-[12px] odd:bg-muted/40"
                >
                  <kbd className="mono min-w-[124px] shrink-0 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                    {s.keys}
                  </kbd>
                  <span className="text-muted-foreground">{s.action}</span>
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
                本话已读完
              </Badge>
              <span className="block truncate text-[13px] font-semibold">
                {nextBusy ? "正在载入下一话…" : `下一话：${nextTitle}`}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {nextBusy ? "正在解析章节链接" : "前往下一话"}
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

      {/* 条漫自动建议：检测到长条画面且本书未记忆过选择（受实验开关与本书可用性门控） */}
      {wtOn && book?.webtoonReady !== false && wtSuggest && mode !== "webtoon" && (
        <div
          data-reader-hud
          className="fade-in absolute bottom-24 left-1/2 z-30 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-border/80 bg-card/95 py-2 pl-4 pr-2 text-card-foreground shadow-hard-sm backdrop-blur-md"
        >
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            检测到长条画面，是否切换条漫模式？
          </span>
          <Button
            variant="pill-primary"
            size="pill-sm"
            onClick={() => {
              setMode("webtoon");
              setWtSuggest(false);
            }}
          >
            切换条漫
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
            保持分页
          </Button>
        </div>
      )}

      <Toaster />
    </div>
  );
}
