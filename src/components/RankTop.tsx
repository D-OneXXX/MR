import type { BookInfo } from "../lib/tauri";

interface Props {
  books: BookInfo[];
  onSelect: (bookId: string) => void;
}

/** 系列 Top3（按累计阅读页数）：序号圆徽章 + 名称 + 右对齐加粗百分比。 */
export default function RankTop({ books, onSelect }: Props) {
  const ranked = books
    .map((b) => ({ book: b, read: Math.min(b.currentPage + 1, b.pageCount) }))
    .filter((r) => r.read > 0)
    .sort((a, b) => b.read - a.read)
    .slice(0, 3);

  if (ranked.length === 0) {
    return <p className="hint">开始阅读后，这里会出现你读得最多的书。</p>;
  }
  const total = ranked.reduce((s, r) => s + r.read, 0) || 1;

  return (
    <div className="rank-list">
      {ranked.map((r, i) => {
        const pct = Math.round((r.read / total) * 100);
        return (
          <button
            key={r.book.id}
            className="rank-item"
            onClick={() => onSelect(r.book.id)}
            title={`在右侧查看《${r.book.title}》的阅读纵深`}
          >
            <span className="rank-badge mono">{i + 1}</span>
            <span className="rank-name">
              {r.book.title}
              <span className="rank-sub">
                {" "}
                · 已读 {r.read} / {r.book.pageCount} 页
              </span>
            </span>
            <span className="rank-pct mono">{pct}%</span>
          </button>
        );
      })}
    </div>
  );
}
