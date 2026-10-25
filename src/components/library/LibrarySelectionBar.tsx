import { useEffect } from "react";
import { BookX, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
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
  const { t } = useI18n();
  // 批量操作条固定在底部：把 toast 抬到它上方，避免文字与按钮互相遮挡。
  useEffect(() => {
    document.body.style.setProperty("--mr-toast-bottom", "6.5rem");
    return () => {
      document.body.style.removeProperty("--mr-toast-bottom");
    };
  }, []);
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[75] flex justify-center px-4"
      role="toolbar"
      aria-label={t("library.bulkAria")}
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-card px-3 py-2 shadow-hard">
        <span className="inline-flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
          <span
            className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold tabular-nums text-primary-foreground"
            aria-live="polite"
          >
            {count}
          </span>
          <span className="whitespace-nowrap">{t("library.selected")}</span>
        </span>
        <Button
          variant="pill"
          size="pill-sm"
          disabled={count === 0}
          onClick={onRemove}
        >
          <BookX />
          {t("library.removeRecords")}
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
          aria-label={t("library.exitSelectAria")}
        >
          <X />
          {t("common.cancel")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
