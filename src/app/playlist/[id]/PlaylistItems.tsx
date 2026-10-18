"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api-client";
import { mediaUrl } from "@/lib/media-url";
import { countLabel, formatDuration, formatRelativeTime } from "@/lib/format";
import { TrashIcon } from "@/components/icons";

export interface PlaylistItemDTO {
  id: string;
  title: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  publishedAt: string | null;
  viewCount: number;
  channel: { id: string; handle: string; name: string; avatarKey: string | null };
}

/**
 * Playlist contents with on-demand paging and (for the owner) item removal.
 *
 * Removal is a real DELETE; the row is removed optimistically and restored if
 * the server refuses, so the list never silently diverges from the database.
 */
export function PlaylistItems({
  playlistId,
  initialItems,
  initialNextOffset,
  canEdit,
  isSystem,
}: {
  playlistId: string;
  initialItems: PlaylistItemDTO[];
  initialNextOffset: number | null;
  canEdit: boolean;
  isSystem: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [nextOffset, setNextOffset] = useState(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: PlaylistItemDTO[]; nextOffset: number | null }>(
        `/api/playlists/${playlistId}?offset=${nextOffset}&limit=50`,
      );
      setItems((current) => {
        const seen = new Set(current.map((v) => v.id));
        return [...current, ...data.items.filter((v) => !seen.has(v.id))];
      });
      setNextOffset(data.nextOffset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more videos.");
    } finally {
      setLoading(false);
    }
  }, [loading, nextOffset, playlistId]);

  async function remove(video: PlaylistItemDTO) {
    if (!window.confirm(`Remove “${video.title}” from this playlist?`)) return;
    const snapshot = items;
    setRemoving(video.id);
    setItems((current) => current.filter((v) => v.id !== video.id));
    try {
      await api.del(`/api/playlists/${playlistId}/items?videoId=${encodeURIComponent(video.id)}`);
    } catch (e) {
      setItems(snapshot);
      setError(e instanceof Error ? e.message : "Could not remove that video.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {items.map((video, index) => {
          const href = video.isShort ? `/shorts/${video.id}` : `/watch/${video.id}`;
          return (
            <li key={video.id} className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-center text-sm text-subtle tabular-nums">{index + 1}</span>
              <Link href={href} className="relative block w-[140px] shrink-0 overflow-hidden rounded-lg dt-aspect-video" style={{ background: "var(--dt-surface-2)" }}>
                {video.thumbnailKey && (
                  <img src={mediaUrl(video.thumbnailKey)!} alt="" loading="lazy" className="h-full w-full object-cover" />
                )}
                <span
                  className="absolute bottom-1 right-1 rounded px-1 py-0.5 text-[11px] font-semibold tabular-nums"
                  style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
                >
                  {formatDuration(video.durationSec)}
                </span>
              </Link>
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
                  <Link href={href}>{video.title}</Link>
                </h3>
                <Link
                  href={`/channel/${video.channel.handle}`}
                  className="mt-1 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
                >
                  <Avatar name={video.channel.name} seed={video.channel.id} src={mediaUrl(video.channel.avatarKey)} size={20} />
                  {video.channel.name}
                </Link>
                <p className="mt-0.5 text-xs text-subtle">
                  {countLabel(video.viewCount, "view")}
                  {video.publishedAt ? ` · ${formatRelativeTime(video.publishedAt)}` : ""}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void remove(video)}
                  disabled={removing === video.id}
                  aria-label={`Remove ${video.title}`}
                  className="dt-icon-btn shrink-0"
                  title={isSystem ? "Remove from this list" : "Remove from playlist"}
                >
                  <TrashIcon size={17} />
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-8 flex justify-center">
        {loading && <p className="text-sm text-subtle">Loading more…</p>}
        {!loading && nextOffset !== null && (
          <button type="button" className="dt-btn dt-btn-secondary" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
        {!loading && nextOffset === null && items.length > 0 && (
          <p className="text-xs text-subtle">That is the whole playlist.</p>
        )}
      </div>
    </div>
  );
}
