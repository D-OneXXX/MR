import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Check, Layers } from "lucide-react";
import { useI18n } from "@/i18n";
import { api, type BookInfo } from "@/lib/tauri";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Props {
  book: BookInfo;
  /** 聚合卡片的同系列总话数（全局、未过滤口径）。 */
  seriesCount?: number;
  /** 多选模式：单击卡片 = 勾选，而不是打开详情。 */
  selectMode?: boolean;
  checked?: boolean;
  onToggleCheck?: (bookId: string) => void;
  /** 单击选中：传入封面矩形，便于上层做 shared-element。 */
  onSelect?: (bookId: string, originRect: DOMRect | null) => void;
  onOpen?: (bookId: string) => void;
  /** 源文件丢失：单击/双击/Enter 一律转去「重新指定位置」，绝不进入阅读。 */
  onMissing?: (bookId: string) => void;
  onContextMenu?: (e: React.MouseEvent, bookId: string) => void;
  /** 延迟单击，留出双击判定窗口，避免详情 sheet 抢走第二次点击。 */
  deferSelect?: boolean;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * 冰蓝胶囊风格书卡：白色卡片 + 硬阴影 + 3:4 封面。
 * 单击详情、双击阅读、Shift+Enter 阅读；右键交给上层弹菜单。
 */
export default function BookCard({
  book,
  seriesCount,
  selectMode,
  checked,
  onToggleCheck,
  onSelect,
  onOpen,
  onMissing,
  onContextMenu,
  deferSelect,
}: Props) {
  const { t, formatNumber } = useI18n();
  const [cover, setCover] = useState<string | null>(null);
  const [coverLoading, setCoverLoading] = useState(true);
  const [inView, setInView] = useState(false);
  const clickTimer = useRef<number>(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const isSeries = !!book.seriesId && (seriesCount ?? 1) > 1;
  const missing = book.missing;

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  // 封面缩略图只在卡片接近视口时才请求，避免大书库一次性打满 IPC + 解码。
  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    setCover(null);
    setCoverLoading(true);
    api.getThumbnail(book.id, 256).then(
      (img) => {
        if (!alive) return;
        setCover(img.dataUrl);
        setCoverLoading(false);
      },
      () => {
        if (!alive) return;
        setCover(null);
        setCoverLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [book.id, inView]);

  const pct =
    book.pageCount > 0
      ? Math.min(100, Math.round((book.currentPage / book.pageCount) * 100))
      : 0;
  const totalPages = formatNumber(book.pageCount);
  const sub =
    book.currentPage > 0
      ? t("card.readPages", {
          current: formatNumber(book.currentPage),
          total: totalPages,
        })
      : t("card.notStarted", { total: totalPages });

  const clearPendingClick = () => {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = 0;
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    clearPendingClick();
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    // 源文件丢失：延迟到双击窗口之后再弹「重新指定位置」，
    // 避免第一次点击就把弹窗打开、第二次点击正好落在遮罩上把它关掉。
    if (missing) {
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onMissing?.(book.id);
      }, 240);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (deferSelect) {
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onSelect?.(book.id, rect);
      }, 240);
      return;
    }
    onSelect?.(book.id, rect);
  };

  const activate = (openReader: boolean) => {
    clearPendingClick();
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    if (missing) {
      onMissing?.(book.id);
      return;
    }
    if (openReader) onOpen?.(book.id);
    else onSelect?.(book.id, null);
  };

  const seriesLabel = isSeries
    ? t("card.seriesBadge", { count: formatNumber(seriesCount ?? 1) })
    : "";
  const ariaLabel = t("card.ariaLabel", {
    title: book.title,
    status:
      book.currentPage > 0
        ? t("card.ariaStatusRead", {
            current: formatNumber(book.currentPage),
            total: totalPages,
          })
        : t("card.ariaStatusNotStarted", { total: totalPages }),
    series: isSeries
      ? t("card.ariaSeries", { count: formatNumber(seriesCount ?? 1) })
      : "",
    online: book.sourceType !== "local" ? t("card.ariaOnline") : "",
    missing: missing ? t("card.ariaMissing") : "",
    hint: selectMode ? t("card.ariaHintSelect") : t("card.ariaHintOpen"),
  });

  return (
    <div
      ref={cardRef}
      className={cn(
        "group relative flex cursor-pointer select-none flex-col rounded-2xl border border-border bg-card p-2 shadow-card transition-all duration-200 ease-out hover:-translate-y-1 hover:shadow-hard",
        checked && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        FOCUS_RING,
      )}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selectMode ? !!checked : undefined}
      title={
        selectMode
          ? t("card.titleSelect", { title: book.title })
          : t("card.titleOpen", { title: book.title })
      }
      onClick={handleClick}
      onDoubleClick={() => {
        if (selectMode) return;
        clearPendingClick();
        if (missing) {
          onMissing?.(book.id);
          return;
        }
        onOpen?.(book.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate(e.shiftKey);
        } else if (e.key === " ") {
          e.preventDefault();
          activate(false);
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, book.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-border bg-muted">
        {coverLoading ? (
          <Skeleton className="absolute inset-0 rounded-xl" />
        ) : cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setCover(null)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <BookOpen className="size-7" strokeWidth={1.5} />
          </div>
        )}

        {selectMode && (
          <span
            className={cn(
              "absolute left-2 top-2 z-20 grid size-6 place-items-center rounded-full border-2 border-border shadow-hard-sm transition-colors",
              checked
                ? "bg-primary text-primary-foreground"
                : "bg-card/90 text-transparent",
            )}
            aria-hidden
          >
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        )}

        {isSeries && (
          <Badge
            variant="outline"
            className="absolute bottom-2 left-2 z-10 max-w-[calc(100%_-_1rem)] border-border bg-card/90 px-2 py-0.5 text-[10px] font-semibold text-foreground shadow-hard-sm backdrop-blur-sm"
          >
            <Layers />
            <span className="min-w-0 truncate">{seriesLabel}</span>
          </Badge>
        )}

        {book.sourceType !== "local" && (
          <Badge
            variant="default"
            className="absolute right-2 top-2 z-10 shrink-0 whitespace-nowrap px-2 py-0.5 text-[10px] font-bold tracking-wide shadow-hard-sm"
          >
            {t("source.url")}
          </Badge>
        )}

        {missing && (
          <Badge
            variant="warning"
            className="absolute bottom-2 right-2 z-10 max-w-[calc(100%_-_1rem)] border-border bg-warning/95 px-2 py-0.5 text-[10px] font-bold text-background shadow-hard-sm"
          >
            <AlertTriangle />
            <span className="min-w-0 truncate">{t("card.missing")}</span>
          </Badge>
        )}
      </div>

      <div className="min-w-0 px-1 pb-1 pt-2.5">
        <h3 className="truncate text-sm font-bold tracking-tight text-foreground">
          {book.title}
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold tabular-nums text-muted-foreground">
            {t("card.progress", { percent: formatNumber(pct) })}
          </span>
        </div>
      </div>
    </div>
  );
}
