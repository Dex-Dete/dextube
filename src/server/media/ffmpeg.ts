/**
 * FFmpeg / FFprobe wrappers.
 *
 * The child-process runner and binary paths live in `./exec`; H.264 encoder
 * negotiation lives in `./encoders`. This module is the high-level API the
 * media pipeline calls.
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";
import { encoderArgs, encoderPrelude, resolveEncoder } from "@/server/media/encoders";
import { FFMPEG_BIN, FFPROBE_BIN, runBinary } from "@/server/media/exec";

const log = logger.child({ mod: "ffmpeg" });

// Re-exported for callers that historically imported these from `./ffmpeg`.
export { FFMPEG_BIN, FFPROBE_BIN, runBinary } from "@/server/media/exec";
export type { RunOptions, RunResult } from "@/server/media/exec";

/**
 * FFmpeg refuses to write into a directory that does not exist (it reports a
 * confusing `return code -2 (No such file or directory)`). Every helper that
 * produces an output file therefore creates its parent directory first.
 */
async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
}

export interface ProbeResult {
  durationSec: number;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrate: number | null;
  frameRate: number | null;
  rotation: number;
  formatName: string | null;
  sizeBytes: number | null;
}

/**
 * Reads container/stream metadata with ffprobe (JSON output — no text parsing).
 * Throws a 400 `AppError` when the file cannot be decoded as media.
 */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const { code, stdout, stderr } = await runBinary(
    FFPROBE_BIN,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,duration,bit_rate,avg_frame_rate:stream_tags=rotate:format=format_name,duration,bit_rate,size",
      filePath,
    ],
    { timeoutMs: 60_000 },
  );

  if (code !== 0) {
    throw new AppError("BAD_REQUEST", `The file could not be read as video or audio. ${firstLine(stderr)}`);
  }

  let parsed: {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError("BAD_REQUEST", "The file could not be read as video or audio.");
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const format = parsed.format ?? {};

  if (!video && !audio) {
    throw new AppError("BAD_REQUEST", "No video or audio stream was found in that file.");
  }

  const duration = Number(format.duration ?? video?.duration ?? 0) || 0;
  const width = video?.width ? Number(video.width) : null;
  const height = video?.height ? Number(video.height) : null;
  const rotation = extractRotation(video);
  // Portrait/square sources are rotated by metadata; normalise so callers can
  // rely on width/height describing what the viewer actually sees.
  const displayWidth = rotation === 90 || rotation === 270 ? height : width;
  const displayHeight = rotation === 90 || rotation === 270 ? width : height;

  return {
    durationSec: duration,
    width: displayWidth,
    height: displayHeight,
    aspectRatio: displayWidth && displayHeight ? displayWidth / displayHeight : null,
    videoCodec: (video?.codec_name as string) ?? null,
    audioCodec: (audio?.codec_name as string) ?? null,
    hasAudio: Boolean(audio),
    bitrate: format.bit_rate ? Number(format.bit_rate) : null,
    frameRate: video?.avg_frame_rate ? parseFraction(String(video.avg_frame_rate)) : null,
    rotation,
    formatName: (format.format_name as string) ?? null,
    sizeBytes: format.size ? Number(format.size) : null,
  };
}

function extractRotation(stream: Record<string, unknown> | undefined): number {
  if (!stream) return 0;
  const tags = stream.tags as Record<string, unknown> | undefined;
  const raw = tags?.rotate;
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
}

function parseFraction(value: string): number | null {
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return null;
  return num / den;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.slice(0, 200);
}

/** True when a video stream looks like a 9:16 (or taller) "short". */
export function looksLikeShort(probe: Pick<ProbeResult, "aspectRatio" | "durationSec" | "height" | "width">): boolean {
  const ratio = probe.aspectRatio;
  if (!ratio) return false;
  // Portrait-ish (<= 0.75 ≈ 3:4 or taller) and at most 3 minutes.
  return ratio <= 0.75 && probe.durationSec > 0 && probe.durationSec <= 180;
}

/**
 * Generates a JPEG thumbnail.
 * `atPercent` positions the frame (e.g. 0.25 = 25% through the video).
 */
export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  opts: { atPercent?: number; width?: number; durationSec?: number } = {},
): Promise<void> {
  const durationSec = opts.durationSec ?? 0;
  const at = Math.max(0, durationSec * (opts.atPercent ?? 0.25));
  const width = opts.width ?? 1280;
  await ensureParent(outputPath);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    // `-ss` before `-i` is a fast (keyframe) seek; the second `-ss` refines it.
    "-ss",
    at.toFixed(3),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2:force_original_aspect_ratio=decrease`,
    "-q:v",
    "3",
    outputPath,
  ];
  const { code, stderr } = await runBinary(FFMPEG_BIN, args, { timeoutMs: 90_000 });
  if (code !== 0) {
    throw new AppError("INTERNAL", `Thumbnail generation failed. ${firstLine(stderr)}`);
  }
}

/**
 * Transcodes to a progressive MP4/H.264 + AAC rendition sized to `height`.
 * `-movflags +faststart` puts the moov atom first so the file streams
 * progressively over HTTP range requests.
 */
export async function transcodeToMp4(
  inputPath: string,
  outputPath: string,
  opts: {
    height: number;
    crf?: number;
    preset?: string;
    hasAudio?: boolean;
    onProgress?: (fraction: number) => void;
    durationSec?: number;
  } = { height: 480 },
): Promise<void> {
  const encoder = await resolveEncoder();
  const prelude = encoderPrelude(encoder);
  const vf = `${prelude.vfPrefix}scale=-2:${opts.height}:force_original_aspect_ratio=decrease`;
  const wanted = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : null;
  await ensureParent(outputPath);

  let lastReported = -1;
  const onStderr = opts.onProgress
    ? (chunk: string) => {
        if (!wanted) return;
        const match = /out_time_us=(\d+)/.exec(chunk);
        if (!match) return;
        const fraction = Math.min(1, Number(match[1]) / 1_000_000 / wanted);
        // Report in whole-percent steps to avoid flooding the job log.
        const bucket = Math.round(fraction * 100);
        if (bucket !== lastReported) {
          lastReported = bucket;
          opts.onProgress?.(fraction);
        }
      }
    : undefined;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...(opts.onProgress ? ["-progress", "pipe:2", "-nostats"] : []),
    ...prelude.global,
    "-i",
    inputPath,
    "-vf",
    vf,
    ...encoderArgs(encoder, {
      height: opts.height,
      crf: opts.crf,
      preset: opts.preset,
      hasAudio: opts.hasAudio,
    }),
    ...(encoder.hardware ? [] : ["-pix_fmt", "yuv420p"]),
    // Reasonably frequent keyframes keep seeking responsive.
    "-g",
    "48",
    ...(opts.hasAudio === false
      ? ["-an"]
      : ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]),
    "-movflags",
    "+faststart",
    outputPath,
  ];
  const { code, stderr } = await runBinary(FFMPEG_BIN, args, {
    timeoutMs: 30 * 60_000,
    onStderr,
  });
  if (code !== 0) {
    throw new AppError("INTERNAL", `Transcode failed. ${firstLine(stderr)}`);
  }
}

/**
 * Produces an H.264 + AAC MP4 that is safe for every browser. If the source is
 * already H.264/AAC MP4 the caller should prefer `remuxFaststart` instead.
 */
export async function remuxFaststart(inputPath: string, outputPath: string): Promise<void> {
  await ensureParent(outputPath);
  const { code, stderr } = await runBinary(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", outputPath],
    { timeoutMs: 20 * 60_000 },
  );
  if (code !== 0) {
    throw new AppError("INTERNAL", `Remux failed. ${firstLine(stderr)}`);
  }
}

/**
 * Packages an H.264/AAC source as HLS (single variant per rendition is handled
 * by the caller). Output is a playlist plus fMP4/TS segments inside `outDir`.
 */
export async function packageHls(
  inputPath: string,
  outDir: string,
  opts: { segmentSeconds?: number; height?: number } = {},
): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const encoder = await resolveEncoder();
  const prelude = encoderPrelude(encoder);
  const vf = opts.height
    ? `${prelude.vfPrefix}scale=-2:${opts.height}:force_original_aspect_ratio=decrease`
    : prelude.vfPrefix.replace(/,hwupload,$/, ",hwupload") || undefined;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...prelude.global,
    "-i",
    inputPath,
    ...(vf ? ["-vf", vf] : []),
    ...encoderArgs(encoder, { height: opts.height ?? 720, crf: 23, preset: "veryfast" }),
    ...(encoder.hardware ? [] : ["-pix_fmt", "yuv420p"]),
    "-g",
    "48",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    String(opts.segmentSeconds ?? 6),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    `${outDir}/seg_%05d.ts`,
    `${outDir}/index.m3u8`,
  ];
  const { code, stderr } = await runBinary(FFMPEG_BIN, args, { timeoutMs: 60 * 60_000 });
  if (code !== 0) {
    throw new AppError("INTERNAL", `HLS packaging failed. ${firstLine(stderr)}`);
  }
}

/** Extracts a single frame at an arbitrary timestamp (used by the thumbnail picker). */
export async function generatePoster(inputPath: string, outputPath: string, timeSec: number): Promise<void> {
  await ensureParent(outputPath);
  const { code, stderr } = await runBinary(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(Math.max(0, timeSec)), "-i", inputPath, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "4", outputPath],
    { timeoutMs: 90_000 },
  );
  if (code !== 0) {
    throw new AppError("INTERNAL", `Poster extraction failed. ${firstLine(stderr)}`);
  }
}

/** Converts an uploaded subtitle file to WebVTT. */
export async function convertToVtt(inputPath: string, outputPath: string): Promise<void> {
  await ensureParent(outputPath);
  const { code, stderr } = await runBinary(
    FFMPEG_BIN,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath, "-c:s", "webvtt", outputPath],
    { timeoutMs: 60_000 },
  );
  if (code !== 0) {
    throw new AppError("BAD_REQUEST", `Subtitle conversion failed. ${firstLine(stderr)}`);
  }
}

export interface ToolStatus {
  ffmpeg: { available: boolean; version?: string; error?: string };
  ffprobe: { available: boolean; version?: string; error?: string };
  /** The H.264 encoder DEXTube will use, and whether it is GPU-backed. */
  encoder?: { id: string; hardware: boolean; detail: string; error?: string };
}

/** Health probe: reports whether FFmpeg/FFprobe can be executed. */
export async function checkMediaTools(): Promise<ToolStatus> {
  const probe = async (bin: string) => {
    try {
      const { code, stdout } = await runBinary(bin, ["-version"], { timeoutMs: 10_000 });
      if (code !== 0) return { available: false, error: `exit code ${code}` };
      return { available: true, version: stdout.split("\n")[0]?.slice(0, 120) };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probe(FFMPEG_BIN), probe(FFPROBE_BIN)]);
  if (!ffmpeg.available || !ffprobe.available) {
    log.warn("media tools unavailable", { ffmpeg, ffprobe });
  }

  // Encoder resolution is worth reporting: a missing one is the single most
  // common reason uploads fail on a fresh Fedora box.
  let encoder: ToolStatus["encoder"];
  if (ffmpeg.available) {
    try {
      const choice = await resolveEncoder();
      encoder = { id: choice.id, hardware: choice.hardware, detail: choice.detail };
    } catch (error) {
      encoder = {
        id: "none",
        hardware: false,
        detail: "No usable H.264 encoder",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ffmpeg, ffprobe, encoder };
}
