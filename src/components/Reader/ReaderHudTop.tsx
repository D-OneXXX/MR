import type { ReactNode } from "react";
import {
  ArrowLeft,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/shell/WindowControls";
import SafeModePill from "@/components/shell/SafeModePill";
import { useI18n } from "@/i18n";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /** HUD 隐藏时整体淡出且不可聚焦（不卸载 DOM）。 */
  hidden: boolean;
  /** 版式切换组（单/双页 + 方向 + 封面偏移），渲染在标题之后。 */
  modeSlot?: ReactNode;
  /** 页签切换器等可选插槽（渲染在版式之后）。 */
  tabsSlot?: ReactNode;
  /** 在线提纯：过滤抽屉与“标记本页”操作（渲染在页签之后）。 */
  filterSlot?: ReactNode;
  onBack: () => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
}

/** 阅读器顶部 HUD：返回、标题、版式组、页签、缩放组与窗口控制，均为悬浮胶囊。 */
export default function ReaderHudTop({
  title,
  zoom,
  minZoom,
  maxZoom,
  hidden,
  modeSlot,
  tabsSlot,
  filterSlot,
  onBack,
  onZoom,
  onReset,
}: Props) {
  const { t } = useI18n();
  const { active: safeMode } = useSafeMode();
  // In safe mode the status capsule is a persistent safety affordance, not
  // decorative chrome, so the top capsule never auto-hides.
  const concealed = hidden && !safeMode;
  return (
    <div
      data-reader-hud
      inert={concealed}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-center gap-2 px-3 pt-3 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        concealed && "-translate-y-2 opacity-0",
      )}
    >
      <div className="pointer-events-auto flex h-11 min-w-0 max-w-[min(1080px,calc(100vw-9rem))] flex-1 items-center gap-0.5 rounded-full border border-border/70 bg-card/95 pl-1.5 pr-1 text-foreground shadow-hard-sm backdrop-blur-md">
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onBack}
          aria-label={t("reader.hud.back")}
          title={t("reader.hud.backTitle")}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className="mx-1 min-w-0 max-w-[16vw] truncate text-[13px] font-semibold"
          title={title}
        >
          {title}
        </span>

        {modeSlot}

        {tabsSlot}

        {filterSlot}

        <SafeModePill compact />

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
          aria-label={t("reader.hud.zoomOut")}
          title={t("reader.hud.zoomOut")}
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={() => onZoom(1.25)}
          disabled={zoom >= maxZoom - 1e-6}
          aria-label={t("reader.hud.zoomIn")}
          title={t("reader.hud.zoomIn")}
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant="pill-ghost"
          size="icon"
          onClick={onReset}
          aria-label={t("reader.hud.reset")}
          title={t("reader.hud.resetTitle")}
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
