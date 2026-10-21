import type { ReactNode } from "react";
import {
  ArrowLeft,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/shell/WindowControls";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /** HUD 隐藏时整体淡出且不可聚焦（不卸载 DOM）。 */
  hidden: boolean;
  /** 页签切换器等可选插槽（渲染在标题之后）。 */
  tabsSlot?: ReactNode;
  onBack: () => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
}

/** 阅读器顶部 HUD：返回、标题、页签、缩放组与窗口控制，均为悬浮胶囊。 */
export default function ReaderHudTop({
  title,
  zoom,
  minZoom,
  maxZoom,
  hidden,
  tabsSlot,
  onBack,
  onZoom,
  onReset,
}: Props) {
  return (
    <div
      data-reader-hud
      inert={hidden}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-center gap-2 px-3 pt-3 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        hidden && "-translate-y-2 opacity-0",
      )}
    >
      <div className="pointer-events-auto flex h-11 min-w-0 max-w-[min(760px,calc(100vw-9rem))] flex-1 items-center gap-0.5 rounded-full border border-border/70 bg-card/95 pl-1.5 pr-1 text-foreground shadow-hard-sm backdrop-blur-md">
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onBack}
          aria-label="返回书库"
          title="返回书库 (Esc)"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className="mx-1 min-w-0 max-w-[30vw] truncate text-[13px] font-semibold"
          title={title}
        >
          {title}
        </span>

        {tabsSlot}

        {/* 非交互拖拽区：双击最大化由 Tauri 处理 */}
        <span
          data-tauri-drag-region
          aria-hidden
          className="h-8 min-w-4 flex-1 cursor-default"
        />

        <span className="mono hidden shrink-0 px-1 text-[11px] tabular-nums text-muted-foreground sm:inline">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={() => onZoom(1 / 1.25)}
          disabled={zoom <= minZoom + 1e-6}
          aria-label="缩小"
          title="缩小"
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={() => onZoom(1.25)}
          disabled={zoom >= maxZoom - 1e-6}
          aria-label="放大"
          title="放大"
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onReset}
          aria-label="重置视图"
          title="重置视图（双击画布）"
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>

      <div className="pointer-events-auto flex h-11 shrink-0 items-center rounded-full border border-border/70 bg-card/95 px-1 text-foreground shadow-hard-sm backdrop-blur-md">
        <WindowControls />
      </div>
    </div>
  );
}
