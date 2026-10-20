import { BookOpen } from "lucide-react";
import type { BookInfo } from "@/lib/tauri";
import { WindowControls } from "@/components/TitleBar";
import OmniBar from "./OmniBar";
import StatusPill from "./StatusPill";

interface TitleBarV3Props {
  lastRead: BookInfo | null;
  transOn: boolean;
  onlineOn: boolean;
  onlineProxy: string | null;
  settingsReady: boolean;
  settingsError: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenImport: (url?: string) => void;
}

export default function TitleBarV3({
  lastRead,
  transOn,
  onlineOn,
  onlineProxy,
  settingsReady,
  settingsError,
  theme,
  onToggleTheme,
  onOpenImport,
}: TitleBarV3Props) {
  return (
    <header
      className="titlebar shell-surface border-b border-hairline"
      style={{ zIndex: 40 }}
    >
      {/* 仅空白层可拖动；交互元素在其上方，不占用拖动区。 */}
      <div className="absolute inset-0" data-tauri-drag-region />

      <div className="pointer-events-none relative z-10 flex h-full w-full min-w-0 items-center gap-3 px-3">
        <div className="pointer-events-none flex shrink-0 select-none items-center gap-2">
          <BookOpen size={16} className="text-brand" />
          <span className="text-[13px] font-bold text-ink">MangaReader</span>
        </div>

        <div className="flex min-w-0 flex-1 justify-center px-2">
          <OmniBar
            lastRead={lastRead}
            transOn={transOn}
            onlineOn={onlineOn}
            theme={theme}
            onToggleTheme={onToggleTheme}
            onOpenImport={onOpenImport}
          />
        </div>

        <div className="pointer-events-auto flex h-full shrink-0 items-center gap-2">
          <StatusPill
            onlineProxy={onlineProxy}
            settingsReady={settingsReady}
            settingsError={settingsError}
            onlineOn={onlineOn}
          />
          <div className="h-6 w-px bg-hairline" />
          <WindowControls />
        </div>
      </div>
    </header>
  );
}
