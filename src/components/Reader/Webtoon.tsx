import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  WEBTOON_TILE_H,
  type BookInfo,
  type PageDim,
} from "../../lib/tauri";
import ErrorState from "../ErrorState";
import PixelPet from "../PixelPet";
import { useI18n } from "@/i18n";

export interface WebtoonHandle {
  scrollToPct: (pct: number) => void;
  scrollToPage: (page: number) => void;
  scrollByViewport: (screens: number) => void;
  /** 最新滚动位置（卸载落快照用，避免 400ms 节流窗口丢失）。 */
  getProgress: () => { pct: number; page: number };
}

interface Props {
  book: BookInfo;
  /** 进入条漫时所在的页码（用于分页→条漫的位置衔接）。 */
  startPage: number;
  /** 恢复的滚动百分比（-1 = 无从条漫记录恢复，走 startPage）。 */
  restorePct: number;
  /** 条漫阅读宽度（视口宽度的百分比，50..150）。 */
  widthPct: number;
  /** 宽度变更（Ctrl+滚轮 / 双指捏合 / 设置滑杆）。 */
  onWidthChange: (pct: number) => void;
  /** 滚动进度提交（组件内 400ms 节流 + 卸载时立即）。 */
  onProgress: (pct: number, page: number, persist?: boolean) => void;
  /** 单击画面（非拖动）切换控制条。 */
  onTap: () => void;
  /** 滚动开始（HUD 立即隐藏用；内部 150ms 节流，不影响进度节流）。 */
  onScrollStart?: () => void;
  /** React 19：ref 作为普通 prop 透传。 */
  ref?: React.Ref<WebtoonHandle>;
}

interface PageLayout {
  dispH: number; // CSS 高度（宽 = 内容宽）
  tiles: number; // 切片数（与后端同公式，键含渲染宽）
  start: number; // CSS 顶部偏移（页级前缀和）
}

interface StripLayout {
  pages: PageLayout[];
  total: number;
  contentWidth: number;
}

/** 挂载/请求窗口：视口上方 2 屏 ~ 下方 3 屏。 */
const MOUNT_BACK_SCREENS = 2;
const MOUNT_AHEAD_SCREENS = 3;
/** 已解码数据保留窗口：视口上下各 5 屏。 */
const KEEP_SCREENS = 5;
/** 进度提交节流（沿用旧行为）。 */
const PROGRESS_COMMIT_MS = 400;
/** 预解码超时：超时也提交（宁可闪一下也不让页面卡死在空白）。 */
const DECODE_TIMEOUT_MS = 2000;
/** 后台预切：本地近前 3 页最优先，向前最多扫 10 页；在线源收紧。 */
const PREFETCH_NEAR = 3;
const PREFETCH_SWEEP = 10;
/** 尺寸兜底：宽高缺失时使用上一张有效页比例，否则 1:2.5。 */
const FALLBACK_RATIO = 2.5;
const MIN_WIDTH_PCT = 50;
const MAX_WIDTH_PCT = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** 前缀高度二分：返回 y 落在的页（越界钳到最后/第一页）。O(log n)。 */
function pageIndexAt(pages: readonly PageLayout[], y: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= y) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 页内切片边界取整：相邻切片共享同一条整数像素线，
 * 避免小数 top/height 被浏览器分别舍入后出现 1px 交替缝隙。
 */
function tileTopAt(p: PageLayout, tile: number): number {
  return p.start + Math.round((tile * p.dispH) / p.tiles);
}
function tileHeightAt(p: PageLayout, tile: number): number {
  return tileTopAt(p, tile + 1) - tileTopAt(p, tile);
}

/** 视口中心（页 + 页内比例），按给定布局计算。 */
function centerAnchor(
  layout: StripLayout,
  top: number,
  vh: number,
): { page: number; frac: number } {
  if (layout.pages.length === 0) return { page: 0, frac: 0 };
  const mid = top + vh * 0.5;
  const page = pageIndexAt(layout.pages, mid);
  const p = layout.pages[page];
  return {
    page,
    frac: p && p.dispH > 0 ? clamp((mid - p.start) / p.dispH, 0, 1) : 0,
  };
}

/** 先让浏览器解码 dataURL，再进 React 状态，避免插入时白闪。 */
function predecode(src: string, timeoutMs = DECODE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    timer = window.setTimeout(done, timeoutMs);
    img.onload = () => {
      if (typeof img.decode === "function") img.decode().then(done, done);
      else done();
    };
    img.onerror = done;
    img.src = src;
  });
}

/**
 * 条漫视图（整话纵向连滚）：
 * - 布局 = get_webtoon_layout 的源尺寸 → 固定高度占位（fit-width），切片数与后端同公式；
 * - 虚拟化：总高由绝对定位占位撑起；只为视口 [-2, +3] 屏内的切片创建 DOM，
 *   已解码数据保留在视口 ±5 屏，滚出即释放；100+ 页章节不会产生全量节点；
 * - 切片由后端按显示宽度降采样解码后均分（≤2048px/片），整张长图永不进浏览器；
 * - 进度/当前页 = 视口中心，页级前缀高度 + 二分查找；
 * - 宽度 50%..150%：Ctrl/Cmd+滚轮与双指捏合可调，宽度变化时保持视口中心页与页内比例；
 * - 恢复：条漫记录优先，否则用进入时的页码。
 */
const WebtoonView = memo(function WebtoonView({
  book,
  startPage,
  restorePct,
  widthPct,
  onWidthChange,
  onProgress,
  onTap,
  onScrollStart,
  ref,
}: Props) {
  const { t } = useI18n();
  const [dims, setDims] = useState<PageDim[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  // 渲染窗口（绝对像素，向下取整/向上取整到 64px，减少滚动期重渲染）。
  const [win, setWin] = useState({ lo: 0, hi: 0 });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const requestedRef = useRef<Set<string>>(new Set());
  const restoreDone = useRef(false);
  const rafRef = useRef(0);
  const progressTimer = useRef(0);
  const scrollNotifyRef = useRef(0);
  const lastProgress = useRef({ pct: 0, page: startPage });
  // 视口中心锚点（页 + 页内比例），宽度/视口变化后按新布局还原。
  const anchorRef = useRef({ page: startPage, frac: 0 });
  // 顶/底边缘：宽度变化时保持贴边，不因中心锚点被钳制而回弹。
  const edgeRef = useRef({ top: true, bottom: false });
  // 上一次同步时的布局 / 滚动位置：宽度变化时用它从当前 scrollTop 重算旧锚点。
  const measuredRef = useRef<{
    layout: StripLayout | null;
    top: number;
    vh: number;
  }>({ layout: null, top: 0, vh: 0 });
  const layoutSigRef = useRef({ cw: 0, vh: 0 });
  const tapRef = useRef({ x: 0, y: 0, t: 0, id: -1 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef({ dist: 0, width: 100 });
  // 后台预切：已完成物化的页 + 代际（book/W 变化时让旧循环退出）。
  const doneRef = useRef<Set<number>>(new Set());
  const prefetchGen = useRef(0);
  // 请求代际：换书/换渲染宽/卸载后，旧请求结果一律丢弃。
  const requestGen = useRef(0);
  // 滚动请求队列：只保留最新视口，空闲 120ms 后开泵；最多 4 个在途，
  // 避免快速滚动时把几十个过期窗口排在前后端串行队列里。
  const queueRef = useRef<
    Array<{ i: number; tile: number; key: string; epoch: number }>
  >([]);
  const queueEpoch = useRef(0);
  const inflightRef = useRef(0);
  const pumpTimer = useRef(0);
  const tilesRef = useRef<Record<string, string>>({});
  const failedRef = useRef<Record<string, true>>({});

  // 程序化滚动（恢复/跳页/宽度锚定）产生的 scroll 事件不要重复提交进度。
  const programmaticScroll = useRef(false);
  // 换书/换渲染宽清空缓存后，下一次窗口同步必须强制重新请求（不能信旧 tiles 闭包）。
  const forceFetchRef = useRef(false);
  // 当前布局的保留窗口（绝对像素），预取结果超出即丢弃，避免无界缓存。
  const layoutRef = useRef<StripLayout | null>(null);
  const keepRef = useRef({ lo: -Infinity, hi: Infinity });

  const pct = clamp(Number.isFinite(widthPct) ? widthPct : 100, MIN_WIDTH_PCT, MAX_WIDTH_PCT);
  const widthRef = useRef(pct);
  widthRef.current = pct;

  /* ---------- 布局加载（后端有缓存，二次切换瞬时） ---------- */
  useEffect(() => {
    let alive = true;
    setDims(null);
    setErr(null);
    setWin({ lo: 0, hi: 0 });
    restoreDone.current = false;
    lastProgress.current = { pct: 0, page: startPage };
    anchorRef.current = { page: startPage, frac: 0 };
    api
      .getWebtoonLayout(book.id)
      .then((d) => alive && setDims(d))
      .catch((e) => {
        if (!alive) return;
        setErr(
          typeof e === "string" && e
            ? e
            : t("reader.webtoon.unknownError"),
        );
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  /* ---------- 容器尺寸 ---------- */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setViewport((prev) =>
        prev.w === w && prev.h === h ? prev : { w, h },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vw = viewport.w;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  // 切片渲染宽度跟随容器（设备像素，64 桶）；宽度偏好只做显示缩放，不触发重新切片。
  const W = useMemo(() => {
    const raw = Math.round((vw * dpr) / 64) * 64;
    return Math.min(2160, Math.max(320, raw)) || 640;
  }, [vw, dpr]);

  const layout = useMemo<StripLayout | null>(() => {
    if (!dims || dims.length === 0 || vw <= 0) return null;
    const contentWidth = Math.max(1, Math.round((vw * pct) / 100));
    const pages: PageLayout[] = [];
    let ratioFallback = FALLBACK_RATIO;
    let acc = 0;
    for (const d of dims) {
      const valid =
        Number.isFinite(d.width) &&
        Number.isFinite(d.height) &&
        d.width > 0 &&
        d.height > 0;
      const ratio = valid ? d.height / d.width : ratioFallback;
      if (valid) ratioFallback = ratio;
      // 显示高度取整：页起点/切片边界都是整数，缩放/加载都不会产生亚像素缝。
      const dispH = Math.max(1, Math.round(ratio * contentWidth));
      const tiles = Math.max(1, Math.ceil((ratio * W) / WEBTOON_TILE_H));
      pages.push({ dispH, tiles, start: acc });
      acc += dispH;
    }
    return { pages, total: acc, contentWidth };
  }, [dims, vw, pct, W]);
  layoutRef.current = layout;

  /* ---------- 换书 / 渲染宽变化：清空切片缓存并让旧请求失效 ---------- */
  useEffect(() => {
    requestGen.current += 1;
    prefetchGen.current += 1;
    queueEpoch.current += 1;
    queueRef.current = [];
    if (pumpTimer.current) {
      window.clearTimeout(pumpTimer.current);
      pumpTimer.current = 0;
    }
    requestedRef.current.clear();
    doneRef.current = new Set();
    forceFetchRef.current = true;
    setTiles({});
    setFailed({});
  }, [book.id, W]);

  /* ---------- 切片获取：预解码后入状态，结果按代际/窗口校验 ---------- */
  const loadTile = useCallback(
    async (
      i: number,
      tile: number,
      _epoch: number | null = null,
    ): Promise<boolean> => {
      const key = `${i}:${tile}`;
      if (requestedRef.current.has(key)) return false;
      requestedRef.current.add(key);
      const gen = requestGen.current;
      // 在途请求不按滚动代际作废：它最多占 4 个槽位，完成后若仍在保留
      // 窗口内就复用；旧队列本身已在 ensureTiles 中被整体替换。
      const stale = () => gen !== requestGen.current;
      try {
        const img = await api.getWebtoonTile(book.id, i, tile, W);
        if (stale()) {
          requestedRef.current.delete(key);
          return false;
        }
        await predecode(img.dataUrl);
        if (stale()) {
          requestedRef.current.delete(key);
          return false;
        }
        // 等待期间可能已滚出保留窗口：丢弃结果，避免缓存无界增长。
        if (!requestedRef.current.has(key)) return false;
        const lay = layoutRef.current;
        const p = lay?.pages[i];
        if (p) {
          const top = tileTopAt(p, tile);
          const bottom = top + tileHeightAt(p, tile);
          if (bottom < keepRef.current.lo || top > keepRef.current.hi) {
            requestedRef.current.delete(key);
            return false;
          }
        }
        setTiles((prev) =>
          prev[key] !== undefined ? prev : { ...prev, [key]: img.dataUrl },
        );
        return true;
      } catch {
        if (stale()) {
          requestedRef.current.delete(key);
          return false;
        }
        requestedRef.current.delete(key);
        setFailed((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
        return false;
      }
    },
    [book.id, W],
  );

  tilesRef.current = tiles;
  failedRef.current = failed;

  const pumpQueue = useCallback(() => {
    if (pumpTimer.current) return;
    pumpTimer.current = window.setTimeout(() => {
      pumpTimer.current = 0;
      const run = () => {
        while (inflightRef.current < 4 && queueRef.current.length > 0) {
          const job = queueRef.current.shift();
          if (!job) break;
          if (job.epoch !== queueEpoch.current) continue;
          if (
            tilesRef.current[job.key] !== undefined ||
            failedRef.current[job.key]
          ) {
            continue;
          }
          inflightRef.current += 1;
          void loadTile(job.i, job.tile, job.epoch).finally(() => {
            inflightRef.current = Math.max(0, inflightRef.current - 1);
            run();
          });
        }
      };
      run();
    }, 120);
  }, [loadTile]);

  /* ---------- 窗口内请求 + 保留窗口外释放（只遍历窗口页） ---------- */
  const ensureTiles = useCallback(
    (top: number, vhNow: number) => {
      if (!layout || layout.pages.length === 0) return;
      const keepLo = top - vhNow * KEEP_SCREENS;
      const keepHi = top + vhNow * KEEP_SCREENS;
      const fetchLo = top - vhNow * MOUNT_BACK_SCREENS;
      const fetchHi = top + vhNow * MOUNT_AHEAD_SCREENS;
      keepRef.current = { lo: keepLo, hi: keepHi };
      const force = forceFetchRef.current;
      forceFetchRef.current = false;

      const inKeep = (key: string): boolean => {
        const [i, tile] = key.split(":").map(Number);
        const p = layout.pages[i];
        if (!p || !Number.isInteger(tile) || tile < 0 || tile >= p.tiles) {
          return false;
        }
        const tileTop = tileTopAt(p, tile);
        return (
          tileTop + tileHeightAt(p, tile) >= keepLo && tileTop <= keepHi
        );
      };

      setTiles((prev) => {
        let dropped = false;
        const next: Record<string, string> = {};
        for (const key of Object.keys(prev)) {
          if (inKeep(key)) {
            next[key] = prev[key];
          } else {
            dropped = true;
            requestedRef.current.delete(key);
          }
        }
        return dropped ? next : prev;
      });
      setFailed((prev) => {
        let dropped = false;
        const next: Record<string, true> = {};
        for (const key of Object.keys(prev)) {
          if (inKeep(key)) next[key] = true;
          else dropped = true;
        }
        return dropped ? next : prev;
      });

      const first = pageIndexAt(layout.pages, Math.max(0, fetchLo));
      const last = pageIndexAt(
        layout.pages,
        Math.min(layout.total - 0.001, Math.max(0, fetchHi)),
      );
      queueEpoch.current += 1;
      const epoch = queueEpoch.current;
      const nextQueue: Array<{
        i: number;
        tile: number;
        key: string;
        epoch: number;
      }> = [];
      for (let i = first; i <= last; i++) {
        const p = layout.pages[i];
        if (!p || p.dispH <= 0) continue;
        const tileH = p.dispH / p.tiles;
        const lo = Math.max(0, Math.floor((fetchLo - p.start) / tileH));
        const hi = Math.min(
          p.tiles - 1,
          Math.floor((fetchHi - p.start) / tileH),
        );
        for (let tile = lo; tile <= hi; tile++) {
          const key = `${i}:${tile}`;
          if (
            force ||
            (tiles[key] === undefined && failed[key] === undefined)
          ) {
            nextQueue.push({ i, tile, key, epoch });
          }
        }
      }
      // 最新视口整体替换旧队列：滚动过程中不堆积过期窗口。
      queueRef.current = nextQueue;
      if (nextQueue.length > 0) pumpQueue();
    },
    [layout, tiles, failed, pumpQueue],
  );

  /* ---------- 进度提交 ---------- */
  const commitProgress = useCallback(() => {
    const { pct: p, page } = lastProgress.current;
    onProgress(p, page);
  }, [onProgress]);

  /* ---------- 滚动：当前页 = 视口中心；同步窗口/进度 ---------- */
  const syncFromScroll = useCallback(
    (schedule = true) => {
      const el = scrollerRef.current;
      if (!el || !layout || layout.pages.length === 0) return;
      const top = el.scrollTop;
      const vhNow = el.clientHeight;
      const anchor = centerAnchor(layout, top, vhNow);
      anchorRef.current = anchor;
      const max = Math.max(1, layout.total - vhNow);
      lastProgress.current = {
        pct: clamp(top / max, 0, 1),
        page: anchor.page,
      };
      const rawMax = Math.max(0, layout.total - vhNow);
      edgeRef.current = {
        top: top <= 0.5,
        bottom: top >= rawMax - 0.5,
      };
      measuredRef.current = { layout, top, vh: vhNow };

      const lo = Math.max(
        0,
        Math.floor((top - vhNow * MOUNT_BACK_SCREENS) / 64) * 64,
      );
      const hi = Math.min(
        layout.total,
        Math.ceil((top + vhNow * MOUNT_AHEAD_SCREENS) / 64) * 64,
      );
      setWin((prev) => (prev.lo === lo && prev.hi === hi ? prev : { lo, hi }));

      ensureTiles(top, vhNow);
      if (schedule) {
        window.clearTimeout(progressTimer.current);
        progressTimer.current = window.setTimeout(
          commitProgress,
          PROGRESS_COMMIT_MS,
        );
      }
    },
    [layout, ensureTiles, commitProgress],
  );
  const syncRef = useRef(syncFromScroll);
  syncRef.current = syncFromScroll;

  const onScroll = useCallback(() => {
    // 滚动开始 → 通知外层立即隐藏 HUD（150ms 节流，避免每帧回调）。
    if (onScrollStart) {
      const now = performance.now();
      if (now - scrollNotifyRef.current > 150) {
        scrollNotifyRef.current = now;
        onScrollStart();
      }
    }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const suppress = programmaticScroll.current;
      programmaticScroll.current = false;
      syncFromScroll(!suppress);
    });
  }, [onScrollStart, syncFromScroll]);

  /* ---------- 程序化滚动：记录标记，避免 scroll 事件重复提交 ---------- */
  const applyScrollTop = useCallback(
    (target: number) => {
      const el = scrollerRef.current;
      if (!el || !layout) return;
      const maxTop = Math.max(0, layout.total - el.clientHeight);
      const before = el.scrollTop;
      el.scrollTop = clamp(target, 0, maxTop);
      if (el.scrollTop !== before) programmaticScroll.current = true;
    },
    [layout],
  );

  /* ---------- 恢复位置：条漫记录优先，否则用进入时的页码 ---------- */
  useLayoutEffect(() => {
    if (!layout || restoreDone.current) return;
    const el = scrollerRef.current;
    if (!el || layout.pages.length === 0) return;
    const maxTop = Math.max(0, layout.total - el.clientHeight);
    let target = 0;
    if (restorePct >= 0) {
      target = restorePct * Math.max(1, layout.total - el.clientHeight);
    } else if (startPage > 0) {
      const p =
        layout.pages[Math.min(startPage, layout.pages.length - 1)];
      if (p) target = p.start;
    }
    const before = el.scrollTop;
    el.scrollTop = clamp(target, 0, maxTop);
    if (el.scrollTop !== before) programmaticScroll.current = true;
    restoreDone.current = true;
    layoutSigRef.current = { cw: layout.contentWidth, vh: el.clientHeight };
    // 首个窗口 + 进度（持久化由 Reader 决定，这里不落后端）。
    syncFromScroll(false);
    onProgress(lastProgress.current.pct, lastProgress.current.page, false);
  }, [layout, restorePct, startPage, syncFromScroll, onProgress]);

  /* ---------- 宽度/视口变化：保持视口中心页 + 页内比例 ---------- */
  useLayoutEffect(() => {
    if (!layout) return;
    const el = scrollerRef.current;
    if (!el) return;
    const sig = layoutSigRef.current;
    const cw = layout.contentWidth;
    const vhNow = el.clientHeight;
    if (!restoreDone.current) {
      sig.cw = cw;
      sig.vh = vhNow;
      return;
    }
    const widthChanged = sig.cw !== 0 && sig.cw !== cw;
    const heightChanged = sig.vh !== 0 && sig.vh !== vhNow;
    sig.cw = cw;
    sig.vh = vhNow;
    if (!widthChanged && !heightChanged) return;
    if (widthChanged) {
      // 用“旧布局 + 当前 scrollTop”重算中心锚点（用户可能刚滚过但尚未进 rAF），
      // 顶/底边缘直接贴边，避免宽度变化把贴边位置推离边缘。
      const prev = measuredRef.current;
      const currentTop = el.scrollTop;
      let atTop = edgeRef.current.top;
      let atBottom = edgeRef.current.bottom;
      if (prev.layout && prev.vh > 0) {
        const oldMax = Math.max(0, prev.layout.total - prev.vh);
        if (currentTop <= 0.5) atTop = true;
        if (currentTop >= oldMax - 0.5) atBottom = true;
      }
      if (atTop) {
        applyScrollTop(0);
      } else if (atBottom) {
        applyScrollTop(layout.total - vhNow);
      } else {
        // Use the last synced old position. `currentTop` may already have been
        // clamped by the browser because the new strip is shorter; deriving the
        // anchor from that clamped value would jump to a different page.
        const a = prev.layout
          ? centerAnchor(prev.layout, prev.top, prev.vh || vhNow)
          : anchorRef.current;
        const page = Math.max(
          0,
          Math.min(layout.pages.length - 1, a.page),
        );
        const p = layout.pages[page];
        if (p) {
          applyScrollTop(p.start + a.frac * p.dispH - vhNow * 0.5);
        }
      }
    }
    syncFromScroll(true);
  }, [
    layout,
    viewport.h,
    applyScrollTop,
    syncFromScroll,
  ]);

  /* ---------- 切片渲染宽变化：重新请求窗口（缩放窗口宽度时） ---------- */
  useEffect(() => {
    if (!restoreDone.current) return;
    syncRef.current(true);
  }, [W]);

  /* ---------- 后台预切：逐页物化后续页（近前优先，向前扫窗口） ---------- */
  const pageCount = layout?.pages.length ?? 0;
  useEffect(() => {
    if (pageCount === 0) return;
    let alive = true;
    const gen = ++prefetchGen.current;
    // 在线源每页都要真实下载：预取窗口收紧到近前 1 页 / 向前 2 页；
    // 本地书保持 3/10。实际并发仍由后端 onlineConcurrency 信号量限制。
    const near = book.sourceType === "local" ? PREFETCH_NEAR : 1;
    const sweep = book.sourceType === "local" ? PREFETCH_SWEEP : 2;
    const run = async () => {
      while (alive && gen === prefetchGen.current) {
        const P = lastProgress.current.page;
        let target = -1;
        for (let c = P + 1; c <= P + near && c < pageCount; c++) {
          if (!doneRef.current.has(c)) {
            target = c;
            break;
          }
        }
        if (target < 0) {
          for (let c = P + near + 1; c < pageCount && c <= P + sweep; c++) {
            if (!doneRef.current.has(c)) {
              target = c;
              break;
            }
          }
        }
        if (target < 0) {
          await sleep(800); // 前方窗口已就绪：低频待命
          continue;
        }
        // 请求首片 = 触发后端整页物化；顺带预解码存入可视缓存。
        await loadTile(target, 0);
        if (!alive || gen !== prefetchGen.current) return;
        doneRef.current.add(target);
        await sleep(30);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [pageCount, book.id, book.sourceType, loadTile]);

  /* ---------- 卸载：立即提交进度并让在途请求失效 ---------- */
  useEffect(() => {
    return () => {
      requestGen.current += 1;
      prefetchGen.current += 1;
      queueEpoch.current += 1;
      queueRef.current = [];
      if (pumpTimer.current) {
        window.clearTimeout(pumpTimer.current);
        pumpTimer.current = 0;
      }
    };
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(progressTimer.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      commitProgress();
    },
    [commitProgress],
  );

  /* ---------- 键盘（捕获并拦截，防止 Reader 再翻页） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scrollerRef.current;
      if (!el) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "[data-reader-hud], [role=dialog], [data-slot=slider], [data-tab-switcher]",
        )
      ) {
        return;
      }
      const tag = target?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const step = el.clientHeight * 0.85;
      const handled = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      switch (e.key) {
        case "Home":
          handled(() => el.scrollTo({ top: 0 }));
          break;
        case "End":
          handled(() => el.scrollTo({ top: el.scrollHeight }));
          break;
        case " ":
        case "PageDown":
        case "ArrowDown":
        case "ArrowRight":
          handled(() => el.scrollBy({ top: step, behavior: "auto" }));
          break;
        case "PageUp":
        case "ArrowUp":
        case "ArrowLeft":
          handled(() => el.scrollBy({ top: -step, behavior: "auto" }));
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* ---------- Ctrl/Cmd+滚轮：宽度缩放（非 passive，普通滚轮照常滚动） ---------- */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // 普通滚轮交给浏览器
      e.preventDefault();
      e.stopPropagation();
      const factor = Math.exp(-e.deltaY * 0.0025);
      const next = clamp(
        widthRef.current * factor,
        MIN_WIDTH_PCT,
        MAX_WIDTH_PCT,
      );
      if (Math.abs(next - widthRef.current) >= 0.1) onWidthChange(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWidthChange]);

  /* ---------- 跳转句柄（进度条点击 / 目录跳页 / 前后翻动） ---------- */
  useImperativeHandle(
    ref,
    () => ({
      scrollToPct: (target: number) => {
        if (!layout) return;
        const el = scrollerRef.current;
        if (!el) return;
        applyScrollTop(
          clamp(target, 0, 1) * Math.max(1, layout.total - el.clientHeight),
        );
        syncFromScroll(true);
      },
      scrollToPage: (page: number) => {
        if (!layout || layout.pages.length === 0) return;
        const el = scrollerRef.current;
        if (!el) return;
        const p =
          layout.pages[
            clamp(Math.round(page), 0, layout.pages.length - 1)
          ];
        if (!p) return;
        // 让目标页中心对准视口中心：跳页后页码标签立即落在该页。
        applyScrollTop(p.start + p.dispH * 0.5 - el.clientHeight * 0.5);
        syncFromScroll(true);
      },
      scrollByViewport: (screens: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollBy({ top: el.clientHeight * screens, behavior: "auto" });
      },
      getProgress: () => {
        const el = scrollerRef.current;
        if (el && layout && layout.pages.length > 0) {
          const top = el.scrollTop;
          const vhNow = el.clientHeight;
          const page = pageIndexAt(
            layout.pages,
            top + vhNow * 0.5,
          );
          const max = Math.max(1, layout.total - vhNow);
          lastProgress.current = {
            pct: clamp(top / max, 0, 1),
            page,
          };
        }
        return { ...lastProgress.current };
      },
    }),
    [layout, applyScrollTop, syncFromScroll],
  );

  /* ---------- 指针：单击切 HUD；双指捏合调宽度 ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        width: widthRef.current,
      };
      tapRef.current.id = -1;
    } else if (pointersRef.current.size === 1) {
      tapRef.current = {
        x: e.clientX,
        y: e.clientY,
        t: Date.now(),
        id: e.pointerId,
      };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size < 2) return;
    const [a, b] = [...pointersRef.current.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const pinch = pinchRef.current;
    if (pinch.dist <= 0 || dist <= 0) return;
    const next = clamp(
      pinch.width * (dist / pinch.dist),
      MIN_WIDTH_PCT,
      MAX_WIDTH_PCT,
    );
    if (Math.abs(next - widthRef.current) >= 0.5) onWidthChange(next);
  };
  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current.dist = 0;
    const tap = tapRef.current;
    if (
      e.pointerId === tap.id &&
      Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 6 &&
      Date.now() - tap.t < 400 &&
      !(e.target as HTMLElement).closest("button")
    ) {
      onTap();
    }
    tapRef.current.id = -1;
  };
  const cancelPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current.dist = 0;
    tapRef.current.id = -1;
  };

  const retryTile = (key: string) => {
    const [i, tile] = key.split(":").map(Number);
    if (!Number.isInteger(i) || !Number.isInteger(tile)) return;
    requestedRef.current.delete(key);
    setFailed((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    void loadTile(i, tile);
  };

  /* ---------- 只渲染窗口内切片（DOM 数量有界） ---------- */
  const tileNodes = useMemo<ReactNode>(() => {
    if (!layout || layout.pages.length === 0 || win.hi <= win.lo) return null;
    const out: ReactNode[] = [];
    const first = pageIndexAt(layout.pages, win.lo);
    const last = pageIndexAt(
      layout.pages,
      Math.min(layout.total - 0.001, win.hi),
    );
    for (let i = first; i <= last; i++) {
      const p = layout.pages[i];
      if (!p || p.dispH <= 0) continue;
      const visLo = Math.max(win.lo, p.start);
      const visHi = Math.min(win.hi, p.start + p.dispH);
      if (visHi <= visLo) continue;
      const tileH = p.dispH / p.tiles;
      const tLo = Math.max(0, Math.floor((visLo - p.start) / tileH));
      const tHi = Math.min(
        p.tiles - 1,
        Math.floor((visHi - p.start - 0.001) / tileH),
      );
      for (let tile = tLo; tile <= tHi; tile++) {
        const key = `${i}:${tile}`;
        const top = tileTopAt(p, tile);
        const height = tileHeightAt(p, tile);
        const src = tiles[key];
        const isFailed = failed[key] === true;
        out.push(
          <div
            key={key}
            className="webtoon-tile"
            style={{ top, height }}
          >
            {src ? (
              <img
                src={src}
                alt={t("reader.page.alt", { page: i + 1 })}
                draggable={false}
              />
            ) : isFailed ? (
              <button
                type="button"
                className="webtoon-tile-fail"
                onClick={() => retryTile(key)}
              >
                {t("reader.webtoon.tileFailed")}
              </button>
            ) : null}
          </div>,
        );
      }
    }
    return out;
  }, [layout, win, tiles, failed, t]);

  // 容器必须始终挂载：首次布局前 scrollerRef 为空，否则尺寸观察永远拿不到宽度。
  return (
    <div
      ref={scrollerRef}
      className="webtoon-scroll"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={cancelPointer}
    >
      {err ? (
        <div className="reader-center">
          <ErrorState
            message={t("reader.error.detail", {
              prefix: t("reader.webtoon.layoutFailed"),
              detail: err,
            })}
          />
        </div>
      ) : !dims || !layout || vw <= 0 ? (
        <div className="reader-center">
          <PixelPet mode="loading" message={t("reader.webtoon.loading")} />
        </div>
      ) : (
        <div className="webtoon-stage" style={{ height: layout.total }}>
          <div
            className="webtoon-strip"
            style={{ width: layout.contentWidth, height: layout.total }}
          >
            {tileNodes}
          </div>
        </div>
      )}
    </div>
  );
});

export default WebtoonView;
