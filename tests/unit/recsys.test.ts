import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS,
  interestTokens,
  rankVideos,
  scoreVideo,
  type RankingContext,
} from "@/server/recsys";
import type { VideoCard } from "@/server/services/videos";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 86_400_000;

function video(overrides: Partial<VideoCard> & { id: string }): VideoCard {
  return {
    title: overrides.id,
    isShort: false,
    durationSec: 300,
    thumbnailKey: null,
    posterKey: null,
    publishedAt: new Date(NOW).toISOString(),
    viewCount: 0,
    likeCount: 0,
    visibility: "PUBLIC",
    status: "READY",
    channel: { id: "chan-a", handle: "chan-a", name: "Channel A", avatarKey: null },
    ...overrides,
  };
}

function context(overrides: Partial<RankingContext> = {}): RankingContext {
  return {
    now: NOW,
    subscribedChannelIds: new Set(),
    interests: new Set(),
    watchedVideoIds: new Set(),
    completionAffinity: new Map(),
    likedChannelIds: new Set(),
    preferredLanguages: new Set(),
    suppressedVideoIds: new Set(),
    hiddenChannelIds: new Set(),
    weights: DEFAULT_WEIGHTS,
    ...overrides,
  };
}

describe("recommender — transparency and ordering", () => {
  it("ranks a fresh video above an old one with identical engagement", () => {
    const fresh = video({ id: "fresh", publishedAt: new Date(NOW - 1 * DAY).toISOString() });
    const old = video({ id: "old", publishedAt: new Date(NOW - 90 * DAY).toISOString() });
    const scoredFresh = scoreVideo(fresh, context());
    const scoredOld = scoreVideo(old, context());
    expect(scoredFresh.score).toBeGreaterThan(scoredOld.score);
    expect(scoredFresh.reasons).toContain("fresh");
  });

  it("applies an exponential decay with the documented half-life", () => {
    const atHalfLife = video({
      id: "half",
      publishedAt: new Date(NOW - RECENCY_HALF_LIFE_DAYS * DAY).toISOString(),
    });
    const zeroEngagement = context({ weights: { ...DEFAULT_WEIGHTS, engagement: 0 } });
    // After one half-life the recency term should contribute about 0.5.
    const scored = scoreVideo(atHalfLife, zeroEngagement);
    expect(scored.score).toBeGreaterThan(0.49);
    expect(scored.score).toBeLessThan(0.51);
  });

  it("boosts a subscribed channel", () => {
    const candidate = video({ id: "x", channel: { id: "chan-b", handle: "b", name: "B", avatarKey: null } });
    const withoutSub = context();
    const withSub = context({ subscribedChannelIds: new Set(["chan-b"]) });
    expect(scoreVideo(candidate, withSub).score).toBeGreaterThan(scoreVideo(candidate, withoutSub).score);
    expect(scoreVideo(candidate, withSub).reasons).toContain("subscribed");
  });

  it("boosts a video whose category matches a declared interest", () => {
    const candidate = { ...video({ id: "y" }), category: "Music", tags: ["piano"] };
    const matched = context({ interests: new Set(["piano"]) });
    const unmatched = context({ interests: new Set(["cooking"]) });
    expect(scoreVideo(candidate as VideoCard, matched).score).toBeGreaterThan(
      scoreVideo(candidate as VideoCard, unmatched).score,
    );
  });

  it("derives interest tokens from category and tags, lowercased", () => {
    const tokens = interestTokens({ category: "Film & Animation", tags: ["Retro", "8-bit"] });
    expect(tokens).toContain("film & animation");
    expect(tokens).toContain("retro");
    expect(tokens).toContain("8-bit");
  });

  it("orders candidates from highest to lowest score", () => {
    const candidates = [
      video({ id: "old", publishedAt: new Date(NOW - 200 * DAY).toISOString() }),
      video({ id: "fresh", publishedAt: new Date(NOW - 1 * DAY).toISOString() }),
      video({ id: "mid", publishedAt: new Date(NOW - 20 * DAY).toISOString() }),
    ];
    const ranked = rankVideos(candidates, context());
    expect(ranked.map((v) => v.id)).toEqual(["fresh", "mid", "old"]);
  });

  it("enforces per-channel diversity", () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      video({ id: `a${i}`, channel: { id: "chan-a", handle: "a", name: "A", avatarKey: null } }),
    );
    const ranked = rankVideos(candidates, context(), { maxPerChannel: 3 });
    expect(ranked).toHaveLength(3);
  });

  it("excludes already-watched videos only when asked to", () => {
    const candidates = [video({ id: "watched" }), video({ id: "unseen" })];
    const ctx = context({ watchedVideoIds: new Set(["watched"]) });
    expect(rankVideos(candidates, ctx).map((v) => v.id)).toContain("watched");
    expect(rankVideos(candidates, ctx, { excludeWatched: true }).map((v) => v.id)).not.toContain("watched");
  });

  it("honours the limit option", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => video({ id: `v${i}` }));
    expect(rankVideos(candidates, context(), { limit: 4, maxPerChannel: 99 })).toHaveLength(4);
  });
});
