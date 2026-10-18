import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { checkDatabase, prisma } from "@/lib/db";
import { aggregateDailyStats, getStudioOverview } from "@/server/services/analytics";
import { getRankedHomeFeed } from "@/server/recsys";
import { cleanupFixtures, createReadyVideo, createTestUser, uniqueSuffix } from "./helpers";

/**
 * Performance regressions we intend to keep fixed.
 *
 * Assertions here are about **statement counts and response sizes**, not wall
 * clock time: a timing threshold is flaky on a shared machine, while "this
 * operation issues a bounded number of queries no matter how much data exists"
 * is the property that actually matters and the one that silently regressed
 * before. The counts are read from Prisma's own query event, so they are the
 * real statements the database received.
 *
 * Fixtures live in the `itest_` namespace and are removed afterwards.
 */

const dbOk = (await checkDatabase()).ok;
const DAY_MS = 86_400_000;

function utcDay(offsetDays = 0, base = Date.now()): Date {
  const now = new Date(base);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY_MS);
}

/* ------------------------------------------------------- statement recorder */

const captured: string[] = [];
let recording = false;
const onQuery = (event: Prisma.QueryEvent) => {
  if (recording) captured.push(event.query);
};

/** Runs `fn` and returns the SQL statements Prisma sent while it ran. */
async function statements<T>(fn: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  captured.length = 0;
  recording = true;
  try {
    const result = await fn();
    return { result, queries: [...captured] };
  } finally {
    recording = false;
  }
}

/* --------------------------------------------------------------- fixtures */

/** A day inside the reporting window on which no real event happened. */
async function findEmptyDay(): Promise<Date> {
  let day = utcDay(-200);
  for (let i = 0; i < 360; i++) {
    const to = new Date(day.getTime() + DAY_MS);
    const [views, watch, comments, reactions, subs, published] = await Promise.all([
      prisma.view.count({ where: { createdAt: { gte: day, lt: to } } }),
      prisma.watchHistory.count({ where: { watchedAt: { gte: day, lt: to } } }),
      prisma.comment.count({ where: { createdAt: { gte: day, lt: to } } }),
      prisma.videoReaction.count({ where: { createdAt: { gte: day, lt: to } } }),
      prisma.subscription.count({ where: { createdAt: { gte: day, lt: to } } }),
      prisma.video.count({ where: { publishedAt: { gte: day, lt: to } } }),
    ]);
    if (views + watch + comments + reactions + subs + published === 0) return day;
    day = new Date(day.getTime() - DAY_MS);
  }
  return day;
}

const rollupDay = dbOk ? await findEmptyDay() : utcDay(-200);

beforeAll(() => {
  // `src/lib/db.ts` emits query events only when NODE_ENV is `test`.
  // The generated client type does not declare the `query` event because the
  // log level is decided at runtime in `src/lib/db.ts`; the event is real.
  if (dbOk) {
    (prisma as unknown as { $on: (event: string, cb: (e: Prisma.QueryEvent) => void) => void }).$on(
      "query",
      onQuery,
    );
  }
});

afterAll(async () => {
  recording = false;
  if (!dbOk) return;
  await cleanupFixtures();
  // The rollup rows this file produced belong to fixture videos; drop them so a
  // later run of `aggregateDailyStats` cannot be affected by leftovers.
  await prisma.videoDailyStat.deleteMany({ where: { day: rollupDay } }).catch(() => {});
  await prisma.channelDailyStat.deleteMany({ where: { day: rollupDay } }).catch(() => {});
});

describe.skipIf(!dbOk)("bounded, set-based data access", () => {
  it("rebuilds a day of rollups with one statement per table, not one per video", async () => {
    const user = await createTestUser();
    const videos = [];
    for (let i = 0; i < 3; i++) {
      const video = await createReadyVideo({
        channelId: user.channelId,
        uploaderId: user.userId,
        title: `itest perf video ${i} ${uniqueSuffix()}`,
        publishedAt: rollupDay,
      });
      videos.push(video);
      // A view on the rollup day is what makes the video appear in the rollup at
      // all; three videos means the old per-row upsert would have run three
      // times.
      await prisma.view.create({
        data: { videoId: video.id, viewerHash: `itest${uniqueSuffix()}`, createdAt: new Date(rollupDay.getTime() + 3_600_000) },
      });
    }

    const dayTo = new Date(rollupDay.getTime() + DAY_MS);
    const { result, queries } = await statements(() => aggregateDailyStats(rollupDay));

    // Three videos were aggregated…
    expect(result.videos).toBe(3);

    const videoInserts = queries.filter((query) => /INSERT INTO "?video_daily_stats"?/i.test(query));
    const channelInserts = queries.filter((query) => /INSERT INTO "?channel_daily_stats"?/i.test(query));

    // …in a single statement each. This is the N+1 fix, asserted on the SQL.
    expect(videoInserts).toHaveLength(1);
    expect(channelInserts).toHaveLength(1);

    // And the rows really are there, one per video.
    const written = await prisma.videoDailyStat.count({
      where: { day: rollupDay, videoId: { in: videos.map((video) => video.id) } },
    });
    expect(written).toBe(3);

    // Reads are bounded too: four event aggregations plus two channel sources.
    expect(queries.length).toBeLessThanOrEqual(10);
    expect(dayTo.getTime() - rollupDay.getTime()).toBe(DAY_MS);
  });

  it("costs the same for the Studio dashboard however many videos the channel has", async () => {
    const user = await createTestUser();
    await createReadyVideo({
      channelId: user.channelId,
      uploaderId: user.userId,
      title: `itest perf overview ${uniqueSuffix()}`,
    });

    const first = await statements(() => getStudioOverview(user.channelId, "28d"));

    // Add more videos; the dashboard must not issue more queries for them.
    for (let i = 0; i < 5; i++) {
      await createReadyVideo({
        channelId: user.channelId,
        uploaderId: user.userId,
        title: `itest perf overview extra ${i} ${uniqueSuffix()}`,
      });
    }
    const second = await statements(() => getStudioOverview(user.channelId, "28d"));

    expect(second.queries.length).toBe(first.queries.length);
    // A fixed budget: the channel rollup, the video rollups, today's raw slice
    // (four sources), two counts, the channel row, the lifetime aggregate and
    // the top-video titles.
    expect(second.queries.length).toBeLessThanOrEqual(12);

    // History is read from the persisted rollups rather than recomputed from
    // raw events on every render.
    expect(second.queries.some((query) => query.includes("video_daily_stats"))).toBe(true);
    expect(second.queries.some((query) => query.includes("channel_daily_stats"))).toBe(true);
  });

  it("serves a bounded feed page and clamps an oversized request", async () => {
    const page = await statements(() => getRankedHomeFeed({ userId: null, limit: 12 }));

    expect(page.result.items.length).toBeLessThanOrEqual(12);
    expect(page.result.rankingVersion).toBeTruthy();
    // Anonymous cold start: a bounded number of reads (candidate pool + a small
    // set of aggregate queries), not one per candidate.
    expect(page.queries.length).toBeLessThanOrEqual(20);

    const oversized = await getRankedHomeFeed({ userId: null, limit: 500 });
    expect(oversized.items.length).toBeLessThanOrEqual(48);
  });

  it("keeps a signed-in feed bounded even as history grows", async () => {
    const user = await createTestUser();
    const anonymous = await statements(() => getRankedHomeFeed({ userId: null, limit: 12 }));
    const signedIn = await statements(() => getRankedHomeFeed({ userId: user.userId, limit: 12 }));

    // The personalisation signals are loaded with a fixed set of bounded
    // queries; the difference is the handful of signal reads, not one query per
    // watched video.
    expect(signedIn.queries.length).toBeLessThanOrEqual(anonymous.queries.length + 12);
    expect(signedIn.result.items.length).toBeLessThanOrEqual(12);
  });
});
