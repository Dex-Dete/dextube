/**
 * Recommender ranking tests.
 *
 * These cover the behaviours that are easy to get subtly wrong and expensive to
 * discover in production: the newer signals (completion affinity, liked
 * channels, language), the viewer's own exclusions, diversity caps, cold start,
 * and the anti-inflation saturation. Everything here is a pure function call —
 * no database, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  LIKES_CAP,
  VIEWS_CAP,
  applyDiversity,
  parseRankingWeights,
  rankColdStart,
  rankVideos,
  rankVideosDetailed,
  saturate,
  scoreVideo,
  type RankableVideo,
  type RankingContext,
  type ScoredVideo,
} from "@/server/recsys/ranking";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY = 86_400_000;

function video(overrides: Partial<RankableVideo> & { id: string }): RankableVideo {
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
    category: "Technology",
    tags: [],
    language: "en",
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

describe("anti-inflation", () => {
  it("saturates view counts so extreme popularity cannot dominate", () => {
    expect(saturate(1_000_000, VIEWS_CAP)).toBeCloseTo(6, 3);
    expect(saturate(10_000_000, VIEWS_CAP)).toBeCloseTo(7, 3);
    // Ten times the views must not be worth ten times the score.
    expect(saturate(10_000_000, VIEWS_CAP) - saturate(1_000_000, VIEWS_CAP)).toBeLessThan(1.1);
  });

  it("caps likes and never returns a negative or infinite term", () => {
    expect(saturate(1_000_000_000, LIKES_CAP)).toBe(LIKES_CAP);
    expect(saturate(-5, VIEWS_CAP)).toBe(0);
    expect(saturate(Number.NaN, VIEWS_CAP)).toBe(0);
  });

  it("makes view inflation buy almost nothing", () => {
    const publishedAt = new Date(NOW - 10 * DAY).toISOString();
    const hundredMillion = video({
      id: "huge",
      publishedAt,
      viewCount: 500_000_000,
      likeCount: 5_000_000,
    });
    const fiveMillion = video({ id: "large", publishedAt, viewCount: 5_000_000, likeCount: 50_000 });
    const ctx = context();
    // A hundred times the views must be worth less than a fifth of one weight.
    expect(scoreVideo(hundredMillion, ctx).score - scoreVideo(fiveMillion, ctx).score).toBeLessThan(0.15);
  });
});

describe("new signals", () => {
  it("boosts videos in topics the viewer actually finishes", () => {
    const candidate: RankableVideo = { ...video({ id: "a" }), category: "Physics", tags: ["orbits"] };
    const engaged = context({ completionAffinity: new Map([["orbits", 0.95]]) });
    const ignored = context({ completionAffinity: new Map([["gardening", 0.95]]) });
    const boosted = scoreVideo(candidate, engaged);
    expect(boosted.score).toBeGreaterThan(scoreVideo(candidate, ignored).score);
    expect(boosted.reasons.some((reason) => reason.startsWith("you finish"))).toBe(true);
  });

  it("boosts channels the viewer has liked before", () => {
    const candidate = video({
      id: "b",
      channel: { id: "chan-liked", handle: "l", name: "L", avatarKey: null },
    });
    const withLike = context({ likedChannelIds: new Set(["chan-liked"]) });
    const without = context();
    expect(scoreVideo(candidate, withLike).score).toBeGreaterThan(scoreVideo(candidate, without).score);
    expect(scoreVideo(candidate, withLike).reasons).toContain("you liked this channel");
  });

  it("applies a mild boost for the viewer's usual language", () => {
    const english = video({ id: "en", language: "en" });
    const french = video({ id: "fr", language: "fr" });
    const ctx = context({ preferredLanguages: new Set(["en"]) });
    expect(scoreVideo(english, ctx).score).toBeGreaterThan(scoreVideo(french, ctx).score);
  });

  it("penalises already-watched videos without removing them", () => {
    const watched = video({ id: "seen" });
    const ctx = context({ watchedVideoIds: new Set(["seen"]) });
    const scored = scoreVideo(watched, ctx);
    expect(scored.reasons).toContain("already watched");
    expect(scored.score).toBeLessThan(scoreVideo(watched, context()).score);
  });
});

describe("the viewer's own exclusions", () => {
  it("removes videos marked not interested, and reports the count", () => {
    const candidates = [video({ id: "dismissed" }), video({ id: "fine" })];
    const ctx = context({ suppressedVideoIds: new Set(["dismissed"]) });
    const result = rankVideosDetailed(candidates, ctx);
    expect(result.items.map((item) => item.id)).toEqual(["fine"]);
    expect(result.excluded.suppressed).toBe(1);
  });

  it("removes every video from a hidden channel", () => {
    const candidates = [
      video({ id: "a1", channel: { id: "chan-hidden", handle: "h", name: "H", avatarKey: null } }),
      video({ id: "a2", channel: { id: "chan-hidden", handle: "h", name: "H", avatarKey: null } }),
      video({ id: "keep" }),
    ];
    const ctx = context({ hiddenChannelIds: new Set(["chan-hidden"]) });
    const result = rankVideosDetailed(candidates, ctx);
    expect(result.items.map((item) => item.id)).toEqual(["keep"]);
    expect(result.excluded.hiddenChannel).toBe(2);
  });

  it("counts watched exclusions when exclusion is requested", () => {
    const candidates = [video({ id: "seen" }), video({ id: "new" })];
    const ctx = context({ watchedVideoIds: new Set(["seen"]) });
    const result = rankVideosDetailed(candidates, ctx, { excludeWatched: true });
    expect(result.items.map((item) => item.id)).toEqual(["new"]);
    expect(result.excluded.watched).toBe(1);
  });
});

describe("diversity", () => {
  it("caps a single channel by default", () => {
    const scored: ScoredVideo[] = Array.from({ length: 6 }, (_, i) => ({
      video: video({ id: `v${i}`, category: `Category ${i}` }),
      score: 10 - i,
      reasons: [],
    }));
    expect(applyDiversity(scored).map((item) => item.id)).toEqual(["v0", "v1", "v2"]);
  });

  it("caps a single category even when the channels differ", () => {
    const scored: ScoredVideo[] = Array.from({ length: 5 }, (_, i) => ({
      video: video({
        id: `v${i}`,
        category: "Gaming",
        channel: { id: `chan-${i}`, handle: `c${i}`, name: `C${i}`, avatarKey: null },
      }),
      score: 10 - i,
      reasons: [],
    }));
    expect(applyDiversity(scored, { maxPerCategory: 2 })).toHaveLength(2);
  });

  it("tops up a page from capped items only when asked", () => {
    const scored: ScoredVideo[] = Array.from({ length: 5 }, (_, i) => ({
      video: video({ id: `v${i}` }),
      score: 10 - i,
      reasons: [],
    }));
    expect(applyDiversity(scored, { maxPerChannel: 2 })).toHaveLength(2);
    expect(applyDiversity(scored, { maxPerChannel: 2, topUp: true })).toHaveLength(5);
  });

  it("keeps the strongest item first even when capping", () => {
    const scored: ScoredVideo[] = [
      { video: video({ id: "best", channel: { id: "c1", handle: "c1", name: "C1", avatarKey: null } }), score: 9, reasons: [] },
      { video: video({ id: "second", channel: { id: "c2", handle: "c2", name: "C2", avatarKey: null } }), score: 8, reasons: [] },
      { video: video({ id: "sameChan", channel: { id: "c1", handle: "c1", name: "C1", avatarKey: null } }), score: 7, reasons: [] },
    ];
    expect(applyDiversity(scored, { maxPerChannel: 1 }).map((item) => item.id)).toEqual([
      "best",
      "second",
    ]);
  });
});

describe("cold start", () => {
  it("orders a signal-less viewer by recency, with diversity applied", () => {
    const candidates = [
      video({ id: "old", publishedAt: new Date(NOW - 300 * DAY).toISOString() }),
      video({ id: "new", publishedAt: new Date(NOW - 1 * DAY).toISOString() }),
      video({ id: "mid", publishedAt: new Date(NOW - 30 * DAY).toISOString() }),
    ];
    const ordered = rankColdStart(candidates, context(), { maxPerChannel: 3 });
    expect(ordered.map((item) => item.id)).toEqual(["new", "mid", "old"]);
  });

  it("does not simply return the most-viewed videos", () => {
    const candidates = [
      video({
        id: "staleHit",
        publishedAt: new Date(NOW - 500 * DAY).toISOString(),
        viewCount: 9_000_000,
      }),
      video({ id: "fresh", publishedAt: new Date(NOW - 2 * DAY).toISOString(), viewCount: 10 }),
    ];
    const ordered = rankColdStart(candidates, context());
    expect(ordered[0]!.id).toBe("fresh");
  });

  it("still applies channel diversity for a brand-new viewer", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => video({ id: `a${i}` }));
    expect(rankColdStart(candidates, context(), { maxPerChannel: 3 })).toHaveLength(3);
  });

  it("is deterministic for equal scores", () => {
    const candidates = [
      video({ id: "b", channel: { id: "cb", handle: "b", name: "B", avatarKey: null } }),
      video({ id: "a", channel: { id: "ca", handle: "a", name: "A", avatarKey: null } }),
    ];
    const first = rankVideos(candidates, context()).map((item) => item.id);
    const second = rankVideos([...candidates].reverse(), context()).map((item) => item.id);
    expect(first).toEqual(second);
  });
});

describe("weight configuration", () => {
  it("returns the documented defaults when nothing is configured", () => {
    expect(parseRankingWeights(undefined).weights).toEqual(DEFAULT_WEIGHTS);
    expect(parseRankingWeights("").weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("applies a valid override", () => {
    const { weights: parsed, ignored } = parseRankingWeights('{"recency": 2.5}');
    expect(parsed.recency).toBe(2.5);
    expect(parsed.engagement).toBe(DEFAULT_WEIGHTS.engagement);
    expect(ignored).toEqual([]);
  });

  it("ignores unknown keys and invalid values instead of throwing", () => {
    const { weights: parsed, ignored } = parseRankingWeights(
      '{"recency": 2, "nonsense": 1, "engagement": "high", "interest": -3}',
    );
    expect(parsed.recency).toBe(2);
    expect(parsed.engagement).toBe(DEFAULT_WEIGHTS.engagement);
    expect(parsed.interest).toBe(DEFAULT_WEIGHTS.interest);
    expect(ignored.sort()).toEqual(["engagement", "interest", "nonsense"]);
  });

  it("survives malformed JSON", () => {
    const { weights: parsed, ignored } = parseRankingWeights("{not json");
    expect(parsed).toEqual(DEFAULT_WEIGHTS);
    expect(ignored).toHaveLength(1);
  });

  it("survives a JSON array or primitive", () => {
    expect(parseRankingWeights("[1,2,3]").weights).toEqual(DEFAULT_WEIGHTS);
    expect(parseRankingWeights('"nope"').weights).toEqual(DEFAULT_WEIGHTS);
  });
});
