import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Languages,
  List,
  MoreHorizontal,
  Settings,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "@/components/Toast";
import type { Direction, PageMode } from "@/components/Reader/spread";

const BTN =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-30";

const MODES: { key: PageMode; label: string }[] = [
  { key: "single", label: "单页" },
  { key: "double", label: "双页" },
  { key: "webtoon", label: "条漫" },
];

const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-40";

interface Props {
  hidden: boolean;
  dir: Direction;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  mode: PageMode;
  webtoonAllowed: boolean;
  webtoonReason: string;
  onMode: (mode: PageMode) => void;
  tocOpen: boolean;
  onToc: () => void;
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  settingsOpen: boolean;
  onSettings: () => void;
  shortcutsOpen: boolean;
  onShortcuts: () => void;
  transOn: boolean;
  regionMode: boolean;
  onRegion: () => void;
  regionDisabledReason: string | null;
  slider: ReactNode;
  pageLabel: ReactNode;
}

/**
 * 阅读器底部 Dock：上一页、页目录、模式分段、进度滑杆、页码、下一页；
 * 阅读设置 / 选区翻译 / 快捷键收进「更多」Popover。
 */
export default function ReaderDock({
  hidden,
  dir,
  canPrev,
  canNext,
  onPrev,
  onNext,
  mode,
  webtoonAllowed,
  webtoonReason,
  onMode,
  tocOpen,
  onToc,
  moreOpen,
  onMoreOpenChange,
  settingsOpen,
  onSettings,
  onShortcuts,
  transOn,
  regionMode,
  onRegion,
  regionDisabledReason,
  shortcutsOpen,
  slider,
  pageLabel,
}: Props) {
  const PrevIcon = dir === "rtl" ? ChevronRight : ChevronLeft;
  const NextIcon = dir === "rtl" ? ChevronLeft : ChevronRight;

  return (
    <div
      data-reader-hud
      inert={hidden}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        hidden && "translate-y-2 opacity-0",
      )}
    >
      <div className="glass hairline pointer-events-auto flex h-12 w-full max-w-[min(920px,94vw)] items-center gap-1 rounded-xl px-2 text-ink shadow-lg">
        <button
          type="button"
          className={BTN}
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="上一页"
          title="上一页"
        >
          <PrevIcon size={17} />
        </button>
        <button
          type="button"
          className={cn(BTN, tocOpen && "bg-accent text-ink")}
          onClick={onToc}
          aria-label="页目录"
          aria-expanded={tocOpen}
          title="页目录"
        >
          <List size={16} />
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-hairline" aria-hidden />

        <div
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-hairline p-0.5"
          role="group"
          aria-label="版式"
        >
          {!webtoonAllowed && (
            <span id="reader-webtoon-disabled-reason" className="sr-only">
              {webtoonReason}
            </span>
          )}
          {MODES.map(({ key, label }) => {
            const disabled = key === "webtoon" && !webtoonAllowed;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (disabled) {
                    toast(webtoonReason);
                    return;
                  }
                  onMode(key);
                }}
                aria-disabled={disabled}
                aria-describedby={
                  disabled ? "reader-webtoon-disabled-reason" : undefined
                }
                aria-pressed={mode === key}
                title={disabled ? webtoonReason : `切换到${label}`}
                className={cn(
                  "h-8 rounded-md px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  disabled
                    ? "cursor-not-allowed text-ink-muted/50 opacity-40 hover:bg-transparent hover:text-ink-muted/50"
                    : mode === key
                      ? "bg-brand text-white"
                      : "text-ink-muted hover:bg-accent hover:text-ink",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-hairline" aria-hidden />

        {slider}

        <div className="mono shrink-0 px-1 text-[11px] tabular-nums text-ink-muted">
          {pageLabel}
        </div>

        <button
          type="button"
          className={BTN}
          onClick={onNext}
          disabled={!canNext}
          aria-label="下一页"
          title="下一页"
        >
          <NextIcon size={17} />
        </button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-hairline" aria-hidden />

        <Popover open={moreOpen} onOpenChange={onMoreOpenChange}>
          <PopoverTrigger
            className={cn(BTN, moreOpen && "bg-accent text-ink")}
            aria-label="更多"
            title="更多"
          >
            <MoreHorizontal size={16} />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            sideOffset={8}
            data-reader-hud
            className="w-48 rounded-xl border border-hairline bg-surface-solid p-1 text-ink shadow-xl"
          >
            <button
              type="button"
              className={cn(MENU_ITEM, settingsOpen && "bg-accent")}
              onClick={onSettings}
            >
              <Settings size={14} />
              阅读设置
            </button>
            {transOn && (
              <button
                type="button"
                className={cn(
                  MENU_ITEM,
                  regionMode && "bg-accent",
                  regionDisabledReason &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                onClick={() => {
                  if (regionDisabledReason) {
                    toast(regionDisabledReason);
                    return;
                  }
                  onRegion();
                }}
                aria-disabled={regionDisabledReason !== null}
                aria-describedby={
                  regionDisabledReason
                    ? "reader-region-disabled-reason"
                    : undefined
                }
                title={regionDisabledReason ?? "选区翻译 (o)"}
              >
                <Languages size={14} />
                选区翻译
              </button>
            )}
            {regionDisabledReason && (
              <span id="reader-region-disabled-reason" className="sr-only">
                {regionDisabledReason}
              </span>
            )}
            <button
              type="button"
              className={cn(MENU_ITEM, shortcutsOpen && "bg-accent")}
              onClick={onShortcuts}
            >
              <Keyboard size={14} />
              快捷键速查
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
