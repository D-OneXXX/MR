import assert from "node:assert/strict";
import { test } from "node:test";
import { validateListBooks } from "./library-ui-check.mjs";

const fixture = {
  bookId: "1".repeat(64),
  title: "Release Smoke Book",
  currentPage: 2,
  scrollPct: 0.5,
  bookCount: 1,
};

function book(overrides = {}) {
  return {
    id: fixture.bookId,
    title: fixture.title,
    currentPage: fixture.currentPage,
    scrollPct: fixture.scrollPct,
    ...overrides,
  };
}

test("validateListBooks：应用 IPC 回读到同一本书、同一进度 → 通过", () => {
  const result = validateListBooks([book()], fixture);
  assert.equal(result.ok, true);
  assert.equal(result.source, "list_books");
  assert.equal(result.bookId, fixture.bookId);
  assert.equal(result.currentPage, 2);
  assert.equal(result.scrollPct, 0.5);
  assert.equal(result.bookCount, 1);
  assert.deepEqual(result.problems, []);
});

test("validateListBooks：兼容 scroll_pct 下划线字段", () => {
  const result = validateListBooks(
    [book({ scrollPct: undefined, scroll_pct: 0.5 })],
    fixture,
  );
  assert.equal(result.ok, true);
});

test("validateListBooks：找不到书 → 拒绝", () => {
  const result = validateListBooks([], fixture);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("找不到书")));
});

test("validateListBooks：阅读进度被改 → 拒绝", () => {
  const result = validateListBooks([book({ currentPage: 1 })], fixture);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("阅读进度不一致")));
});

test("validateListBooks：条漫偏移被改 → 拒绝", () => {
  const result = validateListBooks([book({ scrollPct: 0.2 })], fixture);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("条漫偏移不一致")));
});

test("validateListBooks：书数不符（混入真实书库）→ 拒绝", () => {
  const result = validateListBooks([book(), book({ id: "2".repeat(64) })], fixture);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("书数不一致")));
});

test("validateListBooks：标题被改 → 拒绝", () => {
  const result = validateListBooks([book({ title: "Other Book" })], fixture);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("标题不一致")));
});
