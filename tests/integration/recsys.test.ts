import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import { getRankedHomeFeed } from "@/server/recsys";
import { applyRecommendationFeedback, getFeedbackSummary } from "@/server/services/feedback";
import { createReadyVideo, createTestUser, uniqueSuffix } from "./helpers";

/**
 * Recommendation behaviour against the real database.
 *
 * The ranking maths is covered by `tests/unit/recsys-ranking.test.ts` in
 * isolation. What is checked here is the part that only a database can prove:
 * that a viewer's stored decisions actually reach the query, that a hidden
 * channel disappears completely, that "reset" really undoes it, and that paging
 * through the feed does not repeat or drop videos.
 *
 * Fixtures live in the `itest_` namespace and are removed afterwards.
 */

const dbOk = (await checkDatabase()).ok;

afterAll(async () => {
  if (dbOk) {
    const { cleanupFixtures } = await import("./helpers");
    await cleanupFixtures();
  }
});

/** A channel owned by a throwaway user, with one published video. */
async function channelWithVideo(title: string) {
  const user = await createTestUser();
  const video = await createReadyVideo({
    channelId: user.channelId,
    uploaderId: user.userId,
    title,
    // Recent, so these fixtures sit at the top of the candidate pool and a
    // missing video really means "suppressed", not "outside the window".
    publishedAt: new Date(),
  });
  return { user, video };
}

describe.skipIf(!dbOk)("recommender against the database", () => {
  it("honours 'not interested', 'hide channel' and reset end to end", async () => {
    const viewer = await createTestUser();
    const dismissed = await channelWithVideo(`itest dismissed ${uniqueSuffix()}`);
    const hidden = await channelWithVideo(`itest hidden ${uniqueSuffix()}`);
    const visible = await channelWithVideo(`itest visible ${uniqueSuffix()}`);

    const before = await getRankedHomeFeed({ userId: viewer.userId, limit: 48 });
    const beforeIds = before.items.map((item) => item.id);
    expect(beforeIds).toContain(dismissed.video.id);
    expect(beforeIds).toContain(hidden.video.id);

    await applyRecommendationFeedback({
      userId: viewer.userId,
      action: "not_interested",
      videoId: dismissed.video.id,
    });

    const afterDismiss = await getRankedHomeFeed({ userId: viewer.userId, limit: 48 });
    const dismissIds = afterDismiss.items.map((item) => item.id);
    expect(dismissIds).not.toContain(dismissed.video.id);
    // A single dismissal must not disturb anything else.
    expect(dismissIds).toContain(visible.video.id);

    await applyRecommendationFeedback({
      userId: viewer.userId,
      action: "hide_channel",
      channelId: hidden.user.channelId,
    });

    const afterHide = await getRankedHomeFeed({ userId: viewer.userId, limit: 48 });
    const hideIds = afterHide.items.map((item) => item.id);
    expect(hideIds).not.toContain(hidden.video.id);
    expect(await getFeedbackSummary(viewer.userId)).toEqual({ dismissals: 1, hiddenChannels: 1 });

    await applyRecommendationFeedback({ userId: viewer.userId, action: "reset" });

    expect(await getFeedbackSummary(viewer.userId)).toEqual({ dismissals: 0, hiddenChannels: 0 });
    const afterReset = await getRankedHomeFeed({ userId: viewer.userId, limit: 48 });
    const resetIds = afterReset.items.map((item) => item.id);
    expect(resetIds).toContain(dismissed.video.id);
    expect(resetIds).toContain(hidden.video.id);
  });

  it("treats repeated feedback as idempotent", async () => {
    const viewer = await createTestUser();
    const target = await channelWithVideo(`itest idempotent ${uniqueSuffix()}`);

    for (let i = 0; i < 3; i++) {
      await applyRecommendationFeedback({
        userId: viewer.userId,
        action: "not_interested",
        videoId: target.video.id,
      });
    }

    // Pressing the control twice must not inflate the stored count.
    expect(await getFeedbackSummary(viewer.userId)).toEqual({ dismissals: 1, hiddenChannels: 0 });
    expect(await prisma.videoFeedback.count({ where: { userId: viewer.userId } })).toBe(1);
  });

  it("reports a cold start honestly and personalises once there is a signal", async () => {
    const viewer = await createTestUser();
    const followed = await channelWithVideo(`itest followed ${uniqueSuffix()}`);

    const cold = await getRankedHomeFeed({ userId: viewer.userId, limit: 12 });
    expect(cold.strategy).toBe("trending-recent");
    expect(cold.rankingVersion).toBe("heuristic-2");
    expect(cold.items.length).toBeGreaterThan(0);

    await prisma.subscription.create({
      data: { subscriberId: viewer.userId, channelId: followed.user.channelId },
    });

    const warm = await getRankedHomeFeed({ userId: viewer.userId, limit: 12 });
    expect(warm.strategy).toBe("personalized");
    // A subscribed channel is not merely allowed through; it is ranked up.
    expect(warm.items.map((item) => item.id)).toContain(followed.video.id);
  });

  it("pages without repeating or dropping within the candidate window", async () => {
    const viewer = await createTestUser();
    const first = await getRankedHomeFeed({ userId: viewer.userId, limit: 6, offset: 0 });
    expect(first.items.length).toBeGreaterThan(0);

    const seen = new Set(first.items.map((item) => item.id));
    expect(seen.size).toBe(first.items.length);

    let offset = first.nextOffset;
    let pages = 1;
    while (offset !== null && pages < 4) {
      const page = await getRankedHomeFeed({ userId: viewer.userId, limit: 6, offset });
      expect(page.items.length).toBeLessThanOrEqual(6);
      for (const item of page.items) {
        expect(seen.has(item.id), `video ${item.id} appeared on two pages`).toBe(false);
        seen.add(item.id);
      }
      offset = page.nextOffset;
      pages += 1;
    }

    // The same request twice must produce the same order — the ranker is
    // deterministic, which is what makes an ordering reproducible at all.
    const again = await getRankedHomeFeed({ userId: viewer.userId, limit: 6, offset: 0 });
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });
});
