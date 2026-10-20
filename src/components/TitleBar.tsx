import { useEffect, useState } from "react";
import { BookOpen, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

/**
 * 保留原窗口控制逻辑（Tauri Window API / 最大化状态监听）。
 * v3 TitleBarV3 复用 WindowControls；旧 TitleBar 保留以兼容未迁移场景。
 */
export function WindowControls({ className }: { className?: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
    win
      .onResized(async () => {
        try {
          const m = await win.isMaximized();
          if (alive) setMaximized(m);
        } catch {
          /* 忽略 */
        }
      })
      .then((f) => {
        unlisten = f;
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const act = (f: () => void) => () => {
    try {
      f();
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  };

  const buttonClass =
    "flex h-full w-[46px] items-center justify-center text-ink-muted transition-colors hover:bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand";

  return (
    <div className={cn("flex h-full items-stretch", className)}>
      <button
        type="button"
        className={buttonClass}
        title="最小化"
        aria-label="最小化"
        onClick={act(() => getCurrentWindow().minimize())}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className={buttonClass}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={act(() => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? <Copy size={12} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        className={cn(
          buttonClass,
          "hover:bg-danger hover:text-primary-foreground focus-visible:ring-danger",
        )}
        title="关闭"
        aria-label="关闭"
        onClick={act(() => getCurrentWindow().close())}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <BookOpen size={15} />
        <span>MangaReader</span>
      </div>
      <WindowControls className="ml-auto" />
    </header>
  );
}
