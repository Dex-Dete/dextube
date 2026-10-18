import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import { aggregateDailyStats, getStudioOverview } from "@/server/services/analytics";
import { listStudioVideoPage, STUDIO_PAGE_SIZE_MAX } from "@/server/services/studio-videos";
import { listReportedComments, REPORT_PAGE_SIZE_MAX } from "@/server/services/comments";
import { cleanupFixtures, createReadyVideo, createTestUser, uniqueSuffix } from "./helpers";

/**
 * Studio analytics + content-management regressions.
 *
 * The two things that used to be wrong and must stay fixed:
 *   1. The dashboard recomputed a whole range from raw events on every render,
 *      and the rollup wrote one row per video (N+1). The rollup now rebuilds a
 *      day with two set-based statements, and the dashboard reads the persisted
 *      daily tables — so the aggregate path and the raw path have to agree.
 *   2. Neither the video table nor the moderation queue was paginated.
 *
 * These tests run against the real database. Fixtures live in the `itest_`
 * namespace and are removed afterwards.
 */

const dbOk = (await checkDatabase()).ok;

const DAY_MS = 86_400_000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Nothing in the real dataset may be overwritten by a rollup rebuild. */
async function dayHasEvents(day: Date): Promise<boolean> {
  const from = day;
  const to = new Date(day.getTime() + DAY_MS);
  const [views, watch, comments, reactions, subs, published] = await Promise.all([
    prisma.view.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.watchHistory.count({ where: { watchedAt: { gte: from, lt: to } } }),
    prisma.comment.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.videoReaction.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.subscription.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.video.count({ where: { publishedAt: { gte: from, lt: to } } }),
  ]);
  return views + watch + comments + reactions + subs + published > 0;
}

/**
 * Finds a day inside the 365-day reporting window that has no real events, so
 * rebuilding its rollup can only touch this file's fixtures. Searches backwards
 * from 180 days ago and falls back progressively further.
 */
async function findEmptyRollupDay(): Promise<Date> {
  let day = startOfUtcDay(new Date(Date.now() - 180 * DAY_MS));
  for (let i = 0; i < 360 && (await dayHasEvents(day)); i++) {
    day = new Date(day.getTime() - DAY_MS);
  }
  return day;
}

const rollupDay = dbOk ? await findEmptyRollupDay() : startOfUtcDay(new Date(0));
const rollupDay2 = dbOk ? new Date(rollupDay.getTime() - DAY_MS) : startOfUtcDay(new Date(0));
const dayFrom = rollupDay;
const dayTo = new Date(rollupDay.getTime() + DAY_MS);
const at = (day: Date, hours: number, minutes = 0) =>
  new Date(day.getTime() + hours * 3_600_000 + minutes * 60_000);

afterAll(async () => {
  if (dbOk) await cleanupFixtures();
});

describe.skipIf(!dbOk)("Studio daily rollups (database)", () => {
  it("writes daily rows that exactly match a fresh raw recomputation", async () => {
    const owner = await createTestUser();
    const fan1 = await createTestUser();
    const fan2 = await createTestUser();

    const videoA = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `A ${uniqueSuffix()}`,
      publishedAt: at(rollupDay, 9),
    });
    const videoB = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `B ${uniqueSuffix()}`,
      publishedAt: at(rollupDay, 10),
    });
    // Published but never watched: proves uploads are counted even without any
    // engagement event (there is no `videoDailyStat` row for it).
    const videoC = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `C ${uniqueSuffix()}`,
      publishedAt: at(rollupDay, 11),
    });

    // --- raw events on the rollup day -------------------------------------
    for (let i = 0; i < 3; i++) {
      await prisma.view.create({
        data: {
          videoId: videoA.id,
          userId: owner.userId,
          viewerHash: `itest-${uniqueSuffix()}`,
          watchedSeconds: 30,
          createdAt: at(rollupDay, 12, i),
        },
      });
    }
    await prisma.view.create({
      data: {
        videoId: videoB.id,
        userId: owner.userId,
        viewerHash: `itest-${uniqueSuffix()}`,
        watchedSeconds: 15,
        createdAt: at(rollupDay, 13),
      },
    });

    await prisma.watchHistory.create({
      data: { userId: owner.userId, videoId: videoA.id, seconds: 90, watchedAt: at(rollupDay, 12) },
    });
    await prisma.watchHistory.create({
      data: { userId: fan1.userId, videoId: videoA.id, seconds: 60, watchedAt: at(rollupDay, 12, 5) },
    });
    await prisma.watchHistory.create({
      data: { userId: owner.userId, videoId: videoB.id, seconds: 45, watchedAt: at(rollupDay, 13) },
    });

    await prisma.videoReaction.create({
      data: { videoId: videoA.id, userId: owner.userId, value: "LIKE", createdAt: at(rollupDay, 14) },
    });
    await prisma.videoReaction.create({
      data: { videoId: videoA.id, userId: fan1.userId, value: "LIKE", createdAt: at(rollupDay, 14, 1) },
    });
    // Dislikes must not count towards the likes metric.
    await prisma.videoReaction.create({
      data: { videoId: videoB.id, userId: owner.userId, value: "DISLIKE", createdAt: at(rollupDay, 14, 2) },
    });

    await prisma.comment.create({
      data: { videoId: videoA.id, userId: owner.userId, body: "one", createdAt: at(rollupDay, 15) },
    });
    await prisma.comment.create({
      data: { videoId: videoA.id, userId: fan1.userId, body: "two", createdAt: at(rollupDay, 15, 1) },
    });
    // Soft-deleted comments are excluded from the count.
    await prisma.comment.create({
      data: {
        videoId: videoA.id,
        userId: fan2.userId,
        body: "removed",
        createdAt: at(rollupDay, 15, 2),
        deletedAt: at(rollupDay, 15, 30),
      },
    });
    await prisma.comment.create({
      data: { videoId: videoB.id, userId: owner.userId, body: "three", createdAt: at(rollupDay, 15, 3) },
    });

    await prisma.subscription.create({
      data: { subscriberId: fan1.userId, channelId: owner.channelId, createdAt: at(rollupDay, 16) },
    });
    await prisma.subscription.create({
      data: { subscriberId: fan2.userId, channelId: owner.channelId, createdAt: at(rollupDay, 16, 5) },
    });

    // --- run the rollup ---------------------------------------------------
    await aggregateDailyStats(rollupDay);

    // --- expected values, computed independently of the service's SQL ------
    const expectedVideo = async (videoId: string) => {
      const [views, watch, likes, comments] = await Promise.all([
        prisma.view.count({ where: { videoId, createdAt: { gte: dayFrom, lt: dayTo } } }),
        prisma.watchHistory.aggregate({
          where: { videoId, watchedAt: { gte: dayFrom, lt: dayTo } },
          _sum: { seconds: true },
        }),
        prisma.videoReaction.count({
          where: { videoId, value: "LIKE", createdAt: { gte: dayFrom, lt: dayTo } },
        }),
        prisma.comment.count({ where: { videoId, deletedAt: null, createdAt: { gte: dayFrom, lt: dayTo } } }),
      ]);
      return { views, watchSeconds: watch._sum.seconds ?? 0, likes, comments };
    };

    for (const [video, expected] of [
      [videoA, { views: 3, watchSeconds: 150, likes: 2, comments: 2 }],
      [videoB, { views: 1, watchSeconds: 45, likes: 0, comments: 1 }],
    ] as const) {
      const raw = await expectedVideo(video.id);
      expect(raw).toEqual(expected);

      const row = await prisma.videoDailyStat.findUnique({
        where: { videoId_day: { videoId: video.id, day: rollupDay } },
      });
      expect(row).not.toBeNull();
      expect({
        views: row!.views,
        watchSeconds: row!.watchSeconds,
        likes: row!.likes,
        comments: row!.comments,
      }).toEqual(expected);
    }

    // A published-but-unwatched video has no per-video row.
    const emptyRow = await prisma.videoDailyStat.findUnique({
      where: { videoId_day: { videoId: videoC.id, day: rollupDay } },
    });
    expect(emptyRow).toBeNull();

    // --- channel rollup vs. raw events ------------------------------------
    const videoIds = [videoA.id, videoB.id, videoC.id];
    const [chViews, chWatch, chSubs, chUploads] = await Promise.all([
      prisma.view.count({ where: { videoId: { in: videoIds }, createdAt: { gte: dayFrom, lt: dayTo } } }),
      prisma.watchHistory.aggregate({
        where: { videoId: { in: videoIds }, watchedAt: { gte: dayFrom, lt: dayTo } },
        _sum: { seconds: true },
      }),
      prisma.subscription.count({ where: { channelId: owner.channelId, createdAt: { gte: dayFrom, lt: dayTo } } }),
      prisma.video.count({
        where: { channelId: owner.channelId, deletedAt: null, publishedAt: { gte: dayFrom, lt: dayTo } },
      }),
    ]);
    const expectedChannel = {
      views: chViews,
      watchSeconds: chWatch._sum.seconds ?? 0,
      subscribersGained: chSubs,
      uploads: chUploads,
    };
    expect(expectedChannel).toEqual({ views: 4, watchSeconds: 195, subscribersGained: 2, uploads: 3 });

    const channelRow = await prisma.channelDailyStat.findUnique({
      where: { channelId_day: { channelId: owner.channelId, day: rollupDay } },
    });
    expect(channelRow).not.toBeNull();
    expect({
      views: channelRow!.views,
      watchSeconds: channelRow!.watchSeconds,
      subscribersGained: channelRow!.subscribersGained,
      uploads: channelRow!.uploads,
    }).toEqual(expectedChannel);
  });

  it("serves the same range totals from the persisted rollups as the raw events", async () => {
    const owner = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Range ${uniqueSuffix()}`,
      publishedAt: at(rollupDay, 9),
    });
    await prisma.view.create({
      data: {
        videoId: video.id,
        userId: owner.userId,
        viewerHash: `itest-${uniqueSuffix()}`,
        watchedSeconds: 30,
        createdAt: at(rollupDay, 12),
      },
    });
    await prisma.watchHistory.create({
      data: { userId: owner.userId, videoId: video.id, seconds: 120, watchedAt: at(rollupDay, 12) },
    });
    await prisma.videoReaction.create({
      data: { videoId: video.id, userId: owner.userId, value: "LIKE", createdAt: at(rollupDay, 13) },
    });
    await prisma.comment.create({
      data: { videoId: video.id, userId: owner.userId, body: "hi", createdAt: at(rollupDay, 14) },
    });

    await aggregateDailyStats(rollupDay);
    const overview = await getStudioOverview(owner.channelId, "365d");

    // This channel has no events today, so the raw "today" slice is empty and
    // every number must come from the persisted rollup — which we just proved
    // equals the raw events.
    expect(overview.totals.views).toBe(1);
    expect(overview.totals.watchSeconds).toBe(120);
    expect(overview.totals.likes).toBe(1);
    expect(overview.totals.comments).toBe(1);
    expect(overview.totals.uploads).toBe(1);
    expect(overview.series).toHaveLength(365);

    const dayKey = rollupDay.toISOString().slice(0, 10);
    const seriesDay = overview.series.find((entry) => entry.day === dayKey);
    expect(seriesDay).toEqual({
      day: dayKey,
      views: 1,
      watchSeconds: 120,
      subscribersGained: 0,
      subscribersLost: 0,
    });

    expect(overview.topVideos[0]?.videoId).toBe(video.id);
    expect(overview.topVideos[0]?.views).toBe(1);
  });

  it("rebuilds a day with one set-based statement per table, not one per video", async () => {
    const owner = await createTestUser();
    const videoCount = 25;
    const videoIds: string[] = [];
    for (let i = 0; i < videoCount; i++) {
      const video = await createReadyVideo({
        channelId: owner.channelId,
        uploaderId: owner.userId,
        title: `Bulk ${i} ${uniqueSuffix()}`,
        publishedAt: at(rollupDay2, 9),
      });
      videoIds.push(video.id);
      await prisma.view.create({
        data: {
          videoId: video.id,
          userId: owner.userId,
          viewerHash: `itest-${uniqueSuffix()}`,
          watchedSeconds: 10,
          createdAt: at(rollupDay2, 12, i),
        },
      });
    }

    const captured: string[] = [];
    let recording = true;
    // `prisma` is typed as the base `PrismaClient`, whose `$on` overload does
    // not know the client was configured with the `event` emit mode (see
    // `src/lib/db.ts`). Narrow just for this listener.
    const queryClient = prisma as unknown as {
      $on(event: "query", callback: (event: { query: string }) => void): void;
    };
    queryClient.$on("query", (event) => {
      if (recording) captured.push(event.query);
    });

    await aggregateDailyStats(rollupDay2);
    recording = false;

    const videoInserts = captured.filter((q) => /insert into/i.test(q) && /video_daily_stats/i.test(q));
    const channelInserts = captured.filter((q) => /insert into/i.test(q) && /channel_daily_stats/i.test(q));
    expect(videoInserts).toHaveLength(1);
    expect(channelInserts).toHaveLength(1);

    // The rows really were written (the single statement covered all 25).
    const rows = await prisma.videoDailyStat.count({
      where: { video: { channelId: owner.channelId }, day: rollupDay2 },
    });
    expect(rows).toBe(videoCount);
  });
});

describe.skipIf(!dbOk)("Studio pagination caps (database)", () => {
  it("caps the video page size in the service, whatever the caller asks for", async () => {
    const owner = await createTestUser();
    for (let i = 0; i < 3; i++) {
      await createReadyVideo({
        channelId: owner.channelId,
        uploaderId: owner.userId,
        title: `Cap ${i} ${uniqueSuffix()}`,
      });
    }

    const huge = await listStudioVideoPage({ userId: owner.userId, pageSize: 1000 });
    expect(huge.pageSize).toBe(STUDIO_PAGE_SIZE_MAX);
    expect(huge.items.length).toBeLessThanOrEqual(STUDIO_PAGE_SIZE_MAX);

    const tiny = await listStudioVideoPage({ userId: owner.userId, pageSize: 0 });
    expect(tiny.pageSize).toBeGreaterThanOrEqual(1);

    const negative = await listStudioVideoPage({ userId: owner.userId, page: -5 });
    expect(negative.page).toBe(1);
  });

  it("paginates a sorted list without overlaps or gaps", async () => {
    const owner = await createTestUser();
    const marker = uniqueSuffix();
    const titles = Array.from({ length: 5 }, (_, i) => `Paged ${marker} ${i}`);
    for (const title of titles) {
      await createReadyVideo({ channelId: owner.channelId, uploaderId: owner.userId, title });
    }

    const collected: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await listStudioVideoPage({
        userId: owner.userId,
        query: marker,
        sort: "title",
        direction: "asc",
        page,
        pageSize: 2,
      });
      collected.push(...result.items.map((item) => item.title));
    }

    expect(collected).toEqual([...titles].sort());
    expect(new Set(collected).size).toBe(titles.length);
  });

  it("caps the moderation queue page size in the service", async () => {
    const owner = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Reports ${uniqueSuffix()}`,
    });

    const page = await listReportedComments(
      video.id,
      { userId: owner.userId, channelId: owner.channelId, role: "USER" },
      { pageSize: 1000 },
    );
    expect(page.pageSize).toBe(REPORT_PAGE_SIZE_MAX);
    expect(page.items.length).toBeLessThanOrEqual(REPORT_PAGE_SIZE_MAX);
  });
});
