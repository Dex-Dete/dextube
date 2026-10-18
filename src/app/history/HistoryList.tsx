"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { api } from "@/lib/api-client";
import { mediaUrl } from "@/lib/media-url";
import { countLabel, formatDuration, formatRelativeTime } from "@/lib/format";
import { CloseIcon, HistoryIcon } from "@/components/icons";

export interface HistoryEntryDTO {
  video: {
    id: string;
    title: string;
    isShort: boolean;
    durationSec: number;
    thumbnailKey: string | null;
    publishedAt: string | null;
    viewCount: number;
    channel: { id: string; handle: string; name: string; avatarKey: string | null };
  };
  watchedAt: string;
  seconds: number;
  progressRatio: number;
}

/**
 * The full history list with per-entry removal and a "clear all" action.
 *
 * Both actions hit the real API; failures restore the previous list and surface
 * an error rather than pretending the change succeeded.
 */
export function HistoryList({
  initialItems,
  initialNextCursor,
}: {
  initialItems: HistoryEntryDTO[];
  initialNextCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (cursor === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ items: HistoryEntryDTO[]; nextCursor: string | null }>(
        `/api/history?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => {
        const seen = new Set(current.map((e) => e.video.id));
        return [...current, ...data.items.filter((e) => !seen.has(e.video.id))];
      });
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more history.");
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  async function remove(videoId: string) {
    const snapshot = items;
    setBusyId(videoId);
    setItems((current) => current.filter((e) => e.video.id !== videoId));
    try {
      await api.del(`/api/history/${encodeURIComponent(videoId)}`);
    } catch (e) {
      setItems(snapshot);
      setError(e instanceof Error ? e.message : "Could not remove that entry.");
    } finally {
      setBusyId(null);
    }
  }

  async function clearAll() {
    if (!window.confirm("Clear your entire watch history? This cannot be undone.")) return;
    const snapshot = items;
    setLoading(true);
    setItems([]);
    try {
      await api.del("/api/history");
      setCursor(null);
    } catch (e) {
      setItems(snapshot);
      setError(e instanceof Error ? e.message : "Could not clear your history.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-subtle">All history</h2>
        <button type="button" className="dt-btn dt-btn-secondary !px-3 !py-1.5 text-xs" onClick={() => void clearAll()}>
          Clear all history
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {items.map((entry) => {
          const video = entry.video;
          const href = video.isShort ? `/shorts/${video.id}` : `/watch/${video.id}`;
          return (
            <li key={video.id} className="flex items-center gap-3">
              <Link href={href} className="relative block w-[150px] shrink-0 overflow-hidden rounded-lg dt-aspect-video" style={{ background: "var(--dt-surface-2)" }}>
                {video.thumbnailKey && (
                  <img src={mediaUrl(video.thumbnailKey)!} alt="" loading="lazy" className="h-full w-full object-cover" />
                )}
                <span
                  className="absolute bottom-1 right-1 rounded px-1 py-0.5 text-[11px] font-semibold tabular-nums"
                  style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
                >
                  {formatDuration(video.durationSec)}
                </span>
                {entry.progressRatio > 0 && (
                  <span className="absolute inset-x-0 bottom-0 h-1" style={{ background: "rgba(255,255,255,0.35)" }}>
                    <span
                      className="block h-full"
                      style={{ width: `${Math.round(entry.progressRatio * 100)}%`, background: "var(--dt-brand)" }}
                    />
                  </span>
                )}
              </Link>
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
                  <Link href={href}>{video.title}</Link>
                </h3>
                <Link href={`/channel/${video.channel.handle}`} className="mt-0.5 block text-xs text-muted hover:text-fg">
                  {video.channel.name}
                </Link>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-subtle">
                  <HistoryIcon size={12} /> Watched {formatRelativeTime(entry.watchedAt)} · {countLabel(video.viewCount, "view")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(video.id)}
                disabled={busyId === video.id}
                aria-label={`Remove ${video.title} from history`}
                className="dt-icon-btn shrink-0"
                title="Remove from watch history"
              >
                <CloseIcon size={16} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-8 flex justify-center">
        {loading && <p className="text-sm text-subtle">Working…</p>}
        {!loading && cursor !== null && (
          <button type="button" className="dt-btn dt-btn-secondary" onClick={() => void loadMore()}>
            Load more
          </button>
        )}
        {!loading && cursor === null && items.length > 0 && (
          <p className="text-xs text-subtle">That is your whole history.</p>
        )}
      </div>
    </section>
  );
}
