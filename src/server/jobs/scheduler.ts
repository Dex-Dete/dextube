/**
 * Recurring job scheduler.
 *
 * DEXTube has no external cron or Redis; the runner (inline heartbeat or the
 * `npm run worker` loop) calls `ensureRecurringJobs()` periodically. Every job
 * is de-duplicated by a time-bucketed key, so calling this often is harmless
 * and running several app instances cannot double-schedule the same work.
 *
 * Scheduled work:
 *   * `analytics.aggregate` for **today**, refreshed every 15 minutes so the
 *     Studio numbers stay current through the day (the rollup is a rebuild, so
 *     re-running it is safe and self-healing).
 *   * `analytics.aggregate` for **yesterday**, once, shortly after midnight to
 *     finalise the previous day.
 *   * `maintenance.prune`, once per day.
 */
import "server-only";
import { enqueue } from "@/server/jobs/queue";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "scheduler" });

/** How often today's rollup may be recomputed. */
export const AGGREGATE_REFRESH_MS = 15 * 60_000;

/** In-process throttle so a fast heartbeat does not hammer the database. */
const ENSURE_THROTTLE_MS = 60_000;
let lastEnsureAt = 0;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Enqueues the recurring jobs. Exported separately from the throttled wrapper
 * so tests and one-off maintenance can call it deterministically.
 *
 * Returns which jobs were newly created (deduplicated ones report `false`).
 */
export interface RecurringScheduleResult {
  aggregate: boolean;
  finalisedYesterday: boolean;
  maintenance: boolean;
}

export async function scheduleRecurringJobs(now = new Date()): Promise<RecurringScheduleResult> {
  const day = startOfUtcDay(now);
  const key = dayKey(day);

  // 1. Keep today's aggregates current.
  const bucket = Math.floor(now.getTime() / AGGREGATE_REFRESH_MS);
  const aggregate = await enqueue(
    "analytics.aggregate",
    { day: day.toISOString() },
    { dedupeKey: `analytics:${key}:${bucket}` },
  );

  // 2. Finalise yesterday within two hours of midnight.
  let finalisedYesterday = false;
  if (now.getTime() - day.getTime() < 2 * 60 * 60_000) {
    const yesterday = new Date(day.getTime() - 86_400_000);
    finalisedYesterday = Boolean(
      await enqueue(
        "analytics.aggregate",
        { day: yesterday.toISOString() },
        { dedupeKey: `analytics-final:${dayKey(yesterday)}` },
      ),
    );
  }

  // 3. Daily housekeeping (sessions, rate limits, uploads, finished jobs).
  const maintenance = await enqueue("maintenance.prune", {}, { dedupeKey: `maintenance:${key}` });

  return { aggregate: Boolean(aggregate), finalisedYesterday, maintenance: Boolean(maintenance) };
}

/** Throttled entry point called by the runner loops. */
export async function ensureRecurringJobs(now = new Date()): Promise<void> {
  if (now.getTime() - lastEnsureAt < ENSURE_THROTTLE_MS) return;
  lastEnsureAt = now.getTime();
  try {
    await scheduleRecurringJobs(now);
  } catch (error) {
    log.warn("could not schedule recurring jobs", {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test helper: clear the in-process throttle. */
export function resetSchedulerThrottle(): void {
  lastEnsureAt = 0;
}
