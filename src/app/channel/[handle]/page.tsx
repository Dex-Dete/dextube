import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { SubscribeButton } from "@/components/watch/SubscribeButton";
import { getCurrentUser } from "@/server/auth/session";
import { getChannelProfile } from "@/server/services/channels";
import { listPublicPlaylists } from "@/server/services/playlists";
import { getChannelVideos } from "@/server/services/videos";
import { isAppError } from "@/lib/errors";
import { mediaUrl } from "@/lib/media-url";
import { formatCount, formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ChannelPageProps {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ tab?: string }>;
}

const TABS = ["videos", "shorts", "playlists", "about"] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  try {
    const channel = await getChannelProfile(handle, null);
    return {
      title: channel.name,
      description: channel.description?.slice(0, 200) || `${channel.name} on DEXTube.`,
      openGraph: {
        title: channel.name,
        type: "profile",
        ...(channel.avatarKey ? { images: [{ url: mediaUrl(channel.avatarKey)! }] } : {}),
      },
    };
  } catch {
    return { title: "Channel not found" };
  }
}

/**
 * Public channel page.
 *
 * Banner, identity, a real subscribe control, and tabbed content. The viewer's
 * own unpublished videos appear only when they are the owner (the service
 * enforces that), so a creator can preview their channel as visitors would.
 */
export default async function ChannelPage({ params, searchParams }: ChannelPageProps) {
  const { handle } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "videos";

  const user = await getCurrentUser();
  let channel;
  try {
    channel = await getChannelProfile(handle, user?.id ?? null);
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  const [videos, playlists] = await Promise.all([
    tab === "videos" || tab === "shorts"
      ? getChannelVideos({
          channelId: channel.id,
          viewerChannelId: user?.channel?.id ?? null,
          tab: tab === "shorts" ? "shorts" : "videos",
          includeOwnUnpublished: channel.isOwner,
          limit: 24,
        })
      : Promise.resolve({ items: [], nextCursor: null }),
    tab === "playlists"
      ? listPublicPlaylists(channel.handle, user?.channel?.id ?? null)
      : Promise.resolve({ playlists: [], channelId: channel.id }),
  ]);

  return (
    <div className="px-4 py-5 sm:px-6">
      {/* ---------------------------------------------------------- banner */}
      <div
        className="relative mb-4 h-32 w-full overflow-hidden rounded-2xl sm:h-44"
        style={{ background: "var(--dt-surface-2)" }}
      >
        {channel.bannerKey ? (
          <img src={mediaUrl(channel.bannerKey)!} alt="" className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{ background: "linear-gradient(120deg, var(--dt-brand), var(--dt-accent))", opacity: 0.25 }}
          />
        )}
      </div>

      {/* -------------------------------------------------------- identity */}
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={channel.name} seed={channel.id} src={mediaUrl(channel.avatarKey)} size={96} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold leading-tight">{channel.name}</h1>
          <p className="mt-1 text-sm text-muted">
            @{channel.handle} · {formatCount(channel.subscriberCount)}{" "}
            {channel.subscriberCount === 1 ? "subscriber" : "subscribers"} · {formatCount(channel.videoCount)}{" "}
            {channel.videoCount === 1 ? "video" : "videos"}
          </p>
          {channel.description && <p className="mt-2 max-w-3xl text-sm text-muted">{channel.description}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <SubscribeButton
              channelHandle={channel.handle}
              initiallySubscribed={channel.viewerSubscribed}
              subscriberCount={channel.subscriberCount}
              signedIn={Boolean(user)}
              isOwner={channel.isOwner}
            />
            {channel.isOwner && (
              <Link href="/studio/channel" className="dt-btn dt-btn-secondary">
                Edit channel
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- tabs */}
      <nav className="mt-6 flex gap-1 border-b border-line" aria-label="Channel sections">
        {TABS.map((name) => {
          const count = name === "shorts" ? channel.shortCount : undefined;
          const active = tab === name;
          return (
            <Link
              key={name}
              href={`/channel/${channel.handle}?tab=${name}`}
              aria-current={active ? "page" : undefined}
              className="rounded-t-md px-4 py-2 text-sm font-semibold capitalize hover:bg-surface-2"
              style={
                active
                  ? { borderBottom: "2px solid var(--dt-fg)", marginBottom: -1 }
                  : { color: "var(--dt-fg-subtle)" }
              }
            >
              {name}
              {count !== undefined && count > 0 ? ` · ${formatCount(count)}` : ""}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">
        {tab === "about" ? (
          <ChannelAbout
            handle={channel.handle}
            description={channel.description}
            createdAt={channel.createdAt}
            subscriberCount={channel.subscriberCount}
            videoCount={channel.videoCount}
            shortCount={channel.shortCount}
          />
        ) : tab === "playlists" ? (
          playlists.playlists.length === 0 ? (
            <EmptyPanel title="No public playlists" body="This channel has not published any playlists yet." />
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {playlists.playlists.map((playlist) => (
                <li key={playlist.id} className="dt-card-hover overflow-hidden rounded-xl">
                  <Link href={`/playlist/${playlist.id}`} className="block">
                    <div className="dt-aspect-video relative" style={{ background: "var(--dt-surface-2)" }}>
                      {playlist.coverKey && (
                        <img src={mediaUrl(playlist.coverKey)!} alt="" className="h-full w-full object-cover" />
                      )}
                      <span
                        className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                        style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
                      >
                        {playlist.itemCount} {playlist.itemCount === 1 ? "video" : "videos"}
                      </span>
                    </div>
                    <div className="p-3">
                      <p className="truncate font-semibold">{playlist.title}</p>
                      {playlist.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{playlist.description}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : (
          <FeedGrid
            initialItems={videos.items}
            initialCursor={videos.nextCursor}
            mode="cursor"
            endpoint={`/api/channels/${encodeURIComponent(channel.handle)}/videos?tab=${tab}`}
            limit={24}
            columns={4}
            emptyState={
              <EmptyPanel
                title={tab === "shorts" ? "No Shorts yet" : "No videos yet"}
                body={
                  channel.isOwner
                    ? "Upload something to see it here."
                    : "This channel has not published anything in this section yet."
                }
              />
            }
          />
        )}
      </div>
    </div>
  );
}

function ChannelAbout({
  handle,
  description,
  createdAt,
  subscriberCount,
  videoCount,
  shortCount,
}: {
  handle: string;
  description: string | null;
  createdAt: Date;
  subscriberCount: number;
  videoCount: number;
  shortCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="dt-card p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-subtle">About</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-muted">
          {description || "This channel has not added a description yet."}
        </p>
      </div>
      <dl className="dt-card p-5 text-sm">
        <div className="flex justify-between py-1.5">
          <dt className="text-muted">Handle</dt>
          <dd className="font-medium">@{handle}</dd>
        </div>
        <div className="flex justify-between py-1.5">
          <dt className="text-muted">Joined</dt>
          <dd className="font-medium">{formatDate(createdAt)}</dd>
        </div>
        <div className="flex justify-between py-1.5">
          <dt className="text-muted">Subscribers</dt>
          <dd className="font-medium tabular-nums">{formatCount(subscriberCount)}</dd>
        </div>
        <div className="flex justify-between py-1.5">
          <dt className="text-muted">Videos</dt>
          <dd className="font-medium tabular-nums">{formatCount(videoCount)}</dd>
        </div>
        <div className="flex justify-between py-1.5">
          <dt className="text-muted">Shorts</dt>
          <dd className="font-medium tabular-nums">{formatCount(shortCount)}</dd>
        </div>
      </dl>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="max-w-md text-sm text-muted">{body}</p>
    </div>
  );
}
