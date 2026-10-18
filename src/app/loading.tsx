import { FeedSkeleton, PageHeaderSkeleton } from "@/components/ui";

/**
 * Root loading fallback.
 *
 * The majority of root-level routes are feeds, so this mirrors the shared page
 * frame (header + responsive card grid) rather than a centred spinner, keeping
 * the shell from jumping while the segment streams in. Routes with a more
 * specific shape (`/trending`, `/results`, `/channel/*`, `/history`,
 * `/playlists`) provide their own closer-matching `loading.tsx`.
 */
export default function Loading() {
  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeaderSkeleton className="mb-5" />
      <FeedSkeleton count={12} columns={4} label="Loading page" />
    </div>
  );
}
