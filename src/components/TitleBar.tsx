import { useEffect, useState } from "react";
import { BookOpen, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 自绘标题栏（decorations: false）：
 * 40px，背景与内容区同为 --bg（无接缝）；左=应用图标+名称；
 * 右=lucide 最小化/最大化/关闭（hover 态，关闭为 Windows 红）；
 * 除按钮外整条为 data-tauri-drag-region 拖拽区（双击=最大化/还原由 Tauri 内建）。
 */
export default function TitleBar() {
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

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <BookOpen size={15} />
        <span>MangaReader</span>
      </div>
      <div className="tb-controls">
        <button
          className="tb-btn"
          title="最小化"
          aria-label="最小化"
          onClick={act(() => getCurrentWindow().minimize())}
        >
          <Minus size={14} />
        </button>
        <button
          className="tb-btn"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={act(() => getCurrentWindow().toggleMaximize())}
        >
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button
          className="tb-btn close"
          title="关闭"
          aria-label="关闭"
          onClick={act(() => getCurrentWindow().close())}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
