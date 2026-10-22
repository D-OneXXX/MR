import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  danger?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 36;
const EDGE = 8;

/**
 * Tailwind 浮动右键菜单。
 *
 * 关闭时机：冒泡阶段 mousedown + contains 判断，避免菜单在 mousedown
 * 阶段被卸载导致后续 click 永远不命中菜单项。
 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    // Focus the first item only on mount, not on every parent re-render.
    if (!focusedRef.current) {
      focusedRef.current = true;
      const first = ref.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]',
      );
      first?.focus({ preventScroll: true });
    }

    const inside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      return !!(ref.current && target && ref.current.contains(target));
    };
    const onDown = (e: MouseEvent) => {
      if (!inside(e)) onClose();
    };
    const onCtx = (e: MouseEvent) => {
      if (!inside(e)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const nodes = ref.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      );
      if (!nodes || nodes.length === 0) return;
      e.preventDefault();
      const list = Array.from(nodes);
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next =
        current < 0
          ? 0
          : (current + delta + list.length) % list.length;
      list[next]?.focus({ preventScroll: true });
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

  const left = Math.max(
    EDGE,
    Math.min(x, window.innerWidth - MENU_WIDTH - EDGE),
  );
  const top = Math.max(
    EDGE,
    Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - EDGE * 2),
  );

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t("menu.aria")}
      className="fixed z-[100] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-hard"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium outline-none transition-colors",
            item.danger
              ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10"
              : "text-foreground hover:bg-accent focus:bg-accent",
          )}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon ? (
            <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">
              {item.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
