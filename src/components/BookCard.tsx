import { useEffect, useState } from "react";
import { BookOpen, Check } from "lucide-react";
import { api, type BookInfo } from "../lib/tauri";

interface Props {
  book: BookInfo;
  /** 流体 v2：单击选中 → 详情 sheet（带封面原点矩形做 shared-element 放大）。 */
  onSelect?: (bookId: string, originRect: DOMRect | null) => void;
  onOpen?: (bookId: string) => void;
  /** 多选模式：显示选择圈，单击 = 勾选而非打开详情。 */
  selectMode?: boolean;
  checked?: boolean;
  onToggleCheck?: (bookId: string) => void;
  onContextMenu?: (e: React.MouseEvent, bookId: string) => void;
}

/** 封面卡片（流体 v2）：封面是主角；hover 浮起 4px + 底部标题浮现；12px 圆角。 */
export default function BookCard({
  book,
  onSelect,
  onOpen,
  selectMode,
  checked,
  onToggleCheck,
  onContextMenu,
}: Props) {
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getThumbnail(book.id, 256)
      .then(
        (img) => {
          if (alive) setCover(img.dataUrl);
        },
        () => {
          if (alive) setCover(null);
        },
      );
    return () => {
      alive = false;
    };
  }, [book.id]);

  const pct =
    book.pageCount > 0
      ? Math.min(100, Math.round((book.currentPage / book.pageCount) * 100))
      : 0;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    onSelect?.(book.id, e.currentTarget.getBoundingClientRect());
  };

  return (
    <div
      className={`book-card${selectMode ? " selmode" : ""}${checked ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      title={`${book.title}（单击查看详情，双击进入阅读；多选模式下单击勾选）`}
      onClick={handleClick}
      onDoubleClick={() => {
        if (!selectMode) onOpen?.(book.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (selectMode) onToggleCheck?.(book.id);
          else onSelect?.(book.id, null);
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, book.id)}
    >
      {selectMode && (
        <span
          className={`book-check${checked ? " on" : ""}`}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck?.(book.id);
          }}
        >
          <Check size={13} strokeWidth={3} />
        </span>
      )}
      {cover ? (
        <img
          src={cover}
          alt={book.title}
          loading="lazy"
          draggable={false}
          onError={() => setCover(null)}
        />
      ) : (
        <div className="book-cover-fallback">
          <BookOpen size={28} strokeWidth={1.5} />
        </div>
      )}
      {book.sourceType !== "local" && (
        <span className="book-source-badge mono">URL</span>
      )}
      <div className="book-overlay">
        <div className="book-title">{book.title}</div>
        <div className="book-sub mono">
          {book.currentPage}/{book.pageCount} · {pct}%
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
