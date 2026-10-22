import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileArchive,
  Loader2,
  PackageOpen,
  Power,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  SettingRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { useI18n, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { useUpdater } from "@/features/update/UpdateProvider";
import {
  isUpdateChannel,
  type UpdateChannel,
  type UpdateKind,
} from "@/features/update/types";

function formatBytes(
  bytes: number,
  locale: string,
  fallback: string,
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return fallback;
  const mb = bytes / 1048576;
  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: mb >= 10 ? 1 : 2,
  });
  if (mb >= 1) return `${formatter.format(mb)} MB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
    Math.max(1, bytes / 1024),
  )} KB`;
}

function formatSpeed(bytesPerSecond: number, locale: string): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return `0 KB`;
  }
  const mb = bytesPerSecond / 1048576;
  if (mb >= 1) {
    return `${new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
    }).format(mb)} MB`;
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(bytesPerSecond / 1024)} KB`;
}

function fallbackKey(reason: string): MessageKey | null {
  switch (reason) {
    case "no-patch":
      return "updates.fallback.no-patch";
    case "version-mismatch":
      return "updates.fallback.version-mismatch";
    case "major-upgrade":
      return "updates.fallback.major-upgrade";
    case "multi-minor":
      return "updates.fallback.multi-minor";
    case "patch-available":
      return "updates.fallback.patch-available";
    default:
      return null;
  }
}

function InfoTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-background/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 break-words font-mono text-sm font-semibold leading-snug">
        {children}
      </div>
    </div>
  );
}

/**
 * Settings → Updates. Preferences are device-local and save immediately;
 * downloaded artifacts and signature/hash checks are owned by the Rust side.
 */
export default function UpdatesPanel() {
  const { t, locale, formatDateTime } = useI18n();
  const {
    appInfo,
    appInfoError,
    prefs,
    updatePrefs,
    phase,
    result,
    progress,
    ready,
    error,
    previousFailure,
    dismissPreviousFailure,
    lastCheckedAt,
    checkNow,
    download,
    install,
    cancel,
  } = useUpdater();
  const [manifestUrl, setManifestUrl] = useState(prefs.manifestUrl);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setManifestUrl(prefs.manifestUrl);
  }, [prefs.manifestUrl]);

  const channelItems: { value: UpdateChannel; label: string }[] = [
    { value: "stable", label: t("updates.channel.stable") },
    { value: "beta", label: t("updates.channel.beta") },
  ];

  const busy =
    phase === "checking" ||
    phase === "downloading" ||
    phase === "verifying" ||
    phase === "installing" ||
    phase === "ready";
  const sizeFallback = t("updates.sizeUnknown");
  const selectedKind: UpdateKind | null = ready?.kind ?? result?.kind ?? null;
  const kindLabel =
    selectedKind === "patch"
      ? t("updates.type.patch")
      : t("updates.type.full");
  const progressPercent = Math.min(
    100,
    Math.max(0, Math.round(progress?.percent ?? 0)),
  );
  const progressTotal = progress?.total ?? 0;
  const progressDownloaded = progress?.downloaded ?? 0;
  const fallback = result ? fallbackKey(result.fallbackReason) : null;

  const commitUrl = () => {
    const next = manifestUrl.trim();
    if (next !== prefs.manifestUrl) updatePrefs({ manifestUrl: next });
  };

  const onInstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await install();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={PackageOpen}
        title={t("updates.title")}
        description={t("updates.description")}
        action={
          <Button
            type="button"
            variant="pill-primary"
            size="pill"
            className="whitespace-nowrap"
            disabled={busy || manifestUrl.trim().length === 0}
            onClick={() => {
              commitUrl();
              void checkNow();
            }}
          >
            {phase === "checking" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {phase === "checking"
              ? t("updates.checking")
              : t("updates.check")}
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <InfoTile label={t("updates.version.current")}>
            v{appInfo?.version ?? "—"}
          </InfoTile>
          <InfoTile label={t("updates.version.baseline")}>
            {appInfo?.buildBaseline ?? "—"}
          </InfoTile>
          <InfoTile label={t("updates.version.target")}>
            {appInfo?.target ?? "—"}
          </InfoTile>
          <InfoTile label={t("updates.version.signature")}>
            {!appInfo ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  appInfo.signatureConfigured
                    ? "text-success"
                    : "text-warning",
                )}
              >
                <ShieldCheck className="size-3.5 shrink-0" />
                {appInfo.signatureConfigured
                  ? t("updates.securityConfigured")
                  : t("updates.securityMissing")}
              </span>
            )}
          </InfoTile>
        </div>

        {appInfoError ? (
          <p className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("updates.error.config")}
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="update-channel">{t("updates.version.channel")}</Label>
            <Select
              items={channelItems}
              value={prefs.channel}
              disabled={busy}
              onValueChange={(value) => {
                if (isUpdateChannel(value)) updatePrefs({ channel: value });
              }}
            >
              <SelectTrigger
                id="update-channel"
                aria-label={t("updates.version.channel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("updates.channel.hint")}
            </p>
          </div>

          <div className="min-w-0 space-y-2">
            <Label htmlFor="update-manifest">{t("updates.source.label")}</Label>
            <Input
              id="update-manifest"
              value={manifestUrl}
              onChange={(event) => setManifestUrl(event.currentTarget.value)}
              onBlur={commitUrl}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitUrl();
                }
              }}
              placeholder={t("updates.source.placeholder")}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("updates.source.hint")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <span
            className={cn(
              "inline-flex items-center gap-2 text-xs font-medium",
              phase === "error"
                ? "text-destructive"
                : phase === "uptodate"
                  ? "text-success"
                  : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                phase === "checking" ||
                phase === "downloading" ||
                phase === "verifying" ||
                phase === "installing"
                  ? "animate-pulse bg-primary"
                  : phase === "error"
                    ? "bg-destructive"
                    : phase === "uptodate" || phase === "ready"
                      ? "bg-success"
                      : "bg-muted-foreground",
              )}
              aria-hidden
            />
            {phase === "checking"
              ? t("updates.checking")
              : phase === "downloading"
                ? t("updates.downloading", { kind: kindLabel })
                : phase === "verifying"
                  ? t("updates.verifying")
                  : phase === "uptodate"
                    ? t("updates.upToDate")
                    : phase === "available"
                      ? t("updates.available", {
                          version: result?.latestVersion ?? "",
                        })
                      : phase === "ready"
                        ? t("updates.ready")
                        : phase === "installing"
                          ? t("updates.installing")
                          : phase === "error"
                            ? t("updates.error.title")
                            : t("updates.status.idle")}
            {lastCheckedAt && !busy ? (
              <span className="font-normal text-muted-foreground">
                ·{" "}
                {t("updates.lastChecked", {
                  time: formatDateTime(lastCheckedAt, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            ) : null}
          </span>
          {phase === "ready" && ready ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {kindLabel} · v{ready.version}
            </span>
          ) : null}
        </div>
      </SettingsSection>

      {phase === "uptodate" && result ? (
        <SettingsSection
          icon={CheckCircle2}
          title={t("updates.upToDate")}
          description={t("updates.upToDateDetail", {
            version: result.currentVersion,
          })}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="success">v{result.currentVersion}</Badge>
            {result.releasedAt ? (
              <span>
                {t("updates.releasedAt", {
                  date: formatDateTime(result.releasedAt, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  }),
                })}
              </span>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}

      {phase === "available" && result ? (
        <SettingsSection
          icon={Download}
          title={t("updates.available", {
            version: result.latestVersion,
          })}
          description={t("updates.availableDetail")}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {result.kind === "patch" ? (
                <Badge variant="secondary">
                  <FileArchive className="size-3" />
                  {t("updates.patchSize", {
                    size: formatBytes(
                      result.patch?.size ?? 0,
                      locale,
                      sizeFallback,
                    ),
                  })}
                </Badge>
              ) : (
                <Badge variant="secondary">
                  {t("updates.fullSize", {
                    size: formatBytes(result.full.size, locale, sizeFallback),
                  })}
                </Badge>
              )}
              {result.mandatory ? (
                <Badge variant="warning">{t("updates.mandatory")}</Badge>
              ) : null}
            </div>
          }
        >
          {result.notes.trim() ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-foreground">
                {t("updates.notes.title")}
              </p>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-background/60 p-4 text-sm leading-relaxed text-muted-foreground">
                {result.notes}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("updates.notes.empty")}
            </p>
          )}

          {fallback && result.kind === "full" ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>
                <span className="font-semibold text-foreground">
                  {t("updates.fallback.title")} ·{" "}
                </span>
                {t(fallback)}
              </span>
            </div>
          ) : null}
          {result.kind === "patch" && result.patch ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-mono text-[11px]">
                {t("updates.patchBaseline", {
                  version: result.currentVersion,
                })}
              </span>
              {fallback ? <span> · {t(fallback)}</span> : null}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="pill-primary"
              size="pill"
              className="whitespace-nowrap"
              onClick={() => void download(result.kind ?? "full")}
            >
              <Download />
              {result.kind === "patch"
                ? t("updates.downloadPatch")
                : t("updates.downloadFull")}
            </Button>
            {result.kind === "patch" ? (
              <Button
                type="button"
                variant="pill"
                size="pill"
                className="whitespace-nowrap"
                onClick={() => void download("full")}
              >
                {t("updates.switchFull")}
              </Button>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {t("updates.downloadingHint")}
            </span>
          </div>
        </SettingsSection>
      ) : null}

      {phase === "downloading" || phase === "verifying" ? (
        <SettingsSection
          icon={Download}
          title={
            phase === "verifying"
              ? t("updates.verifying")
              : t("updates.downloading", { kind: kindLabel })
          }
          description={
            phase === "verifying"
              ? t("updates.verifyingHint")
              : t("updates.downloadingHint")
          }
          action={
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="whitespace-nowrap"
              onClick={() => void cancel()}
            >
              {t("updates.cancel")}
            </Button>
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">
                {phase === "verifying"
                  ? t("updates.verifyingHint")
                  : t("updates.downloadBytes", {
                      done: formatBytes(progressDownloaded, locale, "0 KB"),
                      total: formatBytes(progressTotal, locale, sizeFallback),
                    })}
              </span>
              <span className="font-mono tabular-nums">
                {phase === "verifying"
                  ? t("updates.verifying")
                  : `${t("updates.downloadProgress", {
                      percent: String(progressPercent),
                    })} · ${t("updates.downloadSpeed", {
                      speed: formatSpeed(
                        progress?.bytesPerSecond ?? 0,
                        locale,
                      ),
                    })}`}
              </span>
            </div>
            <Progress
              value={phase === "verifying" ? 100 : progressPercent}
              aria-label={t("updates.progressLabel")}
              className="gap-2"
            />
          </div>
        </SettingsSection>
      ) : null}

      {(phase === "ready" || phase === "installing") && ready ? (
        <SettingsSection
          icon={CheckCircle2}
          title={t("updates.ready")}
          description={t("updates.readyDetail", {
            kind: kindLabel,
            version: ready.version,
          })}
          action={<Badge variant="success">SHA-256</Badge>}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="pill-primary"
              size="pill"
              className="whitespace-nowrap"
              disabled={installing || phase === "installing"}
              onClick={() => void onInstall()}
            >
              {installing || phase === "installing" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Power />
              )}
              {installing || phase === "installing"
                ? t("updates.installing")
                : t("updates.install")}
            </Button>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {t("updates.installHint")}
            </span>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
            {ready.format.toUpperCase()} ·{" "}
            {formatBytes(ready.size, locale, sizeFallback)} ·{" "}
            {ready.sha256.slice(0, 16)}…
          </p>
        </SettingsSection>
      ) : null}

      {phase === "error" && error ? (
        <SettingsSection
          icon={AlertTriangle}
          title={t("updates.error.title")}
          description={
            error.stage === "install"
              ? t("updates.error.install")
              : error.stage === "check"
                ? t("updates.error.config")
                : t("updates.error.network")
          }
          className="border-destructive/60"
        >
          <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive break-words">
            {t("updates.error.detail", { detail: error.message })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {error.stage === "install" && ready ? (
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={installing}
                onClick={() => void onInstall()}
              >
                {installing ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCcw />
                )}
                {installing ? t("updates.installing") : t("updates.install")}
              </Button>
            ) : null}
            {error.failedKind === "patch" && error.stage !== "install" ? (
              <Button
                type="button"
                variant="pill"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={() => void download("patch")}
              >
                <RotateCcw />
                {t("updates.retryPatch")}
              </Button>
            ) : null}
            {error.failedKind === "patch" && result?.available ? (
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={() => void download("full")}
              >
                <ArrowRight />
                {t("updates.switchFull")}
              </Button>
            ) : null}
            {error.failedKind === "full" ? (
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={() => void download("full")}
              >
                <RotateCcw />
                {t("updates.retry")}
              </Button>
            ) : null}
            {error.stage === "check" ? (
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={manifestUrl.trim().length === 0}
                onClick={() => {
                  commitUrl();
                  void checkNow();
                }}
              >
                <RefreshCw />
                {t("updates.check")}
              </Button>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}

      {previousFailure ? (
        <SettingsSection
          icon={AlertTriangle}
          title={t("updates.previousFailed.title")}
          description={t("updates.previousFailed.body", {
            version: previousFailure.version,
            current: appInfo?.version ?? "—",
          })}
          className="border-warning/60"
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={busy}
                onClick={() => void checkNow()}
              >
                <RefreshCw />
                {t("updates.previousFailed.check")}
              </Button>
              <Button
                type="button"
                variant="pill-ghost"
                size="pill-sm"
                className="whitespace-nowrap"
                onClick={dismissPreviousFailure}
              >
                {t("updates.previousFailed.dismiss")}
              </Button>
            </div>
          }
        >
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("updates.error.network")}
          </p>
        </SettingsSection>
      ) : null}

      <SettingsSection
        icon={RefreshCw}
        title={t("updates.auto.title")}
        description={t("updates.source.hint")}
      >
        <SettingRow
          title={t("updates.auto.check")}
          description={t("updates.auto.checkHint")}
          badge={
            <Badge variant={prefs.autoCheck ? "success" : "muted"}>
              {prefs.autoCheck ? t("privacy.audit.enabled") : t("privacy.audit.disabled")}
            </Badge>
          }
        >
          <Switch
            aria-label={t("updates.auto.check")}
            checked={prefs.autoCheck}
            onCheckedChange={(checked) => updatePrefs({ autoCheck: checked })}
          />
        </SettingRow>
        <SettingRow
          title={t("updates.auto.download")}
          description={t("updates.auto.downloadHint")}
          badge={
            <Badge variant={prefs.autoDownload ? "success" : "muted"}>
              {prefs.autoDownload
                ? t("privacy.audit.enabled")
                : t("privacy.audit.disabled")}
            </Badge>
          }
        >
          <Switch
            aria-label={t("updates.auto.download")}
            checked={prefs.autoDownload}
            onCheckedChange={(checked) =>
              updatePrefs({ autoDownload: checked })
            }
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        icon={ShieldCheck}
        title={t("updates.security.title")}
        description={t("updates.security.note")}
      >
        <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
            {t("updates.security.sha")}
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
            {t("updates.security.https")}
          </li>
          <li className="flex items-start gap-2">
            {!appInfo ? (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            ) : appInfo.signatureConfigured ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            )}
            {!appInfo
              ? t("privacy.status.unknown")
              : appInfo.signatureConfigured
                ? t("updates.security.signatureOn")
                : t("updates.security.signatureOff")}
          </li>
        </ul>
      </SettingsSection>
    </div>
  );
}
