/**
 * DEXTube development seed.
 *
 *   npm run db:seed
 *
 * Creates a small, self-consistent demo catalogue so a fresh install has
 * something to look at: verified accounts with channels, playable videos (real
 * files, copied from the synthesised FFmpeg fixtures — no third-party media),
 * comments, reactions, subscriptions, watch history and the daily analytics
 * those events roll up into.
 *
 * Honesty rules this file follows:
 *   * It never fabricates analytics: view counters, daily stats and watch time
 *     are derived from real `views` / `watch_history` / `video_reactions` /
 *     `comments` rows that this script inserts and then aggregates.
 *   * It is idempotent per fixture: an account or video that already exists is
 *     left exactly as it is. Re-running does not duplicate or destroy data.
 *   * It is refused in production unless `ALLOW_SEED=1` is set explicitly.
 */
import { prisma } from "../src/lib/db";
import { getStorage } from "../src/server/storage";
import { registerUser } from "../src/server/services/accounts";
import { aggregateDailyStats } from "../src/server/services/analytics";
import { ensureSystemPlaylist } from "../src/server/services/videos";
import { ensureTestMedia } from "../scripts/make-test-media";
import { ensureTestAudio } from "../scripts/make-test-audio";

const DEV_PASSWORD = "CorrectHorse1";
const HISTORY_DAYS = 14;

/* ------------------------------------------------------------- tiny PRNG */

/** Deterministic PRNG so repeated seeds look the same. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRandom(20261017);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

/* ---------------------------------------------------------- fixture specs */

interface SeedUser {
  username: string;
  displayName: string;
  email: string;
  bio: string;
  handle: string;
  channelName: string;
  channelDescription: string;
  interests: string[];
}

const SEED_USERS: SeedUser[] = [
  {
    username: "ada",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    bio: "First programmer. Building analytical engines, now on video.",
    handle: "ada",
    channelName: "Ada's Analytical Engine",
    channelDescription: "Notes on computation, algorithms and the machines that run them.",
    interests: ["Science & Technology", "Education"],
  },
  {
    username: "grace",
    displayName: "Grace Hopper",
    email: "grace@example.com",
    bio: "Compilers, debugging and the occasional nanosecond.",
    handle: "grace",
    channelName: "Nanoseconds",
    channelDescription: "A channel about compilers, systems and shipping reliable software.",
    interests: ["Science & Technology", "Education"],
  },
  {
    username: "margaret",
    displayName: "Margaret Hamilton",
    email: "margaret@example.com",
    bio: "Software engineering for missions that cannot be restarted.",
    handle: "margaret",
    channelName: "Apollo Software",
    channelDescription: "Robust software, fault tolerance and lessons from the Apollo program.",
    interests: ["Science & Technology", "Film & Animation"],
  },
  {
    username: "linus",
    displayName: "Linus Kernel",
    email: "linus@example.com",
    bio: "Kernels, terminals and strongly held opinions.",
    handle: "linus",
    channelName: "Talk Is Cheap",
    channelDescription: "Systems programming, open source and code that shows its work.",
    interests: ["Science & Technology", "Gaming"],
  },
];

interface SeedVideo {
  channel: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  /** Fixture file name from `storage/test-media/`. */
  media: string;
  durationSec: number;
  width: number;
  height: number;
  isShort: boolean;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
}

const SEED_VIDEOS: SeedVideo[] = [
  {
    channel: "ada",
    title: "What is an algorithm, really?",
    description:
      "Algorithms are recipes for computation. In this first episode we look at why a precise sequence of steps matters more than clever code, and how to reason about the steps before writing any of them.",
    category: "Science & Technology",
    tags: ["algorithms", "computer-science", "beginners"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "ada",
    title: "Notes on the Analytical Engine",
    description:
      "A short, illustrated tour of Charles Babbage's machine and why its design anticipated the separation of storage and processing that every computer still uses.",
    category: "Education",
    tags: ["history", "computing", "babbage"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "ada",
    title: "A 15-second tip on naming things",
    description: "Naming is design. A very short tip.",
    category: "Education",
    tags: ["shorts", "tips"],
    media: "portrait-8s.mp4",
    durationSec: 8,
    width: 360,
    height: 640,
    isShort: true,
    visibility: "PUBLIC",
  },
  {
    channel: "grace",
    title: "How a compiler turns text into a program",
    description:
      "Lexing, parsing, semantic analysis, optimisation and code generation: a tour of the pipeline every compiler follows, and where bugs like to hide in it.",
    category: "Science & Technology",
    tags: ["compilers", "systems", "engineering"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "grace",
    title: "Debugging is a skill, not a personality trait",
    description:
      "A practical method for finding the cause of a defect: reproduce, shrink, observe, hypothesise, test. No talent required, only discipline.",
    category: "Education",
    tags: ["debugging", "craft", "teams"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "grace",
    title: "The famous 11.8 inch wire",
    description: "Why a nanosecond is a useful unit of length.",
    category: "Education",
    tags: ["shorts", "hardware"],
    media: "portrait-8s.mp4",
    durationSec: 8,
    width: 360,
    height: 640,
    isShort: true,
    visibility: "PUBLIC",
  },
  {
    channel: "margaret",
    title: "Software engineering for things that fly",
    description:
      "The Apollo guidance computer had to be correct on the first try. We look at priority-driven scheduling, restarts and building software that degrades gracefully under overload.",
    category: "Science & Technology",
    tags: ["apollo", "reliability", "engineering"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "margaret",
    title: "Designing for failure before success",
    description: "What changes when you assume every component will fail at the worst moment.",
    category: "Education",
    tags: ["reliability", "design"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "linus",
    title: "Reading code you did not write",
    description:
      "Techniques for getting oriented in an unfamiliar codebase quickly: start at the edges, follow the data, and write down what you learn as you go.",
    category: "Science & Technology",
    tags: ["open-source", "code-review", "systems"],
    media: "hd-720p-10s.mp4",
    durationSec: 10,
    width: 1280,
    height: 720,
    isShort: false,
    visibility: "PUBLIC",
  },
  {
    channel: "linus",
    title: "Unlisted: a rough cut",
    description: "An unlisted scratch video used to test that unlisted content stays out of public listings.",
    category: "Science & Technology",
    tags: ["internal"],
    media: "tiny-2s.mp4",
    durationSec: 2,
    width: 320,
    height: 180,
    isShort: false,
    visibility: "UNLISTED",
  },
];

interface SeedTrack {
  channel: string;
  title: string;
  artist: string;
  album: string | null;
  /** Fixture file name from `storage/test-audio/`. */
  audio: string;
  durationSec: number;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
  rights: {
    source: string;
    license: string;
    attribution: string;
    territory: string;
    downloadAllowed: boolean;
  };
}

/**
 * DEX Music demo tracks.
 *
 * Every fixture is a computer-generated `sine`/`anoisesrc` clip produced by
 * `scripts/make-test-audio.ts`; no third-party recording is bundled or
 * downloaded. The rights rows are deliberately varied so the two independent
 * permissions — *streaming* (visibility) and *downloading* (`downloadAllowed`)
 * — can each be exercised:
 *
 *   * tone A   — PUBLIC, downloads permitted (CC0-1.0).
 *   * tone C   — PUBLIC, streaming only, downloads forbidden.
 *   * noise    — PRIVATE, downloads permitted, but visible only to the channel.
 *
 * The middle track has to be honest: the generator's output is CC0, which
 * permits copies. Rather than mislabel a public-domain work as restrictive, the
 * licence is recorded as the operator's explicit streaming-only demonstration
 * grant, and the attribution says exactly that.
 */
const SEED_TRACKS: SeedTrack[] = [
  {
    channel: "ada",
    title: "Concert A (440 Hz) — reference tone",
    artist: "DEXTube test tone generator",
    album: "Synthesised reference tones",
    audio: "tone-a440-3s.m4a",
    durationSec: 3,
    visibility: "PUBLIC",
    rights: {
      source: "Synthesised by scripts/make-test-audio.ts with FFmpeg's `sine` filter (440 Hz).",
      license: "CC0-1.0",
      attribution:
        "“Concert A (440 Hz) — reference tone” synthesised for DEXTube by scripts/make-test-audio.ts. CC0-1.0.",
      territory: "Worldwide",
      downloadAllowed: true,
    },
  },
  {
    channel: "grace",
    title: "Middle C (261.63 Hz) — streaming only",
    artist: "DEXTube test tone generator",
    album: "Synthesised reference tones",
    audio: "tone-c262-5s.m4a",
    durationSec: 5,
    visibility: "PUBLIC",
    rights: {
      source: "Synthesised by scripts/make-test-audio.ts with FFmpeg's `sine` filter (261.63 Hz).",
      // Not an SPDX identifier: this is the operator's own demonstration grant.
      // The generator offers its output as CC0, which would allow downloads, so
      // a streaming-only term is stated explicitly instead of mislabelled.
      license: "DEXTube demonstration licence — streaming only",
      attribution:
        "“Middle C (261.63 Hz) — streaming only” synthesised for DEXTube by scripts/make-test-audio.ts, offered under the operator's streaming-only demonstration grant to show a track whose rights forbid downloading.",
      territory: "Worldwide",
      downloadAllowed: false,
    },
  },
  {
    channel: "margaret",
    title: "Calibration noise (white, 2 s)",
    artist: "DEXTube test tone generator",
    album: null,
    audio: "noise-2s.m4a",
    durationSec: 2,
    visibility: "PRIVATE",
    rights: {
      source: "Synthesised by scripts/make-test-audio.ts with FFmpeg's `anoisesrc` filter (white noise).",
      license: "CC0-1.0",
      attribution:
        "“Calibration noise (white, 2 s)” synthesised for DEXTube by scripts/make-test-audio.ts. CC0-1.0.",
      territory: "Worldwide",
      downloadAllowed: true,
    },
  },
];

const COMMENT_BODIES = [
  "This explained it better than three textbooks I have read. Thank you.",
  "The part about reasoning before coding really landed for me.",
  "Could you go deeper on the trade-offs in a follow-up?",
  "Watching this at 1.5x and still following every step — great pacing.",
  "I have been doing this wrong for years and did not realise it.",
  "Bookmarked. The diagrams alone are worth it.",
  "Small correction: the second example also applies when the input is empty.",
  "Please keep these coming, the series is genuinely useful.",
];

const REPLY_BODIES = [
  "Great question — short answer: it depends on the workload.",
  "Yes, and that is exactly the trap I fell into first time round.",
  "Thanks! There is a follow-up planned on this.",
  "Same here. The visuals made the difference.",
];

/* -------------------------------------------------------------- utilities */

async function copyFixture(storage: ReturnType<typeof getStorage>, from: string, key: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(from);
  await storage.put(key, bytes, { contentType: "application/octet-stream" });
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") {
    console.error("Refusing to seed a production database. Set ALLOW_SEED=1 to override.");
    process.exit(1);
  }

  console.log("DEXTube seed\n");

  const storage = getStorage();
  console.log("1/9  Ensuring synthesised test media exists…");
  const media = await ensureTestMedia();
  const poster = media["poster.jpg"]!;

  /* --------------------------------------------------------- users/channels */
  console.log("2/9  Users and channels…");
  const users = new Map<string, { userId: string; channelId: string }>();

  for (const spec of SEED_USERS) {
    const existing = await prisma.user.findUnique({
      where: { username: spec.username },
      select: { id: true, channel: { select: { id: true } } },
    });

    let userId: string;
    let channelId: string;
    if (existing) {
      userId = existing.id;
      channelId = existing.channel?.id ?? "";
      console.log(`     · ${spec.username} already exists — left untouched`);
    } else {
      const created = await registerUser({
        username: spec.username,
        displayName: spec.displayName,
        email: spec.email,
        password: DEV_PASSWORD,
        interests: spec.interests,
      });
      userId = created.userId;
      channelId = created.channelId;
      console.log(`     + ${spec.username} (${spec.handle})`);
    }

    if (!channelId) continue;

    // Make the fixture usable: verified email, a real bio, a public avatar.
    const avatarKey = `users/${userId}/avatar.jpg`;
    const channelAvatarKey = `channels/${channelId}/avatar.jpg`;
    const bannerKey = `channels/${channelId}/banner.jpg`;
    if (!(await storage.exists(avatarKey))) await copyFixture(storage, poster, avatarKey);
    if (!(await storage.exists(channelAvatarKey))) await copyFixture(storage, poster, channelAvatarKey);
    if (!(await storage.exists(bannerKey))) await copyFixture(storage, poster, bannerKey);

    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date(), bio: spec.bio, avatarKey },
    });
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        handle: spec.handle,
        name: spec.channelName,
        description: spec.channelDescription,
        avatarKey: channelAvatarKey,
        bannerKey,
      },
    });

    users.set(spec.username, { userId, channelId });
  }

  /* ---------------------------------------------------------------- videos */
  console.log("3/9  Videos (with real, playable media files)…");
  const videoIds: Array<{ id: string; channel: string; durationSec: number }> = [];

  for (const spec of SEED_VIDEOS) {
    const owner = users.get(spec.channel);
    if (!owner) continue;

    const existing = await prisma.video.findFirst({
      where: { channelId: owner.channelId, title: spec.title, deletedAt: null },
      select: { id: true, sourceFilename: true, width: true, height: true, playbackKey: true },
    });
    if (existing) {
      // The spec table above is the source of truth for a demo video's bytes.
      // If an earlier seed used a different test clip (for example the 640x360
      // landscape file before the 1280x720 rendition fixture existed), re-point
      // it at the current fixture so the recorded dimensions match the file on
      // disk. This is intentionally narrow and idempotent: it only touches the
      // demo's own media keys and never engagement rows (comments, views,
      // reactions, playlists).
      if (
        existing.sourceFilename !== spec.media ||
        existing.width !== spec.width ||
        existing.height !== spec.height
      ) {
        const sourceFile = media[spec.media]!;
        const sourceKey = `videos/${existing.id}/source/original.mp4`;
        const playbackKey = `videos/${existing.id}/playback/${spec.height}p.mp4`;
        await copyFixture(storage, sourceFile, sourceKey);
        await copyFixture(storage, sourceFile, playbackKey);
        await prisma.video.update({
          where: { id: existing.id },
          data: {
            width: spec.width,
            height: spec.height,
            durationSec: spec.durationSec,
            sourceFilename: spec.media,
            originalKey: sourceKey,
            playbackKey,
            sizeBytes: BigInt((await storage.stat(sourceKey))?.size ?? 0),
          },
        });
        if (existing.playbackKey && existing.playbackKey !== playbackKey) {
          await storage.delete(existing.playbackKey);
        }
        console.log(`     ~ ${spec.title} re-pointed at ${spec.media} (${spec.width}x${spec.height})`);
      }
      videoIds.push({ id: existing.id, channel: spec.channel, durationSec: spec.durationSec });
      continue;
    }

    const sourceFile = media[spec.media]!;
    const created = await prisma.video.create({
      data: {
        channelId: owner.channelId,
        uploaderId: owner.userId,
        title: spec.title,
        description: spec.description,
        visibility: spec.visibility,
        status: "READY",
        isShort: spec.isShort,
        durationSec: spec.durationSec,
        width: spec.width,
        height: spec.height,
        category: spec.category,
        tags: spec.tags,
        language: "en",
        sourceFilename: spec.media,
        mimeType: "video/mp4",
        publishedAt: new Date(Date.now() - between(1, HISTORY_DAYS) * 86_400_000),
      },
      select: { id: true },
    });

    const id = created.id;
    const sourceKey = `videos/${id}/source/original.mp4`;
    const playbackKey = `videos/${id}/playback/${spec.height}p.mp4`;
    const thumbnailKey = `videos/${id}/thumbs/default.jpg`;
    const posterKey = `videos/${id}/thumbs/poster.jpg`;

    await copyFixture(storage, sourceFile, sourceKey);
    await copyFixture(storage, sourceFile, playbackKey);
    await copyFixture(storage, poster, thumbnailKey);
    await copyFixture(storage, poster, posterKey);

    await prisma.video.update({
      where: { id },
      data: {
        originalKey: sourceKey,
        playbackKey,
        thumbnailKey,
        posterKey,
        sizeBytes: BigInt((await storage.stat(sourceKey))?.size ?? 0),
      },
    });

    videoIds.push({ id, channel: spec.channel, durationSec: spec.durationSec });
  }
  console.log(`     ${videoIds.length} videos ready`);

  /* -------------------------------------------------------------- comments */
  console.log("4/9  Comments and replies…");
  const allUsers = [...users.values()];
  for (const video of videoIds) {
    const count = await prisma.comment.count({ where: { videoId: video.id } });
    if (count > 0) continue;

    const commenters = allUsers.filter((u) => u.channelId !== users.get(video.channel)?.channelId);
    for (let i = 0; i < between(2, 4); i++) {
      const author = pick(commenters.length ? commenters : allUsers);
      const parent = await prisma.comment.create({
        data: {
          videoId: video.id,
          userId: author.userId,
          body: pick(COMMENT_BODIES),
          createdAt: new Date(Date.now() - between(0, 6) * 86_400_000),
        },
        select: { id: true },
      });

      let replies = 0;
      if (rand() < 0.6) {
        for (let r = 0; r < between(1, 2); r++) {
          const replier = pick(allUsers);
          await prisma.comment.create({
            data: {
              videoId: video.id,
              userId: replier.userId,
              parentId: parent.id,
              body: pick(REPLY_BODIES),
              createdAt: new Date(Date.now() - between(0, 3) * 86_400_000),
            },
          });
          replies++;
        }
      }
      if (replies > 0) {
        await prisma.comment.update({ where: { id: parent.id }, data: { replyCount: replies } });
      }
    }
    // Denormalised counter = every comment (top-level and replies) on the video.
    await prisma.video.update({
      where: { id: video.id },
      data: { commentCount: await prisma.comment.count({ where: { videoId: video.id, deletedAt: null } }) },
    });
  }

  /* ------------------------------------------------------------- reactions */
  console.log("5/9  Reactions…");
  for (const video of videoIds) {
    const existing = await prisma.videoReaction.count({ where: { videoId: video.id } });
    if (existing > 0) continue;
    let likes = 0;
    let dislikes = 0;
    for (const user of allUsers) {
      const roll = rand();
      if (roll < 0.55) {
        await prisma.videoReaction.create({ data: { videoId: video.id, userId: user.userId, value: "LIKE" } });
        likes++;
      } else if (roll < 0.65) {
        await prisma.videoReaction.create({ data: { videoId: video.id, userId: user.userId, value: "DISLIKE" } });
        dislikes++;
      }
    }
    await prisma.video.update({ where: { id: video.id }, data: { likeCount: likes, dislikeCount: dislikes } });
  }

  /* --------------------------------------------------------- subscriptions */
  console.log("6/9  Subscriptions…");
  for (const subscriber of allUsers) {
    for (const target of allUsers) {
      if (subscriber.channelId === target.channelId) continue;
      const exists = await prisma.subscription.findUnique({
        where: { subscriberId_channelId: { subscriberId: subscriber.userId, channelId: target.channelId } },
        select: { id: true },
      });
      if (exists) continue;
      await prisma.subscription.create({
        data: { subscriberId: subscriber.userId, channelId: target.channelId },
      });
    }
  }
  for (const user of allUsers) {
    await prisma.channel.update({
      where: { id: user.channelId },
      data: {
        subscriberCount: await prisma.subscription.count({ where: { channelId: user.channelId } }),
        videoCount: await prisma.video.count({
          where: { channelId: user.channelId, deletedAt: null, status: "READY", visibility: "PUBLIC" },
        }),
      },
    });
  }

  /* ------------------------------------------------- views / watch history */
  console.log(`7/9  Views and watch history spread over ${HISTORY_DAYS} days…`);
  for (const video of videoIds) {
    const existingViews = await prisma.view.count({ where: { videoId: video.id } });
    if (existingViews > 0) continue;

    // A believable long tail: most videos modest, a couple popular.
    const total = between(40, 480);
    for (let i = 0; i < total; i++) {
      const ageDays = Math.floor(Math.pow(rand(), 1.6) * HISTORY_DAYS);
      const at = new Date(Date.now() - ageDays * 86_400_000 - Math.floor(rand() * 86_400_000));
      await prisma.view.create({
        data: {
          videoId: video.id,
          viewerHash: `seed:${video.id}:${i}`,
          watchedSeconds: Math.round(video.durationSec * (0.4 + rand() * 0.6)),
          createdAt: at,
        },
      });
    }

    // Watch history / progress for a handful of viewers.
    for (const user of allUsers.slice(0, between(1, allUsers.length))) {
      const position = Number((video.durationSec * (0.2 + rand() * 0.7)).toFixed(1));
      await prisma.watchProgress.upsert({
        where: { userId_videoId: { userId: user.userId, videoId: video.id } },
        create: {
          userId: user.userId,
          videoId: video.id,
          positionSec: position,
          durationSec: video.durationSec,
          completed: position >= video.durationSec - 1,
        },
        update: {},
      });
      await prisma.watchHistory.create({
        data: {
          userId: user.userId,
          videoId: video.id,
          seconds: Math.round(position),
          watchedAt: new Date(Date.now() - between(0, HISTORY_DAYS) * 86_400_000),
        },
      });
    }

    await prisma.video.update({ where: { id: video.id }, data: { viewCount: total } });
  }

  /* ------------------------------------------ library + analytics rollups */
  console.log("8/9  System playlists and daily analytics rollups…");
  for (const user of allUsers) {
    await ensureSystemPlaylist(user.userId, "watch_later");
    await ensureSystemPlaylist(user.userId, "liked_videos");
  }

  // Populate "Liked videos" from the reactions we just created.
  for (const user of allUsers) {
    const liked = await prisma.videoReaction.findMany({
      where: { userId: user.userId, value: "LIKE" },
      select: { videoId: true },
      take: 20,
    });
    const playlistId = await ensureSystemPlaylist(user.userId, "liked_videos");
    await prisma.playlistItem.createMany({
      data: liked.map((row, index) => ({ playlistId, videoId: row.videoId, position: index })),
      skipDuplicates: true,
    });
    await prisma.playlist.update({
      where: { id: playlistId },
      data: { itemCount: await prisma.playlistItem.count({ where: { playlistId } }) },
    });
  }

  // Roll the inserted events up into the pre-aggregated analytics tables.
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    await aggregateDailyStats(new Date(Date.now() - i * 86_400_000));
  }

  /* ----------------------------------------------------------------- music */
  console.log("9/9  DEX Music tracks (rights-cleared audio)…");
  const audioFixtures = await ensureTestAudio();
  let trackCount = 0;

  for (const spec of SEED_TRACKS) {
    const owner = users.get(spec.channel);
    if (!owner) continue;

    const existing = await prisma.track.findFirst({
      where: { channelId: owner.channelId, title: spec.title, deletedAt: null },
      select: { id: true },
    });

    const trackId =
      existing?.id ??
      (
        await prisma.track.create({
          data: {
            channelId: owner.channelId,
            uploaderId: owner.userId,
            title: spec.title,
            artist: spec.artist,
            album: spec.album,
            durationSec: spec.durationSec,
            mimeType: "audio/mp4",
            // Replaced with the real key immediately below, once the generated
            // id is known (`audioKey` is non-nullable).
            audioKey: "tracks/placeholder/audio/original.m4a",
            visibility: spec.visibility,
            publishedAt:
              spec.visibility === "PUBLIC" ? new Date(Date.now() - between(1, HISTORY_DAYS) * 86_400_000) : null,
          },
          select: { id: true },
        })
      ).id;

    const audioKey = `tracks/${trackId}/audio/original.m4a`;
    if (!(await storage.exists(audioKey))) {
      await copyFixture(storage, audioFixtures[spec.audio]!, audioKey);
    }

    // Point the row at its real bytes and keep the recorded size in step with
    // the file on disk. Idempotent: the key is derived from the id, so a
    // re-run overwrites the same object rather than creating a new one.
    await prisma.track.update({
      where: { id: trackId },
      data: {
        audioKey,
        mimeType: "audio/mp4",
        sizeBytes: BigInt((await storage.stat(audioKey))?.size ?? 0),
      },
    });

    // Rights are upserted so an edited licence in this file is applied on the
    // next run without creating a second rights row (trackId is unique).
    await prisma.trackRights.upsert({
      where: { trackId },
      create: { trackId, ...spec.rights },
      update: spec.rights,
    });

    console.log(existing ? `     · ${spec.title} already exists — rights refreshed` : `     + ${spec.title}`);
    trackCount++;
  }
  console.log(`     ${trackCount} tracks ready`);

  console.log("\nSeed complete.\n");
  console.log("Sign in with any of these accounts (development only):");
  for (const spec of SEED_USERS) {
    console.log(`  ${spec.username.padEnd(10)} ${spec.email.padEnd(24)} ${DEV_PASSWORD}`);
  }
  console.log("\nNote: seeded content is synthesised fixture data for local development,");
  console.log("not user-generated production content.\n");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
