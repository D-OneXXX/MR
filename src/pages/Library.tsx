import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Link2, ListChecks, Plus, Search } from "lucide-react";
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
import BookCard from "../components/BookCard";
import ContextMenu from "../components/ContextMenu";
import ConfirmDialog from "../components/ConfirmDialog";
import ErrorState from "../components/ErrorState";
import PixelPet from "../components/PixelPet";
import DetailSheet from "../components/DetailSheet";
import OnlineImportDialog, {
  LIBRARY_REFRESH_EVENT,
  useOnlineHandoffState,
} from "../components/OnlineImportDialog";
import { toast, toastErr, Toaster } from "../components/Toast";

/**
 * 书库主页（`/`）— 流体 v2：封面是主角。
 * slim 数据条 + 添加书籍（文件多选/全窗口拖拽/扫描目录）+ 封面流；
 * 点击封面 → 详情 sheet；双击 → 阅读器；右键菜单与多选工具条提供
 * 「移除」（可逆，源文件保留）与「删除源文件」（不可逆，二次确认+级联清理）。
 * 完整数据看板在独立「数据」视图（/data）。
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
  const [originRect, setOriginRect] = useState<DOMRect | null>(null);

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

  const displayBooks = useMemo(() => {
    if (!groupSeries) {
      return books.map((book) => {
        const sid = book.seriesId?.trim();
        return { book, seriesCount: sid ? seriesCountMap.get(sid) ?? 1 : 1 };
      });
    }
    const groups = new Map<string, { book: BookInfo; filteredCount: number }>();
    for (const book of books) {
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
  }, [books, groupSeries, seriesCountMap]);

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
    setSelectedId(null);
    setOriginRect(null);
  }, []);

  const onSelect = useCallback((id: string, rect: DOMRect | null) => {
    setOriginRect(rect);
    setSelectedId(id);
  }, []);

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

  const dataline = loading
    ? "正在载入书架…"
    : `藏书 ${dash?.totalBooks ?? books.length} · 在读 ${dash?.reading ?? 0} · 今日 ${dash?.todayPages ?? 0} 页`;

  const ctxBook = ctxMenu ? books.find((b) => b.id === ctxMenu.bookId) ?? null : null;
  const deleteTargets = confirmDelete;
  const deletePages = deleteTargets?.reduce((s, b) => s + b.pageCount, 0) ?? 0;
  const deleteLocal = deleteTargets?.filter((b) => b.sourceType === "local") ?? [];
  const deleteOnline = deleteTargets?.filter((b) => b.sourceType !== "local") ?? [];
  const deleteMixed = deleteLocal.length > 0 && deleteOnline.length > 0;

  return (
    <div>
      {/* slim 数据条：一行小字 + 搜索 / 添加书籍 / 扫描目录 / 多选 */}
      <div className="lib-topbar">
        <span className="lib-dataline mono" aria-label="书库概览">
          {dataline}
        </span>
        <div className="lib-tools">
          <div style={{ position: "relative", display: "flex", flex: 1, maxWidth: 240 }}>
            <Search
              size={15}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--muted)",
              }}
            />
            <input
              className="input"
              style={{ flex: 1, paddingLeft: 30 }}
              placeholder="搜索书名…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              aria-label="搜索书名"
            />
          </div>
          <div className="seg lib-view-toggle" role="group" aria-label="书库视图">
            <button
              className={groupSeries ? "on" : ""}
              onClick={() => setGroupSeries(true)}
              title="同一合集只显示代表卡"
            >
              按合集聚合
            </button>
            <button
              className={!groupSeries ? "on" : ""}
              onClick={() => setGroupSeries(false)}
              title="逐个章节平铺显示"
            >
              全部平铺
            </button>
          </div>
          {onlineOn && (
            <button
              className="btn"
              onClick={() => setOnlineOpen(true)}
              title={
                handoffStatus?.active
                  ? "配对会话进行中，点击打开查看或停止"
                  : "从 JSON 清单或单页 HTML 图集导入"
              }
            >
              <Link2 size={14} />{" "}
              {handoffStatus?.active ? "配对中（打开查看/停止）" : "URL 直读"}
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => void onAddFiles()}
            title="选择压缩包（zip / cbz）导入"
          >
            <Plus size={14} /> 添加书籍
          </button>
          <button
            className="btn"
            onClick={() => void onAddFolder()}
            title="选择一个文件夹（其内容 = 一本书）"
          >
            <FolderOpen size={14} /> 添加文件夹
          </button>
          <button
            className={`btn${selectMode ? " primary" : ""}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            title="多选后可批量移除/删除"
          >
            <ListChecks size={14} /> {selectMode ? "完成" : "管理"}
          </button>
        </div>
      </div>

      {/* 多选工具条 */}
      {selectMode && (
        <div className="toolbar" role="toolbar" aria-label="批量操作">
          <span className="hint">已选 {checkedIds.size} 本</span>
          <button
            className="btn"
            disabled={checkedIds.size === 0}
            onClick={() => void doRemove([...checkedIds])}
          >
            移除
          </button>
          <button
            className="btn"
            disabled={checkedIds.size === 0}
            onClick={() => {
              setConfirmDelete(checkedBooks);
            }}
          >
            {batchDeleteLabel}
          </button>
          <button className="btn" onClick={exitSelectMode}>
            取消
          </button>
        </div>
      )}

      {/* 活跃的批量预翻译任务（仅实验性翻译开启且有任务时出现） */}
      {transOn && batchJobs.length > 0 && (
        <div className="card section-card">
          <div className="field-row" style={{ alignItems: "baseline" }}>
            <span style={{ fontWeight: 600 }}>批量预翻译进行中</span>
            <span className="badge mono" style={{ marginLeft: "auto" }}>
              {batchJobs.length}
            </span>
            <a className="btn" href="#/workbench">
              工作台
            </a>
          </div>
          {batchJobs.slice(0, 3).map((j) => (
            <div key={j.id} style={{ marginTop: 10 }}>
              <div className="field-row" style={{ alignItems: "baseline" }}>
                <span className="hint" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {j.bookTitle}
                </span>
                <span className="badge mono">{j.state}</span>
              </div>
              <div className="progress-track" style={{ marginTop: 4 }}>
                <div
                  className="progress-fill"
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
      ) : books.length === 0 ? (
        <PixelPet
          mode="empty"
          message={
            debounced.length > 0
              ? "没有搜到，去换个关键词吧"
              : "书架还是空的——拖入 cbz/zip/文件夹，或点「添加书籍」"
          }
        />
      ) : (
        <div className="grid-books">
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
            />
          ))}
        </div>
      )}
      {books.length > 0 && !selectMode && (
        <p className="hint" style={{ marginTop: 14 }}>
          单击封面看阅读纵深，双击进入阅读；右键封面可移除或删除源文件。
        </p>
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
                : "将从磁盘永久删除以下源文件/文件夹，并清理该书的进度、缩略图、翻译缓存等全部记录。此操作不可逆。"
          }
          paths={deleteTargets.map(
            (b) =>
              `【${b.sourceType === "local" ? "本地" : "URL"}】${b.path}（${b.pageCount} 页）`,
          )}
          confirmText={
            deleteMixed ? "删除 / 彻底移除" : deleteOnline.length > 0 ? "彻底移除" : "永久删除"
          }
          onConfirm={() => void doDeleteConfirmed()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* 导入进度（右下角小卡） */}
      {importing && (
        <div className="import-progress" role="status" aria-live="polite">
          <div className="field-row" style={{ alignItems: "baseline" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              正在导入 {importing.done + 1} / {importing.total}
            </span>
            <span className="hint mono" style={{ marginLeft: "auto" }}>
              {Math.round((importing.done / importing.total) * 100)}%
            </span>
          </div>
          <div className="progress-track" style={{ marginTop: 8 }}>
            <div
              className="progress-fill"
              style={{ width: `${(importing.done / importing.total) * 100}%` }}
            />
          </div>
          <div className="ip-current mono" title={importing.current}>
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

      {/* 浮动详情 sheet（右侧滑出，非固定栏） */}
      <DetailSheet book={selected} originRect={originRect} onClose={closeSheet} />

      <Toaster />
    </div>
  );
}
