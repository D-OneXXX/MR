import { useEffect, useState } from "react";

/** 错误 toast：直接展示后端 Err(String) 中文信息 */
export function toastErr(cmd: string, e: unknown): void {
  const msg = typeof e === "string" ? e : `调用 ${cmd} 失败`;
  toast(msg);
}

/** 轻量 toast：任意处调用 toast(msg)，由 <Toaster/> 渲染 */
export function toast(message: string): void {
  window.dispatchEvent(new CustomEvent<string>("app-toast", { detail: message }));
}

interface ToastItem {
  id: number;
  msg: string;
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      const id = nextId;
      nextId += 1;
      setItems((prev) => [...prev.slice(-3), { id, msg }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, 4200);
    };
    window.addEventListener("app-toast", handler);
    return () => window.removeEventListener("app-toast", handler);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toaster" aria-live="polite">
      {items.map((t) => (
        <button
          key={t.id}
          className="toast mono"
          onClick={() =>
            setItems((prev) => prev.filter((x) => x.id !== t.id))
          }
          title="点击关闭"
        >
          {t.msg}
        </button>
      ))}
    </div>
  );
}
