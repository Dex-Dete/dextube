import { VideoCard, type VideoCardProps } from "@/components/video/VideoCard";

/** Responsive video grid. 1 column on phones, up to 4 on wide screens. */
export function VideoGrid({
  videos,
  emptyState,
}: {
  videos: VideoCardProps["video"][];
  emptyState?: React.ReactNode;
}) {
  if (videos.length === 0) {
    return <>{emptyState ?? <EmptyState />}</>;
  }
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {videos.map((video) => (
        <VideoCard key={video.id} video={video} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-base font-semibold">Nothing to watch yet</p>
      <p className="max-w-md text-sm text-muted">
        No published videos match this view. Once someone uploads and publishes a video it will appear here.
      </p>
    </div>
  );
}
