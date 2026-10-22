import { LifeBuoy, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import DiagnosticPanel from "@/components/diagnostics/DiagnosticPanel";

/** Settings tab: local bug report + AI troubleshooting prompt generator. */
export default function SupportPanel() {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-5 sm:p-6">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
            <LifeBuoy className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-extrabold tracking-tight">
              {t("support.title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t("support.description")}
            </p>
          </div>
          <Badge variant="success" className="gap-1.5">
            <ShieldCheck className="size-3.5" aria-hidden />
            {t("support.localOnly")}
          </Badge>
        </div>
      </Card>
      <Card className="p-5 sm:p-6">
        <DiagnosticPanel />
      </Card>
    </div>
  );
}
