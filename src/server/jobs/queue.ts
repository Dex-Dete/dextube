/**
 * Database-backed job queue.
 *
 * Why not Redis? The spec allows Redis to be optional, and this machine has no
 * Redis installed. A `jobs` table with `FOR UPDATE SKIP LOCKED` gives correct
 * at-least-once delivery, safe concurrent workers, retries with backoff and
 * dead-letter inspection, with no extra service to run — and the `JobQueue`
 * interface can be re-implemented on Redis/BullMQ later without touching
 * handlers.
 *
 * Delivery semantics: **at-least-once**. Handlers must therefore be
 * idempotent (they are: they derive all state from the DB row they mutate).
 */
import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

const log = logger.child({ mod: "jobs" });

export type JobType =
  | "media.process"
  | "media.thumbnail"
  | "notification.fanout"
  | "analytics.aggregate"
  | "maintenance.prune";

export interface JobPayloads {
  "media.process": { videoId: string; uploadId: string };
  "media.thumbnail": { videoId: string; timeSec?: number };
  "notification.fanout": { videoId: string };
  "analytics.aggregate": { day?: string };
  "maintenance.prune": Record<string, never>;
}

export interface EnqueueOptions {
  /** Unique key preventing duplicate jobs for the same logical event. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Adds a job. Duplicate `dedupeKey`s are ignored (returns null). */
export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  options: EnqueueOptions = {},
): Promise<{ id: string } | null> {
  const config = getConfig();
  const dedupeKey = options.dedupeKey ?? null;

  // Fast path: a job with this key already exists. The scheduler re-enqueues the
  // same bucket every tick, so without this check every pass raises a P2002 that
  // Prisma logs as an error before we can swallow it. The insert below still
  // handles the race between this lookup and the write.
  if (dedupeKey) {
    const existing = await prisma.job.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (existing) {
      log.debug("job deduplicated", { type, dedupeKey });
      return null;
    }
  }

  try {
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        dedupeKey,
        runAt: options.runAt ?? new Date(),
        maxAttempts: options.maxAttempts ?? config.jobs.maxAttempts,
      },
      select: { id: true },
    });
    log.debug("job enqueued", { type, id: job.id });
    return job;
  } catch (error) {
    // Unique constraint on dedupeKey => the job already exists.
    if (isUniqueViolation(error)) {
      log.debug("job deduplicated", { type, dedupeKey: options.dedupeKey });
      return null;
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * Atomically claims the next runnable job for `workerId`.
 * `SKIP LOCKED` lets several workers poll concurrently without contention.
 */
export async function claimNextJob(workerId: string): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    WITH next AS (
      SELECT id FROM jobs
      WHERE status = 'PENDING' AND "runAt" <= NOW()
      ORDER BY "runAt" ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'RUNNING',
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        attempts = jobs.attempts + 1,
        "updatedAt" = NOW()
    FROM next
    WHERE jobs.id = next.id
    RETURNING jobs.id, jobs.type, jobs.payload, jobs.attempts, jobs."maxAttempts"
  `;
  const job = rows[0];
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    attempts: Number(job.attempts),
    maxAttempts: Number(job.maxAttempts),
  };
}

export async function completeJob(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "SUCCEEDED", lockedAt: null, lockedBy: null, lastError: null },
  });
}

/** Records a failure; retries with exponential backoff until maxAttempts. */
export async function failJob(
  job: ClaimedJob,
  error: unknown,
): Promise<{ willRetry: boolean; retryInMs: number | null }> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const canRetry = job.attempts < job.maxAttempts;
  // 5s, 25s, 125s … capped at 10 minutes.
  const retryInMs = canRetry
    ? Math.min(10 * 60_000, 5_000 * 5 ** Math.max(0, job.attempts - 1))
    : null;
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: canRetry ? "PENDING" : "FAILED",
      lockedAt: null,
      lockedBy: null,
      lastError: message.slice(0, 4000),
      runAt: retryInMs === null ? undefined : new Date(Date.now() + retryInMs),
    },
  });
  log[canRetry ? "warn" : "error"]("job failed", {
    id: job.id,
    type: job.type,
    attempts: job.attempts,
    willRetry: canRetry,
    err: message,
  });
  return { willRetry: canRetry, retryInMs };
}

/** Re-queues jobs whose worker died mid-run (lock older than `staleMs`). */
export async function recoverStaleJobs(staleMs = 15 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const result = await prisma.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockedAt: null, lockedBy: null, lastError: "recovered from stale lock" },
  });
  if (result.count > 0) log.warn("recovered stale jobs", { count: result.count });
  return result.count;
}

export async function jobStats() {
  const grouped = await prisma.job.groupBy({ by: ["status"], _count: { _all: true } });
  const failed = await prisma.job.findMany({
    where: { status: "FAILED" },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, type: true, attempts: true, lastError: true, updatedAt: true },
  });
  return { counts: grouped.map((g) => ({ status: g.status, count: g._count._all })), recentFailures: failed };
}

/** Deletes finished jobs older than `days`. */
export async function pruneJobs(days = 14): Promise<number> {
  const result = await prisma.job.deleteMany({
    where: {
      status: { in: ["SUCCEEDED", "FAILED"] },
      updatedAt: { lt: new Date(Date.now() - days * 86_400_000) },
    },
  });
  return result.count;
}
