// 阶段三验收:选区归一化纯函数验证(与 src/components/Reader/region.ts 同逻辑)。
// 运行:node scripts/verify-region.mjs
function clamp01(v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
function rectFromPoints(ax, ay, bx, by) {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}
function normRect(r) {
  const x0 = clamp01(r.x), y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w), y1 = clamp01(r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const MIN_RECT = 0.012;
function rectArea(r) { return r.w * r.h; }
function isUsable(r) { return rectArea(normRect(r)) >= MIN_RECT; }
function normPoint(el, cx, cy) {
  return {
    x: clamp01((cx - el.left) / (el.width || 1)),
    y: clamp01((cy - el.top) / (el.height || 1)),
  };
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
// 浮点经 1e-6 舍入后再做结构比较(0.1+0.2 类表示误差)。
const r6 = (r) => ({
  x: Math.round(r.x * 1e6) / 1e6,
  y: Math.round(r.y * 1e6) / 1e6,
  w: Math.round(r.w * 1e6) / 1e6,
  h: Math.round(r.h * 1e6) / 1e6,
});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
const check = (name, got, want) => {
  const ok = eq(got, want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
// 反向拖动归一化
check("reverse drag", r6(rectFromPoints(0.8, 0.9, 0.2, 0.3)), { x: 0.2, y: 0.3, w: 0.6, h: 0.6 });
// normRect 钳制越界
check("clamp over", r6(normRect({ x: -0.2, y: -0.2, w: 1.5, h: 1.5 })), { x: 0, y: 0, w: 1, h: 1 });
check("clamp tail", r6(normRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })), { x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
// 可用性阈值
check("usable big", isUsable({ x: 0, y: 0, w: 0.5, h: 0.5 }), true);
check("usable tiny", isUsable({ x: 0, y: 0, w: 0.1, h: 0.1 }), false);
check("usable edge", isUsable({ x: 0, y: 0, w: 0.12, h: 0.1 }), true);
// 元素内归一化点
const el = { left: 100, top: 50, width: 200, height: 100 };
const p = normPoint(el, 150, 100);
check("norm point", near(p.x, 0.25) && near(p.y, 0.5), true);
const q = normPoint(el, 0, 0);
check("norm point outside", q.x === 0 && q.y === 0, true);
// 退化输入
check("nan guard", clamp01(NaN), 0);
// 零尺寸元素:防除零(||1)后钳制,得到的仍是退化选区(面积为 0),绝不触发 OCR。
const z = normPoint({ left: 0, top: 0, width: 0, height: 0 }, 5, 5);
check("zero el degenerate", z.x === 1 && z.y === 1 && !isUsable({ x: z.x, y: z.y, w: 0, h: 0 }), true);
if (fail > 0) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log("\nAll region checks passed.");
