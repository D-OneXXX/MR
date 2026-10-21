import { BookX, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

interface Props {
  count: number;
  /** 本地 = 删除源文件，在线 = 彻底移除，混合 = 两者。 */
  deleteLabel: string;
  onRemove: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

/** 多选浮动胶囊条：portal 到 body，固定底部居中，不占据网格布局。 */
export default function LibrarySelectionBar({
  count,
  deleteLabel,
  onRemove,
  onDelete,
  onCancel,
}: Props) {
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[75] flex justify-center px-4"
      role="toolbar"
      aria-label="批量操作"
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-hard">
        <span className="inline-flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
          <span
            className="grid size-6 place-items-center rounded-full bg-primary text-xs font-bold tabular-nums text-primary-foreground"
            aria-live="polite"
          >
            {count}
          </span>
          已选
        </span>
        <Button
          variant="pill"
          size="pill-sm"
          disabled={count === 0}
          onClick={onRemove}
        >
          <BookX />
          移除记录
        </Button>
        <Button
          variant="pill-danger"
          size="pill-sm"
          disabled={count === 0}
          onClick={onDelete}
        >
          <Trash2 />
          {deleteLabel}
        </Button>
        <Button
          variant="pill-ghost"
          size="pill-sm"
          onClick={onCancel}
          aria-label="取消多选"
        >
          <X />
          取消
        </Button>
      </div>
    </div>,
    document.body,
  );
}
