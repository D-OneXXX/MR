import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

/**
 * Thin wrapper around the official Tauri updater/process plugins.
 *
 * The GitHub channel is an additive entry point: the custom manifest/patch
 * channel in `api.ts` stays untouched. Signature verification and installer
 * execution stay in Rust; the webview only receives sizes, versions and text.
 */

export interface NativeUpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

/** An announced update plus the backend resource that holds it. */
export interface NativeUpdateCheck {
  update: Update;
  info: NativeUpdateInfo;
}

export interface NativeDownloadProgress {
  /** Bytes written so far. */
  downloaded: number;
  /** Total bytes when the server announced a content length. */
  total: number | null;
  /** 0-100, or null while the total size is unknown. */
  percent: number | null;
}

export type NativeInstallEvent =
  | ({ phase: "downloading" } & NativeDownloadProgress)
  | { phase: "installing" };

export type NativeUpdateFailureStage = "check" | "install" | "close" | "relaunch";

function messageOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "";
}

/**
 * Plugin errors can embed the signed download endpoint. Strip any URL before
 * writing a debug line; keys, headers and tokens never reach the console.
 */
export function reportNativeUpdateFailure(
  stage: NativeUpdateFailureStage,
  reason: unknown,
): void {
  const safe = messageOf(reason).replace(/https?:\/\/\S+/gi, "[redacted-url]");
  const name = reason instanceof Error ? reason.name : "Error";
  console.error(`[update-native] ${stage} failed (${name})`, safe);
}

/** Windows installers relaunch the app themselves; other targets need help. */
export function isWindowsPlatform(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Windows/i.test(ua);
}

/** Manual check against the endpoints configured in `tauri.conf.json`. */
export async function checkNativeUpdate(): Promise<NativeUpdateCheck | null> {
  const update = await check();
  if (!update) return null;
  return {
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      ...(update.date ? { date: update.date } : {}),
      ...(update.body ? { body: update.body } : {}),
    },
  };
}

/**
 * Download the signed package and hand it to the installer.
 *
 * On Windows the app exits once the NSIS installer starts — this only happens
 * after the user pressed the install button. On other platforms the promise
 * resolves after installation and the caller must call {@link relaunchApp}.
 */
export async function installNativeUpdate(
  update: Update,
  onProgress?: (event: NativeInstallEvent) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  const emitProgress = () => {
    if (!onProgress) return;
    const percent =
      total && total > 0
        ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
        : null;
    onProgress({ phase: "downloading", downloaded, total, percent });
  };

  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      const length = event.data.contentLength;
      total = typeof length === "number" && length > 0 ? length : null;
      downloaded = 0;
      emitProgress();
      return;
    }
    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      emitProgress();
      return;
    }
    onProgress?.({ phase: "installing" });
  });

  onProgress?.({ phase: "installing" });
  await update.install();
}

/** Releases the backend update resource; safe to call with nothing held. */
export async function closeNativeUpdate(
  update: Update | null | undefined,
): Promise<void> {
  if (!update) return;
  try {
    await update.close();
  } catch (reason) {
    reportNativeUpdateFailure("close", reason);
  }
}

/** Restart the app after a non-Windows install. */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}
