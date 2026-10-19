import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
}

/** 顶部统计卡片：数字一律 Geist Mono */
export default function StatCard({ icon: Icon, label, value, sub }: Props) {
  return (
    <div className="card stat-card">
      <div className="stat-icon">
        <Icon size={18} strokeWidth={1.75} />
      </div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value mono">{value}</div>
        {sub ? <div className="stat-sub">{sub}</div> : null}
      </div>
    </div>
  );
}
