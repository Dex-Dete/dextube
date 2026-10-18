/**
 * Generates genuine multi-rendition test data for the player's quality selector.
 *
 *   npm run make:renditions                 # every READY video, idempotent
 *   npm run make:renditions -- --limit 3    # only the first 3 videos
 *   npm run make:renditions -- --force      # re-encode even valid renditions
 *
 * For each READY, non-deleted video that has a source (or playback) file, the
 * real pixel height is probed with ffprobe. Every height in `TRANSCODE_LADDER`
 * (see `src/lib/config.ts`) that is *strictly lower* than that source height is
 * transcoded to a real MP4 through the storage abstraction at
 * `videos/<id>/renditions/<height>p.mp4`, then recorded as a PROGRESSIVE
 * `VideoAsset` row carrying the file's real width, height and byte size.
 *
 * Guarantees:
 *   * Never upscales: a rendition is only produced when `height < sourceHeight`.
 *   * Never invents a row: the file is stat'ed and probed after encoding, and a
 *     row is written only when the file exists with a non-zero size.
 *   * Idempotent: a rendition whose file and DB row already exist is left alone
 *     (no re-encode). `--force` redoes every rendition.
 *   * Fails loudly: an FFmpeg failure names the video, the target key and the
 *     error, and the process exits non-zero.
 *
 * The FFmpeg work is delegated to `src/server/media/ffmpeg.ts` (which negotiates
 * `libopenh264` on this box) and the files are written through `MediaStorage`,
 * exactly as the upload pipeline does for uploads.
 */
import { loadEnvFile } from "../src/lib/load-env";

// `src/lib/db` and `src/server/**` read process.env at import time, so `.env`
// must be loaded before they are imported. Everything below is imported
// dynamically inside `main` for that reason (same pattern as scripts/doctor.ts).
loadEnvFile();

interface Options {
  force: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { force: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--limit") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got "${raw ?? ""}".`);
      }
      opts.limit = n;
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got "${arg.slice("--limit=".length)}".`);
      }
      opts.limit = n;
    } else {
      throw new Error(`Unknown argument "${arg}". Usage: make-renditions [--force] [--limit <n>]`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const { prisma } = await import("../src/lib/db");
  const { getConfig } = await import("../src/lib/config");
  const { getStorage, buildKey } = await import("../src/server/storage");
  const { probeMedia, transcodeToMp4 } = await import("../src/server/media/ffmpeg");

  const storage = getStorage();
  const ladder = getConfig().media.transcodeLadder; // already sorted tallest-first

  const videos = await prisma.video.findMany({
    where: { status: "READY", deletedAt: null },
    orderBy: { createdAt: "asc" },
    ...(opts.limit ? { take: opts.limit } : {}),
    select: {
      id: true,
      title: true,
      originalKey: true,
      playbackKey: true,
      width: true,
      height: true,
    },
  });

  console.log("DEXTube rendition generator");
  console.log(`  ladder: ${ladder.length ? ladder.map((h) => `${h}p`).join(", ") : "(empty)"}`);
  console.log(
    `  videos: ${videos.length}${opts.limit ? ` (limited to ${opts.limit})` : ""}` +
      `${opts.force ? "  [--force: re-encoding everything]" : ""}`,
  );
  console.log("");

  if (ladder.length === 0) {
    console.log("TRANSCODE_LADDER is empty — nothing to do.");
    return;
  }

  const failures: string[] = [];
  let produced = 0;
  let cached = 0;
  const runStarted = Date.now();

  for (const video of videos) {
    const started = Date.now();
    const sourceKey = video.originalKey ?? video.playbackKey;

    if (!sourceKey) {
      console.log(`  – ${video.id}  "${video.title}"  (no source/playback file)  0ms`);
      continue;
    }

    try {
      const sourcePath = storage.localPath(sourceKey);
      const probe = await probeMedia(sourcePath);
      const sourceHeight = probe.height;

      if (!sourceHeight) {
        console.log(`  – ${video.id}  "${video.title}"  (probed height unknown)  ${Date.now() - started}ms`);
        continue;
      }

      const targets = ladder.filter((height) => height < sourceHeight);
      if (targets.length === 0) {
        console.log(
          `  – ${video.id}  "${video.title}"  src=${sourceHeight}p  (no ladder height below source)  ${Date.now() - started}ms`,
        );
        continue;
      }

      const parts: string[] = [];
      for (const height of targets) {
        const key = buildKey("videos", video.id, "renditions", `${height}p.mp4`);
        const target = storage.localPath(key);

        const existingRow = await prisma.videoAsset.findFirst({
          where: { videoId: video.id, storageKey: key },
          select: { id: true },
        });
        const existingStat = await storage.stat(key);
        const alreadyValid = !opts.force && Boolean(existingRow) && existingStat !== null && existingStat.size > 0;

        if (alreadyValid) {
          parts.push(`${height}p=${existingStat!.size}B(cached)`);
          cached++;
          continue;
        }

        // A stale row without a valid file (or the reverse) is repaired below.
        try {
          await transcodeToMp4(sourcePath, target, {
            height,
            hasAudio: probe.hasAudio,
            crf: 24,
            preset: "veryfast",
          });
        } catch (error) {
          throw new Error(
            `FFmpeg failed for ${video.id} (${video.title}) at ${height}p → ${key}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }

        // Assert the file is real before recording it — a row must never exist
        // for bytes that do not.
        const stat = await storage.stat(key);
        if (!stat || stat.size === 0) {
          throw new Error(`Encoded ${key} but the resulting file is missing or empty.`);
        }

        const out = await probeMedia(target);
        const label = `${height}p`;
        const data = {
          kind: "PROGRESSIVE" as const,
          label,
          mimeType: "video/mp4",
          width: out.width,
          height: out.height,
          bitrateKbps: out.bitrate ? Math.round(out.bitrate / 1000) : null,
          sizeBytes: BigInt(stat.size),
        };

        if (existingRow) {
          await prisma.videoAsset.update({ where: { id: existingRow.id }, data });
        } else {
          await prisma.videoAsset.create({ data: { videoId: video.id, storageKey: key, ...data } });
        }

        parts.push(`${height}p=${stat.size}B`);
        produced++;
      }

      console.log(
        `  ✓ ${video.id}  "${video.title}"  src=${sourceHeight}p  →  ${parts.join(", ")}  ${Date.now() - started}ms`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(detail);
      console.error(`  ✗ ${video.id}  "${video.title}"  ${detail}`);
    }
  }

  const elapsed = Date.now() - runStarted;
  console.log("");
  console.log(
    `Done in ${elapsed}ms: ${produced} rendition(s) encoded, ${cached} reused, ` +
      `${failures.length} failure(s) across ${videos.length} video(s).`,
  );

  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Rendition generation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../src/lib/db");
    await prisma.$disconnect();
  });
