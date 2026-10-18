"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import { mediaUrl } from "@/lib/media-url";
import { countLabel, formatCount, formatDate, formatDuration } from "@/lib/format";
import { EditIcon, GlobeIcon, LinkIcon, LockIcon, PlayIcon, TrashIcon } from "@/components/icons";

/** The subset of a video returned by `GET /api/studio/videos`. */
export interface StudioVideoListItem {
  id: string;
  title: string;
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  status: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  processingError: string | null;
}

interface ListResponse {
  items: StudioVideoListItem[];
  nextCursor: string | null;
}

interface Filters {
  q: string;
  status: string;
  visibility: string;
}

const PAGE_SIZE = 20;
const STATUS_OPTIONS = ["ALL", "DRAFT", "PROCESSING", "READY", "FAILED"] as const;
const VISIBILITY_OPTIONS = ["ALL", "PUBLIC", "UNLISTED", "PRIVATE"] as const;

function buildPath(filters: Filters & { cursor: string | null }): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.status !== "ALL") params.set("status", filters.status);
  if (filters.visibility !== "ALL") params.set("visibility", filters.visibility);
  if (filters.cursor) params.set("cursor", filters.cursor);
  params.set("limit", String(PAGE_SIZE));
  return `/api/studio/videos?${params.toString()}`;
}

export interface VideoListClientProps {
  initialItems: StudioVideoListItem[];
  initialCursor: string | null;
  initialQuery: string;
  initialStatus: string;
  initialVisibility: string;
}

/**
 * Studio video list.
 *
 * The first page arrives server-rendered; this component layers on the search
 * box, status/visibility filters, "load more" and the per-row publish / delete
 * actions. Deletes are optimistic and restored in place if the request fails.
 */
export function VideoListClient({
  initialItems,
  initialCursor,
  initialQuery,
  initialStatus,
  initialVisibility,
}: VideoListClientProps) {
  const [filters, setFilters] = useState<Filters>({
    q: initialQuery,
    status: initialStatus,
    visibility: initialVisibility,
  });
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const skipFirstEffect = useRef(true);

  const fetchPage = useCallback(async (next: Filters, cursorValue: string | null, mode: "replace" | "append") => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.get<ListResponse>(buildPath({ ...next, cursor: cursorValue }));
      const fresh = data.items ?? [];
      setItems((current) => {
        if (mode === "replace") return fresh;
        const seen = new Set(current.map((video) => video.id));
        return [...current, ...fresh.filter((video) => !seen.has(video.id))];
      });
      setCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load your videos.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-fetch (debounced) whenever the filters change — but not on first mount,
  // where the server already provided the matching first page.
  useEffect(() => {
    if (skipFirstEffect.current) {
      skipFirstEffect.current = false;
      return;
    }
    const timeout = setTimeout(() => {
      void fetchPage(filters, null, "replace");
    }, 250);
    return () => clearTimeout(timeout);
  }, [filters, fetchPage]);

  const setFilter = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  const setRowPending = (id: string, action: string | null) =>
    setPending((current) => {
      const next = { ...current };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });

  const publish = async (video: StudioVideoListItem) => {
    setRowPending(video.id, "publish");
    setError(null);
    try {
      const res = await api.post<{ video: StudioVideoListItem }>(`/api/studio/videos/${video.id}/publish`, {
        visibility: "PUBLIC",
      });
      setItems((current) => current.map((item) => (item.id === video.id ? res.video : item)));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not publish that video.");
    } finally {
      setRowPending(video.id, null);
    }
  };

  const unpublish = async (video: StudioVideoListItem) => {
    setRowPending(video.id, "unpublish");
    setError(null);
    try {
      const res = await api.del<{ video: StudioVideoListItem }>(`/api/studio/videos/${video.id}/publish`);
      setItems((current) => current.map((item) => (item.id === video.id ? res.video : item)));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not unpublish that video.");
    } finally {
      setRowPending(video.id, null);
    }
  };

  const remove = async (video: StudioVideoListItem) => {
    const index = items.findIndex((item) => item.id === video.id);
    if (index === -1) return;
    if (!window.confirm(`Delete “${video.title}”? This cannot be undone from Studio.`)) return;

    setRowPending(video.id, "delete");
    setError(null);
    // Optimistic removal.
    setItems((current) => current.filter((item) => item.id !== video.id));
    try {
      await api.del(`/api/studio/videos/${video.id}`);
    } catch (e) {
      // Restore the row at its original position.
      setItems((current) => {
        if (current.some((item) => item.id === video.id)) return current;
        const next = [...current];
        next.splice(Math.min(index, next.length), 0, video);
        return next;
      });
      setError(e instanceof ApiClientError ? e.message : "Could not delete that video.");
    } finally {
      setRowPending(video.id, null);
    }
  };

  const hasMore = cursor !== null;
  const filtersActive = filters.q.trim() !== "" || filters.status !== "ALL" || filters.visibility !== "ALL";

  return (
    <div>
      {/* --------------------------------------------------------- filter bar */}
      <div className="dt-card flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1">
          <label className="dt-label" htmlFor="studio-video-search">
            Search
          </label>
          <input
            id="studio-video-search"
            type="search"
            className="dt-input"
            placeholder="Search your videos by title"
            value={filters.q}
            onChange={(event) => setFilter({ q: event.target.value })}
          />
        </div>
        <div>
          <label className="dt-label" htmlFor="studio-video-status">
            Status
          </label>
          <select
            id="studio-video-status"
            className="dt-input"
            value={filters.status}
            onChange={(event) => setFilter({ status: event.target.value })}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "ALL" ? "All statuses" : option}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="dt-label" htmlFor="studio-video-visibility">
            Visibility
          </label>
          <select
            id="studio-video-visibility"
            className="dt-input"
            value={filters.visibility}
            onChange={(event) => setFilter({ visibility: event.target.value })}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "ALL" ? "All visibilities" : option.charAt(0) + option.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="dt-alert dt-alert-error mt-3">
          {error}
        </p>
      )}

      {/* -------------------------------------------------------------- rows */}
      {items.length === 0 ? (
        <div className="dt-card mt-4 flex flex-col items-center gap-2 px-6 py-14 text-center">
          <p className="text-base font-semibold">{filtersActive ? "No videos match those filters" : "No videos yet"}</p>
          <p className="max-w-md text-sm text-muted">
            {filtersActive
              ? "Try clearing the search or choosing a different status or visibility."
              : "Upload your first video to see it here."}
          </p>
          {!filtersActive && (
            <Link href="/studio/upload" className="dt-btn dt-btn-primary mt-1">
              Upload a video
            </Link>
          )}
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((video) => (
            <VideoRow
              key={video.id}
              video={video}
              pendingAction={pending[video.id] ?? null}
              onPublish={() => void publish(video)}
              onUnpublish={() => void unpublish(video)}
              onDelete={() => void remove(video)}
            />
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-col items-center gap-2">
        {busy && <p className="text-sm text-subtle">Loading…</p>}
        {!busy && hasMore && (
          <button type="button" className="dt-btn dt-btn-secondary" onClick={() => void fetchPage(filters, cursor, "append")}>
            Load more
          </button>
        )}
        {!busy && !hasMore && items.length > 0 && (
          <p className="py-2 text-xs text-subtle">
            {filtersActive ? `${items.length} matching video${items.length === 1 ? "" : "s"}` : "That is all your videos."}
          </p>
        )}
      </div>
    </div>
  );
}

function VisibilityBadge({ visibility }: { visibility: StudioVideoListItem["visibility"] }) {
  if (visibility === "PUBLIC") {
    return (
      <span className="dt-badge dt-badge-success">
        <GlobeIcon size={12} /> Public
      </span>
    );
  }
  if (visibility === "UNLISTED") {
    return (
      <span className="dt-badge">
        <LinkIcon size={12} /> Unlisted
      </span>
    );
  }
  return (
    <span className="dt-badge">
      <LockIcon size={12} /> Private
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "READY"
      ? "dt-badge-success"
      : status === "FAILED"
        ? "dt-badge-danger"
        : status === "PROCESSING"
          ? "dt-badge-warning"
          : "";
  return <span className={`dt-badge ${tone}`}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}

function VideoRow({
  video,
  pendingAction,
  onPublish,
  onUnpublish,
  onDelete,
}: {
  video: StudioVideoListItem;
  pendingAction: string | null;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}) {
  const busy = pendingAction !== null;
  const thumb = mediaUrl(video.thumbnailKey);
  const canPublish = video.status === "READY";

  return (
    <li className="dt-card flex flex-wrap items-start gap-3 p-3">
      <Link
        href={`/studio/videos/${video.id}`}
        className="relative block shrink-0 overflow-hidden rounded-lg"
        style={{ background: "var(--dt-surface-2)", width: 140, height: 79 }}
        aria-label={`Edit ${video.title}`}
      >
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-subtle">
            <PlayIcon size={22} />
          </span>
        )}
        <span
          className="pointer-events-none absolute bottom-1 right-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
          style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
        >
          {formatDuration(video.durationSec)}
        </span>
      </Link>

      <div className="min-w-[200px] flex-1">
        <h3 className="text-sm font-semibold leading-snug">
          <Link href={`/studio/videos/${video.id}`} className="hover:text-brand">
            {video.title}
          </Link>
        </h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <VisibilityBadge visibility={video.visibility} />
          <StatusBadge status={video.status} />
          {video.isShort && <span className="dt-badge">Short</span>}
        </div>
        <p className="mt-1.5 text-xs text-subtle">
          {countLabel(video.viewCount, "view")} · {formatCount(video.likeCount)} likes ·{" "}
          {formatCount(video.commentCount)} comments
        </p>
        <p className="mt-0.5 text-xs text-subtle">
          {video.publishedAt ? `Published ${formatDate(video.publishedAt)}` : `Created ${formatDate(video.createdAt)}`}
        </p>
        {video.status === "FAILED" && video.processingError && (
          <p className="mt-1 text-xs text-danger" title={video.processingError}>
            {video.processingError}
          </p>
        )}
      </div>

      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <Link href={`/studio/videos/${video.id}`} className="dt-btn dt-btn-outline !px-3 !py-1.5 text-[13px]">
          <EditIcon size={15} /> Edit
        </Link>
        {video.visibility === "PRIVATE" ? (
          <button
            type="button"
            className="dt-btn dt-btn-primary !px-3 !py-1.5 text-[13px]"
            disabled={busy || !canPublish}
            title={canPublish ? undefined : "Only videos that have finished processing can be published."}
            onClick={onPublish}
          >
            {pendingAction === "publish" ? "Publishing…" : "Publish"}
          </button>
        ) : (
          <button
            type="button"
            className="dt-btn dt-btn-secondary !px-3 !py-1.5 text-[13px]"
            disabled={busy}
            onClick={onUnpublish}
          >
            {pendingAction === "unpublish" ? "Unpublishing…" : "Unpublish"}
          </button>
        )}
        <button
          type="button"
          className="dt-btn dt-btn-danger !px-3 !py-1.5 text-[13px]"
          disabled={busy}
          aria-label={`Delete ${video.title}`}
          onClick={onDelete}
        >
          <TrashIcon size={15} /> {pendingAction === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
    </li>
  );
}
