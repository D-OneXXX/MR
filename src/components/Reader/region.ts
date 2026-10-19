/** 选区纯函数 — 相对坐标(0..1,相对页图元素)。与 scripts/verify-region.mjs 同逻辑。 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 面积阈值:小于该值的选区视为误触,不发起 OCR。 */
export const MIN_RECT = 0.012;

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** 两点 → 正规化矩形(支持反向拖动)。 */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/** 钳制到单位正方形内。 */
export function normRect(r: Rect): Rect {
  const x0 = clamp01(r.x);
  const y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w);
  const y1 = clamp01(r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectArea(r: Rect): number {
  return r.w * r.h;
}

export function isUsable(r: Rect): boolean {
  return rectArea(normRect(r)) >= MIN_RECT;
}

/** 视口坐标 → 元素内相对坐标(0..1)。 */
export function normPoint(el: ElRect, cx: number, cy: number): { x: number; y: number } {
  return {
    x: clamp01((cx - el.left) / (el.width || 1)),
    y: clamp01((cy - el.top) / (el.height || 1)),
  };
}
