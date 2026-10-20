import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, Link2, Loader2, X } from "lucide-react";
import { api, type BookInfo, type HandoffStatus } from "../lib/tauri";
import { toast, toastErr } from "./Toast";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
  initialTab?: "link" | "pair";
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

async function copyHandoffText(label: string, value: string): Promise<boolean> {
  if (!value) {
    toast(`${label}为空，无法复制`);
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(`已复制${label}`);
    return true;
  } catch {
    toastErr("clipboard", `复制失败，请在弹窗中手动复制${label}`);
    try {
      window.prompt(`复制${label}（手动全选复制）`, value);
    } catch {
      /* 忽略 */
    }
    return false;
  }
}

function CopyAction({
  label,
  toastLabel,
  value,
}: {
  label: string;
  toastLabel: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return (
    <button
      className="btn"
      type="button"
      disabled={!value}
      onClick={async () => {
        if (!(await copyHandoffText(toastLabel, value))) return;
        setCopied(true);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "已复制" : label}
    </button>
  );
}

export const LIBRARY_REFRESH_EVENT = "mr-online-library-refresh";
const HANDOFF_STATE_EVENT = "mr-online-handoff-state";

export interface OnlineHandoffState {
  status: HandoffStatus | null;
}

let handoffStatus: HandoffStatus | null = null;
let handoffListenersStarted = false;
let statusRequestSeq = 0;
let unlistenImported: (() => void) | undefined;
let unlistenStopped: (() => void) | undefined;

function getHandoffState(): OnlineHandoffState {
  return { status: handoffStatus };
}

function notifyHandoffState() {
  window.dispatchEvent(new CustomEvent(HANDOFF_STATE_EVENT));
}

function applyHandoffStatus(status: HandoffStatus) {
  statusRequestSeq += 1;
  handoffStatus = status.active ? status : null;
  notifyHandoffState();
}

async function refreshHandoffStatus() {
  const seq = ++statusRequestSeq;
  try {
    const status = await api.getBrowserHandoffStatus();
    if (seq !== statusRequestSeq) return;
    handoffStatus = status.active ? status : null;
    notifyHandoffState();
  } catch {
    /* 契约未落盘或后端不可用时保持当前状态 */
  }
}

function clearHandoffStatus(showToast: boolean) {
  statusRequestSeq += 1;
  const wasActive = handoffStatus?.active ?? false;
  handoffStatus = null;
  notifyHandoffState();
  if (showToast && wasActive) toast("配对已停止");
}

export function useOnlineHandoffState(): OnlineHandoffState {
  const [state, setState] = useState<OnlineHandoffState>(getHandoffState);
  useEffect(() => {
    const onChange = () => setState(getHandoffState());
    window.addEventListener(HANDOFF_STATE_EVENT, onChange);
    void refreshHandoffStatus();
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
      const imported = Array.isArray(raw) ? (raw as BookInfo[]) : raw ? [raw as BookInfo] : [];
      if (imported.length > 0 && handoffStatus?.active) {
        handoffStatus = {
          ...handoffStatus,
          receivedChapters: handoffStatus.receivedChapters + imported.length,
        };
        notifyHandoffState();
      }
      void refreshHandoffStatus();
      // Toast、书库刷新与角标由 Shell 的全局监听负责，避免重复提示。
    },
    (off) => {
      unlistenImported = off;
    },
  );

  registerHandoffListener<void>(
    "online-handoff-stopped",
    () => {
      clearHandoffStatus(true);
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

export default function OnlineImportDialog({
  onClose,
  onImported,
  onRead,
  initialTab = "link",
}: Props) {
  const { status } = useOnlineHandoffState();
  const [tab, setTab] = useState<"link" | "pair">(initialTab);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "add" | "read" | "paste" | "batch" | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [openingCurrentUrl, setOpeningCurrentUrl] = useState(false);
  const [startingHandoff, setStartingHandoff] = useState(false);
  const [stoppingHandoff, setStoppingHandoff] = useState(false);
  const [allowSessionHeaders, setAllowSessionHeaders] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [batchText, setBatchText] = useState("");
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (status?.active) setAllowSessionHeaders(status.allowSessionHeaders);
  }, [status?.active, status?.allowSessionHeaders]);

  useEffect(() => {
    if (tab === "pair") void refreshHandoffStatus();
  }, [tab]);

  const close = useCallback(() => {
    aliveRef.current = false;
    onClose();
  }, [onClose]);

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
      setBatchErr("请粘贴多话合集 JSON");
      return;
    }
    setBusy("batch");
    setErr(null);
    setProbe(null);
    setPasteErr(null);
    setBatchErr(null);
    try {
      const books = await api.resolveOnlineBatch(batchText);
      if (!aliveRef.current) return;
      toast(`合集已导入：${books.length} 本`);
      setBatchText("");
      onImported();
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : "导入失败";
      setBatchErr(msg);
      toastErr("resolve_online_batch", e);
    } finally {
      setBusy(null);
    }
  };

  const startPairing = async () => {
    if (startingHandoff) return;
    setStartingHandoff(true);
    try {
      const next = await api.startBrowserHandoff(allowSessionHeaders);
      applyHandoffStatus(next);
    } catch (e) {
      toastErr("start_browser_handoff", e);
    } finally {
      setStartingHandoff(false);
    }
  };

  const stopPairing = async () => {
    if (stoppingHandoff) return;
    setStoppingHandoff(true);
    try {
      await api.stopBrowserHandoff();
      clearHandoffStatus(true);
    } catch (e) {
      toastErr("stop_browser_handoff", e);
    } finally {
      setStoppingHandoff(false);
    }
  };

  const openCurrentUrl = async () => {
    if (openingCurrentUrl) return;
    const target = url.trim();
    if (!target) {
      toast("请先在「链接 / 清单导入」填写 URL");
      return;
    }
    setOpeningCurrentUrl(true);
    try {
      await openUrl(target);
    } catch (e) {
      toastErr("open_url", e);
    } finally {
      setOpeningCurrentUrl(false);
    }
  };

  const interfaceInfo = status?.active
    ? `Callback URL: ${status.callbackUrl}\nPairing Token: ${status.pairingToken}`
    : "";

  return (
    <div
      className="dialog-mask"
      onClick={() => {
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
        <div className="field-row" style={{ alignItems: "center" }}>
          <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
            <Link2 size={15} /> URL 在线直读
          </h4>
          <button
            className="btn"
            type="button"
            style={{ marginLeft: "auto" }}
            onClick={close}
            disabled={busy !== null}
            title={busy !== null ? "处理进行中，完成前无法关闭" : "关闭"}
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="seg online-tabs" role="tablist" aria-label="导入方式">
          <button
            role="tab"
            aria-selected={tab === "link"}
            className={tab === "link" ? "on" : ""}
            onClick={() => setTab("link")}
            disabled={busy !== null}
          >
            链接 / 清单导入
          </button>
          <button
            role="tab"
            aria-selected={tab === "pair"}
            className={tab === "pair" ? "on" : ""}
            onClick={() => setTab("pair")}
            disabled={busy !== null}
          >
            外部浏览器配对
          </button>
        </div>

        {tab === "link" ? (
          <div className="online-tab-panel" role="tabpanel" aria-label="链接 / 清单导入">
            <p className="hint" style={{ margin: 0 }}>
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

            <div className="field">
              <span>多话合集 JSON</span>
              <textarea
                className="input mono"
                rows={4}
                style={{ fontSize: "inherit", resize: "vertical" }}
                value={batchText}
                onChange={(e) => {
                  setBatchText(e.currentTarget.value);
                  setBatchErr(null);
                }}
                placeholder={
                  '{"version":1,"seriesTitle":"...","chapters":[...]}'
                }
                aria-label="多话合集 JSON"
                disabled={busy !== null}
              />
              <span className="hint">
                粘贴包含 chapters 的合集结构；导入成功后刷新书库。
              </span>
              {batchErr && <p className="hint online-error">{batchErr}</p>}
              <div className="field-row" style={{ justifyContent: "flex-end" }}>
                <button
                  className="btn primary"
                  onClick={() => void importBatch()}
                  disabled={busy !== null || !batchText.trim()}
                >
                  {busy === "batch" ? (
                    <Loader2 size={14} className="online-spin" />
                  ) : null}{" "}
                  导入合集
                </button>
              </div>
            </div>

            <div className="dialog-actions">
              <button
                className="btn"
                onClick={() => void run("test")}
                disabled={busy !== null}
              >
                {busy === "test" ? <Loader2 size={14} className="online-spin" /> : null} 测试
              </button>
              <button
                className="btn"
                onClick={() => void run("add")}
                disabled={busy !== null}
              >
                {busy === "add" ? <Loader2 size={14} className="online-spin" /> : null} 仅加入书库
              </button>
              <button
                className="btn primary"
                onClick={() => void run("read")}
                disabled={busy !== null}
              >
                {busy === "read" ? (
                  <Loader2 size={14} className="online-spin" />
                ) : null}{" "}
                解析并直接阅读
              </button>
            </div>
          </div>
        ) : (
          <div className="online-tab-panel" role="tabpanel" aria-label="外部浏览器配对">
            <div className="status-pill">
              <span className={`status-dot${status?.active ? " active" : ""}`} />
              {status?.active ? (
                <span
                  className="mono"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  127.0.0.1:{status.port} · 已接收 {status.receivedChapters} 话
                </span>
              ) : (
                <span style={{ flex: 1 }}>本地回环桥接未启动</span>
              )}
              {status?.active ? (
                <button
                  className="btn"
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() => void stopPairing()}
                  disabled={stoppingHandoff}
                >
                  {stoppingHandoff ? "停止中…" : "停止监听"}
                </button>
              ) : (
                <button
                  className="btn primary"
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() => void startPairing()}
                  disabled={startingHandoff}
                >
                  {startingHandoff ? "启动中…" : "启动配对监听"}
                </button>
              )}
            </div>

            <div className="field">
              <span>Callback URL</span>
              <input
                className="input mono"
                readOnly
                value={status?.callbackUrl ?? ""}
                placeholder="启动配对后生成"
                aria-label="Callback URL"
              />
            </div>
            <div className="field">
              <span>Pairing Token</span>
              <input
                className="input mono"
                readOnly
                value={status?.pairingToken ?? ""}
                placeholder="启动配对后生成"
                aria-label="Pairing Token"
              />
            </div>

            <div className="field-row" style={{ flexWrap: "wrap" }}>
              <CopyAction
                label="复制接口信息"
                toastLabel="接口信息"
                value={interfaceInfo}
              />
              <CopyAction
                label="复制推送模板（Fetch JSON）"
                toastLabel="推送模板"
                value={status?.script ?? ""}
              />
            </div>

            <p className="hint" style={{ margin: 0 }}>
              脚本由你在自己的浏览器中手动执行，只读取当前页面已渲染的图片地址；不读取
              Cookie、不做翻页爬取。脚本会用 localStorage 累积多话并一次推送整段合集；如需携带自己的请求头，编辑脚本里的
              MR_SESSION_HEADERS 常量（应用只在内存使用，不落盘、不记日志）。控制台可用
              MR_BRIDGE.reset() 清空收集。
            </p>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={allowSessionHeaders}
                onChange={(e) => setAllowSessionHeaders(e.currentTarget.checked)}
                disabled={status?.active || startingHandoff || stoppingHandoff}
                style={{ marginTop: 2 }}
              />
              <span>允许接收临时请求头至内存（退出应用即焚，不写入数据库）</span>
            </label>
            {status?.active && (
              <span className="hint">修改此开关需先停止监听，再重新启动配对。</span>
            )}

            <div className="field-row" style={{ alignItems: "center" }}>
              <button
                className="btn"
                type="button"
                onClick={() => void openCurrentUrl()}
                disabled={openingCurrentUrl}
              >
                {openingCurrentUrl ? <Loader2 size={14} className="online-spin" /> : null}
                在系统浏览器打开当前 URL
              </button>
              <span className="hint" style={{ flex: 1, minWidth: 0 }}>
                当前 URL 取自「链接 / 清单导入」标签页
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
