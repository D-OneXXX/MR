import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Keyboard,
  List,
  MoreHorizontal,
  Settings,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/components/Toast";
import type { Direction, PageMode } from "@/components/Reader/spread";

const MODES: { key: PageMode; label: string; short: string }[] = [
  { key: "single", label: "单页", short: "单" },
  { key: "double", label: "双页", short: "双" },
  { key: "webtoon", label: "条漫", short: "条" },
];

const MENU_ITEM =
  "flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

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
  slider: ReactNode;
  pageLabel: ReactNode;
}

/**
 * 阅读器底部 Dock：上一页、页目录、版式分段、进度滑杆、页码、下一页，
 * 阅读设置 / 快捷键收进「更多」Popover。所有控件仍是真实 <button>，
 * 供全局空格翻页去重判断使用。
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
      <div className="pointer-events-auto flex h-14 w-full max-w-[min(960px,96vw)] items-center gap-1 rounded-full border border-border/70 bg-card/95 px-2 text-foreground shadow-hard-sm backdrop-blur-md">
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="上一页"
          title="上一页"
        >
          <PrevIcon className="size-4.5" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onToc}
          aria-label="页目录"
          aria-expanded={tocOpen}
          title="页目录"
          className={cn(tocOpen && "bg-accent text-accent-foreground")}
        >
          <List className="size-4" />
        </Button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" aria-hidden />

        <div
          className="flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/50 p-0.5"
          role="group"
          aria-label="版式"
        >
          {!webtoonAllowed && (
            <span id="reader-webtoon-disabled-reason" className="sr-only">
              {webtoonReason}
            </span>
          )}
          {MODES.map(({ key, label, short }) => {
            const disabled = key === "webtoon" && !webtoonAllowed;
            return (
              <Button
                key={key}
                type="button"
                variant={mode === key ? "pill-primary" : "pill-ghost"}
                size="pill-sm"
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
                  "h-8 px-2 text-[11px]",
                  disabled &&
                    "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
                )}
              >
                <span className="hidden sm:inline">{label}</span>
                <span className="sm:hidden">{short}</span>
              </Button>
            );
          })}
        </div>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" aria-hidden />

        {slider}

        <div className="mono shrink-0 whitespace-nowrap px-1 text-[11px] tabular-nums text-muted-foreground">
          {pageLabel}
        </div>

        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onNext}
          disabled={!canNext}
          aria-label="下一页"
          title="下一页"
        >
          <NextIcon className="size-4.5" />
        </Button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" aria-hidden />

        <Popover open={moreOpen} onOpenChange={onMoreOpenChange}>
          <PopoverTrigger
            className={cn(
              buttonVariants({ variant: "pill-ghost", size: "icon" }),
              moreOpen && "bg-accent text-accent-foreground",
            )}
            aria-label="更多"
            title="更多"
          >
            <MoreHorizontal className="size-4" />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            sideOffset={10}
            data-reader-hud
            className="reader-portal w-52! rounded-2xl! border! border-border! bg-popover! p-1.5! text-popover-foreground! shadow-hard!"
          >
            <button
              type="button"
              className={cn(MENU_ITEM, settingsOpen && "bg-accent")}
              onClick={onSettings}
            >
              <Settings className="size-4 text-muted-foreground" />
              阅读设置
            </button>
            <button
              type="button"
              className={cn(MENU_ITEM, shortcutsOpen && "bg-accent")}
              onClick={onShortcuts}
            >
              <Keyboard className="size-4 text-muted-foreground" />
              快捷键速查
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
