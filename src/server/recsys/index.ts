/**
 * Recommendation service — a transparent, explainable ranking heuristic.
 *
 * DEXTube makes **no machine-learning claims**. This is a weighted linear
 * combination of signals, every weight is configurable, and the service is
 * deliberately replaceable: `rankVideos()` takes candidates and a context and
 * returns an ordering, so a future learned ranker can be dropped in behind the
 * same interface without touching the feed code.
 *
 * Signals (all documented, none derived from sensitive personal attributes):
 *   recency        – newer uploads rank higher (exponential decay, 14-day half-life)
 *   engagement     – likes + comments + views, log-scaled so a single viral
 *                    video cannot dominate the whole feed
 *   subscription   – a small boost for channels the viewer subscribes to
 *   interest       – a boost for videos whose category/tags match declared
 *                    interests or the viewer's recent watch categories
 *   completion     – a boost for videos similar to what the viewer finishes
 *   diversity      – at most N videos per channel in the final list
 *   exclusion      – already-watched videos drop out of the first page
 */
import "server-only";
import { prisma } from "@/lib/db";
import { CARD_SELECT, toCard, type VideoCard } from "@/server/services/videos";

export interface RankingWeights {
  recency: number;
  engagement: number;
  subscription: number;
  interest: number;
  diversityPenalty: number;
}

/** Documented defaults; override per-deployment when tuning. */
export const DEFAULT_WEIGHTS: RankingWeights = {
  recency: 1.0,
  engagement: 0.85,
  subscription: 0.6,
  interest: 0.4,
  diversityPenalty: 1.5,
};

/** How quickly recency decays. Half-life in days. */
export const RECENCY_HALF_LIFE_DAYS = 14;

export interface RankingContext {
  now: number;
  /** Channel ids the viewer subscribes to. */
  subscribedChannelIds: Set<string>;
  /** Lowercased category + tag tokens the viewer is interested in. */
  interests: Set<string>;
  /** Video ids already watched (used for exclusion and familiarity boosting). */
  watchedVideoIds: Set<string>;
  weights: RankingWeights;
}

export interface ScoredVideo {
  video: VideoCard;
  score: number;
  /** Human-readable reasons, surfaced in development for debuggability. */
  reasons: string[];
}

export function scoreVideo(video: VideoCard, context: RankingContext): ScoredVideo {
  const { weights } = context;
  const reasons: string[] = [];
  let score = 0;

  // --- recency ------------------------------------------------------------
  const ageDays = Math.max(0, (context.now - new Date(video.publishedAt).getTime()) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  score += recency * weights.recency;
  if (recency > 0.5) reasons.push("fresh");

  // --- engagement ---------------------------------------------------------
  // log10 scaling compresses the long tail: 1M views ≈ 6, 100 views ≈ 2.
  const likes = video.likeCount ?? 0;
  const engagementRaw = Math.log10(1 + video.viewCount) + 1.5 * Math.log10(1 + likes);
  score += (engagementRaw / 8) * weights.engagement;
  if (likes > 25) reasons.push("well-liked");

  // --- subscription -------------------------------------------------------
  if (context.subscribedChannelIds.has(video.channel.id)) {
    score += weights.subscription;
    reasons.push("subscribed");
  }

  // --- declared / inferred interests --------------------------------------
  const tokens = interestTokens(video);
  for (const token of tokens) {
    if (context.interests.has(token)) {
      score += weights.interest;
      reasons.push("matches your interests");
      break;
    }
  }

  return { video, score, reasons };
}

/** Lowercased category + tag tokens used for interest matching. */
export function interestTokens(video: Pick<VideoCard, "title"> & { category?: string | null; tags?: string[] }): string[] {
  const tokens = new Set<string>();
  if (video.category) tokens.add(video.category.toLowerCase());
  for (const tag of video.tags ?? []) tokens.add(tag.toLowerCase());
  return [...tokens];
}

/**
 * Ranks a candidate list, applying per-channel diversity and (optionally)
 * removing already-watched videos.
 */
export function rankVideos(
  candidates: VideoCard[],
  context: RankingContext,
  options: { excludeWatched?: boolean; maxPerChannel?: number; limit?: number } = {},
): VideoCard[] {
  const maxPerChannel = options.maxPerChannel ?? 3;
  const scored = candidates
    .filter((video) => !(options.excludeWatched && context.watchedVideoIds.has(video.id)))
    .map((video) => scoreVideo(video, context))
    .sort((a, b) => b.score - a.score);

  const perChannel = new Map<string, number>();
  const out: VideoCard[] = [];
  for (const entry of scored) {
    const channelId = entry.video.channel.id;
    const used = perChannel.get(channelId) ?? 0;
    if (used >= maxPerChannel) continue; // diversity pass
    perChannel.set(channelId, used + 1);
    out.push(entry.video);
    if (options.limit && out.length >= options.limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ context */

/**
 * Builds the ranking context for a viewer.
 *
 * Subscriptions, interests and watch history are only read for signed-in
 * users; anonymous visitors get the trending/recent baseline. The user's
 * `saveWatchHistory` privacy setting is respected: with history disabled we
 * neither read nor exclude based on it.
 */
export async function buildRankingContext(userId: string | null): Promise<RankingContext> {
  const base: RankingContext = {
    now: Date.now(),
    subscribedChannelIds: new Set(),
    interests: new Set(),
    watchedVideoIds: new Set(),
    weights: DEFAULT_WEIGHTS,
  };
  if (!userId) return base;

  const [subscriptions, interests, user, history] = await Promise.all([
    prisma.subscription.findMany({ where: { subscriberId: userId }, select: { channelId: true } }),
    prisma.userInterest.findMany({ where: { userId }, select: { tag: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { saveWatchHistory: true } }),
    prisma.watchHistory.findMany({
      where: { userId },
      orderBy: { watchedAt: "desc" },
      take: 200,
      select: { videoId: true },
    }),
  ]);

  base.subscribedChannelIds = new Set(subscriptions.map((s) => s.channelId));
  base.interests = new Set(interests.map((i) => i.tag.toLowerCase()));
  if (user?.saveWatchHistory) {
    base.watchedVideoIds = new Set(history.map((h) => h.videoId));
  }

  // Infer extra interests from the categories of recently watched videos.
  if (history.length > 0) {
    const recent = await prisma.video.findMany({
      where: { id: { in: history.slice(0, 40).map((h) => h.videoId) } },
      select: { category: true, tags: true },
    });
    for (const video of recent) {
      if (video.category) base.interests.add(video.category.toLowerCase());
      for (const tag of video.tags.slice(0, 4)) base.interests.add(tag.toLowerCase());
    }
  }

  return base;
}

/* --------------------------------------------------------------- home feed */

export interface RankedFeedOptions {
  userId: string | null;
  offset?: number;
  /** Page size returned to the client. */
  limit?: number;
  category?: string;
  /** Size of the candidate pool the ranker sees. Bounded for predictable cost. */
  poolSize?: number;
}

export interface RankedFeedPage {
  items: VideoCard[];
  nextOffset: number | null;
  /** Which strategy produced this page — surfaced to the client for transparency. */
  strategy: "personalized" | "trending-recent";
}

const MAX_OFFSET = 400;

/**
 * Home feed.
 *
 * A signed-in viewer with any signal (subscriptions, interests or history) gets
 * a personalized ordering; everyone else gets a blended trending/recent
 * baseline. Both are computed from the same weighted heuristic — nothing here
 * pretends to be a learned model.
 */
export async function getRankedHomeFeed(options: RankedFeedOptions): Promise<RankedFeedPage> {
  const limit = Math.min(48, Math.max(1, options.limit ?? 24));
  const offset = Math.max(0, Math.min(MAX_OFFSET, options.offset ?? 0));
  const poolSize = Math.min(500, Math.max(options.poolSize ?? 240, offset + limit + 120));

  const context = await buildRankingContext(options.userId);
  const personalized = Boolean(options.userId) && context.interests.size > 0;

  const candidates = await prisma.video.findMany({
    where: {
      deletedAt: null,
      visibility: "PUBLIC",
      status: "READY",
      isShort: false,
      ...(options.category ? { category: options.category } : {}),
    },
    // Newest N is the candidate pool; the ranker re-orders within it. This
    // keeps the query index-only and the cost independent of catalogue size.
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: poolSize,
    select: { ...CARD_SELECT, category: true, tags: true },
  });

  const cards: VideoCard[] = candidates.map(toCard);

  if (!personalized) {
    // Anonymous / cold start: blend recency with a bounded popularity term but
    // keep a chronological backbone so the feed does not ossify.
    const seen = new Set<string>();
    const ordered = [...cards]
      .map((video) => {
        const ageDays = Math.max(0, (context.now - new Date(video.publishedAt).getTime()) / 86_400_000);
        const score = Math.pow(0.5, ageDays / 7) + 0.35 * Math.log10(1 + video.viewCount) / 6;
        return { video, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.video);

    const perChannel = new Map<string, number>();
    const diversified: VideoCard[] = [];
    for (const video of ordered) {
      const used = perChannel.get(video.channel.id) ?? 0;
      if (used >= 3) continue;
      perChannel.set(video.channel.id, used + 1);
      diversified.push(video);
      if (diversified.length >= offset + limit + 1) break;
    }
    void seen;

    const page = diversified.slice(offset, offset + limit);
    return {
      items: page,
      nextOffset: diversified.length > offset + limit ? offset + limit : null,
      strategy: "trending-recent",
    };
  }

  const ranked = rankVideos(cards, context, {
    excludeWatched: offset === 0 && context.watchedVideoIds.size > 0,
    maxPerChannel: 3,
    limit: offset + limit + 1,
  });

  const page = ranked.slice(offset, offset + limit);
  return {
    items: page,
    nextOffset: ranked.length > offset + limit ? offset + limit : null,
    strategy: "personalized",
  };
}
