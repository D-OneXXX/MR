import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Download,
  FileWarning,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useI18n, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  collectDiagnostics,
  exportDiagnostics,
  sanitizeDiagnosticsDescription,
} from "@/features/diagnostics/api";
import { copyText } from "@/features/diagnostics/clipboard";
import { buildDiagnosticPrompt } from "@/features/diagnostics/prompt";
import type {
  DiagnosticBreadcrumb,
  DiagnosticBundle,
  DiagnosticLog,
} from "@/features/diagnostics/types";

const ACTION_KEYS: Record<string, MessageKey> = {
  navigation: "diagnostics.actionKind.navigation",
  readerMode: "diagnostics.actionKind.readerMode",
  archiveImport: "diagnostics.actionKind.archiveImport",
  folderImport: "diagnostics.actionKind.folderImport",
  fileOpen: "diagnostics.actionKind.fileOpen",
  relocateBook: "diagnostics.actionKind.relocateBook",
  onlineRead: "diagnostics.actionKind.onlineRead",
  settingsChange: "diagnostics.actionKind.settingsChange",
  themeChange: "diagnostics.actionKind.themeChange",
  localeChange: "diagnostics.actionKind.localeChange",
  onlinePairing: "diagnostics.actionKind.onlinePairing",
  recovery: "diagnostics.actionKind.recovery",
  safeMode: "diagnostics.actionKind.safeMode",
  update: "diagnostics.actionKind.update",
  privacy: "diagnostics.actionKind.privacy",
  readerPage: "diagnostics.actionKind.readerPage",
  other: "diagnostics.actionKind.other",
};

function errorText(error: unknown): string {
  return typeof error === "string" && error ? error : String(error);
}

function PreviewSection({
  title,
  children,
  open = false,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details
      open={open}
      className="group rounded-2xl border border-border bg-background/55 px-3 py-2.5"
    >
      <summary className="cursor-pointer list-none text-xs font-semibold outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-ring">
        <span className="inline-flex w-full items-center gap-2">
          <span className="text-muted-foreground transition-transform group-open:rotate-90">
            ▸
          </span>
          {title}
        </span>
      </summary>
      <div className="mt-2.5 max-h-56 space-y-2 overflow-auto pr-1 text-[11px] leading-relaxed">
        {children}
      </div>
    </details>
  );
}

function RuntimeTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-background/60 px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mono mt-0.5 break-words text-[11px] font-semibold">
        {value}
      </p>
    </div>
  );
}

export default function DiagnosticPanel({ compact = false }: { compact?: boolean }) {
  const { t, formatDateTime, locale } = useI18n();
  const [bundle, setBundle] = useState<DiagnosticBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [redactUrlPaths, setRedactUrlPaths] = useState(true);
  const [description, setDescription] = useState("");
  const [safeDescription, setSafeDescription] = useState("");
  const [promptOverride, setPromptOverride] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "failed">("idle");
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    const timer = window.setTimeout(() => {
      collectDiagnostics(redactUrlPaths).then(
        (next) => {
          if (!alive) return;
          setBundle(next);
          setPromptOverride(null);
          setLoading(false);
        },
        (error) => {
          if (!alive) return;
          setLoadError(errorText(error));
          setLoading(false);
        },
      );
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [redactUrlPaths, reloadTick]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2600);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    const value = description.trim();
    if (!value) {
      setSafeDescription("");
      return;
    }
    let alive = true;
    setSafeDescription("");
    const timer = window.setTimeout(() => {
      sanitizeDiagnosticsDescription(value).then(
        (clean) => {
          if (alive) setSafeDescription(clean);
        },
        () => {
          // 脱敏不可用时宁可不插入描述，也不能把原文写进 Prompt。
          if (alive) {
            setSafeDescription(t("diagnostics.prompt.descriptionOmitted"));
          }
        },
      );
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [description, t]);

  const generatedPrompt = useMemo(
    () =>
      bundle
        ? buildDiagnosticPrompt(bundle, safeDescription)
        : "",
    // locale 参与依赖：buildDiagnosticPrompt 跟随活动语言，切换语言后需要重建。
    [bundle, safeDescription, locale],
  );
  const prompt = promptOverride ?? generatedPrompt;
  const manual = promptOverride !== null;

  const copyPrompt = async () => {
    setActionError(null);
    const ok = await copyText(prompt);
    setCopyState(ok ? "ok" : "failed");
  };

  const doExport = async () => {
    if (!prompt.trim() || exporting) return;
    setExporting(true);
    setActionError(null);
    setExportPath(null);
    try {
      const path = await exportDiagnostics(prompt);
      setExportPath(path);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setExporting(false);
    }
  };

  const time = (value: string) =>
    formatDateTime(value, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const actionLabel = (item: DiagnosticBreadcrumb) =>
    t(ACTION_KEYS[item.kind] ?? "diagnostics.actionKind.other");

  const runtime = bundle?.runtime;
  const readerMode =
    runtime?.readerMode === "single" ||
    runtime?.readerMode === "double" ||
    runtime?.readerMode === "webtoon"
      ? t(`diagnostics.mode.${runtime.readerMode}`)
      : t("diagnostics.mode.none");

  return (
    <section className={cn("space-y-3.5", compact && "space-y-3")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className={cn("font-extrabold tracking-tight", compact ? "text-sm" : "text-lg")}>
            {t("diagnostics.title")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("diagnostics.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="success" className="shrink-0 gap-1">
            <ShieldCheck className="size-3" aria-hidden />
            {t("diagnostics.localOnly")}
          </Badge>
          <Button
            type="button"
            variant="pill-ghost"
            size="pill-icon-sm"
            aria-label={t("diagnostics.retry")}
            title={t("diagnostics.retry")}
            disabled={loading}
            onClick={() => setReloadTick((value) => value + 1)}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="diagnostics-description">
          {t("diagnostics.descriptionLabel")}
        </Label>
        <Textarea
          id="diagnostics-description"
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
          rows={compact ? 2 : 3}
          placeholder={t("diagnostics.descriptionPlaceholder")}
          className="resize-y text-xs"
          maxLength={4000}
        />
      </div>

      <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-secondary/60 p-3">
        <div className="min-w-0">
          <Label htmlFor="diagnostics-redact-urls" className="text-xs font-semibold">
            {t("diagnostics.redactUrls")}
          </Label>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {t("diagnostics.redactUrlsHint")}
          </p>
        </div>
        <Switch
          id="diagnostics-redact-urls"
          checked={redactUrlPaths}
          onCheckedChange={setRedactUrlPaths}
          aria-label={t("diagnostics.redactUrls")}
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("diagnostics.loading")}
        </div>
      ) : loadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/35 bg-destructive/10 p-3">
          <FileWarning className="size-4 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-0 flex-1 break-words text-xs text-destructive">
            {t("diagnostics.loadFailed", { detail: loadError })}
          </p>
          <Button
            variant="pill"
            size="pill-sm"
            onClick={() => setReloadTick((value) => value + 1)}
          >
            <RefreshCw />
            {t("diagnostics.retry")}
          </Button>
        </div>
      ) : bundle && runtime ? (
        <>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <RuntimeTile
              label={t("diagnostics.runtime.version")}
              value={`v${runtime.version}`}
            />
            <RuntimeTile
              label={t("diagnostics.runtime.build")}
              value={runtime.buildBaseline}
            />
            <RuntimeTile
              label={t("diagnostics.runtime.os")}
              value={`${runtime.os} · ${runtime.arch}`}
            />
            <RuntimeTile
              label={t("diagnostics.runtime.route")}
              value={runtime.route ?? t("diagnostics.unknown")}
            />
            <RuntimeTile
              label={t("diagnostics.runtime.reader")}
              value={
                runtime.readerPage !== null && runtime.readerPage !== undefined
                  ? `${readerMode} · ${runtime.readerPage + 1}`
                  : readerMode
              }
            />
            <RuntimeTile
              label={t("diagnostics.runtime.network")}
              value={
                runtime.networkMode === "proxy"
                  ? t("diagnostics.network.proxy", {
                      scheme: runtime.proxyScheme ?? t("diagnostics.unknown"),
                    })
                  : t("diagnostics.network.direct")
              }
            />
            <RuntimeTile
              label={t("diagnostics.runtime.cacheFailures")}
              value={String(runtime.cacheWriteFailures ?? 0)}
            />
          </div>

          <div className="flex flex-wrap gap-1.5 text-[10px]">
            <Badge variant={runtime.onlineEnabled ? "warning" : "muted"}>
              {t("diagnostics.runtime.online")}:{" "}
              {runtime.onlineEnabled ? t("common.enabled") : t("common.disabled")}
            </Badge>
            <Badge variant={runtime.safeMode ? "warning" : "muted"}>
              {t("diagnostics.runtime.safeMode")}:{" "}
              {runtime.safeMode ? t("common.enabled") : t("common.disabled")}
            </Badge>
          </div>

          <div className="space-y-2">
            <PreviewSection
              title={t("diagnostics.preview.errors", {
                count: bundle.errors.length,
              })}
              open={bundle.errors.length > 0}
            >
              {bundle.errors.length === 0 ? (
                <p className="text-muted-foreground">{t("diagnostics.preview.none")}</p>
              ) : (
                bundle.errors.map((item, index) => (
                  <div
                    key={`${item.at}-${index}`}
                    className="rounded-xl border border-border/70 bg-card p-2"
                  >
                    <p className="font-semibold text-destructive">
                      [{item.source}] {time(item.at)}
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10.5px]">
                      {item.message}
                      {item.stack ? `\n${item.stack}` : ""}
                    </pre>
                  </div>
                ))
              )}
            </PreviewSection>

            <PreviewSection
              title={t("diagnostics.preview.actions", {
                count: bundle.breadcrumbs.length,
              })}
            >
              {bundle.breadcrumbs.length === 0 ? (
                <p className="text-muted-foreground">{t("diagnostics.preview.none")}</p>
              ) : (
                bundle.breadcrumbs.map((item, index) => (
                  <div
                    key={`${item.at}-${index}`}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/40 pb-1 last:border-0"
                  >
                    <span className="mono text-[10px] text-muted-foreground">
                      {time(item.at)}
                    </span>
                    <span className="font-semibold">{actionLabel(item)}</span>
                    {item.route ? (
                      <span className="mono ml-auto text-[10px] text-muted-foreground">
                        {item.route}
                      </span>
                    ) : null}
                  </div>
                ))
              )}
            </PreviewSection>

            <PreviewSection
              title={t("diagnostics.preview.logs", {
                count: bundle.logs.length,
              })}
            >
              {bundle.logs.length === 0 ? (
                <p className="text-muted-foreground">{t("diagnostics.preview.none")}</p>
              ) : (
                bundle.logs.map((item: DiagnosticLog, index: number) => (
                  <pre
                    key={`${item.at}-${index}`}
                    className="whitespace-pre-wrap break-words border-b border-border/40 pb-1 font-mono text-[10.5px] last:border-0"
                  >
                    [{time(item.at)}] [{item.scope}] {item.message}
                  </pre>
                ))
              )}
            </PreviewSection>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold">{t("diagnostics.previewTitle")}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("diagnostics.previewHint")}
                </p>
              </div>
              {manual ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="warning">{t("diagnostics.manuallyEdited")}</Badge>
                  <Button
                    variant="pill-ghost"
                    size="pill-sm"
                    onClick={() => setPromptOverride(null)}
                  >
                    <RefreshCw />
                    {t("diagnostics.regenerate")}
                  </Button>
                </div>
              ) : null}
            </div>
            <Textarea
              value={prompt}
              onChange={(event) => setPromptOverride(event.currentTarget.value)}
              rows={compact ? 10 : 14}
              spellCheck={false}
              aria-label={t("diagnostics.previewTitle")}
              className="min-h-48 resize-y font-mono text-[11px] leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="pill-primary"
                size="pill-sm"
                onClick={() => void copyPrompt()}
                disabled={!prompt.trim()}
              >
                <Copy />
                {t("diagnostics.copy")}
              </Button>
              <Button
                variant="pill"
                size="pill-sm"
                onClick={() => void doExport()}
                disabled={!prompt.trim() || exporting}
              >
                {exporting ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                {exporting ? t("diagnostics.exporting") : t("diagnostics.export")}
              </Button>
              <span
                aria-live="polite"
                className={cn(
                  "text-[11px] font-semibold",
                  copyState === "failed" || actionError
                    ? "text-destructive"
                    : "text-success",
                )}
              >
                {copyState === "ok" ? t("diagnostics.copied") : null}
                {copyState === "failed" ? t("diagnostics.copyFailed") : null}
                {actionError ? t("diagnostics.exportFailed", { detail: actionError }) : null}
              </span>
            </div>
            {exportPath ? (
              <p className="break-all rounded-xl border border-border bg-success/10 px-3 py-2 font-mono text-[10.5px] text-success">
                {t("diagnostics.exported", { path: exportPath })}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {t("diagnostics.privacyNote")}
      </p>
    </section>
  );
}
