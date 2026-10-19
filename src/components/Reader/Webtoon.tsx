import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  api,
  WEBTOON_TILE_H,
  type BookInfo,
  type PageDim,
} from "../../lib/tauri";
import ErrorState from "../ErrorState";
import PixelPet from "../PixelPet";

export interface WebtoonHandle {
  scrollToPct: (pct: number) => void;
  scrollToPage: (page: number) => void;
  scrollByViewport: (screens: number) => void;
}

interface Props {
  book: BookInfo;
  /** 进入条漫时所在的页码（用于分页→条漫的位置衔接）。 */
  startPage: number;
  /** 恢复的滚动百分比（-1 = 无从条漫记录恢复，走 startPage）。 */
  restorePct: number;
  /** 滚动进度提交（组件内 400ms 节流 + 卸载时立即）。 */
  onProgress: (pct: number, page: number) => void;
  /** 单击画面（非拖动）切换控制条。 */
  onTap: () => void;
  /** React 19：ref 作为普通 prop 透传。 */
  ref?: React.Ref<WebtoonHandle>;
}

interface PageLayout {
  dispH: number; // CSS 高度（宽 = 容器宽）
  tiles: number; // 切片数（与后端同公式，键含渲染宽）
  start: number; // CSS 顶部偏移
}

const FETCH_AHEAD_VH = 3.5; // 视口下方预取窗口（3.5 屏）
const RELEASE_SPAN_VH = 7; // 滚出 ±此范围立即卸载
const PREFETCH_NEAR = 3; // 后台预切：近前 3 页最优先
const PREFETCH_SWEEP = 10; // 后台预切：向前最多扫到这个窗口，之后低频待命

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 条漫视图（整话纵向连滚）：
 * - 布局 = get_webtoon_layout 的源尺寸 → 显示高度（fit-width）→ 与后端同公式切片；
 * - 虚拟化：绝对定位占位撑起总高，只挂载视口上下窗口内的切片，滚出即释放；
 * - 切片由后端按显示宽度降采样解码后均分（≤2048px/片），整张长图永不进浏览器；
 * - **后台预切**：挂载后自动逐页物化后续页（本地近前 3 页最优先，在线源收紧为
 *   近前 1 页 / 向前 2 页），滚到时全磁盘命中，
 *   视觉上是一条无缝长条（不做字面拼接——巨型位图会爆内存）；
 * - 进度 = 滚动偏移百分比；恢复优先用条漫记录，否则用进入时的页码。
 */
const WebtoonView = memo(function WebtoonView({
  book,
  startPage,
  restorePct,
  onProgress,
  onTap,
  ref,
}: Props) {
  const [dims, setDims] = useState<PageDim[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [vw, setVw] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const requestedRef = useRef<Set<string>>(new Set());
  const restoreDone = useRef(false);
  const rafRef = useRef(0);
  const progressTimer = useRef(0);
  const lastProgress = useRef({ pct: 0, page: 0 });
  const tapRef = useRef({ x: 0, y: 0, t: 0, id: -1 });
  // 后台预切：已完成物化的页 + 代际（book/W 变化时让旧循环退出）。
  const doneRef = useRef<Set<number>>(new Set());
  const prefetchGen = useRef(0);

  /* ---------- 布局加载（后端有缓存，二次切换瞬时） ---------- */
  useEffect(() => {
    let alive = true;
    setDims(null);
    setErr(null);
    setTiles({});
    setFailed({});
    requestedRef.current.clear();
    doneRef.current = new Set();
    restoreDone.current = false;
    lastProgress.current = { pct: 0, page: startPage };
    api
      .getWebtoonLayout(book.id)
      .then((d) => alive && setDims(d))
      .catch((e) => {
        if (!alive) return;
        setErr(typeof e === "string" ? e : "布局加载失败");
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
    const on = () => setVw(el.clientWidth);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = useMemo(() => {
    const raw = Math.round((vw * dpr) / 64) * 64;
    return Math.min(2160, Math.max(320, raw)) || 640;
  }, [vw, dpr]);

  const layout = useMemo(() => {
    if (!dims || vw <= 0) return null;
    const pages: PageLayout[] = dims.map((d) => {
      const ratio = d.width > 0 ? d.height / d.width : 1;
      const dispH = ratio * vw;
      const n = Math.max(1, Math.ceil((ratio * W) / WEBTOON_TILE_H));
      return { dispH, tiles: n, start: 0 };
    });
    let acc = 0;
    for (const p of pages) {
      p.start = acc;
      acc += p.dispH;
    }
    return { pages, total: acc };
  }, [dims, vw, W]);

  /* ---------- 切片抓取/释放（视口窗口） ---------- */
  const fetchTile = useCallback(
    (i: number, t: number) => {
      const key = `${i}:${t}`;
      if (requestedRef.current.has(key)) return;
      requestedRef.current.add(key);
      api
        .getWebtoonTile(book.id, i, t, W)
        .then(
          (img) => {
            setTiles((prev) => ({ ...prev, [key]: img.dataUrl }));
          },
          () => {
            requestedRef.current.delete(key);
            setFailed((f) => ({ ...f, [key]: true }));
          },
        );
    },
    [book.id, W],
  );

  const ensureTiles = useCallback(
    (top: number, vhNow: number) => {
      if (!layout) return;
      const lo = top - vhNow;
      const hi = top + vhNow * FETCH_AHEAD_VH;
      const keepLo = top - vhNow * 2;
      const keepHi = top + vhNow * RELEASE_SPAN_VH;
      const need: string[] = [];
      let drop = false;
      for (let i = 0; i < layout.pages.length; i++) {
        const p = layout.pages[i];
        const tileH = p.dispH / p.tiles;
        for (let t = 0; t < p.tiles; t++) {
          const tileTop = p.start + t * tileH;
          const tileBottom = tileTop + tileH;
          if (tileBottom < keepLo || tileTop > keepHi) {
            if (tiles[`${i}:${t}`] !== undefined) drop = true;
            continue;
          }
          if (tileBottom >= lo && tileTop <= hi && !tiles[`${i}:${t}`] && !failed[`${i}:${t}`]) {
            need.push(`${i}:${t}`);
          }
        }
      }
      if (drop) {
        setTiles((prev) => {
          const next: Record<string, string> = {};
          for (const k of Object.keys(prev)) {
            const [i, t] = k.split(":").map(Number);
            const p = layout.pages[i];
            if (!p) continue;
            const tileTop = p.start + t * (p.dispH / p.tiles);
            if (tileTop >= keepLo && tileTop <= keepHi) next[k] = prev[k];
            else requestedRef.current.delete(k);
          }
          return next;
        });
      }
      for (const k of need) {
        const [i, t] = k.split(":").map(Number);
        fetchTile(i, t);
      }
    },
    [layout, tiles, failed, fetchTile],
  );

  /* ---------- 滚动：进度 + 虚拟化 ---------- */
  const commitProgress = useCallback(() => {
    const { pct, page } = lastProgress.current;
    onProgress(pct, page);
  }, [onProgress]);

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollerRef.current;
      if (!el || !layout) return;
      const top = el.scrollTop;
      const vhNow = el.clientHeight;
      const mid = top + vhNow * 0.5;
      let page = 0;
      for (let i = 0; i < layout.pages.length; i++) {
        const p = layout.pages[i];
        if (mid < p.start + p.dispH) {
          page = mid >= p.start ? i : Math.max(0, i - 1);
          break;
        }
        page = i;
      }
      const max = Math.max(1, layout.total - vhNow);
      const pct = Math.min(1, Math.max(0, top / max));
      lastProgress.current = { pct, page };
      ensureTiles(top, vhNow);
      window.clearTimeout(progressTimer.current);
      progressTimer.current = window.setTimeout(commitProgress, 400);
    });
  }, [layout, ensureTiles, commitProgress]);

  /* ---------- 恢复位置：条漫记录优先，否则用进入时的页码（误差 < 半屏） ---------- */
  useEffect(() => {
    if (!layout || restoreDone.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (restorePct >= 0) {
      el.scrollTop = restorePct * Math.max(1, layout.total - el.clientHeight);
    } else if (startPage > 0) {
      const p = layout.pages[Math.min(startPage, layout.pages.length - 1)];
      if (p) el.scrollTop = p.start;
    }
    restoreDone.current = true;
    lastProgress.current = {
      pct: Math.min(1, el.scrollTop / Math.max(1, layout.total - el.clientHeight)),
      page: startPage > 0 ? Math.min(startPage, layout.pages.length - 1) : 0,
    };
    // 首帧把窗口内的切片拉进来。
    ensureTiles(el.scrollTop, el.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  /* ---------- 后台预切：逐页物化后续页（近前优先，向前扫 ±窗口） ---------- */
  useEffect(() => {
    if (!layout) return;
    let alive = true;
    const gen = ++prefetchGen.current;
    // 在线源每页都要真实下载：预取窗口收紧到近前 1 页 / 向前 2 页；
    // 本地书保持 3/10。实际并发仍由后端 onlineConcurrency 信号量限制。
    const near = book.sourceType === "local" ? PREFETCH_NEAR : 1;
    const sweep = book.sourceType === "local" ? PREFETCH_SWEEP : 2;
    const run = async () => {
      while (alive && gen === prefetchGen.current) {
        const P = lastProgress.current.page;
        const total = layout.pages.length;
        let target = -1;
        for (let c = P + 1; c <= P + near && c < total; c++) {
          if (!doneRef.current.has(c)) {
            target = c;
            break;
          }
        }
        if (target < 0) {
          for (let c = P + near + 1; c < total && c <= P + sweep; c++) {
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
        try {
          // 请求首片 = 触发后端整页物化；返回的片顺带存入可视缓存。
          const img = await api.getWebtoonTile(book.id, target, 0, W);
          if (!alive || gen !== prefetchGen.current) return;
          setTiles((prev) =>
            prev[`${target}:0`] !== undefined
              ? prev
              : { ...prev, [`${target}:0`]: img.dataUrl },
          );
        } catch {
          /* 失败也标记（避免死循环）；用户滚到时会自行重试 */
        }
        doneRef.current.add(target);
        await sleep(30);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [layout, book.id, book.sourceType, W]);

  /* ---------- 卸载前立即提交进度 ---------- */
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
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
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

  /* ---------- 跳转句柄（进度条点击 / 目录跳页 / 前后翻动） ---------- */
  useImperativeHandle(
    ref,
    () => ({
      scrollToPct: (pct: number) => {
        const el = scrollerRef.current;
        if (!el || !layout) return;
        el.scrollTop = pct * Math.max(1, layout.total - el.clientHeight);
      },
      scrollToPage: (page: number) => {
        const el = scrollerRef.current;
        if (!el || !layout) return;
        const p = layout.pages[Math.max(0, Math.min(layout.pages.length - 1, page))];
        if (p) el.scrollTop = p.start;
      },
      scrollByViewport: (screens: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollBy({ top: el.clientHeight * screens, behavior: "auto" });
      },
    }),
    [layout],
  );

  /* ---------- 单击切换控制条 ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    tapRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const t = tapRef.current;
    if (
      e.pointerId === t.id &&
      Math.hypot(e.clientX - t.x, e.clientY - t.y) < 6 &&
      Date.now() - t.t < 400 &&
      (e.target as HTMLElement).closest("button") == null
    ) {
      onTap();
    }
    tapRef.current.id = -1;
  };

  const retryTile = (key: string) => {
    setFailed((f) => {
      const n = { ...f };
      delete n[key];
      return n;
    });
    const [i, t] = key.split(":").map(Number);
    fetchTile(i, t);
  };

  // 容器必须始终挂载：首次布局前 scrollerRef 为空，否则尺寸观察永远拿不到宽度。
  return (
    <div
      ref={scrollerRef}
      className="webtoon-scroll"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {err ? (
        <div className="reader-center">
          <ErrorState message={`条漫布局加载失败：${err}`} />
        </div>
      ) : !dims || !layout || vw <= 0 ? (
        <div className="reader-center">
          <PixelPet mode="loading" message="正在展开长条" />
        </div>
      ) : (
        <div className="webtoon-strip" style={{ height: layout.total }}>
          {layout.pages.flatMap((p, i) =>
            Array.from({ length: p.tiles }, (_, t) => {
              const key = `${i}:${t}`;
              const tileH = p.dispH / p.tiles;
              const top = p.start + t * tileH;
              const src = tiles[key];
              const isFailed = failed[key];
              return (
                <div key={key} className="webtoon-tile" style={{ top, height: tileH }}>
                  {src ? (
                    <img src={src} alt={`第 ${i + 1} 页`} draggable={false} />
                  ) : isFailed ? (
                    <button className="webtoon-tile-fail" onClick={() => retryTile(key)}>
                      加载失败 · 点按重试
                    </button>
                  ) : null}
                </div>
              );
            }),
          )}
        </div>
      )}
    </div>
  );
});

export default WebtoonView;
