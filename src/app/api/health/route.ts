/**
 * Health endpoint.
 *
 * Used by `scripts/start.sh`, Docker healthchecks and monitoring. Reports the
 * status of every external dependency DEXTube needs, plus the resolved public
 * URL so an operator can confirm which instance answered.
 *
 * It is intentionally unauthenticated but exposes no secrets: only booleans,
 * tool versions and the host's own advertised URL.
 */
import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { checkStorage } from "@/server/storage";
import { checkMediaTools } from "@/server/media/ffmpeg";
import { getConfig } from "@/lib/config";
import { jobStats } from "@/server/jobs/queue";
import { kickInlineQueue } from "@/server/jobs/runner";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const started = Date.now();
  const config = getConfig();
  const url = new URL(request.url);
  const wantsDetails = url.searchParams.get("details") === "1";

  // Health checks run on a timer in every deployment, so this is a good place
  // to make sure inline-mode job processing is alive and self-healing.
  kickInlineQueue();

  const [database, storage, media] = await Promise.all([
    checkDatabase(),
    checkStorage(),
    checkMediaTools(),
  ]);

  const ok =
    database.ok &&
    storage.ok &&
    media.ffmpeg.available &&
    media.ffprobe.available &&
    media.encoder?.id !== "none";

  const body: Record<string, unknown> = {
    status: ok ? "ok" : "degraded",
    version: process.env.npm_package_version ?? "0.1.0",
    environment: config.nodeEnv,
    appUrl: config.appUrl,
    uptimeSeconds: Math.round(process.uptime()),
    responseTimeMs: Date.now() - started,
    checks: {
      database: { ok: database.ok, latencyMs: database.latencyMs, ...(database.error ? { error: database.error } : {}) },
      storage,
      ffmpeg: media.ffmpeg,
      ffprobe: media.ffprobe,
      h264Encoder: media.encoder,
    },
    features: {
      transcoding: config.media.transcodeLadder.length > 0,
      transcodeLadder: config.media.transcodeLadder,
      hls: config.media.enableHls,
      email: config.email.configured ? "smtp" : "file-outbox",
      jobRunner: config.jobs.runner,
      storageDriver: config.storage.driver,
    },
  };

  if (wantsDetails && config.nodeEnv !== "production") {
    body.jobs = await jobStats();
  }

  if (!ok) {
    logger.error("health check failed", {
      database: database.ok,
      storage: storage.ok,
      ffmpeg: media.ffmpeg.available,
      ffprobe: media.ffprobe.available,
    });
  }

  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
