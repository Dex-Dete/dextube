"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VideoCard, type VideoCardProps } from "@/components/video/VideoCard";
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
      <div className={gridClass}>
        {items.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>

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

function DefaultEmpty() {
  return (
    <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
      <p className="text-base font-semibold">Nothing here yet</p>
      <p className="max-w-md text-sm text-muted">Published videos will show up in this list.</p>
    </div>
  );
}
