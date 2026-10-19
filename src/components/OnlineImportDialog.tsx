import { useState } from "react";
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

  const run = async (mode: "test" | "add" | "read") => {
    if (!url.trim()) {
      setErr("请输入 JSON 清单 URL");
      return;
    }
    setBusy(mode);
    setErr(null);
    setProbe(null);
    try {
      if (mode === "test") {
        const p = await api.testOnlineConnection(url.trim());
        setProbe(`${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`);
      } else {
        const b = await api.resolveOnlineUrl(url.trim());
        toast(`已加入：${b.title} · ${b.pageCount} 页`);
        onImported();
        if (mode === "read") onRead(b);
        onClose();
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : "操作失败";
      setErr(msg);
      toastErr("online", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose} role="presentation">
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
          粘贴 JSON 清单地址。只导入你信任的清单；当前版本不支持 Cookie、登录或 HTML 嗅探。
        </p>
        <input
          className="input mono"
          autoFocus
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setErr(null);
            setProbe(null);
          }}
          placeholder="https://example.com/manifest.json"
          aria-label="JSON 清单 URL"
          onKeyDown={(e) => {
            if (e.key === "Enter") void run("read");
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
          <button className="btn" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
