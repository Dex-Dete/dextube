/**
 * Analytics service.
 *
 * Every number DEXTube shows is derived from stored events or aggregates:
 * `views`, `watch_history`, `watch_progress`, `video_reactions`, `comments`,
 * `subscriptions` and the daily rollup tables. Nothing is hard-coded.
 *
 * `aggregateDailyStats` is the rollup job: it re-derives today's (or a given
 * day's) `VideoDailyStat` / `ChannelDailyStat` rows from those source tables,
 * so re-running it is safe and self-healing.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { startOfUtcDay } from "@/server/services/videos";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "analytics" });

export interface DailyAggregateResult {
  day: string;
  videos: number;
  channels: number;
}

/**
 * Rebuilds the daily rollups for `day`.
 * Values are computed with grouped queries; the write is an upsert so the job
 * is idempotent and a late-arriving event is picked up on the next run.
 */
export async function aggregateDailyStats(day: Date): Promise<DailyAggregateResult> {
  const from = startOfUtcDay(day);
  const to = new Date(from.getTime() + 86_400_000);

  // --- per-video views -----------------------------------------------------
  const viewRows = await prisma.$queryRaw<Array<{ videoId: string; views: bigint }>>`
    SELECT "videoId", COUNT(*)::bigint AS views
    FROM views
    WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY "videoId"
  `;

  // --- per-video watch seconds --------------------------------------------
  const watchRows = await prisma.$queryRaw<Array<{ videoId: string; seconds: bigint }>>`
    SELECT "videoId", COALESCE(SUM(seconds), 0)::bigint AS seconds
    FROM watch_history
    WHERE "watchedAt" >= ${from} AND "watchedAt" < ${to}
    GROUP BY "videoId"
  `;

  const likeRows = await prisma.$queryRaw<Array<{ videoId: string; likes: bigint }>>`
    SELECT "videoId", COUNT(*)::bigint AS likes
    FROM video_reactions
    WHERE value = 'LIKE' AND "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY "videoId"
  `;

  const commentRows = await prisma.$queryRaw<Array<{ videoId: string; comments: bigint }>>`
    SELECT "videoId", COUNT(*)::bigint AS comments
    FROM comments
    WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "deletedAt" IS NULL
    GROUP BY "videoId"
  `;

  const watch = new Map(watchRows.map((r) => [r.videoId, Number(r.seconds)]));
  const likes = new Map(likeRows.map((r) => [r.videoId, Number(r.likes)]));
  const comments = new Map(commentRows.map((r) => [r.videoId, Number(r.comments)]));

  // Videos that were viewed, watched, liked or commented on today.
  const videoIds = new Set<string>([
    ...viewRows.map((r) => r.videoId),
    ...watch.keys(),
    ...likes.keys(),
    ...comments.keys(),
  ]);

  for (const videoId of videoIds) {
    const views = Number(viewRows.find((r) => r.videoId === videoId)?.views ?? 0);
    await prisma.videoDailyStat.upsert({
      where: { videoId_day: { videoId, day: from } },
      create: {
        videoId,
        day: from,
        views,
        watchSeconds: watch.get(videoId) ?? 0,
        likes: likes.get(videoId) ?? 0,
        comments: comments.get(videoId) ?? 0,
      },
      update: {
        views,
        watchSeconds: watch.get(videoId) ?? 0,
        likes: likes.get(videoId) ?? 0,
        comments: comments.get(videoId) ?? 0,
      },
    });
  }

  // --- per-channel rollups -------------------------------------------------
  const channelRows = await prisma.$queryRaw<
    Array<{ channelId: string; views: bigint; seconds: bigint; uploads: bigint }>
  >`
    WITH watched AS (
      SELECT v."channelId", COUNT(*)::bigint AS views, 0::bigint AS seconds, 0::bigint AS uploads
      FROM views vw JOIN videos v ON v.id = vw."videoId"
      WHERE vw."createdAt" >= ${from} AND vw."createdAt" < ${to}
      GROUP BY v."channelId"
      UNION ALL
      SELECT v."channelId", 0::bigint, COALESCE(SUM(wh.seconds), 0)::bigint, 0::bigint
      FROM watch_history wh JOIN videos v ON v.id = wh."videoId"
      WHERE wh."watchedAt" >= ${from} AND wh."watchedAt" < ${to}
      GROUP BY v."channelId"
      UNION ALL
      SELECT v."channelId", 0::bigint, 0::bigint, COUNT(*)::bigint
      FROM videos v
      WHERE v."publishedAt" >= ${from} AND v."publishedAt" < ${to} AND v."deletedAt" IS NULL
      GROUP BY v."channelId"
    )
    SELECT "channelId", SUM(views)::bigint AS views, SUM(seconds)::bigint AS seconds, SUM(uploads)::bigint AS uploads
    FROM watched GROUP BY "channelId"
  `;

  const subGained = await prisma.$queryRaw<Array<{ channelId: string; gained: bigint }>>`
    SELECT "channelId", COUNT(*)::bigint AS gained
    FROM subscriptions
    WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
    GROUP BY "channelId"
  `;

  const channelIds = new Set<string>([...channelRows.map((r) => r.channelId), ...subGained.map((r) => r.channelId)]);

  for (const channelId of channelIds) {
    const row = channelRows.find((r) => r.channelId === channelId);
    await prisma.channelDailyStat.upsert({
      where: { channelId_day: { channelId, day: from } },
      create: {
        channelId,
        day: from,
        views: Number(row?.views ?? 0),
        watchSeconds: Number(row?.seconds ?? 0),
        uploads: Number(row?.uploads ?? 0),
        subscribersGained: Number(subGained.find((r) => r.channelId === channelId)?.gained ?? 0),
      },
      update: {
        views: Number(row?.views ?? 0),
        watchSeconds: Number(row?.seconds ?? 0),
        uploads: Number(row?.uploads ?? 0),
        subscribersGained: Number(subGained.find((r) => r.channelId === channelId)?.gained ?? 0),
      },
    });
  }

  const result = { day: from.toISOString().slice(0, 10), videos: videoIds.size, channels: channelIds.size };
  log.info("daily aggregation complete", result);
  return result;
}

/* -------------------------------------------------------------- reporting */

export type RangeKey = "7d" | "28d" | "90d" | "365d";

export function rangeDays(range: RangeKey): number {
  return { "7d": 7, "28d": 28, "90d": 90, "365d": 365 }[range];
}

export interface StudioOverview {
  range: RangeKey;
  totals: {
    views: number;
    watchSeconds: number;
    likes: number;
    comments: number;
    subscribersGained: number;
    subscribersLost: number;
    netSubscribers: number;
    uploads: number;
    subscriberCount: number;
    videoCount: number;
  };
  /** Dense series (one entry per day) for charting. */
  series: Array<{ day: string; views: number; watchSeconds: number; subscribersGained: number; subscribersLost: number }>;
  /** Top videos by views inside the range. */
  topVideos: Array<{ videoId: string; title: string; thumbnailKey: string | null; views: number; watchSeconds: number }>;
  /** All-time counters taken from the denormalised columns. */
  lifetime: { views: number; likes: number; comments: number; subscriberCount: number; videoCount: number };
}

/**
 * Studio dashboard data for a channel.
 * Reads the rollup tables, which are populated by `analytics.aggregate`, and
 * fills missing days with zeros so charts never have gaps.
 */
export async function getStudioOverview(channelId: string, range: RangeKey): Promise<StudioOverview> {
  const days = rangeDays(range);
  const from = startOfUtcDay(new Date(Date.now() - (days - 1) * 86_400_000));

  const [channelStats, videoStats, channel, lifetimeVideos] = await Promise.all([
    prisma.channelDailyStat.findMany({
      where: { channelId, day: { gte: from } },
      orderBy: { day: "asc" },
    }),
    prisma.videoDailyStat.findMany({
      where: { video: { channelId }, day: { gte: from } },
      orderBy: { day: "asc" },
      select: { videoId: true, day: true, views: true, watchSeconds: true },
    }),
    prisma.channel.findUnique({
      where: { id: channelId },
      select: { subscriberCount: true, videoCount: true },
    }),
    prisma.video.aggregate({
      where: { channelId, deletedAt: null },
      _sum: { viewCount: true, likeCount: true, commentCount: true },
    }),
  ]);

  // Dense series with zero-filled days.
  const statsByDay = new Map(channelStats.map((row) => [row.day.toISOString().slice(0, 10), row]));
  const series: StudioOverview["series"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000);
    const key = startOfUtcDay(date).toISOString().slice(0, 10);
    const row = statsByDay.get(key);
    series.push({
      day: key,
      views: row?.views ?? 0,
      watchSeconds: row?.watchSeconds ?? 0,
      subscribersGained: row?.subscribersGained ?? 0,
      subscribersLost: row?.subscribersLost ?? 0,
    });
  }

  const perVideo = new Map<string, { views: number; watchSeconds: number }>();
  for (const row of videoStats) {
    const current = perVideo.get(row.videoId) ?? { views: 0, watchSeconds: 0 };
    current.views += row.views;
    current.watchSeconds += row.watchSeconds;
    perVideo.set(row.videoId, current);
  }

  const topIds = [...perVideo.entries()]
    .sort((a, b) => b[1].views - a[1].views)
    .slice(0, 10)
    .map(([videoId]) => videoId);

  const topVideoRows = topIds.length
    ? await prisma.video.findMany({
        where: { id: { in: topIds } },
        select: { id: true, title: true, thumbnailKey: true },
      })
    : [];

  const totals = series.reduce(
    (acc, entry) => {
      acc.views += entry.views;
      acc.watchSeconds += entry.watchSeconds;
      acc.subscribersGained += entry.subscribersGained;
      acc.subscribersLost += entry.subscribersLost;
      return acc;
    },
    { views: 0, watchSeconds: 0, subscribersGained: 0, subscribersLost: 0 },
  );

  const [likes, comments, uploads] = await Promise.all([
    prisma.videoReaction.count({
      where: { value: "LIKE", createdAt: { gte: from }, video: { channelId } },
    }),
    prisma.comment.count({
      where: { createdAt: { gte: from }, deletedAt: null, video: { channelId } },
    }),
    prisma.video.count({
      where: { channelId, deletedAt: null, publishedAt: { gte: from } },
    }),
  ]);

  return {
    range,
    totals: {
      views: totals.views,
      watchSeconds: totals.watchSeconds,
      likes,
      comments,
      subscribersGained: totals.subscribersGained,
      subscribersLost: totals.subscribersLost,
      netSubscribers: totals.subscribersGained - totals.subscribersLost,
      uploads,
      subscriberCount: channel?.subscriberCount ?? 0,
      videoCount: channel?.videoCount ?? 0,
    },
    series,
    topVideos: topIds.map((videoId) => ({
      videoId,
      title: topVideoRows.find((v) => v.id === videoId)?.title ?? "Deleted video",
      thumbnailKey: topVideoRows.find((v) => v.id === videoId)?.thumbnailKey ?? null,
      views: perVideo.get(videoId)?.views ?? 0,
      watchSeconds: perVideo.get(videoId)?.watchSeconds ?? 0,
    })),
    lifetime: {
      views: lifetimeVideos._sum.viewCount ?? 0,
      likes: lifetimeVideos._sum.likeCount ?? 0,
      comments: lifetimeVideos._sum.commentCount ?? 0,
      subscriberCount: channel?.subscriberCount ?? 0,
      videoCount: channel?.videoCount ?? 0,
    },
  };
}

/**
 * Schedules today's rollup. Called when Studio is opened so a fresh instance
 * has current numbers immediately; the 15-minute bucket key matches the
 * recurring scheduler, so at most one refresh happens per bucket.
 */
export async function ensureTodayAggregated(): Promise<void> {
  const { enqueue } = await import("@/server/jobs/queue");
  const { AGGREGATE_REFRESH_MS } = await import("@/server/jobs/scheduler");
  const today = startOfUtcDay();
  const bucket = Math.floor(Date.now() / AGGREGATE_REFRESH_MS);
  await enqueue(
    "analytics.aggregate",
    { day: today.toISOString() },
    { dedupeKey: `analytics:${today.toISOString().slice(0, 10)}:${bucket}` },
  );
}
