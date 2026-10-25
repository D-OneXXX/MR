import { invoke } from "@tauri-apps/api/core";
import type { SafeModeState } from "@/features/resilience/types";

export type { SafeModeState };

export function getSafeModeState(): Promise<SafeModeState> {
  return invoke<SafeModeState>("get_safe_mode_state");
}

export function enterSafeMode(reason = "manual"): Promise<SafeModeState> {
  return invoke<SafeModeState>("resilience_enable_safe_mode", { reason });
}

export function exitSafeMode(): Promise<SafeModeState> {
  return invoke<SafeModeState>("resilience_disable_safe_mode");
}
