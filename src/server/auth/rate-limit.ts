/**
 * Persistent rate limiting.
 *
 * Backed by the `rate_limit_buckets` table so throttling is correct across
 * restarts and across multiple app instances (an in-memory map would silently
 * fail the moment you scale out or restart). A fixed-window counter is used:
 * cheap, predictable and adequate for login/upload/comment abuse control.
 *
 * The web layer wraps this in `src/server/auth/session.ts` guards; jobs and
 * services call it directly.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { rateLimited } from "@/lib/errors";

export interface RateLimitRule {
  /** Logical name, e.g. "login" — becomes the bucket key prefix. */
  scope: string;
  /** Maximum number of hits allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional time source override for deterministic tests. */
  now?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Records a hit and reports whether the caller is still within the limit.
 * `identity` should be stable per subject (ip, user id, channel id, …).
 */
export async function consumeRateLimit(rule: RateLimitRule, identity: string): Promise<RateLimitResult> {
  const now = rule.now ?? Date.now();
  if (getConfig().rateLimit.disabled) {
    return {
      allowed: true,
      remaining: rule.limit,
      limit: rule.limit,
      resetAt: new Date(now + rule.windowMs),
      retryAfterSeconds: 0,
    };
  }

  const key = `${rule.scope}:${identity}`.slice(0, 200);
  const windowStart = new Date(Math.floor(now / rule.windowMs) * rule.windowMs);
  const resetAt = new Date(windowStart.getTime() + rule.windowMs);

  // Single atomic statement: insert, or increment when still inside the same
  // window, or reset the counter when the window has rolled over.
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO rate_limit_buckets ("key", count, "windowStart", "expiresAt")
    VALUES (${key}, 1, ${windowStart}, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      count = CASE
        WHEN rate_limit_buckets."windowStart" = EXCLUDED."windowStart"
        THEN rate_limit_buckets.count + 1
        ELSE 1
      END,
      "windowStart" = EXCLUDED."windowStart",
      "expiresAt" = EXCLUDED."expiresAt"
    RETURNING count
  `;
  const count = Number(rows[0]?.count ?? 1);
  const allowed = count <= rule.limit;
  return {
    allowed,
    remaining: Math.max(0, rule.limit - count),
    limit: rule.limit,
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
  };
}

/** Throws a 429 `AppError` when the limit has been exceeded. */
export async function enforceRateLimit(rule: RateLimitRule, identity: string): Promise<void> {
  const result = await consumeRateLimit(rule, identity);
  if (!result.allowed) {
    throw rateLimited(result.retryAfterSeconds);
  }
}

/** Clears a bucket — call after a successful login so failures don't accumulate. */
export async function resetRateLimit(scope: string, identity: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { key: `${scope}:${identity}`.slice(0, 200) } });
}

/** Removes expired buckets. Called by the maintenance job. */
export async function pruneRateLimits(now = new Date()): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

/* ------------------------------------------------------------------ presets */

export const LIMITS = {
  login: () => ({
    scope: "login",
    limit: getConfig().rateLimit.loginMaxAttempts,
    windowMs: getConfig().rateLimit.loginWindowMs,
  }),
  register: () => ({ scope: "register", limit: 5, windowMs: 60 * 60_000 }),
  passwordReset: () => ({ scope: "pwreset", limit: 5, windowMs: 60 * 60_000 }),
  comment: () => ({ scope: "comment", limit: 20, windowMs: 5 * 60_000 }),
  upload: () => ({ scope: "upload", limit: 20, windowMs: 60 * 60_000 }),
  mutate: () => ({ scope: "mutate", limit: 120, windowMs: 60_000 }),
  read: () => ({ scope: "read", limit: 600, windowMs: 60_000 }),
  view: () => ({ scope: "view", limit: 240, windowMs: 60_000 }),
  search: () => ({ scope: "search", limit: 120, windowMs: 60_000 }),
  /** Password changes, account deletion and other high-impact actions. */
  sensitive: () => ({ scope: "sensitive", limit: 10, windowMs: 15 * 60_000 }),
} satisfies Record<string, () => Omit<RateLimitRule, "now">>;
