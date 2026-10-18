"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api-client";
import { EyeOffIcon, MenuIcon } from "@/components/icons";

export interface VideoCardMenuProps {
  videoId: string;
  channelId: string;
  channelName: string;
  /** Where the button sits, so the two card layouts can place it sensibly. */
  align?: "top" | "inline";
}

interface FeedbackResponse {
  action: string;
  dismissals: number;
  hiddenChannels: number;
}

type Pending = "not_interested" | "hide_channel" | null;

/**
 * The "not interested" control on a feed card.
 *
 * Two real, reversible choices: dismiss one video, or ask not to be recommended
 * this channel. Both are stored server-side as the viewer's own feedback and
 * both take effect on the next ranked request — the component is not pretending
 * to filter anything locally.
 *
 * After a choice the card swaps itself for a compact confirmation with an Undo
 * action, so the decision is visible and immediately reversible. Undo issues the
 * matching DELETE rather than optimistically assuming success.
 */
export function VideoCardMenu({ videoId, channelId, channelName, align = "top" }: VideoCardMenuProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [hidden, setHidden] = useState<null | "video" | "channel">(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const submit = useCallback(
    async (action: "not_interested" | "hide_channel") => {
      setPending(action);
      setError(null);
      try {
        await api.post<FeedbackResponse>("/api/feed/feedback", {
          action,
          ...(action === "not_interested" ? { videoId } : { channelId }),
        });
        setHidden(action === "not_interested" ? "video" : "channel");
        setOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save that preference.");
      } finally {
        setPending(null);
      }
    },
    [channelId, videoId],
  );

  const undo = useCallback(async () => {
    setPending(hidden === "video" ? "not_interested" : "hide_channel");
    setError(null);
    try {
      const query = hidden === "video" ? `videoId=${encodeURIComponent(videoId)}` : `channelId=${encodeURIComponent(channelId)}`;
      await api.del<FeedbackResponse>(`/api/feed/feedback?${query}`);
      setHidden(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not undo that preference.");
    } finally {
      setPending(null);
    }
  }, [channelId, hidden, videoId]);

  if (hidden) {
    return (
      <div
        className="dt-card flex items-center justify-between gap-3 px-3 py-3 text-xs"
        role="status"
      >
        <span className="text-muted">
          {hidden === "video" ? "Hidden from your recommendations." : `You will not be recommended ${channelName}.`}
        </span>
        <button
          type="button"
          onClick={() => void undo()}
          disabled={pending !== null}
          className="dt-link shrink-0 font-semibold disabled:opacity-60"
        >
          {pending ? "Undoing…" : "Undo"}
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More options for this video`}
        title="More options"
        className={clsx(
          "dt-icon-btn h-8 w-8",
          align === "top" && "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
        )}
      >
        <MenuIcon size={18} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Video options"
          className="dt-card absolute right-0 z-20 mt-1 w-64 overflow-hidden py-1 text-[13px] shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void submit("not_interested")}
            disabled={pending !== null}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-60"
          >
            <EyeOffIcon size={16} />
            {pending === "not_interested" ? "Hiding…" : "Not interested"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void submit("hide_channel")}
            disabled={pending !== null}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-60"
          >
            <ChannelOffIcon />
            {pending === "hide_channel" ? "Hiding…" : `Don't recommend ${channelName}`}
          </button>
          {error ? (
            <p className="px-3 pb-1 pt-2 text-[11px] text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A channel with a slash through it: "don't recommend this channel". */
function ChannelOffIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 10.5-6.1" />
      <path d="M15 18.5l5 5M20 18.5l-5 5" />
    </svg>
  );
}
