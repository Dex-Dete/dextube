"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { CommentIcon, PinIcon, ReportIcon, SpinnerIcon } from "@/components/icons";

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

export interface ReportedCommentsProps {
  videoId: string;
  initialReports: ReportedComment[];
}

/**
 * Comment moderation queue for one video.
 *
 * Reports come from `GET /api/studio/videos/:id/reports`; hide/unhide and
 * pin/unpin go through `POST /api/comments/:id/moderate`. The list updates in
 * place from the server's response so it never drifts from the database.
 */
export function ReportedComments({ videoId, initialReports }: ReportedCommentsProps) {
  const [reports, setReports] = useState<ReportedComment[]>(initialReports);
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

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const data = await api.get<{ reports: ReportedComment[] }>(`/api/studio/videos/${videoId}/reports`);
      setReports(data.reports ?? []);
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
        </h2>
        <button type="button" className="dt-btn dt-btn-outline !px-3 !py-1 text-[13px]" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p role="alert" className="dt-alert dt-alert-error mt-3">
          {error}
        </p>
      )}

      {reports.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-subtle">
          <CommentIcon size={16} /> No reported comments. Reported comments appear here for review.
        </p>
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
                    <PinIcon size={14} /> {comment.isPinned ? "Unpin" : "Pin"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
