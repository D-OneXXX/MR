import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppWindow,
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  CornerDownLeft,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  RefreshCw,
  Settings2,
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
} from "@/lib/tauri";
import { onlineSourceAddress } from "@/lib/sourceDisplay";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";

const RECENTS_KEY = "mr-browser-recents";
const RECENTS_LIMIT = 20;
const URL_INPUT_ID = "browser-url-input";

type BusyKind = "direct" | "embedded" | "external" | null;

interface AddressNotice {
  message: string;
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

export default function BrowserPage() {
  const nav = useNavigate();

  const [url, setUrl] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [notice, setNotice] = useState<AddressNotice | null>(null);

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
      setNotice({ message: "请输入要打开的页面地址", fallback: false });
      return null;
    }
    const target = normalizeUrl(url);
    if (!target) {
      setNotice({
        message: "地址无效，仅支持 http(s) 链接",
        fallback: false,
      });
      return null;
    }
    return target;
  }, [url]);

  const directRead = useCallback(async () => {
    if (busy !== null) return;
    const target = resolveTarget();
    if (!target) return;
    if (!onlineOn) {
      setNotice({
        message: "在线直读已在设置中关闭，无法解析该地址",
        fallback: true,
      });
      return;
    }
    setBusy("direct");
    setNotice(null);
    try {
      const book = await api.resolveOnlineUrl(target);
      toast(`已解析《${book.title}》，正在打开阅读器`);
      remember(target);
      nav(`/reader/${encodeURIComponent(book.id)}`);
    } catch (e) {
      setNotice({
        message:
          typeof e === "string" ? e : "解析失败，请检查地址或网络设置",
        fallback: true,
      });
      toastErr("resolve_online_url", e);
    } finally {
      setBusy(null);
    }
  }, [busy, nav, onlineOn, remember, resolveTarget]);

  const openEmbedded = useCallback(async () => {
    if (busy !== null) return;
    const target = resolveTarget();
    if (!target) return;
    setBusy("embedded");
    setNotice(null);
    try {
      await api.openBrowserWindow(target);
      setUrl(target);
      remember(target);
      toast("已在内嵌浏览器中打开");
    } catch (e) {
      setNotice({
        message: typeof e === "string" ? e : "打开内嵌浏览器失败",
        fallback: false,
      });
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
      toast("已在系统浏览器中打开");
    } catch (e) {
      setNotice({
        message: typeof e === "string" ? e : "打开系统浏览器失败",
        fallback: false,
      });
      toastErr("open_url", e);
    } finally {
      setBusy(null);
    }
  }, [busy, remember, resolveTarget]);

  const loadDownloads = useCallback(async () => {
    setLoadingDownloads(true);
    setDownloadsError(null);
    try {
      setDownloads(await api.listBrowserDownloads());
    } catch (e) {
      setDownloadsError(typeof e === "string" ? e : "下载列表加载失败");
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
        toast(bookId ? `已导入：${item.name}` : `未导入：${item.name}`);
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
      toast(`已下载：${payload.name}`);
      if (payload.imported) toast("已加入书库");
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
      <header className="mb-6 sm:mb-8">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground shadow-hard-sm">
          <Globe className="size-3" aria-hidden />
          ONLINE READER
        </span>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          浏览器
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          把在线漫画的清单或图集地址直接交给阅读器；也可以在独立的内嵌浏览器中打开页面，下载后导入书库。
        </p>
      </header>

      <Card className="gap-4 overflow-hidden p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <Globe aria-hidden />
            在线直读
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
            {onlineOn ? "已开启" : "已关闭"}
          </Badge>
          <span className="ml-auto hidden text-[11px] font-medium text-muted-foreground sm:block">
            支持 JSON 清单与单页 HTML 图集
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
              placeholder="粘贴清单或图集地址，例如 https://example.com/gallery.html"
              aria-label="在线直读地址"
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
                  ? "解析地址并进入阅读器"
                  : "在线直读已在设置中关闭"
              }
              className="h-10 rounded-full border border-border bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-hard-sm disabled:translate-y-0"
            >
              {busy === "direct" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowRight className="size-4" aria-hidden />
              )}
              {busy === "direct" ? "解析中" : "直读"}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            disabled={busy !== null}
            onClick={() => void openEmbedded()}
          >
            {busy === "embedded" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <AppWindow className="size-3.5" aria-hidden />
            )}
            内嵌浏览器
          </Button>
          <Button
            type="button"
            variant="pill"
            size="pill-sm"
            disabled={busy !== null}
            onClick={() => void openExternal()}
          >
            {busy === "external" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <ExternalLink className="size-3.5" aria-hidden />
            )}
            系统浏览器
          </Button>
          <span className="text-xs text-muted-foreground sm:ml-auto">
            内嵌窗口下载的 zip / cbz 可在下方导入
          </span>
        </div>

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
                在线直读未开启
                <Badge variant="warning">需在设置中启用</Badge>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                直读按钮暂不可用；内嵌浏览器与系统浏览器仍可打开页面，下载后可导入书库。
              </p>
            </div>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              className="self-start sm:self-auto"
              onClick={() => nav("/settings")}
            >
              <Settings2 className="size-3.5" aria-hidden />
              前往设置
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
                {notice.message}
              </p>
              {notice.fallback && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  可在内嵌浏览器中打开该页面后下载导入。
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <Card className="gap-0 overflow-hidden p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
              <Clock3 className="size-4" strokeWidth={2.2} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold tracking-tight">最近访问</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                点击填入地址栏；仅展示脱敏地址
              </p>
            </div>
            <Badge variant="muted" className="mono">
              {recents.length}
            </Badge>
          </div>

          {recents.length === 0 ? (
            <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-border bg-secondary px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <Globe className="size-4 shrink-0" aria-hidden />
              暂无最近访问，直读或打开成功后会自动记录。
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {recents.map((item) => {
                // 复用在线源的脱敏展示：query / hash / userinfo 不进入 DOM。
                const label = onlineSourceAddress(item);
                return (
                  <li key={item} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => fillFromRecent(item)}
                      title="填入地址栏"
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
                      title="删除记录"
                      aria-label={`删除最近访问：${label}`}
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
                下载
                {downloads.length > 0 && (
                  <Badge variant="muted" className="mono">
                    {downloads.length}
                  </Badge>
                )}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                内嵌浏览器下载的压缩包，导入后加入书库
              </p>
            </div>
            <Button
              type="button"
              variant="pill"
              size="pill-sm"
              disabled={loadingDownloads}
              onClick={() => void loadDownloads()}
            >
              <RefreshCw
                className={cn("size-3.5", loadingDownloads && "animate-spin")}
                aria-hidden
              />
              {loadingDownloads ? "刷新中" : "刷新"}
            </Button>
          </div>

          <div className="mt-4">
            {downloadsError && downloads.length === 0 ? (
              <ErrorState
                message={`下载列表加载失败：${downloadsError}`}
                onRetry={() => void loadDownloads()}
              />
            ) : loadingDownloads && downloads.length === 0 ? (
              <PixelPet mode="loading" message="正在读取下载列表" />
            ) : downloads.length === 0 ? (
              <PixelPet
                mode="empty"
                message="暂无下载记录，在内嵌浏览器中下载 zip / cbz 后会自动出现在这里"
              />
            ) : (
              <>
                {downloadsError && (
                  <div
                    role="status"
                    className="mb-3 flex items-start gap-2 rounded-2xl border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
                  >
                    <CircleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0 break-words">
                      刷新失败：{downloadsError}
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
                              {item.imported ? "已导入" : "未导入"}
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
                              ? "已导入"
                              : importing
                                ? "导入中"
                                : "导入"}
                          </Button>
                          <Button
                            type="button"
                            variant="pill"
                            size="pill-sm"
                            title={`打开所在文件夹：${item.name}`}
                            onClick={() => void revealDownload(item)}
                          >
                            <FolderOpen className="size-3.5" aria-hidden />
                            打开文件夹
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
    </div>
  );
}
