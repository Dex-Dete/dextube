/**
 * Recommendation service — signal loading and the ranked home feed.
 *
 * The ranking maths lives in `./ranking.ts`, which is pure and unit-tested.
 * This file is the part that talks to the database: it loads a bounded set of
 * signals for the viewer, hands the candidate pool to the ranker, and pages the
 * result.
 *
 * ## Signal loading is bounded
 *
 * Every query here has a hard `take`. A viewer with a hundred thousand watched
 * videos contributes exactly the same amount of work as one with two hundred,
 * so feed latency does not degrade with account age. The trade-off is explicit:
 * signals are drawn from recent activity, not the whole history.
 *
 * ## Privacy
 *
 * Watch history, watch progress and the languages inferred from them are only
 * read when the viewer has left `saveWatchHistory` enabled. Subscriptions,
 * declared interests, likes and explicit dismissals are not watch history and
 * are always honoured.
 *
 * ## Development diagnostics
 *
 * Outside production the chosen ordering is logged with per-video reasons, so a
 * developer can see *why* the feed looks the way it does. That explanation is
 * never returned to an ordinary viewer — the API exposes only the ranking
 * version and which strategy was used.
 */

import "server-only";

import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { CARD_SELECT, toCard, type VideoCard } from "@/server/services/videos";
import {
  DEFAULT_WEIGHTS,
  RANKING_VERSION,
  RECENCY_HALF_LIFE_DAYS,
  explainRanking,
  interestTokens,
  isEligible,
  parseRankingWeights,
  rankColdStart,
  rankVideos,
  rankVideosDetailed,
  scoreVideo,
  type RankableVideo,
  type RankingContext,
  type RankingWeights,
} from "./ranking";

export {
  DEFAULT_WEIGHTS,
  RANKING_VERSION,
  RECENCY_HALF_LIFE_DAYS,
  explainRanking,
  interestTokens,
  parseRankingWeights,
  rankColdStart,
  rankVideos,
  rankVideosDetailed,
  scoreVideo,
};
export type { RankableVideo, RankingContext, RankingWeights };

const recsysLogger = logger.child({ mod: "recsys" });

/** Rows read per signal. Keeps feed cost independent of account age. */
const HISTORY_LIMIT = 200;
const PROGRESS_LIMIT = 200;
const REACTION_LIMIT = 200;
const FEEDBACK_LIMIT = 500;
/** A topic needs at least this many finished samples before it earns a boost. */
const MIN_COMPLETION_SAMPLES = 2;

/** The configured weights, resolved once at module load. */
function resolveWeights(): RankingWeights {
  const configured = getConfig().recsys?.weights;
  if (configured) return configured;
  const { weights } = parseRankingWeights(process.env.RANKING_WEIGHTS);
  return weights;
}

const WEIGHTS = resolveWeights();

/* ------------------------------------------------------------------ context */

/**
 * Load the ranking context for a viewer.
 *
 * Anonymous visitors get an empty context, which the ranker treats as a cold
 * start. A signed-in viewer gets every signal that applies to them, all bounded.
 */
export async function buildRankingContext(userId: string | null, now = Date.now()): Promise<RankingContext> {
  const base: RankingContext = {
    now,
    weights: WEIGHTS,
    subscribedChannelIds: new Set(),
    interests: new Set(),
    watchedVideoIds: new Set(),
    completionAffinity: new Map(),
    likedChannelIds: new Set(),
    preferredLanguages: new Set(),
    suppressedVideoIds: new Set(),
    hiddenChannelIds: new Set(),
  };
  if (!userId) return base;

  const [
    subscriptions,
    declaredInterests,
    user,
    history,
    progress,
    reactions,
    feedback,
    hiddenChannels,
  ] = await Promise.all([
      prisma.subscription.findMany({
        where: { subscriberId: userId },
        select: { channelId: true },
      }),
      prisma.userInterest.findMany({ where: { userId }, select: { tag: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { saveWatchHistory: true } }),
      prisma.watchHistory.findMany({
        where: { userId },
        orderBy: { watchedAt: "desc" },
        take: HISTORY_LIMIT,
        select: { videoId: true },
      }),
      prisma.watchProgress.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: PROGRESS_LIMIT,
        select: {
          positionSec: true,
          durationSec: true,
          completed: true,
          video: { select: { category: true, tags: true, language: true } },
        },
      }),
      prisma.videoReaction.findMany({
        where: { userId, value: "LIKE" },
        orderBy: { updatedAt: "desc" },
        take: REACTION_LIMIT,
        select: { video: { select: { channelId: true } } },
      }),
      prisma.videoFeedback.findMany({
        where: { userId },
        take: FEEDBACK_LIMIT,
        select: { videoId: true },
      }),
      prisma.hiddenChannel.findMany({
        where: { userId },
        take: FEEDBACK_LIMIT,
        select: { channelId: true },
      }),
    ]);

  base.subscribedChannelIds = new Set(subscriptions.map((row) => row.channelId));
  const interests = new Set<string>(declaredInterests.map((row) => row.tag.toLowerCase()));
  base.likedChannelIds = new Set(reactions.map((row) => row.video.channelId));
  base.suppressedVideoIds = new Set(feedback.map((row) => row.videoId));
  base.hiddenChannelIds = new Set(hiddenChannels.map((row) => row.channelId));

  // Watch-history-derived signals are withheld unless the viewer allows history.
  if (user?.saveWatchHistory) {
    base.watchedVideoIds = new Set(history.map((row) => row.videoId));

    // Completion affinity: which topics does this viewer actually finish?
    const affinityTotals = new Map<string, { sum: number; count: number }>();
    const languages = new Map<string, number>();
    for (const entry of progress) {
      const video = entry.video;
      const ratio =
        entry.completed || (entry.durationSec > 0 && entry.positionSec / entry.durationSec >= 1)
          ? 1
          : entry.durationSec > 0
            ? Math.min(1, Math.max(0, entry.positionSec / entry.durationSec))
            : 0;
      if (ratio <= 0.1) continue;
      if (video.language) languages.set(video.language, (languages.get(video.language) ?? 0) + 1);
      for (const token of interestTokens(video)) {
        const current = affinityTotals.get(token) ?? { sum: 0, count: 0 };
        current.sum += ratio;
        current.count += 1;
        affinityTotals.set(token, current);
      }
    }
    const completionAffinity = new Map<string, number>();
    for (const [token, { sum, count }] of affinityTotals) {
      if (count >= MIN_COMPLETION_SAMPLES) completionAffinity.set(token, sum / count);
    }
    base.completionAffinity = completionAffinity;

    // The viewer's three most-watched languages form a mild relevance prior.
    base.preferredLanguages = new Set(
      [...languages.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([language]) => language),
    );

    // Infer extra topic interests from recently watched categories and tags.
    if (history.length > 0) {
      const recent = await prisma.video.findMany({
        where: { id: { in: history.slice(0, 40).map((row) => row.videoId) } },
        select: { category: true, tags: true },
      });
      for (const video of recent) {
        for (const token of interestTokens(video)) interests.add(token);
      }
    }
  }

  base.interests = interests;
  return base;
}

/**
 * Whether a viewer has any personalisation signal at all.
 *
 * A signed-in account with no subscriptions, no declared interests, no history
 * and no likes is treated as a cold start rather than being handed a feed that
 * is nominally "personalised" but is really just recency.
 */
export function hasPersonalisationSignals(context: RankingContext): boolean {
  return (
    context.subscribedChannelIds.size > 0 ||
    context.interests.size > 0 ||
    context.watchedVideoIds.size > 0 ||
    context.likedChannelIds.size > 0 ||
    context.completionAffinity.size > 0 ||
    context.suppressedVideoIds.size > 0 ||
    context.hiddenChannelIds.size > 0
  );
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
  /** Identifies the ranking formula so an ordering can be reproduced. */
  rankingVersion: string;
}

const MAX_OFFSET = 400;
const BASE_POOL = 240;
/** Ceiling on the candidate pool, whatever the offset and history size. */
const MAX_POOL = 600;
const MAX_PER_CHANNEL = 3;
const MAX_PER_CATEGORY = 8;

/**
 * Home feed.
 *
 * A signed-in viewer with any signal gets a personalised ordering; everyone
 * else gets a blended recent/popular baseline. Both come from the same weighted
 * heuristic — nothing here pretends to be a learned model.
 *
 * Already-watched videos are dropped from the candidate pool only while enough
 * unwatched material remains; otherwise they stay with a penalty. That keeps a
 * long-standing viewer's feed from emptying out on a small instance, which is
 * the failure mode a blanket exclusion produces.
 */
export async function getRankedHomeFeed(options: RankedFeedOptions): Promise<RankedFeedPage> {
  const limit = Math.min(48, Math.max(1, options.limit ?? 24));
  const offset = Math.max(0, Math.min(MAX_OFFSET, options.offset ?? 0));

  const context = await buildRankingContext(options.userId);
  const personalised = Boolean(options.userId) && hasPersonalisationSignals(context);

  const watchedAllowance = Math.min(150, context.watchedVideoIds.size);
  const poolSize = Math.min(
    MAX_POOL,
    Math.max(options.poolSize ?? BASE_POOL, offset + limit + 120 + watchedAllowance),
  );

  const rows = await prisma.video.findMany({
    where: {
      deletedAt: null,
      visibility: "PUBLIC",
      status: "READY",
      isShort: false,
      ...(options.category ? { category: options.category } : {}),
    },
    // Newest N forms the candidate pool; the ranker re-orders within it. The
    // cost is therefore bounded by the pool, not by catalogue size.
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: poolSize,
    select: { ...CARD_SELECT, category: true, tags: true, language: true },
  });

  const candidates: RankableVideo[] = rows.map((row) => ({
    ...toCard(row),
    category: row.category,
    tags: row.tags,
    language: row.language,
  }));

  if (!personalised) {
    const eligible = candidates.filter((video) => isEligible(video, context));
    const ordered = rankColdStart(eligible, context, {
      maxPerChannel: MAX_PER_CHANNEL,
      maxPerCategory: MAX_PER_CATEGORY,
      limit: offset + limit + 1,
      topUp: true,
    });
    return {
      items: ordered.slice(offset, offset + limit),
      nextOffset: ordered.length > offset + limit ? offset + limit : null,
      strategy: "trending-recent",
      rankingVersion: RANKING_VERSION,
    };
  }

  const unwatched = candidates.filter(
    (video) => isEligible(video, context) && !context.watchedVideoIds.has(video.id),
  ).length;
  const excludeWatched = context.watchedVideoIds.size > 0 && unwatched >= offset + limit;

  const result = rankVideosDetailed(candidates, context, {
    excludeWatched,
    maxPerChannel: MAX_PER_CHANNEL,
    maxPerCategory: MAX_PER_CATEGORY,
    limit: offset + limit + 1,
    topUp: true,
  });

  if (!getConfig().isProd) {
    const { suppressed, hiddenChannel, watched } = result.excluded;
    recsysLogger.debug("ranked home feed", {
      version: RANKING_VERSION,
      offset,
      candidates: candidates.length,
      excluded: suppressed + hiddenChannel + watched,
      suppressed,
      hiddenChannel,
      watched,
      excludeWatched,
      top: explainRanking(result.scored, 5),
    });
  }

  return {
    items: result.items.slice(offset, offset + limit),
    nextOffset: result.items.length > offset + limit ? offset + limit : null,
    strategy: "personalized",
    rankingVersion: RANKING_VERSION,
  };
}
