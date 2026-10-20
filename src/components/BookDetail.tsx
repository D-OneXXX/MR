import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, CalendarRange, Check, RefreshCw } from "lucide-react";
import { api, type BookInfo, type HeatDay } from "../lib/tauri";
import { toastErr } from "./Toast";

type RangeKey = "day" | "week" | "month" | "all" | "custom";

const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: "day", label: "今天" },
  { key: "week", label: "近7天" },
  { key: "month", label: "近30天" },
  { key: "all", label: "全部" },
  { key: "custom", label: "自定义" },
];

const RANGE_DAYS: Record<Exclude<RangeKey, "custom">, number> = {
  day: 1,
  week: 7,
  month: 30,
  all: 365,
};

function todayStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 详情纵深内容（流体 v2：渲染在 DetailSheet 面板内，自身不带卡片壳）：
 * 胶囊时间 Tab + 刷新 → 超大数字（已读页）→ 单色渐变总量进度条
 * → 区间阅读分布卡片行 → 每日阅读明细表 → 继续阅读。
 * 时间 Tab 只过滤区间数据；大数字/进度条是书籍事实，不随 Tab 变化。
 */
export default function BookDetail({ book }: { book: BookInfo }) {
  const nav = useNavigate();
  const [range, setRange] = useState<RangeKey>("month");
  const [from, setFrom] = useState(todayStr(-29));
  const [to, setTo] = useState(todayStr());
  const [log, setLog] = useState<HeatDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [seriesBooks, setSeriesBooks] = useState<BookInfo[] | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [seriesTick, setSeriesTick] = useState(0);

  const days = range === "custom" ? 365 : RANGE_DAYS[range];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getReadingLog(book.id, days)
      .then(
        (rows) => {
          if (alive) setLog(rows);
        },
        (e) => {
          if (!alive) return;
          setLog([]);
          setError(String(e));
          toastErr("get_reading_log", e);
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [book, days, tick]);

  useEffect(() => {
    if (!book.seriesId) {
      setSeriesBooks(null);
      setSeriesError(null);
      setSeriesLoading(false);
      return;
    }
    let alive = true;
    setSeriesBooks(null);
    setSeriesLoading(true);
    setSeriesError(null);
    api.getSeriesBooks(book.seriesId).then(
      (list) => {
        if (!alive) return;
        setSeriesBooks(
          [...list].sort(
            (a, b) =>
              (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0) ||
              a.title.localeCompare(b.title, "zh"),
          ),
        );
        setSeriesLoading(false);
      },
      (e) => {
        if (!alive) return;
        setSeriesBooks([]);
        setSeriesError(String(e));
        setSeriesLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [book.seriesId, book.id, seriesTick]);

  // 自定义区间在客户端过滤；预设区间直接用后端窗口。
  const ranged = useMemo<HeatDay[]>(() => {
    const rows = log ?? [];
    if (range !== "custom") return rows;
    return rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  }, [log, range, from, to]);

  const inRange = useMemo(() => {
    const total = ranged.reduce((s, r) => s + r.count, 0);
    const activeDays = ranged.filter((r) => r.count > 0).length;
    const top = [...ranged]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
    return { total, activeDays, top };
  }, [ranged]);

  const read = Math.min(book.currentPage + 1, book.pageCount);
  const remain = Math.max(0, book.pageCount - read);
  const pct =
    book.pageCount > 0 ? Math.min(100, Math.round((read / book.pageCount) * 100)) : 0;
  const rangeLabel =
    range === "custom" ? `${from || "…"} ~ ${to || "…"}` : RANGE_TABS.find((t) => t.key === range)?.label ?? "";
  const currentSeriesIndex =
    seriesBooks?.findIndex((item) => item.id === book.id) ?? -1;
  const chapterNo =
    (currentSeriesIndex >= 0 ? seriesBooks?.[currentSeriesIndex]?.chapterIndex : null) ??
    book.chapterIndex ??
    (currentSeriesIndex >= 0 ? currentSeriesIndex + 1 : null);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div className="pill-tabs" role="tablist" aria-label="统计区间">
          {RANGE_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={range === t.key}
              className={`pill-tab${range === t.key ? " on" : ""}`}
              onClick={() => setRange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          className="btn"
          style={{ marginLeft: "auto" }}
          title="刷新阅读记录"
          onClick={() => setTick((v) => v + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {range === "custom" && (
        <div className="field-row" style={{ marginTop: 10 }}>
          <input
            className="input mono"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.currentTarget.value)}
            aria-label="开始日期"
          />
          <input
            className="input mono"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.currentTarget.value)}
            aria-label="结束日期"
          />
        </div>
      )}

      {/* 中央超大数字：主角 = 已读页，说明行 = 总页数/剩余 */}
      <div style={{ marginTop: 18 }}>
        <div className="hero-row">
          <span className="hero-num">{read}</span>
          <span className="hero-unit">页</span>
        </div>
        <div className="hero-sub">
          共 {book.pageCount} 页 · 剩余 {remain} 页 · {rangeLabel}读 {inRange.total} 页
          {inRange.activeDays > 0 ? ` · ${inRange.activeDays} 天有记录` : ""}
        </div>
        <div className="progress-track big">
          <div className="progress-fill grad" style={{ width: `${pct}%` }} />
        </div>
        <div className="hero-sub" style={{ textAlign: "right" }}>
          <span className="mono">{pct}%</span>
        </div>
      </div>

      {book.seriesId && (
        <>
          <h4 style={{ margin: "18px 0 8px", fontSize: 13 }}>
            章节选集（共{" "}
            <span className="mono">{seriesBooks ? seriesBooks.length : "…"}</span> 话）
          </h4>
          {seriesLoading ? (
            <p className="hint">正在加载章节列表…</p>
          ) : seriesError ? (
            <div className="field-row" style={{ alignItems: "center" }}>
              <p className="hint" style={{ flex: 1, margin: 0, color: "var(--accent)" }}>
                章节列表加载失败：{seriesError}
              </p>
              <button className="btn" onClick={() => setSeriesTick((v) => v + 1)}>
                重试
              </button>
            </div>
          ) : !seriesBooks || seriesBooks.length === 0 ? (
            <p className="hint">暂无章节数据。</p>
          ) : (
            <div className="episode-grid">
              {seriesBooks.map((chapter, index) => {
                const no = chapter.chapterIndex ?? index + 1;
                const done =
                  chapter.pageCount > 0 &&
                  chapter.currentPage >= chapter.pageCount - 1;
                const active = chapter.id === book.id;
                return (
                  <button
                    key={chapter.id}
                    type="button"
                    className={`episode-pill${active ? " active" : ""}${done ? " done" : ""}`}
                    onClick={() => nav(`/reader/${encodeURIComponent(chapter.id)}`)}
                    title={chapter.title}
                  >
                    <span className="episode-title">
                      <span className="mono">{String(no).padStart(2, "0")}</span> ·{" "}
                      {chapter.title}
                    </span>
                    <span className="episode-meta">
                      <span className="mono">{chapter.pageCount} 页</span>
                      {done && <Check size={12} aria-label="已读完" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      <h4 style={{ margin: "18px 0 8px", fontSize: 13 }}>
        <CalendarRange size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
        区间阅读分布
      </h4>
      {loading ? (
        <p className="hint">正在加载阅读记录…</p>
      ) : inRange.top.length === 0 ? (
        <p className="hint">这个区间还没有这本书的阅读记录。</p>
      ) : (
        <div className="decomp-row">
          {inRange.top.map((d) => (
            <div className="decomp-card" key={d.date}>
              <span className="decomp-head">
                <CalendarRange size={11} />
                <span className="mono">{d.date.slice(5)}</span>
              </span>
              <span className="decomp-val mono">{d.count}</span>
              <span className="decomp-sub">
                {inRange.total > 0 ? Math.round((d.count / inRange.total) * 100) : 0}% · {d.count} 页
              </span>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ margin: "18px 0 8px", fontSize: 13 }}>每日明细</h4>
      {loading ? (
        <p className="hint">加载中…</p>
      ) : ranged.length === 0 ? (
        <p className="hint">暂无数据。</p>
      ) : (
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>日期</th>
                <th className="num">页数</th>
                <th className="num">占比</th>
              </tr>
            </thead>
            <tbody>
              {[...ranged].reverse().map((d) => (
                <tr key={d.date}>
                  <td className="mono">{d.date}</td>
                  <td className="num mono">{d.count}</td>
                  <td className="num mono">
                    {inRange.total > 0 ? Math.round((d.count / inRange.total) * 100) : 0}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <p className="hint" style={{ color: "var(--accent)" }}>
          阅读记录加载失败，可点击刷新重试。
        </p>
      )}

      <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          onClick={() => nav(`/reader/${encodeURIComponent(book.id)}`)}
        >
          <BookOpen size={14} /> {book.currentPage > 0 ? "继续阅读" : "开始阅读"}
          {book.seriesId && chapterNo != null && (
            <>
              {" "}第 <span className="mono">{chapterNo}</span> 话
            </>
          )}
        </button>
      </div>
    </div>
  );
}
