import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  ReadyUpdate,
  UpdateCheck,
  UpdateKind,
  UpdateProgress,
  UpdateSnapshot,
} from "./types";

/**
 * Rust update commands. The manifest URL is checked again in Rust for
 * HTTPS/loopback, hash, signature and installer policy; the frontend never
 * receives an arbitrary install path.
 */
export const updateApi = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),

  checkUpdate: (manifestUrl: string) =>
    invoke<UpdateCheck>("check_update", { manifestUrl }),

  downloadUpdate: (
    manifestUrl: string,
    version: string,
    kind: UpdateKind,
    requestId: string,
    onProgress: (progress: UpdateProgress) => void,
  ) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = (progress) => onProgress(progress);
    return invoke<ReadyUpdate>("download_update", {
      manifestUrl,
      version,
      kind,
      requestId,
      onEvent: channel,
    });
  },

  installUpdate: () => invoke<void>("install_update"),

  cancelUpdate: () => invoke<void>("cancel_update"),

  getUpdateSnapshot: () => invoke<UpdateSnapshot>("get_update_snapshot"),
};
