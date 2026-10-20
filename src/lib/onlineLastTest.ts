export interface OnlineLastTest {
  ok: boolean;
  at: number;
  urlHost: string;
}

export const ONLINE_LAST_TEST_KEY = "mr-online-last-test";
export const ONLINE_LAST_TEST_EVENT = "mr-online-last-test-updated";

/** 只保留目标主机（含端口）；userinfo、路径、query、hash 全部丢弃。 */
export function onlineTestTargetHost(raw: string): string {
  const value = raw.trim();
  if (!value) return "未知目标";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    const url = new URL(withScheme);
    const host = `${url.hostname}${url.port ? `:${url.port}` : ""}`;
    if (!host || /[=?#\s]/.test(host)) return "未知目标";
    return host.slice(0, 120);
  } catch {
    return "未知目标";
  }
}

export function readOnlineLastTest(): OnlineLastTest | null {
  try {
    const raw = localStorage.getItem(ONLINE_LAST_TEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnlineLastTest>;
    if (
      typeof parsed.ok !== "boolean" ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      typeof parsed.urlHost !== "string"
    ) {
      return null;
    }
    // 重新构造记录，丢弃历史版本可能残留的额外字段。
    const urlHost = parsed.urlHost
      .replace(/^.*@/, "")
      .split(/[/?#]/)[0]
      .trim()
      .slice(0, 120);
    if (!urlHost) return null;
    return {
      ok: parsed.ok,
      at: parsed.at,
      urlHost,
    };
  } catch {
    return null;
  }
}

export function writeOnlineLastTest(input: {
  ok: boolean;
  url: string;
  at?: number;
}): OnlineLastTest {
  const record: OnlineLastTest = {
    ok: input.ok,
    at: input.at ?? Date.now(),
    urlHost: onlineTestTargetHost(input.url),
  };
  try {
    localStorage.setItem(ONLINE_LAST_TEST_KEY, JSON.stringify(record));
  } catch {
    /* 忽略 */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ONLINE_LAST_TEST_EVENT));
  }
  return record;
}
