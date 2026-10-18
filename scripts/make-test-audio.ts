/**
 * Generates small, original DEXTube test audio with FFmpeg.
 *
 *   npm run make:testaudio
 *
 * Every file here is **synthesised by this script** from FFmpeg's `sine` and
 * `anoisesrc` lavfi sources. There is no copyrighted catalogue to ship, so
 * nothing is downloaded or bundled: the fixtures are computer-generated tones
 * and noise, which is why the seed can honestly label them `CC0-1.0` and name
 * this script as the generator.
 *
 * Output goes to `storage/test-audio/`, which is git-ignored.
 *
 * Files produced (all AAC audio in an MP4/M4A container — broadly playable):
 *   tone-a440-3s.m4a    440 Hz (concert A) sine tone, 3 s
 *   tone-c262-5s.m4a    261.63 Hz (middle C) sine tone, 5 s
 *   noise-2s.m4a        white-noise burst, 2 s
 *
 * The `ensureTestAudio()` export mirrors `make-test-media.ts`: it generates any
 * missing fixture and returns absolute paths, so `prisma/seed.ts` can seed real,
 * playable tracks that reuse exactly the bytes the generator produces.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const TEST_AUDIO_DIR = path.resolve(process.cwd(), "storage/test-audio");
const OUT_DIR = TEST_AUDIO_DIR;

interface AudioSpec {
  name: string;
  /** A lavfi source expression passed to `-f lavfi -i`. */
  source: string;
  /** Human-readable description shown in the generator log. */
  label: string;
}

const SPECS: AudioSpec[] = [
  {
    name: "tone-a440-3s.m4a",
    source: "sine=frequency=440:sample_rate=44100:duration=3",
    label: "440 Hz sine tone, 3 s",
  },
  {
    name: "tone-c262-5s.m4a",
    source: "sine=frequency=261.63:sample_rate=44100:duration=5",
    label: "261.63 Hz (middle C) sine tone, 5 s",
  },
  {
    name: "noise-2s.m4a",
    source: "anoisesrc=duration=2:sample_rate=44100:amplitude=0.25:color=white",
    label: "white-noise burst, 2 s",
  },
];

async function generate(spec: AudioSpec): Promise<string> {
  const target = path.join(OUT_DIR, spec.name);
  await run(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      spec.source,
      // AAC in M4A: the encoder is part of FFmpeg itself (no libmp3lame
      // requirement), and every current browser plays it.
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      target,
    ],
    { timeout: 60_000 },
  );
  const stat = await fs.stat(target);
  return `${target} (${(stat.size / 1024).toFixed(0)} KB)`;
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`Generating synthesised test audio in ${OUT_DIR}`);
  for (const spec of SPECS) {
    process.stdout.write(`  ${spec.name} — ${spec.label} … `);
    try {
      console.log(await generate(spec));
    } catch (error) {
      console.error("failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
  console.log("Done. These files are computer-generated and contain no third-party content.");
}

/**
 * Absolute paths of the fixture files, generating any that are missing.
 *
 * Exported so `prisma/seed.ts` can seed playable demo tracks that are byte-for
 * -byte the same synthesised clips the generator produces.
 */
export async function ensureTestAudio(): Promise<Record<string, string>> {
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
  return outputs;
}

// Only generate when run directly (`npm run make:testaudio`); importing this
// module (e.g. from the seed) must not have side effects.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) void main();
