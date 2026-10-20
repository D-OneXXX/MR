import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  List,
  MapPin,
  Search,
} from "lucide-react";
import { api, type BookInfo, type PageEntry } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { sourceDisplay } from "@/lib/sourceDisplay";
import BookDetail from "@/components/BookDetail";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";
const TOC_WINDOW = 60;

function PageToc({ book }: { book: BookInfo }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PageEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(TOC_WINDOW);

  useEffect(() => {
    if (!open || entries !== null) return;
    let alive = true;
    setError(null);
    api.listEntries(book.id).then(
      (rows) => {
        if (!alive) return;
        setEntries([...rows].sort((a, b) => a.index - b.index));
      },
      (e) => {
        if (!alive) return;
        setEntries([]);
        setError(typeof e === "string" ? e : "页面目录加载失败");
      },
    );
    return () => {
      alive = false;
    };
  }, [open, entries, book.id]);

  const filtered = useMemo(() => {
    const list = entries ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        String(entry.index + 1).includes(q),
    );
  }, [entries, query]);

  const shown = filtered.slice(0, visible);
  const loading = open && entries === null && error === null;

  const retry = () => {
    setEntries(null);
    setError(null);
  };

  return (
    <section className="mt-4 border-t border-hairline pt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="inspector-page-toc"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs font-medium text-ink transition-colors hover:text-brand",
          FOCUS_RING,
        )}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-ink-muted" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-ink-muted" />
        )}
        <List size={13} className="shrink-0 text-ink-muted" />
        <span>页面目录</span>
        <span className="mono ml-auto text-[11px] text-ink-muted">
          {book.pageCount} 页
        </span>
      </button>

      {open && (
        <div id="inspector-page-toc" className="mt-2 flex flex-col gap-2">
          <div className="relative">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
            />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setVisible(TOC_WINDOW);
              }}
              placeholder="搜索页码或文件名…"
              aria-label="搜索页面目录"
              className={cn(
                "mono h-8 w-full rounded-md border border-hairline bg-canvas pl-8 pr-2 text-xs text-ink placeholder:text-ink-muted focus:border-brand",
                FOCUS_RING,
              )}
            />
          </div>

          {loading ? (
            <p className="px-1 text-xs text-ink-muted">正在读取页面目录…</p>
          ) : error ? (
            <div className="flex items-center gap-2 px-1">
              <p className="min-w-0 flex-1 truncate text-xs text-danger" title={error}>
                目录加载失败：{error}
              </p>
              <button
                type="button"
                onClick={retry}
                className={cn(
                  "shrink-0 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink transition-colors hover:bg-accent",
                  FOCUS_RING,
                )}
              >
                重试
              </button>
            </div>
          ) : entries && entries.length === 0 ? (
            <p className="px-1 text-xs text-ink-muted">目录为空。</p>
          ) : shown.length === 0 ? (
            <p className="px-1 text-xs text-ink-muted">没有匹配的页面。</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {shown.map((entry) => (
                <button
                  key={entry.index}
                  type="button"
                  onClick={() => nav(`/reader/${encodeURIComponent(book.id)}?page=${entry.index + 1}`)}
                  className={cn(
                    "flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent",
                    FOCUS_RING,
                  )}
                >
                  <span className="mono w-10 shrink-0 text-right text-[10px] text-ink-muted">
                    {entry.index + 1}
                  </span>
                  <span className="truncate">
                    {entry.name || `第 ${entry.index + 1} 页`}
                  </span>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && filtered.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((value) => value + TOC_WINDOW)}
              className={cn(
                "mx-auto rounded-md border border-hairline px-3 py-1 text-[11px] text-ink transition-colors hover:bg-accent",
                FOCUS_RING,
              )}
            >
              加载更多（剩余 {filtered.length - visible} 页）
            </button>
          )}
          {!loading && !error && filtered.length > 0 && (
            <p className="mono px-1 text-[10px] text-ink-muted" role="status">
              显示 {shown.length} / {filtered.length} 页
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default function BookInspector({ book }: { book: BookInfo }) {
  const nav = useNavigate();
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCover(null);
    api.getThumbnail(book.id, 256).then(
      (img) => {
        if (alive) setCover(img.dataUrl);
      },
      () => {
        if (alive) setCover(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [book.id]);

  const source = sourceDisplay(book);
  // 统一口径：已读页数 = currentPage（0 = 未读），百分比 = currentPage / pageCount。
  const read = Math.min(book.currentPage, book.pageCount);
  const pct =
    book.pageCount > 0 ? Math.min(100, Math.round((read / book.pageCount) * 100)) : 0;

  return (
    <div className="p-4">
      <div className="flex gap-3">
        <div className="aspect-[3/4] w-[88px] shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-solid shadow-[inset_0_1px_0_var(--v3-inset-highlight)]">
          {cover ? (
            <img
              src={cover}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-ink-muted">
              <BookOpen size={24} strokeWidth={1.5} />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h3
            className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink"
            title={book.title}
          >
            {book.title}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              {source.badge}
            </span>
            <span className="mono text-[11px] text-ink-muted">
              {book.pageCount} 页
            </span>
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">
            已读 <span className="mono text-ink">{read}</span> /{" "}
            <span className="mono">{book.pageCount}</span> 页 ·{" "}
            <span className="mono text-ink">{pct}%</span>
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-muted">
        <MapPin size={11} aria-hidden className="shrink-0" />
        <span className="shrink-0">来源</span>
        <span className="mono truncate" title={source.text}>
          {source.text}
        </span>
      </div>

      <button
        type="button"
        onClick={() => nav(`/reader/${encodeURIComponent(book.id)}`)}
        className={cn(
          "mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-brand px-3 text-xs font-medium text-white transition-colors hover:bg-brand/90",
          FOCUS_RING,
        )}
      >
        <BookOpen size={14} />
        {book.currentPage > 0 ? "继续阅读" : "开始阅读"}
        <span className="mono text-[10px] text-white/75">
          {read}/{book.pageCount}
        </span>
      </button>

      <PageToc book={book} />

      <div className="mt-4 border-t border-hairline pt-4">
        <BookDetail book={book} />
      </div>
    </div>
  );
}
