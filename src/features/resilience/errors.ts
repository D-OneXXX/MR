import type { FrontendErrorEntry } from "./types";
import { pushFrontendError } from "./api";
import { currentRoute } from "./route";

const LIMIT = 20;
const entries: FrontendErrorEntry[] = [];

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function push(
  source: FrontendErrorEntry["source"],
  message: string,
  stack?: string | null,
): void {
  const clean = clip(message.trim(), 8_000);
  if (!clean) return;
  const last = entries[entries.length - 1];
  if (last && last.source === source && last.message === clean) return;
  const entry: FrontendErrorEntry = {
    at: new Date().toISOString(),
    source,
    message: clean,
    stack: stack ? clip(stack, 24_000) : null,
    route: currentRoute(),
  };
  entries.push(entry);
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
  pushFrontendError({
    source,
    message: clean,
    stack: entry.stack ?? null,
    route: entry.route,
  });
}

function stackOf(value: unknown): string | null {
  return value instanceof Error && typeof value.stack === "string"
    ? value.stack
    : null;
}

interface Installed {
  active: boolean;
}

const installation: Installed = { active: false };

/** Install global error capture without changing user-visible console output. */
export function installErrorCollectors(): void {
  if (installation.active || typeof window === "undefined") return;
  installation.active = true;

  const nativeError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    nativeError(...args);
    try {
      const message = args.map(text).join(" ");
      const firstError = args.find((value) => value instanceof Error);
      push("console.error", message, stackOf(firstError));
    } catch {
      /* error collection must never throw */
    }
  };

  window.addEventListener(
    "error",
    (event) => {
      if (!event.message) return;
      const fileName = event.filename ? ` (${event.filename}:${event.lineno})` : "";
      push("window.error", `${event.message}${fileName}`, stackOf(event.error));
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    push(
      "unhandledrejection",
      `Unhandled rejection: ${text(reason)}`,
      stackOf(reason),
    );
  });
}

/** Called by the top-level React error boundary. */
export function recordBoundaryError(error: unknown, componentStack?: string): void {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : text(error);
  const stack = [
    stackOf(error),
    componentStack ? `React component stack:\n${componentStack}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  push("error-boundary", message, stack || null);
}

export function getFrontendErrors(): FrontendErrorEntry[] {
  return entries.slice();
}
