import test from "node:test";
import assert from "node:assert/strict";
import { hasStableCode } from "../src/features/errors/stableCodes.ts";

test("hasStableCode matches Rust fullwidth stable codes", () => {
  assert.equal(
    hasStableCode("导入失败（archive-encrypted）", "archive-encrypted"),
    true,
  );
});

test("hasStableCode matches legacy halfwidth stable codes", () => {
  assert.equal(
    hasStableCode("failed (archive-encrypted)", "archive-encrypted"),
    true,
  );
});

test("hasStableCode requires exact code inside brackets", () => {
  assert.equal(hasStableCode("archive-encrypted", "archive-encrypted"), false);
  assert.equal(
    hasStableCode("（archive-encrypted-extra）", "archive-encrypted"),
    false,
  );
  assert.equal(hasStableCode("（other）", "archive-encrypted"), false);
});
