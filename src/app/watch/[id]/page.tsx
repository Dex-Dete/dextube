import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getViewerContext } from "@/server/auth/session";
import { getVideoForWatch, getRelatedVideos } from "@/server/services/videos";
import { listComments } from "@/server/services/comments";
import { isAppError } from "@/lib/errors";
import { mediaUrl, streamUrl } from "@/lib/media-url";
import { Avatar } from "@/components/Avatar";
import { VideoCard } from "@/components/video/VideoCard";
import { VideoPlayer } from "@/components/watch/VideoPlayer";
import { ReactionBar } from "@/components/watch/ReactionBar";
import { SubscribeButton } from "@/components/watch/SubscribeButton";
import { DescriptionPanel } from "@/components/watch/DescriptionPanel";
import { CommentSection, type CommentDTO } from "@/components/watch/CommentSection";
import { formatCount, formatRelativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

interface WatchPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ comment?: string; t?: string }>;
}

/** Real titles/descriptions in metadata, so links and tabs are meaningful. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getViewerContext();
  try {
    const video = await getVideoForWatch(id, { userId: viewer.userId, channelId: viewer.channelId });
    const thumb = mediaUrl(video.thumbnailKey ?? video.posterKey);
    return {
      title: video.title,
      description: video.description.slice(0, 200) || `Watch ${video.title} on DEXTube.`,
      openGraph: {
        title: video.title,
        type: "video.other",
        ...(thumb ? { images: [{ url: thumb }] } : {}),
      },
    };
  } catch {
    return { title: "Video not found" };
  }
}

/**
 * Watch page.
 *
 * Server-rendered so the title, description, related videos and first page of
 * comments are all in the initial HTML (good for SEO, sharing and users with
 * JavaScript disabled). The player, reactions and comment composer are client
 * components layered on top.
 */
export default async function WatchPage({ params, searchParams }: WatchPageProps) {
  const { id } = await params;
  const { comment: highlightCommentId } = await searchParams;
  const viewer = await getViewerContext();

  let video;
  try {
    video = await getVideoForWatch(id, { userId: viewer.userId, channelId: viewer.channelId });
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  const [related, comments] = await Promise.all([
    getRelatedVideos(video.id, 12),
    video.isPlayable
      ? listComments(video.id, {
          sort: "top",
          offset: 0,
          limit: 20,
          viewer: { userId: viewer.userId, channelId: viewer.channelId, role: viewer.role },
        })
      : Promise.resolve({ items: [], total: 0, nextOffset: null }),
  ]);

  const playbackUrl = video.isPlayable ? streamUrl(video.playbackKey ?? null) : null;
  const downloadUrl = viewer.userId && video.viewer.isOwner ? streamUrl(video.originalKey ?? null, { download: true }) : null;

  /**
   * The quality menu is built from what is actually stored for this video.
   *
   * The primary playback file is offered first, labelled from its matching
   * `PROGRESSIVE` asset when one exists (the pipeline records the real rendition
   * height there) and falling back to the record's own dimensions. Any other
   * stored rendition follows, tallest first. A video with a single file
   * therefore gets no quality menu at all, because `VideoPlayer` only renders
   * the menu when there is more than one real source.
   */
  const renditionByKey = new Map(video.renditions.map((rendition) => [rendition.key, rendition]));
  const playerRenditions = video.isPlayable
    ? buildPlayerRenditions(playbackUrl, video.playbackKey, video.height, video.renditions, renditionByKey)
    : [];
  const nextVideo = related[0] ? { href: `/watch/${related[0].id}`, title: related[0].title } : null;
  const posterUrl = mediaUrl(video.posterKey ?? video.thumbnailKey);
  const canModerate = video.viewer.isOwner || viewer.role !== "USER";

  return (
    <div className="mx-auto grid max-w-[1750px] grid-cols-1 gap-6 px-4 py-5 sm:px-6 xl:grid-cols-[minmax(0,1fr)_402px]">
      <div className="min-w-0">
        <VideoPlayer
          videoId={video.id}
          src={playbackUrl}
          renditions={playerRenditions}
          posterUrl={posterUrl}
          startAtSeconds={video.viewer.progressSeconds}
          trackProgress={Boolean(viewer.userId)}
          title={video.title}
          nextVideo={nextVideo}
          captions={video.captions.map((caption) => ({
            label: caption.label,
            lang: caption.lang,
            src: `/api/media/${caption.key.split("/").map(encodeURIComponent).join("/")}`,
          }))}
          portrait={false}
        />

        <h1 className="mt-3 text-xl font-bold leading-snug">{video.title}</h1>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* The avatar is decorative: the link below carries the same
                destination and the channel name, so hiding this one from
                assistive technology avoids announcing an unlabelled link. */}
            <Link href={`/channel/${video.channel.handle}`} aria-hidden="true" tabIndex={-1}>
              <Avatar name={video.channel.name} seed={video.channel.id} src={mediaUrl(video.channel.avatarKey)} size={40} />
            </Link>
            <div className="min-w-0">
              <Link href={`/channel/${video.channel.handle}`} className="block truncate font-semibold hover:opacity-80">
                {video.channel.name}
              </Link>
              <p className="text-xs text-subtle">{formatCount(video.channel.subscriberCount)} subscribers</p>
            </div>
            <SubscribeButton
              channelHandle={video.channel.handle}
              initiallySubscribed={video.viewer.subscribed}
              subscriberCount={video.channel.subscriberCount}
              signedIn={Boolean(viewer.userId)}
              isOwner={video.viewer.isOwner}
            />
          </div>

          <ReactionBar
            videoId={video.id}
            title={video.title}
            initialReaction={video.viewer.reaction}
            likeCount={video.likeCount}
            dislikeCount={video.dislikeCount}
            initialWatchLater={video.viewer.watchLater}
            signedIn={Boolean(viewer.userId)}
            downloadUrl={downloadUrl}
          />
        </div>

        <div className="mt-3">
          <DescriptionPanel
            description={video.description}
            viewCount={video.viewCount}
            publishedAt={video.publishedAt}
            createdAt={video.createdAt}
            durationSec={video.durationSec}
            tags={video.tags}
            category={video.category}
            visibility={video.visibility}
            isOwner={video.viewer.isOwner}
            status={video.status}
            processingError={video.processingError}
          />
        </div>

        {video.isPlayable ? (
          <CommentSection
            videoId={video.id}
            initialComments={comments.items as unknown as CommentDTO[]}
            initialTotal={comments.total}
            initialNextOffset={comments.nextOffset}
            sort="top"
            signedIn={Boolean(viewer.userId)}
            canModerate={canModerate}
            commentsDisabled={!video.allowComments}
            highlightCommentId={highlightCommentId ?? null}
          />
        ) : (
          <p className="mt-6 text-sm text-subtle">Comments will be available once processing finishes.</p>
        )}
      </div>

      {/* ------------------------------------------------------ related rail */}
      <aside className="min-w-0">
        {video.tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {video.tags.slice(0, 6).map((tag) => (
              <Link
                key={tag}
                href={`/results?q=${encodeURIComponent(tag)}`}
                className="rounded-full px-3 py-1 text-xs font-medium"
                style={{ background: "var(--dt-surface-2)" }}
              >
                #{tag}
              </Link>
            ))}
          </div>
        )}

        <h2 className="mb-3 text-sm font-bold">Up next</h2>
        {related.length === 0 ? (
          <p className="text-sm text-subtle">
            {video.viewer.isOwner && video.status !== "READY"
              ? "Related videos appear once this one is published."
              : "No related videos yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {related.map((item) => (
              <div key={item.id} className="relative">
                <VideoCard video={item} variant="list" />
                <span className="pointer-events-none absolute right-2 top-2 text-[11px] text-subtle">
                  {item.publishedAt ? formatRelativeTime(item.publishedAt) : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

interface RenditionRow {
  key: string;
  label: string;
  height: number | null;
}

interface PlayerRenditionProp {
  label: string;
  src: string;
  height: number | null;
}

/**
 * Assemble the player's rendition list from stored assets only.
 *
 * The primary playback file is included first (so the default source always
 * appears in the menu labelled correctly), then every other stored rendition,
 * de-duplicated by storage key and sorted tallest first. Renditions whose URL
 * cannot be resolved are dropped rather than offered as a broken option.
 */
function buildPlayerRenditions(
  playbackUrl: string | null,
  playbackKey: string | null,
  videoHeight: number | null,
  renditions: RenditionRow[],
  byKey: Map<string, RenditionRow>,
): PlayerRenditionProp[] {
  const out: PlayerRenditionProp[] = [];
  const seen = new Set<string>();

  if (playbackUrl && playbackKey) {
    const match = byKey.get(playbackKey);
    out.push({
      src: playbackUrl,
      label: match?.label ?? (videoHeight ? `${videoHeight}p` : "Source"),
      height: match?.height ?? videoHeight,
    });
    seen.add(playbackKey);
  }

  for (const rendition of renditions) {
    if (seen.has(rendition.key)) continue;
    const url = streamUrl(rendition.key);
    if (!url) continue;
    seen.add(rendition.key);
    out.push({ src: url, label: rendition.label, height: rendition.height });
  }

  return out.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}
