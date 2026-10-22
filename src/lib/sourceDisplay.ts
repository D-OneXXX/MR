export type SourceKind = "local" | "online";

export interface SourceDisplay {
  kind: SourceKind;
  text: string;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function localSourceName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * 只保留 scheme://host/…/末段路径；query / hash / userinfo 一律丢弃，
 * 避免清单 URL 中的临时 token 出现在 DOM 里。
 */
export function onlineSourceAddress(path: string): string {
  try {
    const url = new URL(path);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    const last = (segments[segments.length - 1] ?? "").split(/[?#]/)[0];
    const label = clip(last, 28);
    return `${url.protocol}//${url.host}/${label ? `…/${label}` : ""}`;
  } catch {
    return "";
  }
}

export function sourceDisplay(book: {
  sourceType: string;
  path: string;
}): SourceDisplay {
  if (book.sourceType === "local") {
    return { kind: "local", text: clip(localSourceName(book.path), 40) };
  }
  return { kind: "online", text: onlineSourceAddress(book.path) };
}
