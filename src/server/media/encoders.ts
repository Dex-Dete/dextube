/**
 * H.264 encoder negotiation.
 *
 * Why this module exists
 * ----------------------
 * Fedora ships `ffmpeg-free`, which deliberately omits the patent-encumbered
 * `libx264` encoder. A naive pipeline that hardcodes `-c:v libx264` therefore
 * fails on a stock Fedora install with "Unknown encoder 'libx264'". DEXTube
 * detects what the local FFmpeg build can actually do and picks the best
 * available H.264 encoder instead of assuming one exists.
 *
 * Preference order (highest first):
 *   1. `IMediaEncoder` override from `VIDEO_ENCODER` (explicit user choice)
 *   2. `libx264`  – best quality/size, present when RPM Fusion FFmpeg is used
 *   3. `h264_nvenc` – NVIDIA hardware, if a device is visible
 *   4. `h264_vaapi` – Intel/AMD hardware, if a render node initialises
 *   5. `libopenh264` – software H.264 shipped by Fedora (openh264 repo)
 *
 * If none of the above exist we throw a clear, actionable error rather than
 * producing a video that cannot be played.
 *
 * Detection runs `ffmpeg -encoders` exactly once per process and is memoised.
 */
import "server-only";
import fs from "node:fs";
import { FFMPEG_BIN, runBinary } from "@/server/media/ffmpeg";
import { logger } from "@/lib/logger";
import { AppError } from "@/lib/errors";

const log = logger.child({ mod: "encoder" });

/** Canonical encoder identifiers DEXTube knows how to drive. */
export type EncoderId = "libx264" | "libopenh264" | "h264_nvenc" | "h264_vaapi";

export interface EncoderChoice {
  /** Internal identifier. */
  id: EncoderId;
  /** The exact encoder name handed to FFmpeg (`-c:v <name>`). */
  name: string;
  /** Whether encoding is offloaded to a GPU. */
  hardware: boolean;
  /** Human-readable explanation, surfaced by `/api/health` and Studio. */
  detail: string;
}

export interface EncodeOptions {
  height: number;
  /** Quality target for CRF-capable encoders (ignored by bitrate-only ones). */
  crf?: number;
  preset?: string;
  hasAudio?: boolean;
  /** Explicit video bitrate in kbps; defaults to a per-height guess. */
  bitrateKbps?: number;
}

/** Maps a rendition height to a sane H.264 bitrate for encoders without CRF. */
export function bitrateForHeight(height: number): number {
  if (height >= 2160) return 14_000;
  if (height >= 1440) return 8_000;
  if (height >= 1080) return 4_500;
  if (height >= 720) return 2_500;
  if (height >= 480) return 1_200;
  if (height >= 360) return 700;
  return 400;
}

const PREFERENCE: EncoderId[] = ["libx264", "h264_nvenc", "h264_vaapi", "libopenh264"];

const DETAIL: Record<EncoderId, { name: string; hardware: boolean; detail: string }> = {
  libx264: {
    name: "libx264",
    hardware: false,
    detail: "Software H.264 (x264). Highest quality per byte; requires RPM Fusion FFmpeg.",
  },
  libopenh264: {
    name: "libopenh264",
    hardware: false,
    detail: "Software H.264 (Cisco OpenH264). Default on stock Fedora's ffmpeg-free build.",
  },
  h264_nvenc: { name: "h264_nvenc", hardware: true, detail: "NVIDIA NVENC hardware H.264." },
  h264_vaapi: { name: "h264_vaapi", hardware: true, detail: "Intel/AMD VAAPI hardware H.264." },
};

let cached: EncoderChoice | null = null;
let detection: Promise<EncoderChoice> | null = null;

/** Returns the encoder FFmpeg's build actually advertises (`-encoders`). */
async function listAvailableEncoders(): Promise<Set<string>> {
  const { code, stdout } = await runBinary(FFMPEG_BIN, ["-hide_banner", "-encoders"], {
    timeoutMs: 15_000,
  });
  if (code !== 0) {
    throw new AppError("INTERNAL", "Could not query FFmpeg for its encoder list.");
  }
  const found = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Encoder listing columns: " V....D libx264  H.264 ..."
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

function nvencDevicePresent(): boolean {
  return fs.existsSync("/dev/nvidia0") || fs.existsSync("/dev/nvidiactl");
}

/** Confirms a VAAPI render node can actually be opened (driver may be absent). */
async function vaapiUsable(device: string): Promise<boolean> {
  if (!fs.existsSync(device)) return false;
  // A 1-frame encode to null muxer is the only reliable liveness check.
  const { code } = await runBinary(
    FFMPEG_BIN,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-vaapi_device", device,
      "-f", "lavfi",
      "-i", "color=size=64x64:rate=1:duration=1",
      "-vf", "format=nv12,hwupload",
      "-c:v", "h264_vaapi",
      "-frames:v", "1",
      "-f", "null",
      "-",
    ],
    { timeoutMs: 20_000 },
  );
  return code === 0;
}

async function detect(): Promise<EncoderChoice> {
  const available = await listAvailableEncoders();
  const requested = (process.env.VIDEO_ENCODER || "auto").trim().toLowerCase();

  const build = (id: EncoderId): EncoderChoice => ({ id, ...DETAIL[id] });

  if (requested && requested !== "auto") {
    if (!(requested in DETAIL)) {
      throw new AppError(
        "INTERNAL",
        `VIDEO_ENCODER="${requested}" is not supported. Use one of: auto, ${Object.keys(DETAIL).join(", ")}.`,
      );
    }
    const id = requested as EncoderId;
    if (!available.has(DETAIL[id].name)) {
      throw new AppError(
        "INTERNAL",
        `VIDEO_ENCODER="${requested}" was requested but this FFmpeg build has no such encoder. Use VIDEO_ENCODER=auto.`,
      );
    }
    log.info("using configured video encoder", { encoder: id });
    return build(id);
  }

  for (const id of PREFERENCE) {
    if (!available.has(DETAIL[id].name)) continue;
    if (id === "h264_nvenc" && !nvencDevicePresent()) continue;
    if (id === "h264_vaapi") {
      const device = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
      if (!(await vaapiUsable(device))) continue;
    }
    log.info("resolved video encoder", { encoder: id, hardware: DETAIL[id].hardware });
    return build(id);
  }

  throw new AppError(
    "INTERNAL",
    "No usable H.264 encoder was found. Install one of:\n" +
      "  * Fedora: sudo dnf install ffmpeg-free (provides libopenh264 via the openh264 repo), or\n" +
      "  * RPM Fusion: sudo dnf install ffmpeg (full build, provides libx264).\n" +
      "Then restart DEXTube.",
  );
}

/** Memoised encoder resolution. Safe to call from every job. */
export function resolveEncoder(): Promise<EncoderChoice> {
  if (cached) return Promise.resolve(cached);
  if (!detection) {
    detection = detect()
      .then((choice) => {
        cached = choice;
        return choice;
      })
      .catch((error) => {
        // Do not cache failures: a missing package can be installed and retried.
        detection = null;
        throw error;
      });
  }
  return detection;
}

/** Test helper: forget the detected encoder. */
export function resetEncoderCache(): void {
  cached = null;
  detection = null;
}

/**
 * Builds the FFmpeg output-argument fragment for a rendition.
 * Every branch keeps `+faststart`-compatible, browser-playable H.264.
 */
export function encoderArgs(encoder: EncoderChoice, opts: EncodeOptions): string[] {
  const bitrate = `${opts.bitrateKbps ?? bitrateForHeight(opts.height)}k`;
  const crf = opts.crf ?? 23;

  switch (encoder.id) {
    case "libx264":
      return [
        "-c:v", "libx264",
        "-preset", opts.preset ?? "veryfast",
        "-crf", String(crf),
        "-profile:v", "main",
        "-level", "4.1",
      ];
    case "libopenh264":
      // OpenH264 has no CRF control; it is driven by a target bitrate.
      return [
        "-c:v", "libopenh264",
        "-b:v", bitrate,
        "-profile:v", "main",
        "-rc_mode", "bitrate",
        "-allow_skip_frames", "true",
      ];
    case "h264_nvenc":
      return [
        "-c:v", "h264_nvenc",
        "-preset", opts.preset ?? "p4",
        "-rc", "vbr",
        "-cq", String(crf),
        "-b:v", bitrate,
      ];
    case "h264_vaapi":
      return ["-c:v", "h264_vaapi", "-b:v", bitrate];
    default: {
      const never: never = encoder.id;
      throw new AppError("INTERNAL", `Unhandled encoder ${String(never)}.`);
    }
  }
}

/**
 * Any extra global FFmpeg arguments this encoder needs *before* `-i`, plus the
 * matching filter-chain prefix that uploads frames to the GPU.
 */
export function encoderPrelude(encoder: EncoderChoice): { global: string[]; vfPrefix: string } {
  if (encoder.id === "h264_vaapi") {
    const device = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
    return { global: ["-vaapi_device", device], vfPrefix: "format=nv12,hwupload," };
  }
  return { global: [], vfPrefix: "" };
}

/** True when the encoder accepts `-profile:v main` / `-level`. */
export function supportsLevelFlag(encoder: EncoderChoice): boolean {
  return encoder.id === "libx264" || encoder.id === "h264_nvenc";
}
