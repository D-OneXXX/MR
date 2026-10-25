import type { ReaderMode, RuntimeContextInput } from "./types";
import { pushRuntimeContext } from "./api";
import { currentRoute } from "./route";

interface RuntimeContext {
  route: string;
  readerMode: ReaderMode | null;
  readerPage: number | null;
  safeMode: boolean;
}

const state: RuntimeContext = {
  route: currentRoute(),
  readerMode: null,
  readerPage: null,
  safeMode: false,
};

export function getRuntimeContext(): Readonly<RuntimeContext> {
  return state;
}

/**
 * Merge and push the latest non-sensitive runtime context. The recovery window
 * cannot inspect the main renderer while it is blocked, so Rust keeps this last
 * known snapshot.
 */
export function updateRuntimeContext(partial: RuntimeContextInput): void {
  if (partial.route !== undefined) state.route = partial.route || "/";
  if (partial.readerMode !== undefined) {
    state.readerMode =
      partial.readerMode === "single" ||
      partial.readerMode === "double" ||
      partial.readerMode === "webtoon"
        ? partial.readerMode
        : null;
  }
  if (partial.readerPage !== undefined) {
    const page = Number(partial.readerPage);
    state.readerPage =
      Number.isFinite(page) && page >= 0 ? Math.floor(page) : null;
  }
  if (partial.safeMode !== undefined) state.safeMode = Boolean(partial.safeMode);
  pushRuntimeContext({
    route: state.route,
    readerMode: state.readerMode,
    readerPage: state.readerPage,
    safeMode: state.safeMode,
  });
}
