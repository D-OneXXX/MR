import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { Link2, Loader2, X } from "lucide-react";
import { api, type BookInfo, type BrowserHandoff } from "../lib/tauri";
import { toast, toastErr } from "./Toast";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
}

function parsePastedPageUrls(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON 格式不正确，请检查数组");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("请粘贴图片 URL 数组（pages 数组），而不是整个 JSON 对象");
    }
    const urls = parsed.map((item) => {
      if (typeof item === "string") return item.trim();
      if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as { url?: unknown }).url === "string"
      ) {
        return (item as { url: string }).url.trim();
      }
      return "";
    });
    if (urls.some((u) => !u)) {
      throw new Error("数组只能包含 URL 字符串或带 url 的对象");
    }
    return urls;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function copyHandoffText(label: string, value: string) {
  if (!value) {
    toast(`${label}为空，无法复制`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(`已复制${label}`);
  } catch {
    toastErr("clipboard", `复制失败，请手动选中${label}文本复制`);
  }
}

function CopyField({
  label,
  value,
  rows = 2,
}: {
  label: string;
  value: string;
  rows?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="field-row" style={{ alignItems: "center" }}>
        <span className="hint" style={{ flex: 1 }}>
          {label}
        </span>
        <button
          className="btn"
          type="button"
          aria-label={`复制${label}`}
          onClick={() => void copyHandoffText(label, value)}
        >
          复制
        </button>
      </div>
      <textarea
        className="input mono"
        readOnly
        rows={rows}
        value={value}
        aria-label={label}
        style={{ fontSize: "inherit", resize: "vertical" }}
      />
    </div>
  );
}

export const LIBRARY_REFRESH_EVENT = "mr-online-library-refresh";
const HANDOFF_STATE_EVENT = "mr-online-handoff-state";

export interface OnlineHandoffState {
  session: BrowserHandoff | null;
  books: BookInfo[];
}

let handoffSession: BrowserHandoff | null = null;
let handoffBooks: BookInfo[] = [];
let handoffListenersStarted = false;
let unlistenImported: (() => void) | undefined;
let unlistenStopped: (() => void) | undefined;

function getHandoffState(): OnlineHandoffState {
  return { session: handoffSession, books: handoffBooks };
}

function notifyHandoffState() {
  window.dispatchEvent(new CustomEvent(HANDOFF_STATE_EVENT));
}

function beginHandoffSession(session: BrowserHandoff) {
  handoffSession = session;
  handoffBooks = [];
  notifyHandoffState();
}

function clearHandoffSession(showToast: boolean) {
  const wasActive = handoffSession !== null || handoffBooks.length > 0;
  handoffSession = null;
  handoffBooks = [];
  notifyHandoffState();
  if (showToast && wasActive) toast("配对已停止");
}

export function useOnlineHandoffState(): OnlineHandoffState {
  const [state, setState] = useState<OnlineHandoffState>(getHandoffState);
  useEffect(() => {
    const onChange = () => setState(getHandoffState());
    window.addEventListener(HANDOFF_STATE_EVENT, onChange);
    return () => window.removeEventListener(HANDOFF_STATE_EVENT, onChange);
  }, []);
  return state;
}

function registerHandoffListener<T>(
  event: string,
  handler: (payload: T) => void,
  remember: (off: () => void) => void,
) {
  try {
    void listen<T>(event, (e) => handler(e.payload))
      .then((off) => {
        if (handoffListenersStarted) remember(off);
        else off();
      })
      .catch(() => {});
  } catch {
    /* 非 Tauri 环境 */
  }
}

function registerHandoffListeners() {
  if (handoffListenersStarted) return;
  handoffListenersStarted = true;

  registerHandoffListener<BookInfo[]>(
    "online-handoff-imported",
    (payload) => {
      const raw = payload as unknown;
      // 兼容后端从“单本 BookInfo”切到“BookInfo[]”的过渡窗口。
      const imported = Array.isArray(raw) ? (raw as BookInfo[]) : raw ? [raw as BookInfo] : [];
      if (imported.length > 0) {
        const previous = handoffBooks;
        handoffBooks = [
          ...imported,
          ...previous.filter((old) => !imported.some((book) => book.id === old.id)),
        ];
        const titles = imported.map((b) => b.title).filter(Boolean);
        const shown = titles.slice(0, 3).join("、");
        toast(
          `已导入 ${imported.length} 本${shown ? `：${shown}${titles.length > 3 ? "…" : ""}` : ""}`,
        );
      } else {
        toast("已导入 0 本");
      }
      notifyHandoffState();
      window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
    },
    (off) => {
      unlistenImported = off;
    },
  );

  registerHandoffListener<void>(
    "online-handoff-stopped",
    () => {
      clearHandoffSession(true);
    },
    (off) => {
      unlistenStopped = off;
    },
  );
}

registerHandoffListeners();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unlistenImported?.();
    unlistenStopped?.();
    unlistenImported = undefined;
    unlistenStopped = undefined;
    handoffListenersStarted = false;
  });
}

export default function OnlineImportDialog({ onClose, onImported, onRead }: Props) {
  const nav = useNavigate();
  const { session: handoff, books: handoffBooks } = useOnlineHandoffState();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<
    "test" | "add" | "read" | "paste" | "batch" | "handoff" | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [stoppingHandoff, setStoppingHandoff] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // 关闭后（含父组件卸载）不再触发普通导入/阅读回调或写入结果。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const close = useCallback(() => {
    aliveRef.current = false;
    onClose();
  }, [onClose]);

  // Esc 关闭；普通请求进行中时忽略。配对桥接是长驻的，关闭不会停止它。
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
    if (busy !== null) return;
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

  const startHandoff = async () => {
    if (busy !== null || handoff !== null) return;
    if (!url.trim()) {
      setErr("请输入要打开的 URL");
      return;
    }
    setBusy("handoff");
    setErr(null);
    setProbe(null);
    setPasteErr(null);
    setBatchErr(null);
    setPasteOpen(false);
    setBatchOpen(false);
    try {
      const info = await api.startBrowserHandoff(url.trim());
      beginHandoffSession(info);
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : "启动外部浏览器协同失败";
      setErr(msg);
      toastErr("start_browser_handoff", e);
    } finally {
      setBusy(null);
    }
  };

  const stopHandoff = async () => {
    if (stoppingHandoff) return;
    setStoppingHandoff(true);
    try {
      await api.stopBrowserHandoff();
      clearHandoffSession(true);
    } catch (e) {
      toastErr("stop_browser_handoff", e);
    } finally {
      setStoppingHandoff(false);
    }
  };

  const openAuxBrowser = async () => {
    if (busy !== null || openingBrowser) return;
    if (!url.trim()) {
      setErr("请输入要打开的 URL");
      return;
    }
    setOpeningBrowser(true);
    try {
      await api.openBrowserWindow(url.trim());
    } catch (e) {
      toastErr("open_browser_window", e);
    } finally {
      setOpeningBrowser(false);
    }
  };

  const importPasted = async () => {
    if (busy !== null) return;
    if (!url.trim()) {
      setPasteErr("请先在上方填写页面 URL");
      return;
    }
    let pageUrls: string[];
    try {
      pageUrls = parsePastedPageUrls(pasteText);
    } catch (e) {
      setPasteErr(e instanceof Error ? e.message : "图片列表解析失败");
      return;
    }
    if (pageUrls.length === 0) {
      setPasteErr("请至少提供一张图片 URL");
      return;
    }
    setBusy("paste");
    setErr(null);
    setProbe(null);
    setPasteErr(null);
    try {
      await api.importResolvedPages(url.trim(), pasteTitle.trim(), pageUrls);
      if (!aliveRef.current) return;
      toast("已加入书库");
      setPasteOpen(false);
      setPasteText("");
      setPasteTitle("");
      onImported();
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : "导入失败";
      setPasteErr(msg);
      toastErr("import_resolved_pages", e);
    } finally {
      setBusy(null);
    }
  };

  const importBatch = async () => {
    if (busy !== null) return;
    if (!batchText.trim()) {
      setBatchErr("请粘贴 JSON 清单");
      return;
    }
    setBusy("batch");
    setErr(null);
    setProbe(null);
    setPasteErr(null);
    setBatchErr(null);
    try {
      const books = await api.importOnlineBatch(batchText);
      if (!aliveRef.current) return;
      toast(`已导入 ${books.length} 本`);
      setBatchOpen(false);
      setBatchText("");
      onImported();
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : "导入失败";
      setBatchErr(msg);
      toastErr("import_online_batch", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="dialog-mask"
      onClick={() => {
        // 普通请求进行中禁止关闭；长驻配对关闭后保留。
        if (busy === null) close();
      }}
      role="presentation"
    >
      <div
        className="dialog online-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="URL 在线直读"
        aria-busy={busy !== null}
        style={{ maxHeight: "calc(100vh - 96px)", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h4>
          <Link2 size={15} /> URL 在线直读
        </h4>
        <p className="hint">
          粘贴 JSON 清单或单页 HTML 图集的 URL。可在设置中手动填写 Cookie /
          Authorization / 自定义请求头；不支持自动登录或需要脚本渲染的网页。
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
            setPasteErr(null);
            setBatchErr(null);
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
        {busy !== null && <p className="hint">正在处理，完成前无法关闭…</p>}

        {handoffBooks.length > 0 && (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              maxHeight: 190,
              overflowY: "auto",
            }}
          >
            <strong>已导入 {handoffBooks.length} 本</strong>
            {handoffBooks.map((item) => (
              <div
                className="field-row"
                key={item.id}
                style={{ alignItems: "center", gap: 8 }}
              >
                <span
                  className="hint"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={item.title}
                >
                  {item.title}
                </span>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => nav(`/reader/${encodeURIComponent(item.id)}`)}
                >
                  立即阅读
                </button>
              </div>
            ))}
          </div>
        )}

        {handoff && (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div className="field-row" style={{ alignItems: "center" }}>
              <strong>配对中：本地回环已就绪，等待浏览器推送</strong>
              <button
                className="btn"
                type="button"
                style={{ marginLeft: "auto" }}
                onClick={() => void stopHandoff()}
                disabled={stoppingHandoff}
              >
                {stoppingHandoff ? "停止中…" : "停止配对"}
              </button>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              在系统浏览器中手动执行下面的书签或控制台脚本；脚本只读取当前页面已渲染的图片地址，不读取
              Cookie、不做翻页爬取。脚本会用 localStorage 累积多话，收集后一次推送整段合集；如需携带自己的请求头，编辑脚本里的
              MR_SESSION_HEADERS 常量（应用只在内存使用，不落盘、不记日志）。控制台可用
              MR_BRIDGE.reset() 清空已收集内容。
            </p>
            <CopyField
              label="回调地址（callback_url）"
              value={handoff.callbackUrl}
            />
            <CopyField
              label="书签脚本（bookmarklet，可直接存为书签）"
              value={handoff.bookmarklet}
            />
            <CopyField
              label="控制台脚本（script，纯文本 JS）"
              value={handoff.script}
              rows={8}
            />
          </div>
        )}

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
          <button
            className="btn"
            onClick={close}
            disabled={busy !== null}
            title={busy !== null ? "处理进行中，完成前无法关闭" : "关闭"}
          >
            <X size={14} />
          </button>
        </div>

        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {!handoff && (
            <button
              className="btn"
              type="button"
              onClick={() => void startHandoff()}
              disabled={busy !== null}
            >
              {busy === "handoff" ? (
                <Loader2 size={14} className="online-spin" />
              ) : null}{" "}
              在系统浏览器中打开并等待回传
            </button>
          )}

          <div className="field-row" style={{ alignItems: "center" }}>
            <button
              className="btn"
              type="button"
              onClick={() => void openAuxBrowser()}
              disabled={busy !== null || openingBrowser}
            >
              {openingBrowser ? <Loader2 size={14} className="online-spin" /> : null}
              打开辅助浏览窗口
            </button>
            <span className="hint" style={{ flex: 1, minWidth: 0 }}>
              在窗口内自行完成登录与浏览；文件下载完成后会自动导入书库
            </span>
          </div>

          <button
            className="btn"
            type="button"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              setPasteOpen((open) => !open);
              setPasteErr(null);
            }}
            disabled={busy !== null}
          >
            粘贴图片 URL 列表导入
          </button>

          {pasteOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                className="input mono"
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.currentTarget.value)}
                placeholder="标题（可留空，由后端按 URL 回退命名）"
                aria-label="图片清单标题"
                disabled={busy !== null}
              />
              <textarea
                className="input mono"
                rows={5}
                style={{ fontSize: "inherit", resize: "vertical" }}
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.currentTarget.value);
                  setPasteErr(null);
                }}
                placeholder={
                  '每行一个图片 URL\n或 JSON 数组：["https://example.com/1.jpg", ...]'
                }
                aria-label="图片 URL 列表"
                disabled={busy !== null}
              />
              <p className="hint" style={{ margin: 0 }}>
                页面 URL 使用上方输入框；仅提交你手动提供的图片地址，不读取网页内容。
              </p>
              {pasteErr && <p className="hint online-error">{pasteErr}</p>}
              <div className="dialog-actions">
                <button
                  className="btn"
                  onClick={() => {
                    setPasteOpen(false);
                    setPasteErr(null);
                  }}
                  disabled={busy !== null}
                >
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => void importPasted()}
                  disabled={busy !== null || !pasteText.trim()}
                >
                  {busy === "paste" ? (
                    <Loader2 size={14} className="online-spin" />
                  ) : null}{" "}
                  导入
                </button>
              </div>
            </div>
          )}

          <button
            className="btn"
            type="button"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              setBatchOpen((open) => !open);
              setBatchErr(null);
            }}
            disabled={busy !== null}
          >
            批量导入清单 JSON
          </button>

          {batchOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                className="input mono"
                rows={6}
                style={{ fontSize: "inherit", resize: "vertical" }}
                value={batchText}
                onChange={(e) => {
                  setBatchText(e.currentTarget.value);
                  setBatchErr(null);
                }}
                placeholder={
                  '粘贴 JSON：单本清单，或包含 chapters 的合集结构\n例如 {"chapters":[...]}'
                }
                aria-label="批量导入 JSON"
                disabled={busy !== null}
              />
              <p className="hint" style={{ margin: 0 }}>
                仅接收你手动粘贴的 JSON 文本；不读取网页内容、不采集 Cookie。
              </p>
              {batchErr && <p className="hint online-error">{batchErr}</p>}
              <div className="dialog-actions">
                <button
                  className="btn"
                  onClick={() => {
                    setBatchOpen(false);
                    setBatchErr(null);
                  }}
                  disabled={busy !== null}
                >
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => void importBatch()}
                  disabled={busy !== null || !batchText.trim()}
                >
                  {busy === "batch" ? (
                    <Loader2 size={14} className="online-spin" />
                  ) : null}{" "}
                  导入
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
