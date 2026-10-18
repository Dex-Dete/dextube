import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { EmptyState, PageHeader, PlaylistCard } from "@/components/ui";
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
      <PageHeader
        eyebrow="Library"
        title="Your library"
        description="Playlists, saved videos and the channels you follow."
        className="mb-6"
      />

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
          <EmptyState
            variant="inline"
            title="No playlists yet"
            description="You have not created any playlists yet. Use “New playlist” to start one."
          />
        ) : (
          <PlaylistRow playlists={custom} />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Subscriptions</h2>
        {subscriptions.items.length === 0 ? (
          <EmptyState
            variant="inline"
            title="Not following anyone yet"
            description="You are not following any channels yet."
            actions={
              <Link href="/results?q=" className="dt-btn dt-btn-secondary">
                Find channels
              </Link>
            }
          />
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
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {playlists.map((playlist) => (
        <PlaylistCard key={playlist.id} playlist={playlist} />
      ))}
    </ul>
  );
}
