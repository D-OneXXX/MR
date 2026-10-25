// 阶段二验收：双页 RTL 排布纯函数验证（与 src/components/Reader/spread.ts 同逻辑）。
// 运行：node scripts/verify-spread.mjs
function spreadFor(p, n, mode, dir) {
  if (n <= 0) return [];
  const c = Math.max(0, Math.min(n - 1, p));
  if (mode === "single" || n === 1) return [c];
  if (dir === "ltr") {
    const s = c % 2 === 0 ? c : c - 1;
    return s + 1 < n ? [s, s + 1] : [s];
  }
  if (c === 0) return [0];
  const s = c % 2 === 1 ? c : c - 1;
  return s + 1 < n ? [s + 1, s] : [s];
}
function stepPage(p, n, mode, dir, delta) {
  if (n <= 0) return 0;
  const c = Math.max(0, Math.min(n - 1, p));
  if (mode === "single") return Math.max(0, Math.min(n - 1, c + delta));
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
const check = (name, got, want) => {
  const ok = eq(got, want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
// 日式 RTL 双页：第一页单独成右页
check("rtl cover solo", spreadFor(0, 500, "double", "rtl"), [0]);
check("rtl p1 spread", spreadFor(1, 500, "double", "rtl"), [2, 1]);
check("rtl p2 spread", spreadFor(2, 500, "double", "rtl"), [2, 1]);
check("rtl p3 spread", spreadFor(3, 500, "double", "rtl"), [4, 3]);
check("rtl step 0->next", stepPage(0, 500, "double", "rtl", 1), 1);
check("rtl step 1->next", stepPage(1, 500, "double", "rtl", 1), 3);
check("rtl step 3->prev", stepPage(3, 500, "double", "rtl", -1), 1);
check("rtl step 1->prev", stepPage(1, 500, "double", "rtl", -1), 0);
// 西式对照
check("ltr p0 spread", spreadFor(0, 500, "double", "ltr"), [0, 1]);
check("ltr p1 spread", spreadFor(1, 500, "double", "ltr"), [0, 1]);
// 单页
check("single step", stepPage(7, 500, "single", "rtl", 1), 8);
// 边界：500页卷尾
check("rtl tail", spreadFor(499, 500, "double", "rtl"), [499]);
if (fail > 0) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log("\nAll RTL spread checks passed.");
