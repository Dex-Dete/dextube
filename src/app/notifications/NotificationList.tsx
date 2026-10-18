"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api-client";
import { mediaUrl } from "@/lib/media-url";
import { formatRelativeTime } from "@/lib/format";
import {
  BellIcon,
  CommentIcon,
  LikeIcon,
  PlayIcon,
  SparkIcon,
  SubscriptionsIcon,
} from "@/components/icons";

export interface NotificationRowDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string;
  isRead: boolean;
  createdAt: string;
  actorAvatarKey: string | null;
}

function iconFor(type: string) {
  switch (type) {
    case "NEW_VIDEO":
      return <PlayIcon size={16} />;
    case "COMMENT_REPLY":
      return <CommentIcon size={16} />;
    case "COMMENT_LIKE":
    case "VIDEO_LIKE":
      return <LikeIcon size={16} />;
    case "NEW_SUBSCRIBER":
      return <SubscriptionsIcon size={16} />;
    default:
      return <SparkIcon size={16} />;
  }
}

/**
 * Notification list with paging and read-state management.
 *
 * Marking read is a real POST scoped to the signed-in user; opening a
 * notification also marks it read, which is what users expect and keeps the
 * header badge in step.
 */
export function NotificationList({
  initialItems,
  initialNextCursor,
}: {
  initialItems: NotificationRowDTO[];
  initialNextCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unread = items.filter((n) => !n.isRead).length;

  const loadMore = useCallback(async () => {
    if (cursor === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: NotificationRowDTO[]; nextCursor: string | null }>(
        `/api/notifications?limit=30&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => {
        const seen = new Set(current.map((n) => n.id));
        return [...current, ...data.items.filter((n) => !seen.has(n.id))];
      });
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more notifications.");
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  const markAllRead = useCallback(async () => {
    const snapshot = items;
    setItems((current) => current.map((n) => ({ ...n, isRead: true })));
    try {
      await api.post("/api/notifications/read", {});
    } catch (e) {
      setItems(snapshot);
      setError(e instanceof Error ? e.message : "Could not mark notifications as read.");
    }
  }, [items]);

  function markReadLocally(id: string) {
    setItems((current) => current.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    // Fire and forget: the badge is corrected on the next full page load.
    void api.post("/api/notifications/read", { ids: [id] }).catch(() => {});
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-subtle">
          {unread > 0 ? `${unread} unread` : "All caught up"}
        </p>
        {unread > 0 && (
          <button type="button" className="dt-link text-xs" onClick={() => void markAllRead()}>
            Mark all as read
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {items.map((row) => (
          <li key={row.id}>
            <Link
              href={row.url}
              onClick={() => markReadLocally(row.id)}
              className="flex items-start gap-3 rounded-lg p-3 hover:bg-surface-2"
              style={!row.isRead ? { background: "var(--dt-surface-2)" } : undefined}
            >
              <Avatar name="DEXTube" seed={row.actorAvatarKey ?? row.id} src={mediaUrl(row.actorAvatarKey)} size={40} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-subtle">{iconFor(row.type)}</span>
                  <span className="text-sm font-semibold">{row.title}</span>
                </span>
                {row.body && <span className="mt-0.5 block text-sm text-muted">{row.body}</span>}
                <span className="mt-0.5 block text-xs text-subtle">{formatRelativeTime(row.createdAt)}</span>
              </span>
              {!row.isRead && (
                <span
                  className="mt-2 inline-block h-2 w-2 shrink-0 rounded-full"
                  aria-label="Unread"
                  style={{ background: "var(--dt-brand)" }}
                />
              )}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex justify-center">
        {loading && <p className="text-sm text-subtle">Loading more…</p>}
        {!loading && cursor !== null && (
          <button type="button" className="dt-btn dt-btn-secondary" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
        {!loading && cursor === null && (
          <p className="flex items-center gap-1 text-xs text-subtle">
            <BellIcon size={12} /> End of notifications
          </p>
        )}
      </div>
    </div>
  );
}
