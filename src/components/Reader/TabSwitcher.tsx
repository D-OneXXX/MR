import { useEffect, useRef } from "react";
import { BookOpen, Layers, LibraryBig, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";

const BTN =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 阅读态页签切换器（顶部 HUD 内，紧凑）：
 * 书库固定在第一项且不可关闭；漫画页签支持点击切换、中键/Ctrl+W 关闭。
 */
export default function TabSwitcher({ open, onOpenChange }: Props) {
  const ws = useWorkspace();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onOpenChange]);

  const total = ws.tabs.length + 1;

  return (
    <div ref={rootRef} data-tab-switcher className="relative shrink-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`阅读页签，共 ${total} 个`}
        title={`阅读页签（Ctrl+1…${ws.maxTabs + 1} 切换）`}
        className={cn(BTN, open && "bg-accent text-ink")}
      >
        <Layers size={14} />
        <span className="mono text-[10px] tabular-nums">{total}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="阅读页签"
          className="absolute left-0 top-9 z-50 w-72 rounded-xl border border-hairline bg-surface-solid p-1 text-ink shadow-2xl"
        >
          <div className="flex h-7 items-center justify-between px-2 text-[10px] text-ink-muted">
            <span>阅读页签</span>
            <span className="mono tabular-nums">
              {total}/{ws.maxTabs + 1}
            </span>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              ws.goLibrary();
              onOpenChange(false);
            }}
            className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-ink transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <LibraryBig size={13} className="shrink-0 text-ink-muted" />
            <span className="flex-1 truncate">书库</span>
            <span className="mono text-[10px] text-ink-muted">Ctrl+1</span>
          </button>

          {ws.tabs.map((tab, i) => (
            <div
              key={tab.bookId}
              className={cn(
                "flex items-center gap-0.5 rounded-md px-0.5",
                tab.bookId === ws.activeId && "bg-accent",
              )}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  ws.activateTab(tab.bookId);
                  onOpenChange(false);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    ws.closeTab(tab.bookId);
                  }
                }}
                onMouseDown={(e) => {
                  // 阻止中键的自动滚动光标。
                  if (e.button === 1) e.preventDefault();
                }}
                title={tab.title}
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-ink transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <BookOpen size={13} className="shrink-0 text-ink-muted" />
                <span className="truncate">{tab.title}</span>
                <span className="mono shrink-0 text-[10px] text-ink-muted">
                  Ctrl+{i + 2}
                </span>
              </button>
              <button
                type="button"
                onClick={() => ws.closeTab(tab.bookId)}
                aria-label={`关闭 ${tab.title}`}
                title="关闭页签（中键 / Ctrl+W）"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <X size={12} />
              </button>
            </div>
          ))}

          {ws.tabs.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-ink-muted">
              还没有打开的漫画。
            </p>
          )}

          <p className="mt-1 border-t border-hairline px-2 pt-1.5 text-[10px] text-ink-muted">
            中键或 Ctrl+W 关闭当前 · Ctrl+1…{ws.maxTabs + 1} 切换
          </p>
        </div>
      )}
    </div>
  );
}
