import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 右键菜单（卡片级操作：查看详情/继续阅读/移除/删除源文件…）。
 *
 * 关闭时机有讲究：不能用「window 捕获阶段 mousedown 直接关」——
 * 捕获监听在事件到达菜单按钮之前触发，菜单在 mousedown 就被卸载，
 * 后续 mouseup/click 永远不会命中菜单项（按钮必失效）。
 * 正确做法：冒泡阶段监听 + 判断按下位置是否在菜单内。
 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const inside = (e: MouseEvent) => {
      const t = e.target as Node | null;
      return !!(ref.current && t && ref.current.contains(t));
    };
    const onDown = (e: MouseEvent) => {
      if (!inside(e)) onClose();
    };
    const onCtx = (e: MouseEvent) => {
      if (!inside(e)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("contextmenu", onCtx, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("contextmenu", onCtx, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - items.length * 38 - 16);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left, top }}
      // React 在根容器派发合成事件，stopPropagation 会拦住原生事件继续冒泡
      // 到 window（配合上面的 contains 判断双保险，菜单内的按下绝不关闭菜单）。
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={`ctx-item${it.danger ? " danger" : ""}`}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
