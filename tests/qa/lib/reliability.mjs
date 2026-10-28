export function isCdpTimeoutError(error) {
  const text = String(error?.message ?? error ?? "");
  return /(CDP|Runtime|WebSocket)/i.test(text) && /(超时|timeout)/i.test(text);
}

/** 页面导航/热重载期间 CDP 会销毁旧执行上下文；这是可恢复的瞬时状态。 */
export function isCdpContextDestroyed(error) {
  const text = String(error?.message ?? error ?? "");
  return /Execution context was destroyed/i.test(text);
}

/**
 * 重载后必须拿到**新的文档**：performance.timeOrigin 应不同于重载前。
 * 旧上下文里 waitForApp 可能先返回 true，随后才被销毁，正好造成
 * cache 套件启动瞬间的 “Execution context was destroyed”。
 */
export function isFreshPage(previousTimeOrigin, nextTimeOrigin) {
  if (typeof previousTimeOrigin !== "number" || typeof nextTimeOrigin !== "number") {
    return false;
  }
  if (!Number.isFinite(previousTimeOrigin) || !Number.isFinite(nextTimeOrigin)) {
    return false;
  }
  return nextTimeOrigin !== previousTimeOrigin;
}

export function shouldRetryCdp({ attempt, maxAttempts, error }) {
  return (
    Number(attempt) < Number(maxAttempts) &&
    (isCdpTimeoutError(error) || isCdpContextDestroyed(error))
  );
}

export function classifyRecoveryClose({ targetPresent, commandTimedOut }) {
  if (!targetPresent) return "closed";
  return commandTimedOut ? "timeout-and-open" : "open";
}
