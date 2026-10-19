import type { SeriesProgress } from "../lib/tauri";

/** 看板数据表格：各书进度明细（CSS 表格 + Geist Mono 数字） */
export default function SeriesTable({ series }: { series: SeriesProgress[] }) {
  if (series.length === 0) {
    return <p className="hint">暂无数据。</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>书名</th>
            <th className="num">当前页</th>
            <th className="num">总页数</th>
            <th className="num">进度</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const pct =
              s.pageCount > 0
                ? Math.min(100, Math.round((s.currentPage / s.pageCount) * 100))
                : 0;
            return (
              <tr key={s.bookId}>
                <td>{s.title || s.bookId}</td>
                <td className="num mono">{s.currentPage}</td>
                <td className="num mono">{s.pageCount}</td>
                <td className="num mono">{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
