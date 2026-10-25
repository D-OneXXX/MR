import { useEffect, useMemo, useState } from "react";
import { Ban, Loader2, RotateCcw } from "lucide-react";
import { api, type FilteredPage } from "@/lib/tauri";
import { useI18n, type MessageKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  items: FilteredPage[];
  restoringIndex: number | null;
  onRestore: (index: number) => void;
}

function displayName(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? url.hostname);
  } catch {
    const clean = raw.split("?")[0].split("#")[0];
    return clean.split("/").filter(Boolean).pop() ?? clean;
  }
}

/** Reader 内“已过滤杂图”抽屉：预览、原因、恢复。 */
export default function FilteredPagesSheet({
  open,
  onOpenChange,
  bookId,
  items,
  restoringIndex,
  onRestore,
}: Props) {
  const { t } = useI18n();
  const [previews, setPreviews] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open || !bookId || items.length === 0) return;
    let alive = true;
    // 过滤抽屉通常只有几张；全部懒加载但用 allSettled 容忍单张失败。
    void Promise.allSettled(
      items.map(async (_, index) => {
        if (previews[index]) return;
        const image = await api.getFilteredPreview(bookId, index);
        if (alive && image.dataUrl) {
          setPreviews((prev) => ({ ...prev, [index]: image.dataUrl }));
        }
      }),
    );
    return () => {
      alive = false;
    };
    // previews 故意不加入依赖：只在打开/条目变化时补载缺失项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bookId, items]);

  useEffect(() => {
    if (!open) setPreviews({});
  }, [open]);

  const rows = useMemo(
    () =>
      items.map((item, index) => {
        const code = item.reason.split(":")[0];
        const key = `reader.filter.reason.${code}` as MessageKey;
        const translated = t(key);
        return {
          item,
          index,
          reason: translated === key ? item.reason : translated,
          name: displayName(item.url),
        };
      }),
    [items, t],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-reader-hud
        data-testid="filtered-pages-sheet"
        className="reader-portal w-full! gap-0! border-l-border! bg-card! p-0! text-card-foreground! shadow-hard! sm:w-[420px]! sm:max-w-[420px]!"
      >
        <SheetHeader className="border-b border-border/70 px-5 py-4 pr-12">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-sm font-bold">
              {t("reader.filter.drawerTitle")}
            </SheetTitle>
            <Badge
              variant="secondary"
              className="mono border-border/60 px-2 py-0.5 text-[10px]"
            >
              {items.length}
            </Badge>
          </div>
          <SheetDescription className="text-[11px] leading-relaxed text-muted-foreground">
            {t("reader.filter.drawerDescription")}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          {items.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
              <Ban className="size-5" />
              {t("reader.filter.empty")}
            </div>
          ) : (
            <ul className="flex flex-col gap-2 p-4">
              {rows.map(({ item, index, reason, name }) => (
                <li
                  key={`${item.order}-${item.url}`}
                  className="flex gap-3 rounded-xl border border-border/60 bg-background/40 p-2.5"
                >
                  <div className="flex h-[92px] w-[68px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-muted/30">
                    {previews[index] ? (
                      <img
                        src={previews[index]}
                        alt={t("reader.filter.previewAlt")}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Ban className="size-4 text-muted-foreground/60" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold" title={name}>
                      {name}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                      <span>{reason}</span>
                      {item.width && item.height ? (
                        <span className="mono">
                          {t("reader.filter.size", {
                            width: item.width,
                            height: item.height,
                          })}
                        </span>
                      ) : null}
                      <span>
                        {t("reader.filter.pageLabel", { page: item.order + 1 })}
                      </span>
                    </div>
                    <Button
                      data-testid="restore-filtered-page"
                      variant="pill"
                      size="pill-sm"
                      className="mt-2"
                      disabled={restoringIndex !== null}
                      onClick={() => onRestore(index)}
                    >
                      {restoringIndex === index ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      {restoringIndex === index
                        ? t("reader.filter.restoring")
                        : t("reader.filter.restore")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
