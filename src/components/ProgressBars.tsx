import type { SeriesProgress } from "../lib/tauri";

interface BarDatum {
  label: string;
  value: number;
}

/** 手写 SVG 柱状图：各书阅读进度（不引入重型图表库） */
export default function ProgressBars({ series }: { series: SeriesProgress[] }) {
  const data: BarDatum[] = series.slice(0, 8).map((s) => ({
    label:
      s.title.length > 10 ? `${s.title.slice(0, 10)}…` : s.title || s.bookId,
    value:
      s.pageCount > 0
        ? Math.min(100, Math.round((s.currentPage / s.pageCount) * 100))
        : 0,
  }));

  if (data.length === 0) {
    return <p className="hint">暂无在读书籍，进度条会在开始阅读后出现。</p>;
  }

  const W = 520;
  const ROW_H = 34;
  const H = data.length * ROW_H + 8;
  const maxLabel = 120;
  const barW = W - maxLabel - 56;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="各书阅读进度柱状图"
    >
      {data.map((d, i) => {
        const y = 8 + i * ROW_H;
        const w = Math.max(2, Math.round((d.value / 100) * barW));
        return (
          <g key={d.label + i}>
            <text
              x={0}
              y={y + 13}
              fontSize={11}
              fill="var(--muted)"
              width={maxLabel}
            >
              {d.label}
            </text>
            <rect
              x={maxLabel}
              y={y}
              width={barW}
              height={14}
              rx={7}
              fill="var(--heat-0)"
            />
            <rect
              x={maxLabel}
              y={y}
              width={w}
              height={14}
              rx={7}
              fill="var(--accent)"
              style={{ transition: "width 150ms ease" }}
            >
              <title>{`${d.label} ${d.value}%`}</title>
            </rect>
            <text
              x={maxLabel + barW + 8}
              y={y + 12}
              fontSize={11}
              fill="var(--muted)"
              fontFamily="var(--mono)"
            >
              {d.value}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}
