import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { translate, useI18n } from "@/i18n";

/** 错误 toast：直接展示后端 Err(String) 中文信息 */
export function toastErr(cmd: string, e: unknown): void {
  const msg =
    typeof e === "string" ? e : translate("error.requestFailed", { cmd });
  toast(msg);
}

type ToastListener = (message: string) => void;

const listeners = new Set<ToastListener>();
const pending: string[] = [];

/** 轻量 toast：任意处调用 toast(msg)，由当前挂载的 <Toaster/> 渲染 */
export function toast(message: string): void {
  if (listeners.size > 0) {
    listeners.forEach((listener) => listener(message));
    return;
  }
  pending.push(message);
  if (pending.length > 8) pending.shift();
}

interface ToastItem {
  id: number;
  msg: string;
}

export function Toaster() {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const handler: ToastListener = (msg) => {
      const id = nextId;
      nextId += 1;
      setItems((prev) => [...prev.slice(-3), { id, msg }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }, 4200);
    };
    listeners.add(handler);
    if (pending.length > 0) {
      pending.splice(0).forEach(handler);
    }
    return () => {
      listeners.delete(handler);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-[120] flex w-[min(92vw,460px)] -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm font-medium text-card-foreground shadow-hard"
          role="status"
        >
          <span className="min-w-0 flex-1 break-words">{item.msg}</span>
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              setItems((prev) => prev.filter((entry) => entry.id !== item.id))
            }
            aria-label={t("toast.close")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
