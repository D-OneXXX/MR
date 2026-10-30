import { Clock, History, Layers, LayoutGrid } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export type SourceFilter = "all" | "local" | "online";

/** 方案 C：书库排序方式——「最近打开」或「最近阅读」。 */
export type SortMode = "recentOpened" | "recentRead";

interface Props {
  sourceFilter: SourceFilter;
  onSourceFilterChange: (filter: SourceFilter) => void;
  groupSeries: boolean;
  onGroupSeriesChange: (grouped: boolean) => void;
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
}

const CHIP =
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-4 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const CHIP_ON =
  "border-border bg-primary text-primary-foreground shadow-hard-sm";
const CHIP_OFF = "text-muted-foreground hover:bg-accent hover:text-foreground";

/** 来源分段胶囊 + 合集/平铺切换 + 排序方式，全部保留为可访问的 aria-pressed 按钮。 */
export default function LibraryFilters({
  sourceFilter,
  onSourceFilterChange,
  groupSeries,
  onGroupSeriesChange,
  sortMode,
  onSortModeChange,
}: Props) {
  const { t } = useI18n();
  const sourceOptions: { key: SourceFilter; label: string }[] = [
    { key: "all", label: t("common.all") },
    { key: "local", label: t("source.local") },
    { key: "online", label: t("source.online") },
  ];

  return (
    <>
      <div
        role="group"
        aria-label={t("library.sourceFilterAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        {sourceOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={sourceFilter === option.key}
            onClick={() => onSourceFilterChange(option.key)}
            className={cn(
              CHIP,
              sourceFilter === option.key ? CHIP_ON : CHIP_OFF,
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div
        role="group"
        aria-label={t("library.groupAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={groupSeries}
          onClick={() => onGroupSeriesChange(true)}
          title={t("library.groupSeriesTitle")}
          className={cn(CHIP, groupSeries ? CHIP_ON : CHIP_OFF)}
        >
          <Layers className="size-3.5" />
          {t("library.groupSeries")}
        </button>
        <button
          type="button"
          aria-pressed={!groupSeries}
          onClick={() => onGroupSeriesChange(false)}
          title={t("library.flatTitle")}
          className={cn(CHIP, groupSeries ? CHIP_OFF : CHIP_ON)}
        >
          <LayoutGrid className="size-3.5" />
          {t("library.flat")}
        </button>
      </div>

      <div
        role="group"
        aria-label={t("library.sortAria")}
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={sortMode === "recentOpened"}
          onClick={() => onSortModeChange("recentOpened")}
          className={cn(CHIP, sortMode === "recentOpened" ? CHIP_ON : CHIP_OFF)}
        >
          <Clock className="size-3.5" />
          {t("library.sortRecentOpened")}
        </button>
        <button
          type="button"
          aria-pressed={sortMode === "recentRead"}
          onClick={() => onSortModeChange("recentRead")}
          className={cn(CHIP, sortMode === "recentRead" ? CHIP_ON : CHIP_OFF)}
        >
          <History className="size-3.5" />
          {t("library.sortRecentRead")}
        </button>
      </div>
    </>
  );
}
