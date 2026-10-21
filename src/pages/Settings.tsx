import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  Check,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  ImageOff,
  Info,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Save,
  ScanLine,
  ShieldCheck,
  Sparkles,
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
  useTheme,
  type ThemeMode,
} from "@/features/theme/ThemeProvider";
import { writeOnlineLastTest } from "@/lib/onlineLastTest";
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
import ErrorState from "@/components/ErrorState";
import PixelPet from "@/components/PixelPet";
import { toast, toastErr } from "@/components/Toast";

const APP_VERSION = "v0.6.0";

const DEFAULT_FORM: Settings = {
  theme: "system",
  cacheBudgetMb: 128,
  libraryDir: "",
  transApiKey: "",
  transEndpoint: "http://localhost:8080/v1",
  transModel: "",
  transTemp: 0,
  transTimeoutS: 30,
  ocrEndpoint: "",
  ocrTimeoutS: 30,
  srcLang: "ja",
  dstLang: "zh",
  experimentalTrans: false,
  experimentalWebtoon: false,
  experimentalOnline: false,
  onlineProxy: "",
  onlineConcurrency: 3,
  onlineHeaders: "",
  sidecarEndpoint: "http://127.0.0.1:8500",
  sidecarTimeoutS: 120,
  wbDetector: "ctd",
  wbOcr: "mit48pxctc",
  wbInpaint: "lama_large_512px",
};

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeMode;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  { value: "system", label: "跟随系统", hint: "随系统深浅色切换", icon: Monitor },
  { value: "light", label: "浅色", hint: "冰蓝画布", icon: Sun },
  { value: "dark", label: "深色", hint: "深夜座舱", icon: Moon },
];

const CONCURRENCY_ITEMS = Array.from({ length: 8 }, (_, index) => {
  const value = String(index + 1);
  return { value, label: `${value} 并发` };
});

function normalizeTheme(value: string): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

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
          {value.toLocaleString("zh-CN")}
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
 * 设置页：常规与主题 / 在线源网络 / 阅读统计 / 缓存。
 * 所有字段仍保存在 Settings 中，保存时以「已加载设置 + 当前表单」整对象写回，
 * 从而保留页面不再展示的翻译、OCR 等历史字段。
 */
export default function SettingsPage() {
  const { mode, setMode } = useTheme();
  const [form, setForm] = useState<Settings>(DEFAULT_FORM);
  const [mem, setMem] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [experimentalBusy, setExperimentalBusy] = useState<
    "experimentalWebtoon" | "experimentalOnline" | null
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
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState<string | null>(null);

  // 最近一次成功读/写数据库的完整设置；保存时作为底稿保留隐藏字段。
  const loadedRef = useRef<Settings | null>(null);
  const loadSeqRef = useRef(0);
  const dashSeqRef = useRef(0);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [settings, memory, session] = await Promise.all([
        api.getSettings(),
        api.getMemoryStats().catch(() => null),
        api.getSessionOnlineHeaders().catch(() => null),
      ]);
      if (seq !== loadSeqRef.current) return;
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
      setMem(memory);
      setSessionActive(sessionValue.length > 0);
      setSessionHeaders(sessionValue.length > 0);
      setDirty(false);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(typeof e === "string" ? e : "读取设置失败");
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
      setDashError(typeof e === "string" ? e : "统计读取失败");
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
    setForm((prev) => ({ ...prev, theme: next }));
    if (loadedRef.current) {
      loadedRef.current = { ...loadedRef.current, theme: next };
    }
  };

  // 实验开关立即持久化，但只写「数据库最新值 + 本开关」，
  // 不会把表单里尚未保存的代理、请求头、目录等一起写库。
  const toggleExperimental = async (
    key: "experimentalWebtoon" | "experimentalOnline",
    value: boolean,
  ) => {
    if (experimentalBusy !== null || saving || loading) return;
    const previous = form[key];
    const label = key === "experimentalWebtoon" ? "条漫模式" : "在线 URL 直读";
    setExperimentalBusy(key);
    setForm((prev) => ({ ...prev, [key]: value }));
    try {
      const persisted = await api.getSettings();
      const next = { ...persisted, [key]: value };
      await api.setSettings(next);
      loadedRef.current = next;
      setForm((prev) => ({ ...prev, [key]: value }));
      toast(`${label}${value ? "已开启" : "已关闭"}`);
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
        title: "选择漫画目录",
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
      toast(`扫描完成，书库共 ${result.books.length} 本`);
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
        toast("已填入系统代理，保存后生效");
      } else {
        toast("未检测到开启的系统代理");
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
      toast("已清空内存凭据");
    } catch (e) {
      toastErr("clear_session_online_headers", e);
    }
  };

  const onTestOnline = async () => {
    const target = onlineTestUrl.trim();
    if (!target) {
      toast("请填写清单或图集 URL");
      return;
    }
    setTestingOnline(true);
    setOnlineTestResult(null);
    try {
      const probe = await api.testOnlineConnection(target);
      writeOnlineLastTest({ ok: probe.ok, url: target });
      const summary = `${probe.title} · ${probe.pageCount} 页 · ${probe.elapsedMs} ms`;
      setOnlineTestResult({
        ok: probe.ok,
        message: probe.ok ? summary : probe.message || summary,
      });
      if (!probe.ok) toast(probe.message || "清单没有可读页面");
    } catch (e) {
      writeOnlineLastTest({ ok: false, url: target });
      setOnlineTestResult({
        ok: false,
        message: typeof e === "string" ? e : "连接测试失败",
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
      toast(`已清除 ${count} 个封面缓存，重新进入书库将自动重建`);
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
      toast("页面缓存已清空");
      await refreshMemory();
    } catch (e) {
      toastErr("clear_pages", e);
    } finally {
      setClearingPages(false);
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
      window.dispatchEvent(new Event("mr-settings-updated"));
      toast("设置已保存");
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
  const cachePct =
    mem && mem.cacheLimitBytes > 0
      ? Math.min(100, Math.round((mem.cacheBytes / mem.cacheLimitBytes) * 100))
      : 0;
  const last7Pages = dash ? sumLast7Days(dash.heatmap) : 0;
  const statusText = loading
    ? "正在加载设置…"
    : loadError
      ? "设置未加载"
      : saving
        ? "正在保存设置…"
        : dirty
          ? "有未保存的更改"
          : "所有更改已保存";
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
            Preferences
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">
            设置
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            外观、在线源、阅读统计与缓存都在这台设备上管理。
          </p>
        </div>
        <Badge variant="secondary" className="gap-1.5 px-3 py-1">
          <ShieldCheck className="size-3.5" />
          本地优先
        </Badge>
      </header>

      {loadError ? (
        <Card className="items-start gap-3 p-2">
          <ErrorState
            message={`设置加载失败：${loadError}`}
            onRetry={() => void load()}
          />
        </Card>
      ) : loading ? (
        <Card className="p-2" aria-busy="true">
          <PixelPet mode="loading" message="正在加载设置" />
        </Card>
      ) : (
        <Tabs defaultValue="general" className="gap-4">
          <TabsList
            aria-label="设置分区"
            className="h-auto w-full flex-wrap justify-start gap-1 rounded-full border border-border bg-card p-1.5 shadow-hard group-data-horizontal/tabs:h-auto"
          >
            <TabsTrigger
              value="general"
              className="h-9 flex-none gap-2 rounded-full px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
            >
              <Palette className="size-4" />
              常规与主题
            </TabsTrigger>
            <TabsTrigger
              value="online"
              className="h-9 flex-none gap-2 rounded-full px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
            >
              <Wifi className="size-4" />
              在线源网络
            </TabsTrigger>
            <TabsTrigger
              value="reading"
              className="h-9 flex-none gap-2 rounded-full px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
            >
              <TrendingUp className="size-4" />
              阅读统计
            </TabsTrigger>
            <TabsTrigger
              value="cache"
              className="h-9 flex-none gap-2 rounded-full px-3.5 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-foreground data-active:border-border data-active:bg-primary data-active:text-primary-foreground data-active:shadow-hard-sm dark:data-active:border-border dark:data-active:bg-primary dark:data-active:text-primary-foreground sm:px-4"
            >
              <HardDrive className="size-4" />
              缓存
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-2 space-y-4">
            <SettingsSection
              icon={Palette}
              title="外观主题"
              description="选择界面配色；切换会立即生效，并同步到本地偏好与数据库。"
            >
              <div
                role="group"
                aria-label="主题模式"
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
                      className="h-auto w-full flex-col items-start gap-1 rounded-2xl px-4 py-3 text-left"
                      onClick={() => onThemeChange(option.value)}
                      disabled={saving}
                    >
                      <span className="flex w-full items-center gap-2">
                        <Icon className="size-4" />
                        <span className="font-semibold">{option.label}</span>
                        {active ? <Check className="ml-auto size-4" /> : null}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] font-normal",
                          active
                            ? "text-primary-foreground/75"
                            : "text-muted-foreground",
                        )}
                      >
                        {option.hint}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                「跟随系统」会随操作系统的深浅色自动切换。
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Sparkles}
              title="实验性功能"
              description="默认关闭。开关切换会立即写入设置，不需要再点保存。"
            >
              <SettingRow
                title="条漫模式"
                description="韩漫长条纵向连续滚动，在单页 / 双页之外提供第三版式。"
                badge={
                  <Badge
                    variant={form.experimentalWebtoon ? "success" : "muted"}
                  >
                    {form.experimentalWebtoon ? "已开启" : "未开启"}
                  </Badge>
                }
              >
                <Switch
                  aria-label="条漫模式"
                  checked={form.experimentalWebtoon}
                  disabled={experimentalBusy !== null || saving}
                  onCheckedChange={(checked) =>
                    void toggleExperimental("experimentalWebtoon", checked)
                  }
                />
              </SettingRow>
              <p className="text-xs text-muted-foreground">
                切换只更新这个开关，不会顺带保存本页其他未保存的修改。
              </p>
            </SettingsSection>

            <SettingsSection
              icon={FolderOpen}
              title="书库目录"
              description="指定漫画所在目录；扫描会把新书加入本机书库。"
            >
              <div className="space-y-2">
                <Label htmlFor="library-dir">扫描目录</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="library-dir"
                    value={form.libraryDir}
                    onChange={(event) =>
                      set("libraryDir", event.currentTarget.value)
                    }
                    placeholder="D:\Manga 或 /path/to/manga"
                    className="font-mono text-xs sm:flex-1"
                    spellCheck={false}
                    disabled={saving}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      onClick={() => void onPickDir()}
                      disabled={scanning || saving}
                    >
                      <FolderOpen />
                      选择
                    </Button>
                    <Button
                      type="button"
                      variant="pill"
                      size="pill-icon"
                      aria-label="清空目录"
                      title="清空目录"
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
                  onClick={() => void onScanLibrary()}
                  disabled={scanning || saving || !form.libraryDir.trim()}
                >
                  {scanning ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ScanLine />
                  )}
                  {scanning ? "扫描中…" : "立即扫描"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  扫描使用上方目录，无需先保存；结果会以提示显示。
                </span>
              </div>
            </SettingsSection>

            <SettingsSection
              icon={Info}
              title="关于"
              description="MangaReader 是一个本地优先的漫画阅读器。"
            >
              <dl className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    版本
                  </dt>
                  <dd className="font-mono mt-1 text-sm font-semibold">
                    {APP_VERSION}
                  </dd>
                </div>
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    设置存储
                  </dt>
                  <dd className="mt-1 text-sm font-semibold">本机 SQLite</dd>
                </div>
                <div className="rounded-xl border border-border bg-background/60 px-3 py-2.5">
                  <dt className="text-[11px] font-medium text-muted-foreground">
                    数据去向
                  </dt>
                  <dd className="mt-1 text-sm font-semibold">不离开设备</dd>
                </div>
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                设置与阅读记录保存在本机；扫描、在线请求与阅读都不会上传个人数据。
              </p>
            </SettingsSection>
          </TabsContent>

          <TabsContent value="online" className="mt-2 space-y-4">
            <SettingsSection
              icon={Wifi}
              title="在线 URL 直读"
              description="支持 JSON 清单与单页 HTML 图集；关闭时书库与浏览器会提示先开启。"
            >
              <SettingRow
                title="启用在线源"
                description="允许从在线清单 / 图集导入并阅读，导入的章节会进入本机书库。"
                badge={
                  <Badge
                    variant={form.experimentalOnline ? "success" : "muted"}
                  >
                    {form.experimentalOnline ? "已开启" : "未开启"}
                  </Badge>
                }
              >
                <Switch
                  aria-label="启用在线源"
                  checked={form.experimentalOnline}
                  disabled={experimentalBusy !== null || saving}
                  onCheckedChange={(checked) =>
                    void toggleExperimental("experimentalOnline", checked)
                  }
                />
              </SettingRow>
              <p className="text-xs text-muted-foreground">
                切换会立即持久化；下方网络参数需点击底部「保存设置」后生效。
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Globe2}
              title="网络与请求"
              description="代理、并发与请求头会随在线请求发送；请只填写你信任的源或网关。"
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="online-proxy">代理地址</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="online-proxy"
                      value={form.onlineProxy}
                      onChange={(event) =>
                        set("onlineProxy", event.currentTarget.value)
                      }
                      placeholder="留空直连，或 http://127.0.0.1:7890"
                      className="font-mono text-xs sm:flex-1"
                      spellCheck={false}
                      disabled={saving}
                    />
                    <Button
                      type="button"
                      variant="pill"
                      size="pill"
                      onClick={() => void onDetectProxy()}
                      disabled={detectingProxy || saving}
                      title="读取 Windows 系统代理并填入代理地址，不会自动保存"
                    >
                      {detectingProxy ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Globe2 />
                      )}
                      {detectingProxy ? "检测中…" : "系统代理"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    支持 http / https / socks5；留空为直连。
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>页面并发</Label>
                  <Select
                    items={CONCURRENCY_ITEMS}
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
                    <SelectTrigger aria-label="页面并发">
                      <SelectValue placeholder="选择并发数" />
                    </SelectTrigger>
                    <SelectContent>
                      {CONCURRENCY_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    1–8；并发越高越快，也更容易被源限流。
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="online-headers">自定义请求头</Label>
                  {sessionActive ? (
                    <Badge variant="success">会话凭据生效中</Badge>
                  ) : null}
                </div>
                <Textarea
                  id="online-headers"
                  value={form.onlineHeaders}
                  onChange={(event) =>
                    set("onlineHeaders", event.currentTarget.value)
                  }
                  rows={3}
                  placeholder='{"Authorization":"Bearer ..."} 或 session=...; token=...'
                  className="min-h-28 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  请求头以明文保存在本机设置中，并会随请求发送到你配置的源或网关。
                </p>
              </div>

              <div className="space-y-3 rounded-2xl border border-border bg-background/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">存储模式</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      会话模式不写入数据库，退出应用即清除。
                    </p>
                  </div>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="请求头存储模式"
                  >
                    <Button
                      type="button"
                      variant={sessionHeaders ? "pill-primary" : "pill"}
                      size="pill-sm"
                      aria-pressed={sessionHeaders}
                      disabled={saving}
                      onClick={() => {
                        setSessionHeaders(true);
                        setDirty(true);
                      }}
                    >
                      仅驻留内存
                    </Button>
                    <Button
                      type="button"
                      variant={!sessionHeaders ? "pill-primary" : "pill"}
                      size="pill-sm"
                      aria-pressed={!sessionHeaders}
                      disabled={saving}
                      onClick={() => {
                        setSessionHeaders(false);
                        setDirty(true);
                      }}
                    >
                      持久化到本地库
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="pill"
                    size="pill-sm"
                    onClick={() => void onClearSessionHeaders()}
                    disabled={!sessionActive || saving}
                  >
                    <Trash2 />
                    清空内存凭据
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {sessionActive
                      ? "当前有请求头保存在进程内存中。"
                      : "当前没有会话请求头。"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                存储模式切换后需点击底部「保存设置」生效。
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Activity}
              title="连通性测试"
              description="解析目标清单或图集，只做探测，不写入书库。"
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={onlineTestUrl}
                  onChange={(event) =>
                    setOnlineTestUrl(event.currentTarget.value)
                  }
                  placeholder="https://example.com/manifest.json"
                  aria-label="在线清单或图集测试 URL"
                  className="font-mono text-xs sm:flex-1"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  onClick={() => void onTestOnline()}
                  disabled={testingOnline || saving}
                >
                  {testingOnline ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  {testingOnline ? "测试中…" : "测试连接"}
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
                    {onlineTestResult.ok ? "可连接" : "失败"}
                  </Badge>
                  <span className="min-w-0 flex-1 break-words text-xs leading-relaxed">
                    {onlineTestResult.message}
                  </span>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                测试使用已保存的代理与请求头；修改后请先保存设置。
              </p>
            </SettingsSection>
          </TabsContent>

          <TabsContent value="reading" className="mt-2 space-y-4">
            {dashError ? (
              <Card className="items-start gap-3 p-5">
                <div className="flex items-start gap-2.5">
                  <Info className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <p className="text-sm text-muted-foreground">
                    阅读统计加载失败：{dashError}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="pill"
                  size="pill-sm"
                  onClick={() => void loadDashboard()}
                >
                  <RefreshCw />
                  重试
                </Button>
              </Card>
            ) : dashLoading || !dash ? (
              <Card className="p-6" aria-busy="true">
                <p className="text-sm text-muted-foreground">
                  正在汇总本机阅读记录…
                </p>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  icon={BookOpen}
                  label="总藏书"
                  value={dash.totalBooks}
                  unit="本"
                />
                <MetricCard
                  icon={TrendingUp}
                  label="在读"
                  value={dash.reading}
                  unit="本"
                />
                <MetricCard
                  icon={CalendarDays}
                  label="今日阅读"
                  value={dash.todayPages}
                  unit="页"
                />
                <MetricCard
                  icon={Gauge}
                  label="近 7 天"
                  value={last7Pages}
                  unit="页"
                />
              </div>
            )}
            <Card className="flex-row items-start gap-2.5 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                只统计本机阅读记录中实际翻过的页面；未打开的书与未记录进度不计入。
              </p>
            </Card>
          </TabsContent>

          <TabsContent value="cache" className="mt-2 space-y-4">
            <SettingsSection
              icon={Gauge}
              title="缓存预算"
              description="预算越高，翻页越顺滑，但进程内存占用也越高。"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>内存缓存预算</Label>
                <Badge
                  variant="secondary"
                  className="font-mono px-3 py-1 tabular-nums"
                >
                  {form.cacheBudgetMb} MB
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
                getAriaLabel={() => "缓存预算（MB）"}
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>64 MB</span>
                <span>2048 MB</span>
              </div>
              <p className="text-xs text-muted-foreground">
                保存后立即套用到页面与缩略图缓存。
              </p>
            </SettingsSection>

            <SettingsSection
              icon={Cpu}
              title="内存使用"
              description="本次运行的内存与缓存快照。"
              action={
                <Button
                  type="button"
                  variant="pill-ghost"
                  size="pill-sm"
                  onClick={() => void refreshMemory()}
                >
                  <RefreshCw />
                  刷新
                </Button>
              }
            >
              {mem ? (
                <>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">
                      预算使用
                    </span>
                    <span className="font-mono font-semibold tabular-nums">
                      {cachePct}%
                    </span>
                  </div>
                  <Progress value={cachePct} />
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <MemoryTile
                      label="进程占用"
                      value={`${mem.processMb.toFixed(1)} MB`}
                    />
                    <MemoryTile
                      label="图片缓存"
                      value={`${formatMb(mem.cacheBytes)} / ${formatMb(mem.cacheLimitBytes)}`}
                    />
                    <MemoryTile
                      label="缓存页面"
                      value={`${mem.cachedPages} 页`}
                    />
                    <MemoryTile
                      label="封面缩略图"
                      value={`${mem.cachedThumbs} 张`}
                    />
                    <MemoryTile
                      label="条漫缓存"
                      value={`${formatMb(mem.webtoonBytes)} · ${mem.webtoonTiles} 片`}
                    />
                    <MemoryTile
                      label="预算上限"
                      value={formatMb(mem.cacheLimitBytes)}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">暂无内存统计。</p>
              )}
            </SettingsSection>

            <SettingsSection
              icon={Database}
              title="缓存维护"
              description="清理后按需重建，不影响书库与阅读进度。"
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  onClick={() => void onClearThumbs()}
                  disabled={clearingThumbs || clearingPages || saving}
                >
                  {clearingThumbs ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ImageOff />
                  )}
                  {clearingThumbs ? "清除中…" : "清除封面缓存"}
                </Button>
                <Button
                  type="button"
                  variant="pill"
                  size="pill"
                  onClick={() => void onClearPages()}
                  disabled={clearingPages || clearingThumbs || saving}
                >
                  {clearingPages ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  {clearingPages ? "清理中…" : "清空页面缓存"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                封面缓存清空后，重新进入书库会自动生成。
              </p>
            </SettingsSection>
          </TabsContent>
        </Tabs>
      )}

      <div className="sticky bottom-4 z-30 mt-6">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-hard">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
            <span
              className={cn("size-2 shrink-0 rounded-full", statusDot)}
              aria-hidden
            />
            <span className="truncate">{statusText}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {dirty && !saving ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                保存后写入本机设置
              </span>
            ) : null}
            <Button
              type="button"
              variant="pill-primary"
              size="pill"
              className="min-w-32"
              onClick={() => void onSave()}
              disabled={!ready || saving || experimentalBusy !== null}
            >
              {saving ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Save />
              )}
              {saving ? "保存中…" : "保存设置"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
