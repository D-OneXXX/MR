import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BookOpen,
  CalendarDays,
  Check,
  Command,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  ImageOff,
  Info,
  Keyboard,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Save,
  ScanLine,
  ShieldCheck,
  Sun,
  Trash2,
  TrendingUp,
  Wifi,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type Dashboard,
  type MemoryStats,
  type Settings,
} from "@/lib/tauri";
import {
  LOCALE_OPTIONS,
  translate,
  useI18n,
  type MessageKey,
} from "@/i18n";
import { isLocale } from "@/i18n/config";
import {
  useTheme,
  type ThemeMode,
} from "@/features/theme/ThemeProvider";
import { writeOnlineLastTest } from "@/lib/onlineLastTest";
import { updateApi } from "@/features/update/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import UpdatesPanel from "@/components/settings/UpdatesPanel";
import PrivacyPanel from "@/components/settings/PrivacyPanel";
import SupportPanel from "@/components/settings/SupportPanel";
import OnlineFilterPanel from "@/components/settings/OnlineFilterPanel";
import DataBackupPanel from "@/components/settings/DataBackupPanel";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";
import ErrorState from "@/components/ErrorState";
import { APP_VERSION, BUILD_COMMIT } from "@/lib/version";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";

const DEFAULT_FORM: Settings = {
  theme: "system",
  cacheBudgetMb: 128,
  diskCacheBudgetMb: 2048,
  libraryDir: "",
  experimentalWebtoon: false,
  experimentalOnline: false,
  onlineProxy: "",
  onlineConcurrency: 3,
  onlineHeaders: "",
};

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeMode;
  labelKey: MessageKey;
  hintKey: MessageKey;
  icon: LucideIcon;
}> = [
  {
    value: "system",
    labelKey: "theme.system",
    hintKey: "settings.theme.systemHint",
    icon: Monitor,
  },
  {
    value: "light",
    labelKey: "theme.light",
    hintKey: "settings.theme.lightHint",
    icon: Sun,
  },
  {
    value: "dark",
    labelKey: "theme.dark",
    hintKey: "settings.theme.darkHint",
    icon: Moon,
  },
];

function normalizeTheme(value: string): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/** 收敛后的五个高内聚分区。 */
type SettingsTab = "general" | "network" | "storage" | "privacy" | "about";

/**
 * 深链 id 归一化：新 id 直通；历史 id（updates / support / reading /
 * cache / online）静默映射到收敛后的分区，保证旧书签与 PrivacyDialog
 * 的 /settings?tab=privacy 都不会落到空页。
 */
function normalizeSettingsTab(raw: string | null): SettingsTab | null {
  switch (raw) {
    case "general":
    case "network":
    case "storage":
    case "privacy":
    case "about":
      return raw;
    case "online":
      return "network";
    case "reading":
    case "cache":
      return "storage";
    case "updates":
    case "support":
      return "about";
    default:
      return null;
  }
}

/** 全局快捷键说明：键位保持原样，说明复用阅读器既有 i18n key。 */
const GLOBAL_SHORTCUTS: ReadonlyArray<{
  keys: string;
  actionKey: MessageKey;
}> = [
  { keys: "Space / ← / →", actionKey: "reader.shortcut.pageTurn" },
  { keys: "Shift + Space", actionKey: "reader.nav.prev" },
  { keys: "F", actionKey: "reader.shortcut.mode" },
  { keys: "Ctrl + 1…9", actionKey: "reader.shortcut.tabs" },
  { keys: "Ctrl / Cmd + W", actionKey: "reader.shortcut.closeTab" },
  { keys: "Esc", actionKey: "reader.shortcut.escape" },
];

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 热力图为日期升序的稀疏记录；按最近 7 个自然日（含今天）求和。 */
function sumLast7Days(heatmap: Dashboard["heatmap"]): number {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  const cutoffKey = localDateKey(cutoff);
  return heatmap.reduce(
    (total, entry) => (entry.date >= cutoffKey ? total + entry.count : total),
    0,
  );
}

function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0.0 MB";
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 缓存占用百分比：非法值/零上限安全，结果限制在 0-100。 */
function cachePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  unit: string;
}) {
  const { formatNumber } = useI18n();
  return (
    <Card className="gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="grid size-9 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
          <Icon className="size-4" strokeWidth={2.2} />
        </span>
        <span className="text-xs font-semibold text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="flex items-end gap-1.5">
        <span className="text-3xl font-extrabold leading-none tracking-tight tabular-nums">
          {formatNumber(value)}
        </span>
        <span className="pb-0.5 text-xs font-medium text-muted-foreground">
          {unit}
        </span>
      </div>
    </Card>
  );
}

function MemoryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="font-mono mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * 设置页：常规与外观 / 网络与在线源 / 存储与数据 / 隐私与安全 / 关于与维护。
 * 保存时以「已加载设置 + 当前表单」整对象写回，保留当前页面未展示、
 * 但后端仍需要的字段（例如实验开关）。
 */
export default function SettingsPage() {
  const { mode, setMode } = useTheme();
  const { locale, setLocale, t, formatNumber } = useI18n();
  const { active: safeMode } = useSafeMode();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(
    () => normalizeSettingsTab(searchParams.get("tab")) ?? "general",
  );
  const [form, setForm] = useState<Settings>(DEFAULT_FORM);
  const [mem, setMem] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [experimentalBusy, setExperimentalBusy] = useState<
    "experimentalOnline" | null
  >(null);
  const [scanning, setScanning] = useState(false);
  const [detectingProxy, setDetectingProxy] = useState(false);
  const [testingOnline, setTestingOnline] = useState(false);
  const [onlineTestUrl, setOnlineTestUrl] = useState("");
  const [onlineTestResult, setOnlineTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [sessionHeaders, setSessionHeaders] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [clearingThumbs, setClearingThumbs] = useState(false);
  const [clearingPages, setClearingPages] = useState(false);
  const [clearingTemp, setClearingTemp] = useState(false);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);

  // 最近一次成功读/写数据库的完整设置；保存时作为底稿保留隐藏字段。
  const loadedRef = useRef<Settings | null>(null);
  const loadSeqRef = useRef(0);
  const dashSeqRef = useRef(0);

  const concurrencyItems = Array.from({ length: 8 }, (_, index) => {
    const value = String(index + 1);
    return {
      value,
      label: t("settings.online.concurrencyItem", {
        count: formatNumber(index + 1),
      }),
    };
  });

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, session] = await Promise.all([
        api.getSettings(),
        api.getSessionOnlineHeaders().catch(() => null),
      ]);
      if (seq !== loadSeqRef.current) return;
      // Cache metrics are supplementary: never let a slow sysinfo query keep
      // the whole settings page in its loading state.
      void api.getMemoryStats().then(
        (memory) => {
          if (seq === loadSeqRef.current) setMem(memory);
        },
        () => {
          if (seq === loadSeqRef.current) setMem(null);
        },
      );
      // localStorage 中的模式优先：首次启动没有偏好时跟随系统，
      // 不让历史数据库里的 dark 默认值覆盖「跟随系统」。
      let storedMode: string | null = null;
      try {
        storedMode = localStorage.getItem("mr-theme");
      } catch {
        /* 忽略 */
      }
      const theme = normalizeTheme(storedMode ?? "system");
      const sessionValue =
        typeof session === "string" && session.trim().length > 0 ? session : "";
      loadedRef.current = { ...settings, theme };
      setForm({
        ...DEFAULT_FORM,
        ...settings,
        theme,
        ...(sessionValue ? { onlineHeaders: sessionValue } : {}),
      });
      setSessionActive(sessionValue.length > 0);
      setSessionHeaders(sessionValue.length > 0);
      setDirty(false);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(
        typeof e === "string" ? e : translate("settings.errors.loadSettings"),
      );
      toastErr("get_settings", e);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadSeqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const requested = normalizeSettingsTab(searchParams.get("tab"));
    if (requested) setTab(requested);
  }, [searchParams]);

  // Each settings tab is a separate page-length surface; always start at the
  // top instead of inheriting the previous tab's scroll offset.
  useEffect(() => {
    document
      .querySelector("main")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [tab]);

  // 顶栏也可切换主题；保证表单里的 theme 始终与 ThemeProvider 当前模式一致。
  useEffect(() => {
    setForm((prev) =>
      prev.theme === mode ? prev : { ...prev, theme: mode },
    );
    if (loadedRef.current && loadedRef.current.theme !== mode) {
      loadedRef.current = { ...loadedRef.current, theme: mode };
    }
  }, [mode]);

  const loadDashboard = useCallback(async () => {
    const seq = ++dashSeqRef.current;
    setDashLoading(true);
    setDashError(null);
    try {
      const next = await api.getDashboard();
      if (seq !== dashSeqRef.current) return;
      setDash(next);
    } catch (e) {
      if (seq !== dashSeqRef.current) return;
      setDashError(
        typeof e === "string" ? e : translate("settings.errors.loadStats"),
      );
    } finally {
      if (seq === dashSeqRef.current) setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
    return () => {
      dashSeqRef.current += 1;
    };
  }, [loadDashboard]);

  const refreshSessionState = useCallback(() => {
    api
      .getSessionOnlineHeaders()
      .then((session) => {
        // Runtime state only: never overwrite the user's storage-mode choice
        // just because a window regained focus.
        const active =
          typeof session === "string" && session.trim().length > 0;
        setSessionActive(active);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => refreshSessionState();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshSessionState();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSessionState]);

  const refreshMemory = useCallback(async () => {
    try {
      setMem(await api.getMemoryStats());
    } catch (e) {
      toastErr("get_memory_stats", e);
    }
  }, []);

  const onThemeChange = (next: ThemeMode) => {
    // setMode 立即改 <html data-theme> 并写入 localStorage 与数据库。
    setMode(next);
    recordBreadcrumb("themeChange");
    setForm((prev) => ({ ...prev, theme: next }));
    if (loadedRef.current) {
      loadedRef.current = { ...loadedRef.current, theme: next };
    }
  };

  // 实验开关立即持久化，但只写「数据库最新值 + 本开关」，
  // 不会把表单里尚未保存的代理、请求头、目录等一起写库。
  const toggleExperimental = async (
    key: "experimentalOnline",
    value: boolean,
  ) => {
    if (experimentalBusy !== null || saving || loading) return;
    const previous = form[key];
    const feature = t("settings.online.urlTitle");
    setExperimentalBusy(key);
    setForm((prev) => ({ ...prev, [key]: value }));
    try {
      const persisted = await api.getSettings();
      const next = { ...persisted, [key]: value };
      await api.setSettings(next);
      loadedRef.current = next;
      setForm((prev) => ({ ...prev, [key]: value }));
      toast(
        t(
          value ? "settings.toast.featureOn" : "settings.toast.featureOff",
          { feature },
        ),
      );
    } catch (e) {
      setForm((prev) => ({ ...prev, [key]: previous }));
      toastErr("set_settings", e);
    } finally {
      setExperimentalBusy(null);
    }
  };

  const onPickDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.library.pickTitle"),
        defaultPath: form.libraryDir.trim() || undefined,
      });
      if (typeof picked === "string") set("libraryDir", picked);
    } catch (e) {
      toastErr("open_dialog", e);
    }
  };

  const onScanLibrary = async () => {
    const dir = form.libraryDir.trim();
    if (!dir || scanning) return;
    setScanning(true);
    try {
      const result = await api.scanLibrary(dir);
      toast(
        t("settings.toast.scanDone", {
          count: formatNumber(result.books.length),
        }),
      );
      if (result.errors?.length) {
        toast(
          t("settings.toast.scanErrors", {
            count: formatNumber(result.errors.length),
          }),
        );
      }
    } catch (e) {
      toastErr("scan_library", e);
    } finally {
      setScanning(false);
    }
  };

  const onDetectProxy = async () => {
    if (detectingProxy) return;
    setDetectingProxy(true);
    try {
      const proxy = (await api.detectSystemProxy())?.trim() ?? "";
      if (proxy) {
        set("onlineProxy", proxy);
        toast(t("settings.toast.proxyFilled"));
      } else {
        toast(t("settings.toast.proxyNotFound"));
      }
    } catch (e) {
      toastErr("detect_system_proxy", e);
    } finally {
      setDetectingProxy(false);
    }
  };

  const onClearSessionHeaders = async () => {
    try {
      await api.clearSessionOnlineHeaders();
      setForm((prev) => ({ ...prev, onlineHeaders: "" }));
      setSessionActive(false);
      setDirty(true);
      toast(t("settings.toast.sessionCleared"));
    } catch (e) {
      toastErr("clear_session_online_headers", e);
    }
  };

  const onTestOnline = async () => {
    const target = onlineTestUrl.trim();
    if (!target) {
      toast(t("settings.toast.urlRequired"));
      return;
    }
    setTestingOnline(true);
    setOnlineTestResult(null);
    try {
      const probe = await api.testOnlineConnection(target);
      writeOnlineLastTest({ ok: probe.ok, url: target });
      const summary = t("settings.online.testSummary", {
        title: probe.title,
        pages: formatNumber(probe.pageCount),
        ms: formatNumber(probe.elapsedMs),
      });
      setOnlineTestResult({
        ok: probe.ok,
        message: probe.ok ? summary : probe.message || summary,
      });
      if (!probe.ok) {
        toast(probe.message || t("settings.toast.noReadablePages"));
      }
    } catch (e) {
      writeOnlineLastTest({ ok: false, url: target });
      setOnlineTestResult({
        ok: false,
        message:
          typeof e === "string" ? e : t("settings.errors.connectTest"),
      });
      toastErr("test_online_connection", e);
    } finally {
      setTestingOnline(false);
    }
  };

  const onClearThumbs = async () => {
    setClearingThumbs(true);
    try {
      const count = await api.clearThumbCache();
      toast(
        t("settings.toast.thumbsCleared", {
          count: formatNumber(count),
        }),
      );
      await refreshMemory();
    } catch (e) {
      toastErr("clear_thumbnail_cache", e);
    } finally {
      setClearingThumbs(false);
    }
  };

  const onClearPages = async () => {
    setClearingPages(true);
    try {
      await api.clearPages();
      toast(t("settings.toast.pagesCleared"));
      await refreshMemory();
    } catch (e) {
      toastErr("clear_pages", e);
    } finally {
      setClearingPages(false);
    }
  };

  const onClearTemp = async () => {
    if (clearingTemp) return;
    setClearingTemp(true);
    try {
      const result = await api.clearTempCache();
      toast(
        t("settings.toast.tempCleared", {
          size: formatMb(result.bytesFreed),
        }),
      );
      await refreshMemory();
    } catch (e) {
      toastErr("clear_temp_cache", e);
    } finally {
      setClearingTemp(false);
    }
  };

  const onSave = async () => {
    // 设置尚未载入（或载入失败）时表单仍是默认值，禁止写库。
    if (loading || loadError || saving || experimentalBusy !== null) return;
    const base: Settings = {
      ...(loadedRef.current ?? DEFAULT_FORM),
      ...form,
    };
    setSaving(true);
    try {
      if (sessionHeaders) {
        // 会话模式：请求头只写入进程内存，数据库里保留空串。
        await api.setSessionOnlineHeaders(form.onlineHeaders);
        setSessionActive(form.onlineHeaders.trim().length > 0);
        const persisted: Settings = { ...base, onlineHeaders: "" };
        await api.setSettings(persisted);
        loadedRef.current = persisted;
      } else {
        await api.clearSessionOnlineHeaders();
        setSessionActive(false);
        await api.setSettings(base);
        loadedRef.current = base;
      }
      setDirty(false);
      recordBreadcrumb("settingsChange");
      window.dispatchEvent(new Event("mr-settings-updated"));
      toast(t("settings.toast.saved"));
      void api
        .getMemoryStats()
        .then(setMem)
        .catch(() => {});
    } catch (e) {
      toastErr("set_settings", e);
    } finally {
      setSaving(false);
    }
  };

  const ready = !loading && !loadError;
  const cachePct = mem ? cachePercent(mem.cacheBytes, mem.cacheLimitBytes) : 0;
  const diskCachePct = mem
    ? cachePercent(mem.diskCacheBytes, mem.diskCacheLimitBytes)
    : 0;
  const diskBudgetMb = Number.isFinite(form.diskCacheBudgetMb)
    ? Math.min(10240, Math.max(500, form.diskCacheBudgetMb))
    : 2048;
  const last7Pages = dash ? sumLast7Days(dash.heatmap) : 0;
  const statusText = loading
    ? t("settings.status.loading")
    : loadError
      ? t("settings.status.loadFailed")
      : saving
        ? t("settings.status.saving")
        : dirty
          ? t("settings.status.dirty")
          : t("settings.status.saved");
  const statusDot = loading || loadError
    ? "bg-muted-foreground"
    : saving
      ? "animate-pulse bg-primary"
      : dirty
        ? "bg-warning"
        : "bg-success";

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-24 pt-4 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t("settings.page.eyebrow")}
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">
            {t("nav.settings")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t("settings.page.description")}
          </p>
        </div>
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <ShieldCheck className="size-3.5" />
          {t("settings.page.localFirst")}
        </Badge>
      </header>

      {loadError ? (
        <Card className="items-start gap-3 p-2">
          <ErrorState
            message={t("settings.errors.loadSettingsDetail", {
              detail: loadError,
            })}
            onRetry={() => void load()}
          />
        </Card>
      ) : loading ? (
        <Card className="p-2" aria-busy="true">
          <PixelPet mode="loading" message={t("settings.page.loading")} />
        </Card>
      ) : (
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="gap-4"
        >
          {/* 单行 5 列：900px 最小窗口 + 六语长文案下不折行、不溢出。 */}
          <TabsList
            aria-label={t("settings.tabs.label")}
            className="grid h-auto w-full grid-cols-5 gap-0.5 overflow-hidden rounded-full border border-border bg-card p-1.5 shadow-hard group-data-horizontal/tabs:h-auto"
          >
            <TabsTrigger
              value="general"
              data-testid="settings-tab-general"
              className="h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm"
            >
              {t("settings.tabs.general")}
            </TabsTrigger>
            <TabsTrigger
              value="network"
              data-testid="settings-tab-network"
              className="h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm"
            >
              {t("settings.tabs.network")}
            </TabsTrigger>
            {/* QA 回归依赖 settings-tab-cache，storage 分区的 testid 保持旧值。 */}
            <TabsTrigger
              value="storage"
              data-testid="settings-tab-cache"
              className="h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm"
            >
              {t("settings.tabs.storage")}
            </TabsTrigger>
            <TabsTrigger
              value="privacy"
              data-testid="settings-tab-privacy"
              className="h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm"
            >
              {t("settings.tabs.privacy")}
            </TabsTrigger>
            <TabsTrigger
              value="about"
              data-testid="settings-tab-about"
              className="h-9 min-w-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground lg:px-3 xl:px-3.5 xl:text-sm"
            >
              {t("settings.tabs.about")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-2 space-y-4">
            <SettingsSection
              icon={Globe2}
              title={t("settings.language.title")}
              description={t("settings.language.description")}
            >
              <div className="flex min-w-0 flex-col gap-2 sm:max-w-md">
                <Label htmlFor="ui-language">
                  {t("settings.language.label")}
                </Label>
                <Select
                  items={LOCALE_OPTIONS}
                  value={locale}
                  onValueChange={(value) => {
                    if (isLocale(value)) {
                      setLocale(value);
                      recordBreadcrumb("localeChange");
                    }
                  }}
                >
                  <SelectTrigger
                    id="ui-language"
                    aria-label={t("settings.language.label")}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </SettingsSection>

            <SettingsSection
              icon={Palette}
              title={t("settings.theme.title")}
              description={t("settings.theme.description")}
            >
              <div
                role="group"
                aria-label={t("settings.theme.groupLabel")}
                className="grid gap-2 sm:grid-cols-3"
              >
                {THEME_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const active = mode === option.value;
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      variant={active ? "pill-primary" : "pill"}
                      size="pill"
                      className="h-auto w-full min-w-0 flex-col items-start gap-1 rounded-2xl px-4 py-3 text-left"
                      onClick={() => onThemeChange(option.value)}
                      disabled={saving}
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <Icon className="size-4 shrink-0" />
                        <span className="min-w-0 font-semibold">
                          {t(option.labelKey)}
                        </span>
                        {active ? (
                          <Check className="ml-auto size-4 shrink-0" />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] font-normal",
                          active
                            ? "text-primary-foreground/75"
                            : "text-muted-foreground",
                        )}
                      >
                        {t(option.hintKey)}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.theme.systemNote")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Keyboard}
              title={t("settings.shortcuts.title")}
              description={t("settings.shortcuts.description")}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {GLOBAL_SHORTCUTS.map((row) => (
                  <div
                    key={row.keys}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-border bg-background/60 px-3 py-2.5"
                  >
                    <span className="min-w-0 text-xs font-medium text-muted-foreground">
                      {t(row.actionKey)}
                    </span>
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-2.5 py-0.5 font-mono text-[11px]"
                    >
                      {row.keys}
                    </Badge>
                  </div>
                ))}
              </div>
              {/* 命令中心：文案自带键位，单独一行避免与键位胶囊重复。 */}
              <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-border bg-background/60 px-3 py-2.5">
                <Command className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 text-xs font-medium">
                  {t("settings.shortcuts.command")}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.shortcuts.note")}
              </p>
            </SettingsSection>
          </TabsContent>

          <TabsContent value="about" className="mt-2 space-y-4">
            <SettingsSection
              icon={Info}
              title={t("settings.about.title")}
              description={t("settings.about.description")}
            >
              <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    {t("settings.about.version")}
                  </dt>
                  <dd className="font-mono mt-1 text-sm font-semibold">
                    v{APP_VERSION}
                  </dd>
                </div>
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    {t("settings.about.commit")}
                  </dt>
                  <dd className="font-mono mt-1 truncate text-sm font-semibold" title={BUILD_COMMIT}>
                    {BUILD_COMMIT}
                  </dd>
                </div>
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    {t("settings.about.storage")}
                  </dt>
                  <dd className="mt-1 text-sm font-semibold">
                    {t("settings.about.storageValue")}
                  </dd>
                </div>
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    {t("settings.about.dataFlow")}
                  </dt>
                  <dd className="mt-1 text-sm font-semibold">
                    {t("settings.about.dataFlowValue")}
                  </dd>
                </div>
                <AboutBuildOriginCell />
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.about.note")}
              </p>
            </SettingsSection>

            <UpdatesPanel />
            <SupportPanel />

            {/* 非商用授权徽章（Build Origin）：常驻关于分区底部。 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className="rounded-full border border-border px-3 py-1 text-xs font-semibold whitespace-nowrap"
                >
                  {t("settings.about.nonCommercial")}
                </Badge>
                <span className="text-xs font-medium">
                  {t("settings.about.buildOriginLabel")}
                </span>
              </div>
              <AboutBuildOriginValue />
            </div>
          </TabsContent>

          <TabsContent value="privacy" className="mt-2 space-y-4">
            <PrivacyPanel />
          </TabsContent>

          <TabsContent value="network" className="mt-2 space-y-4">
            {safeMode ? (
              <Card className="items-start gap-3 p-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-warning text-background shadow-hard-sm">
                  <ShieldCheck className="size-4.5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base font-extrabold">
                    {t("safeMode.settingsOnlinePausedTitle")}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {t("safeMode.settingsOnlinePausedBody")}
                  </p>
                </div>
              </Card>
            ) : (
              <>
            <SettingsSection
              icon={Wifi}
              title={t("settings.online.urlTitle")}
              description={t("settings.online.urlDescription")}
            >
              <SettingRow
                title={t("settings.online.enableTitle")}
                description={t("settings.online.enableDescription")}
                badge={
                  <Badge
                    variant={form.experimentalOnline ? "success" : "muted"}
                  >
                    {form.experimentalOnline
                      ? t("common.enabled")
                      : t("common.disabled")}
                  </Badge>
                }
              >
                <Switch
                  aria-label={t("settings.online.enableTitle")}
                  checked={form.experimentalOnline}
                  disabled={experimentalBusy !== null || saving}
                  onCheckedChange={(checked) =>
                    void toggleExperimental("experimentalOnline", checked)
                  }
                />
              </SettingRow>
              <p className="text-xs text-muted-foreground">
                {t("settings.online.enableNote")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Globe2}
              title={t("settings.online.networkTitle")}
              description={t("settings.online.networkDescription")}
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="online-proxy">
                    {t("settings.online.proxyLabel")}
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="online-proxy"
                      value={form.onlineProxy}
                      onChange={(event) =>
                        set("onlineProxy", event.currentTarget.value)
                      }
                      placeholder={t("settings.online.proxyPlaceholder")}
                      className="min-w-0 font-mono text-xs sm:flex-1"
                      spellCheck={false}
                      disabled={saving}
                    />
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => void onDetectProxy()}
                      disabled={detectingProxy || saving}
                      title={t("settings.online.detectProxyTitle")}
                      aria-label={t("settings.online.detectProxyTitle")}
                    >
                      {detectingProxy ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Globe2 />
                      )}
                      {detectingProxy
                        ? t("settings.online.detecting")
                        : t("settings.online.detectProxy")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.online.proxyHint")}
                  </p>
                </div>

                <div className="min-w-0 space-y-2">
                  <Label>{t("settings.online.concurrencyLabel")}</Label>
                  <Select
                    items={concurrencyItems}
                    value={String(form.onlineConcurrency)}
                    disabled={saving}
                    onValueChange={(value) => {
                      const next = Number(value);
                      if (Number.isFinite(next)) {
                        set(
                          "onlineConcurrency",
                          Math.min(8, Math.max(1, next)),
                        );
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-label={t("settings.online.concurrencyLabel")}
                    >
                      <SelectValue
                        placeholder={t(
                          "settings.online.concurrencyPlaceholder",
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {concurrencyItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.online.concurrencyHint")}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="online-headers">
                    {t("settings.online.headersLabel")}
                  </Label>
                  {sessionActive ? (
                    <Badge variant="success">
                      {t("settings.online.sessionActive")}
                    </Badge>
                  ) : null}
                </div>
                <Textarea
                  id="online-headers"
                  value={form.onlineHeaders}
                  onChange={(event) =>
                    set("onlineHeaders", event.currentTarget.value)
                  }
                  rows={3}
                  placeholder={t("settings.online.headersPlaceholder")}
                  className="min-h-28 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.online.headersHint")}
                </p>
              </div>

              <div className="space-y-3 rounded-2xl border border-border bg-background/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {t("settings.online.storageMode")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("settings.online.storageModeDescription")}
                    </p>
                  </div>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label={t("settings.online.storageModeGroup")}
                  >
                    <Button
                      type="button"
                      variant={sessionHeaders ? "pill-primary" : "pill"}
                      size="pill-sm"
                      className="whitespace-nowrap"
                      aria-pressed={sessionHeaders}
                      disabled={saving}
                      onClick={() => {
                        setSessionHeaders(true);
                        setDirty(true);
                      }}
                    >
                      {t("settings.online.memoryOnly")}
                    </Button>
                    <Button
                      type="button"
                      variant={!sessionHeaders ? "pill-primary" : "pill"}
                      size="pill-sm"
                      className="whitespace-nowrap"
                      aria-pressed={!sessionHeaders}
                      disabled={saving}
                      onClick={() => {
                        setSessionHeaders(false);
                        setDirty(true);
                      }}
                    >
                      {t("settings.online.persistLocal")}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="pill"
                    size="pill-sm"
                    className="whitespace-nowrap"
                    onClick={() => void onClearSessionHeaders()}
                    disabled={!sessionActive || saving}
                  >
                    <Trash2 />
                    {t("settings.online.clearSession")}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {sessionActive
                      ? t("settings.online.sessionPresent")
                      : t("settings.online.sessionAbsent")}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.online.storageModeNote")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Activity}
              title={t("settings.online.testTitle")}
              description={t("settings.online.testDescription")}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={onlineTestUrl}
                  onChange={(event) =>
                    setOnlineTestUrl(event.currentTarget.value)
                  }
                  placeholder={t("settings.online.testUrlPlaceholder")}
                  aria-label={t("settings.online.testUrlAria")}
                  className="min-w-0 font-mono text-xs sm:flex-1"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void onTestOnline()}
                  disabled={testingOnline || saving}
                >
                  {testingOnline ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  {testingOnline
                    ? t("settings.online.testing")
                    : t("settings.online.testConnection")}
                </Button>
              </div>
              {onlineTestResult ? (
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border border-border p-3",
                    onlineTestResult.ok ? "bg-success/10" : "bg-destructive/10",
                  )}
                >
                  <Badge
                    variant={
                      onlineTestResult.ok ? "success" : "destructive"
                    }
                  >
                    {onlineTestResult.ok
                      ? t("settings.online.reachable")
                      : t("status.testFail")}
                  </Badge>
                  <span className="min-w-0 flex-1 break-words text-xs leading-relaxed">
                    {onlineTestResult.message}
                  </span>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("settings.online.testHint")}
              </p>
            </SettingsSection>

            <OnlineFilterPanel />
              </>
            )}
          </TabsContent>

          <TabsContent value="storage" className="mt-2 space-y-4">
            {dashError ? (
              <Card className="items-start gap-3 p-5">
                <div className="flex items-start gap-2.5">
                  <Info className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <p className="text-sm text-muted-foreground">
                    {t("settings.stats.loadError", { detail: dashError })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  onClick={() => void loadDashboard()}
                >
                  <RefreshCw />
                  {t("common.retry")}
                </Button>
              </Card>
            ) : dashLoading || !dash ? (
              <Card className="p-6" aria-busy="true">
                <p className="text-sm text-muted-foreground">
                  {t("settings.stats.loading")}
                </p>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  icon={BookOpen}
                  label={t("settings.stats.totalBooks")}
                  value={dash.totalBooks}
                  unit={t("settings.stats.unitBooks")}
                />
                <MetricCard
                  icon={TrendingUp}
                  label={t("settings.stats.reading")}
                  value={dash.reading}
                  unit={t("settings.stats.unitBooks")}
                />
                <MetricCard
                  icon={CalendarDays}
                  label={t("settings.stats.todayPages")}
                  value={dash.todayPages}
                  unit={t("common.pages")}
                />
                <MetricCard
                  icon={Gauge}
                  label={t("settings.stats.last7Pages")}
                  value={last7Pages}
                  unit={t("common.pages")}
                />
              </div>
            )}
            <Card className="flex-row items-start gap-2.5 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.stats.note")}
              </p>
            </Card>

            <DataBackupPanel onRestored={load} />

            <SettingsSection
              icon={FolderOpen}
              title={t("settings.library.title")}
              description={t("settings.library.description")}
            >
              <div className="space-y-2">
                <Label htmlFor="library-dir">
                  {t("settings.library.dirLabel")}
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="library-dir"
                    value={form.libraryDir}
                    onChange={(event) =>
                      set("libraryDir", event.currentTarget.value)
                    }
                    placeholder={t("settings.library.dirPlaceholder")}
                    className="min-w-0 font-mono text-xs sm:flex-1"
                    spellCheck={false}
                    disabled={saving}
                  />
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      className="whitespace-nowrap"
                      onClick={() => void onPickDir()}
                      disabled={scanning || saving}
                    >
                      <FolderOpen />
                      {t("settings.library.pick")}
                    </Button>
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-icon"
                      aria-label={t("settings.library.clearDir")}
                      title={t("settings.library.clearDir")}
                      onClick={() => set("libraryDir", "")}
                      disabled={!form.libraryDir || saving}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="pill-primary"
                  size="pill"
                  className="whitespace-nowrap"
                  onClick={() => void onScanLibrary()}
                  disabled={scanning || saving || !form.libraryDir.trim()}
                >
                  {scanning ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ScanLine />
                  )}
                  {scanning
                    ? t("settings.library.scanning")
                    : t("settings.library.scanNow")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("settings.library.scanHint")}
                </span>
              </div>
            </SettingsSection>

            <SettingsSection
              icon={Gauge}
              title={t("settings.cache.budgetTitle")}
              description={t("settings.cache.budgetDescription")}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{t("settings.cache.budgetLabel")}</Label>
                <Badge
                  variant="secondary"
                  className="font-mono px-3 py-1 tabular-nums"
                >
                  {formatNumber(form.cacheBudgetMb)} MB
                </Badge>
              </div>
              <Slider
                id="cache-budget"
                value={[form.cacheBudgetMb]}
                min={64}
                max={2048}
                step={64}
                disabled={saving}
                onValueChange={(value) =>
                  set(
                    "cacheBudgetMb",
                    typeof value === "number" ? value : (value[0] ?? 64),
                  )
                }
                getAriaLabel={() => t("settings.cache.budgetAria")}
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{formatNumber(64)} MB</span>
                <span>{formatNumber(2048)} MB</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.cache.budgetHint")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Cpu}
              title={t("settings.cache.memoryTitle")}
              description={t("settings.cache.memoryDescription")}
              action={
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  onClick={() => void refreshMemory()}
                >
                  <RefreshCw />
                  {t("common.refresh")}
                </Button>
              }
            >
              {mem ? (
                <>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">
                      {t("settings.cache.budgetUsage")}
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {formatNumber(cachePct)}%
                    </span>
                  </div>
                  <Progress value={cachePct} />
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <MemoryTile
                      label={t("settings.cache.process")}
                      value={`${mem.processMb.toFixed(1)} MB`}
                    />
                    <MemoryTile
                      label={t("settings.cache.imageCache")}
                      value={`${formatMb(mem.cacheBytes)} / ${formatMb(mem.cacheLimitBytes)}`}
                    />
                    <MemoryTile
                      label={t("settings.cache.cachedPages")}
                      value={t("settings.cache.pagesValue", {
                        count: formatNumber(mem.cachedPages),
                      })}
                    />
                    <MemoryTile
                      label={t("settings.cache.cachedThumbs")}
                      value={t("settings.cache.thumbsValue", {
                        count: formatNumber(mem.cachedThumbs),
                      })}
                    />
                    <MemoryTile
                      label={t("settings.cache.webtoonCache")}
                      value={t("settings.cache.webtoonValue", {
                        size: formatMb(mem.webtoonBytes),
                        count: formatNumber(mem.webtoonTiles),
                      })}
                    />
                    <MemoryTile
                      label={t("settings.cache.limit")}
                      value={formatMb(mem.cacheLimitBytes)}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("settings.cache.empty")}
                </p>
              )}
            </SettingsSection>

            <SettingsSection
              icon={HardDrive}
              title={t("settings.cache.diskTitle")}
              description={t("settings.cache.diskDescription")}
            >
              <div
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="disk-cache-usage"
              >
                <Label htmlFor="disk-cache-budget">
                  {t("settings.cache.diskLabel")}
                </Label>
                <Badge
                  variant="secondary"
                  className="font-mono px-3 py-1 tabular-nums"
                >
                  {formatNumber(diskBudgetMb)} MB
                </Badge>
              </div>
              <Slider
                id="disk-cache-budget"
                value={[diskBudgetMb]}
                min={500}
                max={10240}
                step={256}
                disabled={saving}
                onValueChange={(value) =>
                  set(
                    "diskCacheBudgetMb",
                    typeof value === "number" ? value : (value[0] ?? 2048),
                  )
                }
                getAriaLabel={() => t("settings.cache.diskAria")}
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{formatNumber(500)} MB</span>
                <span>{formatNumber(10240)} MB</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.cache.diskHint")}
              </p>

              {mem ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">
                      {t("settings.cache.diskUsage")}
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {formatMb(mem.diskCacheBytes)} /{" "}
                      {formatMb(mem.diskCacheLimitBytes)} ·{" "}
                      {formatNumber(diskCachePct)}%
                    </span>
                  </div>
                  <Progress value={diskCachePct} />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <MemoryTile
                      label={t("settings.cache.diskRender")}
                      value={formatMb(mem.renderCacheBytes)}
                    />
                    <MemoryTile
                      label={t("settings.cache.diskOnline")}
                      value={formatMb(mem.onlineCacheBytes)}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("settings.cache.diskEmpty")}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  className="whitespace-nowrap"
                  data-testid="clear-temp-cache"
                  onClick={() => void onClearTemp()}
                  disabled={
                    clearingTemp || clearingThumbs || clearingPages || saving
                  }
                >
                  {clearingTemp ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  {clearingTemp
                    ? t("settings.cache.clearingTemp")
                    : t("settings.cache.clearTemp")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.cache.clearTempHint")}
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Database}
              title={t("settings.cache.maintenanceTitle")}
              description={t("settings.cache.maintenanceDescription")}
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  className="whitespace-nowrap"
                  onClick={() => void onClearThumbs()}
                  disabled={
                    clearingThumbs || clearingPages || clearingTemp || saving
                  }
                >
                  {clearingThumbs ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ImageOff />
                  )}
                  {clearingThumbs
                    ? t("settings.cache.clearing")
                    : t("settings.cache.clearThumbs")}
                </Button>
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  className="whitespace-nowrap"
                  onClick={() => void onClearPages()}
                  disabled={
                    clearingPages || clearingThumbs || clearingTemp || saving
                  }
                >
                  {clearingPages ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  {clearingPages
                    ? t("settings.cache.purging")
                    : t("settings.cache.clearPages")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.cache.clearHint")}
              </p>
            </SettingsSection>
          </TabsContent>

        </Tabs>
      )}

      {tab === "general" || tab === "network" || tab === "storage" ? (
      <div className="sticky bottom-4 z-30 mt-6">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-hard">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground">
            <span
              className={cn("size-2 shrink-0 rounded-full", statusDot)}
              aria-hidden
            />
            <span className="truncate">{statusText}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {dirty && !saving ? (
              <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                {t("settings.status.saveHint")}
              </span>
            ) : null}
            <Button
              type="button"
              variant="pill-primary"
              size="pill"
              className="min-w-32 whitespace-nowrap"
              onClick={() => void onSave()}
              disabled={!ready || saving || experimentalBusy !== null}
            >
              {saving ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Save />
              )}
              {saving
                ? t("common.saving")
                : t("settings.saveButton")}
            </Button>
          </div>
        </div>
      </div>
      ) : null}
    </div>
  );
}

/**
 * 构建来源指纹：官方 CI 注入 `MR_BUILD_ORIGIN=official` → Official
 * Release；否则按社区构建展示。拉取失败回落 community（宁可误标社区，
 * 不把第三方产物冒充官方）。模块级缓存避免多处重复 invoke。
 */
let buildOriginCache: Promise<string> | null = null;
function fetchBuildOrigin(): Promise<string> {
  buildOriginCache ??= updateApi
    .getAppInfo()
    .then((info) => (info.buildOrigin === "official" ? "official" : "community"))
    .catch(() => "community");
  return buildOriginCache;
}

function useBuildOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchBuildOrigin().then((value) => {
      if (alive) setOrigin(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return origin;
}

/** 构建来源指纹格子（关于分区 dl 的第 5 格）。 */
function AboutBuildOriginCell() {
  const { t } = useI18n();
  const origin = useBuildOrigin();
  return (
    <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
      <dt className="text-[11px] font-medium text-muted-foreground">
        {t("settings.about.buildOrigin")}
      </dt>
      <dd className="mt-1 text-sm font-semibold">
        {origin === "official"
          ? t("settings.about.buildOriginOfficial")
          : t("settings.about.buildOriginCommunity")}
      </dd>
    </div>
  );
}

/** 构建来源指纹值（非商用徽章行右侧）。 */
function AboutBuildOriginValue() {
  const { t } = useI18n();
  const origin = useBuildOrigin();
  return (
    <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
      {origin === "official"
        ? t("settings.about.buildOriginOfficial")
        : t("settings.about.buildOriginCommunity")}
    </span>
  );
}
