import { useMemo } from "react";
import type { BookDayPoint } from "../lib/tauri";

const DAYS = 14;
const DAY_MS = 86_400_000;
/** 规范：橙/粉/紫只允许出现在趋势堆叠图里；其余书并入灰色"其他"。 */
const COLORS = ["var(--trend-1)", "var(--trend-2)", "var(--trend-3)", "var(--trend-other)"];

interface Seg {
  color: string;
  pages: number;
  label: string;
}

interface Col {
  date: string;
  label: string;
  segs: Seg[];
  sum: number;
}

interface Props {
  data: BookDayPoint[];
  titles: Map<string, string>;
  error?: string | null;
}

function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 近 14 天阅读趋势：按书堆叠的手写 CSS 柱状图（Top3 书 + 其他），首次渲染生长动画。 */
export default function TrendChart({ data, titles, error }: Props) {
  const { cols, legend, max } = useMemo(() => {
    const byDay = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    for (const p of data) {
      let m = byDay.get(p.date);
      if (!m) {
        m = new Map();
        byDay.set(p.date, m);
      }
      m.set(p.bookId, (m.get(p.bookId) ?? 0) + p.pages);
      totals.set(p.bookId, (totals.get(p.bookId) ?? 0) + p.pages);
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map((e) => e[0]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cols: Col[] = [];
    let max = 0;
    for (let i = DAYS - 1; i >= 0; i -= 1) {
      const dt = new Date(today.getTime() - i * DAY_MS);
      const k = dayKey(dt);
      const m = byDay.get(k);
      const segs: Seg[] = [];
      let sum = 0;
      top.forEach((id, idx) => {
        const v = m?.get(id) ?? 0;
        if (v > 0) {
          segs.push({ color: COLORS[idx], pages: v, label: titles.get(id) ?? "未知书籍" });
          sum += v;
        }
      });
      let other = 0;
      for (const [id, v] of m ?? []) {
        if (!top.includes(id)) other += v;
      }
      if (other > 0) {
        segs.push({ color: COLORS[3], pages: other, label: "其他" });
        sum += other;
      }
      max = Math.max(max, sum);
      cols.push({
        date: k,
        label: k.slice(5).replace("-", "/"),
        segs,
        sum,
      });
    }
    const legend = top.map((id, i) => ({
      color: COLORS[i],
      label: titles.get(id) ?? "未知书籍",
    }));
    if (totals.size > top.length) {
      legend.push({ color: COLORS[3], label: "其他" });
    }
    return { cols, legend, max: Math.max(max, 1) };
  }, [data, titles]);

  if (error) {
    return <p className="hint">{error}</p>;
  }
  if (data.length === 0) {
    return <p className="hint">最近 14 天还没有阅读记录，开始读一本书就会点亮这里。</p>;
  }

  return (
    <div>
      <div className="trend" role="img" aria-label="近 14 天阅读趋势堆叠图">
        {cols.map((c, ci) => (
          <div className="trend-col" key={c.date}>
            {c.sum === 0 ? (
              <i style={{ display: "block", height: 3, borderRadius: 2, background: "var(--heat-0)" }} />
            ) : (
              c.segs.map((s, si) => (
                <i
                  key={si}
                  className="trend-seg"
                  title={`${c.date} · ${s.label} ${s.pages} 页`}
                  style={{
                    height: `${Math.max(2, (s.pages / max) * 100)}%`,
                    background: s.color,
                    animationDelay: `${ci * 18}ms`,
                  }}
                />
              ))
            )}
            <span className="trend-date mono">{c.label}</span>
          </div>
        ))}
      </div>
      <div className="trend-legend">
        {legend.map((l, i) => (
          <span key={i}>
            <i style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
