import { PageHeaderSkeleton } from "@/components/ui";

/** Mirrors Trending's numbered list rows rather than a card grid. */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-5" />
      <div role="status" aria-busy="true" className="flex flex-col divide-y divide-line">
        <span className="sr-only">Loading trending videos</span>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-start gap-4 py-4 first:pt-0">
            <div className="dt-skeleton h-5 w-5 shrink-0 rounded" />
            <div className="dt-skeleton dt-aspect-video w-[168px] shrink-0 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
              <div className="dt-skeleton h-3.5 w-full rounded" />
              <div className="dt-skeleton h-3 w-1/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
