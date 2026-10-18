import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser, getViewerContext } from "@/server/auth/session";
import { getPlaylist, isSystemKind, systemPlaylistId } from "@/server/services/playlists";
import { isAppError } from "@/lib/errors";
import { formatCount, formatRelativeTime } from "@/lib/format";
import { PlaylistItems, type PlaylistItemDTO } from "./PlaylistItems";

export const dynamic = "force-dynamic";

interface PlaylistPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Maps a human-friendly URL slug onto a system playlist kind.
 * The sidebar links to `/playlist/watch-later` and `/playlist/liked`, while the
 * database stores the kinds `watch_later` and `liked_videos`.
 */
const SLUG_TO_KIND: Record<string, "watch_later" | "liked_videos"> = {
  "watch-later": "watch_later",
  liked: "liked_videos",
};

export async function generateMetadata({ params }: PlaylistPageProps): Promise<Metadata> {
  const { id } = await params;
  const kind = SLUG_TO_KIND[id];
  if (kind === "watch_later") return { title: "Watch later" };
  if (kind === "liked_videos") return { title: "Liked videos" };

  const viewer = await getViewerContext();
  try {
    const page = await getPlaylist(id, viewer, { limit: 1 });
    return { title: page.playlist.title };
  } catch {
    return { title: "Playlist" };
  }
}

export default async function PlaylistPage({ params }: PlaylistPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  const viewer = await getViewerContext();

  const kind = SLUG_TO_KIND[id];
  let playlistId = id;
  if (kind) {
    if (!user) notFound();
    playlistId = await systemPlaylistId(user.id, kind);
  } else if (isSystemKind(id)) {
    // Direct kind ids (watch_later / liked_videos) are not user-facing routes.
    notFound();
  }

  let page;
  try {
    page = await getPlaylist(playlistId, viewer, { offset: 0, limit: 50 });
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  const { playlist, items, nextOffset } = page;

  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
            {playlist.isSystem ? "Built-in playlist" : "Playlist"}
          </p>
          <h1 className="mt-0.5 text-2xl font-bold">{playlist.title}</h1>
          {playlist.description && <p className="mt-1 max-w-2xl text-sm text-muted">{playlist.description}</p>}
          <p className="mt-1 text-sm text-subtle">
            {formatCount(playlist.itemCount)} {playlist.itemCount === 1 ? "video" : "videos"}
            {!playlist.isSystem && ` · ${playlist.visibility.toLowerCase()}`}
            {` · updated ${formatRelativeTime(playlist.updatedAt)}`}
          </p>
        </div>
        {items.length > 0 && items[0] && (
          <Link href={items[0].isShort ? `/shorts/${items[0].id}` : `/watch/${items[0].id}`} className="dt-btn dt-btn-primary">
            Play all
          </Link>
        )}
      </div>

      {items.length === 0 ? (
        <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
          <h2 className="text-lg font-bold">This playlist is empty</h2>
          <p className="max-w-md text-sm text-muted">
            {playlist.isSystem
              ? "Videos you save appear here."
              : "Add videos with the Save button on any watch page."}
          </p>
          <Link href="/" className="dt-btn dt-btn-secondary">
            Browse videos
          </Link>
        </div>
      ) : (
        <PlaylistItems
          playlistId={playlist.id}
          initialItems={items as unknown as PlaylistItemDTO[]}
          initialNextOffset={nextOffset}
          canEdit={playlist.isOwner}
          isSystem={playlist.isSystem}
        />
      )}
    </div>
  );
}
