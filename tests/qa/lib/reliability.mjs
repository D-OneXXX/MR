export function isCdpTimeoutError(error) {
  const text = String(error?.message ?? error ?? "");
  return /(CDP|Runtime|WebSocket)/i.test(text) && /(超时|timeout)/i.test(text);
}

export function shouldRetryCdp({ attempt, maxAttempts, error }) {
  return (
    Number(attempt) < Number(maxAttempts) && isCdpTimeoutError(error)
  );
}

export function classifyRecoveryClose({ targetPresent, commandTimedOut }) {
  if (!targetPresent) return "closed";
  return commandTimedOut ? "timeout-and-open" : "open";
}
