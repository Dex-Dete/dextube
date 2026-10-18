import { VideoCard, type VideoCardProps } from "@/components/video/VideoCard";
import { EmptyState } from "@/components/ui";

/** Responsive video grid. 1 column on phones, up to 4 on wide screens. */
export function VideoGrid({
  videos,
  emptyState,
}: {
  videos: VideoCardProps["video"][];
  emptyState?: React.ReactNode;
}) {
  if (videos.length === 0) {
    return (
      <>
        {emptyState ?? (
          <EmptyState
            title="Nothing to watch yet"
            description="No published videos match this view. Once someone uploads and publishes a video it will appear here."
          />
        )}
      </>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {videos.map((video) => (
        <VideoCard key={video.id} video={video} />
      ))}
    </div>
  );
}
