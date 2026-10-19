import { useEffect, useState } from "react";
import {
  Cpu,
  FlaskConical,
  FolderOpen,
  ImageOff,
  Keyboard,
  Languages,
  Link2,
  Moon,
  Save,
  ScanLine,
  Sun,
  Trash2,
} from "lucide-react";
import { api, type MemoryStats, type Settings, type TransStats } from "../lib/tauri";
import { READER_SHORTCUTS } from "../components/Reader/shortcuts";
import ErrorState from "../components/ErrorState";
import { toast, toastErr, Toaster } from "../components/Toast";

/**
 * 设置页（亮色）：主题、缓存预算（MB 可调）、扫描目录；
 * 阶段三翻译服务配置区转正式：endpoint/key/model/语言对/超时 + 调用统计。
 * 只经 get_settings / set_settings / get_memory_stats / get_trans_stats 读写。
 */
const DEFAULT_FORM: Settings = {
  theme: "dark",
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

export default function SettingsPage() {
  const [form, setForm] = useState<Settings>(DEFAULT_FORM);
  const [mem, setMem] = useState<MemoryStats | null>(null);
  const [stats, setStats] = useState<TransStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regenThumbs, setRegenThumbs] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [onlineTestUrl, setOnlineTestUrl] = useState("");
  const [onlineProbe, setOnlineProbe] = useState<string | null>(null);
  const [testingOnline, setTestingOnline] = useState(false);

  const load = () => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.getSettings(),
      api.getMemoryStats(),
      // 统计挂了不该拖垮设置页加载。
      api.getTransStats().catch(() => null),
    ])
      .then(
        ([s, m, t]) => {
          if (!alive) return;
          setForm({ ...DEFAULT_FORM, ...s });
          setMem(m);
          setStats(t);
          document.documentElement.dataset.theme = s.theme || "dark";
          try {
            localStorage.setItem("mr-theme", s.theme || "dark");
          } catch {
            /* 忽略 */
          }
        },
        (e) => {
          if (!alive) return;
          setLoadError(String(e));
          toastErr("get_settings", e);
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  };

  useEffect(load, []);

  // 重新生成缩略图：清空封面缓存，重进书库自动重建。
  const onRegenThumbs = async () => {
    setRegenThumbs(true);
    try {
      const n = await api.clearThumbCache();
      toast(`已清除 ${n} 个封面缓存，重新进入书库将自动重建`);
    } catch (e) {
      toastErr("clear_thumbnail_cache", e);
    } finally {
      setRegenThumbs(false);
    }
  };

  // 实验性开关：点选即生效（持久化 + 镜像 + 广播）。
  const setExperimental = async (
    key: "experimentalTrans" | "experimentalWebtoon" | "experimentalOnline",
    v: boolean,
  ) => {
    const next = { ...form, [key]: v };
    setForm(next);
    const label =
      key === "experimentalTrans"
        ? "翻译功能"
        : key === "experimentalWebtoon"
          ? "条漫模式"
          : "在线 URL 直读";
    try {
      await api.setSettings(next);
      toast(v ? `${label}已开启` : `${label}已关闭`);
    } catch (e) {
      toastErr("set_settings", e);
    }
  };

  // libraryDir 的动作面：对配置里的默认目录立即执行一次扫描。
  const onScanConfigured = async () => {
    if (!form.libraryDir.trim()) return;
    setScanning(true);
    try {
      const r = await api.scanLibrary(form.libraryDir.trim());
      toast(`扫描完成，书库共 ${r.books.length} 本`);
    } catch (e) {
      toastErr("scan_library", e);
    } finally {
      setScanning(false);
    }
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const testOnline = async () => {
    if (!onlineTestUrl.trim()) {
      toast("请填写清单或图集 URL");
      return;
    }
    setTestingOnline(true);
    setOnlineProbe(null);
    try {
      const p = await api.testOnlineConnection(onlineTestUrl.trim());
      setOnlineProbe(`${p.title} · ${p.pageCount} 页 · ${p.elapsedMs} ms`);
      if (!p.ok) toast(p.message || "清单没有可读页面");
    } catch (e) {
      toastErr("test_online_connection", e);
    } finally {
      setTestingOnline(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await api.setSettings(form);
      document.documentElement.dataset.theme = form.theme;
      try {
        localStorage.setItem("mr-theme", form.theme);
      } catch {
        /* 忽略 */
      }
      toast("设置已保存");
    } catch (e) {
      toastErr("set_settings", e);
    } finally {
      setSaving(false);
    }
  };

  const pickDir = () => {
    const v = window.prompt("扫描目录（绝对路径）：", form.libraryDir);
    if (v !== null) set("libraryDir", v.trim());
  };

  const cachePct =
    mem && mem.cacheLimitBytes > 0
      ? Math.min(100, Math.round((mem.cacheBytes / mem.cacheLimitBytes) * 100))
      : 0;

  return (
    <div>
      {loadError ? (
        <ErrorState message={`设置加载失败：${loadError}`} onRetry={load} />
      ) : (
        <>
        <div className="card section-card">
        <h3 className="section-title">
          {form.theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
          外观主题
        </h3>
        <div className="seg" role="group" aria-label="主题">
          {(["light", "dark"] as const).map((t) => (
            <button
              key={t}
              className={form.theme === t ? "on" : ""}
              onClick={() => {
                // 点选即生效(不用等保存);保存后持久化到 SQLite。
                document.documentElement.dataset.theme = t;
                try {
                  localStorage.setItem("mr-theme", t);
                } catch {
                  /* 忽略 */
                }
                set("theme", t);
              }}
            >
              {t === "light" ? "亮色理性面" : "暗色沉浸面"}
            </button>
          ))}
        </div>
        <p className="hint">点选即切换;保存后重启仍保持。</p>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <FlaskConical size={15} /> 实验性功能
        </h3>
        <div className="field-row" style={{ alignItems: "center" }}>
          <span style={{ flex: 1 }}>
            翻译功能
            <span className="badge" style={{ marginLeft: 8 }}>
              {form.experimentalTrans ? "已开启" : "未开启"}
            </span>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              翻译工作台、阅读器选区翻译、批量预翻译、术语表。默认关闭，关闭时相关入口与页面全部隐藏。
            </p>
          </span>
          <button
            className={`btn${form.experimentalTrans ? " primary" : ""}`}
            onClick={() => void setExperimental("experimentalTrans", !form.experimentalTrans)}
          >
            {form.experimentalTrans ? "关闭" : "开启"}
          </button>
        </div>
        <div
          className="field-row"
          style={{ alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}
        >
          <span style={{ flex: 1 }}>
            条漫模式
            <span className="badge" style={{ marginLeft: 8 }}>
              {form.experimentalWebtoon ? "已开启" : "未开启"}
            </span>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              韩漫长条纵向连续滚动（单页/双页之外的第三版式）。默认关闭，关闭时版式只在单页/双页间切换。
            </p>
          </span>
          <button
            className={`btn${form.experimentalWebtoon ? " primary" : ""}`}
            onClick={() =>
              void setExperimental("experimentalWebtoon", !form.experimentalWebtoon)
            }
          >
            {form.experimentalWebtoon ? "关闭" : "开启"}
          </button>
        </div>
        <div
          className="field-row"
          style={{ alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}
        >
          <span style={{ flex: 1 }}>
            在线 URL 直读（JSON 清单 / HTML 图集）
            <span className="badge" style={{ marginLeft: 8 }}>
              {form.experimentalOnline ? "已开启" : "未开启"}
            </span>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              支持匿名 JSON 清单与单页 HTML 图集；不支持自动登录、JS 渲染或分页查看器。
            </p>
          </span>
          <button
            className={`btn${form.experimentalOnline ? " primary" : ""}`}
            onClick={() =>
              void setExperimental("experimentalOnline", !form.experimentalOnline)
            }
          >
            {form.experimentalOnline ? "关闭" : "开启"}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          点选即生效并持久化；开启后对应入口会出现。
        </p>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Cpu size={15} /> 缓存预算 <span className="badge">阶段一</span>
        </h3>
        <div className="field">
          <span>
            预算（MB）：<span className="mono">{form.cacheBudgetMb}</span>
          </span>
          <input
            type="range"
            min={64}
            max={2048}
            step={64}
            value={form.cacheBudgetMb}
            onChange={(e) => set("cacheBudgetMb", Number(e.currentTarget.value))}
            aria-label="缓存预算 MB"
          />
          <div className="field-row">
            <input
              className="input mono"
              type="number"
              min={64}
              max={4096}
              value={form.cacheBudgetMb}
              onChange={(e) =>
                set("cacheBudgetMb", Math.max(64, Number(e.currentTarget.value) || 64))
              }
              aria-label="缓存预算数值"
            />
            <span className="hint">MB</span>
          </div>
        </div>
        {loading ? (
          <p className="hint">内存统计加载中…</p>
        ) : mem ? (
          <div className="cache-meter">
            <p className="hint mono" style={{ margin: "8px 0 4px" }}>
              进程 {mem.processMb.toFixed(1)} MB · 缓存{" "}
              {(mem.cacheBytes / 1048576).toFixed(1)} /{" "}
              {(mem.cacheLimitBytes / 1048576).toFixed(1)} MB · 页{" "}
              {mem.cachedPages} · 缩略图 {mem.cachedThumbs}
            </p>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${cachePct}%` }} />
            </div>
          </div>
        ) : (
          <p className="hint">暂无内存统计。</p>
        )}
        <div className="field-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void onRegenThumbs()} disabled={regenThumbs}>
            <ImageOff size={14} /> {regenThumbs ? "清除中…" : "重新生成缩略图"}
          </button>
          <span className="hint" style={{ alignSelf: "center" }}>
            封面显示异常时使用；清除后重新进入书库自动重建。
          </span>
        </div>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <FolderOpen size={15} /> 扫描目录
        </h3>
        <div className="field-row">
          <input
            className="input mono"
            value={form.libraryDir}
            placeholder="/path/to/manga（阶段一单目录）"
            onChange={(e) => set("libraryDir", e.currentTarget.value)}
            aria-label="扫描目录"
          />
          <button className="btn" onClick={pickDir}>
            选择
          </button>
          {form.libraryDir && (
            <button
              className="btn"
              title="清空"
              onClick={() => set("libraryDir", "")}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            className="btn"
            onClick={() => void onScanConfigured()}
            disabled={scanning || !form.libraryDir.trim()}
            title="对上方配置的目录执行一次扫描入库"
          >
            <ScanLine size={14} /> {scanning ? "扫描中…" : "立即扫描"}
          </button>
        </div>
        <p className="hint">多目录 scanDirs 在阶段二扩展；阶段一保持单 libraryDir。</p>
      </div>

      {form.experimentalTrans && (
      <div className="card section-card">
        <h3 className="section-title">
          <Languages size={15} /> 翻译服务 <span className="badge">阶段三</span>
        </h3>
        <p className="hint">
          OCR 默认走 Windows 本地引擎(需系统语言包);配置 OCR Endpoint
          则改发 image→text JSON 协议。翻译走 OpenAI 兼容 /chat/completions。
        </p>
        <div className="form-grid two" style={{ marginTop: 8 }}>
          <label className="field">
            <span>Endpoint</span>
            <input
              className="input mono"
              value={form.transEndpoint}
              onChange={(e) => set("transEndpoint", e.currentTarget.value)}
              placeholder="http://localhost:8080/v1"
            />
          </label>
          <label className="field">
            <span>API Key</span>
            <input
              className="input mono"
              type="password"
              value={form.transApiKey}
              placeholder="Bearer 鉴权,可留空"
              onChange={(e) => set("transApiKey", e.currentTarget.value)}
              aria-label="API Key"
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              className="input mono"
              value={form.transModel}
              onChange={(e) => set("transModel", e.currentTarget.value)}
              placeholder="e.g. qwen2.5:7b"
            />
          </label>
          <label className="field">
            <span>Temperature</span>
            <input
              className="input mono"
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={form.transTemp}
              onChange={(e) => set("transTemp", Number(e.currentTarget.value))}
            />
          </label>
          <label className="field">
            <span>源语言</span>
            <input
              className="input mono"
              value={form.srcLang}
              onChange={(e) => set("srcLang", e.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>目标语言</span>
            <input
              className="input mono"
              value={form.dstLang}
              onChange={(e) => set("dstLang", e.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>翻译超时（秒）</span>
            <input
              className="input mono"
              type="number"
              min={1}
              value={form.transTimeoutS}
              onChange={(e) =>
                set("transTimeoutS", Math.max(1, Number(e.currentTarget.value) || 30))
              }
            />
          </label>
          <label className="field">
            <span>OCR 超时（秒）</span>
            <input
              className="input mono"
              type="number"
              min={1}
              value={form.ocrTimeoutS}
              onChange={(e) =>
                set("ocrTimeoutS", Math.max(1, Number(e.currentTarget.value) || 30))
              }
            />
          </label>
        </div>
        <label className="field" style={{ marginTop: 12 }}>
          <span>OCR Endpoint</span>
          <input
            className="input mono"
            value={form.ocrEndpoint}
            onChange={(e) => set("ocrEndpoint", e.currentTarget.value)}
            placeholder="留空用 Windows 本地 OCR"
          />
        </label>
        <div className="form-grid two" style={{ marginTop: 12 }}>
          <label className="field">
            <span>Sidecar Endpoint(检测/OCR/擦除)</span>
            <input
              className="input mono"
              value={form.sidecarEndpoint}
              onChange={(e) => set("sidecarEndpoint", e.currentTarget.value)}
              placeholder="http://127.0.0.1:8500"
            />
          </label>
          <label className="field">
            <span>Sidecar 超时(秒)</span>
            <input
              className="input mono"
              type="number"
              min={5}
              value={form.sidecarTimeoutS}
              onChange={(e) =>
                set("sidecarTimeoutS", Math.max(5, Number(e.currentTarget.value) || 120))
              }
            />
          </label>
        </div>
        {stats && (
          <div className="hint mono" style={{ marginTop: 12 }}>
            OCR {stats.ocrCalls} 次(失败 {stats.ocrFail},均值{" "}
            {stats.ocrAvgMs.toFixed(0)} ms) · 翻译 {stats.transCalls} 次(失败{" "}
            {stats.transFail},均值 {stats.transAvgMs.toFixed(0)} ms)
            {stats.recent[0]
              ? ` · 最近 ${stats.recent[0].createdAt}`
              : " · 暂无调用"}
          </div>
        )}
      </div>
      )}

      {form.experimentalOnline && (
        <div className="card section-card">
          <h3 className="section-title">
            <Link2 size={15} /> 在线源与网络
          </h3>
          <p className="hint">
            支持 JSON 清单与单页 HTML 直铺图集；请求头仅用于你自建/有权访问的网关，
            会明文保存在本机。不支持分页查看器、切条反混淆、自动登录或 JS 渲染。
          </p>
          <div className="form-grid two" style={{ marginTop: 8 }}>
            <label className="field">
              <span>代理地址</span>
              <input
                className="input mono"
                value={form.onlineProxy}
                onChange={(e) => set("onlineProxy", e.currentTarget.value)}
                placeholder="留空直连，或 http://127.0.0.1:7890 / socks5://..."
              />
            </label>
            <label className="field">
              <span>并发数</span>
              <input
                className="input mono"
                type="number"
                min={1}
                max={8}
                value={form.onlineConcurrency}
                onChange={(e) =>
                  set("onlineConcurrency", Number(e.currentTarget.value) || 1)
                }
              />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>自定义请求头（JSON 或单行 Cookie）</span>
              <textarea
                className="input mono"
                rows={3}
                style={{ fontSize: "inherit", resize: "vertical" }}
                value={form.onlineHeaders}
                onChange={(e) => set("onlineHeaders", e.currentTarget.value)}
                placeholder='{"Authorization":"Bearer ..."} 或 session=...; token=...'
              />
              <span className="hint">
                敏感信息：将以明文保存在本机设置中，不会上传；仅填写你信任的源或网关。
              </span>
            </label>
          </div>
          <div className="field-row" style={{ marginTop: 12 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              value={onlineTestUrl}
              onChange={(e) => setOnlineTestUrl(e.currentTarget.value)}
              placeholder="https://example.com/manifest.json"
              aria-label="在线清单或图集测试 URL"
            />
            <button className="btn" onClick={() => void testOnline()} disabled={testingOnline}>
              {testingOnline ? "测试中…" : "测试连通性"}
            </button>
          </div>
          <p className="hint">测试使用已保存的代理与请求头，修改后请先保存设置。</p>
          {onlineProbe && <p className="hint mono">{onlineProbe}</p>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={onSave} disabled={saving}>
          <Save size={14} /> {saving ? "保存中…" : "保存设置"}
        </button>
      </div>
        </>
      )}

      <div className="card section-card">
        <h3 className="section-title">
          <Keyboard size={15} /> 快捷键
        </h3>
        <div className="sc-list">
          {READER_SHORTCUTS.map((s) => (
            <div className="sc-row" key={s.keys}>
              <span className="mono sc-keys">{s.keys}</span>
              <span className="sc-action">{s.action}</span>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          阅读器内按 <span className="mono">?</span> 可随时呼出本表。
        </p>
      </div>
      <Toaster />
    </div>
  );
}
