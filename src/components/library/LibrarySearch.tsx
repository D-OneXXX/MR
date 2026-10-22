import { useEffect } from "react";
import { ArrowRight, Search } from "lucide-react";
import { useI18n } from "@/i18n";
import { Input } from "@/components/ui/input";
import { FOCUS_LIBRARY_SEARCH_EVENT } from "@/lib/events";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 立即应用当前关键词（回车/点击胶囊按钮）。 */
  onCommit: () => void;
}

const INPUT_ID = "library-search-input";

/** 嵌套胶囊搜索框；Ctrl+K（全局事件）聚焦并全选。 */
export default function LibrarySearch({ value, onChange, onCommit }: Props) {
  const { t } = useI18n();
  useEffect(() => {
    const focus = () => {
      const input = document.getElementById(INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      input.focus();
      input.select();
    };
    window.addEventListener(FOCUS_LIBRARY_SEARCH_EVENT, focus);
    return () =>
      window.removeEventListener(FOCUS_LIBRARY_SEARCH_EVENT, focus);
  }, []);

  return (
    <form
      role="search"
      className="flex h-12 w-full max-w-2xl items-center gap-2 rounded-full border border-border bg-card pl-5 pr-1.5 shadow-hard-sm transition-shadow focus-within:ring-2 focus-within:ring-foreground focus-within:ring-offset-2 focus-within:ring-offset-background"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit();
      }}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <Input
        id={INPUT_ID}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={t("library.searchPlaceholder")}
        aria-label={t("library.searchAria")}
        autoComplete="off"
        className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
      />
      <button
        type="submit"
        className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={t("common.search")}
      >
        {t("common.search")}
        <ArrowRight className="size-4 shrink-0" />
      </button>
    </form>
  );
}
