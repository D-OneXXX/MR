import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  BookMarked,
  BookOpen,
  BookX,
  Check,
  FolderPlus,
  Link2,
  ListChecks,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  isOnlineEnabled,
  onExperimentalChange,
  type BookInfo,
  type Dashboard,
} from "@/lib/tauri";
import { sourceDisplay } from "@/lib/sourceDisplay";
import { LIBRARY_REFRESH_EVENT } from "@/lib/events";
import { Button } from "@/components/ui/button";
import BookCard from "@/components/BookCard";
import BookDetailSheet from "@/components/BookDetailSheet";
import ContextMenu from "@/components/ContextMenu";
import ConfirmDialog from "@/components/ConfirmDialog";
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";
import OnlineImportDialog from "@/components/OnlineImportDialog";
import { toast, toastErr } from "@/components/Toast";
import LibraryFilters, {
  type SourceFilter,
} from "@/components/library/LibraryFilters";
import LibrarySearch from "@/components/library/LibrarySearch";
import LibrarySelectionBar from "@/components/library/LibrarySelectionBar";
import LibrarySkeleton from "@/components/library/LibrarySkeleton";

const GROUP_KEY = "mr-library-group-series";
const FILTER_KEY = "mr-library-source-filter";

interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

interface CtxMenuState {
  x: number;
  y: number;
  bookId: string;
}

function readGrouping(): boolean {
  try {
    const raw = localStorage.getItem(GROUP_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* 忽略隐私模式下的存储异常 */
  }
  return true;
}

function readSourceFilter(): SourceFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw === "all" || raw === "local" || raw === "online") return raw;
  } catch {
    /* 忽略 */
  }
  return "all";
}

/**
 * 书库主页（`/`）— 冰蓝胶囊浅色画布：
 * 大标题 + 胶囊搜索 + 分段筛选 + 书卡网格 + 详情 Sheet。
 * 导入、拖放、多选、右键菜单与在线直读门控保持既有行为。
 */
export default function LibraryPage() {
  const nav = useNavigate();
  const [groupSeries, setGroupSeries] = useState(readGrouping);
  const [sourceFilter, setSourceFilter] = useState(readSourceFilter);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [allBooks, setAllBooks] = useState<BookInfo[]>([]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 详情 Sheet：保留书籍快照，列表刷新时用最新数据覆盖展示。
  const [selectedBook, setSelectedBook] = useState<BookInfo | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // 多选 + 右键菜单 + 删除确认
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BookInfo[] | null>(null);

  // 导入进度（右下角小卡）与全局拖放高亮
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // URL 在线直读入口（实验性开关门控 + 订阅变更）。
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled);
  useEffect(() => onExperimentalChange(() => setOnlineOn(isOnlineEnabled())), []);
  useEffect(() => {
    if (!onlineOn) setOnlineOpen(false);
  }, [onlineOn]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY, groupSeries ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  }, [groupSeries]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, sourceFilter);
    } catch {
      /* 忽略 */
    }
  }, [sourceFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
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
      setDash(d);
      setBooks(list);
      setAllBooks(all ?? list);
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

  // 协同配对回传导入完成 / 其他页面触发刷新。
  useEffect(() => {
    const refresh = () => void reload(debounced);
    window.addEventListener(LIBRARY_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(LIBRARY_REFRESH_EVENT, refresh);
  }, [debounced, reload]);

  const visibleBooks = useMemo(() => {
    if (sourceFilter === "all") return books;
    const local = sourceFilter === "local";
    return books.filter((book) => (book.sourceType === "local") === local);
  }, [books, sourceFilter]);

  // 合集计数始终取「未按来源过滤」的全量列表（搜索时另取全库），
  // 这样筛选在线/本地不会改变合集总话数。
  const displayBooks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const book of allBooks) {
      const sid = book.seriesId?.trim();
      if (sid) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }

    if (!groupSeries) {
      return visibleBooks.map((book) => {
        const sid = book.seriesId?.trim();
        return { book, seriesCount: sid ? counts.get(sid) ?? 1 : 1 };
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
        seriesCount: sid ? counts.get(sid) ?? group.filteredCount : 1,
      };
    });
  }, [visibleBooks, groupSeries, allBooks]);

  const checkedBooks = useMemo(
    () => visibleBooks.filter((book) => checkedIds.has(book.id)),
    [visibleBooks, checkedIds],
  );
  const checkedHasLocal = checkedBooks.some((book) => book.sourceType === "local");
  const checkedHasOnline = checkedBooks.some((book) => book.sourceType !== "local");
  const batchDeleteLabel =
    checkedHasLocal && checkedHasOnline
      ? "删除 / 彻底移除…"
      : checkedHasOnline
        ? "彻底移除…"
        : "删除源文件…";

  // 搜索/来源筛选变化后，已勾选但不再可见的书不应继续留在批量集合里。
  useEffect(() => {
    setCheckedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(
        [...prev].filter((id) =>
          visibleBooks.some((book) => book.id === id),
        ),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [visibleBooks]);

  // 选中的书从刷新结果里消失（被删除/查询变化）时关闭详情 Sheet。
  useEffect(() => {
    if (!selectedBook || loading) return;
    if (!visibleBooks.some((book) => book.id === selectedBook.id)) {
      setSheetOpen(false);
      setSelectedBook(null);
    }
  }, [visibleBooks, selectedBook, loading]);

  const sheetBook = useMemo(() => {
    if (!selectedBook) return null;
    return (
      books.find((book) => book.id === selectedBook.id) ??
      allBooks.find((book) => book.id === selectedBook.id) ??
      selectedBook
    );
  }, [books, allBooks, selectedBook]);

  const detailSeriesBooks = useMemo(() => {
    const sid = selectedBook?.seriesId?.trim();
    if (!sid) return undefined;
    const list = allBooks.filter((book) => book.seriesId?.trim() === sid);
    if (list.length === 0) return undefined;
    return [...list].sort((a, b) => {
      const ai = a.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
  }, [allBooks, selectedBook]);

  const commitSearch = useCallback(() => {
    setDebounced(query.trim());
  }, [query]);

  const openDetail = useCallback((book: BookInfo) => {
    setSelectedBook(book);
    setSheetOpen(true);
  }, []);

  const onCardSelect = useCallback(
    (bookId: string) => {
      const book = books.find((item) => item.id === bookId);
      if (book) openDetail(book);
    },
    [books, openDetail],
  );

  const openReader = useCallback(
    (bookId: string, page?: number) => {
      setSheetOpen(false);
      // BookDetailSheet 契约：page 为 1-based 页码，直接映射到 Reader 的 ?page=。
      const suffix =
        typeof page === "number" && Number.isFinite(page)
          ? `?page=${Math.max(1, Math.round(page))}`
          : "";
      nav(`/reader/${encodeURIComponent(bookId)}${suffix}`);
    },
    [nav],
  );

  const toggleCheck = useCallback((bookId: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setCheckedIds(new Set());
  }, []);

  const toggleSelectMode = useCallback(() => {
    if (selectMode) {
      exitSelectMode();
      return;
    }
    setSheetOpen(false);
    setSelectMode(true);
  }, [selectMode, exitSelectMode]);

  const openOnline = useCallback(() => {
    if (!onlineOn) {
      toast("请先在设置中开启实验性「在线直读」");
      return;
    }
    setOnlineOpen(true);
  }, [onlineOn]);

  /* ---------- 导入（逐路径调用，聚合结果后统一 toast） ---------- */
  const importPaths = useCallback(
    async (paths: string[]) => {
      const clean = paths.map((path) => path.trim()).filter(Boolean);
      if (clean.length === 0) return;
      let added = 0;
      let restored = 0;
      let skipped = 0;
      let failed = 0;
      const failMsgs: string[] = [];
      for (let i = 0; i < clean.length; i += 1) {
        setImporting({ done: i, total: clean.length, current: clean[i] });
        try {
          const result = await api.importBooks([clean[i]]);
          added += result.added;
          restored += result.restored;
          skipped += result.skipped;
          failed += result.failed;
          for (const item of result.items) {
            if (item.status === "failed") {
              failMsgs.push(`${item.path}：${item.message}`);
            }
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

  // 拖入文件/文件夹入库：Tauri drag-drop 事件同时驱动高亮覆盖层。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        setDragActive(false);
        if (payload.paths.length > 0) void importPaths(payload.paths);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 非 Tauri 环境忽略 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths]);

  /* ---------- 移除记录 / 删除源文件（语义与旧版完全一致） ---------- */
  const doRemove = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      try {
        const result = await api.removeBooks(ids, false);
        toast(`已移除 ${result.removed} 本：源文件保留，重新导入可续读`);
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        toastErr("remove_books", e);
      }
    },
    [debounced, reload, selectedBook],
  );

  const doDelete = useCallback(
    async (targets: BookInfo[]) => {
      if (targets.length === 0) return;
      const ids = targets.map((book) => book.id);
      const onlineCount = targets.filter(
        (book) => book.sourceType !== "local",
      ).length;
      const localCount = targets.length - onlineCount;
      try {
        const result = await api.removeBooks(ids, true);
        if (result.errors.length > 0) toastErr("remove_books", result.errors[0]);
        if (onlineCount > 0 && localCount === 0) {
          toast(`已彻底移除 ${onlineCount} 本在线书，远程源未删除`);
        } else if (onlineCount > 0) {
          toast(
            `已删除源文件 ${result.deletedFiles} 个，并彻底移除 ${onlineCount} 本在线书（远程源未删除），全部记录已清理`,
          );
        } else {
          toast(
            result.deletedFiles > 0
              ? `已删除源文件 ${result.deletedFiles} 个并清理全部记录`
              : "没有源文件被删除",
          );
        }
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        toastErr("remove_books", e);
      }
    },
    [debounced, reload, selectedBook],
  );

  const doDeleteConfirmed = useCallback(async () => {
    const targets = confirmDelete;
    setConfirmDelete(null);
    if (!targets || targets.length === 0) return;
    await doDelete(targets);
  }, [confirmDelete, doDelete]);

  const ctxBook = ctxMenu
    ? books.find((book) => book.id === ctxMenu.bookId) ??
      allBooks.find((book) => book.id === ctxMenu.bookId) ??
      null
    : null;

  const deleteTargets = confirmDelete;
  const deletePages =
    deleteTargets?.reduce((total, book) => total + book.pageCount, 0) ?? 0;
  const deleteLocal =
    deleteTargets?.filter((book) => book.sourceType === "local") ?? [];
  const deleteOnline =
    deleteTargets?.filter((book) => book.sourceType !== "local") ?? [];
  const deleteMixed = deleteLocal.length > 0 && deleteOnline.length > 0;

  const totalBooks = dash?.totalBooks ?? allBooks.length;
  const readingCount = dash?.reading ?? 0;
  const todayPages = dash?.todayPages ?? 0;
  const emptyMessage =
    debounced.length > 0
      ? "没有搜到，去换个关键词吧"
      : sourceFilter !== "all"
        ? "当前来源筛选下还没有书，切换到「全部」看看"
        : "书架还是空的——拖入 cbz/zip 或文件夹，或点「添加书籍」";

  return (
    <div className="mx-auto w-full max-w-[1500px] px-5 pb-24 pt-4 sm:px-8">
      <header className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              书库
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              共{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {totalBooks}
              </span>{" "}
              本 · 在读{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {readingCount}
              </span>{" "}
              · 今日{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {todayPages}
              </span>{" "}
              页
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="pill-primary"
              size="pill"
              onClick={() => void onAddFiles()}
              title="选择压缩包（zip / cbz）导入"
            >
              <Plus />
              添加书籍
            </Button>
            <Button
              variant="pill"
              size="pill"
              onClick={() => void onAddFolder()}
              title="选择一个文件夹（其内容 = 一本书）"
            >
              <FolderPlus />
              添加文件夹
            </Button>
            <Button
              variant="pill"
              size="pill"
              onClick={openOnline}
              title={
                onlineOn
                  ? "从链接或配对导入在线漫画"
                  : "请先在设置中开启实验性在线直读"
              }
            >
              <Link2 />
              在线直读
            </Button>
            <Button
              variant={selectMode ? "pill-primary" : "pill"}
              size="pill"
              onClick={toggleSelectMode}
              aria-pressed={selectMode}
              title="多选后可批量移除或删除"
            >
              {selectMode ? <Check /> : <ListChecks />}
              {selectMode ? "完成" : "管理"}
            </Button>
          </div>
        </div>

        <LibrarySearch
          value={query}
          onChange={setQuery}
          onCommit={commitSearch}
        />
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <LibraryFilters
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          groupSeries={groupSeries}
          onGroupSeriesChange={setGroupSeries}
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          <span className="tabular-nums" aria-live="polite">
            {groupSeries
              ? `${displayBooks.length} 组`
              : `${displayBooks.length} 本`}
          </span>
        </div>
      </div>

      <section className="mt-6" aria-busy={loading}>
        {loadError ? (
          <ErrorState
            message={`书库加载失败：${loadError}`}
            onRetry={() => void reload(debounced)}
          />
        ) : loading && books.length === 0 ? (
          <LibrarySkeleton />
        ) : visibleBooks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-10 text-center shadow-hard-sm">
            <PixelPet mode="empty" message={emptyMessage} />
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="pill-primary"
                size="pill-sm"
                onClick={() => void onAddFiles()}
              >
                <Plus />
                添加书籍
              </Button>
              <Button
                variant="pill"
                size="pill-sm"
                onClick={() => void onAddFolder()}
              >
                <FolderPlus />
                添加文件夹
              </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              也可以直接把 zip / cbz 压缩包或文件夹拖进窗口导入
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {displayBooks.map(({ book, seriesCount }) => (
                <BookCard
                  key={book.id}
                  book={book}
                  seriesCount={seriesCount}
                  selectMode={selectMode}
                  checked={checkedIds.has(book.id)}
                  onToggleCheck={toggleCheck}
                  onContextMenu={(e, bookId) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, bookId });
                  }}
                  onSelect={onCardSelect}
                  onOpen={openReader}
                  deferSelect
                />
              ))}
            </div>
            {!selectMode && (
              <p className="mt-4 text-xs text-muted-foreground">
                单击封面查看详情，双击或 Shift+Enter
                开始阅读；右键封面可移除或删除源文件。
              </p>
            )}
          </>
        )}
      </section>

      {selectMode && (
        <LibrarySelectionBar
          count={checkedBooks.length}
          deleteLabel={batchDeleteLabel}
          onRemove={() =>
            void doRemove(checkedBooks.map((book) => book.id))
          }
          onDelete={() => setConfirmDelete(checkedBooks)}
          onCancel={exitSelectMode}
        />
      )}

      {ctxMenu && ctxBook && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: "查看详情",
              icon: <BookOpen />,
              onSelect: () => openDetail(ctxBook),
            },
            {
              label: "继续阅读",
              icon: <BookMarked />,
              onSelect: () => openReader(ctxBook.id),
            },
            {
              label: "移除记录",
              icon: <BookX />,
              onSelect: () => void doRemove([ctxBook.id]),
            },
            {
              label:
                ctxBook.sourceType === "local" ? "删除源文件…" : "彻底移除…",
              danger: true,
              icon: <Trash2 />,
              onSelect: () => setConfirmDelete([ctxBook]),
            },
          ]}
        />
      )}

      {/* 删除源文件 / 彻底移除：二次确认，路径与文件名均已脱敏。 */}
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
              ? `将永久删除 ${deleteLocal.length} 本本地书的源文件（从磁盘移除），并彻底移除 ${deleteOnline.length} 本在线书；在线书的远程源不会被删除。以上书籍的进度、缩略图与派生缓存等全部本地记录都会清理。此操作不可逆。`
              : deleteOnline.length > 0
                ? "将从书库移除以下在线书，并清理进度、缩略图与派生缓存等全部本地记录；不会删除远程源。此操作不可逆。"
                : "将从磁盘永久删除以下源文件/文件夹，并清理该书的进度、缩略图与派生缓存等全部本地记录。此操作不可逆。"
          }
          // 隐私：在线清单 URL 可能带临时 query token / hash / userinfo，
          // 复用 sourceDisplay 的脱敏结果，确认框不直出 b.path。
          paths={deleteTargets.map((book) => {
            const source = sourceDisplay(book);
            return `【${source.badge}】${source.text}（${book.pageCount} 页）`;
          })}
          confirmText={
            deleteMixed
              ? "删除 / 彻底移除"
              : deleteOnline.length > 0
                ? "彻底移除"
                : "永久删除"
          }
          onConfirm={() => void doDeleteConfirmed()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* 导入进度（portal 到 body，right/bottom 相对视口） */}
      {importing &&
        createPortal(
          <div
            className="fade-in fixed bottom-6 right-5 z-[70] w-[min(320px,86vw)] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-hard"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">
                正在导入 {importing.done + 1} / {importing.total}
              </span>
              <span className="ml-auto text-xs font-semibold tabular-nums text-muted-foreground">
                {Math.round((importing.done / importing.total) * 100)}%
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${(importing.done / importing.total) * 100}%`,
                }}
              />
            </div>
            <div
              className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground"
              title={importing.current}
            >
              {importing.current}
            </div>
          </div>,
          document.body,
        )}

      {onlineOn && onlineOpen && (
        <OnlineImportDialog
          initialUrl=""
          initialTab="link"
          onClose={() => setOnlineOpen(false)}
          onImported={() => void reload(debounced)}
          onRead={(book) => openReader(book.id)}
        />
      )}

      <BookDetailSheet
        book={sheetBook}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        seriesBooks={detailSeriesBooks}
        onRead={(book, page) => openReader(book.id, page)}
        onRemove={(book) => void doRemove([book.id])}
        // Destructive source deletion goes through the shared confirm dialog.
        onDelete={(book) => setConfirmDelete([book])}
      />

      {/* 拖入时的全屏覆盖提示（Tauri enter/over/leave/drop） */}
      {dragActive &&
        createPortal(
          <div className="fade-in pointer-events-none fixed inset-0 z-[110] flex items-center justify-center bg-background/70 p-8 backdrop-blur-sm">
            <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card px-8 py-12 text-center shadow-hard">
              <span className="grid size-12 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-hard-sm">
                <Upload className="size-6" />
              </span>
              <p className="text-lg font-bold tracking-tight text-foreground">
                松开即可导入
              </p>
              <p className="text-sm text-muted-foreground">
                支持 zip / cbz 压缩包与文件夹，可一次拖入多个
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
