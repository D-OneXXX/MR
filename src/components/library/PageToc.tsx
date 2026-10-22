import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ListTree,
  Search,
} from "lucide-react";
import { api, type PageEntry } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { translate, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";

const TOC_WINDOW = 60;

export interface PageTocProps {
  bookId: string;
  pageCount: number;
  /** 当前阅读页（1 起）；用于高亮。 */
  currentPage?: number;
  /** 选中某一页（1 起）。 */
  onSelect: (page: number) => void;
}

/**
 * 页面目录（替代 BookInspector 的内嵌 TOC）：
 * 展开时才拉取 listEntries，支持搜索与 60 条窗口；“显示全部 / 收起”切换。
 */
export default function PageToc({
  bookId,
  pageCount,
  currentPage,
  onSelect,
}: PageTocProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PageEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  // 切书时收起并清空，下一次展开重新懒加载。
  useEffect(() => {
    setOpen(false);
    setEntries(null);
    setError(null);
    setQuery("");
    setExpanded(false);
  }, [bookId]);

  useEffect(() => {
    if (!open || entries !== null) return;
    let alive = true;
    setError(null);
    api.listEntries(bookId).then(
      (rows) => {
        if (!alive) return;
        setEntries([...rows].sort((a, b) => a.index - b.index));
      },
      (e) => {
        if (!alive) return;
        setEntries([]);
        setError(
          typeof e === "string" ? e : translate("toc.errorFallback"),
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [open, entries, bookId]);

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

  const shown = expanded ? filtered : filtered.slice(0, TOC_WINDOW);
  const loading = open && entries === null && error === null;
  const canWindow = filtered.length > TOC_WINDOW;

  const retry = () => {
    setEntries(null);
    setError(null);
  };

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="detail-page-toc"
        className="flex h-10 w-full items-center gap-2 rounded-full border border-border bg-card px-4 text-left text-sm font-semibold text-foreground shadow-hard-sm outline-none transition-transform hover:-translate-y-px hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:shadow-none"
      >
        <ListTree className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{t("toc.title")}</span>
        <span className="font-mono text-[11px] font-normal text-muted-foreground">
          {t("toc.pageCount", { count: pageCount })}
        </span>
        {open ? (
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div id="detail-page-toc" className="flex flex-col gap-2 pt-1">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setExpanded(false);
              }}
              placeholder={t("toc.searchPlaceholder")}
              aria-label={t("toc.searchAria")}
              className="h-9 min-w-0 rounded-full pl-9 font-mono text-xs"
            />
          </div>

          {loading ? (
            <PixelPet mode="loading" message={t("toc.loading")} />
          ) : error ? (
            <ErrorState
              message={t("toc.error", { error })}
              onRetry={retry}
            />
          ) : filtered.length === 0 ? (
            <PixelPet
              message={
                (entries?.length ?? 0) === 0
                  ? t("toc.emptyBook")
                  : t("toc.emptySearch")
              }
            />
          ) : (
            <>
              <div className="max-h-64 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card">
                <ul className="divide-y divide-border/60">
                  {shown.map((entry) => {
                    const page = entry.index + 1;
                    const active = page === currentPage;
                    return (
                      <li key={entry.index}>
                        <button
                          type="button"
                          onClick={() => onSelect(page)}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset",
                            active && "bg-accent font-semibold",
                          )}
                        >
                          <span className="w-9 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                            {page}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {entry.name || t("toc.pageLabel", { page })}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="font-mono text-[10px] text-muted-foreground"
                  role="status"
                >
                  {t("toc.showing", {
                    shown: shown.length,
                    total: filtered.length,
                  })}
                </span>
                {canWindow && (
                  <Button
                    variant="pill-ghost"
                    size="pill-sm"
                    className="ml-auto whitespace-nowrap"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? (
                      <>
                        <ChevronUp />
                        {t("toc.collapse")}
                      </>
                    ) : (
                      <>
                        <ChevronDown />
                        {t("toc.showAll", { count: filtered.length })}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
