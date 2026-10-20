import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  BarChart3,
  BookMarked,
  BookOpen,
  Download,
  FolderSearch,
  Globe,
  Languages,
  Library as LibraryIcon,
  Link2,
  Loader2,
  Moon,
  Play,
  Search,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type BookInfo } from "@/lib/tauri";
import { toast, toastErr } from "@/components/Toast";
import { LIBRARY_REFRESH_EVENT } from "@/components/OnlineImportDialog";
import { cn } from "@/lib/utils";

interface OmniBarProps {
  lastRead: BookInfo | null;
  transOn: boolean;
  onlineOn: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenImport: (url?: string) => void;
}

interface OmniItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  hintMono?: boolean;
  icon: ReactNode;
  run: () => void;
}

const PAGE_META: Record<string, { short: string; detail: string }> = {
  "/": { short: "书库", detail: "检索舱" },
  "/data": { short: "数据", detail: "观测台" },
  "/browser": { short: "浏览器", detail: "采集舱" },
  "/workbench": { short: "翻译工作台", detail: "任务" },
  "/glossary": { short: "术语表", detail: "词条" },
  "/status": { short: "服务状态", detail: "诊断" },
  "/settings": { short: "设置", detail: "控制台" },
};

const URL_RE = /^https?:\/\/\S+$/i;

export default function OmniBar({
  lastRead,
  transOn,
  onlineOn,
  theme,
  onToggleTheme,
  onOpenImport,
}: OmniBarProps) {
  const nav = useNavigate();
  const loc = useLocation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [bookResults, setBookResults] = useState<BookInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const page = PAGE_META[loc.pathname] ?? {
    short: "MangaReader",
    detail: "控制台",
  };

  const closePalette = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const scanDirectory = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择要扫描的漫画目录",
      });
      const path =
        typeof picked === "string"
          ? picked
          : Array.isArray(picked)
            ? picked[0]
            : null;
      if (!path) return;
      toast("正在扫描目录…");
      const result = await api.scanLibrary(path);
      toast(`扫描完成，新增 ${result.added} 本`);
      window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
    } catch (e) {
      toastErr("scan_library", e);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!open) {
          triggerRef.current?.focus();
          setOpen(true);
        } else {
          inputRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setBookResults([]);
    setSearchError(null);
    setSearching(false);
    setActive(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q || URL_RE.test(q)) {
      setBookResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let alive = true;
    setSearching(true);
    setSearchError(null);
    setBookResults([]);
    const timer = window.setTimeout(() => {
      api
        .listBooks(q)
        .then(
          (list) => {
            if (alive) setBookResults(list);
          },
          (e) => {
            if (!alive) return;
            setBookResults([]);
            setSearchError(typeof e === "string" ? e : "搜索失败");
          },
        )
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const q = query.trim();
  const urlLike = URL_RE.test(q);
  const items: OmniItem[] = [];

  if (urlLike) {
    items.push({
      id: "online-url",
      group: "在线直读",
      label: onlineOn ? "解析为在线直读" : "在线直读未开启，去设置",
      hint: q,
      hintMono: true,
      icon: <Link2 size={15} />,
      run: () => {
        if (onlineOn) {
          closePalette(false);
          window.setTimeout(() => onOpenImport(q), 0);
        } else {
          closePalette(false);
          nav("/settings");
        }
      },
    });
  } else {
    const quick: OmniItem[] = [
      {
        id: "quick-import",
        group: "快速动作",
        label: "打开导入",
        hint: onlineOn ? undefined : "需开启在线直读",
        icon: <Download size={15} />,
        run: () => {
          if (onlineOn) {
            closePalette(false);
            window.setTimeout(() => onOpenImport(), 0);
          } else {
            closePalette(false);
            nav("/settings");
          }
        },
      },
      {
        id: "quick-scan",
        group: "快速动作",
        label: "扫描目录",
        hint: "选择本地目录入库",
        icon: <FolderSearch size={15} />,
        run: () => {
          closePalette(true);
          window.setTimeout(() => void scanDirectory(), 0);
        },
      },
      {
        id: "quick-settings",
        group: "快速动作",
        label: "设置",
        hint: "网络与实验性功能",
        icon: <SettingsIcon size={15} />,
        run: () => {
          closePalette(false);
          nav("/settings");
        },
      },
      {
        id: "quick-theme",
        group: "快速动作",
        label: "切换主题",
        hint: theme === "dark" ? "当前暗色" : "当前亮色",
        icon: theme === "dark" ? <Sun size={15} /> : <Moon size={15} />,
        run: () => {
          closePalette(true);
          onToggleTheme();
        },
      },
    ];

    const pages: OmniItem[] = [
      {
        id: "page-library",
        group: "跳转",
        label: "书库",
        hint: loc.pathname === "/" ? "当前" : undefined,
        icon: <LibraryIcon size={15} />,
        run: () => {
          closePalette(false);
          nav("/");
        },
      },
    ];
    if (lastRead) {
      pages.push({
        id: "page-continue",
        group: "跳转",
        label: "继续阅读",
        hint: lastRead.title,
        icon: <Play size={15} />,
        run: () => {
          closePalette(false);
          nav(`/reader/${encodeURIComponent(lastRead.id)}`);
        },
      });
    }
    if (transOn) {
      pages.push({
        id: "page-workbench",
        group: "跳转",
        label: "翻译工作台",
        icon: <Languages size={15} />,
        run: () => {
          closePalette(false);
          nav("/workbench");
        },
      });
    }
    pages.push(
      {
        id: "page-data",
        group: "跳转",
        label: "数据",
        icon: <BarChart3 size={15} />,
        run: () => {
          closePalette(false);
          nav("/data");
        },
      },
      {
        id: "page-browser",
        group: "跳转",
        label: "浏览器",
        icon: <Globe size={15} />,
        run: () => {
          closePalette(false);
          nav("/browser");
        },
      },
    );
    if (transOn) {
      pages.push({
        id: "page-glossary",
        group: "跳转",
        label: "术语表",
        icon: <BookMarked size={15} />,
        run: () => {
          closePalette(false);
          nav("/glossary");
        },
      });
    }
    pages.push({
      id: "page-status",
      group: "跳转",
      label: "服务状态",
      icon: <Activity size={15} />,
      run: () => {
        closePalette(false);
        nav("/status");
      },
    });

    const matches = (item: OmniItem) => {
      if (!q) return true;
      const needle = q.toLowerCase();
      return `${item.label} ${item.hint ?? ""}`.toLowerCase().includes(needle);
    };

    items.push(...quick.filter(matches), ...pages.filter(matches));

    for (const book of bookResults) {
      items.push({
        id: `book-${book.id}`,
        group: "本地书库",
        label: book.title,
        hint: `${book.pageCount} 页`,
        hintMono: true,
        icon: <BookOpen size={15} />,
        run: () => {
          closePalette(false);
          nav(`/reader/${encodeURIComponent(book.id)}`);
        },
      });
    }
  }

  useEffect(() => {
    setActive((value) =>
      Math.min(value, Math.max(0, items.length - 1)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const activeItem = items[active];
  const activeId = activeItem ? `omni-option-${activeItem.id}` : undefined;

  useEffect(() => {
    if (!activeId) return;
    document
      .getElementById(activeId)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) {
        setActive((value) => (value + 1) % items.length);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) {
        setActive((value) => (value - 1 + items.length) % items.length);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) item.run();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette(true);
    }
  };

  let groupCursor = "";
  const showEmpty =
    !urlLike && q.length > 0 && items.length === 0 && !searching && !searchError;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`打开命令面板（当前：${page.short}）`}
        className="pointer-events-auto flex h-8 shrink items-center gap-2 rounded-md border border-hairline bg-surface/70 px-3 text-[12px] text-ink shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        style={{ width: "clamp(220px, 34vw, 460px)" }}
      >
        <Search size={14} className="shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1 truncate text-left">
          <span className="text-ink">{page.short}</span>
          <span className="text-ink-muted max-[1100px]:hidden">
            {" "}
            · {page.detail}
          </span>
        </span>
        <span className="mono hidden shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-ink-muted min-[1100px]:inline">
          Ctrl K
        </span>
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-2rem)]! max-w-[640px]! gap-0! border-0! bg-transparent! p-0! shadow-none! ring-0!"
        >
          <div className="glass overflow-hidden rounded-xl border border-hairline text-ink shadow-2xl">
            <DialogTitle className="sr-only">命令面板</DialogTitle>
            <DialogDescription className="sr-only">
              搜索页面与本地书库，或粘贴 URL 打开在线直读。
            </DialogDescription>

            <div className="flex items-center gap-2.5 border-b border-hairline px-4">
              <Search size={16} className="shrink-0 text-ink-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onInputKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-controls="omni-list"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="搜索页面、本地书籍或粘贴 URL"
                placeholder="搜索页面、本地书籍，或粘贴 URL…"
                className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
              />
              <kbd className="mono hidden rounded border border-hairline px-1.5 py-0.5 text-[10px] text-ink-muted sm:inline">
                Esc
              </kbd>
            </div>

            <div
              id="omni-list"
              role="listbox"
              aria-label="命令结果"
              className="max-h-[420px] overflow-y-auto p-2"
            >
              {items.map((item, index) => {
                const heading = item.group !== groupCursor ? item.group : "";
                groupCursor = item.group;
                const selected = index === active;
                return (
                  <Fragment key={item.id}>
                    {heading && (
                      <div
                        role="presentation"
                        className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-muted"
                      >
                        {heading}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      id={`omni-option-${item.id}`}
                      aria-selected={selected}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => item.run()}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                        selected
                          ? "bg-accent text-ink"
                          : "text-ink hover:bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0",
                          selected ? "text-brand" : "text-ink-muted",
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint && (
                        <span
                          className={cn(
                            "max-w-[45%] truncate text-[11px] text-ink-muted",
                            item.hintMono && "mono",
                          )}
                        >
                          {item.hint}
                        </span>
                      )}
                    </button>
                  </Fragment>
                );
              })}

              {searching && (
                <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-ink-muted">
                  <Loader2 size={13} className="animate-spin" />
                  正在搜索本地书库…
                </div>
              )}
              {searchError && (
                <div className="px-2.5 py-2 text-[11px] text-danger">
                  本地搜索失败：{searchError}
                </div>
              )}
              {showEmpty && (
                <div className="px-2.5 py-8 text-center text-[12px] text-ink-muted">
                  没有匹配结果
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-hairline px-4 py-2 text-[10px] text-ink-muted">
              <span>
                <span className="mono">↑↓</span> 选择
              </span>
              <span>
                <span className="mono">Enter</span> 打开
              </span>
              <span>
                <span className="mono">Esc</span> 关闭
              </span>
              <span className="mono ml-auto">Ctrl K</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
