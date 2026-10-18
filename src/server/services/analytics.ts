/**
 * Analytics service.
 *
 * Every number DEXTube shows is derived from stored events or aggregates:
 * `views`, `watch_history`, `watch_progress`, `video_reactions`, `comments`,
 * `subscriptions` and the daily rollup tables. Nothing is hard-coded.
 *
 * Divide of responsibility (this is the fix for the old read path, which
 * recomputed a whole range on every render):
 *   * `aggregateDailyStats` is the rollup job. It re-derives one day's
 *     `VideoDailyStat` / `ChannelDailyStat` rows from the raw event tables, so
 *     re-running it is safe and self-healing.
 *   * `getStudioOverview` serves **history** (every day before today) straight
 *     from those daily tables, and reads the raw tables only for the current,
 *     not-yet-finalised day. That keeps a dashboard render bounded — it no
 *     longer scales with the number of events in the selected range.
 *
 * Both paths share `rawVideoAggregates` / `rawChannelAggregates`, so the raw
 * "today" slice and the persisted rollup can never drift apart.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { startOfUtcDay } from "@/server/services/videos";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "analytics" });

export interface DailyAggregateResult {
  day: string;
  videos: number;
  channels: number;
}

/* ------------------------------------------------------- raw event reading */

/** Per-video totals for one half-open day window, read from the event tables. */
interface RawVideoAggregate {
  videoId: string;
  views: number;
  watchSeconds: number;
  likes: number;
  comments: number;
}

/** Per-channel totals for one half-open day window, read from the event tables. */
interface RawChannelAggregate {
  channelId: string;
  views: number;
  watchSeconds: number;
  uploads: number;
  subscribersGained: number;
}

/**
 * Reads the raw `views` / `watch_history` / `video_reactions` / `comments`
 * tables for `[from, to)` and folds them into one row per video.
 *
 * This is the **only** place those four sources are combined, so the rollup and
 * the Studio "today" slice are guaranteed to agree. `channelId` scopes the
 * whole read to one channel's videos (used by the read path); the rollup omits
 * it to rebuild every video.
 */
async function rawVideoAggregates(
  from: Date,
  to: Date,
  channelId?: string,
): Promise<Map<string, RawVideoAggregate>> {
  const viewScope = channelId
    ? Prisma.sql`JOIN videos v ON v.id = vw."videoId" WHERE vw."createdAt" >= ${from} AND vw."createdAt" < ${to} AND v."channelId" = ${channelId}`
    : Prisma.sql`WHERE vw."createdAt" >= ${from} AND vw."createdAt" < ${to}`;
  const watchScope = channelId
    ? Prisma.sql`JOIN videos v ON v.id = wh."videoId" WHERE wh."watchedAt" >= ${from} AND wh."watchedAt" < ${to} AND v."channelId" = ${channelId}`
    : Prisma.sql`WHERE wh."watchedAt" >= ${from} AND wh."watchedAt" < ${to}`;
  const likeScope = channelId
    ? Prisma.sql`JOIN videos v ON v.id = vr."videoId" WHERE vr."createdAt" >= ${from} AND vr."createdAt" < ${to} AND v."channelId" = ${channelId}`
    : Prisma.sql`WHERE vr."createdAt" >= ${from} AND vr."createdAt" < ${to}`;
  const commentScope = channelId
    ? Prisma.sql`JOIN videos v ON v.id = c."videoId" WHERE c."createdAt" >= ${from} AND c."createdAt" < ${to} AND c."deletedAt" IS NULL AND v."channelId" = ${channelId}`
    : Prisma.sql`WHERE c."createdAt" >= ${from} AND c."createdAt" < ${to} AND c."deletedAt" IS NULL`;

  const [viewRows, watchRows, likeRows, commentRows] = await Promise.all([
    prisma.$queryRaw<Array<{ videoId: string; views: bigint }>>`
      SELECT vw."videoId" AS "videoId", COUNT(*)::bigint AS views
      FROM views vw ${viewScope}
      GROUP BY vw."videoId"
    `,
    prisma.$queryRaw<Array<{ videoId: string; seconds: bigint }>>`
      SELECT wh."videoId" AS "videoId", COALESCE(SUM(wh.seconds), 0)::bigint AS seconds
      FROM watch_history wh ${watchScope}
      GROUP BY wh."videoId"
    `,
    prisma.$queryRaw<Array<{ videoId: string; likes: bigint }>>`
      SELECT vr."videoId" AS "videoId", COUNT(*)::bigint AS likes
      FROM video_reactions vr ${likeScope} AND vr.value = 'LIKE'
      GROUP BY vr."videoId"
    `,
    prisma.$queryRaw<Array<{ videoId: string; comments: bigint }>>`
      SELECT c."videoId" AS "videoId", COUNT(*)::bigint AS comments
      FROM comments c ${commentScope}
      GROUP BY c."videoId"
    `,
  ]);

  const aggregates = new Map<string, RawVideoAggregate>();
  const ensure = (videoId: string): RawVideoAggregate => {
    let row = aggregates.get(videoId);
    if (!row) {
      row = { videoId, views: 0, watchSeconds: 0, likes: 0, comments: 0 };
      aggregates.set(videoId, row);
    }
    return row;
  };

  for (const row of viewRows) ensure(row.videoId).views = Number(row.views);
  for (const row of watchRows) ensure(row.videoId).watchSeconds = Number(row.seconds);
  for (const row of likeRows) ensure(row.videoId).likes = Number(row.likes);
  for (const row of commentRows) ensure(row.videoId).comments = Number(row.comments);

  return aggregates;
}

/**
 * Per-channel totals for one half-open day window: views and watch seconds
 * rolled up from the raw events, uploads counted from `publishedAt`, and
 * subscription gains.
 *
 * Note: `subscribersLost` is deliberately left out. DEXTube deletes the
 * `Subscription` row on unsubscribe and stores no timestamp for it, so the
 * number is not derivable from stored data and is never fabricated.
 */
async function rawChannelAggregates(
  from: Date,
  to: Date,
): Promise<Map<string, RawChannelAggregate>> {
  const rows = await prisma.$queryRaw<
    Array<{ channelId: string; views: bigint; seconds: bigint; uploads: bigint }>
  >`
    WITH watched AS (
      SELECT v."channelId" AS "channelId", COUNT(*)::bigint AS views, 0::bigint AS seconds, 0::bigint AS uploads
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

  const aggregates = new Map<string, RawChannelAggregate>();
  const ensure = (channelId: string): RawChannelAggregate => {
    let row = aggregates.get(channelId);
    if (!row) {
      row = { channelId, views: 0, watchSeconds: 0, uploads: 0, subscribersGained: 0 };
      aggregates.set(channelId, row);
    }
    return row;
  };

  for (const row of rows) {
    const aggregate = ensure(row.channelId);
    aggregate.views = Number(row.views);
    aggregate.watchSeconds = Number(row.seconds);
    aggregate.uploads = Number(row.uploads);
  }
  for (const row of subGained) ensure(row.channelId).subscribersGained = Number(row.gained);

  return aggregates;
}

/* ------------------------------------------------------ set-based rollups */

/** `YYYY-MM-DD` literal for a DATE column, casting away the time component. */
function dayLiteral(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/**
 * Writes one day of per-video rollups in a single statement.
 *
 * `INSERT ... ON CONFLICT` keeps this O(1) statements no matter how many videos
 * were active: the old implementation issued one `upsert` per video, so
 * aggregating a busy channel was an N+1 write storm.
 */
async function writeVideoDailyStats(
  tx: Prisma.TransactionClient,
  day: Date,
  rows: RawVideoAggregate[],
): Promise<void> {
  if (rows.length === 0) return;
  const date = dayLiteral(day);
  const values = rows.map(
    (row) =>
      Prisma.sql`(${randomUUID()}, ${row.videoId}, ${date}::date, ${row.views}, ${row.watchSeconds}, ${row.likes}, ${row.comments})`,
  );
  await tx.$executeRaw`
    INSERT INTO video_daily_stats ("id", "videoId", day, views, "watchSeconds", likes, comments)
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("videoId", day) DO UPDATE SET
      views = EXCLUDED.views,
      "watchSeconds" = EXCLUDED."watchSeconds",
      likes = EXCLUDED.likes,
      comments = EXCLUDED.comments
  `;
}

/** Writes one day of per-channel rollups in a single statement. */
async function writeChannelDailyStats(
  tx: Prisma.TransactionClient,
  day: Date,
  rows: RawChannelAggregate[],
): Promise<void> {
  if (rows.length === 0) return;
  const date = dayLiteral(day);
  const values = rows.map(
    (row) =>
      Prisma.sql`(${randomUUID()}, ${row.channelId}, ${date}::date, ${row.views}, ${row.watchSeconds}, ${row.subscribersGained}, 0, ${row.uploads})`,
  );
  await tx.$executeRaw`
    INSERT INTO channel_daily_stats ("id", "channelId", day, views, "watchSeconds", "subscribersGained", "subscribersLost", uploads)
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("channelId", day) DO UPDATE SET
      views = EXCLUDED.views,
      "watchSeconds" = EXCLUDED."watchSeconds",
      "subscribersGained" = EXCLUDED."subscribersGained",
      uploads = EXCLUDED.uploads
  `;
}

/**
 * Rebuilds the daily rollups for `day`.
 * Values come from grouped raw queries; the write is set-based and idempotent,
 * so a late-arriving event is picked up on the next run.
 */
export async function aggregateDailyStats(day: Date): Promise<DailyAggregateResult> {
  const from = startOfUtcDay(day);
  const to = new Date(from.getTime() + 86_400_000);

  const [videos, channels] = await Promise.all([rawVideoAggregates(from, to), rawChannelAggregates(from, to)]);

  const videoRows = [...videos.values()];
  const channelRows = [...channels.values()];

  // Two statements total (one per table), regardless of how many rows the day
  // produced — see `writeVideoDailyStats`.
  await prisma.$transaction(async (tx) => {
    await writeVideoDailyStats(tx, from, videoRows);
    await writeChannelDailyStats(tx, from, channelRows);
  });

  const result = { day: dayLiteral(from), videos: videoRows.length, channels: channelRows.length };
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
 *
 * Days before today are read from the daily rollup tables; today is read from
 * the raw event tables, because the rollup for the current day is still being
 * refreshed (see `ensureTodayAggregated`). This keeps the query cost bounded by
 * the range length instead of by the number of events in it.
 */
export async function getStudioOverview(channelId: string, range: RangeKey): Promise<StudioOverview> {
  const days = rangeDays(range);
  const todayStart = startOfUtcDay();
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  const from = startOfUtcDay(new Date(todayStart.getTime() - (days - 1) * 86_400_000));
  const todayKey = dayLiteral(todayStart);

  const [channelStats, videoStats, todayVideos, todayUploads, todaySubsGained, channel, lifetimeVideos] =
    await Promise.all([
      prisma.channelDailyStat.findMany({
        where: { channelId, day: { gte: from, lt: todayStart } },
        orderBy: { day: "asc" },
      }),
      prisma.videoDailyStat.findMany({
        where: { video: { channelId }, day: { gte: from, lt: todayStart } },
        select: { videoId: true, day: true, views: true, watchSeconds: true, likes: true, comments: true },
      }),
      rawVideoAggregates(todayStart, tomorrowStart, channelId),
      prisma.video.count({ where: { channelId, deletedAt: null, publishedAt: { gte: todayStart, lt: tomorrowStart } } }),
      prisma.subscription.count({ where: { channelId, createdAt: { gte: todayStart, lt: tomorrowStart } } }),
      prisma.channel.findUnique({ where: { id: channelId }, select: { subscriberCount: true, videoCount: true } }),
      prisma.video.aggregate({
        where: { channelId, deletedAt: null },
        _sum: { viewCount: true, likeCount: true, commentCount: true },
      }),
    ]);

  // Dense series with zero-filled days; today is the raw slice, the rest comes
  // from the persisted rollups.
  const statsByDay = new Map(channelStats.map((row) => [dayLiteral(row.day), row]));
  const todayViews = [...todayVideos.values()].reduce((sum, row) => sum + row.views, 0);
  const todayWatchSeconds = [...todayVideos.values()].reduce((sum, row) => sum + row.watchSeconds, 0);

  const series: StudioOverview["series"] = [];
  for (let i = 0; i < days; i++) {
    const key = dayLiteral(new Date(from.getTime() + i * 86_400_000));
    if (key === todayKey) {
      series.push({
        day: key,
        views: todayViews,
        watchSeconds: todayWatchSeconds,
        subscribersGained: todaySubsGained,
        subscribersLost: 0,
      });
      continue;
    }
    const row = statsByDay.get(key);
    series.push({
      day: key,
      views: row?.views ?? 0,
      watchSeconds: row?.watchSeconds ?? 0,
      subscribersGained: row?.subscribersGained ?? 0,
      subscribersLost: row?.subscribersLost ?? 0,
    });
  }

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

  // Likes/comments are only stored per video, so history comes from
  // `VideoDailyStat` and today from the raw events; uploads likewise split
  // between the channel rollup and a live count.
  let historyLikes = 0;
  let historyComments = 0;
  for (const row of videoStats) {
    historyLikes += row.likes;
    historyComments += row.comments;
  }
  let todayLikes = 0;
  let todayComments = 0;
  for (const row of todayVideos.values()) {
    todayLikes += row.likes;
    todayComments += row.comments;
  }
  const historyUploads = channelStats.reduce((sum, row) => sum + row.uploads, 0);

  // Per-video views/watch seconds across the whole range (history + today).
  const perVideo = new Map<string, { views: number; watchSeconds: number }>();
  const addVideo = (videoId: string, views: number, watchSeconds: number) => {
    const current = perVideo.get(videoId) ?? { views: 0, watchSeconds: 0 };
    current.views += views;
    current.watchSeconds += watchSeconds;
    perVideo.set(videoId, current);
  };
  for (const row of videoStats) addVideo(row.videoId, row.views, row.watchSeconds);
  for (const row of todayVideos.values()) addVideo(row.videoId, row.views, row.watchSeconds);

  const topIds = [...perVideo.entries()]
    .sort((a, b) => b[1].views - a[1].views || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([videoId]) => videoId);

  const topVideoRows = topIds.length
    ? await prisma.video.findMany({
        where: { id: { in: topIds } },
        select: { id: true, title: true, thumbnailKey: true },
      })
    : [];
  // One lookup map instead of a `find` per id (the old O(n²) scan).
  const topById = new Map(topVideoRows.map((row) => [row.id, row]));

  return {
    range,
    totals: {
      views: totals.views,
      watchSeconds: totals.watchSeconds,
      likes: historyLikes + todayLikes,
      comments: historyComments + todayComments,
      subscribersGained: totals.subscribersGained,
      subscribersLost: totals.subscribersLost,
      netSubscribers: totals.subscribersGained - totals.subscribersLost,
      uploads: historyUploads + todayUploads,
      subscriberCount: channel?.subscriberCount ?? 0,
      videoCount: channel?.videoCount ?? 0,
    },
    series,
    topVideos: topIds.map((videoId) => ({
      videoId,
      title: topById.get(videoId)?.title ?? "Deleted video",
      thumbnailKey: topById.get(videoId)?.thumbnailKey ?? null,
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
