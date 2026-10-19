import { useMemo } from "react";
import type { HeatDay } from "../lib/tauri";

/** GitHub 风阅读热力图：最近 26 周，按周分列（手写 CSS，不引入图表库） */
const WEEKS = 26;
const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

interface Cell {
  date: string;
  count: number;
}

export default function Heatmap({ data }: { data: HeatDay[] }) {
  const weeks = useMemo<Cell[][]>(() => {
    const map = new Map(data.map((d) => [d.date, d.count]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY_MS);
    start.setDate(start.getDate() - start.getDay()); // 回到周日对齐
    const cols: Cell[][] = [];
    for (let w = 0; w < WEEKS; w += 1) {
      const col: Cell[] = [];
      for (let d = 0; d < 7; d += 1) {
        const dt = new Date(start.getTime() + (w * 7 + d) * DAY_MS);
        const k = dayKey(dt);
        col.push({ date: k, count: map.get(k) ?? 0 });
      }
      cols.push(col);
    }
    return cols;
  }, [data]);

  const max = useMemo(
    () => data.reduce((m, d) => Math.max(m, d.count), 0),
    [data],
  );

  const level = (c: number): number => {
    if (c <= 0) return 0;
    if (max <= 0) return 1;
    if (c >= max * 0.75) return 4;
    if (c >= max * 0.5) return 3;
    if (c >= max * 0.25) return 2;
    return 1;
  };

  return (
    <div>
      <div className="heat-weeks" role="img" aria-label="阅读热力图">
        {weeks.map((col, wi) => (
          <div className="heat-col" key={`w${wi}`}>
            {col.map((cell) => (
              <i
                key={cell.date}
                title={`${cell.date} · ${cell.count} 页`}
                style={{ background: `var(--heat-${level(cell.count)})` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="heat-legend mono">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} style={{ background: `var(--heat-${l})` }} />
        ))}
        <span>多</span>
        <span style={{ marginLeft: 6 }}>· 本地时区</span>
      </div>
    </div>
  );
}
