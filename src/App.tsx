import { useEffect, useState, type ReactNode } from "react";
import {
  Navigate,
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

/**
 * 壳层（AppShell）允许渲染的路径白名单。
 * 注意：书库首页的真实路径是 "/"，而不是 "/library"。
 */
const SHELL_ROUTES = new Set(["/", "/browser", "/settings"]);

/**
 * 兼容别名："/library" 只是历史入口（书库首页的真实路径是 "/"），
 * 命中它或它的深链（"#/library/xxx"）同样要 replace 回 "/"。
 */
const LEGACY_LIBRARY_ALIAS = "/library";

/** 判断是否命中 "/library" 兼容别名（含深链）。 */
function isLegacyLibraryAlias(pathname: string): boolean {
  return (
    pathname === LEGACY_LIBRARY_ALIAS ||
    pathname.startsWith(`${LEGACY_LIBRARY_ALIAS}/`)
  );
}

/** 判断是否命中壳层白名单；容忍尾部斜杠写法（"/browser/" 与 "/browser" 等价）。 */
function isShellRoute(pathname: string): boolean {
  if (SHELL_ROUTES.has(pathname)) return true;
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed !== "" && SHELL_ROUTES.has(trimmed);
}

function AppRoutes() {
  const loc = useLocation();
  const immersive = loc.pathname.startsWith("/reader/");

  if (immersive) {
    return (
      <Routes>
        <Route path="/reader/:id" element={<ReaderRoute />} />
        {/* immersive 分支兜底："/reader/xxx/yyy" 之类多级路径不会命中 :id，
            用通配路由静默送回书库首页，避免出现未匹配路由导致的空白页。 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // 白名单之外的路径一律静默重定向到书库首页 "/"：
  // 早期版本的外围入口（翻译台、词条页、状态页、数据页、OCR 页、工作台等）
  // 与任意乱码深链都已下线，用"白名单未命中"一次性兜住，避免残留 URL 落到空白页，
  // 同时天然覆盖 "/library" 兼容别名。
  // 必须用 replace 而不是 push：push 会把废弃 URL 留在历史栈里，
  // 用户按"返回"时会再次命中未匹配路由而白屏，形成"返回即崩"的死循环；
  // replace 让当前条目被替换掉，历史栈中不再残留废弃路由。
  if (isLegacyLibraryAlias(loc.pathname) || !isShellRoute(loc.pathname)) {
    return <Navigate to="/" replace />;
  }

  return <AppShell />;
}
