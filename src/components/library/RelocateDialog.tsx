import { useState } from "react";
import {
  AlertTriangle,
  FolderSearch,
  Loader2,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "@/i18n";
import { api, type BookInfo } from "@/lib/tauri";
import { toast, toastErr } from "@/components/Toast";
import { recordBreadcrumb } from "@/features/resilience";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  book: BookInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRelocated: (book: BookInfo) => void;
  onRemove: (book: BookInfo) => void;
}

/** 只展示 basename；完整路径不进入确认文案。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function isFileSourcePath(path: string): boolean {
  return /\.(zip|cbz|pdf)$/i.test(path.trim());
}

/**
 * 失效路径重定位引导：
 * - 文件源（zip / cbz / pdf）用文件选择器，文件夹源用目录选择器；
 * - 选中后由 Rust 事务迁移进度/统计/阅读历史，前端只负责打开新 id；
 * - 另一个出口是「从书库移除」，复用软删语义，源文件与记录都保留。
 */
export default function RelocateDialog({
  book,
  open,
  onOpenChange,
  onRelocated,
  onRemove,
}: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  const choose = async () => {
    if (!book || busy) return;
    const fileSource = isFileSourcePath(book.path);
    let picked: string | string[] | null = null;
    try {
      picked = fileSource
        ? await openDialog({
            title: t("import.filesTitle"),
            multiple: false,
            directory: false,
            filters: [
              {
                name: t("import.filesFilter"),
                extensions: ["zip", "cbz", "pdf"],
              },
            ],
          })
        : await openDialog({
            title: t("import.folderTitle"),
            multiple: false,
            directory: true,
          });
    } catch {
      toast(t("import.pickerUnavailable"));
      return;
    }
    const nextPath =
      typeof picked === "string"
        ? picked
        : Array.isArray(picked)
          ? (picked[0] ?? null)
          : null;
    if (!nextPath) return;

    setBusy(true);
    try {
      recordBreadcrumb("relocateBook");
      const updated = await api.relocateBook(book.id, nextPath);
      onRelocated(updated);
      onOpenChange(false);
    } catch (error) {
      toastErr("relocate_book", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open && book !== null} onOpenChange={(next) => !next && close()}>
      {book ? (
        <DialogContent
          showCloseButton={false}
          className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-hard sm:max-w-lg"
        >
          <DialogHeader className="gap-3 px-6 pb-4 pt-6">
            <span className="grid size-10 place-items-center rounded-full border border-border bg-warning/15 text-warning">
              <AlertTriangle className="size-5" aria-hidden />
            </span>
            <DialogTitle className="text-lg font-bold leading-snug tracking-tight">
              {t("card.missing")}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              {t("relocate.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="mx-6 mb-5 rounded-xl border border-border bg-muted/60 p-3">
            <p className="text-[11px] font-semibold text-muted-foreground">
              {t("relocate.currentPath", { name: baseName(book.path) })}
            </p>
            <p className="mt-1 truncate text-sm font-bold" title={book.title}>
              {book.title}
            </p>
          </div>

          <DialogFooter className="mx-0 mb-0 flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-border bg-muted/40 px-6 py-4 sm:justify-between">
            <Button
              type="button"
              variant="pill-danger"
              size="pill-sm"
              className="whitespace-nowrap"
              disabled={busy}
              onClick={() => onRemove(book)}
            >
              <Trash2 />
              {t("relocate.remove")}
            </Button>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <Button
                type="button"
                variant="pill"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={busy}
                onClick={close}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="pill-primary"
                size="pill-sm"
                className="whitespace-nowrap"
                disabled={busy}
                onClick={() => void choose()}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FolderSearch />
                )}
                {busy ? t("common.loading") : t("relocate.choose")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
