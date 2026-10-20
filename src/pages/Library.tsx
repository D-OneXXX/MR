import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { usePanelRef } from "react-resizable-panels";
import {
  BookOpen,
  FolderOpen,
  Link2,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  isOnlineEnabled,
  isTransEnabled,
  onExperimentalChange,
  onTransToggle,
  type BatchJob,
  type BookInfo,
  type Dashboard,
} from "../lib/tauri";
import { cn } from "@/lib/utils";
import { sourceDisplay } from "@/lib/sourceDisplay";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import BookCard from "../components/BookCard";
import ContextMenu from "../components/ContextMenu";
import ConfirmDialog from "../components/ConfirmDialog";
import ErrorState from "../components/ErrorState";
import PixelPet from "../components/PixelPet";
import DetailSheet from "../components/DetailSheet";
import BookInspector from "../components/library/BookInspector";
import OnlineImportDialog, {
  LIBRARY_REFRESH_EVENT,
  useOnlineHandoffState,
} from "../components/OnlineImportDialog";
import { toast, toastErr, Toaster } from "../components/Toast";

type SourceFilter = "all" | "local" | "online";

const INSPECTOR_WIDTH_KEY = "mr-inspector-width";
const INSPECTOR_COLLAPSED_KEY = "mr-inspector-collapsed";
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 420;
const INSPECTOR_DEFAULT = 320;
const INSPECTOR_COLLAPSED_WIDTH = 40;
const RESIZE_HANDLE_WIDTH = 12;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";
const TOOL_BTN =
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-hairline bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
const TOOL_BTN_PRIMARY = cn(TOOL_BTN, "border-brand bg-brand text-white hover:bg-brand/90");
const TOOL_BTN_ACTIVE = "border-brand/40 bg-accent text-ink";
const SEG_WRAP =
  "flex shrink-0 items-center rounded-md border border-hairline bg-surface p-0.5";
const SEG_BTN =
  "whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors";
const SEG_ON = "bg-accent text-ink";
const SEG_OFF = "text-ink-muted hover:text-ink";
const SEARCH_INPUT =
  "h-9 w-full rounded-md border border-hairline bg-surface pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-brand";

function readInspectorWidth(): number {
  try {
    const value = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    if (Number.isFinite(value) && value >= INSPECTOR_MIN && value <= INSPECTOR_MAX) {
      return Math.round(value);
    }
  } catch {
    /* 忽略 */
  }
  return INSPECTOR_DEFAULT;
}

function readInspectorCollapsed(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 书库主页（`/`）— v3 座舱：
 * ≥1100px 为「导航轨 + 书库画布 + 常驻 Inspector」；窄屏回退到浮动详情 sheet。
 * 导入、拖放、多选、右键菜单与在线直读门控保持既有行为。
 */
export default function LibraryPage() {
  const nav = useNavigate();
  const { status: handoffStatus } = useOnlineHandoffState();
  const [groupSeries, setGroupSeries] = useState(true);
  const [seriesCountMap, setSeriesCountMap] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [originRect, setOriginRect] = useState<DOMRect | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

  // 宽屏 Inspector：宽度 / 折叠 / 拖拽。
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches,
  );
  const [inspectorWidth, setInspectorWidth] = useState(readInspectorWidth);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(
    readInspectorCollapsed,
  );
  const inspectorPanelRef = usePanelRef();
  const inspectorScrollRef = useRef<HTMLElement | null>(null);

  // 多选 + 右键菜单 + 删除确认
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; bookId: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BookInfo[] | null>(null);

  // 导入进度（右下角小卡）
  const [importing, setImporting] = useState<{ done: number; total: number; current: string } | null>(null);
  // 实验性翻译开关（镜像 + 订阅）：关闭时隐藏批量预翻译横条并停轮询。
  const [transOn, setTransOn] = useState(isTransEnabled());
  useEffect(() => onTransToggle(setTransOn), []);

  // URL 在线直读入口（实验性开关门控 + 订阅变更）。
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled());
  useEffect(() => onExperimentalChange(() => setOnlineOn(isOnlineEnabled())), []);
  // 开关在别处被关闭时，立即收起已打开的导入弹窗。
  useEffect(() => {
    if (!onlineOn) setOnlineOpen(false);
  }, [onlineOn]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
    } catch {
      /* 忽略 */
    }
  }, [inspectorWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(
        INSPECTOR_COLLAPSED_KEY,
        inspectorCollapsed ? "1" : "0",
      );
    } catch {
      /* 忽略 */
    }
  }, [inspectorCollapsed]);

  // 宽 → 窄时不再保留封面飞入原点；sheet 会自行滑入。
  // 窄 → 宽时收起覆盖层，恢复常驻 Inspector。
  useEffect(() => {
    if (!wide) setOriginRect(null);
    else setSheetOpen(false);
  }, [wide]);

  useEffect(() => {
    inspectorScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  // 批量预翻译进度轮询(工作台入队;仅在书库页轻量展示活跃任务)。
  useEffect(() => {
    if (!transOn) return;
    let alive = true;
    const poll = () => {
      api
        .batchList()
        .then((list) => {
          if (alive)
            setBatchJobs(
              list.filter((j) =>
                ["queued", "running", "paused", "done", "done_errors", "failed"].includes(
                  j.state,
                ),
              ),
            );
        })
        .catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [transOn]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const reload = useCallback(async (q: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [d, list, all] = await Promise.all([
        api.getDashboard(),
        api.listBooks(q.length > 0 ? q : undefined),
        q.length > 0 ? api.listBooks().catch(() => null) : Promise.resolve(null),
      ]);
      const counts = new Map<string, number>();
      for (const book of all ?? list) {
        const sid = book.seriesId?.trim();
        if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
      }
      setSeriesCountMap(counts);
      setDash(d);
      setBooks(list);
    } catch (e) {
      setLoadError(typeof e === "string" ? e : "加载失败");
      toastErr("list_books", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload(debounced);
  }, [debounced, reload]);

  // 协同配对回传导入完成（弹窗关闭时也会触发）。
  useEffect(() => {
    const refresh = () => void reload(debounced);
    window.addEventListener(LIBRARY_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_REFRESH_EVENT, refresh);
  }, [debounced, reload]);

  const selected = useMemo(
    () => books.find((b) => b.id === selectedId) ?? null,
    [books, selectedId],
  );

  const visibleBooks = useMemo(() => {
    if (sourceFilter === "all") return books;
    const local = sourceFilter === "local";
    return books.filter((book) => (book.sourceType === "local") === local);
  }, [books, sourceFilter]);

  const displayBooks = useMemo(() => {
    if (!groupSeries) {
      return visibleBooks.map((book) => {
        const sid = book.seriesId?.trim();
        return { book, seriesCount: sid ? seriesCountMap.get(sid) ?? 1 : 1 };
      });
    }
    const groups = new Map<string, { book: BookInfo; filteredCount: number }>();
    for (const book of visibleBooks) {
      const sid = book.seriesId?.trim();
      const key = sid ? `series:${sid}` : `book:${book.id}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { book, filteredCount: 1 });
      } else {
        existing.filteredCount += 1;
        if (book.updatedAt > existing.book.updatedAt) existing.book = book;
      }
    }
    return [...groups.entries()].map(([key, group]) => {
      const sid = key.startsWith("series:") ? key.slice("series:".length) : "";
      return {
        book: group.book,
        seriesCount: sid ? seriesCountMap.get(sid) ?? group.filteredCount : 1,
      };
    });
  }, [visibleBooks, groupSeries, seriesCountMap]);

  // 多选删除入口的文案：在线、本地、混合三种集合分别提示。
  const checkedBooks = useMemo(
    () => books.filter((b) => checkedIds.has(b.id)),
    [books, checkedIds],
  );
  const checkedHasLocal = checkedBooks.some((b) => b.sourceType === "local");
  const checkedHasOnline = checkedBooks.some((b) => b.sourceType !== "local");
  const batchDeleteLabel =
    checkedHasLocal && checkedHasOnline
      ? "删除 / 彻底移除…"
      : checkedHasOnline
        ? "彻底移除…"
        : "删除源文件…";

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    setOriginRect(null);
  }, []);

  const onSelect = useCallback(
    (id: string, rect: DOMRect | null) => {
      setOriginRect(wide ? null : rect);
      setSelectedId(id);
      // 宽屏用常驻 Inspector；窄屏才由点击触发覆盖式 Sheet（窗口收窄不自动弹出）。
      setSheetOpen(!wide);
    },
    [wide],
  );

  /* ---------- Inspector：由 resizable.tsx 负责拖拽与键盘调宽 ---------- */
  // 仅在跨越 1100px 断点、工作区重新挂载时快照默认尺寸；
  // 拖拽/折叠只更新状态，避免 defaultSize 变化让 Panel 反复重注册。
  const inspectorMount = useMemo(
    () => ({
      width: inspectorWidth,
      collapsed: inspectorCollapsed,
    }),
    [wide],
  );

  const onWorkspaceLayoutChanged = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    const size = panel.getSize().inPixels;
    const collapsedNow =
      panel.isCollapsed() || size <= INSPECTOR_COLLAPSED_WIDTH + 1;
    setInspectorCollapsed(collapsedNow);
    if (
      !collapsedNow &&
      size >= INSPECTOR_MIN - 1 &&
      size <= INSPECTOR_MAX + 1
    ) {
      setInspectorWidth(
        Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(size))),
      );
    }
  }, [inspectorPanelRef]);

  const collapseInspector = useCallback(() => {
    inspectorPanelRef.current?.collapse();
    setInspectorCollapsed(true);
  }, [inspectorPanelRef]);

  const expandInspector = useCallback(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    panel.expand();
    panel.resize(inspectorWidth);
    setInspectorCollapsed(false);
  }, [inspectorPanelRef, inspectorWidth]);

  const inspectorColumn = inspectorCollapsed
    ? INSPECTOR_COLLAPSED_WIDTH
    : inspectorWidth;
  const libraryRight = wide
    ? 22 + inspectorColumn + RESIZE_HANDLE_WIDTH
    : 22;

  /* ---------- 导入（逐路径调用，右下角进度小卡；重复路径提示不入库） ---------- */
  const importPaths = useCallback(
    async (paths: string[]) => {
      const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0);
      if (clean.length === 0) return;
      let added = 0;
      let restored = 0;
      let skipped = 0;
      let failed = 0;
      const failMsgs: string[] = [];
      for (let i = 0; i < clean.length; i += 1) {
        setImporting({ done: i, total: clean.length, current: clean[i] });
        try {
          const r = await api.importBooks([clean[i]]);
          added += r.added;
          restored += r.restored;
          skipped += r.skipped;
          failed += r.failed;
          for (const it of r.items) {
            if (it.status === "failed") failMsgs.push(`${it.path}：${it.message}`);
          }
        } catch (e) {
          failed += 1;
          failMsgs.push(typeof e === "string" ? e : "导入失败");
        }
      }
      setImporting(null);
      await reload(debounced);
      const parts = [`新增 ${added}`];
      if (restored > 0) parts.push(`恢复 ${restored}（进度保留）`);
      if (skipped > 0) parts.push(`已在书库 ${skipped}`);
      if (failed > 0) parts.push(`失败 ${failed}`);
      toast(`导入完成：${parts.join(" · ")}`);
      if (failMsgs.length > 0) toastErr("import_books", failMsgs[0]);
    },
    [debounced, reload],
  );

  // 添加压缩包：文件对话框（zip/cbz 多选）→ 每个压缩包 = 一本书。
  const onAddFiles = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        title: "选择漫画压缩包（zip / cbz，可多选）",
        filters: [{ name: "漫画压缩包", extensions: ["zip", "cbz"] }],
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      await importPaths(paths);
    } catch {
      toast("文件选择器不可用，请改用拖拽导入");
    }
  }, [importPaths]);

  // 添加文件夹：目录对话框（可多选）→ 选中的文件夹内容构成一本书。
  const onAddFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: true,
        title: "选择漫画文件夹（一个文件夹 = 一本书，可多选）",
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      await importPaths(paths);
    } catch {
      toast("文件夹选择器不可用，请改用拖拽导入");
    }
  }, [importPaths]);

  // 拖入文件/文件夹入库：监听窗口拖放事件（Tauri drag-drop）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          void importPaths(event.payload.paths);
        }
      })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {
        /* 非 Tauri 环境忽略 */
      });
    return () => unlisten?.();
  }, [importPaths]);

  /* ---------- 移除 / 删除源文件 ---------- */
  const doRemove = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      try {
        const r = await api.removeBooks(ids, false);
        toast(`已移除 ${r.removed} 本：源文件保留，重新导入可续读`);
        if (selectedId && ids.includes(selectedId)) closeSheet();
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        toastErr("remove_books", e);
      }
    },
    [debounced, reload, selectedId, closeSheet],
  );

  const doDeleteConfirmed = useCallback(async () => {
    const targets = confirmDelete;
    setConfirmDelete(null);
    if (!targets || targets.length === 0) return;
    const ids = targets.map((b) => b.id);
    const onlineCount = targets.filter((b) => b.sourceType !== "local").length;
    const localCount = targets.length - onlineCount;
    try {
      const r = await api.removeBooks(ids, true);
      if (r.errors.length > 0) toastErr("remove_books", r.errors[0]);
      if (onlineCount > 0 && localCount === 0) {
        toast(`已彻底移除 ${onlineCount} 本在线书，远程源未删除`);
      } else if (onlineCount > 0) {
        toast(
          `已删除源文件 ${r.deletedFiles} 个，并彻底移除 ${onlineCount} 本在线书（远程源未删除），全部记录已清理`,
        );
      } else {
        toast(
          r.deletedFiles > 0
            ? `已删除源文件 ${r.deletedFiles} 个并清理全部记录`
            : "没有源文件被删除",
        );
      }
      if (selectedId && ids.includes(selectedId)) closeSheet();
      setCheckedIds(new Set());
      await reload(debounced);
    } catch (e) {
      toastErr("remove_books", e);
    }
  }, [confirmDelete, debounced, reload, selectedId, closeSheet]);

  const toggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setCheckedIds(new Set());
  }, []);

  const openReader = useCallback(
    (id: string) => nav(`/reader/${encodeURIComponent(id)}`),
    [nav],
  );

  const ctxBook = ctxMenu ? books.find((b) => b.id === ctxMenu.bookId) ?? null : null;
  const deleteTargets = confirmDelete;
  const deletePages = deleteTargets?.reduce((s, b) => s + b.pageCount, 0) ?? 0;
  const deleteLocal = deleteTargets?.filter((b) => b.sourceType === "local") ?? [];
  const deleteOnline = deleteTargets?.filter((b) => b.sourceType !== "local") ?? [];
  const deleteMixed = deleteLocal.length > 0 && deleteOnline.length > 0;

  const canvasContent = (
    <div className="min-w-0" style={{ paddingBottom: selectMode ? 96 : 0 }}>
          {/* 数据线 + 工具条：900px 下整体换行，按钮不竖排。 */}
          <div className="mb-4 flex flex-col gap-3">
            <div
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-ink-muted"
              aria-label="书库概览"
            >
              {loading ? (
                <span>正在载入书架…</span>
              ) : (
                <>
                  <span>
                    藏书{" "}
                    <b className="mono text-sm font-semibold text-ink">
                      {dash?.totalBooks ?? books.length}
                    </b>
                  </span>
                  <span>
                    在读{" "}
                    <b className="mono text-sm font-semibold text-ink">
                      {dash?.reading ?? 0}
                    </b>
                  </span>
                  <span>
                    今日{" "}
                    <b className="mono text-sm font-semibold text-ink">
                      {dash?.todayPages ?? 0}
                    </b>{" "}
                    页
                  </span>
                </>
              )}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] max-w-[380px] flex-1 basis-[240px]">
                <Search
                  size={15}
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <input
                  className={cn(SEARCH_INPUT, FOCUS_RING)}
                  placeholder="搜索书名…"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  aria-label="搜索书名"
                />
              </div>

              <div className={SEG_WRAP} role="group" aria-label="来源筛选">
                {(
                  [
                    ["all", "全部"],
                    ["local", "本地"],
                    ["online", "在线"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={sourceFilter === key}
                    onClick={() => setSourceFilter(key)}
                    className={cn(
                      SEG_BTN,
                      FOCUS_RING,
                      sourceFilter === key ? SEG_ON : SEG_OFF,
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className={SEG_WRAP} role="group" aria-label="合集显示方式">
                <button
                  type="button"
                  aria-pressed={groupSeries}
                  onClick={() => setGroupSeries(true)}
                  title="同一合集只显示代表卡"
                  className={cn(
                    SEG_BTN,
                    FOCUS_RING,
                    groupSeries ? SEG_ON : SEG_OFF,
                  )}
                >
                  按合集
                </button>
                <button
                  type="button"
                  aria-pressed={!groupSeries}
                  onClick={() => setGroupSeries(false)}
                  title="逐个章节平铺显示"
                  className={cn(
                    SEG_BTN,
                    FOCUS_RING,
                    !groupSeries ? SEG_ON : SEG_OFF,
                  )}
                >
                  平铺
                </button>
              </div>

              {onlineOn && (
                <button
                  type="button"
                  className={cn(TOOL_BTN, FOCUS_RING)}
                  onClick={() => setOnlineOpen(true)}
                  title={
                    handoffStatus?.active
                      ? "配对会话进行中，点击打开查看或停止"
                      : "从 JSON 清单或单页 HTML 图集导入"
                  }
                >
                  <Link2 size={14} />
                  {handoffStatus?.active ? "配对中（打开查看/停止）" : "URL 直读"}
                </button>
              )}
              <button
                type="button"
                className={cn(TOOL_BTN_PRIMARY, FOCUS_RING)}
                onClick={() => void onAddFiles()}
                title="选择压缩包（zip / cbz）导入"
              >
                <Plus size={14} /> 添加书籍
              </button>
              <button
                type="button"
                className={cn(TOOL_BTN, FOCUS_RING)}
                onClick={() => void onAddFolder()}
                title="选择一个文件夹（其内容 = 一本书）"
              >
                <FolderOpen size={14} /> 添加文件夹
              </button>
              <button
                type="button"
                className={cn(
                  TOOL_BTN,
                  FOCUS_RING,
                  selectMode && TOOL_BTN_ACTIVE,
                )}
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                title="多选后可批量移除/删除"
                aria-pressed={selectMode}
              >
                <ListChecks size={14} /> {selectMode ? "完成" : "管理"}
              </button>
            </div>
          </div>

          {/* 活跃的批量预翻译任务（仅实验性翻译开启且有任务时出现） */}
          {transOn && batchJobs.length > 0 && (
            <div className="mb-4 rounded-xl border border-hairline bg-surface p-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">
                  批量预翻译进行中
                </span>
                <span className="mono rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-ink-muted">
                  {batchJobs.length}
                </span>
                <a
                  className={cn(TOOL_BTN, FOCUS_RING, "ml-auto h-8")}
                  href="#/workbench"
                >
                  工作台
                </a>
              </div>
              {batchJobs.slice(0, 3).map((j) => (
                <div key={j.id} className="mt-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                      {j.bookTitle}
                    </span>
                    <span className="mono rounded border border-hairline px-1 py-0.5 text-[10px] text-ink-muted">
                      {j.state}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hairline">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{
                        width: `${
                          j.totalPages > 0
                            ? Math.round((j.donePages / j.totalPages) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 封面流：书库的主角 */}
          {loadError ? (
            <ErrorState
              message={`书库加载失败：${loadError}`}
              onRetry={() => void reload(debounced)}
            />
          ) : loading ? (
            <PixelPet mode="loading" />
          ) : visibleBooks.length === 0 ? (
            <PixelPet
              mode="empty"
              message={
                debounced.length > 0
                  ? "没有搜到，去换个关键词吧"
                  : sourceFilter !== "all"
                    ? "当前来源筛选下还没有书，切换到「全部」看看"
                    : "书架还是空的——拖入 cbz/zip/文件夹，或点「添加书籍」"
              }
            />
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(clamp(132px, 12vw, 168px), 1fr))",
                gap: 12,
              }}
            >
              {displayBooks.map(({ book: b, seriesCount }) => (
                <BookCard
                  key={b.id}
                  book={b}
                  seriesCount={seriesCount}
                  selectMode={selectMode}
                  checked={checkedIds.has(b.id)}
                  onToggleCheck={toggleCheck}
                  onContextMenu={(e, id) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, bookId: id });
                  }}
                  onSelect={onSelect}
                  onOpen={openReader}
                  deferSelect={!wide}
                />
              ))}
            </div>
          )}
          {visibleBooks.length > 0 && !selectMode && (
            <p className="mt-4 text-xs text-ink-muted">
              {wide
                ? "单击封面在右侧查看详情，双击进入阅读；右键封面可移除或删除源文件。"
                : "单击封面看阅读纵深，双击进入阅读；右键封面可移除或删除源文件。"}
            </p>
          )}
    </div>
  );

  const inspectorContent = (
    <div
      className="relative min-w-0"
      style={{
        position: "sticky",
        top: "calc(var(--titlebar-h) + 18px)",
        height: "calc(100vh - var(--titlebar-h) - 50px)",
      }}
    >
        <aside
              ref={inspectorScrollRef}
              aria-label="书籍详情"
              className={cn(
                "glass hairline h-full overflow-y-auto rounded-xl",
                inspectorCollapsed && "flex flex-col items-center py-2",
              )}
            >
              {inspectorCollapsed ? (
                <>
                  <button
                    type="button"
                    onClick={expandInspector}
                    title="展开详情"
                    aria-label={
                      selected ? `展开详情：${selected.title}` : "展开详情"
                    }
                    aria-expanded={false}
                    className={cn(
                      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink",
                      FOCUS_RING,
                    )}
                  >
                    <PanelRightOpen size={16} />
                  </button>
                  {selected && (
                    <span
                      className="mt-2 h-1.5 w-1.5 rounded-full bg-brand"
                      aria-hidden
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="shell-surface sticky top-0 z-10 flex h-10 items-center gap-2 border-b border-hairline px-3">
                    <span className="text-[11px] font-medium tracking-[0.16em] text-ink-muted">
                      详情
                    </span>
                    {selected && (
                      <span className="mono truncate text-[10px] text-ink-muted">
                        {selected.pageCount} 页
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={collapseInspector}
                      title="折叠详情"
                      aria-label="折叠详情"
                      aria-expanded
                      className={cn(
                        "ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink",
                        FOCUS_RING,
                      )}
                    >
                      <PanelRightClose size={15} />
                    </button>
                  </div>

                  {selected ? (
                    <BookInspector key={selected.id} book={selected} />
                  ) : (
                    <div className="flex min-h-[calc(100%-40px)] flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-hairline bg-canvas text-ink-muted">
                        <BookOpen size={20} strokeWidth={1.5} />
                      </span>
                      <p className="text-sm font-medium text-ink">
                        在左侧选择一本书
                      </p>
                      <p className="text-xs leading-relaxed text-ink-muted">
                        详情、阅读统计与页面目录会显示在这里；双击封面可直接开始阅读。
                      </p>
                    </div>
                  )}
                </>
              )}
        </aside>
    </div>
  );

  return (
    <div className="min-w-0">
      {wide ? (
        <ResizablePanelGroup
          id="library-workspace"
          orientation="horizontal"
          className="min-w-0"
          style={{ overflow: "visible" }}
          resizeTargetMinimumSize={{ fine: 14, coarse: 24 }}
          onLayoutChanged={onWorkspaceLayoutChanged}
        >
          <ResizablePanel
            id="library-canvas"
            className="min-w-0"
            style={{ overflow: "visible" }}
          >
            {canvasContent}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            aria-label="调整详情宽度"
            className="w-3 bg-transparent after:w-px after:bg-hairline hover:after:bg-brand focus-visible:ring-2 [&>div]:bg-hairline hover:[&>div]:bg-brand"
          />
          <ResizablePanel
            id="library-inspector"
            panelRef={inspectorPanelRef}
            defaultSize={
              inspectorMount.collapsed
                ? INSPECTOR_COLLAPSED_WIDTH
                : inspectorMount.width
            }
            minSize={INSPECTOR_MIN}
            maxSize={INSPECTOR_MAX}
            collapsedSize={INSPECTOR_COLLAPSED_WIDTH}
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0"
            style={{ overflow: "visible" }}
          >
            {inspectorContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        canvasContent
      )}

      {/* 批量操作：浮动玻璃条，不占据网格布局 */}
      {selectMode && (
        <div
          className="pointer-events-none fixed bottom-5 z-[75]"
          style={{
            left: 70,
            right: libraryRight,
          }}
        >
          <div
            className="glass hairline pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl px-3 py-2 shadow-2xl"
            role="toolbar"
            aria-label="批量操作"
          >
            <span className="px-1 text-xs text-ink-muted">
              已选{" "}
              <span className="mono text-ink" aria-live="polite">
                {checkedIds.size}
              </span>{" "}
              本
            </span>
            <button
              type="button"
              className={cn(TOOL_BTN, FOCUS_RING, "h-8")}
              disabled={checkedIds.size === 0}
              onClick={() => void doRemove([...checkedIds])}
            >
              移除
            </button>
            <button
              type="button"
              className={cn(
                TOOL_BTN,
                FOCUS_RING,
                "h-8 border-danger/30 text-danger hover:bg-danger/10",
              )}
              disabled={checkedIds.size === 0}
              onClick={() => {
                setConfirmDelete(checkedBooks);
              }}
            >
              {batchDeleteLabel}
            </button>
            <button
              type="button"
              className={cn(TOOL_BTN, FOCUS_RING, "h-8")}
              onClick={exitSelectMode}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {ctxMenu && ctxBook && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: "查看详情",
              onSelect: () => onSelect(ctxBook.id, null),
            },
            {
              label: "继续阅读",
              onSelect: () => openReader(ctxBook.id),
            },
            {
              label: "移除",
              onSelect: () => void doRemove([ctxBook.id]),
            },
            {
              label: ctxBook.sourceType === "local" ? "删除源文件…" : "彻底移除…",
              danger: true,
              onSelect: () => setConfirmDelete([ctxBook]),
            },
          ]}
        />
      )}

      {/* 删除源文件 / 彻底移除：二次确认，列出路径与文件（页）数 */}
      {deleteTargets && deleteTargets.length > 0 && (
        <ConfirmDialog
          title={`${
            deleteMixed
              ? "删除本地源文件 / 彻底移除在线书"
              : deleteOnline.length > 0
                ? "彻底移除"
                : "删除源文件"
          }（${deleteTargets.length} 本 · 共 ${deletePages} 页）？`}
          message={
            deleteMixed
              ? `将永久删除 ${deleteLocal.length} 本本地书的源文件（从磁盘移除），并彻底移除 ${deleteOnline.length} 本在线书；在线书的远程源不会被删除。以上书籍的进度、缩略图、翻译缓存等全部本地记录都会清理。此操作不可逆。`
              : deleteOnline.length > 0
                ? "将从书库移除以下在线书，并清理进度、缩略图、翻译缓存等全部本地记录；不会删除远程源。此操作不可逆。"
                : "将从磁盘永久删除以下源文件/文件夹，并清理该书的进度、缩略图、翻译缓存等全部本地记录。此操作不可逆。"
          }
          // 隐私：在线清单 URL 可能带临时 query token / hash / userinfo。
          // 这里复用 sourceDisplay 的脱敏结果（在线只显示 scheme://host/…/末段路径），
          // 本地书只显示文件名；确认框不得直出 b.path。依据见 src/lib/sourceDisplay.ts。
          paths={deleteTargets.map((b) => {
            const source = sourceDisplay(b);
            return `【${source.badge}】${source.text}（${b.pageCount} 页）`;
          })}
          confirmText={
            deleteMixed ? "删除 / 彻底移除" : deleteOnline.length > 0 ? "彻底移除" : "永久删除"
          }
          onConfirm={() => void doDeleteConfirmed()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* 导入进度（右下角小卡，避开 Inspector） */}
      {importing && (
        <div
          className="glass hairline fade-in fixed bottom-[18px] z-[99] w-[min(320px,86vw)] rounded-xl p-3 shadow-2xl"
          style={{ right: libraryRight }}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink">
              正在导入 {importing.done + 1} / {importing.total}
            </span>
            <span className="mono ml-auto text-xs text-ink-muted">
              {Math.round((importing.done / importing.total) * 100)}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
            <div
              className="h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${(importing.done / importing.total) * 100}%` }}
            />
          </div>
          <div
            className="mono mt-1.5 truncate text-[11px] text-ink-muted"
            title={importing.current}
          >
            {importing.current}
          </div>
        </div>
      )}

      {onlineOn && onlineOpen && (
        <OnlineImportDialog
          initialTab={handoffStatus?.active ? "pair" : "link"}
          onClose={() => setOnlineOpen(false)}
          onImported={() => void reload(debounced)}
          onRead={(b) => nav(`/reader/${encodeURIComponent(b.id)}`)}
        />
      )}

      {/* 窄屏才使用覆盖式详情 sheet（仅点击触发）；宽屏始终内联 Inspector。 */}
      {!wide && (
        <DetailSheet
          book={sheetOpen ? selected : null}
          originRect={originRect}
          onClose={closeSheet}
        />
      )}

      <Toaster />
    </div>
  );
}
