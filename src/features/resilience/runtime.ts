import { installErrorCollectors } from "./errors";
import { startHeartbeat } from "./heartbeat";
import { installRageClickDetector } from "./rageClick";
import { updateRuntimeContext } from "./context";
import { currentRoute } from "./route";
import { recordBreadcrumb } from "./breadcrumbs";
import { markAppReady } from "./api";

let started = false;
let lastKnownRoute: string | null = null;
let readyTimer: number | undefined;

const READY_DELAY_MS = 4_000;

function syncRoute(record: boolean): void {
  const route = currentRoute();
  const changed = route !== lastKnownRoute;
  lastKnownRoute = route;
  updateRuntimeContext({ route });
  if (record && changed) recordBreadcrumb("navigation", { route });
}

/**
 * Install main-window resilience. This runs once, independently of React
 * remounts, and never renders UI or takes recovery actions on its own.
 */
export function installResilienceRuntime(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  installErrorCollectors();
  installRageClickDetector();

  lastKnownRoute = currentRoute();
  updateRuntimeContext({ route: lastKnownRoute });
  recordBreadcrumb("navigation", { route: lastKnownRoute });

  window.addEventListener("hashchange", () => syncRoute(true));
  window.addEventListener("popstate", () => syncRoute(true));

  startHeartbeat();
  if (readyTimer !== undefined) window.clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    markAppReady();
    recordBreadcrumb("other", { route: currentRoute() });
  }, READY_DELAY_MS);
}
