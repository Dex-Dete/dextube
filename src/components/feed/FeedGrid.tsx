"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { VideoCard, type VideoCardProps } from "@/components/video/VideoCard";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/ui";
import { mediaUrl } from "@/lib/media-url";
import { api } from "@/lib/api-client";

export interface FeedResponse {
  items: VideoCardProps["video"][];
  nextCursor?: string | null;
  nextOffset?: number | null;
}

export interface FeedGridProps {
  /** Items rendered by the server on first paint (progressive enhancement). */
  initialItems: VideoCardProps["video"][];
  /** Endpoint that returns the next page. Cursor/offset are appended. */
  endpoint: string;
  initialCursor?: string | null;
  initialOffset?: number | null;
  /** Pagination flavour: keyset cursor or ranked-feed offset. */
  mode?: "cursor" | "offset";
  limit?: number;
  emptyState?: React.ReactNode;
  columns?: 1 | 2 | 3 | 4;
  /**
   * Presentation of the loaded items. All three share the same pagination and
   * de-duplication so a page only chooses the shape that fits its content:
   * `grid` (default), `ranked` (a numbered list, used by Trending) and
   * `grouped` (videos bucketed under a channel heading, used by Subscriptions).
   */
  variant?: "grid" | "ranked" | "grouped";
  /**
   * Offer the per-card recommendation controls. The home feed sets this when a
   * viewer is signed in, because that is the only place a dismissal changes
   * what is shown.
   */
  recommendationControls?: boolean;
}

/**
 * Client-side "load more" grid.
 *
 * The first page is server-rendered, so the feed works without JavaScript;
 * additional pages are fetched on demand. An `IntersectionObserver` triggers
 * loading when the sentinel scrolls into view, with an explicit button
 * fallback for keyboard and reduced-motion users.
 */
export function FeedGrid({
  initialItems,
  endpoint,
  initialCursor = null,
  initialOffset = null,
  mode = "cursor",
  limit = 24,
  emptyState,
  columns = 3,
  variant = "grid",
  recommendationControls = false,
}: FeedGridProps) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [offset, setOffset] = useState(initialOffset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Reset to a fresh server payload (a `router.refresh()` re-renders the parent
  // component with new props). Adjusting state during render is the documented
  // React alternative to a syncing effect, and it avoids the extra paint an
  // effect would cost. The identity check on `initialItems` is what makes it
  // terminate.
  const [synced, setSynced] = useState({ items: initialItems, cursor: initialCursor, offset: initialOffset });
  if (synced.items !== initialItems || synced.cursor !== initialCursor || synced.offset !== initialOffset) {
    setSynced({ items: initialItems, cursor: initialCursor, offset: initialOffset });
    setItems(initialItems);
    setCursor(initialCursor);
    setOffset(initialOffset);
    setError(null);
  }

  const hasMore = mode === "offset" ? offset !== null : cursor !== null;

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("limit", String(limit));
      if (mode === "offset") url.searchParams.set("offset", String(offset ?? 0));
      else if (cursor) url.searchParams.set("cursor", cursor);

      const data = await api.get<FeedResponse>(url.pathname + url.search);
      const fresh = data.items ?? [];

      // De-duplicate defensively: a ranked feed can shift between requests.
      setItems((current) => {
        const seen = new Set(current.map((v) => v.id));
        return [...current, ...fresh.filter((v) => !seen.has(v.id))];
      });

      if (mode === "offset") {
        const next = data.nextOffset ?? null;
        setOffset(next);
      } else {
        setCursor(data.nextCursor ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more videos.");
    } finally {
      setLoading(false);
    }
  }, [cursor, endpoint, hasMore, limit, loading, mode, offset]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const gridClass =
    columns === 4
      ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
      : columns === 2
        ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2"
        : "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3";

  if (items.length === 0) {
    return <>{emptyState ?? <DefaultEmpty />}</>;
  }

  return (
    <div>
      {variant === "ranked" ? (
        <RankedList items={items} />
      ) : variant === "grouped" ? (
        <GroupedByChannel items={items} columns={columns} />
      ) : (
        <div className={gridClass}>
          {items.map((video) => (
            <VideoCard key={video.id} video={video} recommendationControls={recommendationControls} />
          ))}
        </div>
      )}

      <div ref={sentinel} aria-hidden="true" className="h-1" />

      <div className="mt-8 flex flex-col items-center gap-2">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading && <p className="text-sm text-subtle">Loading more…</p>}
        {!loading && hasMore && (
          <button type="button" onClick={() => void loadMore()} className="dt-btn dt-btn-secondary">
            Load more
          </button>
        )}
        {!hasMore && items.length > 0 && (
          <p className="py-4 text-xs text-subtle">You have reached the end of this list.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Trending's presentation: one numbered row per video. The rank is part of the
 * ordered-list semantics, so it is decorative on screen (readers announce the
 * position from the `<ol>`) rather than a second, unlabelled number.
 */
function RankedList({ items }: { items: VideoCardProps["video"][] }) {
  return (
    <ol className="flex flex-col divide-y divide-line">
      {items.map((video, index) => (
        <li key={video.id} className="flex items-start gap-4 py-4 first:pt-0">
          <span
            aria-hidden="true"
            className="w-6 shrink-0 pt-0.5 text-right text-lg font-bold tabular-nums text-subtle"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <VideoCard video={video} variant="list" />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Subscriptions' presentation: videos bucketed by channel in the order each
 * channel first appears. Recomputing groups from the combined item list means
 * "load more" drops later uploads into the right heading instead of starting a
 * second flat grid.
 */
function GroupedByChannel({
  items,
  columns,
}: {
  items: VideoCardProps["video"][];
  columns: 1 | 2 | 3 | 4;
}) {
  const groups: { channel: VideoCardProps["video"]["channel"]; videos: VideoCardProps["video"][] }[] = [];
  const byId = new Map<string, (typeof groups)[number]>();
  for (const video of items) {
    let group = byId.get(video.channel.id);
    if (!group) {
      group = { channel: video.channel, videos: [] };
      byId.set(video.channel.id, group);
      groups.push(group);
    }
    group.videos.push(video);
  }

  const gridClass =
    columns === 4
      ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
      : columns === 2
        ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2"
        : "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div className="flex flex-col gap-9">
      {groups.map(({ channel, videos }) => (
        <section key={channel.id} aria-label={`Videos from ${channel.name}`}>
          <div className="mb-4 flex items-center gap-3">
            <Link href={`/channel/${channel.handle}`} aria-label={`${channel.name} channel`}>
              <Avatar name={channel.name} seed={channel.id} src={mediaUrl(channel.avatarKey)} size={36} />
            </Link>
            <div className="min-w-0">
              <Link href={`/channel/${channel.handle}`} className="block truncate font-semibold hover:text-brand">
                {channel.name}
              </Link>
              <p className="text-xs text-subtle">
                {videos.length} {videos.length === 1 ? "video" : "videos"}
              </p>
            </div>
          </div>
          <div className={gridClass}>
            {videos.map((video) => (
              <VideoCard key={video.id} video={video} hideChannel />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DefaultEmpty() {
  return <EmptyState title="Nothing here yet" description="Published videos will show up in this list." />;
}
