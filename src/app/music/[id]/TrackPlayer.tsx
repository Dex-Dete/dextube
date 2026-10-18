"use client";

/**
 * Play control for one track page.
 *
 * It drives the same persistent mini-player the library uses
 * (`useMusicPlayer()`), rather than creating a second `<audio>` element, so
 * playback keeps running when the viewer navigates away from this page.
 */
import { useMusicPlayer } from "@/components/music/MusicPlayerProvider";
import { PauseIcon, PlayIcon } from "@/components/icons";
import type { TrackDTO } from "@/lib/dto";

export function TrackPlayer({ track }: { track: TrackDTO }) {
  const player = useMusicPlayer();
  const isCurrent = player.current?.id === track.id;
  const isPlaying = isCurrent && player.isPlaying;

  return (
    <button
      type="button"
      className="dt-btn dt-btn-primary"
      onClick={() => (isCurrent ? player.toggle() : player.play([track], 0))}
      aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
    >
      {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
      <span>{isPlaying ? "Pause" : "Play"}</span>
    </button>
  );
}
