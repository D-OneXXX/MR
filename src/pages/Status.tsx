import { useCallback, useEffect, useState } from "react";
import { Activity, Cpu, Languages, Link2, RefreshCw, Server } from "lucide-react";
import {
  api,
  type MemoryStats,
  type Settings,
  type SidecarHealth,
  type TransStats,
} from "../lib/tauri";
import PixelPet from "../components/PixelPet";
import { toastErr, Toaster } from "../components/Toast";

/**
 * 服务状态（/status，工具页）：sidecar（检测/OCR/擦除模型）、
 * 翻译服务（OpenAI 兼容）、进程内存/缓存用量。全部只读，手动刷新。
 */
export default function StatusPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<SidecarHealth | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [stats, setStats] = useState<TransStats | null>(null);
  const [mem, setMem] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch((e) => toastErr("get_settings", e));
    api
      .sidecarHealth()
      .then((h) => {
        if (!alive) return;
        setHealth(h);
        setHealthErr(null);
      })
      .catch((e) => {
        if (!alive) return;
        setHealth(null);
        setHealthErr(String(e));
      });
    api
      .getTransStats()
      .then((t) => alive && setStats(t))
      .catch(() => {});
    api
      .getMemoryStats()
      .then((m) => alive && setMem(m))
      .catch((e) => toastErr("get_memory_stats", e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((v) => v + 1), []);

  const cachePct =
    mem && mem.cacheLimitBytes > 0
      ? Math.min(100, Math.round((mem.cacheBytes / mem.cacheLimitBytes) * 100))
      : 0;

  const modelBadge = (name: string, state: string | undefined) => {
    const label =
      state === "ready"
        ? "就绪"
        : state === "loading"
          ? "加载中"
          : state === "missing"
            ? "模型缺失"
            : "未加载";
    return (
      <span key={name} className="badge mono" title={`${name}: ${state ?? "unknown"}`}>
        {name} · {label}
      </span>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>服务状态</h2>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={refresh}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Server size={15} /> Sidecar · 检测 / OCR / 图像擦除
        </h3>
        {loading && !health && !healthErr ? (
          <PixelPet mode="loading" message="正在探测 sidecar" />
        ) : healthErr ? (
          <p className="hint">
            连接失败：{healthErr}
            <br />
            请确认 sidecar 已启动（默认 <span className="mono">http://127.0.0.1:8500</span>，
            启动方式见 <span className="mono">sidecar\launch.bat</span>）。
          </p>
        ) : health ? (
          <>
            <p className="hint mono">
              {settings?.sidecarEndpoint ?? "http://127.0.0.1:8500"} ·{" "}
              {health.ok ? "在线" : "异常"} · 设备 {health.device}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {modelBadge("ctd 检测", health.models?.detector)}
              {modelBadge("mit48px OCR", health.models?.ocr)}
              {modelBadge("lama 擦除", health.models?.inpaint)}
            </div>
          </>
        ) : null}
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Languages size={15} /> 翻译服务 · OpenAI 兼容
        </h3>
        <p className="hint mono">
          {settings?.transEndpoint || "未配置"} · 模型 {settings?.transModel || "未配置"} ·{" "}
          {settings?.srcLang ?? "ja"} → {settings?.dstLang ?? "zh"}
        </p>
        {stats ? (
          <p className="hint" style={{ marginTop: 6 }}>
            翻译 {stats.transCalls} 次（失败 {stats.transFail}，均值{" "}
            {stats.transAvgMs.toFixed(0)} ms）· OCR {stats.ocrCalls} 次（失败{" "}
            {stats.ocrFail}，均值 {stats.ocrAvgMs.toFixed(0)} ms）
          </p>
        ) : (
          <p className="hint" style={{ marginTop: 6 }}>
            暂无调用统计。
          </p>
        )}
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Link2 size={15} /> 在线直读
        </h3>
        <p className="hint mono">
          {settings?.experimentalOnline ? "已开启" : "未开启"} · 代理{" "}
          {settings?.onlineProxy ? "已配置" : "直连"} · 并发{" "}
          {settings?.onlineConcurrency ?? 3}
        </p>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Cpu size={15} /> 内存与缓存
        </h3>
        {mem ? (
          <>
            <p className="hint mono" style={{ margin: "0 0 6px" }}>
              进程 {mem.processMb.toFixed(1)} MB · 缓存{" "}
              {(mem.cacheBytes / 1048576).toFixed(1)} /{" "}
              {(mem.cacheLimitBytes / 1048576).toFixed(1)} MB · 页 {mem.cachedPages} ·
              缩略图 {mem.cachedThumbs} · 条漫 {mem.webtoonTiles} 片(
              {(mem.webtoonBytes / 1048576).toFixed(1)} MB)
            </p>
            <div className="progress-track big" style={{ marginTop: 4 }}>
              <div className="progress-fill" style={{ width: `${cachePct}%` }} />
            </div>
          </>
        ) : (
          <p className="hint">{loading ? "加载中…" : "暂无内存统计。"}</p>
        )}
      </div>

      <p className="hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Activity size={12} />
        服务异常时先看这里；sidecar 启动/排障见 docs/sidecar-api.md。
      </p>
      <Toaster />
    </div>
  );
}
