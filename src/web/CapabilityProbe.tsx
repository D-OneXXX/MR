import { useEffect, useMemo, useState } from "react";

/**
 * W6 真机与传输安全联合验证的**能力探针**（页面自报告）。
 *
 * 为什么做成页面自采集：W6 的证据必须来自**真机浏览器**，而人工在手机上逐条
 * 点选既慢又不可复现。把探测逻辑放进页面，手机打开一个 URL 就能把结论
 * 直接显示在屏幕上——不需要日志回传、不需要 USB 调试。
 *
 * 探测项与它们要回答的问题：
 * 1. `isSecureContext` —— http://<LAN-IP> 下是否为安全上下文（**规范事实**，
 *    但必须在目标浏览器上确认不被额外放宽）；
 * 2. `crypto.subtle` / `getRandomValues` / Service Worker / Clipboard ——
 *    安全上下文缺失时哪些能力直接不可用；
 * 3. **后台定时器节流实测** —— 页面被切到后台时 500ms 的定时器实际被拉长到多少；
 * 4. `performance.memory` —— Chromium 系的堆占用（iOS Safari 无此 API，
 *    它的内存上限只能靠"长条漫是否触发页面重载"观测，故一并报告"是否可用"）；
 * 5. 设备身份 —— UA + 视口 + DPR，用于把证据对应到具体机型。
 */

const TICK_KEY = "mr-probe-ticks";
const TICK_INTERVAL_MS = 500;

interface Capability {
  name: string;
  available: boolean;
  note: string;
}

interface ThrottleReport {
  samples: number;
  medianGapMs: number;
  maxGapMs: number;
  throttledGaps: number;
}

function readTicks(): number[] {
  try {
    const raw = localStorage.getItem(TICK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function summarize(ticks: number[]): ThrottleReport | null {
  if (ticks.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) gaps.push(ticks[i] - ticks[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    samples: gaps.length,
    medianGapMs: median,
    maxGapMs: sorted[sorted.length - 1],
    // 明显超过 1.5 个节拍 ⇒ 已被节流（后台或系统降频）。
    throttledGaps: gaps.filter((g) => g > TICK_INTERVAL_MS * 1.5).length,
  };
}

/** Chromium 专有的堆统计；其它浏览器没有这个 API。 */
function heapSnapshot(): { usedMb: number; limitMb: number } | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!mem) return null;
  return {
    usedMb: Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10,
    limitMb: Math.round((mem.jsHeapSizeLimit / 1048576) * 10) / 10,
  };
}

export default function CapabilityProbe() {
  const [ticks, setTicks] = useState<number[]>(() => readTicks());
  const visits = useMemo(() => {
    const prev = Number(localStorage.getItem("mr-probe-visits") || "0");
    const next = prev + 1;
    try {
      localStorage.setItem("mr-probe-visits", String(next));
    } catch {
      /* 隐私模式下 localStorage 可能不可写 */
    }
    return next;
  }, []);

  // 500ms 心跳：页面在后台时被浏览器节流，回到前台时就能算出实际间隔。
  useEffect(() => {
    const record = () => {
      const now = Date.now();
      const next = [...readTicks(), now].slice(-240);
      try {
        localStorage.setItem(TICK_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式下 localStorage 可能不可写：忽略即可 */
      }
      setTicks(next);
    };
    record();
    const id = window.setInterval(record, TICK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") setTicks(readTicks());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const throttle = useMemo(() => summarize(ticks), [ticks]);
  const heap = useMemo(() => heapSnapshot(), []);

  const capabilities: Capability[] = [
    {
      name: "isSecureContext",
      available: window.isSecureContext === true,
      note: "false ⇒ 非安全上下文：crypto.subtle / Service Worker / Clipboard 不可用",
    },
    {
      name: "crypto.subtle",
      available: Boolean(window.crypto && window.crypto.subtle),
      note: "WebCrypto 非对称/对称加密；配对流程若有密钥派生则必需",
    },
    {
      name: "crypto.getRandomValues",
      available: Boolean(window.crypto && window.crypto.getRandomValues),
      note: "随机数；即使非安全上下文通常也可用",
    },
    {
      name: "Service Worker",
      available: "serviceWorker" in navigator,
      note: "离线缓存与后台同步；非安全上下文不可用",
    },
    {
      name: "Clipboard",
      available: Boolean(navigator.clipboard),
      note: "复制/粘贴；权限与用户手势相关",
    },
    {
      name: "performance.memory",
      available: heap !== null,
      note: "堆占用统计；Chromium 专有，iOS Safari 无此 API",
    },
  ];

  const rows: [string, string][] = [
    ["访问次数", String(visits)],
    ["UA", navigator.userAgent],
    ["视口", `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`],
    ["页面来源", window.location.href],
    ["心跳样本", throttle ? String(throttle.samples) : "不足 2 个（刚打开？）"],
    ["心跳中位间隔", throttle ? `${throttle.medianGapMs} ms` : "—"],
    ["心跳最大间隔", throttle ? `${throttle.maxGapMs} ms` : "—"],
    ["被节流的间隔数", throttle ? `${throttle.throttledGaps} / ${throttle.samples}` : "—"],
    ["堆占用", heap ? `${heap.usedMb} MB / 上限 ${heap.limitMb} MB` : "该浏览器不提供此 API"],
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 bg-background px-4 py-6 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-extrabold tracking-tight">W6 能力探针</h1>
        <p className="text-sm opacity-70">
          把本页留在后台 30 秒再切回来，即可看到后台节流的实测值。
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">能力</h2>
        <ul className="flex flex-col gap-1.5">
          {capabilities.map((c) => (
            <li
              key={c.name}
              className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="font-medium">{c.name}</span>
                <span className="block text-xs opacity-70">{c.note}</span>
              </span>
              <span
                className={
                  c.available
                    ? "shrink-0 rounded-lg bg-primary px-2 py-0.5 text-xs text-primary-foreground"
                    : "shrink-0 rounded-lg border border-border px-2 py-0.5 text-xs"
                }
              >
                {c.available ? "可用" : "不可用"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">环境与节流</h2>
        <dl className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-32 shrink-0 opacity-70">{k}</dt>
              <dd className="min-w-0 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
