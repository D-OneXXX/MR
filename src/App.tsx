import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookMarked,
  FlaskConical,
  Languages,
  Library as LibraryIcon,
  Moon,
  Play,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { api, isTransEnabled, onTransToggle, type BookInfo } from "./lib/tauri";

// v2「流体」设计语言：
// - 单画布 + 64px 图标轨（hover 展开文字，覆盖式不推挤内容）；
// - 视图切换 260ms 淡入（铁律：禁止瞬时跳变）；
// - 阅读器路由保持真全屏沉浸（控制条 3s 自动隐藏），壳不参与。
import Library from "./pages/Library";
import Reader from "./pages/Reader";
import Settings from "./pages/Settings";
import Workbench from "./pages/Workbench";
import Glossary from "./pages/Glossary";
import Status from "./pages/Status";
import DataView from "./pages/DataView";
import TitleBar from "./components/TitleBar";

const VERSION = "v0.2.0";

export default function App() {
  const loc = useLocation();
  const immersive = loc.pathname.startsWith("/reader/");
  if (immersive) {
    // 包一层 Route 才能让 Reader 的 useParams 拿到 :id；view-fade 提供进出阅读器的 crossfade。
    return (
      <Routes>
        <Route
          path="/reader/:id"
          element={
            <div className="view-fade">
              <Reader />
            </div>
          }
        />
      </Routes>
    );
  }
  return <Shell />;
}

function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  // 最近在读的书：listBooks 按 updated_at 倒序，取第一本有进度且未读完的。
  const [lastRead, setLastRead] = useState<BookInfo | null>(null);
  // 实验性翻译开关：镜像初值 + 后端刷新 + 变更订阅。
  const [transOn, setTransOn] = useState(isTransEnabled());
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    api
      .getSettings()
      .then(() => setTransOn(isTransEnabled()))
      .catch(() => {});
    const off = onTransToggle(setTransOn);
    return () => off();
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

  const railOn = ({ isActive }: { isActive: boolean }) =>
    `rail-item${isActive ? " on" : ""}`;

  // 实验性翻译关闭时的占位页（工作台/术语表路由的守卫）。
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
    <>
      <TitleBar />
      <aside className="rail">
        <div className="rail-group">
          <div className="rail-group-label">常规</div>
          <NavLink to="/" end className={railOn}>
            <LibraryIcon size={17} />
            <span className="rail-label">书库</span>
          </NavLink>
          <button
            className="rail-item"
            disabled={!lastRead}
            title={lastRead ? `继续阅读 ${lastRead.title}` : "还没有在读书籍"}
            onClick={() => lastRead && nav(`/reader/${encodeURIComponent(lastRead.id)}`)}
          >
            <Play size={17} />
            <span className="rail-label">继续阅读</span>
          </button>
          {transOn && (
            <NavLink to="/workbench" className={railOn}>
              <Languages size={17} />
              <span className="rail-label">翻译工作台</span>
            </NavLink>
          )}
        </div>

        <div className="rail-group">
          <div className="rail-group-label">数据与工具</div>
          <NavLink to="/data" className={railOn}>
            <BarChart3 size={17} />
            <span className="rail-label">数据</span>
          </NavLink>
          {transOn && (
            <NavLink to="/glossary" className={railOn}>
              <BookMarked size={17} />
              <span className="rail-label">术语表</span>
            </NavLink>
          )}
          <NavLink to="/status" className={railOn}>
            <Activity size={17} />
            <span className="rail-label">服务状态</span>
          </NavLink>
        </div>

        <div className="rail-foot">
          <button className="rail-item" onClick={() => void toggleTheme()}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span className="rail-label">{theme === "dark" ? "亮色模式" : "暗色模式"}</span>
          </button>
          <NavLink to="/settings" className={railOn}>
            <SettingsIcon size={17} />
            <span className="rail-label">设置</span>
          </NavLink>
          <span className="rail-ver mono">{VERSION}</span>
        </div>
      </aside>

      <main className="shell-main">
        <div key={loc.pathname} className="view-fade">
          <Routes location={loc}>
            <Route path="/" element={<Library />} />
            <Route path="/data" element={<DataView />} />
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
                  <Settings />
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
    </>
  );
}
