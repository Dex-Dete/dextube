import { FeedSkeleton, PageHeaderSkeleton } from "@/components/ui";

/** Mirrors a channel page: banner, identity header, tab strip, then content. */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="dt-skeleton mb-4 h-32 w-full rounded-2xl sm:h-44" />
      <div className="flex flex-wrap items-start gap-4">
        <div className="dt-skeleton h-24 w-24 shrink-0 rounded-full" />
        <PageHeaderSkeleton className="min-w-0 flex-1" />
      </div>
      <div aria-hidden="true" className="mt-6 flex gap-1 border-b border-line">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="dt-skeleton h-8 w-20 rounded-t-md" />
        ))}
      </div>
      <div className="mt-6">
        <FeedSkeleton count={12} columns={4} label="Loading channel videos" />
      </div>
    </div>
  );
}
