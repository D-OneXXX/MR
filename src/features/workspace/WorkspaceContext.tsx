import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Direction, PageMode } from "@/components/Reader/spread";
import { toast } from "@/components/Toast";
import { api } from "@/lib/tauri";

/** 最多同时打开的漫画阅读页签（固定「书库」页签不计入）。 */
export const MAX_READER_TABS = 5;

/**
 * 运行时可回退开关：`localStorage.setItem("mr-tabs", "0")` 后刷新，退回单页签模式
 * （打开新书替换当前书、不显示页签切换器、返回书库即清 L1）。默认开启。
 */
export const TABS_ENABLED = (() => {
  try {
    return localStorage.getItem("mr-tabs") !== "0";
  } catch {
    return true;
  }
})();

/** 轻量会话快照：只存页码/滚动百分比/版式/方向与写入时间，不存图片或 DOM。 */
export interface TabSnapshot {
  page: number;
  scrollPct: number;
  mode: PageMode;
  dir: Direction;
  /** 写入时间（epoch ms）；与后端 updated_at 比较决定恢复来源。 */
  at: number;
}

export interface ReaderTab {
  bookId: string;
  title: string;
}

interface WorkspaceValue {
  tabs: ReaderTab[];
  activeId: string | null;
  maxTabs: number;
  tabsEnabled: boolean;
  ensureTab: (bookId: string) => boolean;
  activateTab: (bookId: string) => void;
  /** 1 = 书库，2.. = 第 1..N 个阅读页签。 */
  activateIndex: (index: number) => void;
  closeTab: (bookId: string) => void;
  closeActiveTab: () => void;
  replaceTab: (fromId: string, toId: string) => void;
  goLibrary: () => void;
  reportBook: (bookId: string, title: string) => void;
  reportSnapshot: (bookId: string, snapshot: Omit<TabSnapshot, "at">) => void;
  getSnapshot: (bookId: string) => TabSnapshot | null;
  /** 页签是否仍存在；关闭/替换后 Reader 卸载时不要复活已丢弃的快照。 */
  isTabOpen: (bookId: string) => boolean;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return value;
}

/**
 * 阅读工作区：
 * - 固定第一个「书库」页签（路由 "/"），漫画各占一个阅读页签（路由 "/reader/:id"）；
 * - 同一本书只允许一个页签，最多 [`MAX_READER_TABS`] 个；超限拒绝并回退；
 * - 只有激活页签挂载 Reader；切换时由 Reader 卸载前 flush 进度，快照存内存；
 * - L1（`clear_pages`）只在最后一个阅读页签关闭时清理，切页签不清缓存。
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [tabs, setTabs] = useState<ReaderTab[]>([]);
  const snapshots = useRef(new Map<string, TabSnapshot>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeId = useMemo(() => {
    if (!loc.pathname.startsWith("/reader/")) return null;
    const raw = loc.pathname.slice("/reader/".length).split("/")[0] ?? "";
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [loc.pathname]);

  const ensureTab = useCallback((bookId: string): boolean => {
    const list = tabsRef.current;
    if (list.some((t) => t.bookId === bookId)) return true;
    if (!TABS_ENABLED) {
      // 回退模式：始终只保留当前一本书。
      setTabs([{ bookId, title: "载入中…" }]);
      return true;
    }
    if (list.length >= MAX_READER_TABS) return false;
    setTabs((prev) =>
      prev.some((t) => t.bookId === bookId)
        ? prev
        : [...prev, { bookId, title: "载入中…" }],
    );
    return true;
  }, []);

  // 进入 /reader/:id（含深链）时登记页签；超限则退回上一个页签或书库。
  useEffect(() => {
    if (!activeId) return;
    if (ensureTab(activeId)) return;
    toast(`最多同时打开 ${MAX_READER_TABS} 个阅读页签，请先关闭一个`);
    const fallback = tabsRef.current[tabsRef.current.length - 1];
    nav(fallback ? `/reader/${encodeURIComponent(fallback.bookId)}` : "/", {
      replace: true,
    });
  }, [activeId, ensureTab, nav]);

  const activateTab = useCallback(
    (bookId: string) => {
      if (bookId === activeId) return;
      nav(`/reader/${encodeURIComponent(bookId)}`);
    },
    [activeId, nav],
  );

  const activateIndex = useCallback(
    (index: number) => {
      if (!TABS_ENABLED) {
        if (index <= 1 && activeId !== null) nav("/");
        return;
      }
      if (index <= 1) {
        if (activeId !== null) nav("/");
        return;
      }
      const tab = tabsRef.current[index - 2];
      if (tab && tab.bookId !== activeId) {
        nav(`/reader/${encodeURIComponent(tab.bookId)}`);
      }
    },
    [activeId, nav],
  );

  const closeTab = useCallback(
    (bookId: string) => {
      const list = tabsRef.current;
      const idx = list.findIndex((t) => t.bookId === bookId);
      if (idx < 0) return;
      const next = list.filter((t) => t.bookId !== bookId);
      snapshots.current.delete(bookId);
      setTabs(next);

      if (activeId === bookId) {
        const target = next[idx] ?? next[idx - 1] ?? null;
        if (target) {
          nav(`/reader/${encodeURIComponent(target.bookId)}`, { replace: true });
        } else {
          api.clearPages().catch(() => {});
          nav("/", { replace: true });
        }
      } else if (next.length === 0) {
        api.clearPages().catch(() => {});
      }
    },
    [activeId, nav],
  );

  const closeActiveTab = useCallback(() => {
    if (activeId) closeTab(activeId);
  }, [activeId, closeTab]);

  /** 下一话：用新书替换当前页签，避免页签数随章节增长。 */
  const replaceTab = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    snapshots.current.delete(fromId);
    setTabs((prev) => {
      const without = prev.filter((t) => t.bookId !== toId);
      const idx = without.findIndex((t) => t.bookId === fromId);
      if (idx < 0) {
        if (prev.some((t) => t.bookId === toId)) return without;
        if (prev.length >= MAX_READER_TABS) return prev;
        return [...without, { bookId: toId, title: "载入中…" }];
      }
      const next = [...without];
      next[idx] = { bookId: toId, title: "载入中…" };
      return next;
    });
  }, []);

  const goLibrary = useCallback(() => {
    if (activeId !== null) nav("/");
  }, [activeId, nav]);

  const reportBook = useCallback((bookId: string, title: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.bookId === bookId);
      if (idx < 0 || prev[idx].title === title) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], title };
      return next;
    });
  }, []);

  // 快照只写 ref：翻页/滚动不会触发 Provider 重渲染；at 在此统一盖章。
  const reportSnapshot = useCallback(
    (bookId: string, snapshot: Omit<TabSnapshot, "at">) => {
      snapshots.current.set(bookId, { ...snapshot, at: Date.now() });
    },
    [],
  );

  const getSnapshot = useCallback(
    (bookId: string) => snapshots.current.get(bookId) ?? null,
    [],
  );

  const isTabOpen = useCallback(
    (bookId: string) => tabsRef.current.some((tab) => tab.bookId === bookId),
    [],
  );

  // 回退模式：离开阅读态（回书库）即清空页签并释放 L1，等价于旧行为。
  useEffect(() => {
    if (TABS_ENABLED || activeId !== null || tabs.length === 0) return;
    setTabs([]);
    api.clearPages().catch(() => {});
  }, [activeId, tabs.length]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      tabs,
      activeId,
      maxTabs: MAX_READER_TABS,
      tabsEnabled: TABS_ENABLED,
      ensureTab,
      activateTab,
      activateIndex,
      closeTab,
      closeActiveTab,
      replaceTab,
      goLibrary,
      reportBook,
      reportSnapshot,
      getSnapshot,
      isTabOpen,
    }),
    [
      tabs,
      activeId,
      ensureTab,
      activateTab,
      activateIndex,
      closeTab,
      closeActiveTab,
      replaceTab,
      goLibrary,
      reportBook,
      reportSnapshot,
      getSnapshot,
      isTabOpen,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}
