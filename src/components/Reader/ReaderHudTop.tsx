import type { ReactNode } from "react";
import {
  ArrowLeft,
  Minus,
  RotateCcw,
  Square,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

const BTN =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-30";

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

/** 阅读器顶部 HUD：返回、标题、缩放组、窗口控制；空白段兼任窗口拖拽带。 */
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
  const win = getCurrentWindow();

  return (
    <div
      data-reader-hud
      inert={hidden}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-3 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        hidden && "-translate-y-2 opacity-0",
      )}
    >
      <div className="glass hairline pointer-events-auto flex h-11 max-w-[min(820px,92vw)] items-center gap-0.5 rounded-xl px-1.5 text-ink shadow-lg">
        <button
          type="button"
          className={BTN}
          onClick={onBack}
          aria-label="返回书库"
          title="返回书库 (Esc)"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="mx-1 min-w-0 max-w-[36vw] truncate text-[13px] font-semibold"
          title={title}
        >
          {title}
        </span>

        {tabsSlot}

        {/* 非交互拖拽区：双击最大化由 Tauri 处理 */}
        <span
          data-tauri-drag-region
          aria-hidden
          className="h-8 min-w-6 flex-1 cursor-default"
        />

        <span className="mono shrink-0 px-1 text-[11px] tabular-nums text-ink-muted">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className={BTN}
          onClick={() => onZoom(1 / 1.25)}
          disabled={zoom <= minZoom + 1e-6}
          aria-label="缩小"
          title="缩小"
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => onZoom(1.25)}
          disabled={zoom >= maxZoom - 1e-6}
          aria-label="放大"
          title="放大"
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          className={BTN}
          onClick={onReset}
          aria-label="重置视图"
          title="重置视图（双击画布）"
        >
          <RotateCcw size={14} />
        </button>

        <span className="mx-1 h-4 w-px shrink-0 bg-hairline" aria-hidden />

        <button
          type="button"
          className={BTN}
          aria-label="最小化"
          title="最小化"
          onClick={() => win.minimize().catch(() => {})}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          className={BTN}
          aria-label="最大化或还原"
          title="最大化/还原"
          onClick={() => win.toggleMaximize().catch(() => {})}
        >
          <Square size={11} />
        </button>
        <button
          type="button"
          className={BTN}
          aria-label="关闭"
          title="关闭"
          onClick={() => win.close().catch(() => {})}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
