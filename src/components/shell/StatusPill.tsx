import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOnlineHandoffState } from "@/components/OnlineImportDialog";
import { api, type Settings } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  ONLINE_LAST_TEST_EVENT,
  readOnlineLastTest,
  writeOnlineLastTest,
  type OnlineLastTest,
} from "@/lib/onlineLastTest";

interface StatusPillProps {
  onlineProxy: string | null;
  settingsReady: boolean;
  settingsError: boolean;
  onlineOn: boolean;
}

function proxyHost(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "已配置";
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function StatusPill({
  onlineProxy,
  settingsReady,
  settingsError,
  onlineOn,
}: StatusPillProps) {
  const nav = useNavigate();
  const loc = useLocation();
  const { status: handoff } = useOnlineHandoffState();
  const [liveSettings, setLiveSettings] = useState<Settings | null>(null);
  const settingsSeq = useRef(0);
  const [open, setOpen] = useState(false);
  const [lastTest, setLastTest] = useState<OnlineLastTest | null>(
    readOnlineLastTest,
  );
  const [testUrl, setTestUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);

  // 路由 / 窗口 focus / 设置保存后重新读取，兜底壳层传入值。
  const refreshSettings = useCallback(() => {
    const seq = ++settingsSeq.current;
    api.getSettings().then(
      (settings) => {
        if (seq === settingsSeq.current) setLiveSettings(settings);
      },
      () => {
        /* 保留上一次成功读取或壳层传入值 */
      },
    );
  }, []);

  useEffect(() => {
    setLastTest(readOnlineLastTest());
    refreshSettings();
  }, [loc.pathname, refreshSettings]);

  useEffect(() => {
    const syncTest = () => setLastTest(readOnlineLastTest());
    const onFocus = () => {
      syncTest();
      refreshSettings();
    };
    const onSettings = () => refreshSettings();
    window.addEventListener("focus", onFocus);
    window.addEventListener("mr-settings-updated", onSettings);
    // api.setSettings 已广播该事件，实验开关切换也保持同步。
    window.addEventListener("mr-settings-changed", onSettings);
    window.addEventListener(ONLINE_LAST_TEST_EVENT, syncTest);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("mr-settings-updated", onSettings);
      window.removeEventListener("mr-settings-changed", onSettings);
      window.removeEventListener(ONLINE_LAST_TEST_EVENT, syncTest);
    };
  }, [refreshSettings]);

  useEffect(() => {
    if (open) setLastTest(readOnlineLastTest());
  }, [open]);

  const effectiveProxy = liveSettings?.onlineProxy ?? onlineProxy;
  const effectiveOnlineOn =
    liveSettings?.experimentalOnline ?? onlineOn;
  const ready =
    liveSettings !== null || (settingsReady && !settingsError);

  const modeLabel = !ready
    ? "读取中"
    : liveSettings === null && settingsError
      ? "网络状态不可用"
      : effectiveProxy?.trim()
        ? `代理 ${proxyHost(effectiveProxy)}`
        : "直连";

  const currentTest = ready ? lastTest : null;
  const testLabel = !currentTest
    ? ""
    : `${currentTest.ok ? "成功" : "失败"} ${formatTime(currentTest.at)}`;
  const testSummary = currentTest
    ? `${testLabel} · ${currentTest.urlHost}`
    : "";

  const pillLabel = testLabel ? `${modeLabel} · ${testLabel}` : modeLabel;
  const dotClass = !ready
    ? "bg-ink-muted"
    : currentTest?.ok === true
      ? "bg-success"
      : currentTest?.ok === false
        ? "bg-danger"
        : "bg-ink-muted";

  const handoffLabel = handoff?.active
    ? `配对中 · 127.0.0.1:${handoff.port} · 已接收 ${handoff.receivedChapters} 话`
    : "";
  const ariaLabel = useMemo(
    () =>
      [
        `网络：${modeLabel}`,
        testSummary ? `最近测试：${testSummary}` : "",
        handoffLabel,
      ]
        .filter(Boolean)
        .join("；"),
    [modeLabel, testSummary, handoffLabel],
  );

  const runTest = async () => {
    if (!ready || !effectiveOnlineOn || testing) return;
    const target = testUrl.trim();
    if (!target) {
      setTestErr("请输入测试 URL");
      return;
    }
    setTesting(true);
    setTestErr(null);
    try {
      const p = await api.testOnlineConnection(target);
      setLastTest(writeOnlineLastTest({ ok: p.ok, url: target }));
      if (!p.ok) setTestErr(p.message || "清单没有可读页面");
    } catch (e) {
      const message = typeof e === "string" ? e : "测试失败";
      setLastTest(writeOnlineLastTest({ ok: false, url: target }));
      setTestErr(message);
    } finally {
      setTesting(false);
    }
  };

  const goSettings = () => {
    setOpen(false);
    nav("/settings");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="group pointer-events-auto flex h-8 items-center rounded-lg px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="flex h-6 items-center gap-1.5 rounded-md border border-hairline bg-surface/80 px-2 text-[11px] text-ink shadow-sm">
          <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
          <span className="mono max-w-[240px] truncate text-ink-muted max-[1000px]:hidden">
            {pillLabel}
          </span>
          {handoff?.active && (
            <span className="rounded bg-accent px-1 py-0.5 text-[10px] font-semibold text-brand max-[1000px]:hidden">
              配对
            </span>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[340px]! border-0! bg-transparent! p-0! shadow-none! ring-0!"
      >
        <div className="glass rounded-xl border border-hairline p-3 text-ink shadow-xl">
          <div className="mb-3">
            <p className="text-[13px] font-semibold">网络与连接</p>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              状态来自已保存设置与手动测试
            </p>
          </div>

          <dl className="space-y-1.5 text-[12px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-muted">当前模式</dt>
              <dd className="text-ink">{modeLabel}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-muted">代理地址</dt>
              <dd className="mono max-w-[210px] truncate text-ink">
                {effectiveProxy?.trim() ? proxyHost(effectiveProxy) : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-muted">最近测试</dt>
              <dd
                className={cn(
                  "mono text-ink",
                  currentTest && !currentTest.ok && "text-danger",
                )}
              >
                {currentTest ? testLabel : "未测试"}
              </dd>
            </div>
            {currentTest && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">测试目标</dt>
                <dd
                  className="mono max-w-[210px] truncate text-ink"
                  title={currentTest.urlHost}
                >
                  {currentTest.urlHost}
                </dd>
              </div>
            )}
            {handoff?.active && (
              <div className="rounded-md bg-accent px-2 py-1.5 text-[11px] text-brand">
                <span className="mono">{handoffLabel}</span>
              </div>
            )}
          </dl>

          <div className="my-3 h-px bg-hairline" />

          {!effectiveOnlineOn ? (
            <div className="space-y-2">
              <p className="text-[11px] text-warning">
                在线直读未开启，连通性测试不可用。
              </p>
              <button
                type="button"
                className="flex h-8 w-full items-center justify-center rounded-md border border-hairline text-[12px] text-ink hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={goSettings}
              >
                去设置开启
              </button>
            </div>
          ) : !ready ? (
            <p className="text-[11px] text-ink-muted">
              {settingsError ? "网络设置读取失败。" : "正在读取网络设置…"}
            </p>
          ) : (
            <div className="space-y-2">
              <label
                htmlFor="status-test-url"
                className="block text-[11px] text-ink-muted"
              >
                测试 URL
              </label>
              <input
                id="status-test-url"
                className="h-8 w-full rounded-md border border-hairline bg-canvas/60 px-2 text-xs text-ink outline-none placeholder:text-ink-muted focus:border-brand"
                value={testUrl}
                onChange={(e) => {
                  setTestUrl(e.currentTarget.value);
                  setTestErr(null);
                }}
                placeholder="https://example.com/manifest.json"
              />
              {testErr && (
                <p className="text-[11px] text-danger">{testErr}</p>
              )}
              <button
                type="button"
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-brand text-[12px] font-medium text-primary-foreground transition-colors hover:bg-brand/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                onClick={() => void runTest()}
                disabled={testing || !testUrl.trim()}
              >
                {testing && <Loader2 size={14} className="animate-spin" />}
                {testing ? "测试中…" : "测试连通性"}
              </button>
            </div>
          )}

          <button
            type="button"
            className="mt-2 flex h-8 w-full items-center justify-between rounded-md border border-hairline px-2.5 text-[12px] text-ink hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            onClick={goSettings}
          >
            <span>打开网络设置</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
