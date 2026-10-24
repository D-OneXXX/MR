import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppWindow,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  CornerDownLeft,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  RefreshCw,
  Radio,
  Settings2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  isOnlineEnabled,
  type BrowserDownload,
  type BrowserDownloadEvent,
  type TelegramChannel,
  type TelegramChapter,
} from "@/lib/tauri";
import TelegramChannelPanel from "@/components/online/TelegramChannelPanel";
import { onlineSourceAddress } from "@/lib/sourceDisplay";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";
import { translate, useI18n, type MessageKey, type TranslateVars } from "@/i18n";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";
import { localizeBackendError } from "@/features/errors/localize";
import {
  refreshBrowserHandoffSession,
  startBrowserHandoffSession,
  stopBrowserHandoffSession,
  useOnlineHandoffState,
} from "@/features/online/handoffState";
import { writeOnlineLastTest } from "@/lib/onlineLastTest";

const RECENTS_KEY = "mr-browser-recents";
const RECENTS_LIMIT = 20;
const URL_INPUT_ID = "browser-url-input";

type BusyKind = "direct" | "embedded" | "external" | null;

interface AddressNotice {
  key: MessageKey;
  vars?: TranslateVars;
  /** 解析失败时提示可改用内嵌浏览器下载导入。 */
  fallback: boolean;
}

/** 只接受 http(s)；省略协议时默认补 https。 */
function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    return url.href;
  } catch {
    return "";
  }
}

function isTelegramChannelRoot(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.startsWith("tg://resolve")) return true;
  try {
    const url = new URL(raw);
    if (!["t.me", "telegram.me"].includes(url.hostname.toLowerCase())) {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length === 1 || (segments[0] === "s" && segments.length === 2);
  } catch {
    return false;
  }
}

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const target = normalizeUrl(item);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      result.push(target);
      if (result.length >= RECENTS_LIMIT) break;
    }
    return result;
  } catch {
    return [];
  }
}

function writeRecents(urls: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(urls));
  } catch {
    /* 忽略存储失败 */
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** 交接回传字段：只读展示 + 一键复制（值可能是空串，复制时提示）。 */
function CopyField({
  id,
  value,
  label,
  copyLabel,
}: {
  id: string;
  value: string;
  label: string;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!value) {
      toast(translate("online.copyEmpty", { label }));
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast(translate("online.copiedLabel", { label }));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastErr("clipboard", translate("online.copyManual", { label }));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          placeholder={translate("pair.generatedAfterStart")}
          aria-label={label}
          className="h-9 min-w-0 font-mono text-xs"
        />
        <Button
          type="button"
          variant="pill"
          size="pill-icon-sm"
          onClick={() => void onCopy()}
          aria-label={copyLabel}
          title={copyLabel}
          disabled={!value}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

export default function BrowserPage() {
  const nav = useNavigate();
  const { t } = useI18n();
  const { active: safeMode } = useSafeMode();
  const { status: handoff } = useOnlineHandoffState();

  const [url, setUrl] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [notice, setNotice] = useState<AddressNotice | null>(null);
  const [telegram, setTelegram] = useState<TelegramChannel | null>(null);
  const [telegramSource, setTelegramSource] = useState("");
  const [telegramBusyId, setTelegramBusyId] = useState<string | null>(null);
  const [telegramLoadingMore, setTelegramLoadingMore] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  // 辅助验证交接：启动/停止/刷新的忙碌态与会话请求头开关（只驻留内存）。
  const [handoffBusy, setHandoffBusy] = useState<
    "start" | "stop" | "refresh" | null
  >(null);
  const [allowSessionHeaders, setAllowSessionHeaders] = useState(false);

  useEffect(() => {
    if (handoff?.active) setAllowSessionHeaders(handoff.allowSessionHeaders);
  }, [handoff?.active, handoff?.allowSessionHeaders]);

  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [loadingDownloads, setLoadingDownloads] = useState(true);
  const [downloadsError, setDownloadsError] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);

  useEffect(() => {
    writeRecents(recents);
  }, [recents]);

  // 设置页保存后广播 mr-settings-changed：同步在线直读开关。
  useEffect(() => {
    const sync = () => setOnlineOn(isOnlineEnabled());
    window.addEventListener("mr-settings-changed", sync);
    return () => window.removeEventListener("mr-settings-changed", sync);
  }, []);

  const remember = useCallback((target: string) => {
    setRecents((prev) =>
      [target, ...prev.filter((item) => item !== target)].slice(0, RECENTS_LIMIT),
    );
  }, []);

  const fillFromRecent = useCallback((target: string) => {
    setUrl(target);
    setNotice(null);
    const input = document.getElementById(URL_INPUT_ID);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, []);

  const resolveTarget = useCallback((): string | null => {
    if (!url.trim()) {
      setNotice({ key: "browser.emptyUrl", fallback: false });
      return null;
    }
    if (/^tg:\/\//i.test(url.trim())) return url.trim();
    const target = normalizeUrl(url);
    if (!target) {
      setNotice({ key: "browser.invalidUrl", fallback: false });
      return null;
    }
    return target;
  }, [url]);

  const directRead = useCallback(async () => {
    if (busy !== null) return;
    const target = resolveTarget();
    if (!target) return;
    if (!onlineOn) {
      setNotice({ key: "browser.directDisabled", fallback: true });
      return;
    }
    if (isTelegramChannelRoot(target)) {
      setBusy("direct");
      setNotice(null);
      setTelegramError(null);
      setTelegram(null);
      try {
        const channel = await api.resolveTelegramChannel(target);
        writeOnlineLastTest({ ok: true, url: target });
        setTelegram(channel);
        setTelegramSource(target);
        remember(target);
        recordBreadcrumb("onlineRead");
        toast(translate("online.telegram.channelDetected"));
      } catch (e) {
        writeOnlineLastTest({ ok: false, url: target });
        setTelegramError(localizeBackendError(e));
        toastErr("resolve_telegram_channel", e);
      } finally {
        setBusy(null);
      }
      return;
    }
    setTelegram(null);
    setTelegramError(null);
    setBusy("direct");
    setNotice(null);
    try {
      const book = await api.resolveOnlineUrl(target);
      writeOnlineLastTest({ ok: true, url: target });
      recordBreadcrumb("onlineRead");
      toast(translate("browser.toastResolved", { title: book.title }));
      remember(target);
      nav(`/reader/${encodeURIComponent(book.id)}`);
    } catch (e) {
      writeOnlineLastTest({ ok: false, url: target });
      setNotice(
        typeof e === "string"
          ? {
              key: "browser.resolveFailedDetail",
              vars: { error: e },
              fallback: true,
            }
          : { key: "browser.resolveFailed", fallback: true },
      );
      toastErr("resolve_online_url", e);
    } finally {
      setBusy(null);
    }
  }, [busy, nav, onlineOn, remember, resolveTarget]);

  const importTelegramChapter = useCallback(
    async (chapter: TelegramChapter) => {
      if (telegramBusyId !== null) return;
      setTelegramBusyId(chapter.id);
      setTelegramError(null);
      try {
        const book =
          chapter.kind === "document" && chapter.document
            ? await api.downloadTelegramDocument(
                chapter.document.url,
                chapter.document.filename,
              )
            : await api.resolveOnlineUrl(chapter.url);
        recordBreadcrumb("onlineRead");
        toast(translate("browser.toastResolved", { title: book.title }));
        nav(`/reader/${encodeURIComponent(book.id)}`);
      } catch (e) {
        setTelegramError(
          typeof e === "string"
            ? localizeBackendError(e)
            : translate("browser.telegram.downloadFailed"),
        );
        toastErr(
          chapter.kind === "document"
            ? "download_telegram_document"
            : "resolve_online_url",
          e,
        );
      } finally {
        setTelegramBusyId(null);
      }
    },
    [nav, telegramBusyId],
  );

  const loadMoreTelegram = useCallback(async () => {
    if (!telegram || telegramLoadingMore) return;
    setTelegramLoadingMore(true);
    setTelegramError(null);
    try {
      const next = await api.resolveTelegramChannel(
        telegramSource,
        telegram.before ?? null,
      );
      setTelegram((prev) => {
        if (!prev) return next;
        const seen = new Set(prev.chapters.map((chapter) => chapter.id));
        return {
          ...next,
          chapters: [
            ...prev.chapters,
            ...next.chapters.filter((chapter) => !seen.has(chapter.id)),
          ],
        };
      });
    } catch (e) {
      setTelegramError(typeof e === "string" ? e : String(e));
      toastErr("resolve_telegram_channel", e);
    } finally {
      setTelegramLoadingMore(false);
    }
  }, [telegram, telegramLoadingMore, telegramSource]);

  const openEmbedded = useCallback(async () => {
    if (busy !== null) return;
    const target = resolveTarget();
    if (!target) return;
    setBusy("embedded");
    setNotice(null);
    try {
      await api.openBrowserWindow(target);
      recordBreadcrumb("onlineRead");
      setUrl(target);
      remember(target);
      toast(translate("browser.toastEmbedded"));
    } catch (e) {
      setNotice(
        typeof e === "string"
          ? {
              key: "browser.embeddedFailedDetail",
              vars: { error: e },
              fallback: false,
            }
          : { key: "browser.embeddedFailed", fallback: false },
      );
      toastErr("open_browser_window", e);
    } finally {
      setBusy(null);
    }
  }, [busy, remember, resolveTarget]);

  const openExternal = useCallback(async () => {
    if (busy !== null) return;
    const target = resolveTarget();
    if (!target) return;
    setBusy("external");
    setNotice(null);
    try {
      await openUrl(target);
      setUrl(target);
      remember(target);
      toast(translate("browser.toastExternal"));
    } catch (e) {
      setNotice(
        typeof e === "string"
          ? {
              key: "browser.externalFailedDetail",
              vars: { error: e },
              fallback: false,
            }
          : { key: "browser.externalFailed", fallback: false },
      );
      toastErr("open_url", e);
    } finally {
      setBusy(null);
    }
  }, [busy, remember, resolveTarget]);

  /* ---------- 辅助验证交接（唯一入口；原书库导入对话框的配对页收敛于此） ---------- */
  const onStartHandoff = useCallback(async () => {
    if (handoffBusy !== null) return;
    setHandoffBusy("start");
    try {
      await startBrowserHandoffSession(allowSessionHeaders);
    } catch (e) {
      toastErr("start_browser_handoff", e);
    } finally {
      setHandoffBusy(null);
    }
  }, [allowSessionHeaders, handoffBusy]);

  const onStopHandoff = useCallback(async () => {
    if (handoffBusy !== null) return;
    setHandoffBusy("stop");
    try {
      await stopBrowserHandoffSession();
    } catch (e) {
      toastErr("stop_browser_handoff", e);
    } finally {
      setHandoffBusy(null);
    }
  }, [handoffBusy]);

  const onRefreshHandoff = useCallback(async () => {
    if (handoffBusy !== null) return;
    setHandoffBusy("refresh");
    try {
      await refreshBrowserHandoffSession();
    } finally {
      setHandoffBusy(null);
    }
  }, [handoffBusy]);

  const loadDownloads = useCallback(async () => {
    setLoadingDownloads(true);
    setDownloadsError(null);
    try {
      setDownloads(await api.listBrowserDownloads());
    } catch (e) {
      setDownloadsError(typeof e === "string" ? e : "");
      toastErr("list_browser_downloads", e);
    } finally {
      setLoadingDownloads(false);
    }
  }, []);

  useEffect(() => {
    void loadDownloads();
  }, [loadDownloads]);

  const importDownload = useCallback(
    async (item: BrowserDownload) => {
      if (importingPath !== null) return;
      setImportingPath(item.path);
      try {
        const bookId = await api.importBrowserDownload(item.path);
        toast(
          bookId
            ? translate("browser.toastImported", { name: item.name })
            : translate("browser.toastNotImported", { name: item.name }),
        );
        await loadDownloads();
      } catch (e) {
        toastErr("import_browser_download", e);
      } finally {
        setImportingPath(null);
      }
    },
    [importingPath, loadDownloads],
  );

  const revealDownload = useCallback(async (item: BrowserDownload) => {
    try {
      await revealItemInDir(item.path);
    } catch (e) {
      toastErr("reveal_item_in_dir", e);
    }
  }, []);

  // 内嵌浏览器下载完成：提示并刷新列表。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BrowserDownloadEvent>("browser-download", (event) => {
      if (disposed) return;
      const payload = event.payload;
      toast(translate("browser.toastDownloaded", { name: payload.name }));
      if (payload.imported) toast(translate("browser.toastAddedToLibrary"));
      void loadDownloads();
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((e) => {
        if (!disposed) toastErr("listen:browser-download", e);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadDownloads]);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-4 sm:px-8">
      {safeMode ? (
        <Card className="items-start gap-4 p-6 sm:p-8">
          <span className="grid size-11 place-items-center rounded-2xl border border-border bg-warning text-background shadow-hard-sm">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              {t("safeMode.browserBlockedTitle")}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t("safeMode.browserBlockedBody")}
            </p>
          </div>
          <Button variant="pill-primary" size="pill" onClick={() => nav("/")}>
            <ArrowRight className="rotate-180" />
            {t("reader.backToLibrary")}
          </Button>
        </Card>
      ) : (
        <>
      <header className="mb-6 sm:mb-8">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground shadow-hard-sm">
          <Globe className="size-3" aria-hidden />
          {t("browser.overline")}
        </span>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t("browser.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t("browser.subtitle")}
        </p>
      </header>

      <Card className="gap-4 overflow-hidden p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <Globe aria-hidden />
            {t("status.onlineRead")}
          </Badge>
          <Badge
            variant={onlineOn ? "success" : "warning"}
            className="gap-1.5"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                onlineOn ? "bg-success" : "bg-warning",
              )}
            />
            {onlineOn ? t("common.enabled") : t("common.disabled")}
          </Badge>
          <span className="ml-auto hidden text-[11px] font-medium text-muted-foreground sm:block">
            {t("browser.capabilities")}
          </span>
        </div>

        <form
          aria-busy={busy !== null}
          onSubmit={(e) => {
            e.preventDefault();
            void directRead();
          }}
        >
          <div className="flex h-14 w-full items-center gap-2 rounded-full border border-border bg-card pl-5 pr-1.5 shadow-hard transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-foreground focus-within:ring-offset-2 focus-within:ring-offset-background">
            <Globe
              aria-hidden
              className="size-5 shrink-0 text-muted-foreground"
            />
            <Input
              id={URL_INPUT_ID}
              value={url}
              onChange={(e) => {
                setUrl(e.currentTarget.value);
                setNotice(null);
              }}
              placeholder={t("browser.urlPlaceholder")}
              aria-label={t("browser.urlLabel")}
              aria-invalid={notice ? true : undefined}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              className="mono h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-sm text-foreground shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            <Button
              type="submit"
              variant="pill-primary"
              size="pill"
              disabled={busy !== null || !onlineOn}
              title={
                onlineOn
                  ? t("browser.submitHint")
                  : t("browser.submitHintOff")
              }
              className="h-10 shrink-0 whitespace-nowrap rounded-full border border-border bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-hard-sm disabled:translate-y-0"
            >
              {busy === "direct" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowRight className="size-4" aria-hidden />
              )}
              {busy === "direct"
                ? t("browser.resolving")
                : t("browser.directRead")}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            className="whitespace-nowrap"
            disabled={busy !== null}
            onClick={() => void openEmbedded()}
          >
            {busy === "embedded" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <AppWindow className="size-3.5" aria-hidden />
            )}
            {t("browser.openEmbedded")}
          </Button>
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            className="whitespace-nowrap"
            disabled={busy !== null}
            onClick={() => void openExternal()}
          >
            {busy === "external" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ExternalLink className="size-3.5" aria-hidden />
            )}
            {t("browser.openExternal")}
          </Button>
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {t("browser.downloadHint")}
          </span>
        </div>

        {telegramError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span className="min-w-0 break-words">{telegramError}</span>
          </div>
        ) : null}

        {telegram ? (
          <TelegramChannelPanel
            channel={telegram}
            busyId={telegramBusyId}
            loadingMore={telegramLoadingMore}
            onImport={(chapter) => void importTelegramChapter(chapter)}
            onLoadMore={() => void loadMoreTelegram()}
          />
        ) : null}

        {!onlineOn && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-secondary p-3 sm:flex-row sm:items-center"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-warning shadow-hard-sm">
              <TriangleAlert className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {t("browser.gateTitle")}
                <Badge variant="warning">{t("browser.gateBadge")}</Badge>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("browser.gateBody")}
              </p>
            </div>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="self-start whitespace-nowrap sm:self-auto"
              onClick={() => nav("/settings")}
            >
              <Settings2 className="size-3.5" aria-hidden />
              {t("browser.goSettings")}
            </Button>
          </div>
        )}

        {notice && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl border border-destructive/35 bg-destructive/10 p-3"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-destructive">
                {t(notice.key, notice.vars)}
              </p>
              {notice.fallback && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("browser.fallbackHint")}
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* 辅助验证交接：Cloudflare / 登录拦截时的唯一交接引导入口。 */}
      <Card className="mt-6 gap-3 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
            <Radio
              className={cn(
                "size-4",
                handoff?.active ? "text-primary" : "text-muted-foreground",
              )}
              aria-hidden
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold tracking-tight">
                {t("online.tabPair")}
              </h2>
              <Badge variant={handoff?.active ? "success" : "muted"}>
                {handoff?.active
                  ? t("pair.stateOnline")
                  : t("pair.stateIdle")}
              </Badge>
            </div>
            <p className="mono mt-0.5 truncate text-[11px] text-muted-foreground">
              {handoff?.active
                ? t("pair.statusLine", {
                    port: handoff.port,
                    count: handoff.receivedChapters,
                  })
                : t("pair.inactiveHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            className="whitespace-nowrap"
            onClick={() => void onRefreshHandoff()}
            disabled={handoffBusy !== null}
            aria-label={t("pair.refresh")}
            title={t("pair.refresh")}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                handoffBusy === "refresh" && "animate-spin",
              )}
              aria-hidden
            />
            {t("common.refresh")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {handoff?.active ? (
            <Button
              type="button"
              variant="pill-danger"
              size="pill-sm"
              className="whitespace-nowrap"
              onClick={() => void onStopHandoff()}
              disabled={handoffBusy === "stop"}
            >
              {handoffBusy === "stop" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              {handoffBusy === "stop" ? t("pair.stopping") : t("pair.stop")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="pill-primary"
              size="pill-sm"
              className="whitespace-nowrap"
              onClick={() => void onStartHandoff()}
              disabled={handoffBusy === "start"}
            >
              {handoffBusy === "start" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              {handoffBusy === "start" ? t("pair.starting") : t("pair.start")}
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {t("pair.autoImportHint")}
          </span>
        </div>

        {handoff?.active ? (
          <div className="grid gap-2 lg:grid-cols-2">
            <CopyField
              id="handoff-callback"
              value={handoff.callbackUrl}
              label={t("online.callbackLabel")}
              copyLabel={t("pair.copyCallback")}
            />
            <CopyField
              id="handoff-token"
              value={handoff.pairingToken}
              label={t("online.tokenLabel")}
              copyLabel={t("pair.copyToken")}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background/60 px-4 py-3">
          <div className="min-w-0">
            <Label
              htmlFor="handoff-session-headers"
              className="text-xs font-semibold"
            >
              {t("pair.sessionHeadersLabel")}
            </Label>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("pair.sessionHeadersHint")}
            </p>
            {handoff?.active ? (
              <p className="mt-1 text-[11px] text-warning">
                {t("pair.sessionHeadersLocked")}
              </p>
            ) : null}
          </div>
          <Switch
            id="handoff-session-headers"
            checked={allowSessionHeaders}
            onCheckedChange={setAllowSessionHeaders}
            disabled={handoff?.active || handoffBusy !== null}
            aria-label={t("pair.sessionHeadersLabel")}
          />
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <Card className="gap-0 overflow-hidden p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
              <Clock3 className="size-4" strokeWidth={2.2} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold tracking-tight">
                {t("browser.recentsTitle")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("browser.recentsHint")}
              </p>
            </div>
            <Badge variant="muted" className="mono">
              {recents.length}
            </Badge>
          </div>

          {recents.length === 0 ? (
            <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-border bg-secondary px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <Globe className="size-4 shrink-0" aria-hidden />
              {t("browser.recentsEmpty")}
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {recents.map((item) => {
                // 复用在线源的脱敏展示：query / hash / userinfo 不进入 DOM。
                const label =
                  onlineSourceAddress(item) || t("source.hiddenAddress");
                return (
                  <li key={item} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => fillFromRecent(item)}
                      title={t("browser.fillAddress")}
                      className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-full border border-border bg-card py-2 pl-2 pr-3 text-left shadow-hard-sm outline-none transition-[transform,box-shadow,background-color] hover:-translate-y-px hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:shadow-none"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-secondary text-muted-foreground">
                        <Globe className="size-3.5" aria-hidden />
                      </span>
                      <span className="mono min-w-0 flex-1 truncate text-xs text-foreground">
                        {label}
                      </span>
                      <CornerDownLeft
                        className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                        aria-hidden
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRecents((prev) =>
                          prev.filter((entry) => entry !== item),
                        )
                      }
                      title={t("browser.deleteRecent")}
                      aria-label={t("browser.deleteRecentAria", { name: label })}
                      className="grid size-8 shrink-0 place-items-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors hover:border-border hover:bg-card hover:text-destructive focus-visible:border-border focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="gap-0 overflow-hidden p-5 sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
              <Download className="size-4" strokeWidth={2.2} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
                {t("browser.downloadsTitle")}
                {downloads.length > 0 && (
                  <Badge variant="muted" className="mono">
                    {downloads.length}
                  </Badge>
                )}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("browser.downloadsDesc")}
              </p>
            </div>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="whitespace-nowrap"
              disabled={loadingDownloads}
              onClick={() => void loadDownloads()}
            >
              <RefreshCw
                className={cn("size-3.5", loadingDownloads && "animate-spin")}
                aria-hidden
              />
              {loadingDownloads
                ? t("browser.refreshing")
                : t("common.refresh")}
            </Button>
          </div>

          <div className="mt-4">
            {downloadsError !== null && downloads.length === 0 ? (
              <ErrorState
                message={
                  downloadsError
                    ? t("browser.downloadsLoadError", {
                        error: downloadsError,
                      })
                    : t("browser.downloadsLoadFailed")
                }
                onRetry={() => void loadDownloads()}
              />
            ) : loadingDownloads && downloads.length === 0 ? (
              <PixelPet mode="loading" message={t("browser.downloadsLoading")} />
            ) : downloads.length === 0 ? (
              <PixelPet mode="empty" message={t("browser.downloadsEmpty")} />
            ) : (
              <>
                {downloadsError !== null && (
                  <div
                    role="status"
                    className="mb-3 flex items-start gap-2 rounded-2xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
                  >
                    <CircleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0 break-words">
                      {downloadsError
                        ? t("browser.refreshFailedDetail", {
                            error: downloadsError,
                          })
                        : t("browser.refreshFailed")}
                    </span>
                  </div>
                )}
                <ul className="flex flex-col gap-2.5">
                  {downloads.map((item) => {
                    const importing = importingPath === item.path;
                    return (
                      <li
                        key={item.path}
                        className="flex flex-col gap-3 rounded-2xl border border-border bg-background p-3.5 sm:flex-row sm:items-center"
                      >
                        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground shadow-hard-sm">
                          <Download className="size-4" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <p
                              className="max-w-full truncate text-sm font-semibold"
                              title={item.name}
                            >
                              {item.name}
                            </p>
                            <Badge
                              variant={item.imported ? "success" : "outline"}
                            >
                              {item.imported
                                ? t("browser.imported")
                                : t("browser.notImported")}
                            </Badge>
                          </div>
                          <p className="mono mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>{formatSize(item.size)}</span>
                            <span aria-hidden>·</span>
                            <span>{item.modified}</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant={item.imported ? "pill" : "pill-primary"}
                            size="pill-sm"
                            disabled={item.imported || importingPath !== null}
                            onClick={() => void importDownload(item)}
                          >
                            {item.imported ? (
                              <Check className="size-3.5" aria-hidden />
                            ) : importing ? (
                              <Loader2
                                className="size-3.5 animate-spin"
                                aria-hidden
                              />
                            ) : (
                              <Download className="size-3.5" aria-hidden />
                            )}
                            {item.imported
                              ? t("browser.imported")
                              : importing
                                ? t("browser.importing")
                                : t("browser.importAction")}
                          </Button>
                          <Button
                            type="button"
                            variant="pill"
                            size="pill-sm"
                            className="whitespace-nowrap"
                            title={t("browser.openFolderTitle", {
                              name: item.name,
                            })}
                            onClick={() => void revealDownload(item)}
                          >
                            <FolderOpen className="size-3.5" aria-hidden />
                            {t("browser.openFolder")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </Card>
      </div>
        </>
      )}
    </div>
  );
}
