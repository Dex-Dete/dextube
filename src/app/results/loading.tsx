import { FeedSkeleton, PageHeaderSkeleton } from "@/components/ui";

/** Mirrors Search's header, filter chips and result grid. */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-5" />
      <div aria-hidden="true" className="mb-5 flex flex-wrap gap-2">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="dt-skeleton h-8 w-20 rounded-full" />
        ))}
      </div>
      <FeedSkeleton count={9} columns={3} label="Loading search results" />
    </div>
  );
}
