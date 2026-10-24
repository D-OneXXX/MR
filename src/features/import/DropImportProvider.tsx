import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Upload } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { translate, useI18n } from "@/i18n";
import { api } from "@/lib/tauri";
import { LIBRARY_REFRESH_EVENT } from "@/lib/events";
import { localizeBackendError } from "@/features/errors/localize";
import { toast } from "@/components/Toast";

export interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

interface DropImportContextValue {
  /** 逐路径导入；全局单飞，任何页面拖放/按钮共用。 */
  importPaths: (paths: string[]) => Promise<void>;
  /** 当前导入进度；null 表示空闲。 */
  importing: ImportProgress | null;
}

const DropImportContext = createContext<DropImportContextValue | null>(null);

/**
 * 应用级拖放导入：Tauri 的 drag-drop 事件属于整个 WebView，而不是书库页。
 * 挂在路由之外后，阅读器/设置页拖入压缩包同样能入库；进度卡与失败聚合
 * 只有一份，单飞锁也天然覆盖跨页面重叠触发。
 */
export function DropImportProvider({ children }: { children: ReactNode }) {
  const { t, formatNumber } = useI18n();
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const guardRef = useRef(false);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (guardRef.current) {
        toast(translate("import.busy"));
        return;
      }
      const clean = paths.map((path) => path.trim()).filter(Boolean);
      if (clean.length === 0) return;
      guardRef.current = true;
      try {
        let added = 0;
        let restored = 0;
        let skipped = 0;
        let failed = 0;
        const failMsgs: string[] = [];
        for (let i = 0; i < clean.length; i += 1) {
          setImporting({ done: i, total: clean.length, current: clean[i] });
          try {
            const result = await api.importBooks([clean[i]]);
            added += result.added;
            restored += result.restored;
            skipped += result.skipped;
            failed += result.failed;
            for (const item of result.items) {
              if (item.status === "failed") {
                failMsgs.push(
                  translate("import.itemFailed", {
                    path: item.path,
                    message: localizeBackendError(item.message),
                  }),
                );
              }
            }
          } catch (e) {
            failed += 1;
            failMsgs.push(
              typeof e === "string" && e.length > 0
                ? localizeBackendError(e)
                : translate("import.failedFallback"),
            );
          }
        }
        // 书库页监听该事件重新拉取；其它页面无需关心。
        window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
        const parts = [
          translate("import.added", { count: formatNumber(added) }),
        ];
        if (restored > 0) {
          parts.push(
            translate("import.restored", { count: formatNumber(restored) }),
          );
        }
        if (skipped > 0) {
          parts.push(
            translate("import.inLibrary", { count: formatNumber(skipped) }),
          );
        }
        if (failed > 0) {
          parts.push(
            translate("import.failed", { count: formatNumber(failed) }),
          );
        }
        toast(translate("import.complete", { summary: parts.join(" · ") }));
        if (failMsgs.length > 1) {
          toast(
            translate("import.moreFailures", {
              count: formatNumber(failMsgs.length - 1),
            }),
          );
        }
        if (failMsgs.length > 0) toast(failMsgs[0]);
      } finally {
        guardRef.current = false;
        setImporting(null);
      }
    },
    [formatNumber, t],
  );

  // Tauri 拖放事件全局只注册一次；销毁时解除监听。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        setDragActive(false);
        if (payload.paths.length > 0) void importPaths(payload.paths);
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 非 Tauri 环境忽略 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths]);

  return (
    <DropImportContext.Provider value={{ importPaths, importing }}>
      {children}
      {importing &&
        createPortal(
          <div
            className="fade-in fixed bottom-6 right-5 z-[70] w-[min(320px,86vw)] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-hard"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">
                {t("import.progress", {
                  done: formatNumber(importing.done + 1),
                  total: formatNumber(importing.total),
                })}
              </span>
              <span className="ml-auto shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                {Math.round((importing.done / importing.total) * 100)}%
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${(importing.done / importing.total) * 100}%`,
                }}
              />
            </div>
            <div
              className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground"
              title={importing.current}
            >
              {importing.current}
            </div>
          </div>,
          document.body,
        )}
      {dragActive &&
        createPortal(
          <div className="fade-in pointer-events-none fixed inset-0 z-[110] flex items-center justify-center bg-background/70 p-8 backdrop-blur-sm">
            <div className="flex w-full max-w-lg flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card px-8 py-12 text-center shadow-hard">
              <span className="grid size-12 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-hard-sm">
                <Upload className="size-6" />
              </span>
              <p className="text-lg font-bold tracking-tight text-foreground">
                {t("import.dropTitle")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("import.dropHint")}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </DropImportContext.Provider>
  );
}

export function useDropImport(): DropImportContextValue {
  const value = useContext(DropImportContext);
  if (!value) {
    throw new Error("useDropImport must be used inside DropImportProvider");
  }
  return value;
}
