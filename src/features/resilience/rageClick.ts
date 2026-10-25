import { reportRageClick } from "./api";
import { currentRoute } from "./route";

const WINDOW_MS = 1_500;
const MAX_DISTANCE = 30;
const REQUIRED_CLICKS = 5;
const SETTLE_MS = 260;
const COOLDOWN_MS = 15_000;

interface ClickPoint {
  time: number;
  x: number;
  y: number;
  signature: string;
  route: string;
}

let installed = false;
let clicks: ClickPoint[] = [];
let lastProgressAt = -Infinity;
let cooldownUntil = 0;
let settleTimer: number | undefined;
let progressObserver: MutationObserver | null = null;

/** 无 id/label/testid 时用有限的 DOM 路径区分同标签按钮。 */
function domPath(node: Element): string {
  const parts: string[] = [];
  let current: Element | null = node;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const parent: Element | null = current.parentElement;
    const index = parent
      ? Array.from(parent.children).indexOf(current)
      : 0;
    parts.unshift(`${current.tagName.toLowerCase()}:${index}`);
    current = parent;
  }
  return parts.join(">");
}

function interactiveSignature(target: Element): string {
  const node =
    target.closest(
      "button,a,input,select,textarea,label,[role='button'],[role='tab'],[role='menuitem'],[contenteditable='true']",
    ) ?? target;
  const tag = node.tagName.toLowerCase();
  const role = node.getAttribute("role") ?? "";
  const testId = node.getAttribute("data-testid") ?? "";
  const id = node.id;
  const label = (
    node.getAttribute("aria-label") ??
    node.getAttribute("title") ??
    node.textContent ??
    ""
  )
    .trim()
    .slice(0, 40);
  // 同一标签/角色的不同按钮不能只靠 tag 聚合：优先用稳定身份，
  // 都没有时用 4 层 DOM 路径兜底。
  const identity = testId || id || label;
  return `${tag}|${role}|${testId}|${id}|${label}|${identity ? "" : domPath(node)}`;
}

function isIgnored(target: Element): boolean {
  return Boolean(
    target.closest(
      "input,textarea,select,option,[contenteditable='true'],[data-rage-ignore]",
    ),
  );
}

function installProgressObserver(): void {
  if (typeof MutationObserver === "undefined") return;
  // 只把“有意义的交互状态变化”当作进展：路由变化由 evaluate 单独比较，
  // 这里观察 ARIA/open/hidden/inert 与图片/链接源。背景动画、加载文字、
  // 时钟等 childList/characterData 抖动不能再把真实连点误判成“页面有进展”。
  progressObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "attributes" || record.attributeName === null) {
        continue;
      }
      if (
        [
          // 懒加载封面/缩略图的 src 变化不是用户交互进展；保留 href
          // 与 ARIA/弹层状态，避免后台图片加载吞掉真实连点。
          "href",
          "aria-expanded",
          "aria-selected",
          "aria-pressed",
          "data-state",
          "open",
          "disabled",
          "hidden",
          "inert",
        ].includes(record.attributeName)
      ) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target?.closest("[data-rage-ignore], [data-toast]")) {
          continue;
        }
        lastProgressAt = performance.now();
        return;
      }
    }
  });
  progressObserver.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: [
      "href",
      "aria-expanded",
      "aria-selected",
      "aria-pressed",
      "data-state",
      "open",
      "disabled",
      "hidden",
      "inert",
    ],
  });
}

function reset(): void {
  clicks = [];
  if (settleTimer !== undefined) {
    window.clearTimeout(settleTimer);
    settleTimer = undefined;
  }
}

function evaluate(): void {
  settleTimer = undefined;
  if (clicks.length < REQUIRED_CLICKS) return;
  const first = clicks[0];
  const now = performance.now();
  const route = currentRoute();
  if (
    now - first.time > WINDOW_MS ||
    route !== first.route ||
    lastProgressAt >= first.time ||
    now < cooldownUntil
  ) {
    reset();
    return;
  }

  const payload = {
    count: clicks.length,
    windowMs: Math.min(WINDOW_MS, Math.round(now - first.time)),
    target: first.signature,
    route: first.route,
  };
  cooldownUntil = now + COOLDOWN_MS;
  reset();
  void reportRageClick(payload).catch(() => {
    /* Backend may be unavailable; never auto-recover from here. */
  });
}

/**
 * Detect five primary clicks inside 1.5s within 30px or on the same element
 * while the route and meaningful DOM state remain unchanged. The detector only
 * reports a signal; Rust decides whether to focus the recovery window.
 */
export function installRageClickDetector(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  installProgressObserver();

  window.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || isIgnored(target)) return;

    const now = performance.now();
    const route = currentRoute();
    const point: ClickPoint = {
      time: now,
      x: event.clientX,
      y: event.clientY,
      signature: interactiveSignature(target),
      route,
    };

    if (clicks.length > 0) {
      const anchor = clicks[0];
      const near =
        Math.hypot(point.x - anchor.x, point.y - anchor.y) <= MAX_DISTANCE;
      const sameElement = point.signature === anchor.signature;
      if ((!near && !sameElement) || point.route !== anchor.route) {
        reset();
      }
    }

    clicks = clicks.filter((item) => now - item.time <= WINDOW_MS);
    clicks.push(point);

    if (clicks.length >= REQUIRED_CLICKS) {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(evaluate, SETTLE_MS);
    }
  });
}
