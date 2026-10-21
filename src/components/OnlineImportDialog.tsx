import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  AppWindow,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileJson,
  Globe,
  Images,
  Link2,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, type BookInfo, type HandoffStatus } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast, toastErr } from "@/components/Toast";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
  initialTab?: "link" | "pair";
  initialUrl?: string;
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

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = useCallback(async (toastLabel: string, value: string) => {
    if (!(await copyHandoffText(toastLabel, value))) return;
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  }, []);

  return { copied, copy };
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
  const { copied, copy } = useCopyFeedback();
  return (
    <Button
      type="button"
      variant="pill"
      size="pill-sm"
      disabled={!value}
      onClick={() => void copy(toastLabel, value)}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : label}
    </Button>
  );
}

function CopyIconButton({
  label,
  toastLabel,
  value,
}: {
  label: string;
  toastLabel: string;
  value: string;
}) {
  const { copied, copy } = useCopyFeedback();
  return (
    <Button
      type="button"
      variant="pill"
      size="pill-icon-sm"
      disabled={!value}
      onClick={() => void copy(toastLabel, value)}
      aria-label={label}
      title={label}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function InlineNotice({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  const error = tone === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs",
        error
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-success/40 bg-success/10 text-success",
      )}
    >
      {error ? (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

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
      const imported = Array.isArray(raw)
        ? (raw as BookInfo[])
        : raw
          ? [raw as BookInfo]
          : [];
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
  initialUrl = "",
}: Props) {
  const { status } = useOnlineHandoffState();
  const [tab, setTab] = useState<"link" | "pair">(initialTab);
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState<
    "test" | "add" | "read" | "paste" | "batch" | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [openingCurrentUrl, setOpeningCurrentUrl] = useState(false);
  const [startingHandoff, setStartingHandoff] = useState(false);
  const [stoppingHandoff, setStoppingHandoff] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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

  const handleOpenChange = (next: boolean) => {
    if (next) return;
    if (busy !== null) return;
    close();
  };

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
        setProbe({
          text: `${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`,
          ok: p.ok,
        });
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

  const refreshStatus = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshHandoffStatus();
    } finally {
      setRefreshing(false);
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
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-busy={busy !== null}
        className="max-h-[calc(100vh-3rem)] w-[min(660px,94vw)]! max-w-[min(660px,94vw)]! grid-rows-[auto_minmax(0,1fr)] gap-0! overflow-hidden rounded-2xl! border border-border bg-popover p-0! shadow-hard sm:max-w-[660px]!"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-secondary text-secondary-foreground">
            <Link2 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-bold text-foreground">
              URL 在线直读
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              JSON 清单、单页图集与外部浏览器配对导入
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="pill-ghost"
            size="pill-icon-sm"
            onClick={close}
            disabled={busy !== null}
            title={busy !== null ? "处理进行中，完成前无法关闭" : "关闭"}
            aria-label="关闭"
          >
            <X />
          </Button>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === "link" || value === "pair") setTab(value);
          }}
          className="flex min-h-0 flex-col gap-0"
        >
          <div className="shrink-0 px-5 pt-3">
            <TabsList
              className="h-auto w-full! flex-wrap justify-start gap-1 rounded-full border border-border bg-card p-1.5 shadow-hard-sm group-data-horizontal/tabs:h-auto"
              aria-label="导入方式"
            >
              <TabsTrigger
                value="link"
                disabled={busy !== null}
                className="h-9 flex-none gap-2 rounded-full border border-transparent px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
              >
                链接 / 清单导入
              </TabsTrigger>
              <TabsTrigger
                value="pair"
                disabled={busy !== null}
                className="h-9 flex-none gap-2 rounded-full border border-transparent px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
              >
                外部浏览器配对
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
            <TabsContent
              value="link"
              aria-label="链接 / 清单导入"
              className="flex flex-col gap-4"
            >
              <p className="text-xs leading-relaxed text-muted-foreground">
                粘贴 JSON 清单或单页 HTML 图集的 URL。可在设置中手动填写 Cookie /
                Authorization / 自定义请求头；不支持自动登录或需要脚本渲染的网页。
              </p>

              <Card className="gap-3 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="online-import-url"
                    className="text-xs text-muted-foreground"
                  >
                    清单 / 图集 URL
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="online-import-url"
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
                      className="h-10 font-mono text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void run("read");
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      className="shrink-0"
                      onClick={() => void run("test")}
                      disabled={busy !== null}
                    >
                      {busy === "test" ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      测试
                    </Button>
                  </div>
                </div>

                {err && <InlineNotice tone="error">{err}</InlineNotice>}
                {probe && (
                  <InlineNotice tone={probe.ok ? "success" : "error"}>
                    {probe.text}
                  </InlineNotice>
                )}
                {busy !== null && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在处理，完成前无法关闭…
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="pill"
                    size="pill-sm"
                    onClick={() => void openAuxBrowser()}
                    disabled={busy !== null || openingBrowser}
                  >
                    {openingBrowser ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <AppWindow />
                    )}
                    打开辅助浏览窗口
                  </Button>
                  <Button
                    type="button"
                    variant="pill-ghost"
                    size="pill-sm"
                    onClick={() => void openCurrentUrl()}
                    disabled={busy !== null || openingCurrentUrl}
                  >
                    {openingCurrentUrl ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Globe />
                    )}
                    系统浏览器
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  在窗口内自行完成登录与浏览；文件下载完成后会自动导入书库。
                </p>
              </Card>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  onClick={() => void run("add")}
                  disabled={busy !== null}
                >
                  {busy === "add" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <BookOpen />
                  )}
                  仅加入书库
                </Button>
                <Button
                  type="button"
                  variant="pill-primary"
                  size="pill"
                  onClick={() => void run("read")}
                  disabled={busy !== null}
                  title="解析并直接阅读"
                >
                  {busy === "read" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <BookOpen />
                  )}
                  加入并阅读
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  className="self-start"
                  aria-expanded={pasteOpen}
                  onClick={() => {
                    setPasteOpen((open) => !open);
                    setPasteErr(null);
                  }}
                  disabled={busy !== null}
                >
                  <Images />
                  粘贴图片 URL 列表导入
                  <ChevronDown
                    className={cn(
                      "transition-transform",
                      pasteOpen && "rotate-180",
                    )}
                  />
                </Button>

                {pasteOpen && (
                  <Card className="gap-3 rounded-2xl border-border bg-card p-4 shadow-hard-sm">
                    <div className="flex flex-col gap-1.5">
                      <Label
                        htmlFor="online-paste-title"
                        className="text-xs text-muted-foreground"
                      >
                        标题
                      </Label>
                      <Input
                        id="online-paste-title"
                        value={pasteTitle}
                        onChange={(e) => setPasteTitle(e.currentTarget.value)}
                        placeholder="标题（可留空，由后端按 URL 回退命名）"
                        aria-label="图片清单标题"
                        disabled={busy !== null}
                        className="h-9 text-xs"
                      />
                    </div>
                    <Textarea
                      rows={5}
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
                      className="font-mono text-xs"
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      页面 URL 使用上方输入框；仅提交你手动提供的图片地址，不读取网页内容。
                    </p>
                    {pasteErr && (
                      <InlineNotice tone="error">{pasteErr}</InlineNotice>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="pill"
                        size="pill-sm"
                        onClick={() => {
                          setPasteOpen(false);
                          setPasteErr(null);
                        }}
                        disabled={busy !== null}
                      >
                        取消
                      </Button>
                      <Button
                        type="button"
                        variant="pill-primary"
                        size="pill-sm"
                        onClick={() => void importPasted()}
                        disabled={busy !== null || !pasteText.trim()}
                      >
                        {busy === "paste" ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        导入
                      </Button>
                    </div>
                  </Card>
                )}
              </div>

              <Card className="gap-3 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex items-center gap-2">
                  <FileJson className="size-4 text-muted-foreground" />
                  <Label
                    htmlFor="online-batch"
                    className="text-sm font-semibold text-foreground"
                  >
                    多话合集 JSON
                  </Label>
                  <Badge variant="muted" className="ml-auto">
                    合集
                  </Badge>
                </div>
                <Textarea
                  id="online-batch"
                  rows={4}
                  value={batchText}
                  onChange={(e) => {
                    setBatchText(e.currentTarget.value);
                    setBatchErr(null);
                  }}
                  placeholder={'{"version":1,"seriesTitle":"...","chapters":[...]}'}
                  aria-label="多话合集 JSON"
                  disabled={busy !== null}
                  className="font-mono text-xs"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  粘贴包含 chapters 的合集结构；导入成功后刷新书库。
                </p>
                {batchErr && <InlineNotice tone="error">{batchErr}</InlineNotice>}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="pill-primary"
                    size="pill-sm"
                    onClick={() => void importBatch()}
                    disabled={busy !== null || !batchText.trim()}
                  >
                    {busy === "batch" ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
                    导入合集
                  </Button>
                </div>
              </Card>
            </TabsContent>

            <TabsContent
              value="pair"
              aria-label="外部浏览器配对"
              className="flex flex-col gap-3"
            >
              <Card className="gap-3 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex items-center gap-2">
                  <Radio
                    className={cn(
                      "size-4 shrink-0",
                      status?.active
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {status?.active ? "配对监听中" : "配对未启动"}
                      </span>
                      <Badge variant={status?.active ? "success" : "muted"}>
                        {status?.active ? "在线" : "空闲"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {status?.active
                        ? `127.0.0.1:${status.port} · 已接收 ${status.receivedChapters} 话`
                        : "本地回环桥接未启动"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="pill-ghost"
                    size="pill-icon-sm"
                    onClick={() => void refreshStatus()}
                    disabled={refreshing}
                    aria-label="刷新配对状态"
                    title="刷新配对状态"
                  >
                    <RefreshCw
                      className={cn(refreshing && "animate-spin")}
                    />
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {status?.active ? (
                    <Button
                      type="button"
                      variant="pill-danger"
                      size="pill-sm"
                      onClick={() => void stopPairing()}
                      disabled={stoppingHandoff}
                    >
                      {stoppingHandoff ? "停止中…" : "停止监听"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="pill-primary"
                      size="pill-sm"
                      onClick={() => void startPairing()}
                      disabled={startingHandoff}
                    >
                      {startingHandoff ? "启动中…" : "启动配对监听"}
                    </Button>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    接收的章节会自动加入书库
                  </span>
                </div>
              </Card>

              <div className="grid gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="handoff-callback"
                    className="text-xs text-muted-foreground"
                  >
                    Callback URL
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="handoff-callback"
                      readOnly
                      value={status?.callbackUrl ?? ""}
                      placeholder="启动配对后生成"
                      aria-label="Callback URL"
                      className="h-9 font-mono text-xs"
                    />
                    <CopyIconButton
                      label="复制 Callback URL"
                      toastLabel="Callback URL"
                      value={status?.callbackUrl ?? ""}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="handoff-token"
                    className="text-xs text-muted-foreground"
                  >
                    Pairing Token
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="handoff-token"
                      readOnly
                      value={status?.pairingToken ?? ""}
                      placeholder="启动配对后生成"
                      aria-label="Pairing Token"
                      className="h-9 font-mono text-xs"
                    />
                    <CopyIconButton
                      label="复制 Pairing Token"
                      toastLabel="Pairing Token"
                      value={status?.pairingToken ?? ""}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
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

              <Card className="gap-2 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-success" />
                  <span className="text-xs font-semibold text-foreground">
                    隐私说明
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  脚本由你在自己的浏览器中手动执行，只读取当前页面已渲染的图片地址；不读取
                  Cookie、不做翻页爬取。脚本会用 localStorage
                  累积多话并一次推送整段合集；如需携带自己的请求头，编辑脚本里的{" "}
                  <code className="font-mono text-foreground">
                    MR_SESSION_HEADERS
                  </code>{" "}
                  常量（应用只在内存使用，不落盘、不记日志）。控制台可用{" "}
                  <code className="font-mono text-foreground">
                    MR_BRIDGE.reset()
                  </code>{" "}
                  清空收集。
                </p>
              </Card>

              <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-hard-sm">
                <div className="min-w-0">
                  <Label
                    htmlFor="handoff-session-headers"
                    className="text-sm font-semibold text-foreground"
                  >
                    允许接收临时请求头至内存
                  </Label>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    退出应用即焚，不写入数据库，也不会写入日志。
                  </p>
                  {status?.active && (
                    <p className="mt-1 text-[11px] text-warning">
                      修改此开关需先停止监听，再重新启动配对。
                    </p>
                  )}
                </div>
                <Switch
                  id="handoff-session-headers"
                  checked={allowSessionHeaders}
                  onCheckedChange={setAllowSessionHeaders}
                  disabled={
                    status?.active || startingHandoff || stoppingHandoff
                  }
                  aria-label="允许接收临时请求头至内存"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  onClick={() => void openCurrentUrl()}
                  disabled={openingCurrentUrl}
                >
                  {openingCurrentUrl ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Globe />
                  )}
                  在系统浏览器打开当前 URL
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  当前 URL 取自「链接 / 清单导入」标签页
                </span>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
