import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  PackageOpen,
  Power,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { toast } from "@/components/Toast";
import { useI18n } from "@/i18n";
import { isLinuxPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useUpdater } from "@/features/update/UpdateProvider";
import {
  checkNativeUpdate,
  closeNativeUpdate,
  getTempFreeBytes,
  installNativeUpdate,
  isWindowsPlatform,
  relaunchApp,
  reportNativeUpdateFailure,
  type NativeInstallEvent,
  type NativeUpdateCheck,
  type NativeUpdateInfo,
} from "@/features/update/native";

type NativePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

type NativeFailure = "check" | "install" | "relaunch";

const RELEASE_DOWNLOAD_URL = "https://github.com/D-OneXXX/MR/releases/latest";
const RELEASE_NOTES_URL =
  "https://github.com/D-OneXXX/MR/blob/main/docs/RELEASE.md";

interface NativeDownloadState {
  downloaded: number;
  total: number | null;
  percent: number | null;
}

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
 * Settings → 关于与维护 · 唯一的「软件更新」卡片。
 *
 * 端点在构建配置中锁死（Windows: GitHub Releases latest.json，
 * Linux: latest-linux-critical.json），不向用户暴露清单地址输入框；
 * 下载与安装全部由用户手动触发，签名状态徽章读取
 * `tauri.conf.json plugins.updater.pubkey` 的配置结果。
 */
export default function UpdatesPanel() {
  const { t, locale, formatDateTime } = useI18n();
  const { appInfo } = useUpdater();
  const [nativePhase, setNativePhase] = useState<NativePhase>("idle");
  const [nativeInfo, setNativeInfo] = useState<NativeUpdateInfo | null>(null);
  const [nativeDownload, setNativeDownload] =
    useState<NativeDownloadState | null>(null);
  const [nativeFailure, setNativeFailure] = useState<NativeFailure | null>(
    null,
  );
  const [nativeUpToDate, setNativeUpToDate] = useState(false);
  const [nativeRelaunching, setNativeRelaunching] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const nativePhaseRef = useRef<NativePhase>("idle");
  const nativeCheckRef = useRef<NativeUpdateCheck | null>(null);
  const nativeBusyRef = useRef(false);

  const setNativePhaseSafe = (next: NativePhase) => {
    nativePhaseRef.current = next;
    setNativePhase(next);
  };

  // The Update handle owns a Rust-side resource: release it on unmount unless a
  // download/install is still in flight.
  useEffect(() => {
    return () => {
      const phase = nativePhaseRef.current;
      if (phase === "downloading" || phase === "installing") return;
      const held = nativeCheckRef.current;
      nativeCheckRef.current = null;
      if (held) void closeNativeUpdate(held.update);
    };
  }, []);

  const handleNativeCheck = async () => {
    if (nativeBusyRef.current) return;
    nativeBusyRef.current = true;
    setNativeFailure(null);
    setNativeUpToDate(false);
    setNativeInfo(null);
    setNativeDownload(null);
    setNativePhaseSafe("checking");
    const previous = nativeCheckRef.current;
    nativeCheckRef.current = null;
    await closeNativeUpdate(previous?.update);
    try {
      const next = await checkNativeUpdate();
      if (!next) {
        setNativeUpToDate(true);
        setNativePhaseSafe("idle");
        return;
      }
      nativeCheckRef.current = next;
      setNativeInfo(next.info);
      setNativePhaseSafe("available");
    } catch (reason) {
      reportNativeUpdateFailure("check", reason);
      setNativeFailure("check");
      setNativePhaseSafe("error");
    } finally {
      setLastCheckedAt(Date.now());
      nativeBusyRef.current = false;
    }
  };

  const handleNativeInstall = async () => {
    const held = nativeCheckRef.current;
    if (!held || nativeBusyRef.current) return;
    // Linux deb/rpm 系统安装不得由应用替换 /usr 下的包文件。
    if (isLinuxPlatform() && appInfo?.linuxInstall !== "appimage") {
      toast(t("updates.linux.manualBlocked"));
      return;
    }
    // 下载前预检临时目录空间，避免底层直接抛 os error 112。
    nativeBusyRef.current = true;
    const freeBytes = await getTempFreeBytes().catch(() => null);
    if (freeBytes !== null && freeBytes < 256 * 1024 * 1024) {
      nativeBusyRef.current = false;
      toast(t("updates.disk.full"));
      return;
    }
    setNativeFailure(null);
    setNativeDownload({ downloaded: 0, total: null, percent: null });
    setNativePhaseSafe("downloading");
    const onProgress = (event: NativeInstallEvent) => {
      if (event.phase === "installing") {
        setNativePhaseSafe("installing");
        return;
      }
      setNativeDownload({
        downloaded: event.downloaded,
        total: event.total,
        percent: event.percent,
      });
    };
    try {
      await installNativeUpdate(held.update, onProgress);
      nativeCheckRef.current = null;
      setNativeDownload(null);
      setNativePhaseSafe("installed");
    } catch (reason) {
      reportNativeUpdateFailure("install", reason);
      setNativeFailure("install");
      setNativePhaseSafe("error");
    } finally {
      nativeBusyRef.current = false;
    }
  };

  const handleNativeRelaunch = async () => {
    if (nativeRelaunching) return;
    setNativeRelaunching(true);
    try {
      await relaunchApp();
    } catch (reason) {
      reportNativeUpdateFailure("relaunch", reason);
      setNativeFailure("relaunch");
      setNativePhaseSafe("error");
    } finally {
      setNativeRelaunching(false);
    }
  };

  const nativeBusy =
    nativePhase === "checking" ||
    nativePhase === "downloading" ||
    nativePhase === "installing";
  const nativeCurrentVersion =
    nativeInfo?.currentVersion ?? appInfo?.version ?? null;
  const nativeReleaseDate = nativeInfo?.date ? new Date(nativeInfo.date) : null;
  const nativeDateText =
    nativeReleaseDate && !Number.isNaN(nativeReleaseDate.getTime())
      ? formatDateTime(nativeReleaseDate, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
  const nativeNotes = nativeInfo?.body?.trim() ?? "";
  const nativeNeedsRelaunch = !isWindowsPlatform();

  const isLinux = isLinuxPlatform();
  const linuxManualInstall =
    isLinux && appInfo?.linuxInstall !== "appimage";

  const openExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      toast(t("updates.linux.openFailed"));
    }
  };

  const nativeStatus =
    nativePhase === "checking"
      ? t("updates.checking")
      : nativePhase === "available" && nativeInfo
        ? t("updates.available", { version: nativeInfo.version })
        : nativePhase === "downloading"
          ? t("updates.native.downloading")
          : nativePhase === "installing"
            ? t("updates.native.preparing")
            : nativePhase === "installed"
              ? t("updates.native.installed")
              : nativePhase === "error"
                ? t("updates.error.title")
                : nativeUpToDate
                  ? t("updates.upToDate")
                  : t("updates.native.statusIdle");

  // 签名徽章的唯一事实源：get_app_info 汇总 tauri.conf.json 的
  // plugins.updater.pubkey 与构建期 MR_UPDATE_PUBKEY。
  const signatureKnown = appInfo !== null;
  const signatureConfigured = appInfo?.signatureConfigured === true;

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
            id="update-check"
            className="whitespace-nowrap"
            disabled={nativeBusy || nativeRelaunching}
            onClick={() => void handleNativeCheck()}
          >
            {nativePhase === "checking" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {nativePhase === "checking"
              ? t("updates.checking")
              : t("updates.check")}
          </Button>
        }
      >
        {isLinux ? (
          <div className="flex items-start gap-2 rounded-2xl border border-border bg-background/60 p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("updates.native.linuxCriticalChannel")}
            </p>
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <InfoTile label={t("updates.version.current")}>
            {nativeCurrentVersion ? `v${nativeCurrentVersion}` : "—"}
          </InfoTile>
          <InfoTile label={t("updates.native.availableVersion")}>
            {nativeInfo ? `v${nativeInfo.version}` : "—"}
          </InfoTile>
          <InfoTile label={t("updates.version.baseline")}>
            {appInfo?.buildBaseline ?? "—"}
          </InfoTile>
          <InfoTile label={t("updates.version.target")}>
            {appInfo?.target ?? "—"}
          </InfoTile>
        </div>

        {nativeUpToDate && nativePhase === "idle" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("updates.native.upToDateDetail", {
              version: nativeCurrentVersion ?? "—",
            })}
          </p>
        ) : null}

        {nativeDateText && nativeInfo ? (
          <p className="text-xs text-muted-foreground">
            {t("updates.releasedAt", { date: nativeDateText })}
          </p>
        ) : null}

        {nativeNotes && nativeInfo ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-foreground">
              {t("updates.native.notes")}
            </p>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-background/60 p-4 text-sm leading-relaxed text-muted-foreground">
              {nativeNotes}
            </div>
          </div>
        ) : null}

        {nativePhase === "available" ? (
          linuxManualInstall ? (
            <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground">
                    {t("updates.linux.manualTitle")}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t("updates.linux.manualHint")}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="pill-primary"
                  size="pill-sm"
                  className="whitespace-nowrap"
                  onClick={() => void openExternal(RELEASE_DOWNLOAD_URL)}
                >
                  <Download />
                  {t("updates.linux.download")}
                </Button>
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  className="whitespace-nowrap"
                  onClick={() => void openExternal(RELEASE_NOTES_URL)}
                >
                  <ExternalLink />
                  {t("updates.linux.notes")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="pill-primary"
                size="pill"
                className="whitespace-nowrap"
                disabled={nativeBusy}
                onClick={() => void handleNativeInstall()}
              >
                <Download />
                {t("updates.native.downloadInstall")}
              </Button>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                {t("updates.native.availableDetail")}
              </span>
            </div>
          )
        ) : null}

        {nativePhase === "downloading" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">
                {t("updates.native.downloaded", {
                  size: formatBytes(
                    nativeDownload?.downloaded ?? 0,
                    locale,
                    t("updates.sizeUnknown"),
                  ),
                })}
              </span>
              <span className="font-mono tabular-nums">
                {nativeDownload?.percent == null
                  ? t("updates.native.downloading")
                  : t("updates.downloadProgress", {
                      percent: String(nativeDownload.percent),
                    })}
              </span>
            </div>
            <Progress
              value={nativeDownload?.percent ?? 0}
              aria-label={t("updates.native.progressLabel")}
              className="gap-2"
            />
          </div>
        ) : null}

        {nativePhase === "installing" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("updates.native.preparing")}
          </p>
        ) : null}

        {nativePhase === "installed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">
              <CheckCircle2 />
              {t("updates.native.installed")}
            </Badge>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {t("updates.native.installedHint")}
            </span>
            {nativeNeedsRelaunch ? (
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={nativeRelaunching}
                onClick={() => void handleNativeRelaunch()}
              >
                {nativeRelaunching ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Power />
                )}
                {nativeRelaunching
                  ? t("updates.installing")
                  : t("updates.native.relaunch")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {nativePhase === "error" && nativeFailure ? (
          <p className="break-words rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
            {nativeFailure === "check"
              ? t("updates.native.errorCheck")
              : nativeFailure === "relaunch"
                ? t("updates.native.errorRelaunch")
                : t("updates.native.errorInstall")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <span
            className={cn(
              "inline-flex items-center gap-2 text-xs font-medium",
              nativePhase === "error"
                ? "text-destructive"
                : nativePhase === "installed" || nativeUpToDate
                  ? "text-success"
                  : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                nativeBusy
                  ? "animate-pulse bg-primary"
                  : nativePhase === "error"
                    ? "bg-destructive"
                    : nativePhase === "installed" || nativeUpToDate
                      ? "bg-success"
                      : "bg-muted-foreground",
              )}
              aria-hidden
            />
            {nativeStatus}
            {lastCheckedAt && !nativeBusy ? (
              <span className="font-normal text-muted-foreground">
                ·{" "}
                {t("updates.lastChecked", {
                  time: formatDateTime(new Date(lastCheckedAt), {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            ) : null}
          </span>
          <Badge variant={signatureConfigured ? "success" : "warning"}>
            {signatureConfigured ? (
              <ShieldCheck />
            ) : (
              <AlertTriangle className={cn(!signatureKnown && "opacity-60")} />
            )}
            {t("updates.native.signature")}
            {" · "}
            {!signatureKnown
              ? t("privacy.status.unknown")
              : signatureConfigured
                ? t("updates.securityConfigured")
                : t("updates.securityMissing")}
          </Badge>
        </div>
      </SettingsSection>
    </div>
  );
}
