/**
 * Pure ranking functions for DEXTube's recommender.
 *
 * Everything in this file is deterministic and free of I/O, so the ranking
 * behaviour can be unit-tested directly and reasoned about without a database.
 * `./index.ts` is responsible for loading the signals and calling in here.
 *
 * ## What this is, and is not
 *
 * DEXTube makes **no machine-learning claims**. This is a weighted linear
 * combination of a small number of understandable signals. Every weight has a
 * default, every weight can be overridden by configuration, and the weights
 * carry a version so a feed ordering can be reproduced later. A learned ranker
 * could replace `rankVideos()` without touching any caller.
 *
 * ## Signals
 *
 * | signal         | source                                    | why it is here                                             |
 * |----------------|-------------------------------------------|------------------------------------------------------------|
 * | recency        | `publishedAt`                             | fresh material keeps the feed from calcifying               |
 * | engagement     | views + likes, both saturated             | a proxy for quality, deliberately difficult to inflate      |
 * | subscription   | `Subscription`                            | an explicit statement of interest                           |
 * | interest       | declared interests + watched categories   | matches topic, not just popularity                          |
 * | completion     | `WatchProgress` position/duration         | finishing a video says more than clicking it                |
 * | likedChannel   | positive `VideoReaction` history          | a channel you liked before is a strong signal               |
 * | language       | the viewer's most-watched languages       | a mild relevance prior                                      |
 * | alreadyWatched | `WatchHistory`                            | pushes repeats down so they cannot dominate the feed        |
 *
 * ## Anti-inflation
 *
 * View and like contributions are passed through `saturate()`, which caps the
 * logarithm of the count. Going from one million to ten million views changes
 * the engagement term by 1/8th of one weight — artificially inflating a counter
 * has sharply diminishing returns and can never buy the top of the feed. Views
 * are additionally deduplicated at write time per viewer and time window (see
 * `recordView`), so a loop of refreshes does not accumulate.
 *
 * ## What is deliberately absent
 *
 * No sensitive personal attributes are read. No shadow profile is built from
 * clicks. Skipped videos are only used through `alreadyWatched` and explicit
 * dismissals; DEXTube does not infer a "quality" score from how long somebody
 * hovered.
 */

import type { VideoCard } from "@/server/services/videos";

/**
 * A card plus the fields the ranker needs that the client never sees.
 *
 * `category`, `tags` and `language` are optional so that a plain `VideoCard` is
 * assignable here; the feed always supplies them, but tests and other callers
 * do not have to.
 */
export interface RankableVideo extends VideoCard {
  category?: string | null;
  tags?: string[];
  language?: string | null;
}

/** Bumped whenever a default weight or the formula changes. */
export const RANKING_VERSION = "heuristic-2";

export interface RankingWeights {
  /** Exponential decay by publication age. */
  recency: number;
  /** Saturated views + likes, plus a like-ratio tiebreaker. */
  engagement: number;
  /** The viewer subscribes to the channel. */
  subscription: number;
  /** The video's category or tags match the viewer's interests. */
  interest: number;
  /** The viewer tends to finish videos sharing this video's topic. */
  completion: number;
  /** The viewer has positively reacted to this channel before. */
  likedChannel: number;
  /** The video is in a language the viewer usually watches. */
  language: number;
  /** Penalty applied to videos the viewer already watched. */
  alreadyWatched: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  recency: 1,
  engagement: 0.85,
  subscription: 0.6,
  interest: 0.4,
  completion: 0.5,
  likedChannel: 0.45,
  language: 0.2,
  alreadyWatched: 0.6,
};

/** Half-life of the recency term for a personalised feed, in days. */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** A shorter half-life for the cold-start feed, which leans on freshness. */
export const COLD_START_HALF_LIFE_DAYS = 7;

/** log10(1 + 10,000,000). Past this, more views add nothing. */
export const VIEWS_CAP = 7;
/** log10(1 + 100,000). */
export const LIKES_CAP = 5;
/** A like rate above 15% is treated as 15%; no ratio is that trustworthy. */
export const LIKE_RATIO_CAP = 0.15;

export interface RankingContext {
  /** Epoch milliseconds, injected so tests never depend on the wall clock. */
  now: number;
  weights: RankingWeights;
  subscribedChannelIds: ReadonlySet<string>;
  /** Lower-cased category and tag tokens the viewer is interested in. */
  interests: ReadonlySet<string>;
  watchedVideoIds: ReadonlySet<string>;
  /** Topic token -> mean completion ratio (0..1) for that topic. */
  completionAffinity: ReadonlyMap<string, number>;
  likedChannelIds: ReadonlySet<string>;
  preferredLanguages: ReadonlySet<string>;
  /** Videos the viewer marked "not interested". */
  suppressedVideoIds: ReadonlySet<string>;
  /** Channels the viewer asked not to be recommended. */
  hiddenChannelIds: ReadonlySet<string>;
}

export interface ScoredVideo {
  video: RankableVideo;
  score: number;
  /** Human-readable, development-only explanation of the score. */
  reasons: string[];
}

/**
 * Normalise a category or tag into a comparable token.
 *
 * Kept deliberately simple and shared with the interest extraction so both
 * sides always agree on what "the same topic" means.
 */
export function normaliseToken(value: string): string {
  return value.trim().toLowerCase();
}

/** Every topic token a video carries: its category plus each of its tags. */
export function interestTokens(video: Pick<RankableVideo, "category" | "tags">): string[] {
  const tokens = new Set<string>();
  if (video.category) tokens.add(normaliseToken(video.category));
  for (const tag of video.tags ?? []) {
    const token = normaliseToken(tag);
    if (token) tokens.add(token);
  }
  return [...tokens];
}

/**
 * Cap a counter's contribution logarithmically.
 *
 * Returns 0 for non-positive input so a missing or negative counter (which
 * should not happen, but is cheap to guard) cannot produce `-Infinity`.
 */
export function saturate(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.log10(1 + value), cap);
}

/** Age in days, floored at zero so a future `publishedAt` is not penalised. */
export function ageInDays(publishedAt: string | null, now: number): number {
  if (!publishedAt) return 0;
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return 0;
  return Math.max(0, (now - published) / 86_400_000);
}

export function recencyTerm(publishedAt: string | null, now: number, halfLifeDays: number): number {
  return Math.pow(0.5, ageInDays(publishedAt, now) / halfLifeDays);
}

/**
 * Whether a candidate may appear in a feed for this viewer at all.
 *
 * Suppression is the viewer's own decision and outranks every boost, so it is
 * checked before scoring rather than expressed as a penalty.
 */
export function isEligible(video: RankableVideo, context: RankingContext): boolean {
  if (context.suppressedVideoIds.has(video.id)) return false;
  if (context.hiddenChannelIds.has(video.channel.id)) return false;
  return true;
}

/**
 * Score one video.
 *
 * The result is a sum of independent weighted terms plus a watched penalty, so
 * every contribution can be explained and re-weighted without touching the
 * others. `reasons` is for development diagnostics only and is never sent to an
 * ordinary viewer.
 */
export function scoreVideo(video: RankableVideo, context: RankingContext): ScoredVideo {
  const { weights, now } = context;
  const reasons: string[] = [];
  let score = 0;

  const recency = recencyTerm(video.publishedAt, now, RECENCY_HALF_LIFE_DAYS);
  score += weights.recency * recency;
  if (recency > 0.5) reasons.push("fresh");

  // --- engagement: saturated, plus a like-ratio tiebreaker ----------------
  const views = saturate(video.viewCount, VIEWS_CAP);
  const likes = saturate(video.likeCount ?? 0, LIKES_CAP);
  const likeRatio =
    video.viewCount > 0 ? Math.min(LIKE_RATIO_CAP, (video.likeCount ?? 0) / video.viewCount) : 0;
  const engagement = views + 1.5 * likes;
  const engagementContribution = (engagement / 8 + likeRatio) * weights.engagement;
  score += engagementContribution;
  if (engagementContribution > 0.3) reasons.push("well received");

  // --- subscription -------------------------------------------------------
  if (context.subscribedChannelIds.has(video.channel.id)) {
    score += weights.subscription;
    reasons.push("subscribed");
  }

  // --- liked before -------------------------------------------------------
  if (context.likedChannelIds.has(video.channel.id)) {
    score += weights.likedChannel;
    reasons.push("you liked this channel");
  }

  const tokens = interestTokens(video);

  // --- declared / inferred interests --------------------------------------
  if (tokens.some((token) => context.interests.has(token))) {
    score += weights.interest;
    reasons.push("matches your interests");
  }

  // --- completion affinity ------------------------------------------------
  let bestAffinity = 0;
  let affinityToken: string | null = null;
  for (const token of tokens) {
    const affinity = context.completionAffinity.get(token);
    if (affinity !== undefined && affinity > bestAffinity) {
      bestAffinity = affinity;
      affinityToken = token;
    }
  }
  if (bestAffinity > 0) {
    score += bestAffinity * weights.completion;
    reasons.push(`you finish ${affinityToken} videos`);
  }

  // --- language -----------------------------------------------------------
  if (video.language && context.preferredLanguages.has(video.language)) {
    score += weights.language;
    reasons.push("your usual language");
  }

  // --- already watched ----------------------------------------------------
  if (context.watchedVideoIds.has(video.id)) {
    score -= weights.alreadyWatched;
    reasons.push("already watched");
  }

  return { video, score, reasons };
}

export interface DiversityOptions {
  /** Maximum videos from one channel in the returned list. */
  maxPerChannel?: number;
  /** Maximum videos sharing one category in the returned list. */
  maxPerCategory?: number;
  /** Hard cap on the returned list. */
  limit?: number;
  /**
   * Append anything the caps held back once the whole pool has been walked.
   *
   * Off by default, which gives the strict behaviour callers can rely on (and
   * assert on). A feed turns it on so that a viewer whose candidates all come
   * from one or two channels still gets a full page: the caps then decide the
   * *order* of the page rather than truncating it.
   */
  topUp?: boolean;
}

/**
 * Greedily take videos in rank order while respecting variety caps.
 *
 * Selection is greedy rather than round-robin so the strongest items stay near
 * the top instead of being interleaved with weaker ones. With `topUp` disabled
 * the caps are hard: a viewer subscribed to a single channel gets three videos
 * and no more, which is what the unit tests assert.
 */
export function applyDiversity(
  ordered: ScoredVideo[],
  options: DiversityOptions = {},
): RankableVideo[] {
  const maxPerChannel = options.maxPerChannel ?? 3;
  const maxPerCategory = options.maxPerCategory ?? 6;
  const limit = options.limit ?? ordered.length;

  const picked: RankableVideo[] = [];
  const held: RankableVideo[] = [];
  const perChannel = new Map<string, number>();
  const perCategory = new Map<string, number>();

  for (const entry of ordered) {
    if (picked.length >= limit) break;
    const channelId = entry.video.channel.id;
    const category = entry.video.category ?? null;
    const channelCount = perChannel.get(channelId) ?? 0;
    const categoryCount = category ? (perCategory.get(category) ?? 0) : 0;

    if (channelCount >= maxPerChannel || categoryCount >= maxPerCategory) {
      held.push(entry.video);
      continue;
    }
    picked.push(entry.video);
    perChannel.set(channelId, channelCount + 1);
    if (category) perCategory.set(category, categoryCount + 1);
  }

  if (options.topUp) {
    for (const video of held) {
      if (picked.length >= limit) break;
      picked.push(video);
    }
  }

  return picked;
}

export interface RankOptions extends DiversityOptions {
  /**
   * Drop videos the viewer has already watched entirely. Used for the first
   * page; deeper pages keep them but they carry a penalty, so scrolling never
   * runs out of material.
   */
  excludeWatched?: boolean;
}

export interface RankResult {
  items: RankableVideo[];
  /** Development diagnostics: the scored order before diversity was applied. */
  scored: ScoredVideo[];
  /** Candidates removed before scoring, and why. */
  excluded: { suppressed: number; hiddenChannel: number; watched: number };
}

/**
 * Rank a candidate pool for a signed-in viewer.
 *
 * Order of operations matters and is deliberate: eligibility (the viewer's own
 * exclusions) first, then scoring, then ordering, then diversity. Exclusions are
 * counted so the caller can log them and so tests can assert on them.
 */
export function rankVideosDetailed(
  candidates: RankableVideo[],
  context: RankingContext,
  options: RankOptions = {},
): RankResult {
  const excluded = { suppressed: 0, hiddenChannel: 0, watched: 0 };
  const eligible: RankableVideo[] = [];

  for (const video of candidates) {
    if (context.suppressedVideoIds.has(video.id)) {
      excluded.suppressed += 1;
      continue;
    }
    if (context.hiddenChannelIds.has(video.channel.id)) {
      excluded.hiddenChannel += 1;
      continue;
    }
    if (options.excludeWatched && context.watchedVideoIds.has(video.id)) {
      excluded.watched += 1;
      continue;
    }
    eligible.push(video);
  }

  const scored = eligible
    .map((video) => scoreVideo(video, context))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tiebreak so equal scores never reorder between requests.
      const aTime = a.video.publishedAt ?? "";
      const bTime = b.video.publishedAt ?? "";
      if (aTime !== bTime) return aTime < bTime ? 1 : -1;
      return a.video.id < b.video.id ? -1 : 1;
    });

  return { items: applyDiversity(scored, options), scored, excluded };
}

/** Convenience wrapper returning only the ordered videos. */
export function rankVideos(
  candidates: RankableVideo[],
  context: RankingContext,
  options: RankOptions = {},
): RankableVideo[] {
  return rankVideosDetailed(candidates, context, options).items;
}

/**
 * Cold-start ordering for anonymous visitors and brand-new accounts.
 *
 * There is no history to personalise from, so this leans on freshness with a
 * minority share of saturated popularity. It deliberately does **not** simply
 * return the most-viewed videos, which would make every new visitor see the
 * same handful of items, and it applies the same channel/category diversity as
 * the personalised path.
 */
export function rankColdStart(
  candidates: RankableVideo[],
  context: RankingContext,
  options: DiversityOptions = {},
): RankableVideo[] {
  const scored: ScoredVideo[] = candidates.map((video) => {
    const recency = recencyTerm(video.publishedAt, context.now, COLD_START_HALF_LIFE_DAYS);
    const popularity = saturate(video.viewCount, VIEWS_CAP) / VIEWS_CAP;
    const score = recency + 0.35 * popularity;
    return { video, score, reasons: ["cold start"] };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = a.video.publishedAt ?? "";
    const bTime = b.video.publishedAt ?? "";
    if (aTime !== bTime) return aTime < bTime ? 1 : -1;
    return a.video.id < b.video.id ? -1 : 1;
  });

  return applyDiversity(scored, options);
}

/**
 * Parse a weight override from configuration.
 *
 * Accepts a JSON object with any subset of the weight names. Unknown keys and
 * non-numeric values are ignored rather than throwing, because a bad override
 * should degrade to the documented defaults rather than take the feed down. The
 * return value reports which keys were ignored so startup can log them.
 */
export function parseRankingWeights(raw: string | undefined | null): {
  weights: RankingWeights;
  ignored: string[];
} {
  const weights: RankingWeights = { ...DEFAULT_WEIGHTS };
  if (!raw) return { weights, ignored: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { weights, ignored: ["<unparseable RANKING_WEIGHTS>"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { weights, ignored: ["<RANKING_WEIGHTS is not an object>"] };
  }
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in DEFAULT_WEIGHTS)) {
      ignored.push(key);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      ignored.push(key);
      continue;
    }
    weights[key as keyof RankingWeights] = value;
  }
  return { weights, ignored };
}

/**
 * A short, development-only explanation of why the top of the feed looks the
 * way it does. Never returned to an ordinary viewer.
 */
export function explainRanking(scored: ScoredVideo[], limit = 5): string[] {
  return scored.slice(0, limit).map((entry) => {
    const reasons = entry.reasons.length > 0 ? entry.reasons.join(", ") : "baseline";
    return `${entry.video.id} "${entry.video.title}" score=${entry.score.toFixed(3)} (${reasons})`;
  });
}
