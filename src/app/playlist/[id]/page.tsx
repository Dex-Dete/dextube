import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/ui";
import { PlaylistIcon } from "@/components/icons";
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
      <PageHeader
        eyebrow={playlist.isSystem ? "Built-in playlist" : "Playlist"}
        title={playlist.title}
        description={playlist.description || undefined}
        actions={
          items.length > 0 && items[0] ? (
            <Link
              href={items[0].isShort ? `/shorts/${items[0].id}` : `/watch/${items[0].id}`}
              className="dt-btn dt-btn-primary"
            >
              Play all
            </Link>
          ) : undefined
        }
        className="mb-6"
      >
        <p className="text-sm text-subtle">
          {formatCount(playlist.itemCount)} {playlist.itemCount === 1 ? "video" : "videos"}
          {!playlist.isSystem && ` · ${playlist.visibility.toLowerCase()}`}
          {` · updated ${formatRelativeTime(playlist.updatedAt)}`}
        </p>
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState
          icon={<PlaylistIcon size={20} />}
          title="This playlist is empty"
          description={
            playlist.isSystem
              ? "Videos you save appear here."
              : "Add videos with the Save button on any watch page."
          }
          actions={
            <Link href="/" className="dt-btn dt-btn-secondary">
              Browse videos
            </Link>
          }
        />
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
