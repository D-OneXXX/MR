import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { FlaskConical } from "lucide-react";
import {
  api,
  isOnlineEnabled,
  isTransEnabled,
  onExperimentalChange,
  type BookInfo,
  type Settings,
} from "@/lib/tauri";
import { toast } from "@/components/Toast";
import OnlineImportDialog, {
  LIBRARY_REFRESH_EVENT,
} from "@/components/OnlineImportDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import Library from "@/pages/Library";
import SettingsPage from "@/pages/Settings";
import Workbench from "@/pages/Workbench";
import Glossary from "@/pages/Glossary";
import Status from "@/pages/Status";
import DataView from "@/pages/DataView";
import Browser from "@/pages/Browser";
import TitleBarV3 from "./TitleBarV3";
import NavRail from "./NavRail";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";

const VERSION = "v0.6.0";

export default function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useWorkspace();
  const [lastRead, setLastRead] = useState<BookInfo | null>(null);
  const [transOn, setTransOn] = useState(isTransEnabled());
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled());
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [libraryBadge, setLibraryBadge] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getSettings().then(
        (s) => {
          if (!alive) return;
          setSettings(s);
          setSettingsReady(true);
          setSettingsError(false);
          setTransOn(isTransEnabled());
          setOnlineOn(isOnlineEnabled());
          const nextTheme = s.theme === "light" ? "light" : "dark";
          setTheme(nextTheme);
          document.documentElement.dataset.theme = nextTheme;
          try {
            localStorage.setItem("mr-theme", nextTheme);
          } catch {
            /* 忽略 */
          }
        },
        () => {
          if (!alive) return;
          setSettingsError(true);
          setSettingsReady(true);
        },
      );
    };
    void load();
    const off = onExperimentalChange(() => {
      setTransOn(isTransEnabled());
      setOnlineOn(isOnlineEnabled());
      void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .listBooks()
      .then(
        (list) => {
          if (!alive) return;
          setLastRead(
            list.find((b) => b.currentPage > 0 && b.currentPage + 1 < b.pageCount) ??
              null,
          );
        },
        () => {
          /* 书库命令失败时导航项禁用即可 */
        },
      );
    return () => {
      alive = false;
    };
  }, [loc.pathname]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BookInfo[]>("online-handoff-imported", (event) => {
      if (disposed) return;
      const books = Array.isArray(event.payload) ? event.payload : [];
      if (books.length === 0) return;
      const title = books[0]?.title ?? "未命名";
      toast(
        books.length > 1
          ? `已接收《${title}》等 ${books.length} 话`
          : `已接收《${title}》`,
      );
      if (pathRef.current !== "/") {
        setLibraryBadge((count) => count + books.length);
      } else {
        window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
      }
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (loc.pathname === "/") setLibraryBadge(0);
  }, [loc.pathname]);

  // 阅读态不挂载 Shell，因此这里与 Reader 内的监听不会重复；
  // 回书库后仍可用 Ctrl+2… 切回后台阅读页签。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "w" || e.key === "W") {
        // 输入框内也必须拦截，避免 WebView2 直接关窗。
        e.preventDefault();
        ws.closeActiveTab();
        return;
      }
      if (!/^[1-9]$/.test(e.key)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      e.preventDefault();
      ws.activateIndex(Number(e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);

  const toggleTheme = async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mr-theme", next);
    } catch {
      /* 忽略 */
    }
    try {
      const s = await api.getSettings();
      await api.setSettings({ ...s, theme: next });
    } catch {
      /* 无库环境只做内存/本地持久化 */
    }
  };

  const openImport = (url = "") => setImportUrl(url);

  const gatedPage = (
    <div className="shell-inner">
      <div className="card section-card">
        <h3 className="section-title">
          <FlaskConical size={15} /> 实验性功能未开启
        </h3>
        <p className="hint">
          翻译功能默认关闭。到「设置 → 实验性功能」打开「翻译功能」后，这里会显示对应页面。
        </p>
        <button className="btn primary" onClick={() => nav("/settings")}>
          去设置开启
        </button>
      </div>
    </div>
  );

  return (
    <TooltipProvider>
      <TitleBarV3
        lastRead={lastRead}
        transOn={transOn}
        onlineOn={onlineOn}
        onlineProxy={settings?.onlineProxy ?? null}
        settingsReady={settingsReady}
        settingsError={settingsError}
        theme={theme}
        onToggleTheme={() => void toggleTheme()}
        onOpenImport={openImport}
      />
      <NavRail
        lastRead={lastRead}
        transOn={transOn}
        theme={theme}
        onToggleTheme={() => void toggleTheme()}
        libraryBadge={libraryBadge}
        onClearLibraryBadge={() => setLibraryBadge(0)}
        version={VERSION}
      />
      <main className="shell-main bg-canvas">
        <div key={loc.pathname} className="view-fade">
          <Routes location={loc}>
            <Route path="/" element={<Library />} />
            <Route path="/data" element={<DataView />} />
            <Route
              path="/browser"
              element={
                <div className="shell-inner">
                  <Browser />
                </div>
              }
            />
            <Route
              path="/workbench"
              element={
                transOn ? (
                  <div className="shell-inner">
                    <Workbench />
                  </div>
                ) : (
                  gatedPage
                )
              }
            />
            <Route
              path="/settings"
              element={
                <div className="shell-inner">
                  <SettingsPage />
                </div>
              }
            />
            <Route
              path="/glossary"
              element={
                transOn ? (
                  <div className="shell-inner">
                    <Glossary />
                  </div>
                ) : (
                  gatedPage
                )
              }
            />
            <Route
              path="/status"
              element={
                <div className="shell-inner">
                  <Status />
                </div>
              }
            />
            <Route path="*" element={<Library />} />
          </Routes>
        </div>
      </main>

      {importUrl !== null && (
        <OnlineImportDialog
          initialUrl={importUrl}
          initialTab="link"
          onClose={() => setImportUrl(null)}
          onImported={() =>
            window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT))
          }
          onRead={(b) => {
            setImportUrl(null);
            nav(`/reader/${encodeURIComponent(b.id)}`);
          }}
        />
      )}
    </TooltipProvider>
  );
}
