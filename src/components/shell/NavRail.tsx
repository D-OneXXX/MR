import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookMarked,
  Globe,
  Languages,
  Library as LibraryIcon,
  Moon,
  Pin,
  PinOff,
  Play,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import type { BookInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface NavRailProps {
  lastRead: BookInfo | null;
  transOn: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  libraryBadge: number;
  onClearLibraryBadge: () => void;
  version: string;
}

const PIN_KEY = "mr-nav-pinned";
const WIDTH_KEY = "mr-nav-width";

function readPinned(): boolean {
  try {
    const pinned = localStorage.getItem(PIN_KEY);
    if (pinned !== null) return pinned === "1";
    return localStorage.getItem(WIDTH_KEY) === "184";
  } catch {
    return false;
  }
}

const itemFocus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand";

export default function NavRail({
  lastRead,
  transOn,
  theme,
  onToggleTheme,
  libraryBadge,
  onClearLibraryBadge,
  version,
}: NavRailProps) {
  const nav = useNavigate();
  const [pinned, setPinned] = useState(readPinned);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, pinned ? "184" : "48");
    } catch {
      /* 忽略 */
    }
  }, [pinned]);

  const togglePin = () => {
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PIN_KEY, next ? "1" : "0");
        localStorage.setItem(WIDTH_KEY, next ? "184" : "48");
      } catch {
        /* 忽略 */
      }
      return next;
    });
  };

  const railOn = ({ isActive }: { isActive: boolean }) =>
    cn("rail-item", itemFocus, isActive && "on");
  const labelStyle = { opacity: expanded ? 1 : 0 };

  return (
    <nav
      aria-label="主导航"
      className="rail shell-surface border-hairline"
      style={{ width: expanded ? 184 : 48, zIndex: 30 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="rail-group">
        <div className="rail-group-label" style={labelStyle}>
          常规
        </div>
        <NavLink
          to="/"
          end
          className={railOn}
          onClick={onClearLibraryBadge}
        >
          <span className="rail-icon-wrap">
            <LibraryIcon size={17} />
            {libraryBadge > 0 && (
              <span className="rail-badge mono">
                {libraryBadge > 99 ? "99+" : libraryBadge}
              </span>
            )}
          </span>
          <span className="rail-label" style={labelStyle}>
            书库
          </span>
        </NavLink>
        <button
          type="button"
          className={cn("rail-item disabled:opacity-40", itemFocus)}
          disabled={!lastRead}
          title={lastRead ? `继续阅读 ${lastRead.title}` : "还没有在读书籍"}
          onClick={() =>
            lastRead && nav(`/reader/${encodeURIComponent(lastRead.id)}`)
          }
        >
          <Play size={17} />
          <span className="rail-label" style={labelStyle}>
            继续阅读
          </span>
        </button>
        {transOn && (
          <NavLink to="/workbench" className={railOn}>
            <Languages size={17} />
            <span className="rail-label" style={labelStyle}>
              翻译工作台
            </span>
          </NavLink>
        )}
      </div>

      <div className="rail-group">
        <div className="rail-group-label" style={labelStyle}>
          数据与工具
        </div>
        <NavLink to="/data" className={railOn}>
          <BarChart3 size={17} />
          <span className="rail-label" style={labelStyle}>
            数据
          </span>
        </NavLink>
        <NavLink to="/browser" className={railOn}>
          <Globe size={17} />
          <span className="rail-label" style={labelStyle}>
            浏览器
          </span>
        </NavLink>
        {transOn && (
          <NavLink to="/glossary" className={railOn}>
            <BookMarked size={17} />
            <span className="rail-label" style={labelStyle}>
              术语表
            </span>
          </NavLink>
        )}
        <NavLink to="/status" className={railOn}>
          <Activity size={17} />
          <span className="rail-label" style={labelStyle}>
            服务状态
          </span>
        </NavLink>
        <NavLink to="/settings" className={railOn}>
          <SettingsIcon size={17} />
          <span className="rail-label" style={labelStyle}>
            设置
          </span>
        </NavLink>
      </div>

      <div className="rail-foot">
        <button
          type="button"
          className={cn("rail-item", itemFocus)}
          onClick={togglePin}
          title={pinned ? "取消固定展开" : "固定展开导航"}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={17} /> : <Pin size={17} />}
          <span className="rail-label" style={labelStyle}>
            {pinned ? "取消固定" : "固定展开"}
          </span>
        </button>
        <button
          type="button"
          className={cn("rail-item", itemFocus)}
          onClick={onToggleTheme}
          title={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
          aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          <span className="rail-label" style={labelStyle}>
            {theme === "dark" ? "亮色模式" : "暗色模式"}
          </span>
        </button>
        <span className="rail-ver mono" style={labelStyle}>
          {version}
        </span>
      </div>
    </nav>
  );
}
