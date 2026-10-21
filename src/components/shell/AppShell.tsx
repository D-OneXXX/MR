import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  isOnlineEnabled,
  onExperimentalChange,
  type BookInfo,
} from "@/lib/tauri";
import { toast, Toaster } from "@/components/Toast";
import Library from "@/pages/Library";
import SettingsPage from "@/pages/Settings";
import Browser from "@/pages/Browser";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import {
  FOCUS_LIBRARY_SEARCH_EVENT,
  LIBRARY_REFRESH_EVENT,
} from "@/lib/events";
import TopBar from "./TopBar";

export default function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useWorkspace();
  const [lastRead, setLastRead] = useState<BookInfo | null>(null);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled());
  const [onlineProxy, setOnlineProxy] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [libraryBadge, setLibraryBadge] = useState(0);
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getSettings().then(
        (settings) => {
          if (!alive) return;
          setOnlineProxy(settings.onlineProxy);
          setOnlineOn(isOnlineEnabled());
          setSettingsReady(true);
          setSettingsError(false);
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
            list.find(
              (book) =>
                book.currentPage > 0 && book.currentPage + 1 < book.pageCount,
            ) ?? null,
          );
        },
        () => {
          /* 书库命令失败时“继续阅读”保持禁用 */
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

  // 阅读态不挂载 Shell；这里负责从书库侧切回后台阅读页签。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        ws.closeActiveTab();
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (loc.pathname !== "/") nav("/");
        // The Library may still be mounting; fire once its input exists so
        // the shortcut is not dropped on a slow route transition.
        const deadline = Date.now() + 1500;
        const focusWhenReady = () => {
          if (document.getElementById("library-search-input")) {
            window.dispatchEvent(new Event(FOCUS_LIBRARY_SEARCH_EVENT));
            return;
          }
          if (Date.now() < deadline) window.setTimeout(focusWhenReady, 60);
        };
        focusWhenReady();
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      event.preventDefault();
      ws.activateIndex(Number(event.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loc.pathname, nav, ws]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <TopBar
        lastRead={lastRead}
        onlineProxy={onlineProxy}
        onlineOn={onlineOn}
        settingsReady={settingsReady}
        settingsError={settingsError}
        libraryBadge={libraryBadge}
        onClearLibraryBadge={() => setLibraryBadge(0)}
      />
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <div key={loc.pathname} className="view-fade min-h-full">
          <Routes location={loc}>
            <Route path="/" element={<Library />} />
            <Route path="/browser" element={<Browser />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Library />} />
          </Routes>
        </div>
      </main>
      <Toaster />
    </div>
  );
}
