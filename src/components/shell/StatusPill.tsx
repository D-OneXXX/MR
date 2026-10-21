import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Activity, ChevronRight } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useOnlineHandoffState } from "@/components/OnlineImportDialog";
import { api, type Settings } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  ONLINE_LAST_TEST_EVENT,
  readOnlineLastTest,
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
  const [open, setOpen] = useState(false);
  const [lastTest, setLastTest] = useState<OnlineLastTest | null>(
    readOnlineLastTest,
  );

  const refreshSettings = useCallback(() => {
    api.getSettings().then(setLiveSettings, () => {});
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

  const effectiveProxy = liveSettings?.onlineProxy ?? onlineProxy ?? "";
  const effectiveOnlineOn = liveSettings?.experimentalOnline ?? onlineOn;
  const ready = liveSettings !== null || (settingsReady && !settingsError);

  const modeLabel = !ready
    ? "读取中"
    : settingsError && liveSettings === null
      ? "网络状态不可用"
      : effectiveProxy.trim()
        ? `代理 ${proxyHost(effectiveProxy)}`
        : "直连";

  const testLabel = lastTest ? `${formatTime(lastTest.at)}` : "未测试";
  const dotClass = !ready
    ? "bg-muted-foreground"
    : lastTest?.ok === true
      ? "bg-success"
      : lastTest?.ok === false
        ? "bg-destructive"
        : effectiveOnlineOn
          ? "bg-primary"
          : "bg-muted-foreground";

  const handoffLabel = handoff?.active
    ? `127.0.0.1:${handoff.port} · 已接收 ${handoff.receivedChapters} 话`
    : "";

  const ariaLabel = useMemo(
    () =>
      [
        `网络：${modeLabel}`,
        lastTest
          ? `最近测试：${lastTest.ok ? "成功" : "失败"} ${testLabel} · ${lastTest.urlHost}`
          : "",
        handoffLabel ? `配对中：${handoffLabel}` : "",
      ]
        .filter(Boolean)
        .join("；"),
    [modeLabel, lastTest, testLabel, handoffLabel],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-2.5 text-[11px] font-semibold shadow-hard-sm outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
        <span className="mono hidden max-w-[120px] truncate text-muted-foreground md:inline">
          {modeLabel}
        </span>
        {handoff?.active && (
          <span className="hidden rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground sm:inline">
            配对
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[300px]! rounded-2xl! border-border! bg-popover! p-0! shadow-hard!"
      >
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold">网络与连接</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                状态来自已保存设置与最近一次测试
              </p>
            </div>
            <span className="grid size-8 place-items-center rounded-full border border-border bg-secondary text-secondary-foreground">
              <Activity className="size-4" />
            </span>
          </div>

          <dl className="mt-4 space-y-2 text-[12px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">连接方式</dt>
              <dd className="font-semibold">{modeLabel}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">在线直读</dt>
              <dd className="font-semibold">
                {effectiveOnlineOn ? "已开启" : "未开启"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">最近测试</dt>
              <dd
                className={cn(
                  "mono",
                  lastTest?.ok === false && "text-destructive",
                )}
              >
                {lastTest
                  ? `${lastTest.ok ? "成功" : "失败"} ${testLabel}`
                  : "未测试"}
              </dd>
            </div>
            {handoff?.active && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">配对桥接</dt>
                <dd className="mono text-right text-[11px]">{handoffLabel}</dd>
              </div>
            )}
          </dl>

          <Button
            variant="pill-primary"
            size="pill-sm"
            className="mt-4 w-full"
            onClick={() => {
              setOpen(false);
              nav("/settings");
            }}
          >
            打开网络设置
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
