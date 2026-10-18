import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { getCurrentUser } from "@/server/auth/session";
import { listOwnPlaylists } from "@/server/services/playlists";
import { listSubscriptions } from "@/server/services/channels";
import { mediaUrl } from "@/lib/media-url";
import { formatCount } from "@/lib/format";
import { CreatePlaylistForm } from "./CreatePlaylistForm";

export const metadata: Metadata = { title: "Playlists" };
export const dynamic = "force-dynamic";

/**
 * The viewer's library: their own playlists (including the built-in Watch later
 * and Liked videos) plus the channels they follow, so this doubles as a single
 * "your stuff" page rather than duplicating the sidebar.
 */
export default async function PlaylistsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/playlists");
  if (!user.channel) redirect("/studio/channel");

  const [playlists, subscriptions] = await Promise.all([
    listOwnPlaylists(user.id),
    listSubscriptions(user.id, undefined, 24),
  ]);

  const system = playlists.filter((p) => p.isSystem);
  const custom = playlists.filter((p) => !p.isSystem);

  return (
    <div className="px-4 py-5 sm:px-6">
      <h1 className="mb-1 text-xl font-bold">Your library</h1>
      <p className="mb-6 text-sm text-muted">Playlists, saved videos and the channels you follow.</p>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Built-in</h2>
        <PlaylistRow playlists={system} />
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-subtle">Your playlists</h2>
          <CreatePlaylistForm />
        </div>
        {custom.length === 0 ? (
          <p className="dt-card px-4 py-8 text-center text-sm text-muted">
            You have not created any playlists yet. Use “New playlist” to start one.
          </p>
        ) : (
          <PlaylistRow playlists={custom} />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Subscriptions</h2>
        {subscriptions.items.length === 0 ? (
          <p className="dt-card px-4 py-8 text-center text-sm text-muted">
            You are not following any channels yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subscriptions.items.map(({ channel }) => (
              <li key={channel.id}>
                <Link
                  href={`/channel/${channel.handle}`}
                  className="dt-card-hover flex items-center gap-3 rounded-xl p-3"
                >
                  <Avatar name={channel.name} seed={channel.id} src={mediaUrl(channel.avatarKey)} size={44} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{channel.name}</span>
                    <span className="block truncate text-xs text-subtle">
                      {formatCount(channel.subscriberCount)}{" "}
                      {channel.subscriberCount === 1 ? "subscriber" : "subscribers"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlaylistRow({
  playlists,
}: {
  playlists: Array<{
    id: string;
    title: string;
    itemCount: number;
    coverKey: string | null;
    isSystem: boolean;
    systemKind: string | null;
  }>;
}) {
  const hrefFor = (playlist: { id: string; systemKind: string | null }) =>
    playlist.systemKind === "watch_later"
      ? "/playlist/watch-later"
      : playlist.systemKind === "liked_videos"
        ? "/playlist/liked"
        : `/playlist/${playlist.id}`;

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {playlists.map((playlist) => (
        <li key={playlist.id} className="dt-card-hover overflow-hidden rounded-xl">
          <Link href={hrefFor(playlist)} className="block">
            <div className="dt-aspect-video relative" style={{ background: "var(--dt-surface-2)" }}>
              {playlist.coverKey ? (
                <img src={mediaUrl(playlist.coverKey)!} alt="" className="h-full w-full object-cover" />
              ) : null}
              <span
                className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
              >
                {playlist.itemCount} {playlist.itemCount === 1 ? "video" : "videos"}
              </span>
            </div>
            <div className="p-3">
              <p className="truncate font-semibold">{playlist.title}</p>
              <p className="text-xs text-subtle">{playlist.isSystem ? "Built-in playlist" : "Playlist"}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
