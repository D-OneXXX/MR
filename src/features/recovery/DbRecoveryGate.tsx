import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useI18n, type MessageKey } from "@/i18n";
import { localizeBackendError } from "@/features/errors/localize";
import { recoveryApi, type DbHealth } from "./api";
import { Button } from "@/components/ui/button";
import ConfirmDialog from "@/components/ConfirmDialog";

const ERROR_KEYS: Record<string, MessageKey> = {
  "db-open-failed": "dbRecovery.openFailed",
  "db-schema-failed": "dbRecovery.schemaFailed",
  "db-quick-check-failed": "dbRecovery.quickCheckFailed",
};

/**
 * 启动数据库自检门。
 *
 * 数据库打开/结构/quick_check 失败时，整个应用不挂载，避免用户在一堆
 * “数据库尚未初始化”错误里打转。提供两个出口：
 * - 选择 `.mrbackup`，后端先 staging 恢复，成功后才隔离并替换活库；
 * - 在系统文件管理器中打开数据目录（损坏库会以 .corrupt 保留）。
 */
export default function DbRecoveryGate({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [healthError, setHealthError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [recovered, setRecovered] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    setHealthError(false);
    try {
      const next = await recoveryApi.getDbHealth();
      setHealth(next);
    } catch {
      setHealth(null);
      setHealthError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (loading) {
    return (
      <div
        className="grid h-screen w-full place-items-center bg-background px-6 text-sm text-muted-foreground"
        aria-busy="true"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-hard-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("common.loading")}
        </span>
      </div>
    );
  }

  if (health?.ok) return <>{children}</>;

  const errorKey =
    (health?.errorCode && ERROR_KEYS[health.errorCode]) ||
    "dbRecovery.unknown";
  const message = healthError
    ? t("dbRecovery.healthUnavailable")
    : t(errorKey);

  const openDataDir = async () => {
    setActionError("");
    try {
      await recoveryApi.openDataDir();
    } catch (error) {
      setActionError(localizeBackendError(error));
    }
  };

  const pickBackup = async () => {
    setActionError("");
    try {
      const picked = await openDialog({
        title: t("dbRecovery.selectTitle"),
        multiple: false,
        directory: false,
        filters: [
          {
            name: t("dbRecovery.filterName"),
            extensions: ["mrbackup", "zip"],
          },
        ],
      });
      const path =
        typeof picked === "string"
          ? picked
          : Array.isArray(picked)
            ? (picked[0] ?? null)
            : null;
      if (path) setPendingPath(path);
    } catch (error) {
      setActionError(localizeBackendError(error));
    }
  };

  const recover = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await recoveryApi.recoverDatabase(path);
      setPendingPath(null);
      setRecovered(true);
      // 用户显式恢复成功后再重新加载 UI；不是静默重启应用。
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      setPendingPath(null);
      setActionError(
        `${t("dbRecovery.failed")} ${localizeBackendError(error)}`,
      );
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid min-h-screen w-full place-items-center bg-background px-4 py-10">
        <main className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-hard sm:p-8">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-warning/15 text-warning">
              <AlertTriangle className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold tracking-tight">
                {t("dbRecovery.title")}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {message}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border bg-background/60 p-3">
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
              <span>{t("dbRecovery.hint")}</span>
            </p>
            {health?.dataDir ? (
              <p
                className="mt-2 truncate font-mono text-[11px] text-muted-foreground"
                title={health.dataDir}
              >
                {health.dataDir}
              </p>
            ) : null}
          </div>

          {actionError ? (
            <p
              role="alert"
              className="mt-3 break-words rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive"
            >
              {actionError}
            </p>
          ) : null}
          {recovered ? (
            <p
              role="status"
              className="mt-3 rounded-xl border border-success/40 bg-success/10 p-3 text-xs font-semibold text-success"
            >
              {t("dbRecovery.recovered")}
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="pill-primary"
              size="pill"
              className="whitespace-nowrap"
              disabled={busy}
              onClick={() => void pickBackup()}
            >
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ShieldCheck />
              )}
              {t("dbRecovery.recover")}
            </Button>
            <Button
              type="button"
              variant="pill"
              size="pill"
              className="whitespace-nowrap"
              disabled={busy}
              onClick={() => void openDataDir()}
            >
              <FolderOpen />
              {t("dbRecovery.openDir")}
            </Button>
            <Button
              type="button"
              variant="pill-ghost"
              size="pill"
              className="whitespace-nowrap"
              disabled={busy}
              onClick={() => void check()}
            >
              <RefreshCw />
              {t("dbRecovery.retry")}
            </Button>
          </div>
        </main>
      </div>

      {pendingPath ? (
        <ConfirmDialog
          title={t("dbRecovery.confirmTitle")}
          message={t("dbRecovery.confirmMessage")}
          confirmText={t("dbRecovery.confirmAction")}
          onConfirm={() => void recover(pendingPath)}
          onCancel={() => setPendingPath(null)}
        />
      ) : null}
    </>
  );
}
