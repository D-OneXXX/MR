import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/tauri";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "mr-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    /* 无 localStorage 时跟随系统 */
  }
  return "system";
}

function resolve(mode: ThemeMode, system: ResolvedTheme): ResolvedTheme {
  return mode === "system" ? system : mode;
}

function writeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/** Persist the preference to SQLite without blocking the UI. */
function persistMode(mode: ThemeMode) {
  void api
    .getSettings()
    .then((settings) => {
      if (settings.theme === mode) return;
      return api.setSettings({ ...settings, theme: mode });
    })
    .catch(() => {
      /* 无 Tauri 环境时只保留本地偏好 */
    });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const resolved = resolve(mode, system);

  // 跨窗口同步：其它窗口改写 mr-theme 时只更新内存状态，绝不回写
  // localStorage / SQLite，否则会与来源窗口形成回环。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        // clear()：本地键被清空，回落到跟随系统
        setModeState("system");
        return;
      }
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === null) {
        // removeItem：与 readMode 的默认值保持一致
        setModeState("system");
        return;
      }
      if (
        event.newValue === "light" ||
        event.newValue === "dark" ||
        event.newValue === "system"
      ) {
        setModeState(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (mode !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystem(event.matches ? "dark" : "light");
    };
    setSystem(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    root.style.colorScheme = resolved;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) meta.content = resolved === "dark" ? "#0B111E" : "#EFF8FF";
  }, [mode, resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeMode(next);
    persistMode(next);
  }, []);

  const cycleTheme = useCallback(() => {
    const next: ThemeMode = resolved === "dark" ? "light" : "dark";
    setMode(next);
  }, [resolved, setMode]);

  const value = useMemo(
    () => ({ mode, resolved, setMode, cycleTheme }),
    [mode, resolved, setMode, cycleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return value;
}
