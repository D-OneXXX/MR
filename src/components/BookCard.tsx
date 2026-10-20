import { useEffect, useRef, useState } from "react";
import { BookOpen, Check } from "lucide-react";
import { api, type BookInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface Props {
  book: BookInfo;
  /** 单击选中：窄屏传入封面矩形做 shared-element 飞入，宽屏为 null。 */
  onSelect?: (bookId: string, originRect: DOMRect | null) => void;
  onOpen?: (bookId: string) => void;
  /** 多选模式：显示选择圈，单击 = 勾选而非打开详情。 */
  selectMode?: boolean;
  checked?: boolean;
  onToggleCheck?: (bookId: string) => void;
  onContextMenu?: (e: React.MouseEvent, bookId: string) => void;
  /** 聚合卡片的同系列总话数。 */
  seriesCount?: number;
  /** 窄屏延迟单击，留出双击判定窗口，避免 Sheet 抢走第二次点击。 */
  deferSelect?: boolean;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

/** v3 封面卡：3:4 封面 + 12px 圆角 + 内嵌 2px 进度；标题在 hover / focus 时浮现。 */
export default function BookCard({
  book,
  onSelect,
  onOpen,
  selectMode,
  checked,
  onToggleCheck,
  onContextMenu,
  seriesCount,
  deferSelect,
}: Props) {
  const [cover, setCover] = useState<string | null>(null);
  const clickTimer = useRef<number>(0);
  const isSeries = !!book.seriesId && (seriesCount ?? 1) > 1;

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  useEffect(() => {
    let alive = true;
    api.getThumbnail(book.id, 256).then(
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
    window.clearTimeout(clickTimer.current);
    clickTimer.current = 0;
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (deferSelect) {
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onSelect?.(book.id, rect);
      }, 240);
      return;
    }
    onSelect?.(book.id, rect);
  };

  const activate = (openReader: boolean) => {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = 0;
    if (selectMode) {
      onToggleCheck?.(book.id);
      return;
    }
    if (openReader) onOpen?.(book.id);
    else onSelect?.(book.id, null);
  };

  const ariaLabel = `${book.title}，已读 ${book.currentPage}/${book.pageCount} 页${
    isSeries ? `，合集 ${seriesCount} 话` : ""
  }${book.sourceType !== "local" ? "，在线直读" : ""}。${
    selectMode ? "空格切换选择" : "回车查看详情，Shift 加回车阅读"
  }`;

  return (
    <div
      className={cn(
        "group relative cursor-pointer rounded-lg outline-none transition-transform duration-200 ease-out hover:-translate-y-1",
        checked && "ring-2 ring-brand ring-offset-2 ring-offset-canvas",
        FOCUS_RING,
      )}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selectMode ? !!checked : undefined}
      title={
        selectMode
          ? `${book.title}（单击勾选）`
          : `${book.title}（单击查看详情，双击进入阅读）`
      }
      onClick={handleClick}
      onDoubleClick={() => {
        if (selectMode) return;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = 0;
        onOpen?.(book.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate(e.shiftKey);
        } else if (e.key === " ") {
          e.preventDefault();
          activate(false);
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, book.id)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-solid shadow-lg transition-shadow duration-200 group-hover:shadow-2xl">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setCover(null)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-muted">
            <BookOpen size={26} strokeWidth={1.5} />
          </div>
        )}

        {/* 封面内描边：token 随主题切换，ring-inset 叠在图片上，避免接缝漏边。 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] rounded-lg ring-1 ring-inset ring-hairline"
        />

        {selectMode && (
          <span
            className={cn(
              "absolute left-2 top-2 z-30 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 transition-colors",
              checked
                ? "border-brand bg-brand text-white"
                : "border-ink/70 bg-black/35 text-transparent",
            )}
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              onToggleCheck?.(book.id);
            }}
          >
            <Check size={13} strokeWidth={3} />
          </span>
        )}

        {isSeries && (
          <span
            className={cn(
              "absolute top-2 z-10 rounded-md border border-ink/10 bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm",
              selectMode ? "left-10" : "left-2",
            )}
          >
            <span className="mono">合集 · {seriesCount} 话</span>
          </span>
        )}

        {book.sourceType !== "local" && (
          <span className="mono absolute right-2 top-2 z-10 rounded-md bg-brand px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white">
            URL
          </span>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 translate-y-1 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2.5 pt-8 opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <div className="truncate text-xs font-semibold text-white">
            {book.title}
          </div>
          <div className="mono mt-0.5 text-[10px] text-white/70">
            {book.currentPage}/{book.pageCount} · {pct}%
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 bg-ink/20">
          <div
            className="h-full bg-brand transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
