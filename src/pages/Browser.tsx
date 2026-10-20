import { useCallback, useEffect, useState } from "react";
import {
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type BrowserDownload, type BrowserDownloadEvent } from "../lib/tauri";
import ErrorState from "../components/ErrorState";
import PixelPet from "../components/PixelPet";
import { toast, toastErr, Toaster } from "../components/Toast";

const RECENTS_KEY = "mr-browser-recents";
const RECENTS_LIMIT = 20;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

function writeRecents(urls: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(urls));
  } catch {
    /* 忽略 */
  }
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** 浏览器页（/browser）：独立浏览器窗口的启动器与下载导入管理器。 */
export default function BrowserPage() {
  const [url, setUrl] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [importingPath, setImportingPath] = useState<string | null>(null);

  const loadDownloads = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDownloads(await api.listBrowserDownloads());
    } catch (e) {
      setLoadError(typeof e === "string" ? e : "下载列表加载失败");
      toastErr("list_browser_downloads", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDownloads();
  }, [loadDownloads]);

  useEffect(() => {
    writeRecents(recents);
  }, [recents]);

  const remember = useCallback((target: string) => {
    setRecents((prev) =>
      [target, ...prev.filter((item) => item !== target)].slice(0, RECENTS_LIMIT),
    );
  }, []);

  const openInApp = useCallback(
    async (raw?: string) => {
      if (opening) return;
      const target = normalizeUrl(raw ?? url);
      if (!target) {
        toast("请输入要打开的 URL");
        return;
      }
      setOpening(true);
      try {
        await api.openBrowserWindow(target);
        setUrl(target);
        remember(target);
      } catch (e) {
        toastErr("open_browser_window", e);
      } finally {
        setOpening(false);
      }
    },
    [opening, remember, url],
  );

  const openExternal = useCallback(async () => {
    if (opening) return;
    const target = normalizeUrl(url);
    if (!target) {
      toast("请输入要打开的 URL");
      return;
    }
    setOpening(true);
    try {
      await openUrl(target);
      setUrl(target);
      remember(target);
    } catch (e) {
      toastErr("open_url", e);
    } finally {
      setOpening(false);
    }
  }, [opening, remember, url]);

  const importDownload = useCallback(
    async (item: BrowserDownload) => {
      if (importingPath !== null) return;
      setImportingPath(item.path);
      try {
        const bookId = await api.importBrowserDownload(item.path);
        toast(bookId ? `已导入：${item.name}` : `未导入：${item.name}`);
        await loadDownloads();
      } catch (e) {
        toastErr("import_browser_download", e);
      } finally {
        setImportingPath(null);
      }
    },
    [importingPath, loadDownloads],
  );

  const revealDownload = useCallback(async (item: BrowserDownload) => {
    try {
      await revealItemInDir(item.path);
    } catch (e) {
      toastErr("reveal_item_in_dir", e);
    }
  }, []);

  // 浏览器窗口下载完成：提示并刷新列表。书库页未挂载，返回书库时按其现有 reload 拉取最新数据。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BrowserDownloadEvent>("browser-download", (event) => {
      const payload = event.payload;
      toast(`已下载：${payload.name}`);
      if (payload.imported) toast("已加入书库");
      void loadDownloads();
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((e) => toastErr("listen:browser-download", e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadDownloads]);

  return (
    <div>
      <h2 style={{ margin: "0 0 14px", fontSize: 18 }}>浏览器</h2>

      <div className="card section-card">
        <h3 className="section-title">
          <Globe size={15} /> 地址
        </h3>
        <div className="field-row">
          <input
            className="input mono"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openInApp();
              }
            }}
            placeholder="https://example.com"
            aria-label="浏览器地址"
          />
          <button
            className="btn primary"
            onClick={() => void openInApp()}
            disabled={opening}
          >
            {opening ? "打开中…" : "打开"}
          </button>
          <button className="btn" onClick={() => void openExternal()} disabled={opening}>
            <ExternalLink size={14} /> 用系统浏览器打开
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          浏览器在独立窗口打开；下载完成后可在下方导入书库。
        </p>
      </div>

      <div className="card section-card">
        <h3 className="section-title">
          <Globe size={15} /> 最近访问
        </h3>
        {recents.length === 0 ? (
          <p className="hint">还没有最近访问。</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recents.map((item) => (
              <div className="field-row" key={item} style={{ alignItems: "center" }}>
                <button
                  className="btn"
                  style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}
                  title={`打开 ${item}`}
                  onClick={() => void openInApp(item)}
                  disabled={opening}
                >
                  <Globe size={13} style={{ flex: "none" }} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item}
                  </span>
                </button>
                <button
                  className="btn"
                  title="删除记录"
                  aria-label={`删除记录 ${item}`}
                  onClick={() => setRecents((prev) => prev.filter((u) => u !== item))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card section-card">
        <div className="field-row" style={{ alignItems: "center", marginBottom: 10 }}>
          <h3 className="section-title" style={{ margin: 0 }}>
            <Download size={15} /> 下载
          </h3>
          <button
            className="btn"
            style={{ marginLeft: "auto" }}
            onClick={() => void loadDownloads()}
            disabled={loading}
          >
            <RefreshCw size={14} /> {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
        {loadError && downloads.length === 0 ? (
          <ErrorState
            message={`下载列表加载失败：${loadError}`}
            onRetry={() => void loadDownloads()}
          />
        ) : loading && downloads.length === 0 ? (
          <PixelPet mode="loading" message="正在读取下载列表" />
        ) : downloads.length === 0 ? (
          <PixelPet mode="empty" message="暂无下载记录" />
        ) : (
          <>
            {loadError && (
              <p className="hint" style={{ color: "var(--accent)" }}>
                刷新失败：{loadError}
              </p>
            )}
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th className="num">大小</th>
                    <th>时间</th>
                    <th>状态</th>
                    <th className="num">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {downloads.map((item) => (
                    <tr key={item.path}>
                      <td
                        className="mono"
                        title={item.path}
                        style={{
                          maxWidth: 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.name}
                      </td>
                      <td className="num mono">{formatSize(item.size)}</td>
                      <td className="mono">{item.modified}</td>
                      <td>
                        <span className="badge">{item.imported ? "已导入" : "未导入"}</span>
                      </td>
                      <td className="num">
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            className="btn"
                            disabled={item.imported || importingPath !== null}
                            onClick={() => void importDownload(item)}
                          >
                            {importingPath === item.path
                              ? "导入中…"
                              : item.imported
                                ? "已导入"
                                : "导入"}
                          </button>
                          <button
                            className="btn"
                            title={`打开所在文件夹：${item.name}`}
                            onClick={() => void revealDownload(item)}
                          >
                            <FolderOpen size={14} /> 文件夹
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <Toaster />
    </div>
  );
}
