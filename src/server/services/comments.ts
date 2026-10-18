/**
 * Comment service.
 *
 * Thread model: **one level of replies**. A comment with `parentId = null` is
 * top-level; a reply must point at a top-level comment. This is deliberate —
 * unbounded nesting is unreadable and is the main source of recursive query
 * bugs. Replying to a reply is attached to the same thread and prefixed with
 * `@handle` by the UI.
 *
 * Deletion is soft (`deletedAt`) while a comment still has replies, so the
 * thread structure is preserved and the body is replaced by a placeholder.
 * A comment with no replies is hard-deleted, so nothing lingers.
 *
 * Hidden comments exist for creator moderation. They stay in the database,
 * stop counting towards the video's public comment count, and are only visible
 * to the video's owner and to moderators/admins.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { notificationService } from "@/server/services/notifications";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

const log = logger.child({ mod: "comments" });

/** Replies shown inline under a top-level comment before "view all". */
export const REPLY_PREVIEW_COUNT = 2;

/**
 * The moderation queue is paginated and capped in the service as well as in the
 * request schema, so it can never be asked for an unbounded number of reports.
 */
export const REPORT_PAGE_SIZE_DEFAULT = 20;
export const REPORT_PAGE_SIZE_MAX = 50;

export type CommentSort = "top" | "newest";

export interface CommentAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  handle: string | null;
}

export interface CommentView {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  isPinned: boolean;
  isHidden: boolean;
  isDeleted: boolean;
  likeCount: number;
  replyCount: number;
  author: CommentAuthor;
  viewer: {
    hasLiked: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canModerate: boolean;
  };
  /** First few replies (top-level comments only). */
  replies?: CommentView[];
}

export interface CommentPage {
  items: CommentView[];
  total: number;
  nextOffset: number | null;
}

export interface ViewerContext {
  userId: string | null;
  /** The viewer's own channel id, if any — used for moderation rights. */
  channelId: string | null;
  role?: string;
}

const COMMENT_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  editedAt: true,
  isPinned: true,
  isHidden: true,
  deletedAt: true,
  likeCount: true,
  replyCount: true,
  parentId: true,
  userId: true,
  user: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarKey: true,
      channel: { select: { handle: true } },
    },
  },
} satisfies Prisma.CommentSelect;

type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

/** Loads the video's owner channel id, enforcing that the video is visible. */
async function requireVisibleVideo(
  videoId: string,
  viewerChannelId: string | null,
): Promise<{ id: string; channelId: string; allowComments: boolean }> {
  const video = await prisma.video.findFirst({
    where: {
      id: videoId,
      deletedAt: null,
      OR: [
        { visibility: "PUBLIC", status: "READY" },
        { visibility: "UNLISTED", status: "READY" },
        ...(viewerChannelId ? [{ channelId: viewerChannelId }] : []),
      ],
    },
    select: { id: true, channelId: true, allowComments: true },
  });
  if (!video) throw notFound("That video does not exist or is not available.");
  return video;
}

function toView(row: CommentRow, viewer: ViewerContext, videoOwnerChannelId: string): CommentView {
  const isOwner = Boolean(viewer.userId && viewer.userId === row.userId);
  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === videoOwnerChannelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  const deleted = Boolean(row.deletedAt);

  return {
    id: row.id,
    body: deleted ? "" : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    isPinned: row.isPinned,
    isHidden: row.isHidden,
    isDeleted: deleted,
    likeCount: row.likeCount,
    replyCount: row.replyCount,
    author: {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      avatarKey: row.user.avatarKey,
      handle: row.user.channel?.handle ?? null,
    },
    viewer: {
      hasLiked: false,
      canEdit: isOwner && !deleted,
      canDelete: (isOwner || isVideoOwner || isModerator) && !deleted,
      canModerate: isVideoOwner || isModerator,
    },
  };
}

/**
 * Paginated top-level comments with an inline preview of replies.
 * `sort=top` orders by like count then recency; `newest` is pure recency.
 * Hidden comments are filtered out unless the viewer may moderate.
 */
export async function listComments(
  videoId: string,
  options: { sort?: CommentSort; offset?: number; limit?: number; viewer: ViewerContext },
): Promise<CommentPage> {
  const { sort = "top", offset = 0, limit = 20, viewer } = options;
  const video = await requireVisibleVideo(videoId, viewer.channelId);

  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  const canSeeHidden = isVideoOwner || isModerator;

  const where: Prisma.CommentWhereInput = {
    videoId,
    parentId: null,
    ...(canSeeHidden ? {} : { isHidden: false }),
  };

  const orderBy: Prisma.CommentOrderByWithRelationInput[] = [{ isPinned: "desc" }];
  if (sort === "top") orderBy.push({ likeCount: "desc" }, { createdAt: "desc" }, { id: "desc" });
  else orderBy.push({ createdAt: "desc" }, { id: "desc" });

  const [total, rows] = await Promise.all([
    prisma.comment.count({ where }),
    prisma.comment.findMany({
      where,
      orderBy,
      skip: offset,
      take: limit,
      select: COMMENT_SELECT,
    }),
  ]);

  // Replies are fetched in one extra query rather than N+1.
  const replyMap = new Map<string, CommentRow[]>();
  if (rows.length > 0) {
    const replies = await prisma.comment.findMany({
      where: {
        parentId: { in: rows.map((r) => r.id) },
        ...(canSeeHidden ? {} : { isHidden: false }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: COMMENT_SELECT,
    });
    for (const reply of replies) {
      if (!reply.parentId) continue;
      const bucket = replyMap.get(reply.parentId) ?? [];
      // Only keep the preview slice plus a couple of extra so replyCount and
      // the "view all" affordance stay honest.
      if (bucket.length < REPLY_PREVIEW_COUNT) bucket.push(reply);
      replyMap.set(reply.parentId, bucket);
    }
  }

  const items = rows.map((row) => {
    const view = toView(row, viewer, video.channelId);
    view.replies = (replyMap.get(row.id) ?? []).map((r) => toView(r, viewer, video.channelId));
    return view;
  });

  // Which of these did the viewer like? One query, only when signed in.
  const allIds = [...items.map((i) => i.id), ...items.flatMap((i) => (i.replies ?? []).map((r) => r.id))];
  if (viewer.userId && allIds.length > 0) {
    const likes = await prisma.commentLike.findMany({
      where: { userId: viewer.userId, commentId: { in: allIds } },
      select: { commentId: true },
    });
    const liked = new Set(likes.map((l) => l.commentId));
    for (const item of items) {
      item.viewer.hasLiked = liked.has(item.id);
      for (const reply of item.replies ?? []) reply.viewer.hasLiked = liked.has(reply.id);
    }
  }

  const nextOffset = offset + items.length < total ? offset + items.length : null;
  return { items, total, nextOffset };
}

/** Paginated replies for one thread. */
export async function listReplies(
  parentId: string,
  options: { offset?: number; limit?: number; viewer: ViewerContext },
): Promise<CommentPage> {
  const { offset = 0, limit = 50, viewer } = options;

  const parent = await prisma.comment.findFirst({
    where: { id: parentId },
    select: { id: true, videoId: true },
  });
  if (!parent) throw notFound("That comment does not exist.");

  const video = await requireVisibleVideo(parent.videoId, viewer.channelId);
  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  const canSeeHidden = isVideoOwner || isModerator;

  const where: Prisma.CommentWhereInput = {
    parentId,
    ...(canSeeHidden ? {} : { isHidden: false }),
  };

  const [total, rows] = await Promise.all([
    prisma.comment.count({ where }),
    prisma.comment.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: offset,
      take: limit,
      select: COMMENT_SELECT,
    }),
  ]);

  const items = rows.map((row) => toView(row, viewer, video.channelId));
  if (viewer.userId && items.length > 0) {
    const likes = await prisma.commentLike.findMany({
      where: { userId: viewer.userId, commentId: { in: items.map((i) => i.id) } },
      select: { commentId: true },
    });
    const liked = new Set(likes.map((l) => l.commentId));
    for (const item of items) item.viewer.hasLiked = liked.has(item.id);
  }

  const nextOffset = offset + items.length < total ? offset + items.length : null;
  return { items, total, nextOffset };
}

/**
 * Creates a comment or reply.
 * `replyTo` is the comment being answered; when it is itself a reply the new
 * comment is attached to that thread so threads stay one level deep.
 */
export async function createComment(
  videoId: string,
  viewer: ViewerContext,
  input: { body: string; parentId?: string; replyToId?: string },
): Promise<{ comment: CommentView }> {
  if (!viewer.userId) throw forbidden("Sign in to comment.");
  const video = await requireVisibleVideo(videoId, viewer.channelId);
  if (!video.allowComments) throw forbidden("Comments are turned off for this video.");

  const body = input.body.trim();
  if (!body) throw badRequest("Write something first.");

  let parentId: string | null = null;
  let replyTo: { id: string; userId: string } | null = null;

  const anchorId = input.parentId ?? input.replyToId;
  if (anchorId) {
    const anchor = await prisma.comment.findFirst({
      where: { id: anchorId, videoId, deletedAt: null },
      select: { id: true, parentId: true, userId: true },
    });
    if (!anchor) throw notFound("The comment you are replying to no longer exists.");
    // Flatten to a single level: replying to a reply joins the same thread.
    parentId = anchor.parentId ?? anchor.id;
    replyTo = { id: anchor.id, userId: anchor.userId };
  }

  const created = await prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: { videoId, userId: viewer.userId!, parentId, body },
      select: COMMENT_SELECT,
    });
    if (parentId) {
      await tx.comment.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } });
    }
    await tx.video.update({ where: { id: videoId }, data: { commentCount: { increment: 1 } } });
    return comment;
  });

  // Notifications are best-effort and never block the write.
  const excerpt = body.slice(0, 140);
  if (replyTo && replyTo.userId !== viewer.userId) {
    await notificationService.commentReply(viewer.userId, replyTo.userId, viewer.userId, videoId, created.id, excerpt);
  } else if (!parentId) {
    const owner = await prisma.channel.findUnique({
      where: { id: video.channelId },
      select: { ownerId: true, name: true, handle: true },
    });
    if (owner && owner.ownerId !== viewer.userId) {
      const actor = await prisma.user.findUnique({
        where: { id: viewer.userId },
        select: { displayName: true, username: true },
      });
      await notificationService.createNotification({
        userId: owner.ownerId,
        type: "COMMENT_REPLY",
        title: `${actor?.displayName ?? "Someone"} commented on your video`,
        body: excerpt,
        url: `/watch/${videoId}?comment=${created.id}`,
        actorUserId: viewer.userId,
        videoId,
        commentId: created.id,
        dedupeKey: `vcomment:${created.id}`,
      });
    }
  }

  log.info("comment created", { videoId, commentId: created.id, parentId });
  return { comment: toView(created, viewer, video.channelId) };
}

/** Edits the body of one's own comment. */
export async function updateComment(
  commentId: string,
  userId: string,
  body: string,
): Promise<{ comment: CommentView }> {
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, userId: true, videoId: true, deletedAt: true, video: { select: { channelId: true } } },
  });
  if (!existing || existing.deletedAt) throw notFound("That comment no longer exists.");
  if (existing.userId !== userId) throw forbidden("You can only edit your own comments.");

  const trimmed = body.trim();
  if (!trimmed) throw badRequest("A comment cannot be empty.");

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { body: trimmed, editedAt: new Date() },
    select: COMMENT_SELECT,
  });
  return {
    comment: toView(updated, { userId, channelId: null }, existing.video.channelId),
  };
}

/**
 * Deletes a comment.
 * Authors can delete their own; the video's owner and moderators can delete any.
 * A comment with replies is soft-deleted so the thread survives.
 */
export async function deleteComment(
  commentId: string,
  viewer: ViewerContext,
): Promise<{ deleted: true; hard: boolean }> {
  if (!viewer.userId) throw forbidden("Sign in first.");
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      userId: true,
      videoId: true,
      parentId: true,
      deletedAt: true,
      replyCount: true,
      video: { select: { channelId: true } },
    },
  });
  if (!existing || existing.deletedAt) throw notFound("That comment no longer exists.");

  const isAuthor = existing.userId === viewer.userId;
  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === existing.video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  if (!isAuthor && !isVideoOwner && !isModerator) {
    throw forbidden("You do not have permission to delete that comment.");
  }

  const hasReplies = existing.replyCount > 0;

  await prisma.$transaction(async (tx) => {
    if (hasReplies) {
      await tx.comment.update({
        where: { id: commentId },
        data: { deletedAt: new Date(), body: "", isPinned: false },
      });
    } else {
      await tx.comment.delete({ where: { id: commentId } });
      if (existing.parentId) {
        await tx.comment.update({ where: { id: existing.parentId }, data: { replyCount: { decrement: 1 } } });
      }
    }
    // Decrement the video counter in both cases: the comment is no longer
    // part of the conversation either way.
    await tx.video.update({ where: { id: existing.videoId }, data: { commentCount: { decrement: 1 } } });
  });

  log.info("comment deleted", { commentId, byAuthor: isAuthor, hard: !hasReplies });
  return { deleted: true, hard: !hasReplies };
}

/** Likes or unlikes a comment. Returns the authoritative count. */
export async function setCommentLike(
  commentId: string,
  userId: string,
  liked: boolean,
): Promise<{ liked: boolean; likeCount: number }> {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null, isHidden: false },
    select: { id: true, userId: true, videoId: true, body: true },
  });
  if (!comment) throw notFound("That comment no longer exists.");

  const existing = await prisma.commentLike.findUnique({
    where: { commentId_userId: { commentId, userId } },
    select: { id: true },
  });
  if (Boolean(existing) === liked) {
    const current = await prisma.comment.findUniqueOrThrow({ where: { id: commentId }, select: { likeCount: true } });
    return { liked, likeCount: current.likeCount };
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (liked) {
      await tx.commentLike.create({ data: { commentId, userId } });
    } else {
      await tx.commentLike.delete({ where: { commentId_userId: { commentId, userId } } });
    }
    return tx.comment.update({
      where: { id: commentId },
      data: { likeCount: liked ? { increment: 1 } : { decrement: 1 } },
      select: { likeCount: true },
    });
  });

  if (liked && comment.userId !== userId) {
    await notificationService.commentLike(comment.userId, userId, comment.videoId, commentId, comment.body.slice(0, 140));
  }

  return { liked, likeCount: updated.likeCount };
}

/**
 * Creator moderation: hide or restore a comment.
 * Hidden comments keep their replies and can be restored at any time.
 */
export async function setCommentHidden(
  commentId: string,
  viewer: ViewerContext,
  hidden: boolean,
): Promise<{ hidden: boolean }> {
  if (!viewer.userId) throw forbidden("Sign in first.");
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, isHidden: true, videoId: true, video: { select: { channelId: true } } },
  });
  if (!comment) throw notFound("That comment no longer exists.");

  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === comment.video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  if (!isVideoOwner && !isModerator) throw forbidden("Only the video's owner can moderate its comments.");

  if (comment.isHidden !== hidden) {
    await prisma.$transaction(async (tx) => {
      await tx.comment.update({ where: { id: commentId }, data: { isHidden: hidden, isPinned: false } });
      await tx.video.update({
        where: { id: comment.videoId },
        data: { commentCount: hidden ? { decrement: 1 } : { increment: 1 } },
      });
      // Reviewing a reported comment resolves its open reports: hiding it is
      // "actioned", un-hiding it is "dismissed". Either way the queue clears.
      await tx.commentReport.updateMany({
        where: { commentId, status: "OPEN" },
        data: { status: hidden ? "ACTIONED" : "DISMISSED" },
      });
    });
  }
  return { hidden };
}

/** Creator moderation: pin or unpin a top-level comment. */
export async function setCommentPinned(
  commentId: string,
  viewer: ViewerContext,
  pinned: boolean,
): Promise<{ pinned: boolean }> {
  if (!viewer.userId) throw forbidden("Sign in first.");
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      videoId: true,
      parentId: true,
      deletedAt: true,
      isHidden: true,
      video: { select: { channelId: true } },
    },
  });
  if (!comment || comment.deletedAt) throw notFound("That comment no longer exists.");
  if (comment.parentId) throw badRequest("Only top-level comments can be pinned.");
  if (comment.isHidden) throw badRequest("Restore the comment before pinning it.");

  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === comment.video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  if (!isVideoOwner && !isModerator) throw forbidden("Only the video's owner can pin comments.");

  await prisma.$transaction(async (tx) => {
    if (pinned) {
      // A video has at most one pinned comment.
      await tx.comment.updateMany({
        where: { videoId: comment.videoId, isPinned: true, NOT: { id: commentId } },
        data: { isPinned: false },
      });
    }
    await tx.comment.update({ where: { id: commentId }, data: { isPinned: pinned } });
  });
  return { pinned };
}

/** Reports a comment. One report per user per comment (enforced by a unique index). */
export async function reportComment(
  commentId: string,
  userId: string,
  reason: string,
): Promise<{ reported: true }> {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true },
  });
  if (!comment) throw notFound("That comment no longer exists.");

  try {
    await prisma.commentReport.create({ data: { commentId, reporterId: userId, reason } });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return { reported: true };
    }
    throw error;
  }
  return { reported: true };
}

export interface ReportedCommentView {
  id: string;
  reason: string;
  createdAt: string;
  reporter: { id: string; username: string; displayName: string };
  comment: CommentView;
}

export interface ReportedCommentPage {
  items: ReportedCommentView[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Moderation queue for one video.
 *
 * Only the video's owner (or a moderator) may read it — the same ownership
 * check guards `setCommentHidden`/`setCommentPinned`, so a creator can never
 * act on a comment belonging to another channel. Pagination has a documented
 * cap (`REPORT_PAGE_SIZE_MAX`) and a stable `(createdAt, id)` tiebreak so pages
 * do not overlap or skip when reports share a timestamp.
 */
export async function listReportedComments(
  videoId: string,
  viewer: ViewerContext,
  options: { page?: number; pageSize?: number } = {},
): Promise<ReportedCommentPage> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { channelId: true },
  });
  if (!video) throw notFound("That video does not exist.");
  const isVideoOwner = Boolean(viewer.channelId && viewer.channelId === video.channelId);
  const isModerator = Boolean(viewer.role && viewer.role !== "USER");
  if (!isVideoOwner && !isModerator) throw forbidden("Only the video's owner can review reports.");

  const pageSize = Math.min(REPORT_PAGE_SIZE_MAX, Math.max(1, Math.trunc(options.pageSize ?? REPORT_PAGE_SIZE_DEFAULT)));
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const where: Prisma.CommentReportWhereInput = { comment: { videoId }, status: "OPEN" };

  const [total, reports] = await Promise.all([
    prisma.commentReport.count({ where }),
    prisma.commentReport.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        reason: true,
        createdAt: true,
        reporter: { select: { id: true, username: true, displayName: true } },
        comment: { select: COMMENT_SELECT },
      },
    }),
  ]);

  return {
    items: reports.map((report) => ({
      id: report.id,
      reason: report.reason,
      createdAt: report.createdAt.toISOString(),
      reporter: report.reporter,
      comment: toView(report.comment, viewer, video.channelId),
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
