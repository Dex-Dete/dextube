"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import { mediaUrl } from "@/lib/media-url";
import { countLabel, formatCount, formatDate, formatDuration } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import {
  EditIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PlayIcon,
  RefreshIcon,
  TrashIcon,
} from "@/components/icons";

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

type SortKey = "createdAt" | "publishedAt" | "views" | "title";
type Direction = "asc" | "desc";
type BulkAction = "publish" | "unpublish" | "delete";

interface ListResponse {
  items: StudioVideoListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface BulkResponse {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

interface ViewState {
  q: string;
  status: string;
  visibility: string;
  sort: SortKey;
  direction: Direction;
  page: number;
}

/** Matches `STUDIO_PAGE_SIZE_MAX` on the server; the server enforces it too. */
const PAGE_SIZE = 20;
const STATUS_OPTIONS = ["ALL", "DRAFT", "PROCESSING", "READY", "FAILED"] as const;
const VISIBILITY_OPTIONS = ["ALL", "PUBLIC", "UNLISTED", "PRIVATE"] as const;
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "createdAt", label: "Date added" },
  { value: "publishedAt", label: "Published date" },
  { value: "views", label: "Views" },
  { value: "title", label: "Title" },
];

function buildPath(view: ViewState): string {
  const params = new URLSearchParams();
  if (view.q.trim()) params.set("q", view.q.trim());
  if (view.status !== "ALL") params.set("status", view.status);
  if (view.visibility !== "ALL") params.set("visibility", view.visibility);
  params.set("sort", view.sort);
  params.set("direction", view.direction);
  params.set("page", String(view.page));
  params.set("limit", String(PAGE_SIZE));
  return `/api/studio/videos?${params.toString()}`;
}

export interface VideoListClientProps {
  initialItems: StudioVideoListItem[];
  initialTotal: number;
  initialPage: number;
  initialPageCount: number;
  initialQuery: string;
  initialStatus: string;
  initialVisibility: string;
}

/**
 * Studio video table.
 *
 * The first page arrives server-rendered; this component layers on search,
 * filters, sorting, offset pagination, row selection and the per-row and bulk
 * lifecycle actions. Filters/sorting reset to page one; a bulk request reports
 * exactly which ids failed and keeps the successful ones applied.
 */
export function VideoListClient({
  initialItems,
  initialTotal,
  initialPage,
  initialPageCount,
  initialQuery,
  initialStatus,
  initialVisibility,
}: VideoListClientProps) {
  const [view, setView] = useState<ViewState>({
    q: initialQuery,
    status: initialStatus,
    visibility: initialVisibility,
    sort: "createdAt",
    direction: "desc",
    page: initialPage,
  });
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [pageCount, setPageCount] = useState(initialPageCount);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const skipFirstEffect = useRef(true);

  const fetchView = useCallback(async (target: ViewState) => {
    setBusy(true);
    setError(null);
    try {
      const data = await api.get<ListResponse>(buildPath(target));
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setPageCount(data.pageCount ?? 1);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load your videos.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-fetch (debounced) whenever the view changes — but not on first mount,
  // where the server already provided the matching first page.
  useEffect(() => {
    if (skipFirstEffect.current) {
      skipFirstEffect.current = false;
      return;
    }
    const timeout = setTimeout(() => {
      void fetchView(view);
    }, 250);
    return () => clearTimeout(timeout);
  }, [view, fetchView]);

  /** Filter/sort changes invalidate the selection and jump back to page one. */
  const updateView = (patch: Partial<Omit<ViewState, "page">>) => {
    setSelected(new Set());
    setView((current) => ({ ...current, ...patch, page: 1 }));
  };
  const gotoPage = (page: number) => setView((current) => ({ ...current, page }));

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

  const retry = async (video: StudioVideoListItem) => {
    setRowPending(video.id, "retry");
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/studio/videos/${video.id}/retry`);
      // The pipeline sets PROCESSING when the job runs; reflect that intent
      // immediately rather than waiting for a reload.
      setItems((current) =>
        current.map((item) =>
          item.id === video.id ? { ...item, status: "PROCESSING", processingError: null } : item,
        ),
      );
      setNotice("Retry queued. Reload once processing finishes.");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not retry that video.");
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
    setNotice(null);
    // Optimistic removal.
    setItems((current) => current.filter((item) => item.id !== video.id));
    setTotal((current) => Math.max(0, current - 1));
    setSelected((current) => {
      const next = new Set(current);
      next.delete(video.id);
      return next;
    });
    try {
      await api.del(`/api/studio/videos/${video.id}`);
      // If the page is now empty, step back one page.
      if (items.length === 1 && view.page > 1) gotoPage(view.page - 1);
    } catch (e) {
      // Restore the row at its original position.
      setItems((current) => {
        if (current.some((item) => item.id === video.id)) return current;
        const next = [...current];
        next.splice(Math.min(index, next.length), 0, video);
        return next;
      });
      setTotal((current) => current + 1);
      setError(e instanceof ApiClientError ? e.message : "Could not delete that video.");
    } finally {
      setRowPending(video.id, null);
    }
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected];
    if (ids.length === 0 || bulkAction) return;
    if (
      action === "delete" &&
      !window.confirm(
        `Delete ${ids.length} selected video${ids.length === 1 ? "" : "s"}? This cannot be undone from Studio.`,
      )
    ) {
      return;
    }

    setBulkAction(action);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<BulkResponse>("/api/studio/videos/bulk", { action, ids });
      const succeeded = new Set(res.succeeded);

      if (action === "delete") {
        setItems((current) => current.filter((item) => !succeeded.has(item.id)));
        setTotal((current) => Math.max(0, current - succeeded.size));
      } else if (action === "publish") {
        setItems((current) =>
          current.map((item) =>
            succeeded.has(item.id)
              ? { ...item, visibility: "PUBLIC", publishedAt: item.publishedAt ?? new Date().toISOString() }
              : item,
          ),
        );
      } else {
        setItems((current) =>
          current.map((item) =>
            succeeded.has(item.id) ? { ...item, visibility: "PRIVATE", publishedAt: null } : item,
          ),
        );
      }

      // Keep only the failures selected so the creator can see what remains.
      setSelected(new Set(res.failed.map((failure) => failure.id)));
      if (res.failed.length > 0) {
        const detail = res.failed
          .slice(0, 5)
          .map((failure) => `${failure.id.slice(0, 8)}… — ${failure.error}`)
          .join("; ");
        setError(
          `${res.failed.length} of ${ids.length} video${ids.length === 1 ? "" : "s"} could not be updated: ${detail}`,
        );
      } else {
        setNotice(
          `${succeeded.size} video${succeeded.size === 1 ? "" : "s"} ${bulkVerb(action)}.`,
        );
      }
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "The bulk action could not be completed.");
    } finally {
      setBulkAction(null);
    }
  };

  const pageIds = items.map((item) => item.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));

  const toggleRow = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllOnPage = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });

  const filtersActive = view.q.trim() !== "" || view.status !== "ALL" || view.visibility !== "ALL";
  const selectionCount = selected.size;

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
            value={view.q}
            onChange={(event) => updateView({ q: event.target.value })}
          />
        </div>
        <div>
          <label className="dt-label" htmlFor="studio-video-status">
            Status
          </label>
          <select
            id="studio-video-status"
            className="dt-input"
            value={view.status}
            onChange={(event) => updateView({ status: event.target.value })}
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
            value={view.visibility}
            onChange={(event) => updateView({ visibility: event.target.value })}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "ALL" ? "All visibilities" : option.charAt(0) + option.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="dt-label" htmlFor="studio-video-sort">
            Sort by
          </label>
          <select
            id="studio-video-sort"
            className="dt-input"
            value={view.sort}
            onChange={(event) => updateView({ sort: event.target.value as SortKey })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="dt-label" htmlFor="studio-video-direction">
            Order
          </label>
          <select
            id="studio-video-direction"
            className="dt-input"
            value={view.direction}
            onChange={(event) => updateView({ direction: event.target.value as Direction })}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="dt-alert dt-alert-error mt-3">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="dt-alert dt-alert-success mt-3">
          {notice}
        </p>
      )}

      {/* ------------------------------------------------------ bulk actions */}
      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allOnPageSelected}
              ref={(el) => {
                if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
              }}
              onChange={toggleAllOnPage}
              aria-label="Select every video on this page"
            />
            {pageIds.length > 0 ? `Select page (${pageIds.length})` : "Select"}
          </label>
          <span className="text-xs text-subtle">{selectionCount} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
              disabled={selectionCount === 0 || bulkAction !== null}
              onClick={() => void runBulk("publish")}
            >
              <GlobeIcon size={14} /> {bulkAction === "publish" ? "Publishing…" : "Publish"}
            </button>
            <button
              type="button"
              className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
              disabled={selectionCount === 0 || bulkAction !== null}
              onClick={() => void runBulk("unpublish")}
            >
              <LockIcon size={14} /> {bulkAction === "unpublish" ? "Unpublishing…" : "Unpublish"}
            </button>
            <button
              type="button"
              className="dt-btn dt-btn-danger !px-3 !py-1 text-[13px]"
              disabled={selectionCount === 0 || bulkAction !== null}
              onClick={() => void runBulk("delete")}
            >
              <TrashIcon size={14} /> {bulkAction === "delete" ? "Deleting…" : "Delete"}
            </button>
            {selectionCount > 0 && (
              <button
                type="button"
                className="dt-btn dt-btn-ghost !px-3 !py-1 text-[13px]"
                disabled={bulkAction !== null}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------- rows */}
      {items.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<PlayIcon size={20} />}
          title={filtersActive ? "No videos match those filters" : "No videos yet"}
          description={
            filtersActive
              ? "Try clearing the search or choosing a different status or visibility."
              : "Upload your first video to see it here."
          }
          actions={
            !filtersActive ? (
              <Link href="/studio/upload" className="dt-btn dt-btn-primary">
                Upload a video
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {items.map((video) => (
            <VideoRow
              key={video.id}
              video={video}
              selected={selected.has(video.id)}
              onToggleSelect={() => toggleRow(video.id)}
              pendingAction={pending[video.id] ?? null}
              onPublish={() => void publish(video)}
              onUnpublish={() => void unpublish(video)}
              onDelete={() => void remove(video)}
              onRetry={() => void retry(video)}
            />
          ))}
        </ul>
      )}

      {/* -------------------------------------------------------- pagination */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-subtle">
          {total > 0
            ? `${formatCount(total)} video${total === 1 ? "" : "s"}${pageCount > 1 ? ` · page ${view.page} of ${pageCount}` : ""}`
            : busy
              ? "Loading…"
              : ""}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="dt-btn dt-btn-outline !px-3 !py-1.5 text-[13px]"
            disabled={busy || view.page <= 1}
            onClick={() => gotoPage(view.page - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="dt-btn dt-btn-outline !px-3 !py-1.5 text-[13px]"
            disabled={busy || view.page >= pageCount}
            onClick={() => gotoPage(view.page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function bulkVerb(action: BulkAction): string {
  if (action === "publish") return "published";
  if (action === "unpublish") return "unpublished";
  return "deleted";
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
  selected,
  onToggleSelect,
  pendingAction,
  onPublish,
  onUnpublish,
  onDelete,
  onRetry,
}: {
  video: StudioVideoListItem;
  selected: boolean;
  onToggleSelect: () => void;
  pendingAction: string | null;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const busy = pendingAction !== null;
  const thumb = mediaUrl(video.thumbnailKey);
  const canPublish = video.status === "READY";

  return (
    <li className="dt-card flex flex-wrap items-start gap-3 p-3">
      <label className="mt-1 flex shrink-0 items-center" title={`Select ${video.title}`}>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${video.title}`} />
      </label>
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
        {video.status === "FAILED" && (
          <button
            type="button"
            className="dt-btn dt-btn-secondary !px-3 !py-1.5 text-[13px]"
            disabled={busy}
            onClick={onRetry}
          >
            <RefreshIcon size={15} /> {pendingAction === "retry" ? "Retrying…" : "Retry processing"}
          </button>
        )}
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
