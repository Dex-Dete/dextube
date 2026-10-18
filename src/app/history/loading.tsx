import { PageHeaderSkeleton, TableSkeleton } from "@/components/ui";

/** Mirrors History: header, a Continue-watching rail, then the entry list. */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-6" />
      <div aria-hidden="true" className="mb-8 flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="w-[260px] shrink-0">
            <div className="dt-skeleton dt-aspect-video w-full rounded-xl" />
            <div className="dt-skeleton mt-3 h-3.5 w-4/5 rounded" />
            <div className="dt-skeleton mt-2 h-3 w-1/3 rounded" />
          </div>
        ))}
      </div>
      <TableSkeleton rows={8} label="Loading watch history" />
    </div>
  );
}
