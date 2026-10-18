/**
 * Notification service.
 *
 * Writes rows synchronously (so the acting user gets immediate feedback) and
 * exposes `fanoutNewVideo` which is designed to run inside a background job —
 * the boundary is already correct for moving delivery to email/web push later.
 *
 * Duplicate suppression is enforced by a unique `dedupeKey`, so retrying a job
 * can never produce two notifications for the same event.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { NotificationType, Prisma } from "@prisma/client";

const log = logger.child({ mod: "notifications" });

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  url: string;
  actorUserId?: string | null;
  videoId?: string | null;
  commentId?: string | null;
  dedupeKey?: string;
}

/** Creates a notification, ignoring duplicates. Never throws to callers. */
export async function createNotification(input: CreateNotificationInput): Promise<{ id: string } | null> {
  if (input.actorUserId && input.actorUserId === input.userId) return null;
  try {
    return await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body ? input.body.slice(0, 500) : null,
        url: input.url.slice(0, 500),
        actorUserId: input.actorUserId ?? null,
        videoId: input.videoId ?? null,
        commentId: input.commentId ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return null;
    }
    // Notifications must never break the user-visible action that produced them.
    log.warn("could not create notification", { err: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export const notificationService = {
  createNotification,

  /** Channel owner learns about a new subscriber. */
  async subscriptionCreated(subscriberId: string, channel: { id: string; ownerId: string; name: string; handle: string }) {
    const subscriber = await prisma.user.findUnique({
      where: { id: subscriberId },
      select: { displayName: true, username: true },
    });
    if (!subscriber) return;
    await createNotification({
      userId: channel.ownerId,
      type: "NEW_SUBSCRIBER",
      title: `${subscriber.displayName} subscribed to your channel`,
      body: `@${subscriber.username} joined ${channel.name}`,
      url: `/channel/${channel.handle}`,
      actorUserId: subscriberId,
      // One notification per subscriber per channel, ever.
      dedupeKey: `sub:${channel.id}:${subscriberId}`,
    });
  },

  async commentReply(commentAuthorId: string, parentAuthorId: string, actorId: string, videoId: string, commentId: string, excerpt: string) {
    await createNotification({
      userId: parentAuthorId,
      type: "COMMENT_REPLY",
      title: "Someone replied to your comment",
      body: excerpt.slice(0, 140),
      url: `/watch/${videoId}?comment=${commentId}`,
      actorUserId: actorId,
      videoId,
      commentId,
      dedupeKey: `reply:${commentId}`,
    });
  },

  async commentLike(commentAuthorId: string, actorId: string, videoId: string, commentId: string, excerpt: string) {
    await createNotification({
      userId: commentAuthorId,
      type: "COMMENT_LIKE",
      title: "Someone liked your comment",
      body: excerpt.slice(0, 140),
      url: `/watch/${videoId}?comment=${commentId}`,
      actorUserId: actorId,
      videoId,
      commentId,
      dedupeKey: `clike:${commentId}:${actorId}`,
    });
  },

  async videoLike(channelOwnerId: string, actorId: string, videoId: string, videoTitle: string) {
    await createNotification({
      userId: channelOwnerId,
      type: "VIDEO_LIKE",
      title: "Someone liked your video",
      body: videoTitle.slice(0, 140),
      url: `/watch/${videoId}`,
      actorUserId: actorId,
      videoId,
      dedupeKey: `vlike:${videoId}:${actorId}`,
    });
  },

  /**
   * Fans a newly published video out to subscribers.
   * Runs as the `notification.fanout` job; idempotent per (video, subscriber).
   */
  async fanoutNewVideo(videoId: string): Promise<{ created: number; skipped: number }> {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        title: true,
        visibility: true,
        status: true,
        channelId: true,
        channel: { select: { name: true, handle: true } },
      },
    });
    if (!video || video.visibility !== "PUBLIC" || video.status !== "READY") {
      return { created: 0, skipped: 0 };
    }

    const subscribers = await prisma.subscription.findMany({
      where: { channelId: video.channelId, notifyLevel: { not: "none" } },
      select: { subscriberId: true },
      take: 5000,
    });

    let created = 0;
    let skipped = 0;

    // Batched createMany with skipDuplicates keeps this bounded on large
    // channels; the unique dedupeKey makes retries safe.
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const { subscriberId } of subscribers) {
      const dedupeKey = `newvideo:${videoId}:${subscriberId}`;
      const exists = await prisma.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (exists) {
        skipped++;
        continue;
      }
      rows.push({
        userId: subscriberId,
        type: "NEW_VIDEO",
        title: `${video.channel.name} uploaded a new video`,
        body: video.title.slice(0, 140),
        url: `/watch/${videoId}`,
        videoId,
        dedupeKey,
      });
    }

    for (let i = 0; i < rows.length; i += 500) {
      const result = await prisma.notification.createMany({
        data: rows.slice(i, i + 500),
        skipDuplicates: true,
      });
      created += result.count;
    }

    log.info("video notification fanout complete", { videoId, created, skipped });
    return { created, skipped };
  },

  async listForUser(userId: string, cursor?: string, limit = 20) {
    const rows = await prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        url: true,
        isRead: true,
        createdAt: true,
        actor: { select: { avatarKey: true } },
      },
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      url: row.url,
      isRead: row.isRead,
      createdAt: row.createdAt.toISOString(),
      actorAvatarKey: row.actor?.avatarKey ?? null,
    }));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  },

  async unreadCount(userId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, isRead: false } });
  },

  /** Marks every notification read. Idempotent. */
  async markAllRead(userId: string): Promise<number> {
    const result = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return result.count;
  },

  /** Marks one notification read, scoped to its owner. */
  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });
    return result.count === 1;
  },

  async prune(olderThanDays = 90): Promise<number> {
    const result = await prisma.notification.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - olderThanDays * 86_400_000) },
        isRead: true,
      },
    });
    return result.count;
  },
};
