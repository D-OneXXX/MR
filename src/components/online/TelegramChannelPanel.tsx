import {
  Download,
  FileArchive,
  Images,
  Link2,
  Loader2,
  Send,
} from "lucide-react";
import type { TelegramChannel, TelegramChapter } from "@/lib/tauri";
import { useI18n, type MessageKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  channel: TelegramChannel;
  busyId: string | null;
  loadingMore: boolean;
  onImport: (chapter: TelegramChapter) => void;
  onLoadMore: () => void;
}

function kindMeta(kind: TelegramChapter["kind"]): {
  icon: typeof Images;
  key: MessageKey;
} {
  switch (kind) {
    case "telegraph":
      return { icon: Link2, key: "browser.telegram.kind.telegraph" };
    case "document":
      return { icon: FileArchive, key: "browser.telegram.kind.document" };
    default:
      return { icon: Images, key: "browser.telegram.kind.photos" };
  }
}

/** Telegram 公开频道章节列表；只导入用户点击的章节。 */
export default function TelegramChannelPanel({
  channel,
  busyId,
  loadingMore,
  onImport,
  onLoadMore,
}: Props) {
  const { t } = useI18n();
  return (
    <section
      data-testid="telegram-channel-panel"
      aria-label={t("browser.telegram.channelTitle")}
      className="rounded-2xl border border-border bg-secondary/40 p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-foreground shadow-hard-sm">
          <Send className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-bold">
              {channel.title || channel.channel}
            </h2>
            <Badge variant="secondary" className="shrink-0">
              @{channel.channel}
            </Badge>
            <Badge variant="outline" className="shrink-0">
              {t("browser.telegram.chapterCount", {
                count: channel.chapters.length,
              })}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("browser.telegram.publicNote")}
          </p>
        </div>
      </div>

      {channel.chapters.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {t("browser.telegram.noChapters")}
        </p>
      ) : (
        <ScrollArea className="mt-3 max-h-[min(46vh,420px)]">
          <ul className="flex flex-col gap-1.5 pr-2">
            {channel.chapters.map((chapter) => {
              const meta = kindMeta(chapter.kind);
              const Icon = meta.icon;
              const busy = busyId === chapter.id;
              const isDocument = chapter.kind === "document";
              return (
                <li
                  key={chapter.id}
                  data-testid="telegram-chapter"
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/70 px-3 py-2"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold" title={chapter.title}>
                      {chapter.title}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                      <span>{t(meta.key)}</span>
                      {chapter.pageCount ? (
                        <span className="mono">{chapter.pageCount}p</span>
                      ) : null}
                      {chapter.grouped ? (
                        <span>{t("browser.telegram.grouped")}</span>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    variant="pill"
                    size="pill-sm"
                    className="shrink-0"
                    disabled={busyId !== null}
                    onClick={() => onImport(chapter)}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isDocument ? (
                      <Download className="size-3.5" />
                    ) : (
                      <Images className="size-3.5" />
                    )}
                    {busy
                      ? isDocument
                        ? t("browser.telegram.downloading")
                        : t("browser.telegram.importing")
                      : isDocument
                        ? t("browser.telegram.downloadDocument")
                        : t("browser.telegram.importChapter")}
                  </Button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}

      {channel.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            data-testid="telegram-load-more"
            variant="pill"
            size="pill-sm"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {loadingMore
              ? t("browser.telegram.loadingMore")
              : t("browser.telegram.loadMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
