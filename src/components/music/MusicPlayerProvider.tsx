"use client";

/**
 * The DEX Music mini-player.
 *
 * This provider owns **one** `<audio>` element for the whole application. It is
 * mounted by the root layout, and a layout is not re-mounted on navigation, so
 * playback continues while the viewer browses other pages — the element is
 * never torn down and recreated.
 *
 * It is deliberately small: a queue, a play/pause, previous/next, a seek bar and
 * a close control. It exposes `useMusicPlayer()` so a track page can start
 * playback through the same element rather than creating a second player.
 *
 * Accessibility and motion:
 *   * every control is a real `<button>` or `<input type="range">`, so it is
 *     focusable and keyboard-operable without custom key handling;
 *   * labels are explicit `aria-label`s and the region is named;
 *   * no state change relies on animation, and the bar opts out of transitions
 *     under `prefers-reduced-motion` (`motion-reduce:transition-none`), on top
 *     of the global reduced-motion rule in `globals.css`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { mediaUrl } from "@/lib/media-url";
import { formatDuration } from "@/lib/format";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
} from "@/components/icons";
import type { TrackDTO } from "@/lib/dto";

export interface MusicPlayerApi {
  /** The track currently loaded in the player, if any. */
  current: TrackDTO | null;
  queue: TrackDTO[];
  index: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  /** Starts a queue (usually "play this track within the list I can see"). */
  play: (queue: TrackDTO[], index?: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
}

const MusicPlayerContext = createContext<MusicPlayerApi | null>(null);

export function useMusicPlayer(): MusicPlayerApi {
  const value = useContext(MusicPlayerContext);
  if (!value) throw new Error("useMusicPlayer must be used inside <MusicPlayerProvider>.");
  return value;
}

export function MusicPlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<TrackDTO[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const current = queue[index] ?? null;

  /** Points the element at a track (or clears it) without starting playback. */
  const loadTrack = useCallback((track: TrackDTO | null) => {
    const audio = audioRef.current;
    if (!audio) return;
    const src = track ? mediaUrl(track.audioKey) : null;
    if (!src) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      return;
    }
    audio.src = src;
    audio.load();
  }, []);

  const startPlayback = useCallback(() => {
    // `play()` can reject (blocked autoplay, missing file); a rejected promise
    // must not become an unhandled rejection. The `error` event reports the
    // real failure.
    void audioRef.current?.play().catch(() => {});
  }, []);

  const play = useCallback(
    (nextQueue: TrackDTO[], at = 0) => {
      if (nextQueue.length === 0) return;
      const clamped = Math.max(0, Math.min(at, nextQueue.length - 1));
      const track = nextQueue[clamped] ?? null;
      setError(null);
      setQueue(nextQueue);
      setIndex(clamped);
      setCurrentTime(0);
      setDuration(track?.durationSec ?? 0);
      loadTrack(track);
      startPlayback();
    },
    [loadTrack, startPlayback],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) startPlayback();
    else audio.pause();
  }, [current, startPlayback]);

  const goTo = useCallback(
    (target: number) => {
      const track = queue[target];
      if (!track) return;
      setError(null);
      setIndex(target);
      setCurrentTime(0);
      setDuration(track.durationSec);
      loadTrack(track);
      startPlayback();
    },
    [queue, loadTrack, startPlayback],
  );

  const next = useCallback(() => {
    if (index < queue.length - 1) goTo(index + 1);
  }, [index, queue.length, goTo]);

  const previous = useCallback(() => {
    // Standard player behaviour: restart the current track unless we are near
    // its start, in which case step back.
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    if (index > 0) goTo(index - 1);
    else if (audio) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }
  }, [index, goTo]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    loadTrack(null);
    setQueue([]);
    setIndex(0);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError(null);
  }, [loadTrack]);

  const handleEnded = useCallback(() => {
    if (index < queue.length - 1) goTo(index + 1);
    else setIsPlaying(false);
  }, [index, queue.length, goTo]);

  // Reserve room at the end of the document for the fixed bar, so the last row
  // of content is never hidden behind it. This is a DOM side effect, not a
  // React state sync.
  const active = current !== null;
  useEffect(() => {
    if (!active) return;
    const previousPadding = document.body.style.paddingBottom;
    document.body.style.paddingBottom = "84px";
    return () => {
      document.body.style.paddingBottom = previousPadding;
    };
  }, [active]);

  const value = useMemo<MusicPlayerApi>(
    () => ({ current, queue, index, isPlaying, currentTime, duration, play, toggle, next, previous, seek, stop }),
    [current, queue, index, isPlaying, currentTime, duration, play, toggle, next, previous, seek, stop],
  );

  const totalSeconds = Math.max(1, Math.floor(duration || current?.durationSec || 0));
  const positionSeconds = Math.min(Math.floor(currentTime), totalSeconds);

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}

      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || current?.durationSec || 0)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration || current?.durationSec || 0)}
        onError={() => {
          setIsPlaying(false);
          setError("This track could not be played.");
        }}
      />

      {current ? (
        <div
          role="region"
          aria-label="Music mini-player"
          className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface shadow-dt-lg transition-[opacity] duration-150 motion-reduce:transition-none"
        >
          <input
            type="range"
            min={0}
            max={totalSeconds}
            step={1}
            value={positionSeconds}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Seek"
            className="block h-1.5 w-full cursor-pointer"
            style={{ accentColor: "var(--dt-brand)" }}
          />
          <div className="mx-auto flex max-w-[1400px] items-center gap-1.5 px-3 py-2 sm:gap-3">
            <span
              aria-hidden="true"
              className="hidden h-9 w-9 shrink-0 place-items-center rounded-md sm:grid"
              style={{ background: "var(--dt-surface-2)", color: "var(--dt-brand)" }}
            >
              <MusicIcon size={18} />
            </span>

            <div className="min-w-0 flex-1">
              <Link href={`/music/${current.id}`} className="block truncate text-sm font-semibold hover:underline">
                {current.title}
              </Link>
              <p className="truncate text-xs text-subtle">
                {current.artist} · {current.channel.name}
                {error ? <span className="text-danger"> · {error}</span> : null}
              </p>
            </div>

            <span className="hidden shrink-0 text-xs tabular-nums text-subtle sm:inline">
              {formatDuration(positionSeconds)} / {formatDuration(totalSeconds)}
            </span>

            <button
              type="button"
              className="dt-icon-btn"
              onClick={previous}
              aria-label="Previous track"
              title="Previous"
            >
              <ChevronLeftIcon size={20} />
            </button>
            <button
              type="button"
              className="dt-icon-btn"
              onClick={toggle}
              aria-label={isPlaying ? "Pause" : "Play"}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
            </button>
            <button
              type="button"
              className="dt-icon-btn disabled:opacity-40"
              onClick={next}
              aria-label="Next track"
              title="Next"
              disabled={index >= queue.length - 1}
            >
              <ChevronRightIcon size={20} />
            </button>
            <button type="button" className="dt-icon-btn" onClick={stop} aria-label="Close player" title="Close">
              <CloseIcon size={18} />
            </button>
          </div>
        </div>
      ) : null}
    </MusicPlayerContext.Provider>
  );
}
