/** Route shapes safe to keep in local breadcrumbs/errors. */
export function normalizeRoute(raw?: string | null): string {
  if (!raw) return "/";
  let value = raw.trim();
  if (!value) return "/";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      value = new URL(value).pathname;
    } catch {
      return "/";
    }
  }
  value = value.replace(/^#/, "");
  value = value.split("?")[0]?.split("#")[0] ?? "/";
  if (value.startsWith("/reader/")) return "/reader/:id";
  if (!value.startsWith("/")) return "/";
  return value.replace(/\/+$/, "") || "/";
}

export function currentRoute(): string {
  if (typeof window === "undefined") return "/";
  return normalizeRoute(window.location.hash || window.location.pathname);
}
