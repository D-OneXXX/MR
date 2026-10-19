import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Loader2, X } from "lucide-react";
import { api, type BookInfo } from "../lib/tauri";
import { toast, toastErr } from "./Toast";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
}

export default function OnlineImportDialog({ onClose, onImported, onRead }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "add" | "read" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // 关闭后（含父组件卸载）不再触发导入/阅读回调或写入结果。
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const close = useCallback(() => {
    aliveRef.current = false;
    onClose();
  }, [onClose]);

  // Esc 关闭；请求进行中时忽略，避免中途关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (busy !== null) {
        e.preventDefault();
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close]);

  const run = async (mode: "test" | "add" | "read") => {
    if (busy) return;
    if (!url.trim()) {
      setErr("请输入 JSON 清单或单页 HTML 图集 URL");
      return;
    }
    setBusy(mode);
    setErr(null);
    setProbe(null);
    try {
      if (mode === "test") {
        const p = await api.testOnlineConnection(url.trim());
        if (!aliveRef.current) return;
        setProbe(`${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`);
        if (!p.ok) setErr(p.message || "清单没有可读页面，无法入库");
      } else {
        const b = await api.resolveOnlineUrl(url.trim());
        if (!aliveRef.current) return;
        toast(`已加入：${b.title} · ${b.pageCount} 页`);
        onImported();
        if (mode === "read") onRead(b);
        close();
      }
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : "操作失败";
      setErr(msg);
      toastErr("online", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-mask" onClick={close} role="presentation">
      <div
        className="dialog online-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="URL 在线直读"
        onClick={(e) => e.stopPropagation()}
      >
        <h4>
          <Link2 size={15} /> URL 在线直读
        </h4>
        <p className="hint">
          粘贴 JSON 清单或单页 HTML 图集的 URL。只导入你信任的地址；当前版本不支持 Cookie、登录或需要脚本渲染的网页。
        </p>
        <input
          className="input mono"
          autoFocus
          value={url}
          disabled={busy !== null}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setErr(null);
            setProbe(null);
          }}
          placeholder="https://example.com/manifest.json 或 https://example.com/gallery.html"
          aria-label="JSON 清单或单页 HTML 图集 URL"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run("read");
            }
          }}
        />
        {err && <p className="hint online-error">{err}</p>}
        {probe && <p className="hint mono">{probe}</p>}
        <div className="dialog-actions">
          <button className="btn" onClick={() => void run("test")} disabled={busy !== null}>
            {busy === "test" ? <Loader2 size={14} className="online-spin" /> : null} 测试
          </button>
          <button className="btn" onClick={() => void run("add")} disabled={busy !== null}>
            {busy === "add" ? <Loader2 size={14} className="online-spin" /> : null} 仅加入书库
          </button>
          <button className="btn primary" onClick={() => void run("read")} disabled={busy !== null}>
            {busy === "read" ? <Loader2 size={14} className="online-spin" /> : null} 解析并直接阅读
          </button>
          <button className="btn" onClick={close} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
