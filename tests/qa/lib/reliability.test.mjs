import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRecoveryClose,
  isCdpTimeoutError,
  shouldRetryCdp,
} from "./reliability.mjs";

test("isCdpTimeoutError recognizes CDP runtime timeouts only", () => {
  assert.equal(
    isCdpTimeoutError(new Error("主窗口不可响应：CDP Runtime.enable 超时")),
    true,
  );
  assert.equal(
    isCdpTimeoutError(new Error("CDP Runtime.evaluate timeout")),
    true,
  );
  assert.equal(isCdpTimeoutError(new Error("恢复窗口不可响应")), false);
  assert.equal(isCdpTimeoutError(new Error("safe mode not active")), false);
});

test("shouldRetryCdp retries only transient CDP timeouts before the limit", () => {
  const timeout = new Error("CDP Runtime.enable 超时");
  assert.equal(shouldRetryCdp({ attempt: 1, maxAttempts: 3, error: timeout }), true);
  assert.equal(shouldRetryCdp({ attempt: 2, maxAttempts: 3, error: timeout }), true);
  assert.equal(shouldRetryCdp({ attempt: 3, maxAttempts: 3, error: timeout }), false);
  assert.equal(
    shouldRetryCdp({
      attempt: 1,
      maxAttempts: 3,
      error: new Error("safe mode not active"),
    }),
    false,
  );
});

test("classifyRecoveryClose tolerates a timed-out close only when the target is gone", () => {
  assert.equal(
    classifyRecoveryClose({ targetPresent: false, commandTimedOut: true }),
    "closed",
  );
  assert.equal(
    classifyRecoveryClose({ targetPresent: false, commandTimedOut: false }),
    "closed",
  );
  assert.equal(
    classifyRecoveryClose({ targetPresent: true, commandTimedOut: true }),
    "timeout-and-open",
  );
  assert.equal(
    classifyRecoveryClose({ targetPresent: true, commandTimedOut: false }),
    "open",
  );
});
