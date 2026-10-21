import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

/** Frameless-window controls. Kept outside the nav pill so dragging works. */
export function WindowControls({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .isMaximized()
      .then((value) => {
        if (alive) setMaximized(value);
      })
      .catch(() => {});
    win
      .onResized(async () => {
        try {
          const value = await win.isMaximized();
          if (alive) setMaximized(value);
        } catch {
          /* 忽略 */
        }
      })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const act = (fn: () => Promise<unknown> | void) => () => {
    try {
      const result = fn();
      if (result && typeof result.catch === "function") {
        void result.catch(() => {
          /* 非 Tauri 环境忽略 */
        });
      }
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  };

  const base =
    "flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <button
        type="button"
        className={base}
        title="最小化"
        aria-label="最小化"
        onClick={act(() => getCurrentWindow().minimize())}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        className={base}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={act(() => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        className={cn(
          base,
          "hover:bg-destructive hover:text-white focus-visible:ring-destructive",
        )}
        title="关闭"
        aria-label="关闭"
        onClick={act(() => getCurrentWindow().close())}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
