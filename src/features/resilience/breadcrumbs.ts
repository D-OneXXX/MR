import type { Breadcrumb, BreadcrumbKind } from "./types";
import { pushBreadcrumb } from "./api";
import { currentRoute } from "./route";

const LIMIT = 20;
const ring: Breadcrumb[] = [];

/** Record an action type only — never labels, filenames, titles or URLs. */
export function recordBreadcrumb(
  kind: BreadcrumbKind,
  options: { route?: string | null } = {},
): void {
  const entry: Breadcrumb = {
    at: new Date().toISOString(),
    kind,
    route: options.route ?? currentRoute(),
  };
  ring.push(entry);
  if (ring.length > LIMIT) ring.splice(0, ring.length - LIMIT);
  pushBreadcrumb({ kind, route: entry.route });
}

export function getBreadcrumbs(): Breadcrumb[] {
  return ring.slice();
}
