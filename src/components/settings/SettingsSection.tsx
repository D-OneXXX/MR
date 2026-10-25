import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 设置页分区卡片：图标标题 + 说明 + 内容，沿用统一的硬阴影卡片。 */
export function SettingsSection({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <Card className={cn("gap-4 p-5 sm:p-6", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-secondary-foreground shadow-hard-sm">
          <Icon className="size-4" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-bold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

interface SettingRowProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 带标题、说明与右侧控件的设置行。 */
export function SettingRow({
  title,
  description,
  badge,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-border bg-background/60 p-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="break-words text-sm font-semibold text-foreground">
            {title}
          </p>
          {badge}
        </div>
        {description ? (
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
