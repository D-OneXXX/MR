/** IPC contracts shared with `src-tauri/src/resilience.rs` and `diagnostics.rs`. */
export interface SafeModeState {
  active: boolean;
  reason?: string | null;
  activatedAt?: string | null;
}

export type RecoveryTrigger =
  | "rageClick"
  | "heartbeatTimeout"
  | "startupFailures";

export interface RecoveryContext {
  trigger: RecoveryTrigger;
  detail: string;
  detectedAt: string;
  lastRoute?: string | null;
  heartbeatAgeMs: number;
  responsive: boolean;
  safeMode: SafeModeState;
}

export interface RageClickPayload {
  count: number;
  windowMs: number;
  target: string;
  route: string;
}

export type ReaderMode = "single" | "double" | "webtoon";

export interface RuntimeContextInput {
  route?: string | null;
  readerMode?: ReaderMode | null;
  readerPage?: number | null;
  safeMode?: boolean | null;
}

export type BreadcrumbKind =
  | "navigation"
  | "readerMode"
  | "archiveImport"
  | "folderImport"
  | "fileOpen"
  | "relocateBook"
  | "onlineRead"
  | "settingsChange"
  | "themeChange"
  | "localeChange"
  | "onlinePairing"
  | "recovery"
  | "safeMode"
  | "update"
  | "privacy"
  | "readerPage"
  // PDF（PDF-2）：打开 / 渲染失败 / 适配模式切换。
  | "pdf-open"
  | "pdf-open-failed"
  | "pdf-render-failed"
  | "pdf-fit-change"
  | "other";

export interface Breadcrumb {
  at: string;
  kind: BreadcrumbKind;
  route?: string | null;
}

export interface FrontendErrorEntry {
  at: string;
  source:
    | "window.error"
    | "unhandledrejection"
    | "console.error"
    | "error-boundary"
    | "other";
  message: string;
  stack?: string | null;
  route?: string | null;
}
