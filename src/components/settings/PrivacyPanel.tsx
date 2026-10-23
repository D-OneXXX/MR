import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Database,
  FolderCheck,
  Globe2,
  HardDriveDownload,
  Loader2,
  LockKeyhole,
  PackageCheck,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";
import { useI18n, type MessageKey } from "@/i18n";
import { ONLINE_LAST_TEST_EVENT } from "@/lib/onlineLastTest";
import { cn } from "@/lib/utils";
import { recordBreadcrumb } from "@/features/resilience";
import { useUpdater } from "@/features/update/UpdateProvider";
import { resolveManifestUrl } from "@/features/update/types";
import {
  privacyApi,
  type ClearTracesResult,
  type SecurityAudit,
  type SecurityStatus,
} from "@/features/privacy/api";
import {
  PRIVACY_DIALOG_EVENT,
  PRIVACY_POLICY_VERSION,
} from "@/components/privacy/PrivacyDialog";

const TRACE_KEYS = new Set(["mr-browser-recents", "mr-online-last-test"]);

/** 应用数据目录（Tauri `app_data_dir`：library.db / 日志 / 下载）。 */
const APP_DATA_DIR = "%APPDATA%\\com.local.manga-reader";
/** 应用缓存目录（Tauri `app_cache_dir`：render_cache / online_cache）。 */
const CACHE_DIR = "%LOCALAPPDATA%\\com.local.manga-reader";
/** 更新暂存目录：Rust 侧 std::env::temp_dir() 下的 mangareader-updates。 */
const UPDATE_STAGING_DIR = "%TEMP%\\mangareader-updates";

function statusVariant(
  status: SecurityStatus,
): "success" | "warning" | "destructive" | "muted" {
  switch (status) {
    case "pass":
      return "success";
    case "warn":
      return "warning";
    case "fail":
      return "destructive";
    default:
      return "muted";
  }
}

function statusKey(status: SecurityStatus): MessageKey {
  return `privacy.status.${status}` as MessageKey;
}

function formatMb(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(bytes / 1048576)} MB`;
}

function isLoopbackManifest(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1")
    );
  } catch {
    return false;
  }
}

function AuditCard({
  icon: Icon,
  title,
  description,
  status,
  evidence,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  status: SecurityStatus;
  evidence: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  const variant = statusVariant(status);
  return (
    <div className="rounded-2xl border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl border border-border shadow-hard-sm",
            variant === "success" && "bg-success/10 text-success",
            variant === "warning" && "bg-warning/10 text-warning",
            variant === "destructive" && "bg-destructive/10 text-destructive",
            variant === "muted" && "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            <Badge variant={variant}>{t(statusKey(status))}</Badge>
          </div>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
          <details className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            <summary className="cursor-pointer select-none font-semibold text-foreground/80">
              {t("privacy.audit.details")}
            </summary>
            <div className="mt-1.5 space-y-0.5 rounded-lg border border-border/60 bg-muted/30 p-2 font-mono">
              {evidence}
            </div>
          </details>
          {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 胶囊风格说明卡：圆角胶囊图标 + 硬阴影卡片，沿用 --sh-* 语义 token。
 * 仅承载静态指引文案，不触发任何网络请求或后端命令。
 */
function CapsuleCard({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: "default" | "success" | "warning";
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background/60 p-4 shadow-hard-sm">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full border border-border shadow-hard-sm",
            tone === "success" && "bg-success/10 text-success",
            tone === "warning" && "bg-warning/10 text-warning",
            tone === "default" && "bg-secondary text-secondary-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold">{title}</p>
          <div className="mt-1.5 space-y-2 text-xs leading-relaxed text-muted-foreground">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 操作步骤链：全圆角胶囊串联，最后一步为主色强调。 */
function StepChain({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, index) => (
        <li key={step} className="flex min-w-0 max-w-full items-center gap-1.5">
          {index > 0 ? (
            <ArrowRight
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <span
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold shadow-hard-sm",
              index === steps.length - 1
                ? "border-border bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground",
            )}
          >
            <span className="font-mono text-[10px] opacity-70">{index + 1}</span>
            <span className="break-words">{step}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 路径胶囊：等宽字体展示产品级固定路径（非用户私有路径）。 */
function PathCapsule({ path }: { path: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] shadow-hard-sm">
      <FolderCheck className="size-3 shrink-0 text-muted-foreground" />
      <span className="break-words font-mono">{path}</span>
    </span>
  );
}

/**
 * Settings → Privacy & security. The statement is static copy; every audit
 * indicator is returned by the Rust security command (build config, capability
 * file, current settings, live WebViews and cache sizes).
 */
export default function PrivacyPanel() {
  const { t, locale, formatDateTime } = useI18n();
  const { prefs } = useUpdater();
  const [audit, setAudit] = useState<SecurityAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const seqRef = useRef(0);
  const loopbackManifest = isLoopbackManifest(resolveManifestUrl(prefs));

  const runAudit = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const manifestUrl = resolveManifestUrl(prefs);
      const next = await privacyApi.securityAudit({ manifestUrl });
      if (seq !== seqRef.current) return;
      setAudit(next);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(typeof e === "string" ? e : t("privacy.audit.storage.fail"));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [prefs, t]);

  const runAuditRef = useRef(runAudit);
  runAuditRef.current = runAudit;

  useEffect(() => {
    void runAuditRef.current();
    return () => {
      seqRef.current += 1;
    };
  }, []);

  // The update source participates in the audit; re-check when it changes.
  const manifestUrl = resolveManifestUrl(prefs);
  useEffect(() => {
    if (!audit) return;
    void runAuditRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestUrl]);

  const clearTraces = async () => {
    setConfirmClear(false);
    setClearing(true);
    const protectedLocal = new Map<string, string>();
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith("mr-") || TRACE_KEYS.has(key)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) protectedLocal.set(key, value);
      }
    } catch {
      /* Continue without protected-key restoration. */
    }
    try {
      const result: ClearTracesResult = await privacyApi.clearOnlineTraces();
      recordBreadcrumb("privacy");
      const restoreProtected = () => {
        try {
          protectedLocal.forEach((value, key) =>
            localStorage.setItem(key, value),
          );
          TRACE_KEYS.forEach((key) => localStorage.removeItem(key));
          const sessionKeys: string[] = [];
          for (let index = 0; index < sessionStorage.length; index += 1) {
            const key = sessionStorage.key(index);
            if (key?.startsWith("mr-")) sessionKeys.push(key);
          }
          sessionKeys.forEach((key) => sessionStorage.removeItem(key));
        } catch {
          /* Storage restoration is best effort. */
        }
      };
      restoreProtected();
      // WebView2 clears DOM storage asynchronously; restore app preferences
      // once more after the profile clear has settled.
      window.setTimeout(restoreProtected, 1600);
      window.dispatchEvent(new Event(ONLINE_LAST_TEST_EVENT));
      toast(
        result.webviewsCleared > 0
          ? t("privacy.audit.cleared", {
              webviews: String(result.webviewsCleared),
              size: formatMb(result.bytesFreed, locale),
            })
          : t("privacy.toast.cleared"),
      );
      await runAuditRef.current();
    } catch (e) {
      toast(
        t("privacy.toast.clearFailed", {
          detail: typeof e === "string" ? e : t("common.unknown"),
        }),
      );
    } finally {
      setClearing(false);
    }
  };

  const overallVariant = audit ? statusVariant(audit.overall) : "muted";
  const updateDescription = !audit
    ? t("privacy.audit.overall.unknown")
    : !audit.update.manifestConfigured
      ? t("privacy.audit.update.notConfigured")
      : !audit.update.manifestHttps
        ? t("privacy.audit.update.fail")
        : !audit.update.signatureConfigured
          ? t("privacy.audit.update.warn")
          : audit.update.status === "fail"
            ? t("privacy.audit.update.fail")
            : t("privacy.audit.update.pass");

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={ShieldCheck}
        title={t("privacy.statement.title")}
        description={t("privacy.statement.summary")}
        action={
          <Badge variant="success" className="gap-1.5 px-3 py-1">
            <LockKeyhole className="size-3" />
            {t("privacy.badge")}
          </Badge>
        }
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-background/60 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Database className="size-4 text-primary" />
              {t("privacy.storage.title")}
            </p>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>{t("privacy.storage.books")}</li>
              <li>{t("privacy.storage.progress")}</li>
              <li>{t("privacy.storage.cache")}</li>
              <li>{t("privacy.storage.settings")}</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-border bg-background/60 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Wifi className="size-4 text-primary" />
              {t("privacy.network.title")}
            </p>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>{t("privacy.network.online")}</li>
              <li>{t("privacy.network.updates")}</li>
              <li className="font-medium text-foreground">
                {t("privacy.network.none")}
              </li>
            </ul>
          </div>
        </div>
        <p className="rounded-xl border border-border/60 bg-secondary/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {t("diagnostics.privacyNote")}
        </p>
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          className="whitespace-nowrap"
          onClick={() => window.dispatchEvent(new Event(PRIVACY_DIALOG_EVENT))}
        >
          {t("privacy.statement.showDialog")}
        </Button>
        <p className="font-mono text-[10px] text-muted-foreground">
          {t("privacy.dialog.policyVersion", {
            version: PRIVACY_POLICY_VERSION,
          })}
        </p>
      </SettingsSection>

      <SettingsSection
        icon={ShieldCheck}
        title={t("privacy.audit.title")}
        description={t("privacy.audit.description")}
        action={
          <Button
            type="button"
            variant="pill-primary"
            size="pill"
            className="whitespace-nowrap"
            disabled={loading || clearing}
            onClick={() => void runAudit()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {loading ? t("privacy.audit.running") : t("privacy.audit.run")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={overallVariant}>
            {audit ? t(statusKey(audit.overall)) : t("privacy.status.unknown")}
          </Badge>
          <span className="text-xs font-medium">
            {audit
              ? t(`privacy.audit.overall.${audit.overall}` as MessageKey)
              : null}
          </span>
          {audit ? (
            <span className="text-[11px] text-muted-foreground">
              {t("privacy.audit.checkedAt", {
                time: formatDateTime(audit.checkedAt, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }),
              })}
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <LockKeyhole className="size-3" />
            {t("privacy.audit.noUpload")}
          </span>
        </div>

        {error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t("privacy.audit.error", { detail: error })}
            </span>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              onClick={() => void runAudit()}
            >
              {t("privacy.audit.retry")}
            </Button>
          </div>
        ) : null}

        {loading && !audit ? (
          <p className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {t("privacy.audit.running")}
          </p>
        ) : null}

        {audit ? (
          <div className="space-y-3">
            <AuditCard
              icon={ShieldCheck}
              title={t("privacy.audit.update.title")}
              description={updateDescription}
              status={audit.update.status}
              evidence={
                <>
                  <div>
                    {t("privacy.audit.evidence.signature", {
                      value: audit.update.signatureConfigured
                        ? t("privacy.audit.enabled")
                        : t("privacy.audit.disabled"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.sha", {
                      value: audit.update.sha256Enforced
                        ? t("privacy.audit.enabled")
                        : t("privacy.audit.disabled"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.https", {
                      value: !audit.update.manifestConfigured
                        ? t("privacy.audit.disabled")
                        : loopbackManifest
                          ? t("privacy.audit.loopback")
                          : audit.update.manifestHttps
                            ? t("privacy.audit.enabled")
                            : t("privacy.audit.disabled"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.keySource", {
                      value: audit.update.keySource,
                    })}
                  </div>
                </>
              }
            />

            <AuditCard
              icon={Globe2}
              title={t("privacy.audit.isolation.title")}
              description={
                audit.isolation.status === "pass"
                  ? t("privacy.audit.isolation.pass")
                  : audit.isolation.status === "fail"
                    ? t("privacy.audit.isolation.fail")
                    : t("privacy.audit.isolation.warn")
              }
              status={audit.isolation.status}
              evidence={
                <>
                  <div>
                    {t("privacy.audit.evidence.capabilities", {
                      value:
                        audit.isolation.capabilityWindows.join(", ") || "—",
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.remote", {
                      value: String(audit.isolation.remoteCapabilities),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.csp", {
                      value: audit.isolation.cspConfigured
                        ? t("privacy.audit.enabled")
                        : t("privacy.audit.disabled"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.webviews", {
                      value: audit.isolation.browserWindowOpen ? "1" : "0",
                    })}
                  </div>
                </>
              }
            />

            <AuditCard
              icon={Wifi}
              title={t("privacy.audit.network.title")}
              description={
                audit.network.status === "fail"
                  ? t("privacy.audit.network.invalid")
                  : audit.network.status === "warn"
                    ? t("privacy.audit.network.insecure")
                    : audit.network.mode === "direct"
                      ? t("privacy.audit.network.direct")
                      : t("privacy.audit.network.proxy", {
                          proxy: audit.network.proxyScheme ?? "—",
                        })
              }
              status={audit.network.status}
              evidence={
                <>
                  <div>
                    {t("privacy.audit.evidence.mode", {
                      value:
                        audit.network.mode === "direct"
                          ? t("privacy.audit.direct")
                          : t("privacy.audit.proxyMode"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.scheme", {
                      value: audit.network.proxyScheme ?? "—",
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.https", {
                      value: audit.network.httpsPreferred
                        ? t("privacy.audit.enabled")
                        : t("privacy.audit.disabled"),
                    })}
                  </div>
                </>
              }
            />

            <AuditCard
              icon={Database}
              title={t("privacy.audit.storage.title")}
              description={
                audit.storage.status === "fail"
                  ? t("privacy.audit.storage.fail")
                  : t("privacy.audit.storage.summary", {
                      memory: formatMb(audit.storage.memoryCacheBytes, locale),
                      disk: formatMb(audit.storage.diskCacheBytes, locale),
                    })
              }
              status={audit.storage.status}
              evidence={
                <>
                  <div>
                    {t("privacy.audit.evidence.webviews", {
                      value: String(audit.storage.liveWebviews),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.sessionHeaders", {
                      value: audit.storage.sessionHeadersInMemory
                        ? t("privacy.audit.enabled")
                        : t("privacy.audit.disabled"),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.memoryBytes", {
                      value: String(audit.storage.memoryCacheBytes),
                    })}
                  </div>
                  <div>
                    {t("privacy.audit.evidence.diskBytes", {
                      value: String(audit.storage.diskCacheBytes),
                    })}
                  </div>
                </>
              }
            />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={ShieldAlert}
        title={t("privacy.security.windowsTitle")}
        description={t("privacy.security.windowsBody")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success" className="gap-1.5 px-3 py-1">
            <ShieldCheck className="size-3" />
            {t("privacy.security.windowsBadgeIntegrity")}
          </Badge>
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <PackageCheck className="size-3" />
            {t("privacy.security.windowsBadgeTransaction")}
          </Badge>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <CapsuleCard
            icon={ShieldAlert}
            tone="warning"
            title={t("privacy.security.windowsSmartScreenTitle")}
          >
            <p className="break-words">
              {t("privacy.security.windowsSmartScreen")}
            </p>
            <StepChain
              steps={[
                t("privacy.security.windowsStepLaunch"),
                t("privacy.security.windowsStepInfo"),
                t("privacy.security.windowsStepRun"),
              ]}
            />
          </CapsuleCard>

          <CapsuleCard
            icon={HardDriveDownload}
            title={t("privacy.security.windowsTempTitle")}
          >
            <p className="break-words">{t("privacy.security.windowsTemp")}</p>
            <PathCapsule path={UPDATE_STAGING_DIR} />
          </CapsuleCard>
        </div>

        <CapsuleCard
          icon={FolderCheck}
          tone="success"
          title={t("privacy.security.windowsAllowlistTitle")}
        >
          <p className="break-words">
            {t("privacy.security.windowsAllowlist")}
          </p>
          <div className="flex flex-wrap gap-2">
            <PathCapsule path={APP_DATA_DIR} />
            <PathCapsule path={CACHE_DIR} />
          </div>
        </CapsuleCard>
      </SettingsSection>

      <SettingsSection
        icon={Trash2}
        title={t("privacy.audit.clear")}
        description={t("privacy.audit.clearHint")}
        action={
          <Button
            type="button"
            variant="pill-danger"
            size="pill"
            className="whitespace-nowrap"
            disabled={clearing}
            onClick={() => setConfirmClear(true)}
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {clearing ? t("privacy.audit.clearing") : t("privacy.audit.clear")}
          </Button>
        }
      >
        <p className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {t("privacy.audit.clearBody")}
        </p>
      </SettingsSection>

      {confirmClear ? (
        <ConfirmDialog
          title={t("privacy.audit.clearTitle")}
          message={t("privacy.audit.clearBody")}
          confirmText={t("privacy.audit.clearAction")}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearTraces()}
        />
      ) : null}
    </div>
  );
}
