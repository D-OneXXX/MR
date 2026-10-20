import { useEffect, useState } from "react";

/** 错误 toast：直接展示后端 Err(String) 中文信息 */
export function toastErr(cmd: string, e: unknown): void {
  const msg = typeof e === "string" ? e : `调用 ${cmd} 失败`;
  toast(msg);
}

type ToastListener = (message: string) => void;

// 事件式改为「监听器 + 待投递队列」：页签切换/超限回退的瞬间可能没有 Toaster
// 挂载（例如路由层已拒绝挂载 Reader），消息先入队，等下一个 Toaster 挂载后补显示。
const listeners = new Set<ToastListener>();
const pending: string[] = [];

/** 轻量 toast：任意处调用 toast(msg)，由当前挂载的 <Toaster/> 渲染 */
export function toast(message: string): void {
  if (listeners.size > 0) {
    listeners.forEach((l) => l(message));
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
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let nextId = 1;
    const handler: ToastListener = (msg) => {
      const id = nextId;
      nextId += 1;
      setItems((prev) => [...prev.slice(-3), { id, msg }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
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
