/**
 * Job runner.
 *
 * Two modes, selected by `JOB_RUNNER`:
 *
 *   inline   (default for development) — work is drained in the background of
 *            the web process. Nothing extra to run; still bounded concurrency
 *            so FFmpeg cannot saturate a laptop.
 *   external (recommended for production) — `npm run worker` owns the queue, so
 *            web requests never compete with transcoding.
 *
 * Both call the same `drainQueue`, so behaviour is identical.
 */
import "server-only";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { claimNextJob, completeJob, failJob, recoverStaleJobs } from "@/server/jobs/queue";
import { runJob } from "@/server/jobs/handlers";
import { ensureRecurringJobs } from "@/server/jobs/scheduler";

const log = logger.child({ mod: "runner" });

let inlineRunning = false;
let inlinePending = false;
let inlineRetryTimer: ReturnType<typeof setTimeout> | null = null;
let inlineRetryAt = 0;

/**
 * In inline mode there is no polling loop, so a job scheduled with backoff
 * would sit untouched until unrelated traffic happened to kick the queue.
 * After a retryable failure we therefore wake the queue ourselves.
 */
function scheduleInlineRetry(delayMs: number): void {
  if (getConfig().jobs.runner !== "inline") return;
  const at = Date.now() + delayMs;
  // Keep only the earliest outstanding retry.
  if (inlineRetryTimer && at >= inlineRetryAt) return;
  if (inlineRetryTimer) clearTimeout(inlineRetryTimer);
  inlineRetryAt = at;
  inlineRetryTimer = setTimeout(() => {
    inlineRetryTimer = null;
    inlineRetryAt = 0;
    kickInlineQueue();
  }, Math.max(1_000, delayMs));
  // Never hold the process open just for a retry.
  inlineRetryTimer.unref?.();
}

/**
 * Processes up to `max` jobs. Returns how many actually ran.
 * Concurrency is capped by `PROCESSING_CONCURRENCY` and only one draining
 * loop per process may be active, which is what keeps FFmpeg work bounded.
 */
export async function drainQueue(options: { workerId: string; max?: number }): Promise<number> {
  const config = getConfig();
  const max = options.max ?? config.media.processingConcurrency * 2;
  let processed = 0;

  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(options.workerId);
    if (!job) break;
    const started = Date.now();
    try {
      const result = await runJob(job.type, job.payload);
      await completeJob(job.id);
      processed++;
      log.info("job succeeded", {
        id: job.id,
        type: job.type,
        ms: Date.now() - started,
        ...(result ?? {}),
      });
    } catch (error) {
      const outcome = await failJob(job, error);
      if (outcome.willRetry && outcome.retryInMs !== null) {
        scheduleInlineRetry(outcome.retryInMs);
      }
    }
  }
  return processed;
}

/**
 * Kicks the queue from inside the web process (fire-and-forget).
 * Safe to call on every request: a second call while a drain is running just
 * sets a flag so the work is picked up in the next pass rather than twice.
 */
export function kickInlineQueue(): void {
  if (getConfig().jobs.runner !== "inline") return;
  ensureInlineHeartbeat();
  if (inlineRunning) {
    inlinePending = true;
    return;
  }
  inlineRunning = true;
  void (async () => {
    try {
      do {
        inlinePending = false;
        await drainQueue({ workerId: `inline-${process.pid}` });
      } while (inlinePending);
    } catch (error) {
      log.error("inline queue drain failed", { err: error instanceof Error ? error.message : String(error) });
    } finally {
      inlineRunning = false;
    }
  })();
}

let inlineHeartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * A low-frequency poll so inline mode still makes progress on jobs that were
 * scheduled with a delay (retries) or enqueued by a process that has since
 * exited. One indexed query every few seconds is negligible, and the timer is
 * unref'd so it never keeps the process alive.
 */
function ensureInlineHeartbeat(): void {
  if (inlineHeartbeat) return;
  // Schedule the recurring analytics/maintenance jobs as soon as we are alive.
  void ensureRecurringJobs();
  inlineHeartbeat = setInterval(() => {
    void ensureRecurringJobs();
    kickInlineQueue();
  }, 5_000);
  inlineHeartbeat.unref?.();
}

/** Long-running worker loop used by `npm run worker`. */
export async function runWorkerLoop(signal?: AbortSignal): Promise<void> {
  const config = getConfig();
  const workerId = process.env.DEXTUBE_WORKER_ID || `worker-${process.pid}`;
  log.info("worker started", {
    workerId,
    pollMs: config.jobs.pollMs,
    concurrency: config.media.processingConcurrency,
    ladder: config.media.transcodeLadder,
  });

  await recoverStaleJobs();

  let lastRecovery = Date.now();
  while (!signal?.aborted) {
    const processed = await drainQueue({ workerId });
    await ensureRecurringJobs();
    if (Date.now() - lastRecovery > 10 * 60_000) {
      lastRecovery = Date.now();
      await recoverStaleJobs().catch(() => 0);
    }
    if (processed === 0) {
      await sleep(config.jobs.pollMs, signal);
    }
  }
  log.info("worker stopped", { workerId });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
