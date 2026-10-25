import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticBundle } from "./types";

export type { DiagnosticBundle } from "./types";

export function collectDiagnostics(redactUrlPaths: boolean): Promise<DiagnosticBundle> {
  return invoke<DiagnosticBundle>("diagnostics_collect", { redactUrlPaths });
}

export function exportDiagnostics(markdown: string): Promise<string> {
  return invoke<string>("diagnostics_export", { markdown });
}

export function sanitizeDiagnosticsDescription(text: string): Promise<string> {
  return invoke<string>("diagnostics_sanitize_description", { text });
}
