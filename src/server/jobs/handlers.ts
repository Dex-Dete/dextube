/**
 * Job handlers.
 *
 * Each handler is idempotent (at-least-once delivery) and returns a small
 * result object which the runner logs. Handlers are registered in one map so
 * the set of background work DEXTube performs is auditable in a single file.
 */
import "server-only";
import { processVideo, purgeVideoMedia } from "@/server/services/media-process";
import { notificationService } from "@/server/services/notifications";
import { aggregateDailyStats } from "@/server/services/analytics";
import { pruneAbandonedUploads } from "@/server/services/uploads";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { pruneSessions } from "@/server/auth/session";
import { pruneJobs } from "@/server/jobs/queue";
import { logger } from "@/lib/logger";
import type { JobType } from "@/server/jobs/queue";

const log = logger.child({ mod: "jobs" });

export type JobHandler = (payload: unknown) => Promise<Record<string, unknown>>;

export const handlers: Record<JobType, JobHandler> = {
  /** Transcode/thumbnail/package an upload, then mark it READY. */
  "media.process": async (payload) => {
    const { videoId, uploadId } = payload as { videoId: string; uploadId: string };
    const result = await processVideo(videoId, uploadId);
    return { videoId, status: result.status, renditions: result.renditions };
  },

  /** Re-extract a thumbnail at a creator-chosen timestamp. */
  "media.thumbnail": async (payload) => {
    const { videoId, timeSec } = payload as { videoId: string; timeSec?: number };
    const { regenerateThumbnail } = await import("@/server/services/media-process");
    const result = await regenerateThumbnail(videoId, timeSec);
    return { videoId, thumbnailKey: result.thumbnailKey };
  },

  /** Fan a published video out to its channel's subscribers. */
  "notification.fanout": async (payload) => {
    const { videoId } = payload as { videoId: string };
    return notificationService.fanoutNewVideo(videoId);
  },

  /** Roll per-video/per-channel daily aggregates for reporting. */
  "analytics.aggregate": async (payload) => {
    const { day } = payload as { day?: string };
    const result = await aggregateDailyStats(day ? new Date(day) : new Date());
    return { day: result.day, videos: result.videos, channels: result.channels };
  },

  /** Housekeeping: expired sessions, rate-limit buckets, stale uploads, jobs. */
  "maintenance.prune": async () => {
    const [sessions, buckets, uploads, jobs] = await Promise.all([
      pruneSessions(),
      pruneRateLimits(),
      pruneAbandonedUploads(),
      pruneJobs(),
    ]);
    return { sessions, buckets, uploads: uploads.removed, jobs };
  },
};

/** Runs a claimed job, dispatching to its handler. */
export async function runJob(type: string, payload: unknown): Promise<Record<string, unknown>> {
  const handler = handlers[type as JobType];
  if (!handler) {
    log.error("no handler registered for job type", { type });
    throw new Error(`No handler registered for job type "${type}".`);
  }
  return handler(payload);
}

/**
 * Purges stored media for a deleted video.
 * Exposed separately because it is invoked from the delete flow rather than
 * from a queue payload (the payload only carries a catalogue-wide prune).
 */
export async function purgeDeletedVideoMedia(videoId: string): Promise<void> {
  await purgeVideoMedia(videoId);
}
