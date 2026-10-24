import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  BookMarked,
  BookOpen,
  BookX,
  Check,
  FolderPlus,
  ListChecks,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useI18n, translate } from "@/i18n";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import { recordBreadcrumb } from "@/features/resilience";
import {
  api,
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
import { toast, toastErr } from "@/components/Toast";
import { localizeBackendError } from "@/features/errors/localize";
import LibraryFilters, {
  type SourceFilter,
} from "@/components/library/LibraryFilters";
import LibrarySearch from "@/components/library/LibrarySearch";
import LibrarySelectionBar from "@/components/library/LibrarySelectionBar";
import LibrarySkeleton from "@/components/library/LibrarySkeleton";
import RelocateDialog from "@/components/library/RelocateDialog";

const GROUP_KEY = "mr-library-group-series";
const FILTER_KEY = "mr-library-source-filter";
/** 书库渐进窗口：首屏 60 张，滚动/点击再追加，避免几千卡片同时挂载。 */
const PAGE_SIZE = 60;

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

/** 后端中文详情只在中文界面直出；其余语言走稳定码/泛化本地化。 */
function notifyError(cmd: string, error: unknown): void {
  toastErr(cmd, error);
}

/**
 * 书库主页（`/`）— 冰蓝胶囊浅色画布：
 * 大标题 + 胶囊搜索 + 分段筛选 + 书卡网格 + 详情 Sheet。
 * 导入、拖放、多选、右键菜单与在线直读门控保持既有行为。
 */
export default function LibraryPage() {
  const nav = useNavigate();
  const ws = useWorkspace();
  const { t, formatNumber } = useI18n();
  const { active: safeMode } = useSafeMode();
  const [groupSeries, setGroupSeries] = useState(readGrouping);
  const [sourceFilter, setSourceFilter] = useState(readSourceFilter);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [allBooks, setAllBooks] = useState<BookInfo[]>([]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // 详情 Sheet：保留书籍快照，列表刷新时用最新数据覆盖展示。
  const [selectedBook, setSelectedBook] = useState<BookInfo | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 失效路径重定位引导（不进入 Reader，先让用户重新指定位置）。
  const [relocatingBook, setRelocatingBook] = useState<BookInfo | null>(null);

  // 多选 + 右键菜单 + 删除确认
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BookInfo[] | null>(null);

  // 导入进度（右下角小卡）与全局拖放高亮
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // 单飞锁：拖放、按钮、外部刷新可能同时触发导入，重叠扫描会互相抢库锁。
  const importGuardRef = useRef(false);

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
      setLoadError(localizeBackendError(e));
      notifyError("list_books", e);
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
    const localOnly = safeMode
      ? books.filter((book) => book.sourceType === "local")
      : books;
    if (sourceFilter === "all") return localOnly;
    const local = sourceFilter === "local";
    return localOnly.filter((book) => (book.sourceType === "local") === local);
  }, [books, sourceFilter, safeMode]);

  const accessibleAllBooks = useMemo(
    () =>
      safeMode
        ? allBooks.filter((book) => book.sourceType === "local")
        : allBooks,
    [allBooks, safeMode],
  );

  // 合集计数始终取「未按来源过滤」的全量列表（搜索时另取全库），
  // 这样筛选在线/本地不会改变合集总话数。
  const displayBooks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const book of accessibleAllBooks) {
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
  }, [visibleBooks, groupSeries, accessibleAllBooks]);

  // 搜索 / 来源筛选 / 合集模式变化后回到首屏窗口。
  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [debounced, sourceFilter, groupSeries, safeMode]);

  const hasMore = displayBooks.length > visibleLimit;
  const shownBooks = useMemo(
    () => displayBooks.slice(0, visibleLimit),
    [displayBooks, visibleLimit],
  );

  // 底部哨兵接近视口时自动追加一页；按钮仍保留为键盘/读屏的显式入口。
  useEffect(() => {
    if (!hasMore) return;
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleLimit((limit) =>
            Math.min(limit + PAGE_SIZE, displayBooks.length),
          );
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, displayBooks.length, visibleLimit]);

  const checkedBooks = useMemo(
    () => visibleBooks.filter((book) => checkedIds.has(book.id)),
    [visibleBooks, checkedIds],
  );
  const checkedHasLocal = checkedBooks.some((book) => book.sourceType === "local");
  const checkedHasOnline = checkedBooks.some((book) => book.sourceType !== "local");
  const batchDeleteLabel =
    checkedHasLocal && checkedHasOnline
      ? t("library.deleteMixed")
      : checkedHasOnline
        ? t("library.deleteOnline")
        : t("library.deleteLocal");

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
    const list = accessibleAllBooks.filter((book) => book.seriesId?.trim() === sid);
    if (list.length === 0) return undefined;
    return [...list].sort((a, b) => {
      const ai = a.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.chapterIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return (
        a.title.localeCompare(b.title, "zh", {
          numeric: true,
          sensitivity: "base",
        }) || a.updatedAt.localeCompare(b.updatedAt)
      );
    });
  }, [accessibleAllBooks, selectedBook]);

  const commitSearch = useCallback(() => {
    setDebounced(query.trim());
  }, [query]);

  const openDetail = useCallback((book: BookInfo) => {
    setSelectedBook(book);
    setSheetOpen(true);
  }, []);

  const findBook = useCallback(
    (bookId: string) =>
      books.find((item) => item.id === bookId) ??
      allBooks.find((item) => item.id === bookId) ??
      null,
    [books, allBooks],
  );

  const openRelocate = useCallback((book: BookInfo) => {
    setSheetOpen(false);
    setSelectedBook(null);
    setRelocatingBook(book);
  }, []);

  const onCardSelect = useCallback(
    (bookId: string) => {
      const book = findBook(bookId);
      if (!book) return;
      if (book.missing) {
        openRelocate(book);
        return;
      }
      openDetail(book);
    },
    [findBook, openDetail, openRelocate],
  );

  const openReader = useCallback(
    (bookId: string, page?: number) => {
      const book = findBook(bookId);
      if (book?.missing) {
        openRelocate(book);
        return;
      }
      setSheetOpen(false);
      // BookDetailSheet 契约：page 为 1-based 页码，直接映射到 Reader 的 ?page=。
      const suffix =
        typeof page === "number" && Number.isFinite(page)
          ? `?page=${Math.max(1, Math.round(page))}`
          : "";
      nav(`/reader/${encodeURIComponent(bookId)}${suffix}`);
    },
    [findBook, nav, openRelocate],
  );

  const onRelocated = useCallback(
    (updated: BookInfo) => {
      const previousId = relocatingBook?.id;
      if (previousId) ws.replaceTab(previousId, updated.id);
      setRelocatingBook(null);
      toast(t("relocate.success", { title: updated.title }));
      void reload(debounced);
      // 重定位是用户显式动作：直接进入阅读器，后端已保留原进度。
      nav(`/reader/${encodeURIComponent(updated.id)}`);
    },
    [debounced, nav, reload, relocatingBook, t, ws],
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

  /* ---------- 导入（逐路径调用，聚合结果后统一 toast） ---------- */
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (importGuardRef.current) {
        toast(translate("import.busy"));
        return;
      }
      const clean = paths.map((path) => path.trim()).filter(Boolean);
      if (clean.length === 0) return;
      importGuardRef.current = true;
      try {
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
                failMsgs.push(
                  translate("import.itemFailed", {
                    path: item.path,
                    message: localizeBackendError(item.message),
                  }),
                );
              }
            }
          } catch (e) {
            failed += 1;
            failMsgs.push(
              typeof e === "string" && e.length > 0
                ? localizeBackendError(e)
                : translate("import.failedFallback"),
            );
          }
        }
        await reload(debounced);
        const parts = [
          translate("import.added", { count: formatNumber(added) }),
        ];
        if (restored > 0) {
          parts.push(
            translate("import.restored", { count: formatNumber(restored) }),
          );
        }
        if (skipped > 0) {
          parts.push(
            translate("import.inLibrary", { count: formatNumber(skipped) }),
          );
        }
        if (failed > 0) {
          parts.push(
            translate("import.failed", { count: formatNumber(failed) }),
          );
        }
        toast(translate("import.complete", { summary: parts.join(" · ") }));
        if (failMsgs.length > 0) toast(failMsgs[0]);
      } finally {
        importGuardRef.current = false;
        setImporting(null);
      }
    },
    [debounced, formatNumber, reload],
  );

  // 添加压缩包：文件对话框（zip/cbz 多选）→ 每个压缩包 = 一本书。
  const onAddFiles = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        title: translate("import.filesTitle"),
        filters: [
          { name: translate("import.filesFilter"), extensions: ["zip", "cbz"] },
        ],
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      if (paths.length > 0) recordBreadcrumb("archiveImport");
      await importPaths(paths);
    } catch {
      toast(translate("import.pickerUnavailable"));
    }
  }, [importPaths]);

  // 添加文件夹：目录对话框（可多选）→ 选中的文件夹内容构成一本书。
  const onAddFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: true,
        title: translate("import.folderTitle"),
      });
      const paths =
        typeof picked === "string"
          ? [picked]
          : Array.isArray(picked)
            ? picked
            : [];
      if (paths.length > 0) recordBreadcrumb("folderImport");
      await importPaths(paths);
    } catch {
      toast(translate("import.folderPickerUnavailable"));
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
        toast(
          translate("library.removed", {
            count: formatNumber(result.removed),
          }),
        );
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        notifyError("remove_books", e);
      }
    },
    [debounced, formatNumber, reload, selectedBook],
  );

  const onRemoveMissing = useCallback(
    (book: BookInfo) => {
      setRelocatingBook(null);
      void doRemove([book.id]);
    },
    [doRemove],
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
        if (result.errors.length > 0) {
          notifyError("remove_books", result.errors[0]);
        }
        if (onlineCount > 0 && localCount === 0) {
          toast(
            translate("library.deletedOnlineOnly", {
              count: formatNumber(onlineCount),
            }),
          );
        } else if (onlineCount > 0) {
          toast(
            translate("library.deletedMixed", {
              files: formatNumber(result.deletedFiles),
              count: formatNumber(onlineCount),
            }),
          );
        } else {
          toast(
            result.deletedFiles > 0
              ? translate("library.deletedLocal", {
                  files: formatNumber(result.deletedFiles),
                })
              : translate("library.deletedNone"),
          );
        }
        if (selectedBook && ids.includes(selectedBook.id)) {
          setSheetOpen(false);
          setSelectedBook(null);
        }
        setCheckedIds(new Set());
        await reload(debounced);
      } catch (e) {
        notifyError("remove_books", e);
      }
    },
    [debounced, formatNumber, reload, selectedBook],
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

  const totalBooks = safeMode
    ? accessibleAllBooks.length
    : dash?.totalBooks ?? allBooks.length;
  const readingCount = dash?.reading ?? 0;
  const todayPages = dash?.todayPages ?? 0;
  const emptyMessage =
    debounced.length > 0
      ? t("library.emptySearch")
      : sourceFilter !== "all"
        ? t("library.emptyFilter")
        : t("library.emptyLibrary");

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1500px] px-5 pb-24 pt-4 sm:px-8">
      <header className="flex w-full min-w-0 flex-col gap-5">
        {safeMode ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-border bg-secondary px-4 py-3 shadow-hard-sm"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-warning text-background shadow-hard-sm">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-extrabold">{t("safeMode.libraryNoticeTitle")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("safeMode.libraryNoticeBody")}
              </p>
            </div>
          </div>
        ) : null}
        <div className="flex w-full min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              {t("nav.library")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("library.summary", {
                total: formatNumber(totalBooks),
                reading: formatNumber(readingCount),
                today: formatNumber(todayPages),
              })}
            </p>
          </div>

          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {/* 本地导入唯一入口对：导入文件夹 / 导入压缩包（另支持整窗拖拽）。 */}
            <Button
              variant="pill-primary"
              size="pill"
              onClick={() => void onAddFolder()}
              title={t("library.addFolderTitle")}
              disabled={importing !== null}
            >
              <FolderPlus />
              {t("library.addFolder")}
            </Button>
            <Button
              variant="pill"
              size="pill"
              onClick={() => void onAddFiles()}
              title={t("library.addBooksTitle")}
              disabled={importing !== null}
            >
              <Plus />
              {t("library.addBooks")}
            </Button>
            <Button
              variant={selectMode ? "pill-primary" : "pill"}
              size="pill"
              onClick={toggleSelectMode}
              aria-pressed={selectMode}
              title={t("library.manageTitle")}
            >
              {selectMode ? <Check /> : <ListChecks />}
              {selectMode ? t("library.done") : t("library.manage")}
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
          <span className="whitespace-nowrap tabular-nums" aria-live="polite">
            {groupSeries
              ? t("library.countGroups", {
                  count: formatNumber(displayBooks.length),
                })
              : t("library.countBooks", {
                  count: formatNumber(displayBooks.length),
                })}
          </span>
        </div>
      </div>

      <section className="mt-6" aria-busy={loading}>
        {loadError !== null ? (
          <ErrorState
            message={t("library.loadFailed", {
              error: loadError || t("common.error"),
            })}
            onRetry={() => void reload(debounced)}
          />
        ) : loading && books.length === 0 ? (
          <LibrarySkeleton />
        ) : visibleBooks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-10 text-center shadow-hard-sm">
            <PixelPet mode="empty" message={emptyMessage} />
            {/* 空状态不再重复渲染导入按钮：顶栏右侧是唯一导入入口。 */}
            <p className="mt-4 text-xs text-muted-foreground">
              {t("library.dragHint")}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {shownBooks.map(({ book, seriesCount }) => (
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
                  onMissing={(bookId) => {
                    const book = findBook(bookId);
                    if (book) openRelocate(book);
                  }}
                  deferSelect
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="pill"
                  size="pill"
                  onClick={() =>
                    setVisibleLimit((limit) =>
                      Math.min(limit + PAGE_SIZE, displayBooks.length),
                    )
                  }
                >
                  <Plus />
                  {t("library.loadMore", {
                    count: formatNumber(displayBooks.length - visibleLimit),
                  })}
                </Button>
              </div>
            )}
            <div ref={loadMoreRef} className="h-px w-full" aria-hidden />
            {!selectMode && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t("library.cardHint")}
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
              label: t("menu.details"),
              icon: <BookOpen />,
              onSelect: () => openDetail(ctxBook),
            },
            {
              label: ctxBook.missing
                ? t("relocate.choose")
                : t("menu.continue"),
              icon: <BookMarked />,
              onSelect: () =>
                ctxBook.missing
                  ? openRelocate(ctxBook)
                  : openReader(ctxBook.id),
            },
            {
              label: t("menu.remove"),
              icon: <BookX />,
              onSelect: () => void doRemove([ctxBook.id]),
            },
            {
              label:
                ctxBook.sourceType === "local"
                  ? t("menu.deleteLocal")
                  : t("menu.deleteOnline"),
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
          title={t(
            deleteMixed
              ? "confirm.titleMixed"
              : deleteOnline.length > 0
                ? "confirm.titleOnline"
                : "confirm.titleLocal",
            {
              count: formatNumber(deleteTargets.length),
              pages: formatNumber(deletePages),
            },
          )}
          message={
            deleteMixed
              ? t("confirm.messageMixed", {
                  local: formatNumber(deleteLocal.length),
                  online: formatNumber(deleteOnline.length),
                })
              : deleteOnline.length > 0
                ? t("confirm.messageOnline")
                : t("confirm.messageLocal")
          }
          // 隐私：在线清单 URL 可能带临时 query token / hash / userinfo，
          // 复用 sourceDisplay 的脱敏结果，确认框不直出 b.path。
          paths={deleteTargets.map((book) => {
            const source = sourceDisplay(book);
            return t("confirm.pathLine", {
              source: t(
                source.kind === "local" ? "source.local" : "source.url",
              ),
              name: source.text,
              pages: formatNumber(book.pageCount),
            });
          })}
          confirmText={t(
            deleteMixed
              ? "confirm.confirmMixed"
              : deleteOnline.length > 0
                ? "confirm.confirmOnline"
                : "confirm.confirmLocal",
          )}
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
                {t("import.progress", {
                  done: formatNumber(importing.done + 1),
                  total: formatNumber(importing.total),
                })}
              </span>
              <span className="ml-auto shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
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

      <BookDetailSheet
        book={sheetBook}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        seriesBooks={detailSeriesBooks}
        onRead={(book, page) => openReader(book.id, page)}
        onRemove={(book) => void doRemove([book.id])}
        onRelocate={openRelocate}
        // Destructive source deletion goes through the shared confirm dialog.
        onDelete={(book) => setConfirmDelete([book])}
      />

      <RelocateDialog
        book={relocatingBook}
        open={relocatingBook !== null}
        onOpenChange={(next) => {
          if (!next) setRelocatingBook(null);
        }}
        onRelocated={onRelocated}
        onRemove={onRemoveMissing}
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
                {t("import.dropTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("import.dropHint")}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
