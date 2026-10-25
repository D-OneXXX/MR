import { invoke } from "@tauri-apps/api/core";
import type { AppInfo } from "./types";

/**
 * Rust update commands used by the frontend. The unified settings card runs on
 * the official tauri-plugin-updater channel (`native.ts`); the retired custom
 * patch channel no longer exposes any IPC.
 */
export const updateApi = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
};
