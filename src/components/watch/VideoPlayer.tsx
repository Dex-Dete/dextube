"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { CaptionsIcon, PauseIcon, PlayIcon, SpinnerIcon } from "@/components/icons";

export interface PlayerCaption {
  label: string;
  src: string;
  lang: string;
}

export interface VideoPlayerProps {
  videoId: string;
  /** Progressive MP4 source. Null while the video is still processing. */
  src: string | null;
  posterUrl: string | null;
  /** Seconds to resume from (0 for "start at the beginning"). */
  startAtSeconds?: number;
  /** Whether to persist progress / record a view. False for anonymous viewers. */
  trackProgress?: boolean;
  captions?: PlayerCaption[];
  /** Vertical (9:16) presentation for Shorts. */
  portrait?: boolean;
  autoPlay?: boolean;
  className?: string;
}

/** How often playback position is persisted while playing. */
const PROGRESS_INTERVAL_MS = 10_000;
/** A view is recorded only after this much real playback. */
const VIEW_AFTER_SECONDS = 3;
/** Options offered in the settings menu. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * Video player.
 *
 * Built on the native `<video>` element so controls, captions, PiP, fullscreen
 * and accessibility all behave the way users and browsers expect — nothing here
 * is a decorative fake control. On top of that it adds the product behaviour a
 * video site needs: resume position, keyboard shortcuts, a real view ping and
 * throttled progress saving.
 *
 * Keyboard shortcuts (ignored while typing in a field):
 *   space / k      play or pause
 *   j / l          seek back / forward 10s
 *   ← / →          seek back / forward 5s
 *   ↑ / ↓          volume
 *   m              mute
 *   f              fullscreen
 *   0–9            jump to 0%–90%
 */
export function VideoPlayer({
  videoId,
  src,
  posterUrl,
  startAtSeconds = 0,
  trackProgress = false,
  captions = [],
  portrait = false,
  autoPlay = false,
  className,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(!autoPlay);
  const [error, setError] = useState<string | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  const viewSent = useRef(false);
  const lastSavedAt = useRef(0);

  /* ------------------------------------------------------ view recording */
  const recordView = useCallback(() => {
    if (viewSent.current || !trackProgress) return;
    viewSent.current = true;
    // Fire and forget: a failed view ping must never disturb playback.
    void api.post(`/api/videos/${videoId}/view`).catch(() => {});
  }, [trackProgress, videoId]);

  /* ------------------------------------------------------ progress saving */
  const saveProgress = useCallback(
    (force: boolean) => {
      const el = videoRef.current;
      if (!el || !trackProgress) return;
      if (!Number.isFinite(el.duration) || el.duration <= 0) return;
      const now = Date.now();
      if (!force && now - lastSavedAt.current < PROGRESS_INTERVAL_MS) return;
      lastSavedAt.current = now;
      void api
        .put(`/api/videos/${videoId}/progress`, {
          positionSec: el.currentTime,
          durationSec: el.duration,
        })
        .catch(() => {});
    },
    [trackProgress, videoId],
  );

  /**
   * Toggle browser fullscreen on the player wrapper.
   *
   * Declared above the keyboard effect and memoised so the effect can list it
   * as a dependency without changing identity on every render.
   */
  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrapper.requestFullscreen();
    } catch {
      /* Fullscreen can be blocked by the browser; the control is a no-op then. */
    }
  }, []);

  /* -------------------------------------------------------- resume + setup */
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !src) return;
    setReady(false);
    setError(null);
    setResumedFrom(null);
    viewSent.current = false;

    const onLoaded = () => {
      setReady(true);
      el.playbackRate = speed;
      // Only offer to resume if it is a meaningful position and not basically
      // at the end (which would look like the video is broken).
      if (startAtSeconds > 5 && el.duration > 0 && startAtSeconds < el.duration - 10) {
        el.currentTime = startAtSeconds;
        setResumedFrom(startAtSeconds);
      }
    };
    const onError = () => setError("This video could not be played. Try reloading the page.");
    const onPlay = () => {
      setPaused(false);
      recordView();
    };
    const onPause = () => {
      setPaused(true);
      saveProgress(true);
    };

    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("error", onError);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
    // `speed` is intentionally excluded: changing speed must not tear down the
    // media element. It is applied imperatively in the speed handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, startAtSeconds, recordView, saveProgress]);

  /* ----------------------------------------------- record view on progress */
  useEffect(() => {
    if (!trackProgress) return;
    const el = videoRef.current;
    if (!el) return;
    const onTime = () => {
      if (el.currentTime >= VIEW_AFTER_SECONDS) recordView();
      saveProgress(false);
    };
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [trackProgress, recordView, saveProgress]);

  /* ---------------------------------------------- save on leave / hide */
  useEffect(() => {
    if (!trackProgress) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") saveProgress(true);
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onHidden);
      saveProgress(true);
    };
  }, [trackProgress, saveProgress]);

  /* ------------------------------------------------------------- shortcuts */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from text entry or when a modifier is held.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const el = videoRef.current;
      if (!el) return;

      const seekBy = (delta: number) => {
        el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
      };

      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          if (el.paused) void el.play();
          else el.pause();
          break;
        case "j":
          event.preventDefault();
          seekBy(-10);
          break;
        case "l":
          event.preventDefault();
          seekBy(10);
          break;
        case "ArrowLeft":
          event.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekBy(5);
          break;
        case "ArrowUp":
          event.preventDefault();
          el.volume = Math.min(1, el.volume + 0.1);
          break;
        case "ArrowDown":
          event.preventDefault();
          el.volume = Math.max(0, el.volume - 0.1);
          break;
        case "m":
          event.preventDefault();
          el.muted = !el.muted;
          break;
        case "f":
          event.preventDefault();
          void toggleFullscreen();
          break;
        case "c":
          // Let the browser toggle native caption rendering; nothing to do.
          break;
        default:
          if (/^[0-9]$/.test(event.key) && Number.isFinite(el.duration)) {
            event.preventDefault();
            el.currentTime = (Number(event.key) / 10) * el.duration;
          }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleFullscreen]);

  function changeSpeed(value: number) {
    setSpeed(value);
    setShowSpeedMenu(false);
    if (videoRef.current) videoRef.current.playbackRate = value;
  }

  if (!src) {
    return (
      <div
        className={`dt-card flex items-center justify-center ${className ?? ""}`}
        style={{ aspectRatio: portrait ? "9 / 16" : "16 / 9", background: "#000", color: "#fff" }}
      >
        <p className="text-sm">This video is still being processed.</p>
      </div>
    );
  }

  const aspect = portrait ? "9 / 16" : "16 / 9";

  return (
    <div
      ref={wrapperRef}
      className={`group relative overflow-hidden rounded-xl ${className ?? ""}`}
      style={{ aspectRatio: aspect, background: "#000" }}
    >
      <video
        ref={videoRef}
        src={src}
        poster={posterUrl ?? undefined}
        controls
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        crossOrigin="anonymous"
        className="h-full w-full"
        style={{ objectFit: portrait ? "contain" : "contain" }}
      >
        {captions.map((caption) => (
          <track key={caption.src} kind="subtitles" src={caption.src} srcLang={caption.lang} label={caption.label} />
        ))}
      </video>

      {!ready && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ color: "#fff" }}>
          <SpinnerIcon size={30} />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center" style={{ color: "#fff" }}>
          <p className="text-sm font-semibold">Playback problem</p>
          <p className="max-w-sm text-xs opacity-80">{error}</p>
        </div>
      )}

      {resumedFrom !== null && !error && (
        <div
          role="status"
          className="absolute bottom-16 left-3 rounded-md px-2.5 py-1.5 text-[11px] font-medium"
          style={{ background: "rgba(0,0,0,0.82)", color: "#fff" }}
        >
          Resumed from {formatClock(resumedFrom)}
        </div>
      )}

      {/* Playback speed — the one control the native UI lacks per-platform. */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setShowSpeedMenu((open) => !open)}
          aria-expanded={showSpeedMenu}
          aria-label="Playback speed"
          className="rounded-md px-2 py-1 text-[11px] font-semibold opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
          style={{ background: "rgba(0,0,0,0.75)", color: "#fff" }}
        >
          {speed}×
        </button>
        {showSpeedMenu && (
          <div
            role="menu"
            className="flex flex-col rounded-md py-1 text-[12px]"
            style={{ background: "rgba(0,0,0,0.88)", color: "#fff" }}
          >
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={value === speed}
                onClick={() => changeSpeed(value)}
                className="px-3 py-1 text-left hover:bg-white/15"
                style={{ fontWeight: value === speed ? 700 : 400 }}
              >
                {value}×
              </button>
            ))}
          </div>
        )}
      </div>

      {/* A visible, keyboard-focusable play/pause control: the native control
          bar is not reliably reachable for every assistive technology. */}
      <button
        type="button"
        onClick={() => {
          const el = videoRef.current;
          if (!el) return;
          if (el.paused) void el.play();
          else el.pause();
        }}
        aria-label={paused ? "Play" : "Pause"}
        className="absolute bottom-14 left-3 rounded-full p-2.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
        style={{ background: "rgba(0,0,0,0.72)", color: "#fff" }}
      >
        {paused ? <PlayIcon size={18} /> : <PauseIcon size={18} />}
      </button>

      {captions.length > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-14 right-3 rounded p-1.5 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: "rgba(0,0,0,0.72)", color: "#fff" }}
        >
          <CaptionsIcon size={16} />
        </span>
      )}

      <p className="sr-only">
        Keyboard shortcuts: space or K to play and pause, J and L to seek 10 seconds, arrow keys to seek 5 seconds and
        adjust volume, M to mute, F for fullscreen, and the number keys to jump through the video.
      </p>
    </div>
  );
}

/** mm:ss / h:mm:ss, also used for the resume toast. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}
