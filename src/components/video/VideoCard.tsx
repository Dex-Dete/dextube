import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { VideoCardMenu } from "@/components/video/VideoCardMenu";
import { mediaUrl } from "@/lib/media-url";
import { countLabel, formatDuration, formatRelativeTime } from "@/lib/format";
import { LockIcon, ShortsIcon } from "@/components/icons";

export interface VideoCardProps {
  video: {
    id: string;
    title: string;
    isShort?: boolean;
    durationSec: number;
    thumbnailKey: string | null;
    posterKey?: string | null;
    publishedAt: string | null;
    viewCount: number;
    visibility?: "PRIVATE" | "UNLISTED" | "PUBLIC";
    status?: string;
    channel: { id: string; handle: string; name: string; avatarKey: string | null };
  };
  /** Compact list layout for sidebars/related videos. */
  variant?: "grid" | "list";
  /** Hide the channel line (used inside a channel's own grid). */
  hideChannel?: boolean;
  /** Optional badge row (Studio uses it to show status). */
  badge?: React.ReactNode;
  /**
   * Show the "not interested" / "don't recommend this channel" control.
   *
   * Only the ranked home feed turns this on: those are the cards whose position
   * a preference can actually change. It is off everywhere else so a dismissal
   * is never offered where it would do nothing.
   */
  recommendationControls?: boolean;
}

/**
 * A single video card. Server-renderable, so feeds arrive as HTML with no
 * client JavaScript required; the thumbnail falls back to a generated gradient
 * when the video has no thumbnail yet.
 */
export function VideoCard({
  video,
  variant = "grid",
  hideChannel = false,
  badge,
  recommendationControls = false,
}: VideoCardProps) {
  const href = video.isShort ? `/shorts/${video.id}` : `/watch/${video.id}`;
  const thumb = mediaUrl(video.thumbnailKey) ?? mediaUrl(video.posterKey ?? null);
  const menu = recommendationControls ? (
    <VideoCardMenu
      videoId={video.id}
      channelId={video.channel.id}
      channelName={video.channel.name}
      align={variant === "grid" ? "top" : "inline"}
    />
  ) : null;

  if (variant === "list") {
    return (
      <article className="group flex gap-3">
        <Link href={href} className="relative block w-[168px] shrink-0 overflow-hidden rounded-lg" style={{ background: "var(--dt-surface-2)" }}>
          <Thumbnail video={video} thumb={thumb} />
        </Link>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
            <Link href={href}>{video.title}</Link>
          </h3>
          {!hideChannel && (
            <Link href={`/channel/${video.channel.handle}`} className="mt-1 block text-xs text-muted hover:text-fg">
              {video.channel.name}
            </Link>
          )}
          <p className="mt-0.5 text-xs text-subtle">
            {countLabel(video.viewCount, "view")}
            {video.publishedAt ? ` · ${formatRelativeTime(video.publishedAt)}` : ""}
          </p>
          {badge}
        </div>
        {menu}
      </article>
    );
  }

  return (
    <article className="dt-card-hover group flex flex-col gap-2">
      <Link
        href={href}
        className="relative block overflow-hidden rounded-xl dt-aspect-video"
        style={{ background: "var(--dt-surface-2)" }}
        aria-label={video.title}
      >
        <Thumbnail video={video} thumb={thumb} />
      </Link>

      <div className="flex gap-2.5">
        {!hideChannel && (
          <Link href={`/channel/${video.channel.handle}`} aria-label={`${video.channel.name} channel`}>
            <Avatar name={video.channel.name} seed={video.channel.id} src={mediaUrl(video.channel.avatarKey)} size={34} />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug">
            <Link href={href}>{video.title}</Link>
          </h3>
          {!hideChannel && (
            <Link
              href={`/channel/${video.channel.handle}`}
              className="mt-0.5 block truncate text-[13px] text-muted hover:text-fg"
            >
              {video.channel.name}
            </Link>
          )}
          <p className="text-[13px] text-subtle">
            {countLabel(video.viewCount, "view")}
            {video.publishedAt ? ` · ${formatRelativeTime(video.publishedAt)}` : ""}
          </p>
          {badge}
        </div>
        {menu}
      </div>
    </article>
  );
}

function Thumbnail({ video, thumb }: { video: VideoCardProps["video"]; thumb: string | null }) {
  return (
    <>
      {thumb ? (
        <img
          src={thumb}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-subtle">
          <ShortsIcon size={28} />
        </div>
      )}
      <span
        className="pointer-events-none absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
        style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
      >
        {formatDuration(video.durationSec)}
      </span>
      {video.isShort && (
        <span
          className="pointer-events-none absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold"
          style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
        >
          Short
        </span>
      )}
      {video.visibility && video.visibility !== "PUBLIC" && (
        <span
          className="pointer-events-none absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold"
          style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
        >
          <LockIcon size={11} /> {video.visibility === "PRIVATE" ? "Private" : "Unlisted"}
        </span>
      )}
    </>
  );
}
