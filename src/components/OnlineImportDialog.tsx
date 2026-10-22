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
import { translate, useI18n } from "@/i18n";
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
import { recordBreadcrumb } from "@/features/resilience";

interface Props {
  onClose: () => void;
  onImported: () => void;
  onRead: (book: BookInfo) => void;
  initialTab?: "link" | "pair";
  initialUrl?: string;
}

function isTelegramChannelRoot(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.startsWith("tg://resolve")) return true;
  try {
    const url = new URL(value);
    if (!["t.me", "telegram.me"].includes(url.hostname)) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length === 1 || (segments[0] === "s" && segments.length === 2);
  } catch {
    return false;
  }
}

function parsePastedPageUrls(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(translate("online.parseJsonError"));
    }
    if (!Array.isArray(parsed)) {
      throw new Error(translate("online.parseArrayOnly"));
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
      throw new Error(translate("online.parseItemShape"));
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
    toast(translate("online.copyEmpty", { label }));
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(translate("online.copiedLabel", { label }));
    return true;
  } catch {
    toastErr(
      "clipboard",
      translate("online.copyManual", { label }),
    );
    try {
      window.prompt(translate("online.copyPrompt", { label }), value);
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
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  return (
    <Button
      type="button"
      variant="pill"
      size="pill-sm"
      className="whitespace-nowrap"
      disabled={!value}
      onClick={() => void copy(toastLabel, value)}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t("common.copied") : label}
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
  if (showToast && wasActive) toast(translate("pair.toastStopped"));
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
  const { t } = useI18n();
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
      setErr(t("online.errorMissingUrl"));
      return;
    }
    if (isTelegramChannelRoot(url.trim())) {
      setErr(t("online.telegram.useBrowserHint"));
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
          text: t("online.probe", {
            title: p.title,
            pages: p.pageCount,
            ms: p.elapsedMs,
          }),
          ok: p.ok,
        });
        if (!p.ok) setErr(p.message || t("online.errorNoPages"));
      } else {
        const b = await api.resolveOnlineUrl(url.trim());
        if (!aliveRef.current) return;
        recordBreadcrumb("onlineRead");
        toast(
          t("online.toastAdded", {
            title: b.title,
            pages: b.pageCount,
          }),
        );
        onImported();
        if (mode === "read") onRead(b);
        close();
      }
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : t("online.errorAction");
      setErr(msg);
      toastErr("online", e);
    } finally {
      setBusy(null);
    }
  };

  const openAuxBrowser = async () => {
    if (busy !== null || openingBrowser) return;
    if (!url.trim()) {
      setErr(t("online.errorOpenUrlMissing"));
      return;
    }
    setOpeningBrowser(true);
    try {
      await api.openBrowserWindow(url.trim());
      recordBreadcrumb("onlineRead");
    } catch (e) {
      toastErr("open_browser_window", e);
    } finally {
      setOpeningBrowser(false);
    }
  };

  const importPasted = async () => {
    if (busy !== null) return;
    if (!url.trim()) {
      setPasteErr(t("online.errorPasteNoPageUrl"));
      return;
    }
    let pageUrls: string[];
    try {
      pageUrls = parsePastedPageUrls(pasteText);
    } catch (e) {
      setPasteErr(
        e instanceof Error ? e.message : t("online.errorPasteParse"),
      );
      return;
    }
    if (pageUrls.length === 0) {
      setPasteErr(t("online.errorPasteNoImages"));
      return;
    }
    setBusy("paste");
    setErr(null);
    setProbe(null);
    setPasteErr(null);
    try {
      await api.importResolvedPages(url.trim(), pasteTitle.trim(), pageUrls);
      if (!aliveRef.current) return;
      recordBreadcrumb("onlineRead");
      toast(t("online.toastLibraryAdded"));
      setPasteOpen(false);
      setPasteText("");
      setPasteTitle("");
      onImported();
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : t("online.errorImport");
      setPasteErr(msg);
      toastErr("import_resolved_pages", e);
    } finally {
      setBusy(null);
    }
  };

  const importBatch = async () => {
    if (busy !== null) return;
    if (!batchText.trim()) {
      setBatchErr(t("online.errorBatchEmpty"));
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
      recordBreadcrumb("onlineRead");
      toast(t("online.toastBatch", { count: books.length }));
      setBatchText("");
      onImported();
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = typeof e === "string" ? e : t("online.errorImport");
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
      recordBreadcrumb("onlinePairing");
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
      toast(t("online.toastNeedUrl"));
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
    ? `${t("online.callbackLabel")}: ${status.callbackUrl}\n${t("online.tokenLabel")}: ${status.pairingToken}`
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
              {t("online.title")}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              {t("online.description")}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="pill-ghost"
            size="pill-icon-sm"
            onClick={close}
            disabled={busy !== null}
            title={
              busy !== null
                ? t("online.busyCloseTitle")
                : t("common.close")
            }
            aria-label={t("common.close")}
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
              aria-label={t("online.tabsAria")}
            >
              <TabsTrigger
                value="link"
                disabled={busy !== null}
                className="h-9 flex-none gap-2 rounded-full border border-transparent px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
              >
                {t("online.tabLink")}
              </TabsTrigger>
              <TabsTrigger
                value="pair"
                disabled={busy !== null}
                className="h-9 flex-none gap-2 rounded-full border border-transparent px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
              >
                {t("online.tabPair")}
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
            <TabsContent
              value="link"
              aria-label={t("online.tabLink")}
              className="flex flex-col gap-4"
            >
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("online.linkIntro")}
              </p>

              <Card className="gap-3 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="online-import-url"
                    className="text-xs text-muted-foreground"
                  >
                    {t("online.urlLabel")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
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
                      placeholder={t("online.urlPlaceholder")}
                      aria-label={t("online.urlAria")}
                      className="h-10 min-w-0 font-mono text-xs"
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
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => void run("test")}
                      disabled={busy !== null}
                    >
                      {busy === "test" ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      {t("common.test")}
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
                    {t("online.busyHint")}
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
                    <span className="whitespace-nowrap">
                      {t("online.openAuxBrowser")}
                    </span>
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
                    <span className="whitespace-nowrap">
                      {t("online.systemBrowser")}
                    </span>
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("online.auxHint")}
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
                  <span className="whitespace-nowrap">
                    {t("online.addOnly")}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="pill-primary"
                  size="pill"
                  className="whitespace-nowrap"
                  onClick={() => void run("read")}
                  disabled={busy !== null}
                  title={t("online.addAndReadTitle")}
                >
                  {busy === "read" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <BookOpen />
                  )}
                  {t("online.addAndRead")}
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
                  <span className="whitespace-nowrap">
                    {t("online.pasteToggle")}
                  </span>
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
                        {t("online.pasteTitleLabel")}
                      </Label>
                      <Input
                        id="online-paste-title"
                        value={pasteTitle}
                        onChange={(e) => setPasteTitle(e.currentTarget.value)}
                        placeholder={t("online.pasteTitlePlaceholder")}
                        aria-label={t("online.pasteTitleAria")}
                        disabled={busy !== null}
                        className="h-9 min-w-0 text-xs"
                      />
                    </div>
                    <Textarea
                      rows={5}
                      value={pasteText}
                      onChange={(e) => {
                        setPasteText(e.currentTarget.value);
                        setPasteErr(null);
                      }}
                      placeholder={t("online.pastePlaceholder")}
                      aria-label={t("online.pasteAria")}
                      disabled={busy !== null}
                      className="min-w-0 font-mono text-xs"
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("online.pasteNote")}
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
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        variant="pill-primary"
                        size="pill-sm"
                        className="whitespace-nowrap"
                        onClick={() => void importPasted()}
                        disabled={busy !== null || !pasteText.trim()}
                      >
                        {busy === "paste" ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        {t("online.import")}
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
                    {t("online.batchTitle")}
                  </Label>
                  <Badge variant="muted" className="ml-auto">
                    {t("common.series")}
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
                  placeholder={t("online.batchPlaceholder")}
                  aria-label={t("online.batchAria")}
                  disabled={busy !== null}
                  className="min-w-0 font-mono text-xs"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("online.batchNote")}
                </p>
                {batchErr && <InlineNotice tone="error">{batchErr}</InlineNotice>}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="pill-primary"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    onClick={() => void importBatch()}
                    disabled={busy !== null || !batchText.trim()}
                  >
                    {busy === "batch" ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
                    {t("online.importBatch")}
                  </Button>
                </div>
              </Card>
            </TabsContent>

            <TabsContent
              value="pair"
              aria-label={t("online.tabPair")}
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
                        {status?.active ? t("pair.active") : t("pair.inactive")}
                      </span>
                      <Badge variant={status?.active ? "success" : "muted"}>
                        {status?.active
                          ? t("pair.stateOnline")
                          : t("pair.stateIdle")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {status?.active
                        ? t("pair.statusLine", {
                            port: status.port,
                            count: status.receivedChapters,
                          })
                        : t("pair.inactiveHint")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="pill-ghost"
                    size="pill-icon-sm"
                    onClick={() => void refreshStatus()}
                    disabled={refreshing}
                    aria-label={t("pair.refresh")}
                    title={t("pair.refresh")}
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
                      className="whitespace-nowrap"
                      onClick={() => void stopPairing()}
                      disabled={stoppingHandoff}
                    >
                      {stoppingHandoff ? t("pair.stopping") : t("pair.stop")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="pill-primary"
                      size="pill-sm"
                      className="whitespace-nowrap"
                      onClick={() => void startPairing()}
                      disabled={startingHandoff}
                    >
                      {startingHandoff ? t("pair.starting") : t("pair.start")}
                    </Button>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {t("pair.autoImportHint")}
                  </span>
                </div>
              </Card>

              <div className="grid gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="handoff-callback"
                    className="text-xs text-muted-foreground"
                  >
                    {t("online.callbackLabel")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id="handoff-callback"
                      readOnly
                      value={status?.callbackUrl ?? ""}
                      placeholder={t("pair.generatedAfterStart")}
                      aria-label={t("online.callbackLabel")}
                      className="h-9 min-w-0 font-mono text-xs"
                    />
                    <CopyIconButton
                      label={t("pair.copyCallback")}
                      toastLabel={t("online.callbackLabel")}
                      value={status?.callbackUrl ?? ""}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="handoff-token"
                    className="text-xs text-muted-foreground"
                  >
                    {t("online.tokenLabel")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id="handoff-token"
                      readOnly
                      value={status?.pairingToken ?? ""}
                      placeholder={t("pair.generatedAfterStart")}
                      aria-label={t("online.tokenLabel")}
                      className="h-9 min-w-0 font-mono text-xs"
                    />
                    <CopyIconButton
                      label={t("pair.copyToken")}
                      toastLabel={t("online.tokenLabel")}
                      value={status?.pairingToken ?? ""}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <CopyAction
                  label={t("pair.copyInterface")}
                  toastLabel={t("pair.interfaceInfo")}
                  value={interfaceInfo}
                />
                <CopyAction
                  label={t("pair.copyTemplate")}
                  toastLabel={t("pair.pushTemplate")}
                  value={status?.script ?? ""}
                />
              </div>

              <Card className="gap-2 rounded-2xl border-border bg-muted/20 p-4 shadow-none">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-success" />
                  <span className="text-xs font-semibold text-foreground">
                    {t("pair.privacyTitle")}
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("pair.privacyP1")}{" "}
                  <code className="font-mono text-foreground">
                    MR_SESSION_HEADERS
                  </code>{" "}
                  {t("pair.privacyP2")}{" "}
                  <code className="font-mono text-foreground">
                    MR_BRIDGE.reset()
                  </code>{" "}
                  {t("pair.privacyP3")}
                </p>
              </Card>

              <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-hard-sm">
                <div className="min-w-0">
                  <Label
                    htmlFor="handoff-session-headers"
                    className="text-sm font-semibold text-foreground"
                  >
                    {t("pair.sessionHeadersLabel")}
                  </Label>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {t("pair.sessionHeadersHint")}
                  </p>
                  {status?.active && (
                    <p className="mt-1 text-[11px] text-warning">
                      {t("pair.sessionHeadersLocked")}
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
                  aria-label={t("pair.sessionHeadersLabel")}
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
                  <span className="whitespace-nowrap">
                    {t("pair.openCurrent")}
                  </span>
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {t("pair.currentUrlHint")}
                </span>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
