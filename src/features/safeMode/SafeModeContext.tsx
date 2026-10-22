import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/i18n";
import {
  getSafeModeState,
  exitSafeMode as callExitSafeMode,
  type SafeModeState,
} from "./api";
import { updateRuntimeContext } from "@/features/resilience/context";

interface SafeModeContextValue {
  active: boolean;
  ready: boolean;
  state: SafeModeState;
  refresh: () => Promise<void>;
  leaveSafeMode: () => Promise<void>;
}

const INACTIVE: SafeModeState = { active: false, reason: null, activatedAt: null };

const SafeModeContext = createContext<SafeModeContextValue | null>(null);

export function SafeModeProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<SafeModeState>(INACTIVE);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getSafeModeState();
      setState(next);
    } catch {
      // A diagnostics window or a dev browser may not expose the command.
      // Start normal mode; backend online guards still fail closed.
      setState(INACTIVE);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void getSafeModeState().then(
      (next) => {
        if (alive) {
          setState(next);
          setReady(true);
        }
      },
      () => {
        if (alive) {
          setState(INACTIVE);
          setReady(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    root.dataset.safeMode = state.active ? "true" : "false";
    updateRuntimeContext({ safeMode: state.active });
    return () => {
      delete root.dataset.safeMode;
    };
  }, [ready, state.active]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const leaveSafeMode = useCallback(async () => {
    const next = await callExitSafeMode();
    setState(next);
    updateRuntimeContext({ safeMode: false });
    window.location.reload();
  }, []);

  const value = useMemo<SafeModeContextValue>(
    () => ({
      active: state.active,
      ready,
      state,
      refresh,
      leaveSafeMode,
    }),
    [leaveSafeMode, ready, refresh, state],
  );

  if (!ready) {
    return (
      <div
        className="grid h-screen w-full place-items-center bg-background text-sm text-muted-foreground"
        aria-busy="true"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-hard-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("common.loading")}
        </span>
      </div>
    );
  }

  return (
    <SafeModeContext.Provider value={value}>
      {children}
    </SafeModeContext.Provider>
  );
}

export function useSafeMode(): SafeModeContextValue {
  const value = useContext(SafeModeContext);
  if (!value) throw new Error("useSafeMode must be used inside SafeModeProvider");
  return value;
}
