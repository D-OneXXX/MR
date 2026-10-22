import { useEffect, useState, type ReactNode } from "react";
import {
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Loader2 } from "lucide-react";
import Reader from "./pages/Reader";
import AppShell from "./components/shell/AppShell";
import {
  WorkspaceProvider,
  useWorkspace,
} from "./features/workspace/WorkspaceContext";
import { useSafeMode } from "./features/safeMode/SafeModeContext";
import { useI18n } from "./i18n";

/** 阅读路由：key 绑定 bookId，切页签时强制卸载旧 Reader（释放图片/条漫 DOM）。 */
function ReaderRoute() {
  const { id = "" } = useParams();
  const ws = useWorkspace();
  const bookId = decodeURIComponent(id);
  const known = ws.tabs.some((t) => t.bookId === bookId);
  // 超出页签上限时不挂载 Reader，避免白跑 get_book/get_page；Provider 随后提示并回退。
  if (!known && ws.tabs.length >= ws.maxTabs) return null;
  return (
    <div className="view-fade">
      <Reader key={bookId} />
    </div>
  );
}

export default function App() {
  return (
    <SafeModeBootGate>
      <WorkspaceProvider>
        <AppRoutes />
      </WorkspaceProvider>
    </SafeModeBootGate>
  );
}

/**
 * Safe-mode startup policy: never mount a Reader/Browser surface before the
 * persisted safe-mode flag is known. A previously open reader (the most likely
 * corrupt scene) is skipped exactly once, without touching library progress.
 */
function SafeModeBootGate({ children }: { children: ReactNode }) {
  const { active, ready } = useSafeMode();
  const { t } = useI18n();
  const loc = useLocation();
  const nav = useNavigate();
  const [booted, setBooted] = useState(false);

  const unsafePath =
    loc.pathname.startsWith("/reader/") || loc.pathname === "/browser";

  useEffect(() => {
    if (ready && active && !booted && unsafePath) {
      nav("/", { replace: true });
    }
  }, [active, booted, nav, ready, unsafePath]);

  useEffect(() => {
    if (ready && !booted && (!active || !unsafePath)) setBooted(true);
  }, [active, booted, ready, unsafePath]);

  if (!ready || !booted) {
    return (
      <div
        className="grid h-screen w-full place-items-center bg-background text-sm text-muted-foreground"
        aria-busy="true"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-hard-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("common.loading")}
        </span>
      </div>
    );
  }
  return <>{children}</>;
}

function AppRoutes() {
  const loc = useLocation();
  const immersive = loc.pathname.startsWith("/reader/");

  return immersive ? (
    <Routes>
      <Route path="/reader/:id" element={<ReaderRoute />} />
    </Routes>
  ) : (
    <AppShell />
  );
}
