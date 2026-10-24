import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { updateApi } from "./api";
import {
  loadUpdatePrefs,
  saveUpdatePrefs,
  type AppInfo,
  type UpdatePrefs,
} from "./types";

interface UpdateContextValue {
  appInfo: AppInfo | null;
  appInfoError: boolean;
  /**
   * 补丁通道的遗留本机偏好（清单地址 + 通道）。设置页已不再暴露编辑入口，
   * 但隐私安全审计仍按该地址评估回环策略，因此保留读取与更新能力。
   */
  prefs: UpdatePrefs;
  updatePrefs: (patch: Partial<UpdatePrefs>) => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * App-wide update info. The unified settings card drives the GitHub native
 * channel (tauri-plugin-updater); this provider only shares the Rust-side
 * `get_app_info` snapshot and the locally persisted patch-channel source
 * consumed by the privacy audit.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appInfoError, setAppInfoError] = useState(false);
  const [prefs, setPrefs] = useState<UpdatePrefs>(loadUpdatePrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    let alive = true;
    updateApi.getAppInfo().then(
      (info) => {
        if (!alive) return;
        setAppInfo(info);
        setAppInfoError(false);
      },
      () => {
        if (!alive) return;
        setAppInfoError(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const updatePrefs = useCallback((patch: Partial<UpdatePrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    saveUpdatePrefs(next);
    setPrefs(next);
  }, []);

  const value = useMemo<UpdateContextValue>(
    () => ({ appInfo, appInfoError, prefs, updatePrefs }),
    [appInfo, appInfoError, prefs, updatePrefs],
  );

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdater(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) {
    throw new Error("useUpdater must be used inside UpdateProvider");
  }
  return value;
}
