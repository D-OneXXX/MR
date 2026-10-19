import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Eraser,
  Languages,
  Plus,
  RefreshCw,
  ScanText,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type BatchJob,
  type BookInfo,
  type DetectBox,
  type PageImage,
  type Settings,
} from "../lib/tauri";
import { toast, toastErr, Toaster } from "../components/Toast";
import PixelPet from "../components/PixelPet";
import ErrorState from "../components/ErrorState";
import "../components/Reader.css";

/**
 * 翻译工作台(亮色面)—— 阶段三两步工作流:
 * ① 检测 + OCR:sidecar ctd 出框 → 展示文本框 → 人工删除拟声词/装饰字框;
 * ② 翻译 + 擦除 + 嵌字:保留框逐条翻译(缓存秒出、术语表注入)→ lama 擦除 → 译文嵌回。
 * 原图永不修改;删除框的区域不做擦除,原拟声词画面保持完好。
 * provider 选择经 set_settings 持久化(检测/OCR/擦除三槽;翻译固定 OpenAI 兼容服务)。
 */

const OCR_PROVIDERS = [
  { value: "mit48pxctc", label: "mit48px(sidecar)" },
  { value: "windows", label: "Windows 本地 OCR" },
  { value: "http", label: "HTTP OCR 服务" },
];
const INPAINT_PROVIDERS = [
  { value: "lama_large_512px", label: "lama_large_512px(sidecar)" },
  { value: "none", label: "不擦除(仅嵌字覆盖)" },
];

interface Step2State {
  translations: string[]; // 对齐保留框
  keepIdx: number[];
  erased: { dataUrl: string } | null;
  elapsedMs: number;
}

export default function Workbench() {
  const nav = useNavigate();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [bookId, setBookId] = useState("");
  const [pageInput, setPageInput] = useState("1");
  const [page, setPage] = useState<PageImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  // 步骤一产物
  const [full, setFull] = useState<{ width: number; height: number } | null>(null);
  const [boxes, setBoxes] = useState<DetectBox[]>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [ocrTexts, setOcrTexts] = useState<string[]>([]);
  const [step1Ms, setStep1Ms] = useState<number | null>(null);

  // 步骤二产物
  const [step2, setStep2] = useState<Step2State | null>(null);

  // sidecar 健康与术语表
  const [health, setHealth] = useState<{ ok: boolean; text: string } | null>(null);
  const [glossary, setGlossary] = useState<[string, string][]>([]);
  const [glSrc, setGlSrc] = useState("");
  const [glDst, setGlDst] = useState("");

  // 批量预翻译(当前书的任务)
  const [job, setJob] = useState<BatchJob | null>(null);
  const [storedHint, setStoredHint] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dispW, setDispW] = useState(0);

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    let alive = true;
    Promise.all([api.getSettings(), api.listBooks()])
      .then(
        ([s, b]) => {
          if (!alive) return;
          setSettings(s);
          setBooks(b);
          if (b.length > 0) setBookId((cur) => cur || b[0].id);
          document.documentElement.dataset.theme = s.theme || "light";
        },
        (e) => toastErr("get_settings", e),
      )
      .finally(() => refreshHealth());
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshHealth = useCallback(() => {
    api.sidecarHealth().then(
      (h) =>
        setHealth({
          ok: true,
          text: `sidecar ${h.device} · 检测 ${h.models.detector ?? "?"} · OCR ${h.models.ocr ?? "?"} · 擦除 ${h.models.inpaint ?? "?"}`,
        }),
      (e) =>
        setHealth({
          ok: false,
          text: `sidecar 不可达:${e}(运行 sidecar\\launch.bat 启动)`,
        }),
    );
  }, []);

  /* ---------- 术语表(按系列=书) ---------- */
  useEffect(() => {
    if (!bookId) return;
    api.glossaryList(bookId).then(setGlossary, () => setGlossary([]));
  }, [bookId]);

  /* ---------- 当前书批量任务轮询 ---------- */
  useEffect(() => {
    let alive = true;
    const poll = () => {
      api
        .batchList()
        .then((list) => {
          if (alive) setJob(list.find((j) => j.bookId === bookId) ?? null);
        })
        .catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [bookId]);

  const addGlossary = async () => {
    if (!glSrc.trim() || !glDst.trim()) return;
    try {
      await api.glossarySet(bookId, glSrc, glDst);
      setGlossary(await api.glossaryList(bookId));
      setGlSrc("");
      setGlDst("");
      toast("术语已添加");
    } catch (e) {
      toastErr("glossary_set", e);
    }
  };

  const removeGlossary = async (src: string) => {
    try {
      await api.glossaryRemove(bookId, src);
      setGlossary(await api.glossaryList(bookId));
    } catch (e) {
      toastErr("glossary_remove", e);
    }
  };

  /* ---------- provider 下拉框(整表保存) ---------- */
  const setProvider = (slot: "wbDetector" | "wbOcr" | "wbInpaint", value: string) => {
    if (!settings) return;
    const next = { ...settings, [slot]: value };
    setSettings(next);
    api.setSettings(next).catch((e) => toastErr("set_settings", e));
  };

  /* ---------- 载入页面 ---------- */
  const idx = Math.max(0, Number(pageInput) - 1 || 0);

  const loadPage = async () => {
    if (!bookId) return;
    setBusy(true);
    setPageError(null);
    setStep2(null);
    setBoxes([]);
    setOcrTexts([]);
    setDeleted(new Set());
    setFull(null);
    setStep1Ms(null);
    setStoredHint(false);
    try {
      const img = await api.getPage(bookId, idx, 1200);
      setPage(img);
    } catch (e) {
      setPage(null);
      setPageError(typeof e === "string" ? e : "页面加载失败");
      toastErr("get_page", e);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 批量预翻译(整话) ---------- */
  const enqueueBatch = async () => {
    try {
      const j = await api.batchEnqueue(bookId);
      setJob(j);
      toast(`已入队:${j.bookTitle} 共 ${j.totalPages} 页`);
    } catch (e) {
      toastErr("batch_enqueue", e);
    }
  };
  const pauseBatch = () => api.batchPause(bookId).catch((e) => toastErr("batch_pause", e));
  const resumeBatch = () =>
    api.batchResume(bookId).catch((e) => toastErr("batch_resume", e));
  const cancelBatch = () => api.batchCancel(bookId).catch((e) => toastErr("batch_cancel", e));

  /* ---------- 步骤一:检测 + OCR(有存档则秒出) ---------- */
  const runStep1 = async (force = false) => {
    if (!settings || !bookId) return;
    setBusy(true);
    setStep2(null);
    setDeleted(new Set());
    setStoredHint(false);
    try {
      if (!force) {
        // 已预翻译过的页:直接用存档的框+文本,不调模型,秒出。
        const stored = await api.wbGetOcr(bookId, idx);
        if (stored) {
          setFull({ width: stored.width, height: stored.height });
          setBoxes(stored.boxes);
          setOcrTexts(stored.texts);
          setStep1Ms(0);
          setStoredHint(true);
          return;
        }
      }
      const det = await api.wbDetect(bookId, idx);
      setFull({ width: det.width, height: det.height });
      setBoxes(det.boxes);
      setStep1Ms(det.elapsedMs);
      if (det.boxes.length === 0) {
        setOcrTexts([]);
        toast("未检测到文本框");
        return;
      }
      // OCR:sidecar mit48px 按框整批;windows/http 槽位逐框换算相对坐标走 ocr_region。
      let texts: string[];
      if (settings.wbOcr === "mit48pxctc") {
        const r = await api.wbOcr(bookId, idx, det.boxes);
        texts = r.results.map((t) => t.text);
      } else {
        texts = await Promise.all(
          det.boxes.map((b) =>
            api
              .ocrRegion(bookId, idx, {
                x: b.x / det.width,
                y: b.y / det.height,
                w: b.w / det.width,
                h: b.h / det.height,
              })
              .then((r) => r.text)
              .catch((e) => {
                toastErr("ocr_region", e);
                return "";
              }),
          ),
        );
      }
      setOcrTexts(texts);
      // 存档:下次打开/批量队列直接复用,秒出。
      api
        .wbSaveOcr(bookId, idx, det.width, det.height, det.boxes, texts)
        .catch(() => {});
    } catch (e) {
      toastErr("wb_detect", e);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 步骤二:翻译 + 擦除 + 嵌字 ---------- */
  const keepIdx = boxes.map((_, i) => i).filter((i) => !deleted.has(i));

  const runStep2 = async () => {
    if (!settings || keepIdx.length === 0) return;
    setTranslating(true);
    try {
      const tr = await api.wbTranslate(
        bookId,
        idx,
        keepIdx.map((i) => ocrTexts[i] ?? ""),
      );
      let erased: { dataUrl: string } | null = null;
      if (settings.wbInpaint !== "none") {
        const er = await api.wbInpaint(
          bookId,
          idx,
          keepIdx.map((i) => boxes[i]),
        );
        erased = { dataUrl: er.dataUrl };
      }
      setStep2({
        translations: tr.items.map((it) => it.translated),
        keepIdx,
        erased,
        elapsedMs: tr.elapsedMs,
      });
      const hits = tr.items.filter((it) => it.cached).length;
      toast(
        hits > 0
          ? `完成:${hits} 条命中缓存,${tr.items.length - hits} 条新翻译`
          : `完成:${tr.items.length} 条翻译`,
      );
    } catch (e) {
      toastErr("wb_translate", e);
    } finally {
      setTranslating(false);
    }
  };

  /* ---------- 显示缩放(框用百分比定位,字号用实测宽度) ---------- */
  useEffect(() => {
    const on = () => {
      if (wrapRef.current) setDispW(wrapRef.current.clientWidth);
    };
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [page, step2]);

  const baseImg = step2?.erased?.dataUrl ?? page?.dataUrl ?? "";
  const fullW = full?.width ?? 1;
  const fullH = full?.height ?? 1;
  const scale = dispW > 0 ? dispW / fullW : 0;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  const book = books.find((b) => b.id === bookId);

  return (
    <div>
      {/* 四下拉框 + sidecar 健康 */}
      <div className="card section-card">
        <h3 className="section-title">
          <Languages size={15} /> 翻译工作台 <span className="badge">阶段三</span>
        </h3>
        <div className="form-grid two" style={{ marginTop: 8 }}>
          <label className="field">
            <span>文本检测器</span>
            <select
              className="input mono"
              value={settings?.wbDetector ?? "ctd"}
              onChange={(e) => setProvider("wbDetector", e.currentTarget.value)}
              disabled={!settings}
            >
              <option value="ctd">ctd(sidecar)</option>
            </select>
          </label>
          <label className="field">
            <span>OCR</span>
            <select
              className="input mono"
              value={settings?.wbOcr ?? "mit48pxctc"}
              onChange={(e) => setProvider("wbOcr", e.currentTarget.value)}
              disabled={!settings}
            >
              {OCR_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>图像擦除</span>
            <select
              className="input mono"
              value={settings?.wbInpaint ?? "lama_large_512px"}
              onChange={(e) => setProvider("wbInpaint", e.currentTarget.value)}
              disabled={!settings}
            >
              {INPAINT_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>翻译</span>
            <select className="input mono" value="index-translate" disabled>
              <option value="index-translate">OpenAI 兼容(Index-Translate)</option>
            </select>
          </label>
        </div>
        {health && (
          <p className="hint mono" style={{ marginTop: 8, color: health.ok ? undefined : "#dc2626" }}>
            {health.text}
            <button className="btn" style={{ marginLeft: 8 }} onClick={refreshHealth}>
              <RefreshCw size={12} /> 刷新
            </button>
          </p>
        )}
      </div>

      {/* 选书 + 载入 */}
      <div className="card section-card">
        <h3 className="section-title">页面</h3>
        {books.length === 0 ? (
          <div className="reader-err" style={{ color: "inherit" }}>
            <PixelPet mode="empty" message="书库还是空的" />
            <button className="btn" onClick={() => nav("/")}>
              <ArrowLeft size={14} style={{ verticalAlign: -2 }} /> 去书库扫描
            </button>
          </div>
        ) : (
          <div className="field-row">
            <select
              className="input"
              value={bookId}
              onChange={(e) => setBookId(e.currentTarget.value)}
              aria-label="选择书籍"
              style={{ maxWidth: 340 }}
            >
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
            <input
              className="input mono"
              type="number"
              min={1}
              max={book?.pageCount ?? undefined}
              value={pageInput}
              onChange={(e) => setPageInput(e.currentTarget.value)}
              aria-label="页码"
              style={{ width: 90 }}
            />
            <button className="btn primary" onClick={loadPage} disabled={busy || !bookId}>
              载入页面
            </button>
            {book && (
              <span className="hint mono">
                共 {book.pageCount} 页(内部 0 起算:当前 {idx})
              </span>
            )}
          </div>
        )}
        {pageError && (
          <ErrorState
            message={`页面加载失败：${pageError}`}
            onRetry={() => void loadPage()}
          />
        )}
      </div>

      {/* 步骤一 */}
      {page && (
        <div className="card section-card">
          <h3 className="section-title">
            <ScanText size={15} /> ① 检测 + OCR
            {step1Ms != null && (
              <span className="hint mono">{storedHint ? "缓存秒出" : `${step1Ms} ms`}</span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {storedHint && (
                <button className="btn" onClick={() => runStep1(true)} disabled={busy || !bookId}>
                  <RefreshCw size={13} /> 重新检测
                </button>
              )}
              <button
                className="btn primary"
                onClick={() => runStep1(false)}
                disabled={busy || !bookId}
              >
                {busy ? "检测中…" : storedHint ? "已秒出" : boxes.length > 0 ? "重新检测" : "开始检测"}
              </button>
            </span>
          </h3>
          <p className="hint">
            点击文本框可标记删除(拟声词/装饰字/艺术字);被删除的框不做翻译,也不做擦除。
          </p>
          {full && (
            <div ref={wrapRef} style={{ position: "relative", marginTop: 10 }}>
              <img
                src={baseImg}
                alt="当前页"
                style={{ width: "100%", display: "block", borderRadius: 6 }}
                draggable={false}
              />
              {!step2 &&
                boxes.map((b, i) => {
                  const del = deleted.has(i);
                  return (
                    <div
                      key={i}
                      onClick={() =>
                        setDeleted((s) => {
                          const n = new Set(s);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        })
                      }
                      style={{
                        position: "absolute",
                        left: pct(b.x, fullW),
                        top: pct(b.y, fullH),
                        width: pct(b.w, fullW),
                        height: pct(b.h, fullH),
                        border: del ? "2px dashed #9ca3af" : "2px solid #0ea5e9",
                        background: del ? "rgba(156,163,175,0.08)" : "rgba(14,165,233,0.10)",
                        borderRadius: 3,
                        cursor: "pointer",
                        opacity: del ? 0.55 : 1,
                        overflow: "hidden",
                      }}
                      title={del ? "点击恢复" : "点击删除该框"}
                    >
                      {ocrTexts[i] && (
                        <span
                          className="mono"
                          style={{
                            position: "absolute",
                            left: 0,
                            top: 0,
                            fontSize: 10,
                            lineHeight: 1.3,
                            background: del ? "#9ca3af" : "#0ea5e9",
                            color: "#fff",
                            padding: "1px 4px",
                            borderRadius: "0 0 4px 0",
                            maxWidth: "100%",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            textDecoration: del ? "line-through" : "none",
                          }}
                        >
                          {ocrTexts[i]}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          {boxes.length > 0 && !step2 && (
            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              {boxes.map((b, i) => (
                <div key={i} className="field-row" style={{ alignItems: "center" }}>
                  <span className="mono hint" style={{ width: 90, flex: "none" }}>
                    框 {i + 1}
                    {b.vertical ? " · 竖" : ""}
                  </span>
                  <span
                    className="mono"
                    style={{
                      flex: 1,
                      textDecoration: deleted.has(i) ? "line-through" : "none",
                      color: deleted.has(i) ? "#9ca3af" : undefined,
                    }}
                  >
                    {ocrTexts[i] || "(空)"}
                  </span>
                  <button
                    className="btn"
                    onClick={() =>
                      setDeleted((s) => {
                        const n = new Set(s);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                    title={deleted.has(i) ? "恢复" : "删除"}
                  >
                    {deleted.has(i) ? <RefreshCw size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 步骤二 */}
      {page && boxes.length > 0 && (
        <div className="card section-card">
          <h3 className="section-title">
            <Eraser size={15} /> ② 翻译 + 擦除 + 嵌字
            {step2 && <span className="hint mono">{step2.elapsedMs} ms</span>}
            <button
              className="btn primary"
              style={{ marginLeft: "auto" }}
              onClick={runStep2}
              disabled={translating || busy || keepIdx.length === 0}
            >
              <Languages size={14} /> {translating ? "处理中…" : `执行(保留 ${keepIdx.length} 框)`}
            </button>
          </h3>
          {step2 ? (
            <>
              <div style={{ position: "relative", marginTop: 10 }}>
                <img
                  src={step2.erased?.dataUrl ?? page.dataUrl}
                  alt="翻译结果"
                  style={{ width: "100%", display: "block", borderRadius: 6 }}
                  draggable={false}
                />
                {full &&
                  step2.keepIdx.map((i) => {
                    const b = boxes[i];
                    const t = step2.translations[step2.keepIdx.indexOf(i)];
                    if (!t) return null;
                    return (
                      <div
                        key={i}
                        style={{
                          position: "absolute",
                          left: pct(b.x, fullW),
                          top: pct(b.y, fullH),
                          width: pct(b.w, fullW),
                          height: pct(b.h, fullH),
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          padding: 2,
                        }}
                      >
                        <span
                          style={{
                            fontSize: Math.max(10, Math.min(44, b.h * scale * 0.5)),
                            lineHeight: 1.25,
                            color: "#fff",
                            fontWeight: 600,
                            textAlign: "center",
                            textShadow:
                              "0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000, -1px -1px 2px #000",
                            wordBreak: "break-word",
                          }}
                        >
                          {t}
                        </span>
                      </div>
                    );
                  })}
              </div>
              <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
                {step2.keepIdx.map((i, k) => (
                  <div key={i} className="field-row" style={{ alignItems: "baseline" }}>
                    <span className="mono hint" style={{ width: 90, flex: "none" }}>
                      框 {i + 1}
                    </span>
                    <span className="mono hint" style={{ flex: 1 }}>
                      {ocrTexts[i]}
                    </span>
                    <span className="mono" style={{ flex: 1, color: "#0ea5e9" }}>
                      {step2.translations[k]}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="hint">
              确认步骤一的框选后执行;翻译命中缓存秒出,擦除走 sidecar lama(CPU 可能较慢)。
            </p>
          )}
        </div>
      )}

      {/* 批量预翻译(整话) */}
      {bookId && (
        <div className="card section-card">
          <h3 className="section-title">
            批量预翻译(整话)
            {job && <span className="badge mono">{job.state}</span>}
          </h3>
          {job && ["queued", "running", "paused"].includes(job.state) ? (
            <>
              <p className="hint mono">
                {job.bookTitle}:{job.donePages} / {job.totalPages} 页 · 成功 {job.okPages} ·
                失败 {job.failPages}
              </p>
              <div className="progress-track" style={{ marginTop: 8 }}>
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      job.totalPages > 0
                        ? Math.round((job.donePages / job.totalPages) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              {job.lastError && (
                <p className="hint mono" style={{ color: "#dc2626" }}>
                  最近错误:{job.lastError}
                </p>
              )}
              <div className="field-row" style={{ marginTop: 10 }}>
                {job.state === "paused" ? (
                  <button className="btn primary" onClick={resumeBatch}>
                    <RefreshCw size={13} /> 继续
                  </button>
                ) : (
                  <button className="btn" onClick={pauseBatch} disabled={job.state !== "running"}>
                    暂停
                  </button>
                )}
                <button className="btn" onClick={cancelBatch}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="hint">
                后台逐页跑 检测→OCR→翻译(缓存+术语表生效);翻过的页在工作台打开即秒出。
              </p>
              <div className="field-row">
                <button className="btn primary" onClick={enqueueBatch}>
                  整话预翻译
                </button>
              </div>
              {job && ["failed", "done_errors"].includes(job.state) && (
                <p className="hint mono" style={{ color: "#dc2626" }}>
                  {job.state === "failed" ? "任务失败" : "完成(有失败页)"}:失败 {job.failPages} 页
                  {job.lastError ? ` · ${job.lastError}` : ""}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* 术语表 */}
      {bookId && (
        <div className="card section-card">
          <h3 className="section-title">术语表(按系列)</h3>
          <p className="hint">人名/招式名等固定译法;翻译时自动注入提示词。</p>
          <div className="field-row" style={{ marginTop: 8 }}>
            <input
              className="input mono"
              placeholder="原文(如 ナルト)"
              value={glSrc}
              onChange={(e) => setGlSrc(e.currentTarget.value)}
              style={{ maxWidth: 200 }}
            />
            <input
              className="input mono"
              placeholder="译文(如 鸣人)"
              value={glDst}
              onChange={(e) => setGlDst(e.currentTarget.value)}
              style={{ maxWidth: 200 }}
            />
            <button className="btn primary" onClick={addGlossary}>
              <Plus size={14} /> 添加
            </button>
          </div>
          {glossary.length > 0 && (
            <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
              {glossary.map(([s, d]) => (
                <div key={s} className="field-row" style={{ alignItems: "center" }}>
                  <span className="mono" style={{ flex: 1 }}>
                    {s} = {d}
                  </span>
                  <button className="btn" onClick={() => removeGlossary(s)} title="删除">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Toaster />
    </div>
  );
}
