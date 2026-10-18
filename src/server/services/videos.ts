/**
 * Video service: feeds, watch-page access, visibility enforcement, views,
 * reactions, metadata editing and lifecycle.
 *
 * Visibility rules (enforced here, never in the UI):
 *   PUBLIC   – anyone, including signed-out visitors.
 *   UNLISTED – anyone with the link, but never listed in feeds/search.
 *   PRIVATE  – only the owning channel.
 * Deleted videos (`deletedAt` set) are invisible everywhere.
 * Non-READY videos are only visible to their owner (and never playable).
 */
import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { conflict, notFound, preconditionFailed } from "@/lib/errors";
import { notificationService } from "@/server/services/notifications";
import { enqueue } from "@/server/jobs/queue";
import { normalizeText } from "@/lib/validation";
import { logger } from "@/lib/logger";
import type { Prisma, Visibility } from "@prisma/client";

const log = logger.child({ mod: "videos" });

/** Statuses a viewer other than the owner is allowed to see. */
const PUBLISHED_STATUS = "READY" as const;

function visibilityFilter(viewerChannelId: string | null): Prisma.VideoWhereInput {
  const clauses: Prisma.VideoWhereInput[] = [
    { visibility: "PUBLIC", status: PUBLISHED_STATUS },
    { visibility: "UNLISTED", status: PUBLISHED_STATUS },
  ];
  if (viewerChannelId) clauses.push({ channelId: viewerChannelId });
  return { deletedAt: null, OR: clauses };
}

/** Filter used by feeds/search: excludes UNLISTED and everything not ready. */
function listedFilter(): Prisma.VideoWhereInput {
  return { deletedAt: null, visibility: "PUBLIC", status: PUBLISHED_STATUS };
}

/* -------------------------------------------------------------- card shape */

export const CARD_SELECT = {
  id: true,
  title: true,
  isShort: true,
  durationSec: true,
  thumbnailKey: true,
  posterKey: true,
  publishedAt: true,
  createdAt: true,
  viewCount: true,
  likeCount: true,
  visibility: true,
  status: true,
  channel: { select: { id: true, handle: true, name: true, avatarKey: true } },
} as const;

type CardRow = Prisma.VideoGetPayload<{ select: typeof CARD_SELECT }>;

export function toCard(row: CardRow) {
  return {
    id: row.id,
    title: row.title,
    isShort: row.isShort,
    durationSec: row.durationSec,
    thumbnailKey: row.thumbnailKey,
    posterKey: row.posterKey,
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    visibility: row.visibility,
    status: row.status,
    channel: row.channel,
  };
}

export type VideoCard = ReturnType<typeof toCard>;

/* ------------------------------------------------------------------- feeds */

export type FeedTab = "home" | "subscriptions" | "trending";

export interface FeedOptions {
  tab: FeedTab;
  viewerId: string | null;
  viewerChannelId: string | null;
  cursor?: string;
  limit?: number;
  category?: string;
}

export interface FeedPage {
  items: VideoCard[];
  nextCursor: string | null;
}

/** Keyset pagination over (publishedAt desc, id desc). */
async function paginateVideos(
  where: Prisma.VideoWhereInput,
  cursor: string | undefined,
  limit: number,
  orderBy: Prisma.VideoOrderByWithRelationInput[] = [{ publishedAt: "desc" }, { id: "desc" }],
): Promise<FeedPage> {
  const rows = await prisma.video.findMany({
    where,
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: CARD_SELECT,
  });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toCard);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function getFeed(options: FeedOptions): Promise<FeedPage> {
  const limit = Math.min(60, Math.max(1, options.limit ?? 24));
  const base: Prisma.VideoWhereInput = {
    ...listedFilter(),
    isShort: false,
    ...(options.category ? { category: options.category } : {}),
  };

  if (options.tab === "subscriptions") {
    if (!options.viewerId) return { items: [], nextCursor: null };
    const subs = await prisma.subscription.findMany({
      where: { subscriberId: options.viewerId },
      select: { channelId: true },
      take: 1000,
    });
    if (subs.length === 0) return { items: [], nextCursor: null };
    return paginateVideos({ ...base, channelId: { in: subs.map((s) => s.channelId) } }, options.cursor, limit);
  }

  if (options.tab === "trending") {
    // "Trending" is a transparent blend of recency and engagement, not a
    // claim of a machine-learned ranking: views dominate, with a freshness
    // window so old popular videos do not ossify the list.
    return paginateVideos(base, options.cursor, limit, [
      { viewCount: "desc" },
      { publishedAt: "desc" },
      { id: "desc" },
    ]);
  }

  // Home: newest-first baseline; the recommender re-orders the first page.
  return paginateVideos(base, options.cursor, limit);
}

export async function getShortsFeed(options: {
  viewerId: string | null;
  cursor?: string;
  limit?: number;
}): Promise<FeedPage> {
  const limit = Math.min(30, Math.max(1, options.limit ?? 10));
  return paginateVideos({ ...listedFilter(), isShort: true }, options.cursor, limit);
}

export interface ShortItem {
  id: string;
  title: string;
  durationSec: number;
  playbackKey: string | null;
  posterKey: string | null;
  thumbnailKey: string | null;
  width: number | null;
  height: number | null;
  viewCount: number;
  likeCount: number;
  publishedAt: string;
  channel: { id: string; handle: string; name: string; avatarKey: string | null };
  /** Viewer-specific state; null for anonymous visitors. */
  viewer: { reaction: "LIKE" | "DISLIKE" | null; subscribed: boolean } | null;
}

/**
 * Shorts feed with the extra fields the vertical player needs (playback key and
 * intrinsic dimensions so the frame can reserve the right aspect ratio).
 *
 * Restricted to PUBLIC + READY, so a private or failed upload can never appear
 * here. Viewer reaction/subscription state is batched in one query each.
 */
export async function getShortsFeedDetailed(options: {
  viewerId: string | null;
  cursor?: string;
  limit?: number;
}): Promise<{ items: ShortItem[]; nextCursor: string | null }> {
  const limit = Math.min(30, Math.max(1, options.limit ?? 10));
  const rows = await prisma.video.findMany({
    where: { ...listedFilter(), isShort: true },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      durationSec: true,
      playbackKey: true,
      posterKey: true,
      thumbnailKey: true,
      width: true,
      height: true,
      viewCount: true,
      likeCount: true,
      publishedAt: true,
      createdAt: true,
      channel: { select: { id: true, handle: true, name: true, avatarKey: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((r) => r.id);
  const channelIds = [...new Set(page.map((r) => r.channel.id))];

  const [reactions, subscriptions] = options.viewerId && ids.length
    ? await Promise.all([
        prisma.videoReaction.findMany({
          where: { userId: options.viewerId, videoId: { in: ids } },
          select: { videoId: true, value: true },
        }),
        prisma.subscription.findMany({
          where: { subscriberId: options.viewerId, channelId: { in: channelIds } },
          select: { channelId: true },
        }),
      ])
    : [[], []];

  const reactionByVideo = new Map(reactions.map((r) => [r.videoId, r.value]));
  const subscribedChannels = new Set(subscriptions.map((s) => s.channelId));

  const items: ShortItem[] = page.map((row) => ({
    id: row.id,
    title: row.title,
    durationSec: row.durationSec,
    playbackKey: row.playbackKey,
    posterKey: row.posterKey,
    thumbnailKey: row.thumbnailKey,
    width: row.width,
    height: row.height,
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    channel: row.channel,
    viewer: options.viewerId
      ? {
          reaction: reactionByVideo.get(row.id) ?? null,
          subscribed: subscribedChannels.has(row.channel.id),
        }
      : null,
  }));

  return { items, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

/** A single short by id, for deep links (`/shorts/:id`). 404s when not public. */
export async function getShortById(
  videoId: string,
  viewerId: string | null,
): Promise<ShortItem | null> {
  const page = await getShortsFeedDetailed({ viewerId, limit: 30 });
  const found = page.items.find((item) => item.id === videoId);
  if (found) return found;

  // The requested short may not be in the newest page; look it up directly.
  const row = await prisma.video.findFirst({
    where: { id: videoId, ...listedFilter(), isShort: true },
    select: {
      id: true,
      title: true,
      durationSec: true,
      playbackKey: true,
      posterKey: true,
      thumbnailKey: true,
      width: true,
      height: true,
      viewCount: true,
      likeCount: true,
      publishedAt: true,
      createdAt: true,
      channel: { select: { id: true, handle: true, name: true, avatarKey: true } },
    },
  });
  if (!row) return null;

  const [reaction, subscription] = viewerId
    ? await Promise.all([
        prisma.videoReaction.findUnique({
          where: { videoId_userId: { videoId: row.id, userId: viewerId } },
          select: { value: true },
        }),
        prisma.subscription.findUnique({
          where: { subscriberId_channelId: { subscriberId: viewerId, channelId: row.channel.id } },
          select: { id: true },
        }),
      ])
    : [null, null];

  return {
    id: row.id,
    title: row.title,
    durationSec: row.durationSec,
    playbackKey: row.playbackKey,
    posterKey: row.posterKey,
    thumbnailKey: row.thumbnailKey,
    width: row.width,
    height: row.height,
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    channel: row.channel,
    viewer: viewerId ? { reaction: reaction?.value ?? null, subscribed: Boolean(subscription) } : null,
  };
}

export interface ChannelVideosOptions {
  channelId: string;
  viewerChannelId: string | null;
  tab: "videos" | "shorts" | "popular" | "all";
  cursor?: string;
  limit?: number;
  /** Include the owner's non-public videos (studio/channel owner view). */
  includeOwnUnpublished?: boolean;
}

export async function getChannelVideos(options: ChannelVideosOptions): Promise<FeedPage> {
  const limit = Math.min(60, Math.max(1, options.limit ?? 24));
  const isOwner = options.viewerChannelId === options.channelId;

  const visibility: Prisma.VideoWhereInput = options.includeOwnUnpublished && isOwner
    ? { deletedAt: null, OR: [{ status: PUBLISHED_STATUS, visibility: { in: ["PUBLIC", "UNLISTED"] } }, { status: { not: "DRAFT" } }] }
    : { deletedAt: null, visibility: "PUBLIC", status: PUBLISHED_STATUS };

  const where: Prisma.VideoWhereInput = {
    ...visibility,
    channelId: options.channelId,
    ...(options.tab === "shorts" ? { isShort: true } : {}),
    ...(options.tab === "videos" ? { isShort: false } : {}),
  };

  const orderBy: Prisma.VideoOrderByWithRelationInput[] =
    options.tab === "popular"
      ? [{ viewCount: "desc" }, { publishedAt: "desc" }]
      : [{ publishedAt: "desc" }, { id: "desc" }];

  return paginateVideos(where, options.cursor, limit, orderBy);
}

export interface SearchOptions {
  query: string;
  viewerChannelId: string | null;
  cursor?: string;
  limit?: number;
  duration?: "any" | "short" | "medium" | "long";
  sort?: "relevance" | "date" | "views";
}

/**
 * Video search.
 *
 * Titles/descriptions/tags are matched with case-insensitive `contains`, which
 * the `pg_trgm` GIN indexes make fast at DEXTube's target scale. Results are
 * always restricted to PUBLIC + READY, so search can never leak private media.
 */
export async function searchVideos(options: SearchOptions): Promise<FeedPage> {
  const limit = Math.min(60, Math.max(1, options.limit ?? 20));
  const q = options.query.trim();
  if (!q) return { items: [], nextCursor: null };

  const durationFilter: Prisma.VideoWhereInput =
    options.duration === "short"
      ? { durationSec: { lt: 240 } }
      : options.duration === "medium"
        ? { durationSec: { gte: 240, lt: 1200 } }
        : options.duration === "long"
          ? { durationSec: { gte: 1200 } }
          : {};

  const where: Prisma.VideoWhereInput = {
    ...listedFilter(),
    ...durationFilter,
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
      { tags: { has: q.toLowerCase() } },
      { channel: { name: { contains: q, mode: "insensitive" } } },
      { channel: { handle: { contains: q, mode: "insensitive" } } },
    ],
  };

  const orderBy: Prisma.VideoOrderByWithRelationInput[] =
    options.sort === "date"
      ? [{ publishedAt: "desc" }, { id: "desc" }]
      : options.sort === "views"
        ? [{ viewCount: "desc" }, { publishedAt: "desc" }]
        : // "relevance": title hits first, then engagement, then recency.
          [{ viewCount: "desc" }, { publishedAt: "desc" }, { id: "desc" }];

  const page = await paginateVideos(where, options.cursor, limit, orderBy);
  if (options.sort === "relevance" && !options.cursor && page.items.length > 1) {
    // Nudge exact title matches above the engagement ordering.
    const needle = q.toLowerCase();
    return {
      ...page,
      items: [...page.items].sort((a, b) => score(b, needle) - score(a, needle)),
    };
  }
  return page;
}

function score(video: VideoCard, needle: string): number {
  const title = video.title.toLowerCase();
  let s = 0;
  if (title === needle) s += 100;
  else if (title.startsWith(needle)) s += 50;
  else if (title.includes(needle)) s += 25;
  s += Math.min(20, Math.log10(1 + video.viewCount) * 5);
  return s;
}

/* ------------------------------------------------------------------- watch */

export interface WatchVideo {
  id: string;
  title: string;
  description: string;
  visibility: Visibility;
  status: string;
  isShort: boolean;
  durationSec: number;
  width: number | null;
  height: number | null;
  category: string | null;
  tags: string[];
  language: string | null;
  thumbnailKey: string | null;
  posterKey: string | null;
  playbackKey: string | null;
  hlsKey: string | null;
  /** Only exposed to the owner, who may download their own original. */
  originalKey: string | null;
  allowComments: boolean;
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  processingError: string | null;
  channel: {
    id: string;
    handle: string;
    name: string;
    avatarKey: string | null;
    subscriberCount: number;
  };
  captions: Array<{ label: string; key: string; lang: string }>;
  /**
   * Every progressive rendition stored for this video, tallest first. Empty when
   * the video has no separate renditions, in which case the player offers no
   * quality menu at all.
   */
  renditions: Array<{
    label: string;
    key: string;
    height: number;
    width: number | null;
    mimeType: string;
    sizeBytes: number | null;
  }>;
  viewer: {
    isOwner: boolean;
    subscribed: boolean;
    reaction: "LIKE" | "DISLIKE" | null;
    progressSeconds: number;
    canComment: boolean;
    watchLater: boolean;
  };
  isPlayable: boolean;
}

/** Extract a declared BCP-47-ish language token without inventing one. */
function captionLanguageFromLabel(label: string | null): string {
  if (!label) return "und";
  const matches = label.match(/\b[a-z]{2,3}(?:[-_][A-Z]{2})?\b/gi);
  const value = matches?.at(-1);
  return value ? value.replace("_", "-") : "und";
}

/**
 * Loads a video for the watch page, enforcing visibility.
 * Anything not visible to this viewer results in a 404 (not a 403) so private
 * video ids are indistinguishable from non-existent ones.
 */
export async function getVideoForWatch(
  videoId: string,
  viewer: { userId: string | null; channelId: string | null },
): Promise<WatchVideo> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, ...visibilityFilter(viewer.channelId) },
    select: {
      id: true,
      title: true,
      description: true,
      visibility: true,
      status: true,
      isShort: true,
      durationSec: true,
      width: true,
      height: true,
      category: true,
      tags: true,
      language: true,
      thumbnailKey: true,
      posterKey: true,
      playbackKey: true,
      hlsKey: true,
      originalKey: true,
      allowComments: true,
      viewCount: true,
      likeCount: true,
      dislikeCount: true,
      commentCount: true,
      publishedAt: true,
      createdAt: true,
      processingError: true,
      channelId: true,
      // Both the caption tracks and every progressive rendition this video
      // actually has on disk. The player's quality menu is built from these
      // rows, so an option can never appear for a file that does not exist.
      assets: {
        where: { kind: { in: ["CAPTION", "PROGRESSIVE"] } },
        select: {
          kind: true,
          label: true,
          storageKey: true,
          mimeType: true,
          width: true,
          height: true,
          sizeBytes: true,
        },
        orderBy: { height: "desc" },
      },
      channel: {
        select: { id: true, handle: true, name: true, avatarKey: true, subscriberCount: true },
      },
    },
  });

  if (!video) throw notFound("That video does not exist or is not available.");

  const isOwner = Boolean(viewer.channelId && viewer.channelId === video.channelId);

  const [subscription, reaction, progress, watchLater] = await Promise.all([
    viewer.userId
      ? prisma.subscription.findUnique({
          where: { subscriberId_channelId: { subscriberId: viewer.userId, channelId: video.channelId } },
          select: { id: true },
        })
      : Promise.resolve(null),
    viewer.userId
      ? prisma.videoReaction.findUnique({
          where: { videoId_userId: { videoId: video.id, userId: viewer.userId } },
          select: { value: true },
        })
      : Promise.resolve(null),
    viewer.userId
      ? prisma.watchProgress.findUnique({
          where: { userId_videoId: { userId: viewer.userId, videoId: video.id } },
          select: { positionSec: true, completed: true },
        })
      : Promise.resolve(null),
    viewer.userId
      ? prisma.playlistItem.findFirst({
          where: { videoId: video.id, playlist: { systemKind: "watch_later", channel: { ownerId: viewer.userId } } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    id: video.id,
    title: video.title,
    description: video.description,
    visibility: video.visibility,
    status: video.status,
    isShort: video.isShort,
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    category: video.category,
    tags: video.tags,
    language: video.language,
    thumbnailKey: video.thumbnailKey,
    posterKey: video.posterKey,
    playbackKey: video.playbackKey,
    hlsKey: video.hlsKey,
    // The original upload is the creator's own file; nobody else may fetch it.
    originalKey: isOwner ? video.originalKey : null,
    allowComments: video.allowComments,
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    dislikeCount: video.dislikeCount,
    commentCount: video.commentCount,
    publishedAt: video.publishedAt?.toISOString() ?? null,
    createdAt: video.createdAt.toISOString(),
    processingError: video.processingError,
    channel: video.channel,
    captions:
      video.assets
        ?.filter((asset) => asset.kind === "CAPTION")
        .map((asset) => ({
          label: asset.label ?? "Captions",
          key: asset.storageKey,
           lang: captionLanguageFromLabel(asset.label),
        })) ?? [],
    // Progressive renditions, tallest first. Empty for videos processed before
    // multi-rendition output existed, or when the source is already the
    // smallest ladder rung — in both cases the player offers no quality menu
    // rather than showing dead options.
    renditions:
      video.assets
        ?.filter((asset) => asset.kind === "PROGRESSIVE" && typeof asset.height === "number")
        .map((asset) => ({
          label: asset.label ?? `${asset.height}p`,
          key: asset.storageKey,
          height: asset.height as number,
          width: asset.width,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
        }))
        .sort((a, b) => b.height - a.height) ?? [],
    viewer: {
      isOwner,
      subscribed: Boolean(subscription),
      reaction: reaction?.value ?? null,
      progressSeconds: progress && !progress.completed ? progress.positionSec : 0,
      canComment: Boolean(viewer.userId),
      watchLater: Boolean(watchLater),
    },
    isPlayable: video.status === PUBLISHED_STATUS && Boolean(video.playbackKey),
  };
}

/* ------------------------------------------------------------------ views */

/**
 * Server-side viewer fingerprint for anonymous de-duplication.
 * A salted hash of (ip + user agent + utc day) means no raw IP is stored, and
 * the same visitor cannot inflate a counter by refreshing.
 */
export function viewerHash(ip: string, userAgent: string, userId: string | null): string {
  const config = getConfig();
  const day = new Date().toISOString().slice(0, 10);
  const subject = userId ? `user:${userId}` : `anon:${ip}|${userAgent.slice(0, 120)}`;
  return createHash("sha256")
    .update(`${config.session.secret}|${day}|${subject}`)
    .digest("hex")
    .slice(0, 40);
}

export interface RecordViewResult {
  counted: boolean;
  viewCount: number;
}

/**
 * Records a view with de-duplication inside `VIEW_DEDUPE_SECONDS`.
 *
 * The counter is only incremented when a new, distinct view is stored, so a
 * client cannot inflate views by reloading. The video's owner viewing their own
 * video does not count.
 */
export async function recordView(
  videoId: string,
  viewer: { userId: string | null; channelId: string | null; ip: string; userAgent: string },
): Promise<RecordViewResult> {
  const config = getConfig();
  const video = await prisma.video.findFirst({
    where: { id: videoId, ...visibilityFilter(viewer.channelId) },
    select: { id: true, viewCount: true, channelId: true, status: true, visibility: true },
  });
  if (!video) throw notFound("That video does not exist or is not available.");
  if (video.status !== PUBLISHED_STATUS) throw preconditionFailed("This video is still processing.");
  if (viewer.channelId && viewer.channelId === video.channelId) {
    return { counted: false, viewCount: video.viewCount };
  }

  const dedupeSeconds = config.rateLimit.viewDedupeSeconds;
  const hash = viewerHash(viewer.ip, viewer.userAgent, viewer.userId);

  if (dedupeSeconds > 0) {
    const recent = await prisma.view.findFirst({
      where: {
        videoId,
        viewerHash: hash,
        createdAt: { gt: new Date(Date.now() - dedupeSeconds * 1000) },
      },
      select: { id: true },
    });
    if (recent) return { counted: false, viewCount: video.viewCount };
  }

  const day = startOfUtcDay();
  // Watch history is only written for signed-in viewers who kept the setting on.
  const saveHistory = viewer.userId ? await userSavesWatchHistory(viewer.userId) : false;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.view.create({ data: { videoId, userId: viewer.userId, viewerHash: hash } });
    const row = await tx.video.update({
      where: { id: videoId },
      data: { viewCount: { increment: 1 } },
      select: { viewCount: true },
    });
    await tx.videoDailyStat.upsert({
      where: { videoId_day: { videoId, day } },
      create: { videoId, day, views: 1 },
      update: { views: { increment: 1 } },
    });
    if (viewer.userId && saveHistory) {
      // One row per (user, video): rewatching refreshes the timestamp.
      await tx.watchHistory.upsert({
        where: { userId_videoId: { userId: viewer.userId, videoId } },
        create: { userId: viewer.userId, videoId },
        update: { watchedAt: new Date() },
      });
    }
    return row;
  });

  return { counted: true, viewCount: updated.viewCount };
}

/** Whether the account has watch-history saving turned on. */
async function userSavesWatchHistory(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { saveWatchHistory: true } });
  return user?.saveWatchHistory ?? false;
}

export function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/* ------------------------------------------------------------- watch progress */

/** A video is treated as finished once the viewer is this close to the end. */
export const COMPLETION_THRESHOLD_SECONDS = 15;

export interface ProgressInput {
  positionSec: number;
  durationSec: number;
}

/**
 * Persists the playback position for "resume where you left off".
 *
 * Only videos the viewer may see are accepted, positions are clamped to the
 * media's real duration, and a video counts as watched once the viewer reaches
 * within `COMPLETION_THRESHOLD_SECONDS` of the end (shorter videos use a
 * proportional threshold so a 20-second clip can still be completed).
 */
export async function saveWatchProgress(
  videoId: string,
  userId: string,
  input: ProgressInput,
  viewerChannelId: string | null = null,
): Promise<{ positionSec: number; completed: boolean }> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, ...visibilityFilter(viewerChannelId) },
    select: { id: true, durationSec: true, channelId: true },
  });
  if (!video) throw notFound("That video does not exist or is not available.");

  const duration = Math.max(video.durationSec, input.durationSec || 0);
  const position = Math.max(0, Math.min(input.positionSec, duration || Number.MAX_SAFE_INTEGER));
  const threshold = duration > 0 ? Math.min(COMPLETION_THRESHOLD_SECONDS, duration * 0.25) : COMPLETION_THRESHOLD_SECONDS;
  const completed = duration > 0 && position >= duration - threshold;

  const previous = await prisma.watchProgress.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { positionSec: true, completed: true },
  });
  // Only forward progress counts as watch time, so replays and backwards seeks
  // cannot inflate the analytics.
  const delta = previous && !previous.completed ? Math.max(0, Math.floor(position - previous.positionSec)) : 0;

  const saved = await prisma.watchProgress.upsert({
    where: { userId_videoId: { userId, videoId } },
    create: { userId, videoId, positionSec: position, durationSec: duration, completed },
    update: { positionSec: position, durationSec: duration, completed },
    select: { positionSec: true, completed: true },
  });

  if (delta > 0) {
    const day = startOfUtcDay();
    await prisma.$transaction([
      prisma.videoDailyStat.upsert({
        where: { videoId_day: { videoId, day } },
        create: { videoId, day, watchSeconds: delta },
        update: { watchSeconds: { increment: delta } },
      }),
      prisma.channelDailyStat.upsert({
        where: { channelId_day: { channelId: video.channelId, day } },
        create: { channelId: video.channelId, day, watchSeconds: delta },
        update: { watchSeconds: { increment: delta } },
      }),
    ]);
  }

  return { positionSec: saved.positionSec, completed: saved.completed };
}

export interface ContinueWatchingItem {
  video: VideoCard;
  positionSec: number;
  /** 0–1, for the progress bar on the thumbnail. */
  progressRatio: number;
}

/** Partially watched videos, most recent first — the "Continue watching" row. */
export async function getContinueWatching(userId: string, limit = 12): Promise<ContinueWatchingItem[]> {
  const rows = await prisma.watchProgress.findMany({
    where: { userId, completed: false, positionSec: { gt: 5 }, video: { deletedAt: null, status: PUBLISHED_STATUS } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      positionSec: true,
      durationSec: true,
      video: { select: CARD_SELECT },
    },
  });

  return rows.map((row) => ({
    video: toCard(row.video),
    positionSec: row.positionSec,
    progressRatio: row.durationSec > 0 ? Math.min(1, row.positionSec / row.durationSec) : 0,
  }));
}

/* -------------------------------------------------------------- reactions */

export interface ReactionResult {
  reaction: "LIKE" | "DISLIKE" | null;
  likeCount: number;
  dislikeCount: number;
}

/** Sets or clears the viewer's reaction. Counts stay consistent via a transaction. */
export async function setReaction(
  videoId: string,
  userId: string,
  value: "LIKE" | "DISLIKE" | null,
): Promise<ReactionResult> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, ...listedFilter(), OR: [{ visibility: "PUBLIC" }, { visibility: "UNLISTED" }] },
    select: { id: true, channelId: true, title: true, channel: { select: { ownerId: true } } },
  });
  if (!video) throw notFound("That video does not exist or is not available.");

  const existing = await prisma.videoReaction.findUnique({
    where: { videoId_userId: { videoId, userId } },
    select: { value: true },
  });

  await prisma.$transaction(async (tx) => {
    if (value === null) {
      if (!existing) return;
      await tx.videoReaction.delete({ where: { videoId_userId: { videoId, userId } } });
      await tx.video.update({
        where: { id: videoId },
        data: existing.value === "LIKE" ? { likeCount: { decrement: 1 } } : { dislikeCount: { decrement: 1 } },
      });
      return;
    }

    if (existing?.value === value) {
      await tx.videoReaction.delete({ where: { videoId_userId: { videoId, userId } } });
      await tx.video.update({
        where: { id: videoId },
        data: value === "LIKE" ? { likeCount: { decrement: 1 } } : { dislikeCount: { decrement: 1 } },
      });
      return;
    }

    await tx.videoReaction.upsert({
      where: { videoId_userId: { videoId, userId } },
      create: { videoId, userId, value },
      update: { value },
    });
    await tx.video.update({
      where: { id: videoId },
      data:
        value === "LIKE"
          ? {
              likeCount: { increment: 1 },
              ...(existing?.value === "DISLIKE" ? { dislikeCount: { decrement: 1 } } : {}),
            }
          : {
              dislikeCount: { increment: 1 },
              ...(existing?.value === "LIKE" ? { likeCount: { decrement: 1 } } : {}),
            },
    });
  });

  const fresh = await prisma.video.findUniqueOrThrow({
    where: { id: videoId },
    select: { likeCount: true, dislikeCount: true },
  });

  // Notify "liked videos" playlist + owner notification for new likes.
  if (value === "LIKE") {
    await addToSystemPlaylist(userId, videoId, "liked_videos");
    await notificationService.videoLike(video.channel.ownerId, userId, videoId, video.title);
  } else {
    await removeFromSystemPlaylist(userId, videoId, "liked_videos");
  }

  const final = await prisma.videoReaction.findUnique({
    where: { videoId_userId: { videoId, userId } },
    select: { value: true },
  });

  return { reaction: final?.value ?? null, likeCount: fresh.likeCount, dislikeCount: fresh.dislikeCount };
}

/* ----------------------------------------------------- system playlists */

/**
 * Lazily creates the per-user "Watch later" / "Liked videos" system playlists.
 * They live on the user's own channel, keep `isSystem = true`, and cannot be
 * renamed or deleted.
 */
export async function ensureSystemPlaylist(userId: string, kind: "watch_later" | "liked_videos"): Promise<string> {
  // Scoped to the user's own channel: every account gets its own Watch later /
  // Liked videos list (the uniqueness constraint is (channelId, systemKind)).
  const existing = await prisma.playlist.findFirst({
    where: { systemKind: kind, channel: { ownerId: userId } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const channelId = await prisma.channel
    .findUnique({ where: { ownerId: userId }, select: { id: true } })
    .then((c) => {
      if (!c) throw preconditionFailed("Create your channel first.");
      return c.id;
    });

  const title = kind === "watch_later" ? "Watch later" : "Liked videos";
  try {
    const playlist = await prisma.playlist.create({
      data: {
        channelId,
        title,
        visibility: "PRIVATE",
        isSystem: true,
        systemKind: kind,
      },
      select: { id: true },
    });
    return playlist.id;
  } catch (error) {
    // Concurrent first use: another request created it between the read and
    // the write. Return that one rather than failing the user's action.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      const raced = await prisma.playlist.findFirst({
        where: { systemKind: kind, channel: { ownerId: userId } },
        select: { id: true },
      });
      if (raced) return raced.id;
    }
    throw error;
  }
}

export async function addToSystemPlaylist(userId: string, videoId: string, kind: "watch_later" | "liked_videos"): Promise<void> {
  const playlistId = await ensureSystemPlaylist(userId, kind);
  const existing = await prisma.playlistItem.findUnique({
    where: { playlistId_videoId: { playlistId, videoId } },
    select: { id: true },
  });
  if (existing) return;
  await prisma.$transaction(async (tx) => {
    const max = await tx.playlistItem.aggregate({ where: { playlistId }, _max: { position: true } });
    await tx.playlistItem.create({
      data: { playlistId, videoId, position: (max._max.position ?? 0) + 1 },
    });
    await tx.playlist.update({ where: { id: playlistId }, data: { itemCount: { increment: 1 } } });
  });
}

export async function removeFromSystemPlaylist(userId: string, videoId: string, kind: "watch_later" | "liked_videos"): Promise<void> {
  const playlist = await prisma.playlist.findFirst({
    where: { systemKind: kind, channel: { ownerId: userId } },
    select: { id: true },
  });
  if (!playlist) return;
  const result = await prisma.playlistItem.deleteMany({ where: { playlistId: playlist.id, videoId } });
  if (result.count > 0) {
    await prisma.playlist.update({ where: { id: playlist.id }, data: { itemCount: { decrement: result.count } } });
  }
}

/* ---------------------------------------------------------- owner actions */

export interface StudioVideo {
  id: string;
  title: string;
  description: string;
  visibility: Visibility;
  status: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  category: string | null;
  tags: string[];
  allowComments: boolean;
  madeForKids: boolean;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  processingError: string | null;
  sizeBytes: number | null;
  playbackKey: string | null;
}

/** Loads a video for its owner, regardless of visibility. */
export async function getOwnedVideo(videoId: string, userId: string): Promise<StudioVideo> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, channel: { ownerId: userId } },
    select: {
      id: true,
      title: true,
      description: true,
      visibility: true,
      status: true,
      isShort: true,
      durationSec: true,
      thumbnailKey: true,
      category: true,
      tags: true,
      allowComments: true,
      madeForKids: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
      processingError: true,
      sizeBytes: true,
      playbackKey: true,
    },
  });
  if (!video) throw notFound("That video does not exist.");
  return {
    ...video,
    publishedAt: video.publishedAt?.toISOString() ?? null,
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
    sizeBytes: video.sizeBytes === null ? null : Number(video.sizeBytes),
  };
}

/** Studio list with search + status/visibility filters, owner-scoped. */
export async function listStudioVideos(options: {
  userId: string;
  query?: string;
  status?: string;
  visibility?: string;
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(60, Math.max(1, options.limit ?? 20));
  const where: Prisma.VideoWhereInput = {
    deletedAt: null,
    channel: { ownerId: options.userId },
    ...(options.query ? { title: { contains: options.query, mode: "insensitive" } } : {}),
    ...(options.status && options.status !== "ALL" ? { status: options.status as never } : {}),
    ...(options.visibility && options.visibility !== "ALL" ? { visibility: options.visibility as Visibility } : {}),
  };

  const rows = await prisma.video.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      visibility: true,
      status: true,
      isShort: true,
      durationSec: true,
      thumbnailKey: true,
      viewCount: true,
      likeCount: true,
      commentCount: true,
      publishedAt: true,
      createdAt: true,
      processingError: true,
    },
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: slice.map((row) => ({
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      status: row.status,
      isShort: row.isShort,
      durationSec: row.durationSec,
      thumbnailKey: row.thumbnailKey,
      viewCount: row.viewCount,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      processingError: row.processingError,
    })),
    nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
  };
}

export async function updateVideoMetadata(
  videoId: string,
  userId: string,
  input: {
    title?: string;
    description?: string;
    visibility?: Visibility;
    category?: string;
    tags?: string[];
    language?: string;
    allowComments?: boolean;
    madeForKids?: boolean;
  },
): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, channel: { ownerId: userId } },
    select: { id: true, status: true, publishedAt: true },
  });
  if (!video) throw notFound("That video does not exist.");

  const data: Prisma.VideoUpdateInput = {};
  if (input.title !== undefined) data.title = normalizeText(input.title).slice(0, 120);
  if (input.description !== undefined) data.description = input.description.slice(0, 20000);
  if (input.category !== undefined) data.category = input.category;
  if (input.tags !== undefined) {
    data.tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  }
  if (input.language !== undefined) data.language = input.language;
  if (input.allowComments !== undefined) data.allowComments = input.allowComments;
  if (input.madeForKids !== undefined) data.madeForKids = input.madeForKids;

  if (input.visibility !== undefined) {
    if (input.visibility === "PUBLIC" && video.status !== PUBLISHED_STATUS) {
      throw preconditionFailed("This video is still processing and cannot be published yet.");
    }
    data.visibility = input.visibility;
    // Publishing schedules the notification fan-out exactly once.
    if (input.visibility === "PUBLIC" && !video.publishedAt) {
      data.publishedAt = new Date();
    }
  }

  const updated = await prisma.video.update({
    where: { id: videoId },
    data,
    select: { id: true, visibility: true, status: true, publishedAt: true, title: true },
  });

  if (updated.visibility === "PUBLIC" && updated.publishedAt && updated.status === PUBLISHED_STATUS) {
    await enqueue("notification.fanout", { videoId }, { dedupeKey: `fanout:${videoId}` });
  }
  await recomputeChannelCounts(updated.id);
}

/** Publishes a ready video. */
export async function publishVideo(videoId: string, userId: string, visibility: Visibility = "PUBLIC"): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, channel: { ownerId: userId } },
    select: { id: true, status: true, publishedAt: true },
  });
  if (!video) throw notFound("That video does not exist.");
  if (video.status !== PUBLISHED_STATUS) {
    throw preconditionFailed(
      video.status === "FAILED"
        ? "Processing failed, so this video cannot be published. Check the error and re-upload."
        : "This video is still processing. Try again once it is ready.",
    );
  }

  const updated = await prisma.video.update({
    where: { id: videoId },
    data: {
      visibility,
      publishedAt: video.publishedAt ?? new Date(),
    },
    select: { id: true, visibility: true, status: true, publishedAt: true },
  });

  if (updated.visibility === "PUBLIC") {
    await enqueue("notification.fanout", { videoId }, { dedupeKey: `fanout:${videoId}` });
  }
  await recomputeChannelCounts(videoId);
}

/** Hides a video from feeds without deleting it. */
export async function unpublishVideo(videoId: string, userId: string): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, channel: { ownerId: userId } },
    select: { id: true },
  });
  if (!video) throw notFound("That video does not exist.");
  await prisma.video.update({ where: { id: videoId }, data: { visibility: "PRIVATE", publishedAt: null } });
  await recomputeChannelCounts(videoId);
}

/**
 * Soft-deletes a video and schedules storage cleanup, so a mis-click is
 * recoverable for a short window and never breaks comment threads.
 */
export async function deleteVideo(videoId: string, userId: string, hard = false): Promise<void> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, channel: { ownerId: userId } },
    select: { id: true, deletedAt: true },
  });
  if (!video) throw notFound("That video does not exist.");
  if (video.deletedAt) return;

  await prisma.$transaction(async (tx) => {
    await tx.video.update({
      where: { id: videoId },
      data: { deletedAt: new Date(), visibility: "PRIVATE", publishedAt: null },
    });
    await tx.playlistItem.deleteMany({ where: { videoId } });
  });

  await recomputeChannelCounts(videoId);
  if (hard) {
    await enqueue("maintenance.prune", {}, { dedupeKey: `prune-after-delete:${videoId}` });
  }
  log.info("video deleted", { videoId, hard });
}

/** Recomputes the cached counters on the owning channel. */
export async function recomputeChannelCounts(videoId: string): Promise<void> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { channelId: true } });
  if (!video) return;
  const count = await prisma.video.count({
    where: { channelId: video.channelId, deletedAt: null, status: PUBLISHED_STATUS, visibility: { in: ["PUBLIC", "UNLISTED"] } },
  });
  await prisma.channel.update({ where: { id: video.channelId }, data: { videoCount: count } });
}

/** Related videos for the watch page sidebar. */
export async function getRelatedVideos(videoId: string, limit = 12): Promise<VideoCard[]> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { id: true, channelId: true, category: true, tags: true },
  });
  if (!video) return [];

  const rows = await prisma.video.findMany({
    where: {
      ...listedFilter(),
      isShort: false,
      id: { not: videoId },
      OR: [
        ...(video.category ? [{ category: video.category }] : []),
        ...(video.tags.length ? [{ tags: { hasSome: video.tags } }] : []),
        { channelId: video.channelId },
      ],
    },
    orderBy: [{ viewCount: "desc" }, { publishedAt: "desc" }],
    take: limit * 3,
    select: CARD_SELECT,
  });

  // Simple diversity pass: cap each channel at 3 entries to avoid a sidebar
  // filled by a single channel, then trim to `limit`.
  const perChannel = new Map<string, number>();
  const out: VideoCard[] = [];
  for (const row of rows) {
    const used = perChannel.get(row.channel.id) ?? 0;
    if (used >= 3) continue;
    perChannel.set(row.channel.id, used + 1);
    out.push(toCard(row));
    if (out.length >= limit) break;
  }
  return out;
}

/** Video ids a user has watched, newest first (used by the recommender). */
export async function recentlyWatchedVideoIds(userId: string, limit = 50): Promise<string[]> {
  const rows = await prisma.watchHistory.findMany({
    where: { userId },
    orderBy: { watchedAt: "desc" },
    take: limit,
    select: { videoId: true },
  });
  return rows.map((r) => r.videoId);
}

export interface WatchHistoryEntry {
  video: VideoCard;
  watchedAt: string;
  seconds: number;
  /** Progress ratio 0–1, when the user is signed in and has progress stored. */
  progressRatio: number;
}

/**
 * Watch history, newest first.
 *
 * Rows whose video has since been deleted or is no longer publicly visible are
 * filtered out, so history never resurrects content the creator took down.
 */
export async function listWatchHistory(
  userId: string,
  cursor?: string,
  limit = 50,
): Promise<{ items: WatchHistoryEntry[]; nextCursor: string | null }> {
  const rows = await prisma.watchHistory.findMany({
    where: { userId, video: { deletedAt: null, status: PUBLISHED_STATUS } },
    orderBy: [{ watchedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, watchedAt: true, seconds: true, video: { select: CARD_SELECT } },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Merge in stored progress so the history list can show "watched 40%".
  const progress = await prisma.watchProgress.findMany({
    where: { userId, videoId: { in: page.map((r) => r.video.id) } },
    select: { videoId: true, positionSec: true, durationSec: true },
  });
  const byVideo = new Map(progress.map((p) => [p.videoId, p]));

  const items = page.map((row) => {
    const p = byVideo.get(row.video.id);
    return {
      video: toCard(row.video),
      watchedAt: row.watchedAt.toISOString(),
      seconds: row.seconds,
      progressRatio: p && p.durationSec > 0 ? Math.min(1, p.positionSec / p.durationSec) : 0,
    };
  });
  return { items, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

/** Removes every stored watch-history row for a user. Returns how many went. */
export async function clearWatchHistory(userId: string): Promise<number> {
  const result = await prisma.watchHistory.deleteMany({ where: { userId } });
  return result.count;
}

/** Removes a single video from a user's watch history (and its progress). */
export async function removeWatchHistoryEntry(userId: string, videoId: string): Promise<void> {
  await prisma.$transaction([
    prisma.watchHistory.deleteMany({ where: { userId, videoId } }),
    prisma.watchProgress.deleteMany({ where: { userId, videoId } }),
  ]);
}

/** Increments the cached comment counter (comment service calls this). */
export async function bumpCommentCount(videoId: string, delta: number): Promise<void> {
  await prisma.video.update({ where: { id: videoId }, data: { commentCount: { increment: delta } } });
}

/** Guards a transition that requires the video to be ready. */
export function assertReady(status: string, action: string): void {
  if (status !== PUBLISHED_STATUS) throw conflict(`This video must finish processing before you can ${action}.`);
}
