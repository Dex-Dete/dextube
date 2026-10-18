"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { api } from "@/lib/api-client";
import {
  CaptionsIcon,
  CheckIcon,
  ChevronLeftIcon,
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  SettingsIcon,
  SpinnerIcon,
  VolumeIcon,
} from "@/components/icons";
import {
  AutoplayIcon,
  FullscreenExitIcon,
  KeyboardIcon,
  PipIcon,
  QualityIcon,
  ReplayIcon,
} from "@/components/watch/player-icons";

export interface PlayerCaption {
  label: string;
  src: string;
  lang: string;
}

/** One playable rendition, derived from a real `VideoAsset` row. */
export interface PlayerRendition {
  label: string;
  src: string;
  height: number | null;
}

/** One text track as reported by the media element itself. */
export interface CaptionTrack {
  label: string;
  language: string;
}

export interface VideoPlayerProps {
  videoId: string;
  /** Default progressive source. Null while the video is still processing. */
  src: string | null;
  /**
   * Every rendition that actually exists on disk, tallest first. When this has
   * fewer than two entries the quality menu is not rendered at all — DEXTube
   * never shows a quality option it cannot honour.
   */
  renditions?: PlayerRendition[];
  posterUrl: string | null;
  /** Seconds to resume from (0 for "start at the beginning"). */
  startAtSeconds?: number;
  /** Whether to persist progress / record a view. False for anonymous viewers. */
  trackProgress?: boolean;
  captions?: PlayerCaption[];
  /** Vertical (9:16) presentation for Shorts. */
  portrait?: boolean;
  autoPlay?: boolean;
  /** Fired when playback reaches the end, for a caller-driven next video. */
  onEnded?: () => void;
  /**
   * The next video in the queue. When set, the end card and the autoplay-next
   * preference navigate here. Server components can pass this where they cannot
   * pass a callback.
   */
  nextVideo?: { href: string; title: string } | null;
  /** Accessible name for the media element. */
  title?: string;
  className?: string;
}

/** How often playback position is persisted while playing. */
const PROGRESS_INTERVAL_MS = 10_000;
/** A view is recorded only after this much real playback. */
const VIEW_AFTER_SECONDS = 3;
/** Playback speeds, as specified for the product. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
/** How long the control bar stays up after the last interaction. */
const HIDE_DELAY_MS = 2600;
/** Minimum position change worth a write to the database. */
const MIN_PROGRESS_DELTA_SEC = 1;
/** A video the viewer barely started is not worth resuming. */
const RESUME_MIN_SECONDS = 5;
/** …and neither is one where they stopped in the closing moments. */
const RESUME_TAIL_SECONDS = 10;
const RESUME_TAIL_RATIO = 0.15;
/** Preference: jump to the next video when the current one ends. */
const AUTOPLAY_NEXT_PREF_KEY = "dextube-autoplay-next";
/** Preference: try to start a watch page muted when it opens (default off). */
const AUTOPLAY_PLAY_PREF_KEY = "dextube-player-autoplay";
/** Preference: the time readout counts down instead of up (default off). */
const TIME_REMAINING_PREF_KEY = "dextube-player-time-remaining";
const PLAYBACK_SPEED_PREF_KEY = "dextube-player-speed";

function playbackSpeedSnapshot(): number {
  try {
    const stored = Number(window.localStorage.getItem(PLAYBACK_SPEED_PREF_KEY));
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4].includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

const playbackSpeedListeners = new Set<() => void>();
const playbackSpeedPreference = {
  subscribe(listener: () => void) {
    playbackSpeedListeners.add(listener);
    return () => playbackSpeedListeners.delete(listener);
  },
  write(value: number) {
    try {
      window.localStorage.setItem(PLAYBACK_SPEED_PREF_KEY, String(value));
    } catch {
      /* Private mode — the preference simply does not persist. */
    }
    for (const listener of playbackSpeedListeners) listener();
  },
};

/**
 * A range of already-downloaded media, in seconds. Derived from the media
 * element's own `TimeRanges` — DEXTube never guesses a buffered range.
 */
export interface BufferedRange {
  start: number;
  end: number;
}

/** The subset of `TimeRanges` this module needs; a real one satisfies it. */
export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/* ------------------------------------------------- browser-environment stores */

/**
 * `useSyncExternalStore` sources for values that only exist in the browser.
 *
 * Reading these in a mount effect and calling `setState` renders twice and
 * hides the value from React during hydration. Subscribing instead gives a
 * server snapshot (the safe default) plus a client snapshot, so hydration
 * matches and the real value appears immediately afterwards.
 */
const noopSubscribe = () => () => {};

function pipSupportedSnapshot(): boolean {
  return typeof document !== "undefined" && "pictureInPictureEnabled" in document;
}

let reducedMotionQuery: MediaQueryList | null = null;
function reducedMotionQueryList(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  reducedMotionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotionQuery;
}
function reducedMotionSubscribe(listener: () => void): () => void {
  const query = reducedMotionQueryList();
  if (!query) return () => {};
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function reducedMotionSnapshot(): boolean {
  return reducedMotionQueryList()?.matches ?? false;
}

/**
 * A `useSyncExternalStore` source backed by one boolean in `localStorage`.
 *
 * Reads happen through `snapshot` so React hydrates with the safe default and
 * only adopts the stored value on the client; writes fan out to every mounted
 * subscriber. Storage access is wrapped because private mode can throw.
 */
interface BooleanPreference {
  subscribe(listener: () => void): () => void;
  snapshot(): boolean;
  write(value: boolean): void;
}

function createBooleanPreference(key: string): BooleanPreference {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      try {
        return window.localStorage.getItem(key) === "true";
      } catch {
        return false;
      }
    },
    write(value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch {
        /* Private mode — the preference simply does not persist. */
      }
      for (const listener of listeners) listener();
    },
  };
}

const autoplayNextPreference = createBooleanPreference(AUTOPLAY_NEXT_PREF_KEY);
const autoplayPlayPreference = createBooleanPreference(AUTOPLAY_PLAY_PREF_KEY);
const timeRemainingPreference = createBooleanPreference(TIME_REMAINING_PREF_KEY);/** Stable server snapshot: never a capability the server can know about. */
const falseOnServer = () => false;

type MenuView = "none" | "root" | "speed" | "quality" | "captions";

/**
 * DEXTube player.
 *
 * Built on the native `<video>` element, which means the browser owns codec
 * decoding, buffering and (for the single-rendition case) the media pipeline.
 * Everything layered on top is a real control bound to real media state — no
 * decorative placeholders. Specifically:
 *
 *  * Quality switching swaps between MP4 renditions that exist as rows in
 *    `video_assets` and as files on disk. It is *manual* switching: it seeks
 *    back to the current position in the new file. There is no adaptive
 *    bitrate engine here and the player does not claim to be one.
 *  * Speed, volume, mute, seek, fullscreen, picture-in-picture, captions and
 *    keyboard shortcuts all act on the media element directly.
 *  * The seek bar draws a second, decorative bar from the element's real
 *    `buffered` ranges, and a spinner appears only while the element is
 *    genuinely stalled (not on a timer).
 *  * The time readout toggles between elapsed and remaining, and the setting
 *    persists.
 *  * Caption languages come from `video.textTracks`, so a language is offered
 *    only when the browser parsed a track for it.
 *  * The "Autoplay" preference is honoured only as far as a browser allows on a
 *    normal navigation: it may start playback *muted*, and never with sound.
 *  * Progress is throttled to one write per 10 seconds, skipped when the
 *    position has barely moved, and flushed with `keepalive` when the page is
 *    hidden or unloaded so a closed tab still saves the resume point.
 *  * Playback and processing failures surface as real messages with recovery
 *    actions rather than a dead black rectangle.
 *
 * Keyboard shortcuts (ignored while typing, or while a control has focus):
 *   space / k    play or pause          ← / →   seek 5s
 *   j / l        seek 10s               ↑ / ↓   volume
 *   m            mute                   f       fullscreen
 *   c            captions on/off        0–9     jump to 0%–90%
 *   < / >        playback speed down/up
 */
export function VideoPlayer({
  videoId,
  src,
  renditions = [],
  posterUrl,
  startAtSeconds = 0,
  trackProgress = false,
  captions = [],
  portrait = false,
  autoPlay = false,
  onEnded,
  nextVideo = null,
  title,
  className,
}: VideoPlayerProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const preferredSpeed = useSyncExternalStore(playbackSpeedPreference.subscribe, playbackSpeedSnapshot, () => 1);

  const [activeSrc, setActiveSrc] = useState<string | null>(src);
  // The first stored rendition is the one playing, so that is the honest
  // initial value — the menu must never show a fabricated "Auto".
  const [qualityLabel, setQualityLabel] = useState<string | null>(() => renditions[0]?.label ?? null);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [paused, setPaused] = useState(!autoPlay);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const speed = preferredSpeed;
  const [menu, setMenu] = useState<MenuView>("none");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionTracks, setCaptionTracks] = useState<CaptionTrack[]>([]);
  const [activeCaptionIndex, setActiveCaptionIndex] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  const reduceMotion = useSyncExternalStore(
    reducedMotionSubscribe,
    reducedMotionSnapshot,
    falseOnServer,
  );
  const pipSupported = useSyncExternalStore(noopSubscribe, pipSupportedSnapshot, falseOnServer);
  const autoplayNext = useSyncExternalStore(
    autoplayNextPreference.subscribe,
    autoplayNextPreference.snapshot,
    falseOnServer,
  );
  const autoplayPlayback = useSyncExternalStore(
    autoplayPlayPreference.subscribe,
    autoplayPlayPreference.snapshot,
    falseOnServer,
  );
  const showRemaining = useSyncExternalStore(
    timeRemainingPreference.subscribe,
    timeRemainingPreference.snapshot,
    falseOnServer,
  );

  const viewSent = useRef(false);
  const lastSaved = useRef({ at: 0, position: -1 });
  const resumeApplied = useRef(false);
  const metadataApplied = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const wasPlaying = useRef(false);
  const autoplayAttempted = useRef(false);

  const hasQualityMenu = renditions.length > 1;
  /**
   * Captions are real only when the element actually exposes text tracks.
   * `video.textTracks` — not the props — is the source of truth, so a language
   * is never offered unless the browser parsed a `<track>` for it.
   */
  const hasCaptions = captionTracks.length > 0;
  const captionsOn = activeCaptionIndex !== null;

  /**
   * Reset per-source state when the source changes.
   *
   * Adjusting state during render — rather than in an effect — is the pattern
   * React recommends when props change and derived state is stale. It re-renders
   * immediately without a wasted commit or the cascading render an effect would
   * cause. The source changes when a video finishes processing and when a caller
   * swaps the video in place.
   */
  const [sourceState, setSourceState] = useState<string | null>(src);
  if (sourceState !== src) {
    setSourceState(src);
    setActiveSrc(src);
    setQualityLabel(renditions[0]?.label ?? null);
    setSwitching(false);
    setReady(false);
    setError(null);
    setEnded(false);
    setBuffering(false);
    setResumedFrom(null);
  }

  /**
   * Per-source refs are cleared in an effect rather than during render: writing
   * to a ref while rendering is not allowed, and no media event (which reads
   * them) can fire before effects have run.
   */
  useEffect(() => {
    resumeApplied.current = false;
    metadataApplied.current = false;
  }, [activeSrc]);

  /** A different video is a different view, even at the same quality. */
  useEffect(() => {
    viewSent.current = false;
  }, [videoId]);

  /* --------------------------------------------- captions straight from the DOM */
  /**
   * The menu must reflect the tracks the browser actually parsed, not the props
   * that were requested. `video.textTracks` is read on mount and re-read on
   * `addtrack` / `removetrack` / `change`, so the list appears once a remote
   * track has loaded and follows a mode change made anywhere else.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const tracks = el.textTracks;

    const sync = () => {
      const next: CaptionTrack[] = [];
      let active: number | null = null;
      for (let i = 0; i < tracks.length; i += 1) {
        const track = tracks[i];
        const language = (track.language || "").trim();
        const label = (track.label || "").trim() || language || `Track ${i + 1}`;
        next.push({ label, language });
        if (track.mode === "showing" && active === null) active = i;
      }
      setCaptionTracks(next);
      setActiveCaptionIndex(active);
    };

    sync();
    tracks.addEventListener("addtrack", sync);
    tracks.addEventListener("removetrack", sync);
    tracks.addEventListener("change", sync);
    return () => {
      tracks.removeEventListener("addtrack", sync);
      tracks.removeEventListener("removetrack", sync);
      tracks.removeEventListener("change", sync);
    };
  }, [activeSrc]);

  /* ------------------------------------------------- autoplay-on-open preference */
  useEffect(() => {
    autoplayAttempted.current = false;
  }, [videoId]);

  /**
   * Honour the persisted "Autoplay" preference, and only in the way a browser
   * permits on a normal navigation.
   *
   * Playback without a user gesture is allowed only while the media is muted, so
   * that is exactly what happens: the element is muted, `play()` is attempted,
   * and if it resolves the video keeps playing **muted** — sound is never turned
   * on automatically. If it rejects (autoplay policy, data saver, no gesture)
   * nothing happens: the poster and the play button stay, with no error. The
   * attempt runs once per video, so switching quality cannot restart playback.
   */
  useEffect(() => {
    if (!autoplayPlayback || autoPlay || autoplayAttempted.current) return;
    const el = videoRef.current;
    if (!el || !el.paused) return;
    autoplayAttempted.current = true;
    el.muted = true;
    void el.play().catch(() => {
      /* Not allowed right now — the poster and play button remain. */
    });
  }, [autoplayPlayback, autoPlay, videoId]);

  /** Advance to the next video, however the caller wired it up. */
  const goNext = useCallback(() => {
    if (onEnded) {
      onEnded();
      return;
    }
    if (nextVideo) router.push(nextVideo.href);
  }, [nextVideo, onEnded, router]);
  const canGoNext = Boolean(onEnded || nextVideo);

  /* ------------------------------------------------------- progress writing */
  const recordView = useCallback(() => {
    if (viewSent.current || !trackProgress) return;
    viewSent.current = true;
    void api.post(`/api/videos/${videoId}/view`).catch(() => {});
  }, [trackProgress, videoId]);

  /**
   * Persist the resume position.
   *
   * `flush` is used on pause and on page hide/unload; the periodic path is
   * skipped unless the position actually moved, which keeps an idle or
   * buffering player from writing to the database in a loop.
   */
  const saveProgress = useCallback(
    (flush: boolean) => {
      const el = videoRef.current;
      if (!el || !trackProgress) return;
      if (!Number.isFinite(el.duration) || el.duration <= 0) return;
      const position = el.currentTime;
      const now = Date.now();
      if (!flush && now - lastSaved.current.at < PROGRESS_INTERVAL_MS) return;
      if (!flush && Math.abs(position - lastSaved.current.position) < MIN_PROGRESS_DELTA_SEC) return;
      lastSaved.current = { at: now, position };
      const body = JSON.stringify({ positionSec: position, durationSec: el.duration });
      if (flush) {
        // `keepalive` lets the request outlive the document, so closing the tab
        // or navigating away still stores the resume point.
        void fetch(`/api/videos/${videoId}/progress`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
          credentials: "same-origin",
          keepalive: true,
        }).catch(() => {});
        return;
      }
      void api.put(`/api/videos/${videoId}/progress`, JSON.parse(body)).catch(() => {});
    },
    [trackProgress, videoId],
  );

  /* ---------------------------------------------------- media event wiring */
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !activeSrc) return;

    const applyBuffered = () => {
      setBufferedRanges(computeBufferedRanges(el.buffered, el.duration));
    };

    /**
     * A genuine stall, derived from the element's own state rather than a timer:
     * not enough data to continue while the browser is still loading it. Called
     * from the media events that can change either value.
     */
    const syncLoading = () => {
      setBuffering(
        el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
          el.networkState === HTMLMediaElement.NETWORK_LOADING,
      );
    };

    const fail = (code: number | null) => {
      setError(describeMediaError(code, el.networkState));
      setBuffering(false);
      setReady(true);
      setSwitching(false);
    };

    const onLoadedMetadata = () => {
      // Applied on every run so a speed change while playing takes effect on the
      // element immediately.
      el.playbackRate = speed;

      // Everything below describes the *source*, so it runs once per source.
      if (metadataApplied.current) return;
      metadataApplied.current = true;

      setDuration(el.duration);
      setReady(true);
      setSwitching(false);
      setBufferedRanges([]);

      // A quality switch carries the playhead across files.
      if (pendingSeek.current !== null) {
        el.currentTime = Math.min(pendingSeek.current, Math.max(0, el.duration - 0.5));
        pendingSeek.current = null;
        if (wasPlaying.current) void el.play().catch(() => {});
        wasPlaying.current = false;
        return;
      }

      // Resume once per source, inside a window that scales with the video. The
      // tail guard is the smaller of a fixed ten seconds and 15% of the
      // duration, so a long film never resumes into its closing seconds while a
      // ten-second clip still offers to resume at all.
      const tail = Math.min(RESUME_TAIL_SECONDS, el.duration * RESUME_TAIL_RATIO);
      if (
        !resumeApplied.current &&
        el.duration > 0 &&
        startAtSeconds >= RESUME_MIN_SECONDS &&
        startAtSeconds <= el.duration - tail
      ) {
        el.currentTime = startAtSeconds;
        setResumedFrom(startAtSeconds);
      }
      resumeApplied.current = true;
    };

    /**
     * The media element has failed, or has settled with nothing to play
     * (`HAVE_NOTHING` + `NETWORK_NO_SOURCE`). The message is chosen from the
     * real `MediaError` code so a decode/format failure is not reported as a
     * network fault. A quality switch never reaches this path: swapping `src`
     * leaves the element in `NETWORK_EMPTY`/`LOADING`, not `NO_SOURCE`.
     */
    const onError = () => fail(el.error?.code ?? null);
    const onPlay = () => {
      setPaused(false);
      setEnded(false);
      recordView();
    };
    const onPause = () => {
      setPaused(true);
      saveProgress(true);
    };
    const onWaiting = () => setBuffering(true);
    const onStalled = () => setBuffering(true);
    const onSeeking = () => setBuffering(true);
    // A seek inside already-buffered data completes without another `canplay`,
    // so clear the indicator here when the data is in fact present.
    const onSeeked = () => {
      applyBuffered();
      if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) setBuffering(false);
    };
    const onPlaying = () => {
      setBuffering(false);
      applyBuffered();
    };
    const onCanPlay = () => setBuffering(false);
    const onTime = () => {
      setCurrentTime(el.currentTime);
      if (el.currentTime >= VIEW_AFTER_SECONDS) recordView();
      saveProgress(false);
      applyBuffered();
    };
    const onProgress = () => {
      applyBuffered();
      syncLoading();
    };
    const onEmptied = () => {
      applyBuffered();
      if (el.readyState === HTMLMediaElement.HAVE_NOTHING && el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        fail(null);
      }
    };
    const onDuration = () => setDuration(el.duration);
    const onVolume = () => {
      setVolume(el.volume);
      setMuted(el.muted);
    };
    const onEndedEvent = () => {
      setEnded(true);
      setPaused(true);
      saveProgress(true);
      if (autoplayNext && canGoNext) goNext();
    };

    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("durationchange", onDuration);
    el.addEventListener("error", onError);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("stalled", onStalled);
    el.addEventListener("seeking", onSeeking);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("progress", onProgress);
    el.addEventListener("emptied", onEmptied);
    el.addEventListener("volumechange", onVolume);
    el.addEventListener("ended", onEndedEvent);

    /**
     * The `<video>` is server-rendered with its source, so the browser can
     * finish loading metadata before React hydrates and attaches the listener
     * above. In that case `loadedmetadata` has already fired and would never
     * fire again, leaving the duration — and therefore the seek bar — at zero
     * forever. Apply whatever the element already knows.
     */
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
    else if (el.error) onError();
    else if (el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) fail(null);
    else applyBuffered();

    return () => {
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("durationchange", onDuration);
      el.removeEventListener("error", onError);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("stalled", onStalled);
      el.removeEventListener("seeking", onSeeking);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("emptied", onEmptied);
      el.removeEventListener("volumechange", onVolume);
      el.removeEventListener("ended", onEndedEvent);
    };
  }, [activeSrc, autoplayNext, canGoNext, goNext, recordView, saveProgress, speed, startAtSeconds]);

  /* ------------------------------------------------- flush on leave / hide */
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

  /* -------------------------------------------------------------- fullscreen */
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await wrapper.requestFullscreen();
      // Orientation locking is best-effort: it needs a trusted gesture and is
      // not implemented by every browser, so a rejection is not an error.
      if (!portrait) {
        const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        void orientation?.lock?.("landscape").catch(() => {});
      }
    } catch {
      /* Blocked by the browser; the control simply does nothing. */
    }
  }, [portrait]);

  const togglePip = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* Not permitted for this media; ignore. */
    }
  }, []);

  /* ------------------------------------------------------------------ menus */
  useEffect(() => {
    if (menu === "none") return;
    const onDocPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && !menuRef.current.contains(target)) setMenu("none");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu("none");
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /* ------------------------------------------------------ control bar hiding */
  /**
   * Auto-hide is driven by real media state, and state is only written from the
   * timer callback — never synchronously in an effect body. While playback is
   * paused, or a menu is open, the bar is forced visible by `barVisible` below
   * instead of by another state write.
   */
  const scheduleHide = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setControlsVisible(false);
    }, HIDE_DELAY_MS);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (!paused && menu === "none" && !showHelp) scheduleHide();
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [paused, menu, showHelp, scheduleHide]);

  /** Visible while paused, while a menu is open, or shortly after input. */
  const barVisible = controlsVisible || paused || menu !== "none" || showHelp;

  /* --------------------------------------------------------- keyboard shortcuts */
  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + delta));
  }, []);

  const setSpeedValue = useCallback((value: number) => {
    playbackSpeedPreference.write(value);
    if (videoRef.current) videoRef.current.playbackRate = value;
  }, []);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  /**
   * Show a specific caption track and disable every other one. `null` turns
   * captions off. Modes are written on the real `TextTrack` objects, and the
   * `change` listener on `textTracks` reflects the result back into the menu.
   */
  const showCaption = useCallback((index: number | null) => {
    const el = videoRef.current;
    if (!el) return;
    for (let i = 0; i < el.textTracks.length; i += 1) {
      el.textTracks[i].mode = index !== null && i === index ? "showing" : "disabled";
    }
  }, []);

  /** A menu selection changes the track and closes the menu. */
  const selectCaption = useCallback(
    (index: number | null) => {
      showCaption(index);
      setMenu("none");
    },
    [showCaption],
  );

  /** The one-track case: a plain on/off toggle over the sole track. */
  const toggleCaptions = useCallback(() => {
    const el = videoRef.current;
    if (!el || el.textTracks.length === 0) return;
    showCaption(captionsOn ? null : activeCaptionIndex ?? 0);
  }, [activeCaptionIndex, captionsOn, showCaption]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = videoRef.current;
      if (!el) return;

      // Space and Enter belong to a focused control when one has focus.
      const active = document.activeElement as HTMLElement | null;
      const controlFocused = Boolean(active && active !== document.body && /^(BUTTON|A|INPUT|SELECT)$/.test(active.tagName));

      switch (event.key) {
        case " ":
          if (controlFocused) return;
          event.preventDefault();
          togglePlay();
          break;
        case "k":
          event.preventDefault();
          togglePlay();
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
          if (!hasCaptions) return;
          event.preventDefault();
          toggleCaptions();
          break;
        case ",":
        case "<": {
          event.preventDefault();
          const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
          setSpeedValue(SPEEDS[Math.max(0, (i === -1 ? 3 : i) - 1)]);
          break;
        }
        case ".":
        case ">": {
          event.preventDefault();
          const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
          setSpeedValue(SPEEDS[Math.min(SPEEDS.length - 1, (i === -1 ? 3 : i) + 1)]);
          break;
        }
        default:
          if (/^[0-9]$/.test(event.key) && Number.isFinite(el.duration)) {
            event.preventDefault();
            el.currentTime = (Number(event.key) / 10) * el.duration;
          }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasCaptions, seekBy, setSpeedValue, speed, toggleCaptions, toggleFullscreen, togglePlay]);

  /* ------------------------------------------------------------ quality swap */
  const chooseQuality = useCallback((rendition: PlayerRendition) => {
    const el = videoRef.current;
    setMenu("none");
    if (!el || rendition.src === activeSrc) return;
    pendingSeek.current = el.currentTime;
    wasPlaying.current = !el.paused;
    setSwitching(true);
    setQualityLabel(rendition.label);
    setActiveSrc(rendition.src);
  }, [activeSrc]);

  const setAutoplay = useCallback((value: boolean) => {
    autoplayNextPreference.write(value);
    setMenu("none");
  }, []);

  const retry = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    // A retry is a fresh load of the same source, so the once-per-source guards
    // must be cleared or `loadedmetadata` would be ignored and the spinner would
    // never resolve. The quality choice is untouched.
    metadataApplied.current = false;
    resumeApplied.current = false;
    setError(null);
    setReady(false);
    setBuffering(false);
    setBufferedRanges([]);
    el.load();
  }, []);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const remaining = duration > 0 ? Math.max(0, duration - currentTime) : 0;
  /**
   * Only the played portion is drawn on the range input itself. The buffered
   * ranges are a separate, decorative layer so the two can never overwrite each
   * other — and are drawn behind the input, which keeps the thumb draggable.
   */
  const seekTrackBackground = useMemo(
    () => `linear-gradient(to right, var(--dt-brand) 0% ${progressPct}%, transparent ${progressPct}% 100%)`,
    [progressPct],
  );

  /* -------------------------------------------------------- processing state */
  if (!activeSrc) {
    return (
      <div
        className={clsx("relative flex items-center justify-center overflow-hidden rounded-xl", className)}
        style={{ aspectRatio: portrait ? "9 / 16" : "16 / 9", background: "#0b0b0f", color: "#fff" }}
      >
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <SpinnerIcon size={26} />
          <p className="text-sm font-semibold">This video is still processing</p>
          <p className="max-w-sm text-xs opacity-70">
            The file is being converted for playback. This page will start working as soon as it is ready.
          </p>
          <button type="button" onClick={() => router.refresh()} className="dt-btn dt-btn-secondary mt-1">
            Check again
          </button>
        </div>
      </div>
    );
  }

  const barTransition = reduceMotion ? "" : "transition-opacity duration-200";

  return (
    <div
      ref={wrapperRef}
      className={clsx("group/player relative overflow-hidden rounded-xl", className)}
      style={{ aspectRatio: portrait ? "9 / 16" : "16 / 9", background: "#000" }}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onFocus={revealControls}
    >
      <video
        ref={videoRef}
        src={activeSrc}
        poster={posterUrl ?? undefined}
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        crossOrigin="anonymous"
        aria-label={title ? `${title} — video player` : "Video player"}
        className="h-full w-full cursor-pointer"
        style={{ objectFit: "contain" }}
        onClick={() => {
          if (menu !== "none" || showHelp) return;
          togglePlay();
        }}
        onDoubleClick={() => void toggleFullscreen()}
        onContextMenu={(event) => {
          // The player owns its surface: no ad-hoc download/URL menu.
          event.preventDefault();
        }}
      >
        {captions.map((caption) => (
          <track key={caption.src} kind="subtitles" src={caption.src} srcLang={caption.lang} label={caption.label} />
        ))}
      </video>

      {/* Loading / buffering: shown while stalled, not on a timer */}
      {(!ready || buffering || switching) && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" style={{ color: "#fff" }}>
          <span
            aria-hidden="true"
            className="grid h-12 w-12 place-items-center rounded-full"
            style={{ background: "rgba(0,0,0,0.55)" }}
          >
            <SpinnerIcon size={26} style={reduceMotion ? { animation: "none" } : undefined} />
          </span>
          <span className="sr-only" role="status">
            {switching ? "Switching quality" : "Loading video"}
          </span>
        </div>
      )}

      {/* Centre play button — visible whenever playback is not running */}
      {ready && paused && !error && !ended && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 grid place-items-center"
          style={{ background: "rgba(0,0,0,0.28)" }}
        >
          <span className="grid h-14 w-14 place-items-center rounded-full" style={{ background: "rgba(0,0,0,0.68)", color: "#fff" }}>
            <PlayIcon size={26} />
          </span>
        </button>
      )}

      {/* End of video: replay, and jump to the next video when one is offered */}
      {ended && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ background: "rgba(0,0,0,0.62)", color: "#fff" }}>
          <p className="text-sm font-semibold">Finished</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                const el = videoRef.current;
                if (!el) return;
                el.currentTime = 0;
                setEnded(false);
                void el.play().catch(() => {});
              }}
              className="dt-btn dt-btn-secondary"
            >
              <ReplayIcon size={16} /> Replay
            </button>
            {canGoNext ? (
              <button type="button" onClick={goNext} className="dt-btn dt-btn-primary">
                Next video
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* Real error state with recovery actions */}
      {error && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center"
          style={{ background: "rgba(0,0,0,0.72)", color: "#fff" }}
          role="alert"
        >
          <p className="text-sm font-semibold">Playback problem</p>
          <p className="max-w-sm text-xs opacity-80">{error}</p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={retry} className="dt-btn dt-btn-secondary">
              Retry
            </button>
            <button type="button" onClick={() => window.location.reload()} className="dt-btn dt-btn-ghost" style={{ color: "#fff" }}>
              Reload page
            </button>
          </div>
        </div>
      )}

      {resumedFrom !== null && !error && !ended && (
        <div
          role="status"
          className="absolute left-3 top-3 rounded-md px-2.5 py-1.5 text-[11px] font-medium"
          style={{ background: "rgba(0,0,0,0.82)", color: "#fff" }}
        >
          Resumed from {formatClock(resumedFrom)}
          <button
            type="button"
            onClick={() => {
              const el = videoRef.current;
              if (el) el.currentTime = 0;
              setResumedFrom(null);
            }}
            className="ml-2 font-semibold underline"
          >
            Start over
          </button>
        </div>
      )}

      {/* ------------------------------------------------------ control surface */}
      <div
        className={clsx(
          "absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-2 pb-2 pt-8 sm:px-3",
          barTransition,
          barVisible ? "opacity-100" : "opacity-0",
        )}
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0.42) 55%, transparent)",
        }}
        onPointerDown={() => revealControls()}
      >
        {/* Seek bar — buffered and played ranges, keyboard operable */}
        <div className="relative flex items-center">
          {/*
            Buffered ranges, drawn from `video.buffered` as a decorative layer
            behind the range input. It is `aria-hidden` and `pointer-events-none`
            so it can never intercept a drag, and it renders nothing (zero-width)
            before the browser reports any ranges.
          */}
          <div
            aria-hidden="true"
            data-testid="buffered-bar"
            className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full"
            style={{ background: "rgba(255,255,255,0.18)" }}
          >
            {bufferedRanges.map((range, index) => (
              <span
                key={`${range.start}-${index}`}
                data-testid="buffered-range"
                className="absolute inset-y-0"
                style={{
                  left: `${duration > 0 ? (range.start / duration) * 100 : 0}%`,
                  width: `${duration > 0 ? ((range.end - range.start) / duration) * 100 : 0}%`,
                  background: "rgba(255,255,255,0.42)",
                }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => {
              const el = videoRef.current;
              if (!el) return;
              el.currentTime = Number(event.target.value);
              setCurrentTime(Number(event.target.value));
            }}
            onMouseMove={(event) => {
              if (duration <= 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              setSeekPreview(ratio * duration);
            }}
            onMouseLeave={() => setSeekPreview(null)}
            aria-label="Seek"
            aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration)}`}
            className="relative h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            style={{ background: seekTrackBackground }}
          />
          {seekPreview !== null ? (
            <span
              role="presentation"
              className="pointer-events-none absolute -top-7 z-20 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              style={{ background: "rgba(0,0,0,0.85)", color: "#fff", left: `calc(${duration > 0 ? (seekPreview / duration) * 100 : 0}% - 18px)` }}
            >
              {formatClock(seekPreview)}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-0.5 text-white sm:gap-1">
          <BarButton label={paused ? "Play" : "Pause"} onClick={togglePlay}>
            {paused ? <PlayIcon size={20} /> : <PauseIcon size={20} />}
          </BarButton>

          {/* Volume: mute button plus a slider on pointer-capable widths */}
          <div className="group/vol flex items-center">
            <BarButton
              label={muted || volume === 0 ? "Unmute" : "Mute"}
              onClick={() => {
                const el = videoRef.current;
                if (el) el.muted = !el.muted;
              }}
            >
              <VolumeIcon size={20} level={muted ? 0 : volume === 0 ? 0 : volume < 0.5 ? 0.5 : 1} />
            </BarButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => {
                const el = videoRef.current;
                if (!el) return;
                const next = Number(event.target.value);
                el.volume = next;
                el.muted = next === 0;
              }}
              aria-label="Volume"
              aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
              className="hidden h-1.5 w-0 cursor-pointer appearance-none rounded-full opacity-0 outline-none transition-all focus-visible:w-16 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70 group-hover/vol:w-16 group-hover/vol:opacity-100 sm:block [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              style={{ background: "rgba(255,255,255,0.35)" }}
            />
          </div>

          <button
            type="button"
            data-testid="time-toggle"
            onClick={() => timeRemainingPreference.write(!showRemaining)}
            aria-label={
              showRemaining
                ? `Remaining time ${formatClock(remaining)}. Show elapsed time`
                : `Elapsed time ${formatClock(currentTime)}. Show remaining time`
            }
            title={showRemaining ? "Show elapsed time" : "Show remaining time"}
            className="ml-1 rounded px-1 text-[11px] font-medium tabular-nums outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 sm:text-xs"
          >
            {showRemaining ? `-${formatClock(remaining)}` : formatClock(currentTime)}
          </button>
          <span className="text-[11px] font-medium tabular-nums sm:text-xs" aria-hidden="true">
            / {formatClock(duration)}
          </span>

          <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
            {speed !== 1 ? (
              <span
                className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                style={{ background: "rgba(255,255,255,0.16)" }}
                aria-label={`Playback speed ${speed} times`}
              >
                {speed}×
              </span>
            ) : null}

            {hasCaptions ? (
              <BarButton label={captionsOn ? "Turn subtitles off" : "Turn subtitles on"} onClick={toggleCaptions} active={captionsOn}>
                <CaptionsIcon size={20} />
              </BarButton>
            ) : null}

            <BarButton
              label="Keyboard shortcuts"
              onClick={() => {
                setShowHelp((open) => !open);
                setMenu("none");
              }}
              active={showHelp}
              className="hidden sm:inline-flex"
            >
              <KeyboardIcon size={19} />
            </BarButton>

            <BarButton
              label="Settings"
              onClick={() => {
                setMenu((current) => (current === "none" ? "root" : "none"));
                setShowHelp(false);
              }}
              active={menu !== "none"}
            >
              <SettingsIcon size={20} />
            </BarButton>

            {pipSupported ? (
              <BarButton label="Picture in picture" onClick={() => void togglePip()} className="hidden sm:inline-flex">
                <PipIcon size={19} />
              </BarButton>
            ) : null}

            <BarButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => void toggleFullscreen()}>
              {fullscreen ? <FullscreenExitIcon size={20} /> : <FullscreenIcon size={20} />}
            </BarButton>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------- settings */}
      {menu !== "none" ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Player settings"
          className="absolute bottom-16 right-2 z-10 max-h-[70%] w-60 overflow-y-auto rounded-lg py-1 text-[13px] shadow-lg sm:right-3"
          style={{ background: "rgba(20,20,26,0.97)", color: "#fff", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          {menu !== "root" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => setMenu("root")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left font-semibold hover:bg-white/10"
            >
              <ChevronLeftIcon size={16} /> Back
            </button>
          ) : null}

          {menu === "root" ? (
            <>
              <MenuRow
                icon={<QualityIcon size={17} />}
                label="Quality"
                value={hasQualityMenu ? qualityLabel ?? "Auto" : "Single rendition"}
                onClick={hasQualityMenu ? () => setMenu("quality") : undefined}
              />
              <MenuRow
                icon={<SettingsIcon size={17} />}
                label="Speed"
                value={`${speed}×`}
                onClick={() => setMenu("speed")}
              />
              {hasCaptions ? (
                <MenuRow
                  icon={<CaptionsIcon size={17} />}
                  label="Captions"
                  value={captionsOn ? captionTracks[activeCaptionIndex ?? 0]?.label ?? "On" : "Off"}
                  onClick={() => setMenu("captions")}
                />
              ) : null}
              <div className="my-1 h-px" style={{ background: "rgba(255,255,255,0.12)" }} />
              <MenuToggleRow
                icon={<AutoplayIcon size={17} />}
                label="Autoplay next"
                checked={autoplayNext}
                onClick={() => setAutoplay(!autoplayNext)}
              />
              <MenuToggleRow
                icon={<PlayIcon size={17} />}
                label="Autoplay"
                checked={autoplayPlayback}
                onClick={() => autoplayPlayPreference.write(!autoplayPlayback)}
              />
            </>
          ) : null}

          {menu === "speed" ? (
            <>
              {SPEEDS.map((value) => (
                <MenuRadioRow
                  key={value}
                  label={`${value}×${value === 1 ? " (normal)" : ""}`}
                  checked={value === speed}
                  onClick={() => {
                    setSpeedValue(value);
                    setMenu("none");
                  }}
                />
              ))}
            </>
          ) : null}

          {menu === "quality" ? (
            <>
              {renditions.map((rendition) => (
                <MenuRadioRow
                  key={rendition.src}
                  label={rendition.label}
                  checked={rendition.label === qualityLabel}
                  onClick={() => chooseQuality(rendition)}
                />
              ))}
              <p className="px-3 pt-1 pb-2 text-[11px] leading-snug opacity-60">
                Rendered from this video&apos;s stored renditions. Switching keeps your position.
              </p>
            </>
          ) : null}

          {menu === "captions" ? (
            <>
              <MenuRadioRow label="Off" checked={activeCaptionIndex === null} onClick={() => selectCaption(null)} />
              {captionTracks.map((track, index) => (
                <MenuRadioRow
                  key={`${track.label}-${index}`}
                  label={track.label}
                  checked={activeCaptionIndex === index}
                  onClick={() => selectCaption(index)}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {/* -------------------------------------------------------- shortcuts help */}
      {showHelp ? (
        <div
          className="absolute right-2 top-2 z-10 w-64 rounded-lg p-3 text-[12px] leading-relaxed shadow-lg sm:right-3 sm:top-3"
          style={{ background: "rgba(20,20,26,0.97)", color: "#fff", border: "1px solid rgba(255,255,255,0.12)" }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-semibold">Keyboard shortcuts</p>
            <button type="button" onClick={() => setShowHelp(false)} className="underline" aria-label="Close keyboard shortcuts">
              Close
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 opacity-90">
            <dt className="font-mono">space / k</dt>
            <dd>Play or pause</dd>
            <dt className="font-mono">j / l</dt>
            <dd>Back / forward 10s</dd>
            <dt className="font-mono">← / →</dt>
            <dd>Back / forward 5s</dd>
            <dt className="font-mono">↑ / ↓</dt>
            <dd>Volume</dd>
            <dt className="font-mono">m</dt>
            <dd>Mute</dd>
            <dt className="font-mono">f</dt>
            <dd>Fullscreen</dd>
            {hasCaptions ? (
              <>
                <dt className="font-mono">c</dt>
                <dd>Captions</dd>
              </>
            ) : null}
            <dt className="font-mono">, / .</dt>
            <dd>Slower / faster</dd>
            <dt className="font-mono">0–9</dt>
            <dd>Jump 0%–90%</dd>
          </dl>
        </div>
      ) : null}

      <p className="sr-only">
        Use space or K to play and pause, J and L to seek ten seconds, the arrow keys to seek five seconds and adjust
        volume, M to mute, F for fullscreen, and the number keys to jump through the video. The time readout is a
        button that switches between elapsed and remaining time.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

function BarButton({
  label,
  onClick,
  children,
  active = false,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70",
        active && "text-white",
        className,
      )}
      style={active ? { background: "rgba(255,255,255,0.18)" } : undefined}
    >
      {children}
    </button>
  );
}

function MenuRow({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  onClick?: () => void;
}) {
  if (!onClick) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 opacity-55" aria-disabled="true">
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
        {value ? <span className="ml-auto text-[11px]">{value}</span> : null}
      </div>
    );
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/10">
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {value ? <span className="ml-auto text-[11px] opacity-70">{value}</span> : null}
      <ChevronLeftIcon size={14} className="rotate-180 opacity-70" />
    </button>
  );
}

function MenuRadioRow({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/10"
    >
      <span className="grid w-4 place-items-center" aria-hidden="true">
        {checked ? <CheckIcon size={15} /> : null}
      </span>
      <span style={{ fontWeight: checked ? 700 : 400 }}>{label}</span>
    </button>
  );
}

function MenuToggleRow({
  icon,
  label,
  checked,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/10"
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <span
        className="ml-auto grid h-4 w-7 items-center rounded-full px-0.5"
        style={{ background: checked ? "var(--dt-brand)" : "rgba(255,255,255,0.28)" }}
        aria-hidden="true"
      >
        <span
          className="h-3 w-3 rounded-full bg-white transition-transform"
          style={{ transform: checked ? "translateX(12px)" : "translateX(0)" }}
        />
      </span>
    </button>
  );
}

/** mm:ss / h:mm:ss. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}

/**
 * Turn buffered ranges into positioned ranges between `0` and `duration`.
 *
 * Pure and defensive: a real `Video.buffered` (`TimeRanges`) is accepted, as is
 * a test double. Out-of-range values are clamped, empty/backwards ranges are
 * dropped, and a missing duration yields an empty list — so a caller never has
 * to guard, and the bar simply renders nothing when the browser reports
 * nothing. Reading the values never mutates the media element.
 */
export function computeBufferedRanges(
  buffered: TimeRangesLike | null | undefined,
  duration: number,
): BufferedRange[] {
  if (!buffered || buffered.length <= 0 || !Number.isFinite(duration) || duration <= 0) return [];
  const ranges: BufferedRange[] = [];
  for (let i = 0; i < buffered.length; i += 1) {
    const rawStart = buffered.start(i);
    const rawEnd = buffered.end(i);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(0, Math.min(rawStart, duration));
    const end = Math.max(0, Math.min(rawEnd, duration));
    if (end <= start) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * A viewer-facing explanation of a playback failure, chosen from the media
 * element's own state rather than a guess.
 *
 * The distinction the UI needs is *what failed*: a decode/format problem (this
 * source cannot be played here) is a different message from a transport problem
 * (the network failed), because the recovery differs. `networkState` is only
 * consulted when there is no `MediaError` — `NETWORK_NO_SOURCE` is the dead end
 * where the element settled with nothing playable. Unknown codes fall back to a
 * neutral, non-committal message rather than inventing a cause.
 */
export function describeMediaError(
  mediaErrorCode: number | null | undefined,
  networkState: number | null | undefined,
): string {
  switch (mediaErrorCode) {
    case 1: // MEDIA_ERR_ABORTED
      return "Loading was interrupted before the video could play. Check your connection, then retry.";
    case 2: // MEDIA_ERR_NETWORK
      return "The network failed while loading this video. Check your connection, then retry.";
    case 3: // MEDIA_ERR_DECODE
      return "This video could not be decoded by your browser. The file may be damaged.";
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return "This source could not be played. The file may be missing, or your browser does not support its format.";
    default:
      break;
  }
  if (networkState === 3) {
    // NETWORK_NO_SOURCE — the element found nothing it could load.
    return "This source could not be played. The file may be missing, or your browser does not support its format.";
  }
  if (networkState === 2) {
    // NETWORK_LOADING with no MediaError — treat as a transport failure.
    return "The network failed while loading this video. Check your connection, then retry.";
  }
  return "This video could not be played. Retry to load it again.";
}
