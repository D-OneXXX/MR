import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { updateApi } from "./api";
import { type AppInfo } from "./types";

interface UpdateContextValue {
  appInfo: AppInfo | null;
  appInfoError: boolean;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * App-wide update info. The unified settings card drives the GitHub native
 * channel (tauri-plugin-updater); this provider only shares the Rust-side
 * `get_app_info` snapshot. The retired custom patch channel no longer keeps
 * any local preference — its endpoint is baked into the build config.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appInfoError, setAppInfoError] = useState(false);

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

  const value = useMemo<UpdateContextValue>(
    () => ({ appInfo, appInfoError }),
    [appInfo, appInfoError],
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
