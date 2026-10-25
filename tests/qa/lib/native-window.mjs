import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * WebView2 ignores CDP viewport emulation. Resize the real native window on
 * Windows so 900px minimum-width layout checks exercise the actual shell.
 */
export function resizeNativeWindow(pid, physicalWidth, physicalHeight) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "native window resize is Windows-only in this QA harness" };
  }
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class QaWindow {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
}
"@
[QaWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$process = Get-Process -Id ${Number(pid)} -ErrorAction Stop
if ($process.MainWindowHandle -eq 0) { throw "main window handle unavailable" }
[QaWindow]::SetWindowPos($process.MainWindowHandle, [IntPtr]::Zero, 80, 70, ${Math.round(physicalWidth)}, ${Math.round(physicalHeight)}, 0x0014) | Out-Null
"resized"
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    reason:
      result.status === 0
        ? ""
        : String(result.stderr || result.stdout || "powershell resize failed").trim(),
  };
}
