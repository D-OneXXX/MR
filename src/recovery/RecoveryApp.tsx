import { useEffect, useState } from "react";
import {
  ArrowRight,
  CircleAlert,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import DiagnosticPanel from "@/components/diagnostics/DiagnosticPanel";
import { useI18n, type MessageKey } from "@/i18n";
import {
  closeRecoveryWindow,
  getRecoveryContext,
  reloadMainView,
} from "@/features/resilience/api";
import type { RecoveryContext } from "@/features/resilience/types";
import { recordBreadcrumb } from "@/features/resilience";
import { enterSafeMode } from "@/features/safeMode/api";

type ActionKind = "continue" | "reload" | "safe" | null;

function reasonCopy(trigger: RecoveryContext["trigger"]): {
  title: MessageKey;
  body: MessageKey;
} {
  switch (trigger) {
    case "rageClick":
      return {
        title: "recovery.reason.rageTitle",
        body: "recovery.reason.rageBody",
      };
    case "startupFailures":
      return {
        title: "recovery.reason.startupTitle",
        body: "recovery.reason.startupBody",
      };
    default:
      return {
        title: "recovery.reason.heartbeatTitle",
        body: "recovery.reason.heartbeatBody",
      };
  }
}

function errorText(error: unknown): string {
  return typeof error === "string" && error ? error : String(error);
}

export default function RecoveryApp() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const [context, setContext] = useState<RecoveryContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ActionKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [continued, setContinued] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getRecoveryContext().then(
        (next) => {
          if (!alive) return;
          setContext(next);
          setLoadError(null);
        },
        (error) => {
          if (alive) setLoadError(errorText(error));
        },
      );
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [retryTick]);

  const close = async () => {
    try {
      await closeRecoveryWindow();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const continueWaiting = () => {
    setContinued(true);
    recordBreadcrumb("recovery");
    setNotice(t("recovery.action.continued"));
    setActionError(null);
  };

  const reload = async () => {
    setBusy("reload");
    recordBreadcrumb("recovery");
    setActionError(null);
    setNotice(null);
    try {
      await reloadMainView();
      setReloaded(true);
      setNotice(t("recovery.action.reloaded"));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const startSafeMode = async () => {
    setBusy("safe");
    recordBreadcrumb("safeMode");
    setActionError(null);
    setNotice(null);
    try {
      const next = await enterSafeMode("userRecovery");
      setContext((current) =>
        current ? { ...current, safeMode: next } : current,
      );
      setNotice(t("recovery.action.safeEntered"));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const copy = context ? reasonCopy(context.trigger) : null;
  const safeActive = context?.safeMode.active === true;
  const responsive = context?.responsive === true;
  const heartbeatSeconds = context
    ? Math.max(0, Math.floor(context.heartbeatAgeMs / 1000))
    : 0;
  const triggerDetail = context
    ? context.trigger === "startupFailures"
      ? t("recovery.reason.detailStartup", {
          count: formatNumber(Number(context.detail) || 0),
        })
      : context.trigger === "rageClick"
        ? t("recovery.reason.detailClicks", { detail: context.detail })
        : null
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="relative flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4"
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <div className="relative z-10 flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-border bg-primary text-primary-foreground shadow-hard-sm">
            <ShieldCheck className="size-4" aria-hidden />
          </span>
          <span className="truncate text-sm font-extrabold tracking-tight">
            {t("recovery.windowTitle")}
          </span>
        </div>
        <div className="relative z-10 ml-auto flex items-center gap-1.5">
          <Badge variant={safeActive ? "warning" : "muted"}>
            {safeActive ? t("safeMode.badgeActive") : t("recovery.eyebrow")}
          </Badge>
          <Button
            variant="pill-ghost"
            size="pill-icon-sm"
            onClick={() => void close()}
            aria-label={t("recovery.close")}
            title={t("recovery.close")}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3.5">
          {loadError && !context ? (
            <Card className="items-start gap-3 p-4">
              <div className="flex items-start gap-2.5">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="break-words text-xs text-muted-foreground">
                  {t("recovery.action.failed", { detail: loadError })}
                </p>
              </div>
              <Button
                variant="pill"
                size="pill-sm"
                onClick={() => setRetryTick((value) => value + 1)}
              >
                <RefreshCw />
                {t("common.retry")}
              </Button>
            </Card>
          ) : null}

          {context && copy ? (
            <>
              <Card className="gap-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {t("recovery.eyebrow")}
                    </p>
                    <h1 className="mt-1 text-2xl font-extrabold tracking-tight">
                      {t(copy.title)}
                    </h1>
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-bold shadow-hard-sm"
                    aria-live="polite"
                  >
                    <span
                      aria-hidden
                      className={
                        responsive
                          ? "size-1.5 animate-pulse rounded-full bg-success"
                          : "size-1.5 rounded-full bg-warning"
                      }
                    />
                    {responsive
                      ? t("recovery.status.respondingTitle")
                      : t("recovery.status.waitingTitle")}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(copy.body)}
                </p>
                {triggerDetail ? (
                  <p className="rounded-xl border border-border/60 bg-secondary/60 px-3 py-2 text-[11px] font-semibold">
                    {triggerDetail}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-muted-foreground">
                  <span>
                    {t("recovery.detectedAt", {
                      time: formatDateTime(context.detectedAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      }),
                    })}
                  </span>
                  <span>
                    {t("recovery.status.heartbeatAge", {
                      seconds: formatNumber(heartbeatSeconds),
                    })}
                  </span>
                  {context.lastRoute ? (
                    <span className="mono break-all">
                      {t("recovery.reason.lastRoute", {
                        route: context.lastRoute,
                      })}
                    </span>
                  ) : null}
                </div>
                <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                  {responsive
                    ? t("recovery.status.respondingBody")
                    : t("recovery.status.waitingBody")}
                </p>
              </Card>

              <div className="grid gap-2 min-[560px]:grid-cols-3">
                <Card className="gap-2 p-3">
                  <p className="text-xs font-extrabold">
                    {t("recovery.actions.continueTitle")}
                  </p>
                  <p className="min-h-8 text-[10.5px] leading-relaxed text-muted-foreground">
                    {t("recovery.actions.continueBody")}
                  </p>
                  <Button
                    variant="pill"
                    size="pill-sm"
                    className="w-full"
                    onClick={continueWaiting}
                    disabled={busy !== null}
                  >
                    {continued ? (
                      t("recovery.action.continued")
                    ) : (
                      t("recovery.actions.continueTitle")
                    )}
                  </Button>
                </Card>
                <Card className="gap-2 p-3">
                  <p className="text-xs font-extrabold">
                    {t("recovery.actions.reloadTitle")}
                  </p>
                  <p className="min-h-8 text-[10.5px] leading-relaxed text-muted-foreground">
                    {t("recovery.actions.reloadBody")}
                  </p>
                  <Button
                    variant="pill-primary"
                    size="pill-sm"
                    className="w-full"
                    onClick={() => void reload()}
                    disabled={busy !== null}
                  >
                    {busy === "reload" || reloaded ? (
                      busy === "reload" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )
                    ) : (
                      <ArrowRight className="size-3.5" />
                    )}
                    {busy === "reload"
                      ? t("recovery.action.working")
                      : t("recovery.actions.reloadTitle")}
                  </Button>
                </Card>
                <Card className="gap-2 border-primary/60 p-3">
                  <p className="text-xs font-extrabold">
                    {t("recovery.actions.safeTitle")}
                  </p>
                  <p className="min-h-8 text-[10.5px] leading-relaxed text-muted-foreground">
                    {t("recovery.actions.safeBody")}
                  </p>
                  <Button
                    variant="pill-primary"
                    size="pill-sm"
                    className="w-full bg-warning! text-background!"
                    onClick={() => void startSafeMode()}
                    disabled={busy !== null || safeActive}
                  >
                    {busy === "safe" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-3.5" />
                    )}
                    {safeActive
                      ? t("recovery.action.safeActive")
                      : busy === "safe"
                        ? t("recovery.action.working")
                        : t("recovery.actions.safeTitle")}
                  </Button>
                </Card>
              </div>

              {safeActive ? (
                <div className="rounded-2xl border border-border bg-secondary/70 px-3 py-2 text-[11px] font-semibold">
                  {t("recovery.action.safeActive")}
                </div>
              ) : null}

              {notice || actionError ? (
                <div
                  role="status"
                  aria-live="polite"
                  className={
                    actionError
                      ? "rounded-2xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] font-semibold text-destructive"
                      : "rounded-2xl border border-success/35 bg-success/10 px-3 py-2 text-[11px] font-semibold text-success"
                  }
                >
                  {actionError
                    ? t("recovery.action.failed", { detail: actionError })
                    : notice}
                </div>
              ) : null}

              <div className="rounded-2xl border border-border bg-card/80 p-3">
                <p className="text-xs font-extrabold">
                  {t("recovery.safetyTitle")}
                </p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t("recovery.safetyBody")}
                </p>
              </div>
            </>
          ) : !loadError ? (
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : null}

          <Card className="p-4 sm:p-5">
            <div className="mb-3">
              <p className="text-sm font-extrabold">
                {t("recovery.diagnosticsTitle")}
              </p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                {t("recovery.diagnosticsBody")}
              </p>
            </div>
            <DiagnosticPanel compact />
          </Card>

          {notice && !context ? (
            <p className="text-xs text-success">{notice}</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
