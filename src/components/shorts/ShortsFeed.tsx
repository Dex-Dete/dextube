"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { Avatar } from "@/components/Avatar";
import { mediaUrl, streamUrl } from "@/lib/media-url";
import { formatCount, formatRelativeTime } from "@/lib/format";
import { CommentIcon, DislikeIcon, LikeIcon, ShareIcon, VolumeIcon } from "@/components/icons";

/**
 * Shape of a Short as returned by `/api/shorts` and the server service. Kept
 * as a local structural type so this client component never imports server
 * code.
 */
export interface ShortItemDTO {
  id: string;
  title: string;
  durationSec: number;
  playbackKey: string | null;
  posterKey: string | null;
  thumbnailKey: string | null;
  width: number | null;
  height: number | null;
  viewCount: number;
  likeCount: number;
  publishedAt: string;
  channel: { id: string; handle: string; name: string; avatarKey: string | null };
  viewer: { reaction: "LIKE" | "DISLIKE" | null; subscribed: boolean } | null;
}

export interface ShortsFeedProps {
  initialItems: ShortItemDTO[];
  initialCursor: string | null;
  signedIn: boolean;
}

/** Playback seconds after which a view counts as real. */
const VIEW_AFTER_SECONDS = 3;

/**
 * A vertically paged Shorts player.
 *
 * One short fills the viewport and snapping moves between them. The visible
 * slide autoplays (muted, as every browser requires) and the others are paused,
 * so at most one video ever decodes at a time. Every control is real: like,
 * dislike, subscribe, share, mute, comments and "next/previous" all hit the
 * same APIs the rest of the site uses. New shorts stream in as the viewer
 * approaches the end of the loaded page.
 */
export function ShortsFeed({ initialItems, initialCursor, signedIn }: ShortsFeedProps) {
  const [items, setItems] = useState<ShortItemDTO[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [activeId, setActiveId] = useState<string | null>(initialItems[0]?.id ?? null);
  const [muted, setMuted] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const slideRefs = useRef(new Map<string, HTMLElement>());
  const viewSent = useRef(new Set<string>());

  // Per-item interactive state, seeded from the server payload.
  const [reactions, setReactions] = useState<Record<string, "LIKE" | "DISLIKE" | null>>(() =>
    Object.fromEntries(initialItems.map((item) => [item.id, item.viewer?.reaction ?? null])),
  );
  const [likes, setLikes] = useState<Record<string, number>>(() =>
    Object.fromEntries(initialItems.map((item) => [item.id, item.likeCount])),
  );
  const [subs, setSubs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialItems.map((item) => [item.channel.handle, item.viewer?.subscribed ?? false])),
  );

  /* ------------------------------------------------------ active slide detection */
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const id = (entry.target as HTMLElement).dataset.videoId;
            if (id) setActiveId(id);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    for (const el of slideRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  /* --------------------------------------------------- play only the active slide */
  useEffect(() => {
    for (const [id, el] of slideRefs.current) {
      const video = el.querySelector("video");
      if (!video) continue;
      if (id === activeId) void video.play().catch(() => {});
      else video.pause();
    }
  }, [activeId, items]);

  /* ------------------------------------------------------------- mute propagation */
  useEffect(() => {
    for (const el of slideRefs.current.values()) {
      const video = el.querySelector("video");
      if (video) video.muted = muted;
    }
  }, [muted, items]);

  /* ------------------------------------------------------------ infinite loading */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.get<{ items: ShortItemDTO[]; nextCursor: string | null }>(
        `/api/shorts?cursor=${encodeURIComponent(cursor)}&limit=10`,
      );
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [...previous, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.nextCursor);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load more Shorts.");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  // Fetch the next page once the viewer reaches the last loaded short. The
  // fetch is deferred by a task because `loadMore` flips the loading flag
  // synchronously; updating state straight from an effect body would cascade a
  // second render before the browser paints.
  useEffect(() => {
    if (!cursor) return;
    const last = items[items.length - 1];
    if (!activeId || !last || activeId !== last.id) return;
    const timer = setTimeout(() => void loadMore(), 0);
    return () => clearTimeout(timer);
  }, [activeId, items, cursor, loadMore]);

  /* ------------------------------------------------------------ keyboard paging */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)) return;
      event.preventDefault();
      const index = items.findIndex((item) => item.id === activeId);
      if (index < 0) return;
      const nextIndex = event.key === "ArrowDown" || event.key === "j" ? index + 1 : index - 1;
      const next = items[nextIndex];
      if (next) slideRefs.current.get(next.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, items]);

  /* ------------------------------------------------------------------- actions */
  async function react(id: string, value: "LIKE" | "DISLIKE") {
    if (!signedIn) {
      setNotice("Sign in to like Shorts.");
      return;
    }
    const current = reactions[id] ?? null;
    const clearing = current === value;
    const snapshot = { reaction: current, count: likes[id] ?? 0 };
    setNotice(null);
    setReactions((state) => ({ ...state, [id]: clearing ? null : value }));
    setLikes((state) => ({
      ...state,
      [id]: Math.max(0, (state[id] ?? 0) + (clearing ? (current === "LIKE" ? -1 : 0) : value === "LIKE" && current !== "LIKE" ? 1 : 0)),
    }));
    try {
      const result = clearing
        ? await api.del<{ reaction: "LIKE" | "DISLIKE" | null; likeCount: number }>(`/api/videos/${id}/reaction`)
        : await api.put<{ reaction: "LIKE" | "DISLIKE" | null; likeCount: number }>(`/api/videos/${id}/reaction`, { value });
      setReactions((state) => ({ ...state, [id]: result.reaction }));
      setLikes((state) => ({ ...state, [id]: result.likeCount }));
    } catch (error) {
      setReactions((state) => ({ ...state, [id]: snapshot.reaction }));
      setLikes((state) => ({ ...state, [id]: snapshot.count }));
      setNotice(error instanceof Error ? error.message : "Could not save your reaction.");
    }
  }

  async function toggleSubscribe(handle: string) {
    if (!signedIn) {
      setNotice("Sign in to subscribe.");
      return;
    }
    const next = !subs[handle];
    setSubs((state) => ({ ...state, [handle]: next }));
    try {
      const result = await api[next ? "post" : "del"]<{ subscribed: boolean }>(
        `/api/channels/${encodeURIComponent(handle)}/subscribe`,
        next ? {} : undefined,
      );
      setSubs((state) => ({ ...state, [handle]: result.subscribed }));
    } catch (error) {
      setSubs((state) => ({ ...state, [handle]: !next }));
      setNotice(error instanceof Error ? error.message : "Could not update your subscription.");
    }
  }

  async function share(id: string, title: string) {
    const url = `${window.location.origin}/shorts/${id}`;
    try {
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
      if ((error as { name?: string })?.name !== "AbortError") setNotice(url);
    }
  }

  function recordViewIfWatched(id: string, el: HTMLVideoElement) {
    if (el.currentTime < VIEW_AFTER_SECONDS || viewSent.current.has(id)) return;
    viewSent.current.add(id);
    // Fire and forget: a failed view ping must never disturb playback.
    void api.post(`/api/videos/${id}/view`).catch(() => {});
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[calc(100dvh-var(--dt-header-h))] flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-bold">No Shorts yet</h1>
        <p className="max-w-md text-sm text-muted">
          Shorts are vertical videos under three minutes. When creators publish one it will appear here.
        </p>
        <Link href="/" className="dt-btn dt-btn-secondary">
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[calc(100dvh-var(--dt-header-h))] snap-y snap-mandatory overflow-y-auto overscroll-y-contain bg-black"
        aria-label="Shorts feed"
      >
        {items.map((item) => {
          const src = streamUrl(item.playbackKey);
          const poster = mediaUrl(item.posterKey ?? item.thumbnailKey);
          const reaction = reactions[item.id] ?? null;
          const subscribed = subs[item.channel.handle] ?? false;

          return (
            <section
              key={item.id}
              data-video-id={item.id}
              ref={(el) => {
                if (el) slideRefs.current.set(item.id, el);
                else slideRefs.current.delete(item.id);
              }}
              className="relative flex h-[calc(100dvh-var(--dt-header-h))] snap-start items-center justify-center"
            >
              {src ? (
                <video
                  src={src}
                  poster={poster ?? undefined}
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  controls={false}
                  onClick={(event) => {
                    const el = event.currentTarget;
                    if (el.paused) void el.play().catch(() => {});
                    else el.pause();
                  }}
                  onTimeUpdate={(event) => recordViewIfWatched(item.id, event.currentTarget)}
                  className="h-full max-h-full w-auto max-w-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 text-center" style={{ color: "#fff" }}>
                  <p className="text-sm font-semibold">This Short is still processing</p>
                  <p className="text-xs opacity-70">Check back once the upload finishes.</p>
                </div>
              )}

              {/* Top-right mute toggle: needed because autoplay must start muted. */}
              <button
                type="button"
                onClick={() => setMuted((value) => !value)}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={!muted}
                className="absolute right-3 top-3 rounded-full p-2"
                style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                <VolumeIcon size={18} level={muted ? 0 : 1} />
              </button>

              {/* Bottom overlay: channel + title + subscribe. */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4"
                style={{ background: "linear-gradient(to top, rgba(0,0,0,0.78), transparent)" }}
              >
                <div className="pointer-events-auto min-w-0 max-w-[75%]" style={{ color: "#fff" }}>
                  <div className="flex items-center gap-2">
                    <Link href={`/channel/${item.channel.handle}`}>
                      <Avatar
                        name={item.channel.name}
                        seed={item.channel.id}
                        src={mediaUrl(item.channel.avatarKey)}
                        size={34}
                      />
                    </Link>
                    <Link href={`/channel/${item.channel.handle}`} className="truncate text-sm font-semibold">
                      {item.channel.name}
                    </Link>
                    <button
                      type="button"
                      onClick={() => void toggleSubscribe(item.channel.handle)}
                      aria-pressed={subscribed}
                      className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                      style={{ background: subscribed ? "rgba(255,255,255,0.22)" : "#fff", color: subscribed ? "#fff" : "#000" }}
                    >
                      {subscribed ? "Subscribed" : "Subscribe"}
                    </button>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm">{item.title}</p>
                  <p className="mt-1 text-[11px] opacity-80">
                    {formatCount(item.viewCount)} views · {formatRelativeTime(item.publishedAt)}
                  </p>
                </div>

                {/* Right action rail. */}
                <div className="pointer-events-auto flex flex-col items-center gap-4 pb-1" style={{ color: "#fff" }}>
                  <RailButton
                    label={reaction === "LIKE" ? "Unlike" : "Like"}
                    onClick={() => void react(item.id, "LIKE")}
                    count={likes[item.id] ?? item.likeCount}
                  >
                    <LikeIcon size={24} filled={reaction === "LIKE"} />
                  </RailButton>
                  <RailButton
                    label={reaction === "DISLIKE" ? "Remove dislike" : "Dislike"}
                    onClick={() => void react(item.id, "DISLIKE")}
                  >
                    <DislikeIcon size={24} filled={reaction === "DISLIKE"} />
                  </RailButton>
                  <RailButton label="Comments" href={`/watch/${item.id}`}>
                    <CommentIcon size={24} />
                  </RailButton>
                  <RailButton label="Share" onClick={() => void share(item.id, item.title)}>
                    <ShareIcon size={24} />
                  </RailButton>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {loadingMore && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] font-medium"
          style={{ background: "rgba(0,0,0,0.75)", color: "#fff" }}
        >
          Loading more…
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="absolute bottom-4 right-4 rounded-md px-3 py-1.5 text-[11px]"
          style={{ background: "rgba(0,0,0,0.8)", color: "#fff" }}
        >
          {notice}
        </p>
      )}

      {!signedIn && (
        <p
          className="absolute left-4 top-4 rounded-md px-3 py-1.5 text-[11px]"
          style={{ background: "rgba(0,0,0,0.65)", color: "#fff" }}
        >
          <Link href="/login" className="underline">
            Sign in
          </Link>{" "}
          to like and subscribe.
        </p>
      )}
    </div>
  );
}

function RailButton({
  label,
  onClick,
  href,
  count,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  count?: number;
  children: React.ReactNode;
}) {
  const inner = (
    <>
      <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: "rgba(0,0,0,0.5)" }}>
        {children}
      </span>
      {typeof count === "number" && <span className="text-[11px] font-semibold">{formatCount(count)}</span>}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-label={label} className="flex flex-col items-center gap-0.5 hover:opacity-85">
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-label={label} className="flex flex-col items-center gap-0.5 hover:opacity-85">
      {inner}
    </button>
  );
}
