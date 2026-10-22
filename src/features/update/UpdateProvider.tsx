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
import { toast } from "@/components/Toast";
import { translate, useI18n } from "@/i18n";
import { updateApi } from "./api";
import {
  loadUpdatePrefs,
  resolveManifestUrl,
  saveUpdatePrefs,
  type AppInfo,
  type PreviousUpdateFailure,
  type ReadyUpdate,
  type UpdateCheck,
  type UpdateError,
  type UpdateKind,
  type UpdatePhase,
  type UpdatePrefs,
  type UpdateProgress,
} from "./types";

interface CheckOptions {
  /** Startup check: report availability but not failures. */
  silent?: boolean;
  /** Startup check: media auto-download policy applies. */
  auto?: boolean;
}

interface UpdateContextValue {
  appInfo: AppInfo | null;
  appInfoError: boolean;
  prefs: UpdatePrefs;
  updatePrefs: (patch: Partial<UpdatePrefs>) => void;
  phase: UpdatePhase;
  result: UpdateCheck | null;
  progress: UpdateProgress | null;
  ready: ReadyUpdate | null;
  error: UpdateError | null;
  previousFailure: PreviousUpdateFailure | null;
  dismissPreviousFailure: () => void;
  lastCheckedAt: number | null;
  checkNow: (options?: CheckOptions) => Promise<void>;
  download: (kind: UpdateKind, options?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  cancel: () => Promise<void>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

function errorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Error && value.message) return value.message;
  return translate("common.unknown");
}

function makeRequestId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `upd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * App-wide updater state. The Rust side owns downloaded artifacts and enforces
 * HTTPS/signature/hash policy; this provider only orchestrates the UX state
 * machine and persists non-secret preferences locally.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appInfoError, setAppInfoError] = useState(false);
  const [prefs, setPrefs] = useState<UpdatePrefs>(loadUpdatePrefs);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [ready, setReady] = useState<ReadyUpdate | null>(null);
  const [error, setError] = useState<UpdateError | null>(null);
  const [previousFailure, setPreviousFailure] =
    useState<PreviousUpdateFailure | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  const prefsRef = useRef(prefs);
  const phaseRef = useRef<UpdatePhase>("idle");
  const resultRef = useRef<UpdateCheck | null>(null);
  const requestSeq = useRef(0);
  const checkingRef = useRef(false);
  const cancelRequested = useRef(false);
  const autoKeyRef = useRef("");
  const checkNowRef = useRef<
    ((options?: CheckOptions) => Promise<void>) | undefined
  >(undefined);
  const downloadRef = useRef<
    | ((
        kind: UpdateKind,
        options?: { silent?: boolean },
      ) => Promise<void>)
    | undefined
  >(undefined);

  prefsRef.current = prefs;

  const setPhaseSafe = useCallback((next: UpdatePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const applyPrefs = useCallback((patch: Partial<UpdatePrefs>) => {
    const previous = prefsRef.current;
    const sourceChanged =
      (patch.manifestUrl !== undefined &&
        patch.manifestUrl !== previous.manifestUrl) ||
      (patch.channel !== undefined && patch.channel !== previous.channel);
    const next = { ...previous, ...patch };
    prefsRef.current = next;
    saveUpdatePrefs(next);
    setPrefs(next);
    if (!sourceChanged) return;
    if (phaseRef.current === "error") {
      setError(null);
      setPhaseSafe("idle");
    } else if (
      phaseRef.current === "uptodate" ||
      phaseRef.current === "available"
    ) {
      setResult(null);
      resultRef.current = null;
      setPhaseSafe("idle");
    }
  }, [setPhaseSafe]);

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
    updateApi.getUpdateSnapshot().then(
      (snapshot) => {
        if (!alive) return;
        if (snapshot.previousAttemptFailed) {
          setPreviousFailure(snapshot.previousAttemptFailed);
        }
        if (!snapshot.ready || phaseRef.current !== "idle") return;
        setReady(snapshot.ready);
        setPhaseSafe("ready");
      },
      () => {
        /* Snapshot is optional; the user can check again. */
      },
    );
    return () => {
      alive = false;
    };
  }, [setPhaseSafe]);

  const download = useCallback(
    async (kind: UpdateKind, _options?: { silent?: boolean }) => {
      const current = resultRef.current;
      if (!current || !current.available) {
        setError({
          stage: "check",
          message: t("updates.source.empty"),
          failedKind: null,
        });
        setPhaseSafe("error");
        return;
      }
      if (
        phaseRef.current === "downloading" ||
        phaseRef.current === "verifying" ||
        phaseRef.current === "installing"
      ) {
        return;
      }
      const manifestUrl = resolveManifestUrl(prefsRef.current);
      if (!manifestUrl) {
        setError({
          stage: "check",
          message: t("updates.source.empty"),
          failedKind: null,
        });
        setPhaseSafe("error");
        return;
      }
      const seq = ++requestSeq.current;
      const requestId = makeRequestId();
      cancelRequested.current = false;
      setPreviousFailure(null);
      setError(null);
      setProgress({
        requestId,
        phase: "downloading",
        downloaded: 0,
        total: kind === "patch" ? current.patch?.size ?? 0 : current.full.size,
        percent: 0,
        bytesPerSecond: 0,
      });
      setPhaseSafe("downloading");
      let terminal = false;
      try {
        const artifact = await updateApi.downloadUpdate(
          manifestUrl,
          current.latestVersion,
          kind,
          requestId,
          (event) => {
            if (terminal || seq !== requestSeq.current) return;
            setProgress(event);
            if (event.phase === "verifying") setPhaseSafe("verifying");
          },
        );
        terminal = true;
        if (seq !== requestSeq.current) return;
        setReady(artifact);
        setProgress(null);
        setPhaseSafe("ready");
        toast(t("updates.toast.ready"));
      } catch (e) {
        terminal = true;
        if (seq !== requestSeq.current) return;
        if (cancelRequested.current) {
          cancelRequested.current = false;
          setProgress(null);
          setPhaseSafe("available");
          return;
        }
        setProgress(null);
        setError({
          stage: "download",
          message: errorMessage(e),
          failedKind: kind,
        });
        setPhaseSafe("error");
      }
    },
    [setPhaseSafe, t],
  );
  downloadRef.current = download;

  const checkNow = useCallback(
    async (options?: CheckOptions) => {
      if (checkingRef.current) return;
      if (
        phaseRef.current === "downloading" ||
        phaseRef.current === "verifying" ||
        phaseRef.current === "installing" ||
        phaseRef.current === "ready"
      ) {
        return;
      }
      const manifestUrl = resolveManifestUrl(prefsRef.current);
      if (!manifestUrl) {
        setError({
          stage: "check",
          message: t("updates.source.empty"),
          failedKind: null,
        });
        setPhaseSafe("error");
        return;
      }
      // A manual check also satisfies the startup auto-check for this source;
      // avoid a duplicate request when the auto-check timer fires.
      autoKeyRef.current = `${manifestUrl}|${prefsRef.current.channel}`;
      checkingRef.current = true;
      const seq = ++requestSeq.current;
      setError(null);
      setProgress(null);
      setPhaseSafe("checking");
      try {
        const next = await updateApi.checkUpdate(manifestUrl);
        if (seq !== requestSeq.current) return;
        resultRef.current = next;
        setResult(next);
        setLastCheckedAt(Date.now());
        if (next.available) {
          setPhaseSafe("available");
          if (options?.silent) {
            toast(t("updates.toast.available", { version: next.latestVersion }));
          }
          if (
            options?.auto &&
            prefsRef.current.autoDownload &&
            next.kind === "patch"
          ) {
            void downloadRef.current?.("patch", { silent: true });
          }
        } else {
          setPhaseSafe("uptodate");
        }
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError({
          stage: "check",
          message: errorMessage(e),
          failedKind: null,
        });
        setPhaseSafe("error");
        if (!options?.silent) {
          toast(t("updates.toast.checkFailed", { detail: errorMessage(e) }));
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [setPhaseSafe, t],
  );
  checkNowRef.current = checkNow;

  const cancel = useCallback(async () => {
    cancelRequested.current = true;
    requestSeq.current += 1;
    try {
      await updateApi.cancelUpdate();
    } catch {
      /* The download may already have finished. */
    }
    setProgress(null);
    if (resultRef.current?.available) setPhaseSafe("available");
    else setPhaseSafe("idle");
    toast(t("updates.toast.cancelled"));
  }, [setPhaseSafe, t]);

  const install = useCallback(async () => {
    if (!ready) return;
    setError(null);
    setPhaseSafe("installing");
    try {
      await updateApi.installUpdate();
      toast(t("updates.toast.install"));
    } catch (e) {
      setError({
        stage: "install",
        message: errorMessage(e),
        failedKind: ready.kind,
      });
      setPhaseSafe("error");
    }
  }, [ready, setPhaseSafe, t]);

  // Startup auto-check. The key is only recorded when the timer actually fires
  // so React StrictMode's mount/unmount probe cannot swallow the check.
  useEffect(() => {
    if (!prefs.autoCheck) return;
    const manifestUrl = resolveManifestUrl(prefs);
    if (!manifestUrl) return;
    const key = `${manifestUrl}|${prefs.channel}`;
    const timer = window.setTimeout(() => {
      if (autoKeyRef.current === key) return;
      autoKeyRef.current = key;
      void checkNowRef.current?.({ silent: true, auto: true });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [prefs.autoCheck, prefs.manifestUrl, prefs.channel]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      appInfo,
      appInfoError,
      prefs,
      updatePrefs: applyPrefs,
      phase,
      result,
      progress,
      ready,
      error,
      previousFailure,
      dismissPreviousFailure: () => setPreviousFailure(null),
      lastCheckedAt,
      checkNow,
      download,
      install,
      cancel,
    }),
    [
      appInfo,
      appInfoError,
      applyPrefs,
      cancel,
      checkNow,
      download,
      error,
      install,
      lastCheckedAt,
      phase,
      prefs,
      previousFailure,
      progress,
      ready,
      result,
    ],
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
