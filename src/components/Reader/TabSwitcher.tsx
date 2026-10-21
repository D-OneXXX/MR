import { BookOpen, Layers, LibraryBig, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ITEM =
  "flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 阅读态页签切换器（顶部 HUD 内，紧凑）：
 * 书库固定在第一项且不可关闭；漫画页签支持点击切换、中键/Ctrl+W 关闭。
 */
export default function TabSwitcher({ open, onOpenChange }: Props) {
  const ws = useWorkspace();
  const total = ws.tabs.length + 1;

  return (
    <div data-tab-switcher className="relative shrink-0">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          className={cn(
            buttonVariants({ variant: "pill-ghost", size: "sm" }),
            "h-8 gap-1 px-2",
            open && "bg-accent text-accent-foreground",
          )}
          aria-label={`阅读页签，共 ${total} 个`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`阅读页签（Ctrl+1…${ws.maxTabs + 1} 切换）`}
        >
          <Layers className="size-3.5" />
          <span className="mono text-[10px] tabular-nums">{total}</span>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={10}
          data-reader-hud
          role="menu"
          aria-label="阅读页签"
          className="reader-portal w-72! rounded-2xl! border! border-border! bg-popover! p-1.5! shadow-hard!"
        >
          <div className="flex h-7 items-center justify-between px-2 text-[10px] font-medium text-muted-foreground">
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
            className={ITEM}
          >
            <LibraryBig className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">书库</span>
            <span className="mono text-[10px] text-muted-foreground">Ctrl+1</span>
          </button>

          {ws.tabs.map((tab, i) => (
            <div
              key={tab.bookId}
              className={cn(
                "flex items-center gap-0.5 rounded-xl px-0.5",
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
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{tab.title}</span>
                <span className="mono shrink-0 text-[10px] text-muted-foreground">
                  Ctrl+{i + 2}
                </span>
              </button>
              <button
                type="button"
                onClick={() => ws.closeTab(tab.bookId)}
                aria-label={`关闭 ${tab.title}`}
                title="关闭页签（中键 / Ctrl+W）"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}

          {ws.tabs.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-muted-foreground">
              还没有打开的漫画。
            </p>
          )}

          <p className="mt-1 border-t border-border/60 px-2 pb-1 pt-2 text-[10px] text-muted-foreground">
            中键或 Ctrl+W 关闭当前 · Ctrl+1…{ws.maxTabs + 1} 切换
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
