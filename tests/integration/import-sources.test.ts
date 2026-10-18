/**
 * Integration tests for the import service, against the real database.
 *
 * They deliberately use a **local creator-export fixture** (no network) written
 * under the configured `CREATOR_EXPORT_ROOT`. The manifest carries a real
 * authorization basis, and every fixture is removed again in `afterAll`.
 *
 * Every test uses its own unique `externalId` tag: `dedupeKey` is
 * `kind:externalId` and dedupe is intentionally cross-source, so sharing ids
 * across tests would make later tests look like duplicates of earlier ones.
 *
 * The metadata path is the heart of the service; the authorized-media copy path
 * is additionally exercised here because a creator export can supply bytes
 * without any decoder involvement (the service preserves the export's files
 * verbatim rather than transcoding them).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import { exportRoot } from "@/server/import/creator-export";
import { getStorage } from "@/server/storage";
import { purgeVideoMedia } from "@/server/services/media-process";
import {
  type ImportActor,
  cancelImportSource,
  createImportSource,
  deleteImportSource,
  getImportSource,
  previewImport,
  retryFailedImportItems,
  runImportSource,
} from "@/server/services/import-sources";
import { cleanupFixtures, createTestUser, uniqueSuffix, type TestUser } from "./helpers";

const dbOk = (await checkDatabase()).ok;

const runId = uniqueSuffix();
const fixtureDirs: string[] = [];
const trackedSourceIds: string[] = [];
let user: TestUser;
let actor: ImportActor;
let baselineUsers = 0;
let baselineVideos = 0;

function trackSource(id: string): string {
  trackedSourceIds.push(id);
  return id;
}

const AUTHORIZATION = `Written authorization from the creator, reference #${runId}`;

/* ------------------------------------------------------------ fixtures */

const TINY_VIDEO = Buffer.from("DEXTube import fixture: not real media, preserved verbatim.");
const TINY_IMAGE = Buffer.from("fake-image-bytes");
const TINY_VTT = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");

/** Two entries — one with an authorized source/rendition/subtitle, one without. */
function mainManifest(tag: string) {
  return {
    format: "dextube-creator-export/1",
    authorization: { basis: AUTHORIZATION, grantedBy: "Creator", reference: `ref-${tag}` },
    channel: { title: `ITest Creator ${tag}`, externalChannelId: `itest-chan-${tag}` },
    items: [
      {
        externalId: `itest-media-${tag}`,
        title: "Entry with media",
        description: "This entry has an authorized source file.",
        publishedAt: "2024-02-02T00:00:00.000Z",
        durationSeconds: 90,
        source: "media/clip.mp4",
        thumbnail: "media/thumb.jpg",
        poster: "media/poster.jpg",
        renditions: [{ file: "media/clip-480.mp4", label: "480p", height: 480, width: 854 }],
        subtitles: [{ file: "media/en.vtt", label: "en", language: "en", kind: "subtitles" }],
        tags: ["fixture"],
      },
      {
        externalId: `itest-nomedia-${tag}`,
        title: "Entry without media",
        publishedAt: "2024-02-01T00:00:00.000Z",
      },
    ],
  };
}

async function writeFixture(name: string, manifest: unknown): Promise<string> {
  const dir = path.join(exportRoot(), `itest-${name}-${runId}`);
  await fs.mkdir(path.join(dir, "media"), { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [file, content] of Object.entries({
    "clip.mp4": TINY_VIDEO,
    "clip-480.mp4": TINY_VIDEO,
    "thumb.jpg": TINY_IMAGE,
    "poster.jpg": TINY_IMAGE,
    "en.vtt": TINY_VTT,
    "audio.m4a": TINY_VIDEO,
  })) {
    await fs.writeFile(path.join(dir, "media", file), content);
  }
  fixtureDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  if (!dbOk) return;
  baselineUsers = await prisma.user.count();
  baselineVideos = await prisma.video.count();
  user = await createTestUser();
  actor = { userId: user.userId, label: user.username, ip: "203.0.113.10", userAgent: "vitest-import" };
});

afterAll(async () => {
  if (!dbOk) return;

  // Import sources (cascade removes their items).
  if (trackedSourceIds.length > 0) {
    await prisma.importSource.deleteMany({ where: { id: { in: trackedSourceIds } } });
  }
  // Videos created under the test channel: purge their media, then let the user
  // deletion cascade remove the rows.
  if (user) {
    const videos = await prisma.video.findMany({
      where: { channel: { ownerId: user.userId } },
      select: { id: true },
    });
    for (const video of videos) await purgeVideoMedia(video.id);
  }
  // Audit rows this suite wrote (source + per-item media rows).
  if (trackedSourceIds.length > 0) {
    await prisma.adminAuditLog.deleteMany({
      where: { targetType: "import_source", targetId: { in: trackedSourceIds } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        action: "import.item.media_imported",
        OR: trackedSourceIds.map((id) => ({ details: { path: ["sourceId"], equals: id } })),
      },
    });
  }

  await cleanupFixtures();

  for (const dir of fixtureDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }

  const [users, videos] = await Promise.all([prisma.user.count(), prisma.video.count()]);
  console.log(`[import-sources] post-cleanup users=${users} videos=${videos} (baseline ${baselineUsers}/${baselineVideos})`);
  expect(users).toBe(baselineUsers);
  expect(videos).toBe(baselineVideos);
});

describe.skipIf(!dbOk)("import sources (database)", () => {
  it("previews a creator export and writes nothing", async () => {
    const tag = `preview-${runId}`;
    const dir = await writeFixture("main", mainManifest(tag));
    const before = await prisma.importSource.count({ where: { createdById: user.userId } });

    const preview = await previewImport({ input: dir, scopeLimit: 10 });

    expect(preview.kind).toBe("CREATOR_EXPORT");
    expect(preview.title).toBe(`ITest Creator ${tag}`);
    expect(preview.entries).toHaveLength(2);
    expect(preview.entries.map((entry) => entry.externalId)).toEqual([
      `itest-media-${tag}`,
      `itest-nomedia-${tag}`,
    ]);
    expect(preview.entries[0]!.title).toBe("Entry with media");
    expect(preview.entries[0]!.durationSeconds).toBe(90);
    expect(preview.estimatedBytes).toBeGreaterThan(0);

    const after = await prisma.importSource.count({ where: { createdById: user.userId } });
    expect(after).toBe(before);
  });

  it("refuses an export with no authorization basis", async () => {
    const dir = await writeFixture("nobasis", {
      format: "dextube-creator-export/1",
      channel: { title: "No basis" },
      items: [{ externalId: "itest-x", title: "X" }],
    });
    await expect(previewImport({ input: dir, scopeLimit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a manifest that traverses outside the export root", async () => {
    const dir = await writeFixture("traversal", {
      format: "dextube-creator-export/1",
      authorization: { basis: AUTHORIZATION },
      channel: { title: "Traversal" },
      items: [{ externalId: "itest-traverse", title: "Escape", source: "../../etc/passwd" }],
    });
    await expect(previewImport({ input: dir, scopeLimit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to copy media without a real authorization basis", async () => {
    const dir = await writeFixture("basischeck", mainManifest(`basis-${runId}`));
    await expect(
      createImportSource({
        input: dir,
        scopeLimit: 5,
        authorizationBasis: "   ",
        mediaAuthorized: true,
        actor,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("imports metadata only and creates no videos", async () => {
    const tag = `meta-${runId}`;
    const dir = await writeFixture("metaonly", mainManifest(tag));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(created.source.id);

    expect(created.source.status).toBe("PREVIEW");
    expect(created.source.authorizationBasis).toBe("metadata-only");
    expect(created.items.every((item) => item.mediaAuthorized === false)).toBe(true);

    const videosBefore = await prisma.video.count({ where: { channel: { ownerId: user.userId } } });
    const summary = await runImportSource(created.source.id, actor);
    const videosAfter = await prisma.video.count({ where: { channel: { ownerId: user.userId } } });

    expect(summary.status).toBe("COMPLETED");
    expect(summary.counts.metadataOnly).toBe(2);
    expect(summary.counts.imported).toBe(0);
    expect(summary.bytesImported).toBe(0);
    expect(videosAfter).toBe(videosBefore);

    const stored = await getImportSource(created.source.id);
    expect(stored!.items.every((item) => item.status === "METADATA_ONLY")).toBe(true);
    expect(stored!.items.every((item) => item.videoId === null)).toBe(true);
    expect(stored!.items.find((item) => item.externalId === `itest-nomedia-${tag}`)!.canonicalUrl).toBe("");
  });

  it("copies authorized media into a real video with renditions, captions and thumbnails", async () => {
    const tag = `media-${runId}`;
    const dir = await writeFixture("media", mainManifest(tag));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      concurrency: 2,
      actor,
    });
    trackSource(created.source.id);

    const summary = await runImportSource(created.source.id, actor);
    expect(summary.counts.imported).toBe(1);
    expect(summary.counts.metadataOnly).toBe(1);
    expect(summary.bytesImported).toBeGreaterThan(0);

    const stored = await getImportSource(created.source.id);
    const importedItem = stored!.items.find((item) => item.externalId === `itest-media-${tag}`)!;
    const noMediaItem = stored!.items.find((item) => item.externalId === `itest-nomedia-${tag}`)!;
    expect(importedItem.status).toBe("IMPORTED");
    expect(importedItem.videoId).toBeTruthy();
    expect(noMediaItem.status).toBe("METADATA_ONLY");
    expect(noMediaItem.lastError).toMatch(/no media/i);

    const video = await prisma.video.findUnique({ where: { id: importedItem.videoId! }, include: { assets: true } });
    expect(video).not.toBeNull();
    expect(video!.status).toBe("READY");
    expect(video!.visibility).toBe("PRIVATE");
    expect(video!.durationSec).toBe(90);
    expect(video!.originalKey).toBeTruthy();
    expect(video!.playbackKey).toBeTruthy();
    expect(video!.thumbnailKey).toBeTruthy();
    expect(video!.posterKey).toBeTruthy();

    const rendition = video!.assets.find((asset) => asset.kind === "PROGRESSIVE");
    expect(rendition).toBeDefined();
    expect(rendition!.height).toBe(480);
    expect(rendition!.width).toBe(854);
    expect(rendition!.label).toBe("480p");
    expect(video!.assets.find((asset) => asset.kind === "CAPTION")?.label).toBe("en");
    expect(video!.assets.find((asset) => asset.kind === "ORIGINAL")).toBeDefined();

    // The bytes really are on disk.
    const stat = await getStorage().stat(video!.playbackKey!);
    expect(stat?.size).toBeGreaterThan(0);
  });

  it("refuses to import an export that supplies a separate audio track", async () => {
    const dir = await writeFixture("audio", {
      format: "dextube-creator-export/1",
      authorization: { basis: AUTHORIZATION },
      channel: { title: "Audio track" },
      items: [
        {
          externalId: `itest-audio-${runId}`,
          title: "Has an audio track",
          source: "media/clip.mp4",
          audioTracks: [{ file: "media/audio.m4a", language: "en", isDefault: true }],
        },
      ],
    });
    const created = await createImportSource({
      input: dir,
      scopeLimit: 5,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      actor,
    });
    trackSource(created.source.id);
    const summary = await runImportSource(created.source.id, actor);

    expect(summary.counts.imported).toBe(0);
    expect(summary.counts.failed).toBe(1);
    const stored = await getImportSource(created.source.id);
    expect(stored!.items[0]!.status).toBe("FAILED");
    expect(stored!.items[0]!.lastError).toMatch(/audio track/i);
    expect(stored!.items[0]!.videoId).toBeNull();
  });

  it("marks an entry already imported by another source as a duplicate", async () => {
    const tag = `dedupe-${runId}`;
    const dir = await writeFixture("dedupe", mainManifest(tag));
    const first = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      actor,
    });
    trackSource(first.source.id);
    const firstRun = await runImportSource(first.source.id, actor);
    expect(firstRun.counts.imported).toBe(1);

    const second = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(second.source.id);

    const mediaItem = second.items.find((item) => item.externalId === `itest-media-${tag}`)!;
    const noMediaItem = second.items.find((item) => item.externalId === `itest-nomedia-${tag}`)!;
    expect(mediaItem.status).toBe("SKIPPED_DUPLICATE");
    expect(mediaItem.lastError).toContain(first.source.id);
    // The no-media entry was METADATA_ONLY, never IMPORTED, so it is not a duplicate.
    expect(noMediaItem.status).toBe("PENDING");
  });

  it("resumes by processing only the remaining pending items", async () => {
    const dir = await writeFixture("resume", mainManifest(`resume-${runId}`));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(created.source.id);
    await runImportSource(created.source.id, actor);

    const before = (await getImportSource(created.source.id))!.items;
    const target = before[0]!;
    const other = before[1]!;
    await prisma.importItem.update({ where: { id: target.id }, data: { status: "PENDING", attempts: 0 } });

    await runImportSource(created.source.id, actor);

    const after = (await getImportSource(created.source.id))!.items;
    const targetAfter = after.find((item) => item.id === target.id)!;
    const otherAfter = after.find((item) => item.id === other.id)!;
    expect(targetAfter.status).toBe("METADATA_ONLY");
    expect(targetAfter.attempts).toBe(1);
    expect(otherAfter.attempts).toBe(other.attempts);
  });

  it("flips failed items back to pending and retries them", async () => {
    const dir = await writeFixture("retry", mainManifest(`retry-${runId}`));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(created.source.id);
    await runImportSource(created.source.id, actor);

    const items = (await getImportSource(created.source.id))!.items;
    await prisma.importItem.update({ where: { id: items[0]!.id }, data: { status: "FAILED", lastError: "seeded failure" } });

    const summary = await retryFailedImportItems(created.source.id, actor);
    expect(summary.counts.failed).toBe(0);

    const stored = await getImportSource(created.source.id);
    expect(stored!.items.find((item) => item.id === items[0]!.id)!.status).toBe("METADATA_ONLY");

    const retryAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "import.source.retry", targetId: created.source.id },
      orderBy: { createdAt: "desc" },
    });
    expect(retryAudit).not.toBeNull();
    expect((retryAudit!.details as { resetItems?: number }).resetItems).toBe(1);
  });

  it("cancels an idle import leaving every item pending", async () => {
    const dir = await writeFixture("cancel-idle", mainManifest(`cancelidle-${runId}`));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(created.source.id);

    const summary = await cancelImportSource(created.source.id, actor);
    expect(summary.status).toBe("CANCELLED");
    const stored = await getImportSource(created.source.id);
    expect(stored!.items.every((item) => item.status === "PENDING")).toBe(true);
  });

  it("stops a running import at the next item boundary when cancelled", async () => {
    // A slow first entry gives the running import a real window to observe the
    // cancellation flag between items, without relying on a sleep inside it.
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const dir = path.join(exportRoot(), `itest-cancel-run-${runId}`);
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    fixtureDirs.push(dir);
    await fs.writeFile(path.join(dir, "media", "big.mp4"), big);
    await fs.writeFile(path.join(dir, "media", "small.mp4"), TINY_VIDEO);
    await fs.writeFile(path.join(dir, "media", "thumb.jpg"), TINY_IMAGE);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        format: "dextube-creator-export/1",
        authorization: { basis: AUTHORIZATION },
        channel: { title: `Cancel ${runId}` },
        items: [
          { externalId: `itest-cancel-1-${runId}`, title: "First", publishedAt: "2024-03-03T00:00:00.000Z", source: "media/big.mp4", thumbnail: "media/thumb.jpg" },
          { externalId: `itest-cancel-2-${runId}`, title: "Second", publishedAt: "2024-03-02T00:00:00.000Z", source: "media/small.mp4" },
          { externalId: `itest-cancel-3-${runId}`, title: "Third", publishedAt: "2024-03-01T00:00:00.000Z", source: "media/small.mp4" },
        ],
      }),
    );

    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      concurrency: 1,
      actor,
    });
    trackSource(created.source.id);

    const runPromise = runImportSource(created.source.id, actor);
    // Wait until the run has claimed the source, then request cancellation.
    for (let i = 0; i < 5000; i++) {
      const current = await prisma.importSource.findUnique({ where: { id: created.source.id }, select: { status: true } });
      if (current?.status === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await cancelImportSource(created.source.id, actor);
    const summary = await runPromise;

    expect(summary.status).toBe("CANCELLED");
    const stored = await getImportSource(created.source.id);
    expect(stored!.items.some((item) => item.status === "PENDING")).toBe(true);
  });

  it("refuses a second concurrent run of a running source", async () => {
    const dir = await writeFixture("conflict", mainManifest(`conflict-${runId}`));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: "",
      mediaAuthorized: false,
      actor,
    });
    trackSource(created.source.id);

    await prisma.importSource.update({ where: { id: created.source.id }, data: { status: "RUNNING" } });
    await expect(runImportSource(created.source.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    await prisma.importSource.update({ where: { id: created.source.id }, data: { status: "CANCELLED" } });
  });

  it("deletes a source, keeping imported videos by default and deleting them on request", async () => {
    const tag = `delete-${runId}`;
    const dir = await writeFixture("delete", mainManifest(tag));

    // Default: keep the created video.
    const keep = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      actor,
    });
    trackSource(keep.source.id);
    await runImportSource(keep.source.id, actor);
    const keepResult = await deleteImportSource(keep.source.id, actor);
    expect(keepResult.removedItems).toBe(2);
    expect(keepResult.keptVideos).toBe(1);
    expect(keepResult.deletedVideos).toBe(0);
    expect(await prisma.importSource.findUnique({ where: { id: keep.source.id } })).toBeNull();
    expect(await prisma.importItem.count({ where: { sourceId: keep.source.id } })).toBe(0);

    // Opt-in: remove the created video too.
    const remove = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      actor,
    });
    trackSource(remove.source.id);
    await runImportSource(remove.source.id, actor);
    const stored = await getImportSource(remove.source.id);
    const videoId = stored!.items.find((item) => item.videoId)!.videoId!;

    const removeResult = await deleteImportSource(remove.source.id, actor, { deleteImportedVideos: true });
    expect(removeResult.deletedVideos).toBe(1);
    expect(removeResult.keptVideos).toBe(0);
    const video = await prisma.video.findUnique({ where: { id: videoId }, select: { deletedAt: true } });
    expect(video?.deletedAt).toBeInstanceOf(Date);
  });

  it("records the expected audit actions without leaking a secret", async () => {
    const dir = await writeFixture("audit", mainManifest(`audit-${runId}`));
    const created = await createImportSource({
      input: dir,
      scopeLimit: 10,
      authorizationBasis: AUTHORIZATION,
      mediaAuthorized: true,
      actor,
    });
    trackSource(created.source.id);
    await runImportSource(created.source.id, actor);
    await deleteImportSource(created.source.id, actor);

    const rows = await prisma.adminAuditLog.findMany({
      where: { targetType: "import_source", targetId: created.source.id },
    });
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("import.source.create");
    expect(actions).toContain("import.source.complete");
    expect(actions).toContain("import.source.delete");

    const mediaRows = await prisma.adminAuditLog.findMany({
      where: {
        action: "import.item.media_imported",
        OR: [{ details: { path: ["sourceId"], equals: created.source.id } }],
      },
    });
    expect(mediaRows.length).toBeGreaterThan(0);

    for (const row of [...rows, ...mediaRows]) {
      const details = (row.details ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(details)) {
        if (/password|secret|token/i.test(key)) {
          expect(value).toBe("[redacted]");
        }
      }
    }
  });
});
