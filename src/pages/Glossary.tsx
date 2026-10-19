import { useCallback, useEffect, useState } from "react";
import { BookMarked, Plus, Trash2 } from "lucide-react";
import { api, type BookInfo } from "../lib/tauri";
import ConfirmDialog from "../components/ConfirmDialog";
import PixelPet from "../components/PixelPet";
import { toast, toastErr, Toaster } from "../components/Toast";

/**
 * 术语表（/glossary，工具页）：按书维护人名/招式名等译名映射。
 * series_id = 书籍 id（与翻译工作台的取词口径一致，见 workbench.rs）。
 * 重复原文提交即覆盖（glossary_upsert 语义）。
 */
export default function GlossaryPage() {
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [seriesId, setSeriesId] = useState("");
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [src, setSrc] = useState("");
  const [dst, setDst] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listBooks()
      .then((list) => {
        if (!alive) return;
        setBooks(list);
        setSeriesId((cur) => cur || list[0]?.id || "");
      })
      .catch((e) => toastErr("list_books", e));
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(() => {
    if (!seriesId) {
      setRows([]);
      return;
    }
    api
      .glossaryList(seriesId)
      .then(setRows)
      .catch((e) => toastErr("glossary_list", e));
  }, [seriesId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = async () => {
    if (!src.trim() || !dst.trim()) {
      toast("原文和译文都不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.glossarySet(seriesId, src.trim(), dst.trim());
      setSrc("");
      setDst("");
      reload();
      toast("术语已保存");
    } catch (e) {
      toastErr("glossary_set", e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: string) => {
    try {
      await api.glossaryRemove(seriesId, s);
      reload();
      toast("已删除");
    } catch (e) {
      toastErr("glossary_remove", e);
    } finally {
      setConfirmDel(null);
    }
  };

  const book = books.find((b) => b.id === seriesId);

  return (
    <div>
      <div className="card section-card">
        <h3 className="section-title">
          <BookMarked size={15} /> 术语表
          <span className="badge mono">{rows?.length ?? 0}</span>
        </h3>
        <p className="hint">
          翻译工作台按“书 = 系列”取词：给同一本书维护人名/招式名的固定译名，
          翻译时会注入 prompt。重复提交同一原文会覆盖旧译文。
        </p>

        {books.length === 0 ? (
          <PixelPet mode="empty" message="书架还是空的，先去书库扫描入库，才能按书维护术语。" />
        ) : (
          <>
            <div className="field" style={{ marginTop: 10 }}>
              <span>选择系列（书）</span>
              <select
                className="input"
                value={seriesId}
                onChange={(e) => setSeriesId(e.currentTarget.value)}
                aria-label="选择系列"
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-row" style={{ marginTop: 12 }}>
              <input
                className="input"
                placeholder="原文（如：ナルト）"
                value={src}
                onChange={(e) => setSrc(e.currentTarget.value)}
                aria-label="原文"
              />
              <input
                className="input"
                placeholder="译文（如：鸣人）"
                value={dst}
                onChange={(e) => setDst(e.currentTarget.value)}
                aria-label="译文"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
              <button className="btn primary" onClick={() => void add()} disabled={busy || !book}>
                <Plus size={14} /> 添加
              </button>
            </div>

            <div style={{ marginTop: 14 }}>
              {rows === null ? (
                <PixelPet mode="loading" message="正在加载术语" />
              ) : rows.length === 0 ? (
                <PixelPet mode="empty" message="这本书还没有术语，添加第一条吧。" />
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>原文</th>
                        <th>译文</th>
                        <th className="num">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(([s, d]) => (
                        <tr key={s}>
                          <td>{s}</td>
                          <td>{d}</td>
                          <td className="num">
                            <button
                              className="btn"
                              title="删除"
                              onClick={() => setConfirmDel(s)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {confirmDel !== null && (
        <ConfirmDialog
          title="删除这条术语？"
          message={`「${confirmDel}」将从该系列的术语表中移除，翻译时不再注入。`}
          confirmText="删除"
          onConfirm={() => void remove(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
      <Toaster />
    </div>
  );
}
