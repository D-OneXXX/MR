import { sendHeartbeat } from "./api";
import { getRuntimeContext } from "./context";

const INTERVAL_MS = 2_000;

let timer: number | undefined;

function beat(): void {
  const context = getRuntimeContext();
  sendHeartbeat({
    route: context.route,
    readerMode: context.readerMode,
    readerPage: context.readerPage,
  });
}

/**
 * A renderer-side liveness signal. A hard loop (`while(true)`) stops this
 * interval; Rust then opens the isolated recovery window after 6 seconds.
 */
export function startHeartbeat(): void {
  if (timer !== undefined) return;
  if (window.location.pathname.includes("recovery.html")) return;
  beat();
  timer = window.setInterval(beat, INTERVAL_MS);
}
