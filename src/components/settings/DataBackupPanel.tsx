import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Download, Loader2, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useI18n, type Locale, type MessageKey } from "@/i18n";
import { useTheme } from "@/features/theme/ThemeProvider";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import {
  LIBRARY_REFRESH_EVENT,
  SETTINGS_UPDATED_EVENT,
} from "@/lib/events";
import { toast, toastErr } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  backupApi,
  type SkippedBackupBook,
} from "@/features/backup/api";
import {
  applyBackupPreferences,
  captureBackupPreferences,
} from "@/features/backup/preferences";

interface DataBackupPanelProps {
  /** 恢复完成后重新加载设置表单（由 Settings 的 load() 提供）。 */
  onRestored?: () => void | Promise<void>;
}

type BusyState = "export" | "restore" | null;

const BACKUP_EXTENSIONS = ["mrbackup", "zip"];

const SKIP_REASON_KEYS: Record<string, MessageKey> = {
  "path-relative": "settings.backup.skippedReasonMissing",
  "path-missing": "settings.backup.skippedReasonMissing",
  "path-not-book": "settings.backup.skippedReasonNotBook",
  "path-unsafe": "settings.backup.skippedReasonUnsafe",
};

/** 本地日期文件名：Moyu-backup-YYYY-MM-DD.mrbackup。 */
function backupFileName(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `Moyu-backup-${year}-${month}-${day}.mrbackup`;
}

/** 仅取 basename，避免把完整路径塞进确认文案。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 本地 KB/MB 格式化；单位是符号不是文案，避免硬编码中文。 */
function formatBytes(bytes: number, locale: Locale): string {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (safe < 1024) return `${nf.format(safe)} B`;
  if (safe < 1024 * 1024) return `${nf.format(safe / 1024)} KB`;
  return `${nf.format(safe / (1024 * 1024))} MB`;
}

/** 让 React 提交上一轮 setTabs，避免同一 tick 内连续 closeTab 互相覆盖。 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

/**
 * 设置 → 存储与数据 → 本地备份与恢复。
 *
 * 后端负责书库/进度/统计/规则与 SQLite 设置；前端只负责把轻量偏好
 * （白名单）打包进导出请求、在恢复后写回 localStorage 并即时应用主题/语言。
 */
export default function DataBackupPanel({ onRestored }: DataBackupPanelProps) {
  const { t, locale, formatNumber, setLocale } = useI18n();
  const { setMode } = useTheme();
  const { tabs, closeTab } = useWorkspace();
  const [busy, setBusy] = useState<BusyState>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [pendingSkip, setPendingSkip] = useState<{ path: string; count: number } | null>(null);
  const [lastSkipped, setLastSkipped] = useState<SkippedBackupBook[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const filters = [
    { name: t("settings.backup.filterName"), extensions: BACKUP_EXTENSIONS },
  ];

  const onExport = async () => {
    if (busy) return;
    let path: string | null = null;
    try {
      path = await saveDialog({
        title: t("settings.backup.saveTitle"),
        defaultPath: backupFileName(),
        filters,
      });
    } catch {
      toast(t("settings.backup.error"));
      return;
    }
    // 取消保存：静默返回，不提示、不写文件。
    if (typeof path !== "string" || !path) return;

    setBusy("export");
    try {
      const result = await backupApi.exportBackup(
        path,
        captureBackupPreferences(),
      );
      if (!mountedRef.current) return;
      toast(
        t("settings.backup.exported", {
          books: formatNumber(result.books),
          size: formatBytes(result.bytes, locale),
        }),
      );
    } catch (e) {
      toastErr("export_backup", e);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const onPickRestore = async () => {
    if (busy) return;
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        title: t("settings.backup.pickTitle"),
        multiple: false,
        directory: false,
        filters,
      });
    } catch {
      toast(t("settings.backup.error"));
      return;
    }
    if (Array.isArray(picked)) picked = picked[0] ?? null;
    if (typeof picked !== "string" || !picked) return;
    setConfirmPath(picked);
  };

  const runRestore = async (path: string, allowSkipped = false) => {
    if (busy) return;
    setBusy("restore");
    setLastSkipped([]);
    try {
      const result = await backupApi.importBackup(path, allowSkipped);
      const skipped = result.skippedBooks ?? [];
      setLastSkipped(skipped);

      // 1) 偏好：白名单写回 + sanitize，随后即时应用主题/语言。
      const applied = applyBackupPreferences(result.preferencesJson);
      if (applied.theme) setMode(applied.theme);
      if (applied.locale) setLocale(applied.locale);

      // 2) 关掉所有旧阅读页签，避免恢复后旧 bookId 残留在工作区。
      const tabIds = tabs.map((tab) => tab.bookId);
      for (const bookId of tabIds) {
        closeTab(bookId);
        await nextTick();
      }

      // 3) 通知书库与设置页重新拉取数据。
      window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));

      // 4) 重新加载设置表单（SQLite 已由后端刷新）。
      await onRestored?.();

      if (!mountedRef.current) return;
      toast(
        t("settings.backup.restored", {
          books: formatNumber(result.books),
          days: formatNumber(result.readingDays),
        }),
      );
      if (result.preferencesJson) {
        toast(t("settings.backup.applied"));
      }
      if (skipped.length > 0) {
        toast(
          t("settings.backup.skippedCount", {
            count: formatNumber(skipped.length),
          }),
        );
      }
      // 前向兼容恢复（Windows 主线高版本导出的备份）：只提取了核心
      // 书库/进度/统计/规则，高版本新增的未知字段与表已按兼容模式丢弃。
      if (result.forwardSchema) {
        toast(
          t("settings.backup.forwardSchema", {
            version: result.appVersion ?? `v? (schema ${result.forwardSchema})`,
          }),
        );
      }
    } catch (e) {
      // 后端在"备份里有书路径不可达"时不会直接恢复，而是要求前端先确认：
      // 恢复会整库替换，这些书在当前库中的进度与历史会被移除。
      const needsConfirm = String(e).match(/restore-skipped-books:(\d+)/);
      if (needsConfirm && !allowSkipped) {
        setPendingSkip({ path, count: Number(needsConfirm[1]) });
        return;
      }
      toastErr("import_backup", e);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const exporting = busy === "export";
  const restoring = busy === "restore";
  const disabled = busy !== null;

  return (
    <>
      <SettingsSection
        icon={Archive}
        title={t("settings.backup.title")}
        description={t("settings.backup.description")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="pill-primary"
            size="pill"
            className="whitespace-nowrap"
            onClick={() => void onExport()}
            disabled={disabled}
          >
            {exporting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Download />
            )}
            {exporting
              ? t("settings.backup.exporting")
              : t("settings.backup.export")}
          </Button>
          <Button
            type="button"
            variant="pill"
            size="pill"
            className="whitespace-nowrap"
            onClick={() => void onPickRestore()}
            disabled={disabled}
          >
            {restoring ? <Loader2 className="animate-spin" /> : <Upload />}
            {restoring
              ? t("settings.backup.restoring")
              : t("settings.backup.restore")}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.backup.note")}
        </p>
      </SettingsSection>

      {lastSkipped.length > 0 ? (
        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4 shadow-hard-sm">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground">
                {t("settings.backup.skippedTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("settings.backup.skippedHint")}
              </p>
            </div>
          </div>
          <ul className="mt-3 max-h-52 space-y-1.5 overflow-y-auto pr-1">
            {lastSkipped.map((book) => (
              <li
                key={book.id}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-card/80 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={book.title}>
                  {book.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(
                    SKIP_REASON_KEYS[book.reason] ??
                      "settings.backup.skippedReasonMissing",
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pendingSkip ? (
        <ConfirmDialog
          title={t("settings.backup.skipWarningTitle")}
          message={t("settings.backup.skipWarningMessage", {
            count: formatNumber(pendingSkip.count),
          })}
          confirmText={t("settings.backup.confirmRestore")}
          onConfirm={() => {
            const path = pendingSkip.path;
            setPendingSkip(null);
            void runRestore(path, true);
          }}
          onCancel={() => setPendingSkip(null)}
        />
      ) : null}

      {confirmPath ? (
        <ConfirmDialog
          title={t("settings.backup.confirmTitle")}
          message={t("settings.backup.confirmMessage", {
            file: baseName(confirmPath),
          })}
          confirmText={t("settings.backup.confirmRestore")}
          onConfirm={() => {
            const path = confirmPath;
            setConfirmPath(null);
            if (path) void runRestore(path);
          }}
          onCancel={() => setConfirmPath(null)}
        />
      ) : null}
    </>
  );
}
