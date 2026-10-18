"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { ReportIcon, SpinnerIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui";

export interface ReportedComment {
  id: string;
  reason: string;
  createdAt: string;
  reporter: { id: string; username: string; displayName: string };
  comment: {
    id: string;
    body: string;
    createdAt: string;
    isPinned: boolean;
    isHidden: boolean;
    author: {
      id: string;
      username: string;
      displayName: string;
      avatarKey: string | null;
      handle: string | null;
    };
  };
}

interface ModerationResult {
  hidden?: boolean;
  pinned?: boolean;
}

interface ReportsResponse {
  items: ReportedComment[];
  total: number;
  page: number;
  pageCount: number;
}

export interface ReportedCommentsProps {
  videoId: string;
  initialReports: ReportedComment[];
  initialTotal: number;
  initialPage: number;
  initialPageCount: number;
}

/**
 * Comment moderation queue for one video.
 *
 * Reports come from `GET /api/studio/videos/:id/reports` (paginated; the page
 * size is capped server-side). Hide/unhide and pin/unpin go through
 * `POST /api/comments/:id/moderate`, and the row updates in place from the
 * server's response so it never drifts from the database.
 */
export function ReportedComments({
  videoId,
  initialReports,
  initialTotal,
  initialPage,
  initialPageCount,
}: ReportedCommentsProps) {
  const [reports, setReports] = useState<ReportedComment[]>(initialReports);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(initialPage);
  const [pageCount, setPageCount] = useState(initialPageCount);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const moderate = async (commentId: string, action: "hide" | "unhide" | "pin" | "unpin") => {
    setPending(`${commentId}:${action}`);
    setError(null);
    try {
      const result = await api.post<ModerationResult>(`/api/comments/${commentId}/moderate`, { action });
      setReports((current) =>
        current.map((report) => {
          if (report.comment.id !== commentId) return report;
          const comment = { ...report.comment };
          if (action === "hide") {
            comment.isHidden = result.hidden ?? true;
            // Hiding also unpins the comment server-side.
            comment.isPinned = false;
          } else if (action === "unhide") {
            comment.isHidden = result.hidden ?? false;
          } else if (action === "pin") {
            comment.isPinned = result.pinned ?? true;
          } else {
            comment.isPinned = result.pinned ?? false;
          }
          return { ...report, comment };
        }),
      );
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not update that comment.");
    } finally {
      setPending(null);
    }
  };

  const load = async (targetPage: number) => {
    setRefreshing(true);
    setError(null);
    try {
      const data = await api.get<ReportsResponse>(`/api/studio/videos/${videoId}/reports?page=${targetPage}`);
      setReports(data.items ?? []);
      setTotal(data.total ?? 0);
      setPage(data.page ?? targetPage);
      setPageCount(data.pageCount ?? 1);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load reports.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="dt-card p-4 sm:p-5" aria-labelledby="reports-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="reports-heading" className="flex items-center gap-2 text-sm font-bold">
          <ReportIcon size={16} /> Reported comments
          {total > 0 && <span className="text-xs font-normal text-subtle">({total})</span>}
        </h2>
        <button
          type="button"
          className="dt-btn dt-btn-outline !px-3 !py-1 text-[13px]"
          disabled={refreshing}
          onClick={() => void load(page)}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p role="alert" className="dt-alert dt-alert-error mt-3">
          {error}
        </p>
      )}

      {reports.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No reported comments"
          description="Reported comments appear here for review. Nothing needs your attention right now."
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {reports.map((report) => {
            const comment = report.comment;
            const hiding = pending === `${comment.id}:hide` || pending === `${comment.id}:unhide`;
            const pinning = pending === `${comment.id}:pin` || pending === `${comment.id}:unpin`;
            return (
              <li key={report.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-subtle">
                  <span className="dt-badge dt-badge-warning">
                    <ReportIcon size={12} /> Reported for {report.reason}
                  </span>
                  <span>
                    by <span className="font-semibold">{report.reporter.displayName}</span>
                    {" · "}
                    {formatDate(report.createdAt)}
                  </span>
                </div>

                <blockquote className="mt-3 border-l-2 border-line pl-3">
                  <p className="text-sm">
                    {comment.author.handle ? (
                      <Link href={`/channel/${comment.author.handle}`} className="font-semibold hover:text-brand">
                        {comment.author.displayName}
                      </Link>
                    ) : (
                      <span className="font-semibold">{comment.author.displayName}</span>
                    )}{" "}
                    <span className="text-xs text-subtle">@{comment.author.username}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
                  <p className="mt-1 text-xs text-subtle">{formatDate(comment.createdAt)}</p>
                </blockquote>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {comment.isHidden && <span className="dt-badge dt-badge-danger">Hidden</span>}
                  {comment.isPinned && <span className="dt-badge dt-badge-brand">Pinned</span>}
                  <button
                    type="button"
                    className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                    disabled={pending !== null}
                    onClick={() => void moderate(comment.id, comment.isHidden ? "unhide" : "hide")}
                  >
                    {hiding && <SpinnerIcon size={14} className="dt-spin" />}
                    {comment.isHidden ? "Unhide" : "Hide"}
                  </button>
                  <button
                    type="button"
                    className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]"
                    disabled={pending !== null || comment.isHidden}
                    title={comment.isHidden ? "Unhide the comment before pinning it." : undefined}
                    onClick={() => void moderate(comment.id, comment.isPinned ? "unpin" : "pin")}
                  >
                    {pinning && <SpinnerIcon size={14} className="dt-spin" />}
                    {comment.isPinned ? "Unpin" : "Pin"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Report pages">
          <button
            type="button"
            className="dt-btn dt-btn-outline !px-3 !py-1 text-[13px]"
            disabled={refreshing || page <= 1}
            onClick={() => void load(page - 1)}
          >
            <ChevronLeftIcon size={15} /> Previous
          </button>
          <span className="text-xs text-subtle">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="dt-btn dt-btn-outline !px-3 !py-1 text-[13px]"
            disabled={refreshing || page >= pageCount}
            onClick={() => void load(page + 1)}
          >
            Next <ChevronRightIcon size={15} />
          </button>
        </nav>
      )}
    </section>
  );
}
