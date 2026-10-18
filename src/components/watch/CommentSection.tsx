"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { mediaUrl } from "@/lib/media-url";
import { formatCount, formatRelativeTime } from "@/lib/format";
import { api } from "@/lib/api-client";
import { LikeIcon, PinIcon, ReportIcon, SpinnerIcon, TrashIcon } from "@/components/icons";

export interface CommentAuthorDTO {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  handle: string | null;
}

export interface CommentDTO {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isPinned: boolean;
  isHidden: boolean;
  isDeleted: boolean;
  likeCount: number;
  replyCount: number;
  author: CommentAuthorDTO;
  viewer: { hasLiked: boolean; canEdit: boolean; canDelete: boolean; canModerate: boolean };
  replies?: CommentDTO[];
}

export interface CommentSectionProps {
  videoId: string;
  initialComments: CommentDTO[];
  initialTotal: number;
  initialNextOffset: number | null;
  sort: "top" | "newest";
  signedIn: boolean;
  /** Owner or moderator: unlocks moderation actions and hidden comments. */
  canModerate: boolean;
  /** Creator has disabled comments for this video. */
  commentsDisabled: boolean;
  /** Deep link: scroll to and highlight one comment. */
  highlightCommentId?: string | null;
}

const MAX_LENGTH = 4000;

/**
 * Comment thread.
 *
 * The first page is server-rendered so the discussion is indexable and visible
 * without JavaScript. Everything after that (posting, liking, replying, editing,
 * deleting, moderating, paging) goes through the API and updates in place.
 *
 * Replies are one level deep by design; replying to a reply joins the same
 * thread and prefixes the body with the handle being answered, which keeps the
 * conversation readable and the queries simple.
 */
export function CommentSection({
  videoId,
  initialComments,
  initialTotal,
  initialNextOffset,
  sort: initialSort,
  signedIn,
  canModerate,
  commentsDisabled,
  highlightCommentId,
}: CommentSectionProps) {
  const [comments, setComments] = useState<CommentDTO[]>(initialComments);
  const [total, setTotal] = useState(initialTotal);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [sort, setSort] = useState<"top" | "newest">(initialSort);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; handle: string; parentId: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------------------------------------- sort switching */
  const reload = useCallback(
    async (nextSort: "top" | "newest") => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<{
          items: CommentDTO[];
          total: number;
          nextOffset: number | null;
        }>(`/api/videos/${videoId}/comments?sort=${nextSort}&offset=0&limit=20`);
        setComments(data.items);
        setTotal(data.total);
        setNextOffset(data.nextOffset);
        setSort(nextSort);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load comments.");
      } finally {
        setLoading(false);
      }
    },
    [videoId],
  );

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{
        items: CommentDTO[];
        total: number;
        nextOffset: number | null;
      }>(`/api/videos/${videoId}/comments?sort=${sort}&offset=${nextOffset}&limit=20`);
      setComments((current) => {
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...data.items.filter((c) => !seen.has(c.id))];
      });
      setTotal(data.total);
      setNextOffset(data.nextOffset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more comments.");
    } finally {
      setLoading(false);
    }
  }, [loading, nextOffset, sort, videoId]);

  /* ------------------------------------------------------------- highlight */
  useEffect(() => {
    if (!highlightCommentId) return;
    // Wait a frame so server-rendered nodes exist before scrolling.
    const timer = window.setTimeout(() => {
      const node = document.getElementById(`comment-${highlightCommentId}`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [highlightCommentId]);

  /* --------------------------------------------------------------- posting */
  async function submit() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);
    try {
      // When answering a reply we target that reply's thread, and prefix the
      // handle so it is obvious who is being answered.
      const payload: { body: string; parentId?: string } = { body };
      if (replyTo) payload.parentId = replyTo.parentId;

      const data = await api.post<{ comment: CommentDTO }>(`/api/videos/${videoId}/comments`, payload);

      if (replyTo) {
        setComments((current) =>
          current.map((comment) =>
            comment.id === replyTo.parentId
              ? {
                  ...comment,
                  replyCount: comment.replyCount + 1,
                  replies: [...(comment.replies ?? []), data.comment].slice(0, 2),
                }
              : comment,
          ),
        );
      } else {
        // Newest-first for "newest"; for "top" just prepend and let the user
        // re-sort if they care about strict ordering.
        setComments((current) => [data.comment, ...current]);
        setTotal((value) => value + 1);
      }
      setDraft("");
      setReplyTo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not post your comment.");
    } finally {
      setPosting(false);
    }
  }

  /* ------------------------------------------------------------- mutations */
  const applyToComment = useCallback(
    (id: string, update: (comment: CommentDTO) => CommentDTO) => {
      setComments((current) =>
        current.map((comment) =>
          comment.id === id
            ? update(comment)
            : { ...comment, replies: comment.replies?.map((r) => (r.id === id ? update(r) : r)) },
        ),
      );
    },
    [],
  );

  async function toggleLike(comment: CommentDTO) {
    if (!signedIn) {
      setError("Sign in to like comments.");
      return;
    }
    const liked = !comment.viewer.hasLiked;
    applyToComment(comment.id, (c) => ({
      ...c,
      likeCount: Math.max(0, c.likeCount + (liked ? 1 : -1)),
      viewer: { ...c.viewer, hasLiked: liked },
    }));
    try {
      const result = await apiFetchLike(comment.id, liked);
      applyToComment(comment.id, (c) => ({
        ...c,
        likeCount: result.likeCount,
        viewer: { ...c.viewer, hasLiked: result.liked },
      }));
    } catch (e) {
      applyToComment(comment.id, (c) => ({
        ...c,
        likeCount: comment.likeCount,
        viewer: { ...c.viewer, hasLiked: comment.viewer.hasLiked },
      }));
      setError(e instanceof Error ? e.message : "Could not update your like.");
    }
  }

  async function remove(comment: CommentDTO) {
    if (!window.confirm("Delete this comment? This cannot be undone.")) return;
    const snapshot = comments;
    // Optimistic removal; the reply count on the parent is decremented too.
    setComments((current) =>
      current
        .filter((c) => c.id !== comment.id)
        .map((c) => ({
          ...c,
          replies: c.replies?.filter((r) => r.id !== comment.id),
          replyCount: c.replies?.some((r) => r.id === comment.id) ? Math.max(0, c.replyCount - 1) : c.replyCount,
        })),
    );
    setTotal((value) => Math.max(0, value - 1));
    try {
      await api.del(`/api/comments/${comment.id}`);
    } catch (e) {
      setComments(snapshot);
      setTotal((value) => value + 1);
      setError(e instanceof Error ? e.message : "Could not delete that comment.");
    }
  }

  async function moderate(comment: CommentDTO, action: "hide" | "unhide" | "pin" | "unpin") {
    try {
      await api.post(`/api/comments/${comment.id}/moderate`, { action });
      if (action === "hide" || action === "unhide") {
        const hidden = action === "hide";
        applyToComment(comment.id, (c) => ({ ...c, isHidden: hidden }));
        setTotal((value) => Math.max(0, value + (hidden ? -1 : 1)));
      } else {
        const pinned = action === "pin";
        // Only one comment can be pinned at a time.
        setComments((current) =>
          current.map((c) => (c.id === comment.id ? { ...c, isPinned: pinned } : { ...c, isPinned: pinned ? false : c.isPinned })),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Moderation action failed.");
    }
  }

  async function report(comment: CommentDTO) {
    const reason = window.prompt(
      "Why are you reporting this comment? (spam, harassment, misinformation, copyright, sexual, violence, other)",
      "spam",
    );
    if (!reason) return;
    try {
      await api.post(`/api/comments/${comment.id}/report`, { reason });
      setError(null);
      window.alert("Thanks — this comment has been reported to the channel owner.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit that report.");
    }
  }

  const remaining = Math.max(0, total - comments.length);
  const placeholder = useMemo(
    () => (signedIn ? "Add a comment…" : "Sign in to add a comment"),
    [signedIn],
  );

  return (
    <section aria-label="Comments" className="mt-6">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <h2 className="text-base font-bold">
          {formatCount(total)} {total === 1 ? "comment" : "comments"}
        </h2>
        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => void reload("top")}
            aria-pressed={sort === "top"}
            className="rounded px-2 py-1 font-semibold hover:bg-black/5"
            style={sort === "top" ? { textDecoration: "underline" } : { color: "var(--dt-fg-subtle)" }}
          >
            Top
          </button>
          <button
            type="button"
            onClick={() => void reload("newest")}
            aria-pressed={sort === "newest"}
            className="rounded px-2 py-1 font-semibold hover:bg-black/5"
            style={sort === "newest" ? { textDecoration: "underline" } : { color: "var(--dt-fg-subtle)" }}
          >
            Newest
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------- composer */}
      {commentsDisabled ? (
        <p className="dt-card mb-5 px-4 py-3 text-sm text-muted">The creator has turned off comments for this video.</p>
      ) : signedIn ? (
        <div className="mb-6 flex gap-3">
          <div className="w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            {replyTo && (
              <p className="mb-1 text-xs text-muted">
                Replying to <strong>@{replyTo.handle}</strong>{" "}
                <button type="button" className="underline" onClick={() => setReplyTo(null)}>
                  cancel
                </button>
              </p>
            )}
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, MAX_LENGTH))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={replyTo ? 2 : 2}
              placeholder={placeholder}
              aria-label="Write a comment"
              className="dt-input w-full resize-y"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[11px] text-subtle">{draft.length}/{MAX_LENGTH}</p>
              <div className="flex gap-2">
                {draft.length > 0 && (
                  <button
                    type="button"
                    className="dt-btn dt-btn-secondary"
                    onClick={() => {
                      setDraft("");
                      setReplyTo(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button type="button" className="dt-btn dt-btn-primary" disabled={posting || draft.trim().length === 0} onClick={() => void submit()}>
                  {posting ? <SpinnerIcon size={16} /> : null}
                  {replyTo ? "Reply" : "Comment"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="dt-card mb-6 px-4 py-3 text-sm text-muted">
          <Link href="/login" className="underline">
            Sign in
          </Link>{" "}
          to join the conversation.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      {/* -------------------------------------------------------- the list */}
      <div ref={anchorRef} className="flex flex-col gap-6">
        {comments.length === 0 && !loading && <p className="text-sm text-subtle">No comments yet. Be the first.</p>}
        {comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            videoId={videoId}
            signedIn={signedIn}
            canModerate={canModerate}
            highlighted={highlightCommentId === comment.id}
            onLike={toggleLike}
            onDelete={remove}
            onModerate={moderate}
            onReport={report}
            onReply={(target) => {
              setReplyTo({ id: target.id, handle: target.author.handle ?? target.author.username, parentId: target.parentId ?? target.id });
              composerRef.current?.focus();
            }}
          />
        ))}
      </div>

      {loading && (
        <p className="mt-4 flex items-center gap-2 text-sm text-subtle">
          <SpinnerIcon size={16} /> Loading…
        </p>
      )}

      {nextOffset !== null && (
        <button type="button" className="dt-btn dt-btn-secondary mt-6" onClick={() => void loadMore()} disabled={loading}>
          Show {Math.min(20, remaining)} more {remaining === 1 ? "reply" : "replies"}
        </button>
      )}

      {nextOffset === null && comments.length > 0 && (
        <p className="mt-6 text-xs text-subtle">That is everything in this discussion.</p>
      )}
    </section>
  );
}

/** Likes/unlikes through the dedicated endpoint (PUT = like, DELETE = unlike). */
async function apiFetchLike(commentId: string, liked: boolean): Promise<{ liked: boolean; likeCount: number }> {
  const { apiFetch } = await import("@/lib/api-client");
  return apiFetch<{ liked: boolean; likeCount: number }>(`/api/comments/${commentId}/like`, {
    method: liked ? "PUT" : "DELETE",
  });
}

interface CommentItemProps {
  comment: CommentDTO;
  videoId: string;
  signedIn: boolean;
  canModerate: boolean;
  highlighted: boolean;
  parentId?: string;
  onLike: (comment: CommentDTO) => void;
  onDelete: (comment: CommentDTO) => void;
  onModerate: (comment: CommentDTO, action: "hide" | "unhide" | "pin" | "unpin") => void;
  onReport: (comment: CommentDTO) => void;
  onReply: (target: CommentDTO & { parentId?: string }) => void;
}

function CommentItem({
  comment,
  videoId,
  signedIn,
  canModerate,
  highlighted,
  parentId,
  onLike,
  onDelete,
  onModerate,
  onReport,
  onReply,
}: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.body);
  // Edited bodies are tracked locally: mutating the prop object would not
  // re-render and would silently desync from the server response.
  const [body, setBody] = useState(comment.body);
  const [editedAt, setEditedAt] = useState(comment.editedAt);
  const [editError, setEditError] = useState<string | null>(null);
  const [showReplies, setShowReplies] = useState(false);

  async function saveEdit() {
    const next = editDraft.trim();
    if (!next) return;
    try {
      const result = await api.patch<{ comment: CommentDTO }>(`/api/comments/${comment.id}`, { body: next });
      setBody(result.comment.body);
      setEditedAt(result.comment.editedAt);
      setEditing(false);
      setEditError(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Could not save your edit.");
    }
  }

  const replies = comment.replies ?? [];

  return (
    <article
      id={`comment-${comment.id}`}
      className={`flex gap-3 rounded-lg ${highlighted ? "ring-2 ring-offset-2" : ""}`}
      style={highlighted ? { boxShadow: "0 0 0 2px var(--dt-accent)" } : undefined}
    >
      <Link href={comment.author.handle ? `/channel/${comment.author.handle}` : "#"} className="shrink-0" tabIndex={-1}>
        <Avatar name={comment.author.displayName} seed={comment.author.id} src={mediaUrl(comment.author.avatarKey)} size={40} />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <Link
            href={comment.author.handle ? `/channel/${comment.author.handle}` : "#"}
            className="font-semibold hover:underline"
          >
            {comment.author.handle ? `@${comment.author.handle}` : comment.author.displayName}
          </Link>
          <span className="text-subtle">{formatRelativeTime(comment.createdAt)}</span>
          {editedAt && <span className="text-subtle">(edited)</span>}
          {comment.isPinned && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: "var(--dt-surface-2)" }}>
              <PinIcon size={11} /> Pinned
            </span>
          )}
          {comment.isHidden && (
            <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-danger" style={{ background: "var(--dt-surface-2)" }}>
              Hidden
            </span>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5">
            <textarea
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value.slice(0, 4000))}
              rows={2}
              className="dt-input w-full"
              aria-label="Edit comment"
            />
            <div className="mt-1.5 flex gap-2">
              <button type="button" className="dt-btn dt-btn-primary !px-3 !py-1 text-xs" onClick={() => void saveEdit()}>
                Save
              </button>
              <button
                type="button"
                className="dt-btn dt-btn-secondary !px-3 !py-1 text-xs"
                onClick={() => {
                  setEditing(false);
                  setEditDraft(body);
                  setEditError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : comment.isDeleted ? (
          <p className="mt-1 text-sm italic text-subtle">This comment was removed.</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{body}</p>
        )}
        {editError && <p className="mt-1 text-xs text-danger">{editError}</p>}

        {!comment.isDeleted && !editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[13px]">
            <button
              type="button"
              onClick={() => onLike(comment)}
              aria-pressed={comment.viewer.hasLiked}
              aria-label="Like comment"
              className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-black/5"
              style={comment.viewer.hasLiked ? { color: "var(--dt-accent-strong, var(--dt-accent))" } : undefined}
            >
              <LikeIcon size={16} filled={comment.viewer.hasLiked} />
              {comment.likeCount > 0 ? formatCount(comment.likeCount) : ""}
            </button>
            <button
              type="button"
              onClick={() => onReply({ ...comment, parentId })}
              className="rounded-full px-2.5 py-1 font-semibold hover:bg-black/5"
              disabled={!signedIn}
            >
              Reply
            </button>

            {comment.viewer.canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-full px-2.5 py-1 font-semibold hover:bg-black/5"
              >
                Edit
              </button>
            )}

            {comment.viewer.canDelete && (
              <button
                type="button"
                onClick={() => onDelete(comment)}
                aria-label="Delete comment"
                className="rounded-full p-1.5 hover:bg-black/5"
              >
                <TrashIcon size={15} />
              </button>
            )}

            {signedIn && !comment.viewer.canDelete && (
              <button type="button" onClick={() => onReport(comment)} aria-label="Report comment" className="rounded-full p-1.5 hover:bg-black/5">
                <ReportIcon size={15} />
              </button>
            )}

            {canModerate && (
              <>
                <button
                  type="button"
                  onClick={() => onModerate(comment, comment.isPinned ? "unpin" : "pin")}
                  className="rounded-full px-2.5 py-1 font-semibold hover:bg-black/5"
                >
                  {comment.isPinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  onClick={() => onModerate(comment, comment.isHidden ? "unhide" : "hide")}
                  className="rounded-full px-2.5 py-1 font-semibold hover:bg-black/5"
                >
                  {comment.isHidden ? "Unhide" : "Hide"}
                </button>
              </>
            )}
          </div>
        )}

        {/* Inline reply preview + "view all" */}
        {comment.replyCount > 0 && (
          <div className="mt-3">
            {!showReplies && replies.length > 0 && (
              <div className="flex flex-col gap-3">
                {replies.map((reply) => (
                  <CommentItem
                    key={reply.id}
                    comment={reply}
                    videoId={videoId}
                    signedIn={signedIn}
                    canModerate={canModerate}
                    highlighted={false}
                    parentId={comment.id}
                    onLike={onLike}
                    onDelete={onDelete}
                    onModerate={onModerate}
                    onReport={onReport}
                    onReply={onReply}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowReplies((value) => !value)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold"
              style={{ background: "var(--dt-surface-2)" }}
            >
              {showReplies ? "Hide replies" : `View ${comment.replyCount} ${comment.replyCount === 1 ? "reply" : "replies"}`}
            </button>
            {showReplies && <ReplyList commentId={comment.id} videoId={videoId} onLike={onLike} onDelete={onDelete} onModerate={onModerate} onReport={onReport} onReply={onReply} signedIn={signedIn} canModerate={canModerate} />}
          </div>
        )}
      </div>
    </article>
  );
}

/** Lazily loads the complete reply list for a thread. */
function ReplyList({
  commentId,
  videoId,
  signedIn,
  canModerate,
  onLike,
  onDelete,
  onModerate,
  onReport,
  onReply,
}: {
  commentId: string;
  videoId: string;
  signedIn: boolean;
  canModerate: boolean;
  onLike: (comment: CommentDTO) => void;
  onDelete: (comment: CommentDTO) => void;
  onModerate: (comment: CommentDTO, action: "hide" | "unhide" | "pin" | "unpin") => void;
  onReport: (comment: CommentDTO) => void;
  onReply: (target: CommentDTO & { parentId?: string }) => void;
}) {
  const [replies, setReplies] = useState<CommentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items: CommentDTO[] }>(`/api/comments/${commentId}/replies?limit=100`)
      .then((data) => {
        if (!cancelled) setReplies(data.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load replies.");
      });
    return () => {
      cancelled = true;
    };
  }, [commentId]);

  if (error) return <p className="mt-2 text-xs text-danger">{error}</p>;
  if (!replies) return <p className="mt-2 text-xs text-subtle">Loading replies…</p>;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {replies.map((reply) => (
        <CommentItem
          key={reply.id}
          comment={reply}
          videoId={videoId}
          signedIn={signedIn}
          canModerate={canModerate}
          highlighted={false}
          parentId={commentId}
          onLike={onLike}
          onDelete={onDelete}
          onModerate={onModerate}
          onReport={onReport}
          onReply={onReply}
        />
      ))}
    </div>
  );
}
