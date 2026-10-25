import { invoke } from "@tauri-apps/api/core";
import type {
  BreadcrumbKind,
  RageClickPayload,
  ReaderMode,
  RecoveryContext,
  RuntimeContextInput,
} from "./types";

/** Fire-and-forget: resilience must never break the UI if IPC is unavailable. */
function quietly(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

export function reportRageClick(payload: RageClickPayload): Promise<boolean> {
  return invoke<boolean>("resilience_report_rage_click", { payload });
}

export function getRecoveryContext(): Promise<RecoveryContext> {
  return invoke<RecoveryContext>("get_recovery_context");
}

export function reloadMainView(): Promise<void> {
  return invoke<void>("resilience_reload_main");
}

export function closeRecoveryWindow(): Promise<void> {
  return invoke<void>("resilience_close_recovery");
}

export function markAppReady(): void {
  quietly(invoke<void>("resilience_mark_ready"));
}

export function sendHeartbeat(context: {
  route: string | null;
  readerMode: ReaderMode | null;
  readerPage: number | null;
}): void {
  quietly(
    invoke<void>("heartbeat_ping", {
      route: context.route,
      readerMode: context.readerMode,
      readerPage: context.readerPage,
    }),
  );
}

export function pushFrontendError(entry: {
  source: string;
  message: string;
  stack?: string | null;
  route?: string | null;
}): void {
  quietly(invoke<void>("diagnostics_record_frontend_error", { entry }));
}

export function pushBreadcrumb(entry: {
  kind: BreadcrumbKind;
  route?: string | null;
}): void {
  quietly(invoke<void>("diagnostics_record_breadcrumb", { entry }));
}

export function pushRuntimeContext(context: RuntimeContextInput): void {
  quietly(invoke<void>("diagnostics_update_context", { context }));
}
