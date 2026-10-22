import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Filter,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  api,
  type OnlineFilterRule,
  type OnlineFilterStats,
} from "@/lib/tauri";
import { useI18n } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/components/settings/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast, toastErr } from "@/components/Toast";

function patternText(rule: OnlineFilterRule): string {
  const pattern = rule.pattern;
  switch (pattern.kind) {
    case "urlTemplate":
      return pattern.template;
    case "exactUrl":
      return pattern.url;
    case "sha256":
      return `${pattern.hash.slice(0, 16)}…`;
    case "domClass":
      return pattern.value;
    case "size":
      return `${pattern.width}×${pattern.height}`;
  }
}

function sourceLabelKey(source: OnlineFilterRule["source"]) {
  switch (source) {
    case "user":
      return "settings.filter.source.user" as const;
    case "imported":
      return "settings.filter.source.imported" as const;
    default:
      return "settings.filter.source.learned" as const;
  }
}

/** 设置 → 在线源：提纯统计、规则库与导入/导出/重置。 */
export default function OnlineFilterPanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<OnlineFilterStats | null>(null);
  const [rules, setRules] = useState<OnlineFilterRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportText, setExportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStats, nextRules] = await Promise.all([
        api.getOnlineFilterStatus(),
        api.listOnlineFilterRules(),
      ]);
      setStats(nextStats);
      setRules(nextRules);
    } catch (e) {
      setError(localizeBackendError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onExport = useCallback(async () => {
    try {
      const text = await api.exportOnlineFilterRules();
      setExportText(text);
      setExportOpen(true);
      try {
        await navigator.clipboard.writeText(text);
        toast(t("settings.filter.exportDone"));
      } catch {
        toast(t("settings.filter.exportFailed"));
      }
    } catch (e) {
      toastErr("export_online_filter_rules", e);
    }
  }, [t]);

  const onImport = useCallback(async () => {
    const text = importText.trim();
    if (!text) {
      toast(t("settings.filter.importEmpty"));
      return;
    }
    setImporting(true);
    try {
      const count = await api.importOnlineFilterRules(text);
      setImportOpen(false);
      setImportText("");
      await load();
      toast(t("settings.filter.importDone", { count }));
    } catch (e) {
      toastErr("import_online_filter_rules", e);
    } finally {
      setImporting(false);
    }
  }, [importText, load, t]);

  const onReset = useCallback(async () => {
    setResetting(true);
    try {
      await api.resetOnlineFilterRules();
      setResetOpen(false);
      await load();
      toast(t("settings.filter.resetDone"));
    } catch (e) {
      toastErr("reset_online_filter_rules", e);
    } finally {
      setResetting(false);
    }
  }, [load, t]);

  const visibleRules = useMemo(() => rules.slice(0, 200), [rules]);

  return (
    <SettingsSection
      icon={Filter}
      title={t("settings.filter.title")}
      description={t("settings.filter.description")}
      action={
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          {t("settings.filter.refresh")}
        </Button>
      }
    >
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-border bg-destructive/10 px-3 py-2 text-xs text-muted-foreground"
        >
          {t("settings.filter.loadFailed")}：{error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          ["profiles", stats?.siteProfiles ?? 0],
          ["rules", stats?.rules ?? 0],
          ["blockedTotal", stats?.blockedTotal ?? 0],
          ["restoredTotal", stats?.restoredTotal ?? 0],
        ].map(([key, value]) => (
          <div
            key={String(key)}
            className="rounded-xl border border-border bg-background/60 px-3 py-2.5"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t(`settings.filter.${key}` as "settings.filter.profiles")}
            </p>
            <p className="mono mt-1 text-lg font-bold tabular-nums">
              {Number(value).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
      {stats?.lastUpdated ? (
        <p className="mono text-[10px] text-muted-foreground">
          {t("settings.filter.lastUpdated", { time: stats.lastUpdated })}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          onClick={() => void onExport()}
        >
          <Download />
          {t("settings.filter.export")}
        </Button>
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          onClick={() => setImportOpen(true)}
        >
          <Upload />
          {t("settings.filter.import")}
        </Button>
        <Button
          type="button"
          variant="pill"
          size="pill-sm"
          className="text-destructive"
          onClick={() => setResetOpen(true)}
        >
          <Trash2 />
          {t("settings.filter.reset")}
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-background/50">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <span className="flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck className="size-3.5" />
            {t("settings.filter.rulesTitle")}
          </span>
          <Badge variant="secondary" className="mono">
            {rules.length}
          </Badge>
        </div>
        {loading ? (
          <div className="flex min-h-28 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("settings.filter.refresh")}
          </div>
        ) : visibleRules.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("settings.filter.empty")}
          </p>
        ) : (
          <ScrollArea className="max-h-[min(42vh,360px)]">
            <ul className="divide-y divide-border/60 pr-2">
              {visibleRules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-start gap-2 px-3 py-2.5"
                >
                  <Badge
                    variant={
                      rule.action === "block" ? "destructive" : "success"
                    }
                    className="mt-0.5 shrink-0"
                  >
                    {rule.action === "block"
                      ? t("settings.filter.action.block")
                      : t("settings.filter.action.allow")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-[11px] leading-relaxed text-foreground">
                      {patternText(rule)}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span>{rule.host}</span>
                      <span>
                        {t(sourceLabelKey(rule.source))}
                      </span>
                      <span>
                        {t(
                          `settings.filter.pattern.${rule.pattern.kind}` as "settings.filter.pattern.urlTemplate",
                        )}
                      </span>
                      {rule.hits > 0 ? (
                        <span className="mono">{rule.hits}×</span>
                      ) : null}
                    </p>
                  </div>
                  <span className="mono mt-0.5 shrink-0 text-[10px] text-muted-foreground">
                    {rule.createdAt}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.filter.exportDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.filter.exportDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            readOnly
            value={exportText}
            rows={12}
            className="font-mono text-[11px]"
            aria-label={t("settings.filter.exportDialogTitle")}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              onClick={() => setExportOpen(false)}
            >
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.filter.importTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.filter.importDescription")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(event) => setImportText(event.currentTarget.value)}
            rows={10}
            placeholder={t("settings.filter.importPlaceholder")}
            className="font-mono text-[11px]"
            aria-label={t("settings.filter.importTitle")}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              onClick={() => setImportOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="pill-primary"
              size="pill-sm"
              disabled={importing}
              onClick={() => void onImport()}
            >
              {importing ? <Loader2 className="animate-spin" /> : <Upload />}
              {t("settings.filter.importConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {resetOpen ? (
        <ConfirmDialog
          title={t("settings.filter.resetTitle")}
          message={t("settings.filter.resetDescription")}
          confirmText={
            resetting
              ? t("settings.filter.refresh")
              : t("settings.filter.reset")
          }
          onCancel={() => {
            if (!resetting) setResetOpen(false);
          }}
          onConfirm={() => void onReset()}
        />
      ) : null}
    </SettingsSection>
  );
}
