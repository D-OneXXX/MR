/** Spread math — pure, 0-based page indexes. RTL = manga default. */

export type PageMode = "single" | "double" | "webtoon";
export type Direction = "rtl" | "ltr";

/**
 * Visible pages for 0-based index p of n total.
 * Order is visual left -> right. RTL double: page 0 stands alone on the
 * right (cover); from page 1 on, pairs are [later, earlier] so the earlier
 * page sits on the right.
 * 条漫模式不走 spread 布局（Webtoon 组件自绘）；此处按单页兜底防误用。
 */
export function spreadFor(
  p: number,
  n: number,
  mode: PageMode,
  dir: Direction,
): number[] {
  if (n <= 0) return [];
  const c = Math.max(0, Math.min(n - 1, p));
  if (mode !== "double" || n === 1) return [c];
  if (dir === "ltr") {
    const s = c % 2 === 0 ? c : c - 1;
    return s + 1 < n ? [s, s + 1] : [s];
  }
  if (c === 0) return [0];
  const s = c % 2 === 1 ? c : c - 1;
  return s + 1 < n ? [s + 1, s] : [s];
}

/** True when the spread is the lone RTL cover on the right side. */
export function isSoloCover(
  spread: number[],
  mode: PageMode,
  dir: Direction,
): boolean {
  return mode === "double" && dir === "rtl" && spread.length === 1 && spread[0] === 0;
}

/** Next/prev spread landing index from 0-based p (clamped). */
export function stepPage(
  p: number,
  n: number,
  mode: PageMode,
  dir: Direction,
  delta: 1 | -1,
): number {
  if (n <= 0) return 0;
  const c = Math.max(0, Math.min(n - 1, p));
  if (mode !== "double") return Math.max(0, Math.min(n - 1, c + delta));
  if (dir === "ltr") {
    const s = c % 2 === 0 ? c : c - 1;
    return Math.max(0, Math.min(n - 1, s + delta * 2));
  }
  if (delta === 1) {
    if (c === 0) return Math.min(n - 1, 1);
    const s = c % 2 === 1 ? c : c - 1;
    return Math.min(n - 1, s + 2);
  }
  if (c <= 1) return 0;
  const s = c % 2 === 1 ? c : c - 1;
  return Math.max(0, s - 2);
}
