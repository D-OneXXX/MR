import { Route, Routes, useLocation, useParams } from "react-router-dom";
import Reader from "./pages/Reader";
import AppShell from "./components/shell/AppShell";
import {
  WorkspaceProvider,
  useWorkspace,
} from "./features/workspace/WorkspaceContext";

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
  const loc = useLocation();
  const immersive = loc.pathname.startsWith("/reader/");

  return (
    <WorkspaceProvider>
      {immersive ? (
        <Routes>
          <Route path="/reader/:id" element={<ReaderRoute />} />
        </Routes>
      ) : (
        <AppShell />
      )}
    </WorkspaceProvider>
  );
}
