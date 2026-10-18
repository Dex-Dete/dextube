import { FeedSkeleton, PageHeaderSkeleton } from "@/components/ui";

/** Mirrors the Library page: header, section heading, then playlist tiles. */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-6" />
      <div className="dt-skeleton mb-3 h-3 w-24 rounded" />
      <FeedSkeleton count={4} columns={4} label="Loading playlists" />
    </div>
  );
}
