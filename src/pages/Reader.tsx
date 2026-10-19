import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Languages,
  List,
  Minus,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import {
  isSoloCover,
  spreadFor,
  stepPage,
  type Direction,
  type PageMode,
} from "../components/Reader/spread";
import { READER_SHORTCUTS } from "../components/Reader/shortcuts";
import WebtoonView, { type WebtoonHandle } from "../components/Reader/Webtoon";
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
const HIDE_MS = 3000;
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
  // 条漫进度的 ref 镜像：setMode 切走时需要读最新页码而无依赖抖动。
  const wtProgressRef = useRef({ pct: 0, page: 0 });
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

  /* ---------- 阶段三:选区翻译 ---------- */
  // 实验性开关（镜像 + 后端刷新 + 订阅）：关闭时入口隐藏、快捷键失效。
  const [transOn, setTransOn] = useState(isTransEnabled());
  const [wtOn, setWtOn] = useState(isWebtoonEnabled());
  useEffect(() => {
    api.getSettings().catch(() => {});
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
  const regionPanelRef = useRef(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
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
          setPage(Math.max(0, Math.min(b.pageCount - 1, b.currentPage)));
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
      api.clearPages().catch(() => {});
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
      if (!uiLockRef.current) setUiVisible(false);
    }, HIDE_MS);
  }, []);

  useEffect(() => {
    const panel = regionPanelRef.current;
    overlayRef.current = tocOpen || setOpen || panel || shortcutsOpen;
    uiLockRef.current = tocOpen || setOpen || panel || shortcutsOpen;
    if (tocOpen || setOpen || panel || shortcutsOpen) {
      setUiVisible(true);
      window.clearTimeout(hideTimer.current);
    } else {
      poke();
    }
  }, [tocOpen, setOpen, shortcutsOpen, poke]);

  // 阶段三:选区结果面板开合同步进弹层锁。
  useEffect(() => {
    const panel = ocrBusy || ocrRes !== null || transBusy || transRes !== null;
    if (regionPanelRef.current !== panel) {
      regionPanelRef.current = panel;
      overlayRef.current = tocOpen || setOpen || panel;
      uiLockRef.current = tocOpen || setOpen || panel;
      if (panel) {
        setUiVisible(true);
        window.clearTimeout(hideTimer.current);
      }
    }
  }, [ocrBusy, ocrRes, transBusy, transRes, tocOpen, setOpen, poke]);

  useEffect(() => {
    poke();
    window.addEventListener("mousemove", poke);
    window.addEventListener("keydown", poke);
    return () => {
      window.removeEventListener("mousemove", poke);
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
  const commitWt = useCallback((pct: number, page: number) => {
    wtProgressRef.current = { pct, page };
    setWtProgress({ pct, page });
    // 同步本地 book：切模式/重进条漫时能立刻拿到最新位置。
    setBook((b) => (b ? { ...b, currentPage: page, scrollPct: pct } : b));
    const bb = trackRef.current.book;
    if (bb) api.setProgress(bb.id, page, pct).catch((e) => toastErr("set_progress", e));
  }, []);

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
    regionPanelRef.current = false;
    poke();
  }, [poke]);

  const toggleRegion = useCallback(() => {
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
      const tag = el?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (el?.isContentEditable ?? false)
      ) {
        return;
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
          go(fwd ? 1 : -1);
          break;
        }
        case " ":
          if (onBtn && el instanceof HTMLButtonElement) break;
          e.preventDefault();
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
          // 选区开着先退选区,弹层开着先关弹层,否则返回书库。
          if (regionRef.current) {
            exitRegion();
          } else if (overlayRef.current) {
            setTocOpen(false);
            setSetOpen(false);
            setShortcutsOpen(false);
          } else {
            nav("/");
          }
          break;
        case "?":
          // P1:快捷键速查表(设置页同源数据)。
          e.preventDefault();
          setShortcutsOpen((v) => !v);
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
  }, [go, jumpTo, toggleMode, toggleRegion, exitRegion, nav, transOn]);

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

  const onProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (n <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (trackRef.current.mode === "webtoon") {
      wtHandle.current?.scrollToPct(ratio);
      return;
    }
    jumpTo(Math.min(n - 1, Math.floor(ratio * n)));
  };

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

  const dirRtl = prefs.dir === "rtl";
  const NextIcon = dirRtl ? ChevronLeft : ChevronRight;
  const PrevIcon = dirRtl ? ChevronRight : ChevronLeft;
  const spreadSet = new Set(spread);
  // spreadFor 已是视觉左→右顺序，DOM 顺序即视觉顺序，不再翻转。
  const ordered = spread;

  return (
    <div className={`reader-root${uiVisible ? "" : " hidden"}`}>
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
            restorePct={book.scrollPct}
            onProgress={commitWt}
            onTap={tapToggle}
          />
        ) : (
          <div
            className={`reader-pages${mode === "double" ? " reader-double" : ""}${solo ? " solo" : ""}`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
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

      {/* top bar（decorations:false → 兼任拖拽标题栏：空白处可拖动/双击最大化） */}
      <div className="reader-top glass-bar" data-tauri-drag-region>
        <button className="rbtn" onClick={() => nav("/")} title="返回书库 (Esc)">
          <ArrowLeft size={16} />
        </button>
        <span className="reader-title">
          {book?.title ?? (bookState === "loading" ? "正在打开…" : "未知书籍")}
        </span>
        <span className="reader-zoomtag mono">{Math.round(zoom * 100)}%</span>
        <button
          className="rbtn"
          onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25)}
          disabled={zoom <= MIN_ZOOM + 1e-6}
          title="缩小"
        >
          <ZoomOut size={15} />
        </button>
        <button
          className="rbtn"
          onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25)}
          disabled={zoom >= MAX_ZOOM - 1e-6}
          title="放大"
        >
          <ZoomIn size={15} />
        </button>
        <button className="rbtn" onClick={resetView} title="重置视图（双击画布）">
          <RotateCcw size={14} />
        </button>
        <span className="tb-sep" aria-hidden />
        <button
          className="rbtn"
          title="最小化"
          aria-label="最小化"
          onClick={() => getCurrentWindow().minimize().catch(() => {})}
        >
          <Minus size={14} />
        </button>
        <button
          className="rbtn"
          title="最大化/还原"
          aria-label="最大化或还原"
          onClick={() => getCurrentWindow().toggleMaximize().catch(() => {})}
        >
          <Square size={11} />
        </button>
        <button
          className="rbtn"
          title="关闭"
          aria-label="关闭"
          onClick={() => getCurrentWindow().close().catch(() => {})}
        >
          <X size={14} />
        </button>
      </div>

      {/* bottom bar */}
      <div className="reader-bar glass-bar">
        {transOn && (
          <button
            className={`rbtn${regionMode ? " on" : ""}`}
            onClick={toggleRegion}
            disabled={mode === "webtoon"}
            title={mode === "webtoon" ? "条漫模式暂不支持选区翻译" : "选区翻译 (o)"}
          >
            <Languages size={16} />
          </button>
        )}
        <button
          className={`rbtn${setOpen ? " on" : ""}`}
          onClick={() => {
            setSetOpen((o) => !o);
            setTocOpen(false);
            setShortcutsOpen(false);
          }}
          title="阅读设置"
        >
          <Settings size={16} />
        </button>
        <button
          className={`rbtn${tocOpen ? " on" : ""}`}
          onClick={openToc}
          title="目录"
        >
          <List size={16} />
        </button>
        {mode === "webtoon" ? (
          <span className="r-pages mono">
            <span className="r-cur">{Math.round(wtProgress.pct * 100)}%</span>
            <span className="r-sep"> · </span>
            <span className="r-tot">
              {wtProgress.page + 1}/{n} 页
            </span>
          </span>
        ) : (
          <span className="r-pages mono">
            <span className="r-cur">{n > 0 ? page + 1 : "–"}</span>
            <span className="r-sep">/</span>
            <span className="r-tot">{n > 0 ? n : "–"}</span>
          </span>
        )}
        <div
          className="r-progress"
          role="slider"
          aria-label="阅读进度"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, n)}
          aria-valuenow={
            mode === "webtoon"
              ? Math.max(1, Math.round(wtProgress.pct * n) + 1)
              : Math.min(Math.max(1, page + 1), Math.max(1, n))
          }
          tabIndex={0}
          onClick={onProgressClick}
          onKeyDown={(e) => {
            // 全局已有 ←/→ 翻页；slider 内只处理 Home/End，避免双重 go()。
            if (e.key === "Home") {
              e.preventDefault();
              e.stopPropagation();
              jumpTo(0);
            } else if (e.key === "End") {
              e.preventDefault();
              e.stopPropagation();
              if (n > 0) jumpTo(n - 1);
            }
          }}
        >
          <div
            className="r-fill"
            style={{
              width:
                mode === "webtoon"
                  ? `${wtProgress.pct * 100}%`
                  : `${n > 0 ? ((page + 1) / n) * 100 : 0}%`,
            }}
          />
        </div>
        <button className="rbtn" onClick={() => go(-1)} disabled={!canPrev} title="上一页">
          <PrevIcon size={17} />
        </button>
        <button className="rbtn" onClick={() => go(1)} disabled={!canNext} title="下一页">
          <NextIcon size={17} />
        </button>
        <button
          className="rbtn mono"
          style={{ fontSize: 11, padding: "6px 9px" }}
          onClick={toggleMode}
          title="版式切换：单页 → 双页 → 条漫 (f)"
        >
          {mode === "single" ? "单页" : mode === "double" ? "双页" : "条漫"}
        </button>
      </div>

      {/* toc popover */}
      {tocOpen && (
        <div className="reader-toc fade-in">
          <h4>
            目录 <span className="mono">{entries ? entries.length : "…"}</span>
            <button className="rbtn" onClick={() => setTocOpen(false)} title="关闭">
              <X size={14} />
            </button>
          </h4>
          {entriesError ? (
            <ErrorState message="目录加载失败" onRetry={openToc} />
          ) : entriesLoading || !entries ? (
            <PixelPet mode="loading" message="正在加载目录" />
          ) : entries.length === 0 ? (
            <PixelPet mode="empty" message="暂无目录" />
          ) : (
            entries.map((en) => (
              <button
                key={en.index}
                className={`toc-item${spreadSet.has(en.index) ? " hit" : ""}`}
                onClick={() => jumpTo(en.index)}
                title={`跳到第 ${en.index + 1} 页`}
              >
                <span className="idx mono">{en.index + 1}</span>
                <span className="nm">{en.name}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* settings popover */}
      {setOpen && (
        <div className="reader-set fade-in">
          <div className="set-row">
            <span>版式</span>
            <div className="seg-dark" role="group" aria-label="版式">
              {(wtOn && book?.webtoonReady !== false
                ? (["single", "double", "webtoon"] as const)
                : (["single", "double"] as const)
              ).map((m) => (
                <button
                  key={m}
                  className={mode === m ? "on" : ""}
                  onClick={() => setMode(m)}
                >
                  {m === "single" ? "单页" : m === "double" ? "双页" : "条漫"}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <span>翻页方向</span>
            <div className="seg-dark" role="group" aria-label="翻页方向">
              <button
                className={dirRtl ? "on" : ""}
                onClick={() => setPrefs((p) => ({ ...p, dir: "rtl" }))}
              >
                日式右开
              </button>
              <button
                className={!dirRtl ? "on" : ""}
                onClick={() => setPrefs((p) => ({ ...p, dir: "ltr" }))}
              >
                西式左开
              </button>
            </div>
          </div>
          <div className="set-row">
            <span>
              缩放 <span className="mono">{Math.round(zoom * 100)}%</span>
            </span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(clampZoom(Number(e.currentTarget.value)))}
              aria-label="缩放"
            />
          </div>
          <div className="set-hint">
            ←/→ 翻页（右开时 ← 为下一页）· Space 下一页 · Shift+Space 上一页
            <br />
            f 单双页切换 · Ctrl+滚轮/双指缩放 · 拖拽平移 · 双击重置 · Esc 返回
          </div>
        </div>
      )}

      {/* 快捷键速查表(P1,? 呼出) */}
      {shortcutsOpen && (
        <div className="reader-set fade-in">
          <h4 style={{ marginTop: 0 }}>快捷键速查</h4>
          <div className="sc-list">
            {READER_SHORTCUTS.map((s) => (
              <div className="sc-row" key={s.keys}>
                <span className="mono sc-keys">{s.keys}</span>
                <span className="sc-action">{s.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 阶段三:选区结果面板 */}
      {regionMode && (ocrBusy || ocrRes || transBusy || transRes) && (
        <div className="reader-region fade-in">
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
        <div className="wt-suggest glass-bar fade-in">
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
