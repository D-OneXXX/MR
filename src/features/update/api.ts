import { invoke } from "@tauri-apps/api/core";
import type { AppInfo } from "./types";

/**
 * Rust update commands used by the frontend. The unified settings card runs on
 * the official tauri-plugin-updater channel (`native.ts`); artifact download,
 * hash and signature verification for the patch channel stay entirely in Rust.
 */
export const updateApi = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
};
