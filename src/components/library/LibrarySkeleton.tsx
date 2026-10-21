import { Skeleton } from "@/components/ui/skeleton";

/** 初始加载时的书卡骨架网格，尺寸与真实卡片一致，避免布局跳动。 */
export default function LibrarySkeleton({ count = 12 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
      role="status"
      aria-label="正在载入书架"
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="rounded-2xl border border-border bg-card p-2 shadow-card"
        >
          <Skeleton className="aspect-[3/4] w-full rounded-xl" />
          <div className="px-1 pb-1 pt-2.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="mt-2 h-3 w-1/2" />
            <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
