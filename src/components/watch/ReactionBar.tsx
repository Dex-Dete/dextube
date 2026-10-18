"use client";

import { useState } from "react";
import { api, apiFetch } from "@/lib/api-client";
import { formatCount } from "@/lib/format";
import { CheckIcon, DislikeIcon, DownloadIcon, LikeIcon, ShareIcon, WatchLaterIcon } from "@/components/icons";

export interface ReactionBarProps {
  videoId: string;
  title: string;
  initialReaction: "LIKE" | "DISLIKE" | null;
  likeCount: number;
  dislikeCount: number;
  /** Whether the video is already in the viewer's Watch later list. */
  initialWatchLater: boolean;
  signedIn: boolean;
  /** Direct URL used by the download action. */
  downloadUrl: string | null;
}

/**
 * The row under the player: like, dislike, share, save and download.
 *
 * Every control either performs a real action or tells the user exactly why it
 * cannot (for example: sign in). Nothing here is decorative. Reaction and
 * "Watch later" state use optimistic updates with server reconciliation, which
 * matters because these buttons invite rapid repeated clicks.
 */
export function ReactionBar({
  videoId,
  title,
  initialReaction,
  likeCount,
  dislikeCount,
  initialWatchLater,
  signedIn,
  downloadUrl,
}: ReactionBarProps) {
  const [reaction, setReaction] = useState(initialReaction);
  const [likes, setLikes] = useState(likeCount);
  const [dislikes, setDislikes] = useState(dislikeCount);
  const [watchLater, setWatchLater] = useState(initialWatchLater);
  const [pending, setPending] = useState<null | "reaction" | "save" | "share">(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function react(value: "LIKE" | "DISLIKE") {
    if (!signedIn) {
      setNotice("Sign in to like videos.");
      return;
    }
    if (pending) return;
    setPending("reaction");
    setNotice(null);

    const snapshot = { reaction, likes, dislikes };
    // Optimistic: the server value replaces this when it responds.
    const clearing = reaction === value;
    setReaction(clearing ? null : value);
    setLikes((n) => n - (reaction === "LIKE" ? 1 : 0) + (!clearing && value === "LIKE" ? 1 : 0));
    setDislikes((n) => n - (reaction === "DISLIKE" ? 1 : 0) + (!clearing && value === "DISLIKE" ? 1 : 0));

    try {
      const result = clearing
        ? await api.del<{ reaction: "LIKE" | "DISLIKE" | null; likeCount: number; dislikeCount: number }>(
            `/api/videos/${videoId}/reaction`,
          )
        : await api.put<{ reaction: "LIKE" | "DISLIKE" | null; likeCount: number; dislikeCount: number }>(
            `/api/videos/${videoId}/reaction`,
            { value },
          );
      setReaction(result.reaction);
      setLikes(result.likeCount);
      setDislikes(result.dislikeCount);
    } catch (error) {
      setReaction(snapshot.reaction);
      setLikes(snapshot.likes);
      setDislikes(snapshot.dislikes);
      setNotice(error instanceof Error ? error.message : "Could not save your reaction.");
    } finally {
      setPending(null);
    }
  }

  async function toggleWatchLater() {
    if (!signedIn) {
      setNotice("Sign in to save videos.");
      return;
    }
    if (pending) return;
    const next = !watchLater;
    setWatchLater(next);
    setPending("save");
    setNotice(next ? "Saved to Watch later." : "Removed from Watch later.");
    try {
      // A system playlist is addressed by its kind, so the same endpoint serves
      // Watch later, Liked videos and any user-created playlist.
      const path = next
        ? `/api/playlists/watch_later/items`
        : `/api/playlists/watch_later/items?videoId=${encodeURIComponent(videoId)}`;
      await apiFetch(path, {
        method: next ? "PUT" : "DELETE",
        ...(next ? { body: JSON.stringify({ videoId }) } : {}),
      });
    } catch (error) {
      setWatchLater(!next);
      setNotice(error instanceof Error ? error.message : "Could not update Watch later.");
    } finally {
      setPending(null);
    }
  }

  async function share() {
    setPending("share");
    setNotice(null);
    const url = `${window.location.origin}/watch/${videoId}`;
    try {
      // The Web Share API is unavailable on desktop Firefox/Safari, so fall
      // back to copying the link and telling the user what happened.
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title, url });
        setNotice("Shared.");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setNotice("Link copied to your clipboard.");
      } else {
        setNotice(url);
      }
    } catch (error) {
      // A user cancelling the share sheet is not an error worth shouting about.
      if ((error as { name?: string })?.name !== "AbortError") {
        setNotice(url);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex items-center overflow-hidden rounded-full"
          style={{ background: "var(--dt-surface-2)" }}
        >
          <button
            type="button"
            onClick={() => void react("LIKE")}
            aria-pressed={reaction === "LIKE"}
            aria-label="Like"
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold hover:bg-black/5"
          >
            <LikeIcon size={19} filled={reaction === "LIKE"} />
            {formatCount(likes)}
          </button>
          <span aria-hidden="true" className="h-6 w-px" style={{ background: "var(--dt-border)" }} />
          <button
            type="button"
            onClick={() => void react("DISLIKE")}
            aria-pressed={reaction === "DISLIKE"}
            aria-label="Dislike"
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold hover:bg-black/5"
          >
            <DislikeIcon size={19} filled={reaction === "DISLIKE"} />
            {formatCount(dislikes)}
          </button>
        </div>

        <button type="button" onClick={() => void share()} disabled={pending === "share"} className="dt-btn dt-btn-secondary">
          <ShareIcon size={17} /> Share
        </button>

        <button
          type="button"
          onClick={() => void toggleWatchLater()}
          disabled={pending === "save"}
          aria-pressed={watchLater}
          className="dt-btn dt-btn-secondary"
        >
          {watchLater ? <CheckIcon size={17} /> : <WatchLaterIcon size={17} />}
          {watchLater ? "Saved" : "Save"}
        </button>

        {downloadUrl ? (
          <a href={downloadUrl} download className="dt-btn dt-btn-secondary">
            <DownloadIcon size={17} /> Download
          </a>
        ) : (
          <span
            className="dt-btn dt-btn-secondary cursor-not-allowed opacity-60"
            title="The original file is not available for download."
            aria-disabled="true"
          >
            <DownloadIcon size={17} /> Download
          </span>
        )}
      </div>

      {!signedIn && (
        <p className="text-xs text-subtle">
          <a href="/login" className="underline">
            Sign in
          </a>{" "}
          to like, save and comment.
        </p>
      )}

      {notice && (
        <p role="status" className="text-xs text-muted">
          {notice}
        </p>
      )}
    </div>
  );
}
