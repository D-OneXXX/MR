/**
 * WebView 侧平台探测（用户代理推断）。
 *
 * 仅用于展示层差异（目录提示、更新策略说明）；权限与安全决策一律在
 * Rust 侧（`src-tauri/src/platform.rs`）完成，前端猜测不作为依据。
 */

export type PlatformKind = "windows" | "linux" | "mac" | "unknown";

export function platformKind(): PlatformKind {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  // WebKitGTK 的 UA 携带 "X11" 或 "Linux"；桌面专用构建无 Android 场景。
  if (/Linux|X11/i.test(ua)) return "linux";
  if (/Mac OS X/i.test(ua)) return "mac";
  return "unknown";
}

export function isLinuxPlatform(): boolean {
  return platformKind() === "linux";
}
