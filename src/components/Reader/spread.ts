/** Spread math — pure, 0-based page indexes. RTL = manga default. */

export type PageMode = "single" | "double" | "webtoon";
export type Direction = "rtl" | "ltr";

/** 每页原始宽高（0-based 下标 → [width, height]）。 */
export type PageDims = ReadonlyMap<number, readonly [number, number]>;

export interface SpreadOptions {
  /**
   * 每页原始尺寸（来自 `get_webtoon_layout` 的逐页头部探测）。
   * 横向跨页大图（width > height × 1.1）自动独占一屏；缺省页按普通
   * 竖页参与配对。
   */
  dims?: PageDims | null;
  /**
   * 首页封面单独成页（double 模式）：开启后第 1 页独占居中，从
   * 第 [2,3]、[4,5] 页开始成对拼合。缺省值保持历史行为——RTL 封面
   * 单页（日漫惯例）、LTR 从 [0,1] 起对。
   */
  coverOffset?: boolean;
}

/**
 * 横向跨页大图判定：本身已是横向双页跨页图（宽 > 高 × 1.1）时独占一屏，
 * 绝不与相邻单页竖图强行并排挤压。
 */
export function isWidePage(width: number, height: number): boolean {
  return width > 0 && height > 0 && width > height * 1.1;
}

interface SpreadLayout {
  /** 阅读顺序的组列表；每组内部是「视觉左 → 右」的页下标。 */
  groups: number[][];
  /** 页下标 → 组下标（钳制到 0）。 */
  indexOf: number[];
}

function buildLayout(
  n: number,
  mode: PageMode,
  dir: Direction,
  options: SpreadOptions,
): SpreadLayout {
  const groups: number[][] = [];
  const indexOf = new Array<number>(Math.max(n, 0)).fill(0);
  if (n <= 0) return { groups, indexOf };

  const wide = (i: number) => {
    const dim = options.dims?.get(i);
    return dim ? isWidePage(dim[0], dim[1]) : false;
  };
  const push = (group: number[]) => {
    for (const page of group) indexOf[page] = groups.length;
    groups.push(group);
  };

  if (mode !== "double") {
    for (let i = 0; i < n; i += 1) push([i]);
    return { groups, indexOf };
  }

  // 封面偏移：显式开启 → 第 1 页独占；缺省保持历史行为（RTL 封面单页）。
  const coverOffset = options.coverOffset ?? dir === "rtl";
  let i = 0;
  if (coverOffset && n > 1) {
    push([0]);
    i = 1;
  }

  while (i < n) {
    if (wide(i)) {
      push([i]);
      i += 1;
      continue;
    }
    if (i + 1 < n && !wide(i + 1)) {
      // 组内保持「视觉左 → 右」：LTR 顺序 [i, i+1]；RTL 后页在左。
      push(dir === "ltr" ? [i, i + 1] : [i + 1, i]);
      i += 2;
    } else {
      push([i]);
      i += 1;
    }
  }
  return { groups, indexOf };
}

/**
 * Visible pages for 0-based index p of n total.
 * Order is visual left -> right.
 * 条漫模式不走 spread 布局（Webtoon 组件自绘）；此处按单页兜底防误用。
 */
export function spreadFor(
  p: number,
  n: number,
  mode: PageMode,
  dir: Direction,
  options: SpreadOptions = {},
): number[] {
  if (n <= 0) return [];
  const c = Math.max(0, Math.min(n - 1, p));
  const layout = buildLayout(n, mode, dir, options);
  return layout.groups[layout.indexOf[c]] ?? [c];
}

/** True when the spread is a lone first page shown as the cover. */
export function isSoloCover(
  spread: number[],
  mode: PageMode,
  dir: Direction,
  options: SpreadOptions = {},
): boolean {
  if (mode !== "double" || spread.length !== 1) return false;
  if (spread[0] !== 0) return false;
  return options.coverOffset ?? dir === "rtl";
}

/** True when the spread is a lone wide (landscape) page centered full-width. */
export function isWideSolo(
  spread: number[],
  mode: PageMode,
  dims?: PageDims | null,
): boolean {
  if (mode !== "double" || spread.length !== 1) return false;
  const dim = dims?.get(spread[0]);
  return dim ? isWidePage(dim[0], dim[1]) : false;
}

/** Next/prev spread landing index from 0-based p (clamped). */
export function stepPage(
  p: number,
  n: number,
  mode: PageMode,
  dir: Direction,
  delta: 1 | -1,
  options: SpreadOptions = {},
): number {
  if (n <= 0) return 0;
  const c = Math.max(0, Math.min(n - 1, p));
  const layout = buildLayout(n, mode, dir, options);
  const groupIndex = layout.indexOf[c] ?? 0;
  const next = Math.max(0, Math.min(layout.groups.length - 1, groupIndex + delta));
  // 落点取该组的最小页下标（RTL 组内视觉序与逻辑序相反）。
  return Math.min(...layout.groups[next]);
}
