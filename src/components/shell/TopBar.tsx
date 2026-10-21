import { NavLink, useNavigate } from "react-router-dom";
import {
  Globe2,
  LibraryBig,
  Moon,
  Play,
  Settings2,
  Sun,
} from "lucide-react";
import type { BookInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useTheme } from "@/features/theme/ThemeProvider";
import BrandLogo from "./BrandLogo";
import StatusPill from "./StatusPill";
import { WindowControls } from "./WindowControls";

interface TopBarProps {
  lastRead: BookInfo | null;
  onlineProxy: string | null;
  onlineOn: boolean;
  settingsReady: boolean;
  settingsError: boolean;
  libraryBadge: number;
  onClearLibraryBadge: () => void;
}

const navItem =
  "relative inline-flex h-9 items-center gap-2 rounded-full border border-transparent px-3.5 text-[13px] font-semibold outline-none transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-4";

const navIdle = "text-muted-foreground hover:bg-accent hover:text-foreground";
const navActive =
  "border border-border bg-primary text-primary-foreground shadow-hard-sm";

export default function TopBar({
  lastRead,
  onlineProxy,
  onlineOn,
  settingsReady,
  settingsError,
  libraryBadge,
  onClearLibraryBadge,
}: TopBarProps) {
  const nav = useNavigate();
  const { mode, resolved, cycleTheme } = useTheme();

  return (
    <header
      data-tauri-drag-region
      className="relative z-40 flex h-16 shrink-0 items-center px-3 sm:px-5"
    >
      <div className="absolute inset-0" data-tauri-drag-region />

      <div className="pointer-events-none relative z-10 flex w-full min-w-0 items-center gap-2 sm:gap-3">
        <NavLink
          to="/"
          end
          onClick={onClearLibraryBadge}
          className="pointer-events-auto shrink-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="MangaReader 书库"
        >
          <BrandLogo />
        </NavLink>

        <nav
          aria-label="主导航"
          className="pointer-events-auto mx-auto flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-card p-1 shadow-hard"
        >
          <NavLink
            to="/"
            end
            onClick={onClearLibraryBadge}
            className={({ isActive }) =>
              cn(navItem, isActive ? navActive : navIdle)
            }
          >
            <LibraryBig className="size-4" />
            <span>书库</span>
            {libraryBadge > 0 && (
              <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full border border-border bg-foreground px-1 py-0.5 text-[9px] font-bold leading-none text-background">
                {libraryBadge > 99 ? "99+" : libraryBadge}
              </span>
            )}
          </NavLink>

          <button
            type="button"
            className={cn(navItem, navIdle, "disabled:opacity-35")}
            disabled={!lastRead}
            title={
              lastRead ? `继续阅读《${lastRead.title}》` : "还没有在读书籍"
            }
            aria-label={
              lastRead
                ? `继续阅读《${lastRead.title}》`
                : "继续阅读（还没有在读书籍）"
            }
            onClick={() =>
              lastRead && nav(`/reader/${encodeURIComponent(lastRead.id)}`)
            }
          >
            <Play className="size-4" />
            <span>继续阅读</span>
          </button>

          <NavLink
            to="/browser"
            className={({ isActive }) =>
              cn(navItem, isActive ? navActive : navIdle)
            }
          >
            <Globe2 className="size-4" />
            <span>浏览器</span>
          </NavLink>

          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(navItem, isActive ? navActive : navIdle)
            }
          >
            <Settings2 className="size-4" />
            <span>设置</span>
          </NavLink>
        </nav>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          <StatusPill
            onlineProxy={onlineProxy}
            onlineOn={onlineOn}
            settingsReady={settingsReady}
            settingsError={settingsError}
          />
          <button
            type="button"
            className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            onClick={cycleTheme}
            title={`主题：${
              mode === "system"
                ? `跟随系统（当前${resolved === "dark" ? "深色" : "浅色"}）`
                : mode === "dark"
                  ? "深色"
                  : "浅色"
            }，点击切换`}
            aria-label="切换主题"
          >
            {resolved === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </button>
          <div className="mx-0.5 h-6 w-px bg-border/25" />
          <WindowControls />
        </div>
      </div>
    </header>
  );
}
