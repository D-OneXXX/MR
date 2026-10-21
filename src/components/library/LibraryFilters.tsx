import { Layers, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

export type SourceFilter = "all" | "local" | "online";

interface Props {
  sourceFilter: SourceFilter;
  onSourceFilterChange: (filter: SourceFilter) => void;
  groupSeries: boolean;
  onGroupSeriesChange: (grouped: boolean) => void;
}

const CHIP =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent px-4 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const CHIP_ON =
  "border-border bg-primary text-primary-foreground shadow-hard-sm";
const CHIP_OFF = "text-muted-foreground hover:bg-accent hover:text-foreground";

const SOURCE_OPTIONS: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "local", label: "本地" },
  { key: "online", label: "在线" },
];

/** 来源分段胶囊 + 合集/平铺切换，全部保留为可访问的 aria-pressed 按钮。 */
export default function LibraryFilters({
  sourceFilter,
  onSourceFilterChange,
  groupSeries,
  onGroupSeriesChange,
}: Props) {
  return (
    <>
      <div
        role="group"
        aria-label="来源筛选"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        {SOURCE_OPTIONS.map((option) => (
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
        aria-label="合集显示方式"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card p-1 shadow-hard-sm"
      >
        <button
          type="button"
          aria-pressed={groupSeries}
          onClick={() => onGroupSeriesChange(true)}
          title="同一合集只显示代表卡"
          className={cn(CHIP, groupSeries ? CHIP_ON : CHIP_OFF)}
        >
          <Layers className="size-3.5" />
          按合集
        </button>
        <button
          type="button"
          aria-pressed={!groupSeries}
          onClick={() => onGroupSeriesChange(false)}
          title="逐个章节平铺显示"
          className={cn(CHIP, groupSeries ? CHIP_OFF : CHIP_ON)}
        >
          <LayoutGrid className="size-3.5" />
          平铺
        </button>
      </div>
    </>
  );
}
