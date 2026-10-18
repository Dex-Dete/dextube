/**
 * Upload service — resumable, chunked uploads with server-side authorisation.
 *
 * Flow
 *   1. POST /api/uploads            → creates an `Upload` row + reserved key
 *   2. PUT  /api/uploads/:id/chunk  → appends bytes at an explicit offset
 *   3. POST /api/uploads/:id/complete → promotes to a Video + queues processing
 *   4. DELETE /api/uploads/:id      → aborts and deletes the partial file
 *
 * Why chunks with an explicit offset rather than one big request body:
 *   * upload progress reflects real transferred bytes,
 *   * a dropped connection resumes from the last acknowledged byte,
 *   * the server never buffers a multi-gigabyte body.
 *
 * Safety
 *   * The client supplies only a filename and a size; the storage key is
 *     generated server-side, so path traversal is impossible by construction.
 *   * Size, MIME type and quota are validated server-side.
 *   * Chunk writes are positional and monotonic; a mismatched offset is
 *     rejected with the authoritative offset so the client can resync.
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { AppError, badRequest, forbidden, notFound, payloadTooLarge, unsupportedMedia } from "@/lib/errors";
import { buildKey, extensionFor, getStorage, normalizeKey } from "@/server/storage";
import { requireOwnedChannelId } from "@/server/services/channels";
import { enqueue } from "@/server/jobs/queue";
import { logger } from "@/lib/logger";
import { guessMimeFromName } from "@/server/media/validate";

const log = logger.child({ mod: "uploads" });

/** Chunk size advertised to clients (and enforced server-side). */
export const CHUNK_SIZE = 5 * 1024 * 1024;
/** Abandoned uploads are pruned after this long. */
export const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000;

export interface InitiateResult {
  uploadId: string;
  chunkSize: number;
  /** Byte offset the client should start sending from (supports resume). */
  receivedBytes: number;
  maxBytes: number;
}

/**
 * Creates an upload reservation.
 * `requestedVisibility` is not trusted for anything but the draft's default;
 * publishing always re-checks that processing succeeded.
 */
export async function initiateUpload(
  userId: string,
  input: { filename: string; sizeBytes: number; mimeType: string },
): Promise<InitiateResult> {
  const config = getConfig();
  if (input.sizeBytes > config.uploads.maxBytes) {
    throw payloadTooLarge(
      `Files are limited to ${Math.floor(config.uploads.maxBytes / (1024 * 1024))} MB on this DEXTube instance.`,
    );
  }

  const channelId = await requireOwnedChannelId(userId);

  // Reject obviously wrong types before creating any state.
  const mime = (input.mimeType || guessMimeFromName(input.filename) || "").toLowerCase();
  if (!mime.startsWith("video/") && !mime.startsWith("audio/")) {
    throw unsupportedMedia("Only video and audio files can be uploaded.");
  }
  const extension = extensionFor(mime, path.extname(input.filename).slice(1).toLowerCase() || "bin");
  if (!/^[a-z0-9]{2,5}$/.test(extension)) {
    throw unsupportedMedia("That file extension is not supported.");
  }

  // Concurrency guard: refuse to start another upload while 3 are in flight.
  const inFlight = await prisma.upload.count({
    where: { userId, status: { in: ["INITIATED", "UPLOADING"] } },
  });
  if (inFlight >= 3) {
    throw new AppError("CONFLICT", "You already have uploads in progress. Finish or cancel them first.");
  }

  const created = await prisma.upload.create({
    data: {
      userId,
      channelId,
      filename: input.filename.slice(0, 255),
      sizeBytes: BigInt(input.sizeBytes),
      mimeType: mime,
      // The upload id becomes the storage folder, so a key can always be traced
      // back to its owner.
      tempKey: "pending",
    },
    select: { id: true },
  });

  const tempKey = buildKey("uploads", created.id, `source.${extension}`);
  await prisma.upload.update({ where: { id: created.id }, data: { tempKey } });

  // Create the file so the first chunk can be written positionally.
  const localPath = resolveLocalPath(tempKey);
  await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o750 });
  await fs.writeFile(localPath, Buffer.alloc(0), { mode: 0o640 });

  log.info("upload initiated", { uploadId: created.id, userId, sizeBytes: input.sizeBytes, mime });

  return {
    uploadId: created.id,
    chunkSize: CHUNK_SIZE,
    receivedBytes: 0,
    maxBytes: config.uploads.maxBytes,
  };
}

function resolveLocalPath(key: string): string {
  const config = getConfig();
  if (config.storage.driver !== "local") {
    throw new AppError(
      "PRECONDITION_FAILED",
      "Chunked uploads require the local storage driver. Configure an S3 multipart adapter before using STORAGE_DRIVER=s3.",
    );
  }
  return getStorage().localPath(key);
}

/** Owner-only upload fetch. */
async function requireOwnUpload(uploadId: string, userId: string) {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: {
      id: true,
      userId: true,
      channelId: true,
      filename: true,
      sizeBytes: true,
      receivedBytes: true,
      mimeType: true,
      status: true,
      tempKey: true,
      videoId: true,
    },
  });
  if (!upload) throw notFound("That upload does not exist.");
  if (upload.userId !== userId) throw forbidden("That upload belongs to another account.");
  return upload;
}

/** Current resumable state, for a resuming client. */
export async function getUploadStatus(uploadId: string, userId: string) {
  const upload = await requireOwnUpload(uploadId, userId);
  return {
    uploadId: upload.id,
    filename: upload.filename,
    sizeBytes: Number(upload.sizeBytes),
    receivedBytes: Number(upload.receivedBytes),
    status: upload.status,
    videoId: upload.videoId,
    chunkSize: CHUNK_SIZE,
  };
}

/**
 * Appends a chunk at `offset`.
 * Returns the new received-bytes total. A mismatched offset is a 409 carrying
 * the authoritative offset so the client can resume instead of restarting.
 */
export async function appendChunk(
  uploadId: string,
  userId: string,
  offset: number,
  chunk: Buffer,
): Promise<{ receivedBytes: number }> {
  const upload = await requireOwnUpload(uploadId, userId);
  if (upload.status === "COMPLETE" || upload.status === "ABORTED") {
    throw preconconditionFailedForStatus(upload.status);
  }
  if (!Number.isInteger(offset) || offset < 0) throw badRequest("Invalid chunk offset.");
  if (chunk.length === 0) throw badRequest("Empty chunk.");
  if (chunk.length > CHUNK_SIZE) throw payloadTooLarge("Chunk is larger than the advertised chunk size.");

  const received = Number(upload.receivedBytes);
  if (offset !== received) {
    throw new AppError("CONFLICT", "Upload offset does not match the server's state; resume from the reported offset.", {
      details: { offset: [String(received)] },
    });
  }

  const total = Number(upload.sizeBytes);
  if (received + chunk.length > total) {
    throw payloadTooLarge("This chunk exceeds the declared file size.");
  }

  const localPath = resolveLocalPath(upload.tempKey);
  const handle = await fs.open(localPath, "r+");
  try {
    await handle.write(chunk, 0, chunk.length, received);
  } finally {
    await handle.close();
  }

  const next = received + chunk.length;
  await prisma.upload.update({
    where: { id: upload.id },
    data: { receivedBytes: BigInt(next), status: "UPLOADING" },
  });

  return { receivedBytes: next };
}

function preconconditionFailedForStatus(status: string) {
  return new AppError(
    "PRECONDITION_FAILED",
    status === "COMPLETE" ? "This upload has already been finalised." : "This upload was cancelled.",
  );
}

export interface CompleteResult {
  videoId: string;
  status: string;
}

/**
 * Finalises an upload: validates that every byte arrived, performs a fast
 * FFprobe pre-flight (so a corrupt file fails here rather than in the worker),
 * creates the `Video` row and queues processing.
 */
export async function completeUpload(
  uploadId: string,
  userId: string,
  metadata: { title: string; description?: string; visibility: "PRIVATE" | "UNLISTED" | "PUBLIC"; category?: string; tags?: string[]; isShortHint?: boolean },
): Promise<CompleteResult> {
  const upload = await requireOwnUpload(uploadId, userId);
  if (upload.videoId) return { videoId: upload.videoId, status: "PROCESSING" };
  if (upload.status === "ABORTED") throw new AppError("PRECONDITION_FAILED", "This upload was cancelled.");

  const received = Number(upload.receivedBytes);
  const expected = Number(upload.sizeBytes);
  if (received !== expected) {
    throw new AppError(
      "PRECONDITION_FAILED",
      `Upload incomplete: ${received} of ${expected} bytes received. Resume the upload and try again.`,
    );
  }

  const localPath = resolveLocalPath(upload.tempKey);
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat || stat.size !== expected) {
    throw new AppError("PRECONDITION_FAILED", "The uploaded file is missing or truncated. Please upload again.");
  }

  const { probeMedia, looksLikeShort } = await import("@/server/media/ffmpeg");
  const probe = await probeMedia(localPath);

  const config = getConfig();
  if (probe.durationSec > config.uploads.maxDurationSeconds) {
    throw payloadTooLarge(
      `Videos are limited to ${Math.round(config.uploads.maxDurationSeconds / 60)} minutes on this instance.`,
    );
  }

  const isShort = looksLikeShort(probe);

  const video = await prisma.$transaction(async (tx) => {
    const created = await tx.video.create({
      data: {
        channelId: upload.channelId,
        uploaderId: userId,
        title: metadata.title,
        description: metadata.description ?? "",
        visibility: metadata.visibility,
        status: "PROCESSING",
        isShort,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        category: metadata.category ?? null,
        tags: metadata.tags ?? [],
        sourceFilename: upload.filename,
        sizeBytes: upload.sizeBytes,
        mimeType: upload.mimeType,
      },
      select: { id: true },
    });
    await tx.upload.update({
      where: { id: upload.id },
      data: { status: "COMPLETE", videoId: created.id },
    });
    return created;
  });

  await enqueue(
    "media.process",
    { videoId: video.id, uploadId: upload.id },
    { dedupeKey: `media.process:${video.id}`, maxAttempts: 2 },
  );

  log.info("upload complete, processing queued", {
    uploadId: upload.id,
    videoId: video.id,
    durationSec: probe.durationSec,
    isShort,
  });

  return { videoId: video.id, status: "PROCESSING" };
}

/** Cancels an upload and removes the partial file. */
export async function abortUpload(uploadId: string, userId: string): Promise<void> {
  const upload = await requireOwnUpload(uploadId, userId);
  if (upload.videoId) {
    // Already promoted: cancelling only clears the staging file.
    await prisma.upload.update({ where: { id: upload.id }, data: { status: "COMPLETE", error: "staging file removed by user" } });
  } else {
    await prisma.upload.update({ where: { id: upload.id }, data: { status: "ABORTED" } });
  }
  await getStorage().delete(normalizeKey(upload.tempKey)).catch(() => {});
  log.info("upload aborted", { uploadId: upload.id, userId });
}

/**
 * Deletes abandoned uploads (partial files and their rows).
 * Invoked by the `maintenance.prune` job.
 */
export async function pruneAbandonedUploads(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - UPLOAD_STALE_MS);
  const stale = await prisma.upload.findMany({
    where: {
      status: { in: ["INITIATED", "UPLOADING", "ABORTED"] },
      updatedAt: { lt: cutoff },
      videoId: null,
    },
    select: { id: true, tempKey: true },
    take: 200,
  });

  for (const upload of stale) {
    await getStorage().delete(upload.tempKey).catch(() => {});
  }
  if (stale.length > 0) {
    await prisma.upload.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }
  if (stale.length > 0) log.info("pruned abandoned uploads", { count: stale.length });
  return { removed: stale.length };
}
