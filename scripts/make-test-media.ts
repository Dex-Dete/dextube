/**
 * Generates small, original DEXTube test media with FFmpeg.
 *
 *   npm run make:testmedia
 *
 * Everything here is synthesised (`testsrc2` pattern + a sine tone), so there
 * is no copyrighted material anywhere in the repository or the test suite.
 * Output goes to `storage/test-media/` which is git-ignored.
 *
 * Files produced:
 *   landscape-10s.mp4  640x360, 10s  – a normal long-form video
 *   portrait-8s.mp4    360x640, 8s   – qualifies as a Short (9:16, < 3 min)
 *   tiny-2s.mp4        320x180, 2s   – fast fixture for automated tests
 *   silent-3s.mp4      320x180, 3s   – no audio track (audio-optional path)
 *   poster.jpg                       – avatar/banner upload fixture
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const TEST_MEDIA_DIR = path.resolve(process.cwd(), "storage/test-media");
const OUT_DIR = TEST_MEDIA_DIR;

interface Spec {
  name: string;
  width: number;
  height: number;
  seconds: number;
  audio: boolean;
  fps: number;
}

const SPECS: Spec[] = [
  { name: "landscape-10s.mp4", width: 640, height: 360, seconds: 10, audio: true, fps: 24 },
  { name: "portrait-8s.mp4", width: 360, height: 640, seconds: 8, audio: true, fps: 24 },
  { name: "tiny-2s.mp4", width: 320, height: 180, seconds: 2, audio: true, fps: 15 },
  { name: "silent-3s.mp4", width: 320, height: 180, seconds: 3, audio: false, fps: 15 },
];

/**
 * Picks an H.264 encoder this FFmpeg build actually provides.
 *
 * Fedora's `ffmpeg-free` ships `libopenh264` but not `libx264`; RPM Fusion's
 * `ffmpeg` ships both. Rather than assuming, ask the binary. This mirrors what
 * the application does at runtime (`src/server/media/encoders.ts`) so the
 * fixtures are encoded the same way the pipeline will encode uploads.
 */
async function pickVideoArgs(bitrateKbps: number): Promise<string[]> {
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-encoders"], { timeout: 20_000 });
  if (/\slibx264\s/.test(stdout)) {
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"];
  }
  if (/\slibopenh264\s/.test(stdout)) {
    return ["-c:v", "libopenh264", "-b:v", `${bitrateKbps}k`, "-profile:v", "main", "-pix_fmt", "yuv420p"];
  }
  throw new Error(
    "No H.264 encoder found (need libx264 or libopenh264). Install ffmpeg-free or RPM Fusion ffmpeg.",
  );
}

async function generate(spec: Spec): Promise<string> {
  const target = path.join(OUT_DIR, spec.name);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.seconds}`,
    ...(spec.audio
      ? [
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=420:sample_rate=48000:duration=${spec.seconds}`,
          "-c:a",
          "aac",
          "-b:a",
          "96k",
        ]
      : ["-an"]),
    ...(await pickVideoArgs(spec.width * spec.height > 200_000 ? 900 : 400)),
    "-movflags",
    "+faststart",
    "-shortest",
    target,
  ];
  await run(FFMPEG, args, { timeout: 120_000 });
  const stat = await fs.stat(target);
  return `${target} (${(stat.size / 1024).toFixed(0)} KB)`;
}

async function generatePoster(): Promise<string> {
  const target = path.join(OUT_DIR, "poster.jpg");
  await run(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x640:rate=1:duration=1", "-frames:v", "1", target],
    { timeout: 60_000 },
  );
  return target;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`Generating test media in ${OUT_DIR}`);
  for (const spec of SPECS) {
    process.stdout.write(`  ${spec.name} … `);
    try {
      console.log(await generate(spec));
    } catch (error) {
      console.error("failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
  console.log(await generatePoster());
  console.log("Done. These files are synthesised patterns and contain no third-party content.");
}

/**
 * Absolute paths of the fixture files, generating any that are missing.
 *
 * Exported so `prisma/seed.ts` can build playable demo videos that reuse the
 * same synthesised clips the test suite uses — no copyrighted media is ever
 * shipped or fetched.
 */
export async function ensureTestMedia(): Promise<Record<string, string>> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outputs: Record<string, string> = {};
  for (const spec of SPECS) {
    const target = path.join(OUT_DIR, spec.name);
    try {
      await fs.access(target);
    } catch {
      await generate(spec);
    }
    outputs[spec.name] = target;
  }
  const poster = path.join(OUT_DIR, "poster.jpg");
  try {
    await fs.access(poster);
  } catch {
    await generatePoster();
  }
  outputs["poster.jpg"] = poster;
  return outputs;
}

// Only generate when run directly (`npm run make:testmedia`); importing this
// module (e.g. from the seed) must not have side effects.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) void main();
