import { useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export interface ScrubPreview {
  label: string;
  thumb: string | null;
}

interface Props {
  value: number;
  max: number;
  min?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  /** 拖拽预览内容；thumb 只允许传已缓存图片（不触发任何请求）。 */
  preview: ScrubPreview | null;
  onScrub: (value: number) => void;
  onCommit: (value: number) => void;
  className?: string;
}

const BLOCK_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);

/**
 * 阅读进度滑杆（Base UI Slider）：
 * - 拖拽期间只更新本地草稿与预览，不发请求、不跳页；
 * - 松手（onValueCommitted）或指针抬起兜底时才提交；
 * - 键盘事件在此截断，避免与全局翻页快捷键重复触发。
 */
export default function ProgressScrubber({
  value,
  max,
  min = 0,
  step = 1,
  disabled,
  ariaLabel,
  preview,
  onScrub,
  onCommit,
  className,
}: Props) {
  const [draft, setDraft] = useState<number | null>(null);
  // 与 state 同步的 ref：onValueCommitted 与 pointerup 兜底可能同帧触发，
  // 用 ref 立即置空，保证提交只发生一次。
  const draftRef = useRef<number | null>(null);
  const writeDraft = (next: number | null) => {
    draftRef.current = next;
    setDraft(next);
  };
  const shown = draft ?? value;
  const span = Math.max(1, max - min);
  const pct = Math.max(0, Math.min(100, ((shown - min) / span) * 100));

  const read = (v: number | readonly number[]): number =>
    Array.isArray(v) ? Number(v[0]) : Number(v);

  const commitDraft = () => {
    const next = draftRef.current;
    if (next === null) return;
    writeDraft(null);
    onCommit(next);
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("relative flex min-w-0 flex-1 items-center", className)}
      onKeyDown={(e) => {
        if (BLOCK_KEYS.has(e.key)) e.stopPropagation();
      }}
      onPointerUp={commitDraft}
    >
      {draft !== null && preview && (
        <div
          className="pointer-events-none absolute bottom-8 z-20 -translate-x-1/2"
          style={{ left: `${Math.max(8, Math.min(92, pct))}%` }}
        >
          <div className="flex flex-col items-center gap-1 rounded-xl border border-border bg-card/95 px-2 py-1.5 shadow-hard-sm backdrop-blur-md">
            {preview.thumb && (
              <img
                src={preview.thumb}
                alt=""
                draggable={false}
                className="max-h-24 w-auto max-w-[120px] rounded-lg object-contain"
              />
            )}
            <span className="mono whitespace-nowrap text-[11px] tabular-nums text-foreground">
              {preview.label}
            </span>
          </div>
        </div>
      )}

      <Slider
        value={[shown]}
        min={min}
        max={Math.max(min + 1, max)}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        getAriaLabel={() => ariaLabel}
        className="[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-foreground/20 [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-primary"
        onValueChange={(v) => {
          const next = read(v);
          writeDraft(next);
          onScrub(next);
        }}
        onValueCommitted={(v) => {
          const next = read(v);
          writeDraft(null);
          onCommit(next);
        }}
      />
    </div>
  );
}
