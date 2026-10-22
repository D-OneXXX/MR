import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useI18n } from "@/i18n";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/utils";
import { useSafeMode } from "@/features/safeMode/SafeModeContext";
import { recordBreadcrumb } from "@/features/resilience";

/** Persistent, user-controlled safe-mode badge. One click restores full mode. */
export default function SafeModePill({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { active, leaveSafeMode } = useSafeMode();
  const [busy, setBusy] = useState(false);
  if (!active) return null;

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    recordBreadcrumb("safeMode");
    try {
      await leaveSafeMode();
    } catch (error) {
      setBusy(false);
      toast(
        typeof error === "string"
          ? error
          : t("safeMode.exitFailed", { detail: String(error) }),
      );
    }
  };

  return (
    <button
      type="button"
      onClick={() => void leave()}
      disabled={busy}
      title={t("safeMode.badgeTitle")}
      aria-label={t("safeMode.badgeTitle")}
      data-safe-mode-pill
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-warning px-3 text-[11px] font-extrabold text-background shadow-hard-sm outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-70",
        className,
      )}
    >
      <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">
        {busy
          ? t("safeMode.exiting")
          : compact
            ? t("safeMode.badgeShort")
            : t("safeMode.badgeActive")}
      </span>
    </button>
  );
}
