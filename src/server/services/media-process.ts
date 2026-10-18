/**
 * Media processing pipeline.
 *
 * Runs inside the `media.process` job. Steps:
 *
 *   1. Move the staged upload into its permanent source key.
 *   2. FFprobe (again, authoritatively) for duration/dimensions/codecs.
 *   3. Extract a poster + thumbnail.
 *   4. Produce the playback rendition:
 *        - H.264/AAC in MP4 → remux with `+faststart` (no quality loss, fast)
 *        - anything else     → transcode to the largest ladder height that
 *                              does not upscale the source
 *   5. Optionally transcode the remaining ladder heights and package HLS.
 *   6. Record `VideoAsset` rows, mark the video READY and — when the uploader
 *      chose PUBLIC — publish it and queue the subscriber notification fan-out.
 *
 * Failure handling: the video is marked FAILED with `processingError`, the
 * original source is retained so the creator can retry, and the error is
 * surfaced in Studio. Processing never silently succeeds.
 */
import "server-only";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getStorage, buildKey } from "@/server/storage";
import {
  generatePoster,
  generateThumbnail,
  packageHls,
  probeMedia,
  remuxFaststart,
  transcodeToMp4,
  type ProbeResult,
} from "@/server/media/ffmpeg";
import { enqueue } from "@/server/jobs/queue";
import { recomputeChannelCounts } from "@/server/services/videos";

const log = logger.child({ mod: "media" });

export interface ProcessResult {
  videoId: string;
  status: "READY" | "FAILED";
  renditions: number;
  durationSec: number;
  isShort: boolean;
  thumbnailKey: string | null;
  playbackKey: string | null;
}

/**
 * Processes one uploaded video.
 * Idempotent: re-running after a partial failure replaces the derived assets
 * and converges on the same final state.
 */
export async function processVideo(videoId: string, uploadId: string): Promise<ProcessResult> {
  const config = getConfig();
  const storage = getStorage();

  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      channelId: true,
      status: true,
      visibility: true,
      publishedAt: true,
      title: true,
      sourceFilename: true,
    },
  });
  if (!video) throw new Error(`Video ${videoId} no longer exists.`);

  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: { id: true, tempKey: true, mimeType: true },
  });
  if (!upload) throw new Error(`Upload ${uploadId} no longer exists.`);

  await prisma.video.update({
    where: { id: videoId },
    data: { status: "PROCESSING", processingError: null },
  });

  const extension = path.extname(upload.tempKey).replace(".", "") || "mp4";
  const sourceKey = buildKey("videos", videoId, "source", `original.${extension}`);

  try {
    // ---------------------------------------------------------- 1. promote
    // Idempotent: a retried job finds the source already promoted and skips
    // the move instead of failing because the staging file is gone.
    const sourcePath = storage.localPath(sourceKey);
    const alreadyPromoted = await storage.stat(sourceKey);
    if (!alreadyPromoted || alreadyPromoted.size === 0) {
      const staged = await storage.stat(upload.tempKey);
      if (!staged) throw new Error("The staged upload file is missing from storage.");
      // Same volume → an atomic rename; no multi-gigabyte buffer is ever held
      // in memory. Falls back to a streamed copy across filesystems.
      await moveFile(storage.localPath(upload.tempKey), sourcePath);
      await storage.delete(upload.tempKey);
    }

    // -------------------------------------------------------------- 2. probe
    const probe = await probeMedia(sourcePath);
    if (probe.durationSec <= 0) throw new Error("The file has no decodable duration.");

    // --------------------------------------------------------- 3. thumbnails
    const thumbnailKey = buildKey("videos", videoId, "thumbs", "default.jpg");
    const posterKey = buildKey("videos", videoId, "thumbs", "poster.jpg");
    const thumbnailPath = storage.localPath(thumbnailKey);
    const posterPath = storage.localPath(posterKey);

    await generateThumbnail(sourcePath, thumbnailPath, {
      atPercent: 0.25,
      width: 1280,
      durationSec: probe.durationSec,
    });
    await generatePoster(sourcePath, posterPath, Math.min(probe.durationSec * 0.1, 5));

    // ---------------------------------------------------- 4. playback source
    const ladder = chooseLadder(probe, config.media.transcodeLadder);
    const primaryHeight = ladder[0] ?? 720;
    const primaryKey = buildKey("videos", videoId, "playback", `${primaryHeight}p.mp4`);
    const primaryPath = storage.localPath(primaryKey);

    const alreadyCompatible =
      probe.videoCodec === "h264" &&
      (!probe.hasAudio || probe.audioCodec === "aac") &&
      /mp4|mov|m4a/.test(probe.formatName ?? "") &&
      (probe.height ?? 0) <= primaryHeight;

    if (alreadyCompatible) {
      await remuxFaststart(sourcePath, primaryPath);
    } else {
      await transcodeToMp4(sourcePath, primaryPath, {
        height: primaryHeight,
        hasAudio: probe.hasAudio,
        crf: 23,
        preset: "veryfast",
      });
    }

    const assets: Array<{
      kind: "PROGRESSIVE" | "HLS_MANIFEST" | "THUMBNAIL" | "ORIGINAL";
      label: string;
      storageKey: string;
      mimeType: string;
      width: number | null;
      height: number | null;
      sizeBytes: number | null;
    }> = [];

    for (const height of ladder) {
      const key = height === primaryHeight ? primaryKey : buildKey("videos", videoId, "playback", `${height}p.mp4`);
      const target = storage.localPath(key);
      if (height !== primaryHeight) {
        await transcodeToMp4(sourcePath, target, {
          height,
          hasAudio: probe.hasAudio,
          crf: 24,
          preset: "veryfast",
        });
      }
      const stat = await storage.stat(key);
      assets.push({
        kind: "PROGRESSIVE",
        label: `${height}p`,
        storageKey: key,
        mimeType: "video/mp4",
        width: scaleWidth(probe, height),
        height,
        sizeBytes: stat?.size ?? null,
      });
    }

    // ------------------------------------------------------- 5. optional HLS
    let hlsKey: string | null = null;
    if (config.media.enableHls) {
      const hlsDir = storage.localPath(buildKey("videos", videoId, "hls"));
      await packageHls(primaryPath, hlsDir, { height: primaryHeight, segmentSeconds: 6 });
      hlsKey = buildKey("videos", videoId, "hls", "index.m3u8");
      assets.push({
        kind: "HLS_MANIFEST",
        label: `${primaryHeight}p HLS`,
        storageKey: hlsKey,
        mimeType: "application/vnd.apple.mpegurl",
        width: scaleWidth(probe, primaryHeight),
        height: primaryHeight,
        sizeBytes: null,
      });
    }

    for (const [label, key] of [
      ["Thumbnail", thumbnailKey],
      ["Poster", posterKey],
    ] as const) {
      const stat = await storage.stat(key);
      assets.push({
        kind: "THUMBNAIL",
        label,
        storageKey: key,
        mimeType: "image/jpeg",
        width: 1280,
        height: null,
        sizeBytes: stat?.size ?? null,
      });
    }

    const sourceStat = await storage.stat(sourceKey);
    assets.push({
      kind: "ORIGINAL",
      label: "Original upload",
      storageKey: sourceKey,
      mimeType: upload.mimeType,
      width: probe.width,
      height: probe.height,
      sizeBytes: sourceStat?.size ?? null,
    });

    // ------------------------------------------------------------ 6. commit
    await prisma.$transaction(async (tx) => {
      await tx.videoAsset.deleteMany({ where: { videoId } });
      await tx.videoAsset.createMany({
        data: assets.map((asset) => ({
          videoId,
          kind: asset.kind,
          label: asset.label,
          storageKey: asset.storageKey,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          sizeBytes: asset.sizeBytes === null ? null : BigInt(asset.sizeBytes),
        })),
      });

      await tx.video.update({
        where: { id: videoId },
        data: {
          status: "READY",
          processingError: null,
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          thumbnailKey,
          posterKey,
          playbackKey: primaryKey,
          hlsKey,
          originalKey: sourceKey,
          sizeBytes: sourceStat?.size ?? undefined,
          // Publish-on-ready: the creator chose a non-private visibility before
          // the media was ready, so publishing happens now and only now.
          ...(video.visibility !== "PRIVATE" && !video.publishedAt ? { publishedAt: new Date() } : {}),
        },
      });
    });

    if (video.visibility !== "PRIVATE") {
      await enqueue("notification.fanout", { videoId }, { dedupeKey: `fanout:${videoId}` });
    }
    await recomputeChannelCounts(videoId);

    log.info("media processed", {
      videoId,
      durationSec: Math.round(probe.durationSec),
      renditions: ladder.length,
      hls: Boolean(hlsKey),
    });

    return {
      videoId,
      status: "READY",
      renditions: ladder.length,
      durationSec: probe.durationSec,
      isShort: (probe.height ?? 0) > (probe.width ?? 0),
      thumbnailKey,
      playbackKey: primaryKey,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The creator's chosen visibility is deliberately preserved: a transient
    // failure must not silently unpublish a video that later succeeds on
    // retry. FAILED videos are excluded from every public listing anyway
    // because those queries require `status = READY`.
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "FAILED", processingError: detail.slice(0, 4000) },
    });
    log.error("media processing failed", { videoId, err: detail });
    throw error;
  }
}

/** Re-generates the thumbnail from an existing rendition (used by Studio). */
export async function regenerateThumbnail(videoId: string, timeSec?: number): Promise<{ thumbnailKey: string }> {
  const storage = getStorage();
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { id: true, durationSec: true, playbackKey: true, originalKey: true },
  });
  if (!video) throw new Error("Video not found.");
  const from = video.originalKey ?? video.playbackKey;
  if (!from) throw new Error("This video has no processed media to take a thumbnail from.");

  const thumbnailKey = buildKey("videos", videoId, "thumbs", "default.jpg");
  const at = timeSec ?? Math.min(5, Math.max(1, video.durationSec * 0.25));
  // `generateThumbnail` positions the frame as a fraction of the duration, so
  // an absolute timestamp is expressed as `atPercent: 1`.
  await generateThumbnail(storage.localPath(from), storage.localPath(thumbnailKey), {
    atPercent: 1,
    durationSec: at,
    width: 1280,
  });
  await prisma.video.update({ where: { id: videoId }, data: { thumbnailKey } });
  return { thumbnailKey };
}

/** Deletes every stored artefact for a video (used by hard delete / purge). */
export async function purgeVideoMedia(videoId: string): Promise<void> {
  const storage = getStorage();
  await storage.deletePrefix(buildKey("videos", videoId)).catch((error) => {
    log.warn("failed to purge video media", { videoId, err: String(error) });
  });
}

/**
 * Chooses rendition heights: never upscale above the source, always include a
 * primary rendition, and cap the count so a laptop is not asked to run a
 * six-way transcode.
 */
export function chooseLadder(probe: ProbeResult, configured: number[], maxRenditions = 2): number[] {
  const sourceHeight = probe.height ?? 720;
  const usable = configured.filter((height) => height <= sourceHeight + 8);
  if (usable.length === 0) {
    // Source is smaller than every ladder entry: single rendition at source
    // height, rounded to an even number (H.264 requires even dimensions).
    return [Math.max(144, sourceHeight % 2 === 0 ? sourceHeight : sourceHeight - 1)];
  }
  return usable.slice(0, maxRenditions);
}

function scaleWidth(probe: ProbeResult, height: number): number | null {
  if (!probe.width || !probe.height) return null;
  const width = Math.round((probe.width / probe.height) * height);
  return width % 2 === 0 ? width : width - 1;
}

/** Moves a staged file into its permanent key without buffering it. */
async function moveFile(from: string, to: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o750 });
  try {
    await fs.rename(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EXDEV: different filesystem (e.g. storage on another mount).
    if (code !== "EXDEV") throw error;
  }
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(createReadStream(from), createWriteStream(to, { mode: 0o640 }));
  await fs.rm(from, { force: true });
}
