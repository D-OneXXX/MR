import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Keyboard,
  List,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { Direction } from "@/components/Reader/spread";

interface Props {
  hidden: boolean;
  dir: Direction;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  tocOpen: boolean;
  onToc: () => void;
  shortcutsOpen: boolean;
  onShortcuts: () => void;
  slider: ReactNode;
  pageLabel: ReactNode;
}

/**
 * 阅读器底部 Dock：上一页、页目录、唯一一套进度滑杆与页码、下一页、
 * 快捷键速查。版式/方向/封面偏移/缩放统一收在顶部 HUD，不在此重复。
 * 所有控件仍是真实 <button>，供全局空格翻页去重判断使用。
 */
export default function ReaderDock({
  hidden,
  dir,
  canPrev,
  canNext,
  onPrev,
  onNext,
  tocOpen,
  onToc,
  shortcutsOpen,
  onShortcuts,
  slider,
  pageLabel,
}: Props) {
  const { t } = useI18n();
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
          aria-label={t("reader.nav.prev")}
          title={t("reader.nav.prev")}
        >
          <PrevIcon className="size-4.5" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onToc}
          aria-label={t("reader.toc.title")}
          aria-expanded={tocOpen}
          title={t("reader.toc.title")}
          className={cn(tocOpen && "bg-accent text-accent-foreground")}
        >
          <List className="size-4" />
        </Button>

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
          aria-label={t("reader.nav.next")}
          title={t("reader.nav.next")}
        >
          <NextIcon className="size-4.5" />
        </Button>

        <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" aria-hidden />

        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onShortcuts}
          aria-label={t("reader.shortcuts.title")}
          aria-expanded={shortcutsOpen}
          title={t("reader.shortcuts.title")}
          className={cn(shortcutsOpen && "bg-accent text-accent-foreground")}
        >
          <Keyboard className="size-4" />
        </Button>
      </div>
    </div>
  );
}
