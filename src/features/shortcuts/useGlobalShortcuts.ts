import { useEffect, useRef } from "react";

/**
 * 全局快捷键输入态隔离守卫（AGENTS.md §4.4）。
 *
 * 所有全局快捷键（翻页、版式切换、页签数字键、Ctrl/Cmd+K 等）都必须
 * 走这个 hook，不得各自手写 window keydown 监听，否则就会出现
 * “在搜索框里打字触发翻页”“输入法选词触发切页”这类盲区。
 *
 * 触发前的强制顺序：
 *   1. isImeComposing(event)  → 直接 return（中日韩输入法候选态一律不触发）；
 *   2. isEditableTarget(event.target) → 直接 return（放行原生输入）；
 *   3. 其余才按 event.key 分发到具体处理器。
 */

/** 可编辑标签：input / textarea / select。 */
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** contenteditable 宿主选择器（含嵌套查找）。 */
const CONTENT_EDITABLE_HOST = "[contenteditable]";

/** 取事件目标里的元素；document / window 等非元素目标返回 null。 */
function toElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  const node = target as Element;
  return typeof node.tagName === "string" ? node : null;
}

/**
 * 事件目标是否可编辑：input / textarea / select / contenteditable
 * （含 contenteditable 区域内的嵌套元素）。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = toElement(target);
  if (el) {
    if (EDITABLE_TAGS.has(el.tagName)) return true;
    if ((el as HTMLElement).isContentEditable === true) return true;
    // isContentEditable 在部分宿主不可靠，用最近的 contenteditable 宿主兜底
    // （含嵌套；显式 contenteditable="false" 的子树不算可编辑）。
    if (typeof el.closest !== "function") return false;
    const host = el.closest(CONTENT_EDITABLE_HOST);
    if (!host) return false;
    return host.getAttribute("contenteditable")?.toLowerCase() !== "false";
  }
  // 目标不是元素（document / window）时退回 activeElement 判定。
  const active =
    typeof document === "undefined" ? null : document.activeElement;
  return active ? isEditableTarget(active) : false;
}

/**
 * 是否处于输入法组合中（中日韩候选框）：
 * `event.isComposing === true` 或 `event.keyCode === 229`。
 */
export function isImeComposing(event: KeyboardEvent): boolean {
  if (!event) return false;
  if (event.isComposing === true) return true;
  return event.keyCode === 229;
}

export type ShortcutHandler = (event: KeyboardEvent) => void;

/** 处理器表：key（event.key）→ 处理器。 */
export type ShortcutHandlers = Record<string, ShortcutHandler>;

export interface GlobalShortcutOptions {
  /** false 时完全不注册监听（例如阅读器未打开时）。默认 true。 */
  enabled?: boolean;
  /** 监听目标，默认 window。 */
  target?: Window | HTMLElement;
  /** 捕获阶段监听（默认冒泡阶段）。 */
  capture?: boolean;
  /** 重新注册监听的额外依赖；数组长度必须固定。 */
  deps?: unknown[];
  /**
   * 输入态豁免的例外键：这些键即使焦点在输入框里也要生效。
   * 仅供「窗口关闭保护」这类必须拦截的键（Ctrl/Cmd+W）使用，
   * 默认空数组 —— 严格遵守输入态豁免。
   */
  editableExempt?: string[];
}

/**
 * 注册单个全局 keydown 监听，并强制执行输入态 / 输入法豁免。
 *
 * @param handlers key → 处理器（内部始终取最新闭包，不会拿到过期值）
 * @param options enabled / target / capture / deps / editableExempt
 */
export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options: GlobalShortcutOptions = {},
): void {
  const {
    enabled = true,
    target,
    capture = false,
    deps,
    editableExempt,
  } = options;

  // 处理器表放 ref：监听只注册一次，但每次渲染都会拿到最新闭包。
  const handlersRef = useRef<ShortcutHandlers>(handlers);
  handlersRef.current = handlers;
  const exemptRef = useRef<readonly string[]>(editableExempt ?? []);
  exemptRef.current = editableExempt ?? [];

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // 1) 输入法组合中：任何全局快捷键都不得生效。
      if (isImeComposing(event)) return;
      // 2) 输入态：放行原生输入（input / textarea / select / contenteditable）。
      if (!exemptRef.current.includes(event.key) && isEditableTarget(event.target)) {
        return;
      }
      // 3) 其余按 key 分发。
      const handler = handlersRef.current[event.key];
      if (!handler) return;
      handler(event);
    };

    if (target) {
      // 联合类型（Window | HTMLElement）只能命中通用签名，这里显式收窄。
      const listener = onKeyDown as EventListener;
      target.addEventListener("keydown", listener, capture);
      return () => target.removeEventListener("keydown", listener, capture);
    }
    window.addEventListener("keydown", onKeyDown, capture);
    return () => window.removeEventListener("keydown", onKeyDown, capture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, target, capture, ...(deps ?? [])]);
}
