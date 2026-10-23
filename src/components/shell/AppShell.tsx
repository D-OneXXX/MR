import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  isOnlineEnabled,
  onExperimentalChange,
  type BookInfo,
} from "@/lib/tauri";
import { toast, Toaster } from "@/components/Toast";
import { translate } from "@/i18n";
import Library from "@/pages/Library";
import SettingsPage from "@/pages/Settings";
import Browser from "@/pages/Browser";
import { useWorkspace } from "@/features/workspace/WorkspaceContext";
import {
  FOCUS_LIBRARY_SEARCH_EVENT,
  LIBRARY_REFRESH_EVENT,
} from "@/lib/events";
import TopBar from "./TopBar";
import PrivacyDialog from "@/components/privacy/PrivacyDialog";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { useGlobalShortcuts } from "@/features/shortcuts/useGlobalShortcuts";

export default function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  const ws = useWorkspace();
  const { active: safeMode } = useSafeMode();
  const [lastRead, setLastRead] = useState<BookInfo | null>(null);
  const [onlineOn, setOnlineOn] = useState(isOnlineEnabled());
  const [onlineProxy, setOnlineProxy] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [libraryBadge, setLibraryBadge] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const pathRef = useRef(loc.pathname);
  pathRef.current = loc.pathname;

  // Page transitions must start at the top: the shell owns the scroll container,
  // so without this a previous page's scroll position can clip the next header.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [loc.pathname]);

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
                (book.sourceType === "local" || !safeMode) &&
                book.currentPage > 0 &&
                book.currentPage + 1 < book.pageCount,
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
  }, [loc.pathname, safeMode]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<BookInfo[]>("online-handoff-imported", (event) => {
      if (disposed || safeMode) return;
      const books = Array.isArray(event.payload) ? event.payload : [];
      if (books.length === 0) return;
      const title = books[0]?.title?.trim() || translate("common.unknown");
      toast(
        books.length > 1
          ? translate("toast.receivedMany", {
              title,
              count: books.length,
            })
          : translate("toast.receivedOne", { title }),
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
  }, [safeMode]);

  useEffect(() => {
    if (loc.pathname === "/") setLibraryBadge(0);
  }, [loc.pathname]);

  // 阅读态不挂载 Shell；这里负责从书库侧切回后台阅读页签。
  const onShellKey = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Ctrl/Cmd+W 是窗口关闭保护：即使焦点在输入框里也必须拦截，
      // 否则 WebView2 会直接关窗（因此它是唯一豁免输入态的键）。
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
      event.preventDefault();
      ws.activateIndex(Number(event.key));
    },
    [loc.pathname, nav, ws],
  );

  // 全局快捷键统一守卫：输入法组合中 / 输入框焦点一律放行，
  // 数字键切页签与 Ctrl/Cmd+K 只在非输入态生效；
  // w/W 例外（Ctrl+W 窗口关闭保护必须始终拦截）。
  const shellShortcuts = useMemo(() => {
    const map: Record<string, (event: KeyboardEvent) => void> = {};
    map.k = onShellKey;
    map.K = onShellKey;
    map.w = onShellKey;
    map.W = onShellKey;
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      map[key] = onShellKey;
    }
    return map;
  }, [onShellKey]);

  useGlobalShortcuts(shellShortcuts, { editableExempt: ["w", "W"] });

  return (
    <div className="flex h-screen w-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        lastRead={lastRead}
        onlineProxy={onlineProxy}
        onlineOn={onlineOn}
        settingsReady={settingsReady}
        settingsError={settingsError}
        libraryBadge={libraryBadge}
        onClearLibraryBadge={() => setLibraryBadge(0)}
      />
      <main
        ref={mainRef}
        className="relative w-full min-w-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div key={loc.pathname} className="view-fade min-h-full">
          <Routes location={loc}>
            <Route path="/" element={<Library />} />
            <Route path="/browser" element={<Browser />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* 通配兜底：已下线/未知路由静默 replace 回书库首页，
                避免历史栈残留废弃 URL 导致返回即白屏（AGENTS.md §2.1）。 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <Toaster />
      <PrivacyDialog />
    </div>
  );
}
