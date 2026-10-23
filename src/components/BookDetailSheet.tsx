import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Layers,
  Loader2,
  MapPin,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { api, type BookInfo, type HeatDay } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { sourceDisplay } from "@/lib/sourceDisplay";
import { translate, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import PageToc from "@/components/library/PageToc";

export interface BookDetailSheetProps {
  book: BookInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesBooks?: BookInfo[];
  onRead: (book: BookInfo, page?: number) => void;
  onRemove: (book: BookInfo) => void;
  onDelete: (book: BookInfo) => void;
  /** 文件位置失效：打开重定位引导。 */
  onRelocate?: (book: BookInfo) => void;
}

function sortChapters(list: BookInfo[]): BookInfo[] {
  return [...list].sort((a, b) => {
    const ai = a.chapterIndex;
    const bi = b.chapterIndex;
    if (ai != null && bi != null && ai !== bi) return ai - bi;
    if (ai != null && bi == null) return -1;
    if (ai == null && bi != null) return 1;
    return a.title.localeCompare(b.title, "zh", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * 书库详情 Sheet（右侧滑出，shadcn Sheet / Base UI）：
 * 封面 + 元信息 + 阅读进度 + 页面目录 + 章节选集 + 近 30 天阅读活动 + 危险操作。
 * 仅在打开时按需拉取数据。
 */
export default function BookDetailSheet({
  book,
  open,
  onOpenChange,
  seriesBooks,
  onRead,
  onRemove,
  onDelete,
  onRelocate,
}: BookDetailSheetProps) {
  return (
    <Sheet open={open && book !== null} onOpenChange={onOpenChange}>
      {book ? (
        <BookDetailSheetBody
          key={book.id}
          book={book}
          active={open}
          onOpenChange={onOpenChange}
          seriesBooks={seriesBooks}
          onRead={onRead}
          onRemove={onRemove}
          onDelete={onDelete}
          onRelocate={onRelocate}
        />
      ) : null}
    </Sheet>
  );
}

function BookDetailSheetBody({
  book,
  active,
  onOpenChange,
  seriesBooks,
  onRead,
  onRemove,
  onDelete,
  onRelocate,
}: {
  book: BookInfo;
  active: boolean;
  onOpenChange: (open: boolean) => void;
  seriesBooks?: BookInfo[];
  onRead: (book: BookInfo, page?: number) => void;
  onRemove: (book: BookInfo) => void;
  onDelete: (book: BookInfo) => void;
  onRelocate?: (book: BookInfo) => void;
}) {
  const { t } = useI18n();
  const [cover, setCover] = useState<string | null>(null);

  const online = book.sourceType !== "local";
  const missing = book.missing;
  const source = sourceDisplay(book);
  const sourceKindLabel = t(
    source.kind === "local" ? "source.local" : "source.online",
  );
  const sourceText = source.text || t("source.hiddenAddress");
  const read = Math.max(0, Math.min(book.currentPage, book.pageCount));
  const pct =
    book.pageCount > 0
      ? Math.min(100, Math.round((read / book.pageCount) * 100))
      : 0;

  useEffect(() => {
    if (!active) return;
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
  }, [active, book.id]);

  const startReading = (page: number) => {
    if (book.missing) {
      onOpenChange(false);
      onRelocate?.(book);
      return;
    }
    onOpenChange(false);
    onRead(book, page);
  };

  const removeBook = () => {
    onOpenChange(false);
    onRemove(book);
  };

  const deleteBook = () => {
    onOpenChange(false);
    onDelete(book);
  };

  const deleteLabel = online ? t("book.deleteOnline") : t("book.deleteLocal");

  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      className="w-[min(92vw,560px)] gap-0 overflow-hidden border-l border-border bg-popover p-0 data-[side=right]:w-[min(92vw,560px)]! data-[side=right]:sm:max-w-[560px]!"
    >
      <Button
        variant="pill-ghost"
        size="pill-icon-sm"
        className="absolute right-3 top-3 z-10"
        onClick={() => onOpenChange(false)}
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        <X />
      </Button>

      <SheetHeader className="shrink-0 gap-3 border-b border-border px-5 pb-4 pt-5">
        <SheetDescription className="sr-only">
          {t("book.metaDescription")}
        </SheetDescription>

        <div className="flex items-start gap-3 pr-8">
          <div className="aspect-[3/4] w-20 shrink-0 overflow-hidden rounded-xl border border-border bg-muted shadow-hard-sm">
            {cover ? (
              <img
                src={cover}
                alt=""
                draggable={false}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <BookOpen className="size-6" strokeWidth={1.5} />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <SheetTitle
              className="line-clamp-2 text-base font-bold leading-snug text-foreground"
              title={book.title}
            >
              {book.title}
            </SheetTitle>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant={online ? "secondary" : "muted"}>
                {sourceKindLabel}
              </Badge>
              {missing && (
                <Badge variant="warning">
                  <AlertTriangle />
                  {t("card.missing")}
                </Badge>
              )}
              {book.seriesTitle && (
                <Badge
                  variant="outline"
                  className="max-w-[180px] truncate"
                  title={book.seriesTitle}
                >
                  {book.seriesTitle}
                </Badge>
              )}
              {book.chapterIndex != null && (
                <Badge variant="muted">
                  {t("book.chapterBadge", { number: book.chapterIndex })}
                </Badge>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">
                {t("book.pageCount", { count: book.pageCount })}
              </span>
            </div>

            <div className="mt-1.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="shrink-0">{t("common.source")}</span>
              <span className="truncate font-mono" title={sourceText}>
                {sourceText}
              </span>
            </div>

            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {t("book.readLabel")}{" "}
                <span className="font-mono text-foreground">{read}</span> /{" "}
                <span className="font-mono">{book.pageCount}</span>
              </span>
              <span className="font-mono font-semibold text-foreground">
                {pct}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t("book.progressAria")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>

        {missing ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground">
                  {t("card.missing")}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {t("book.missingNotice")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={() => {
                  onOpenChange(false);
                  onRelocate?.(book);
                }}
              >
                <MapPin />
                {t("relocate.choose")}
              </Button>
              <Button
                variant="pill"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={removeBook}
              >
                <Trash2 />
                {t("relocate.remove")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="pill-primary"
              size="pill-sm"
              className="min-w-[128px] flex-1"
              onClick={() => startReading(book.currentPage + 1)}
            >
              <Play className="fill-current" />
              {t("book.continue")}
            </Button>
            <Button
              variant="pill"
              size="pill-sm"
              className="whitespace-nowrap"
              onClick={() => startReading(1)}
            >
              <RotateCcw />
              {t("book.startOver")}
            </Button>
          </div>
        )}
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        <div className="flex flex-col gap-4">
          {missing ? null : (
            <>
              <PageToc
                bookId={book.id}
                pageCount={book.pageCount}
                currentPage={
                  book.currentPage > 0 ? book.currentPage + 1 : undefined
                }
                onSelect={startReading}
              />

              <SeriesSection
                book={book}
                active={active}
                seriesBooks={seriesBooks}
                onOpenChange={onOpenChange}
                onRead={onRead}
              />
            </>
          )}

          <ActivitySection book={book} active={active} />
        </div>
      </div>

      <SheetFooter className="shrink-0 gap-1.5 border-t border-border bg-muted/30 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="pill"
            size="pill-sm"
            className="whitespace-nowrap"
            onClick={removeBook}
          >
            <Trash2 />
            {t("book.removeRecord")}
          </Button>
          <Button
            variant="pill-danger"
            size="pill-sm"
            className="whitespace-nowrap"
            onClick={deleteBook}
          >
            <Trash2 />
            {deleteLabel}
          </Button>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t("book.footerKeep")}{" "}
          {online
            ? t("book.footerDangerOnline")
            : t("book.footerDangerLocal")}
        </p>
      </SheetFooter>
    </SheetContent>
  );
}

function SeriesSection({
  book,
  active,
  seriesBooks,
  onOpenChange,
  onRead,
}: {
  book: BookInfo;
  active: boolean;
  seriesBooks?: BookInfo[];
  onOpenChange: (open: boolean) => void;
  onRead: (book: BookInfo, page?: number) => void;
}) {
  const { t } = useI18n();
  const [fetched, setFetched] = useState<BookInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const provided = seriesBooks && seriesBooks.length > 1 ? seriesBooks : null;
  const seriesId = book.seriesId ?? null;
  const shouldFetch = provided === null && seriesId !== null;

  useEffect(() => {
    if (!active || !shouldFetch || !seriesId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api.getSeriesBooks(seriesId).then(
      (rows) => {
        if (!alive) return;
        setFetched(sortChapters(rows));
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setFetched([]);
        setError(
          typeof e === "string" ? e : translate("book.seriesErrorFallback"),
        );
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [active, shouldFetch, seriesId, tick]);

  const list = useMemo(
    () => sortChapters(provided ?? fetched ?? []),
    [provided, fetched],
  );

  if (!book.seriesId && list.length <= 1) return null;

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <Layers className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-bold text-foreground">
          {t("book.seriesTitle")}
        </h3>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {list.length > 0
            ? t("book.seriesCount", { count: list.length })
            : "…"}
        </span>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("book.seriesLoading")}
        </p>
      ) : error ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
            {t("book.seriesError", { error })}
          </p>
          <Button
            variant="pill-ghost"
            size="pill-sm"
            onClick={() => setTick((value) => value + 1)}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("book.seriesEmpty")}</p>
      ) : (
        <div className="max-h-52 overflow-y-auto overscroll-contain pr-1">
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {list.map((chapter, index) => {
              const activeChapter = chapter.id === book.id;
              const done =
                chapter.pageCount > 0 &&
                chapter.currentPage >= chapter.pageCount - 1;
              const no = chapter.chapterIndex ?? index + 1;
              return (
                <button
                  key={chapter.id}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onRead(chapter);
                  }}
                  title={chapter.title}
                  aria-current={activeChapter ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 flex-col justify-center gap-0.5 rounded-xl border px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    activeChapter
                      ? "border-primary bg-primary text-primary-foreground shadow-hard-sm"
                      : "border-border bg-card text-foreground hover:bg-accent",
                  )}
                >
                  <span className="flex w-full items-center gap-1">
                    <span className="font-mono text-[11px] font-bold">
                      {String(no).padStart(2, "0")}
                    </span>
                    {done && (
                      <Check
                        className={cn(
                          "ml-auto size-3",
                          activeChapter
                            ? "text-primary-foreground"
                            : "text-success",
                        )}
                        aria-label={t("book.chapterDone")}
                      />
                    )}
                  </span>
                  <span className="w-full truncate text-[10px] opacity-80">
                    {chapter.title}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ActivitySection({
  book,
  active,
}: {
  book: BookInfo;
  active: boolean;
}) {
  const { t } = useI18n();
  const [log, setLog] = useState<HeatDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setLog(null);
    api.getReadingLog(book.id, 30).then(
      (rows) => {
        if (!alive) return;
        setLog(rows);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setLog([]);
        setError(
          typeof e === "string" ? e : translate("book.activityErrorFallback"),
        );
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [active, book.id, tick]);

  const total = (log ?? []).reduce((sum, day) => sum + day.count, 0);
  const activeDays = (log ?? []).filter((day) => day.count > 0).length;

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-bold text-foreground">
          {t("book.activityTitle")}
        </h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t("book.activityRange")}
        </span>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("book.activityLoading")}
        </p>
      ) : error ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
            {t("book.activityError")}
          </p>
          <Button
            variant="pill-ghost"
            size="pill-sm"
            onClick={() => setTick((value) => value + 1)}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-border bg-card px-3 py-2.5 shadow-hard-sm">
              <p className="font-mono text-xl font-bold leading-none text-foreground">
                {total}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("book.pagesRead")}
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card px-3 py-2.5 shadow-hard-sm">
              <p className="font-mono text-xl font-bold leading-none text-foreground">
                {activeDays}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("book.activeDays")}
              </p>
            </div>
          </div>
          {total === 0 && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ChevronRight className="size-3" />
              {t("book.activityEmpty")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
