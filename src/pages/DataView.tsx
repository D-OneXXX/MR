import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Flame, RefreshCw, Trophy } from "lucide-react";
import { api, type BookDayPoint, type BookInfo, type Dashboard } from "../lib/tauri";
import Heatmap from "../components/Heatmap";
import ErrorState from "../components/ErrorState";
import PixelPet from "../components/PixelPet";
import RankTop from "../components/RankTop";
import StatCard from "../components/StatCard";
import TrendChart from "../components/TrendChart";
import { toastErr, Toaster } from "../components/Toast";

/**
 * 「数据」视图（/data）— 流体 v2：完整看板独立成页，不挤书库主页。
 * 四格统计 → Top3（读得最多，点击可去书库继续读）→ 阅读热力图 → 阅读趋势堆叠图。
 */
export default function DataView() {
  const nav = useNavigate();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [trend, setTrend] = useState<BookDayPoint[]>([]);
  const [trendErr, setTrendErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    api
      .getDashboard()
      .then((d) => alive && setDash(d))
      .catch((e) => {
        if (alive) setLoadError(typeof e === "string" ? e : "加载失败");
        toastErr("get_dashboard", e);
      });
    api
      .listBooks()
      .then((list) => alive && setBooks(list))
      .catch((e) => toastErr("list_books", e));
    api
      .getReadingByBook(14)
      .then((rows) => {
        if (!alive) return;
        setTrend(rows);
        setTrendErr(null);
      })
      .catch((e) => {
        if (!alive) return;
        setTrendErr("阅读趋势加载失败");
        toastErr("get_reading_by_book", e);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    load();
  }, [load, tick]);

  const titles = useMemo(() => new Map(books.map((b) => [b.id, b.title])), [books]);

  const weekPages = useMemo(() => {
    const days = dash?.heatmap ?? [];
    return days.slice(-7).reduce((s, d) => s + d.count, 0);
  }, [dash]);

  if (!loading && books.length === 0 && !loadError) {
    return (
      <div>
        <PixelPet mode="empty" message="还没有任何数据——先去书库扫描入库、读几页吧。" />
        <Toaster />
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <ErrorState message={`数据加载失败：${loadError}`} onRetry={() => setTick((v) => v + 1)} />
        <Toaster />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>数据</h2>
        <button
          className="btn"
          style={{ marginLeft: "auto" }}
          onClick={() => setTick((v) => v + 1)}
          title="刷新"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {loading && !dash ? (
        <PixelPet mode="loading" />
      ) : (
        <>
          <div className="stats-row">
            <StatCard icon={Flame} label="藏书总数" value={String(dash?.totalBooks ?? 0)} sub="本地优先" />
            <StatCard label="在读书籍" icon={BarChart3} value={String(dash?.reading ?? 0)} />
            <StatCard icon={Flame} label="今日页数" value={String(dash?.todayPages ?? 0)} sub="页 / 天" />
            <StatCard icon={Trophy} label="本周页数" value={String(weekPages)} sub="页 / 近7天" />
          </div>

          <div className="data-grid">
            <div className="card section-card" style={{ margin: 0 }}>
              <h3 className="section-title">
                <Trophy size={15} /> Top3 · 读得最多
              </h3>
              <RankTop
                books={books}
                onSelect={(id) => nav(`/reader/${encodeURIComponent(id)}`)}
              />
            </div>

            <div className="card section-card" style={{ margin: 0 }}>
              <h3 className="section-title">
                <Flame size={15} /> 阅读热力图
              </h3>
              <Heatmap data={dash?.heatmap ?? []} />
            </div>

            <div className="card section-card span-2" style={{ margin: 0 }}>
              <h3 className="section-title">
                <BarChart3 size={15} /> 阅读趋势 · 近14天
              </h3>
              <TrendChart data={trend} titles={titles} error={trendErr} />
            </div>
          </div>
        </>
      )}
      <Toaster />
    </div>
  );
}
