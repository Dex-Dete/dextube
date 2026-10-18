"use client";

/**
 * The DEX Music library list.
 *
 * A client component because it owns two pieces of interaction: starting
 * playback in the shared mini-player, and paging in more tracks from
 * `/api/music/tracks`. It reuses the same `TrackDTO` shape the server rendered,
 * so a page loaded from the API is identical to the first page.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import { PauseIcon, PlayIcon } from "@/components/icons";
import { formatDuration } from "@/lib/format";
import type { TrackDTO } from "@/lib/dto";

export interface MusicLibraryProps {
  initialTracks: TrackDTO[];
  initialNextOffset: number | null;
}

export function MusicLibrary({ initialTracks, initialNextOffset }: MusicLibraryProps) {
  const player = useMusicPlayer();
  const [tracks, setTracks] = useState<TrackDTO[]>(initialTracks);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/music/tracks?offset=${nextOffset}`);
      if (!response.ok) throw new Error("Could not load more tracks.");
      const data = (await response.json()) as { items: TrackDTO[]; nextOffset: number | null };
      setTracks((previous) => {
        const seen = new Set(previous.map((track) => track.id));
        return [...previous, ...data.items.filter((track) => !seen.has(track.id))];
      });
      setNextOffset(data.nextOffset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more tracks.");
    } finally {
      setLoading(false);
    }
  }, [nextOffset, loading]);

  const playFrom = useCallback(
    (trackId: string) => {
      const index = tracks.findIndex((track) => track.id === trackId);
      if (index >= 0) player.play(tracks, index);
    },
    [tracks, player],
  );

  return (
    <div>
      <ul className="flex flex-col gap-2">
        {tracks.map((track) => {
          const isCurrent = player.current?.id === track.id;
          const isPlaying = isCurrent && player.isPlaying;
          return (
            <li
              key={track.id}
              className="dt-card-hover flex flex-wrap items-center gap-3 rounded-xl border p-3"
              style={{ borderColor: "var(--dt-line)", background: "var(--dt-surface)" }}
            >
              <button
                type="button"
                onClick={() => (isPlaying ? player.toggle() : playFrom(track.id))}
                aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                className="dt-icon-btn shrink-0"
                style={{ background: "var(--dt-surface-2)" }}
              >
                {isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
              </button>

              <Link href={`/music/${track.id}`} className="min-w-0 flex-1">
                <p className="truncate font-semibold">{track.title}</p>
                <p className="truncate text-xs text-subtle">
                  {track.artist}
                  {track.album ? ` · ${track.album}` : ""}
                </p>
              </Link>

              <span className="hidden shrink-0 text-xs tabular-nums text-subtle sm:inline">
                {formatDuration(track.durationSec)}
              </span>

              <span className="hidden max-w-[140px] shrink-0 truncate text-xs text-subtle md:inline">
                {track.channel.name}
              </span>

              {track.rights ? (
                <span className="dt-badge shrink-0" title={`Licence: ${track.rights.license}`}>
                  {track.rights.license}
                </span>
              ) : (
                <span className="dt-badge dt-badge-warning shrink-0" title="No rights metadata is stored for this track">
                  Rights missing
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {error ? <p className="dt-alert dt-alert-error mt-3 text-xs">{error}</p> : null}

      {nextOffset !== null ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            className="dt-btn dt-btn-secondary"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
