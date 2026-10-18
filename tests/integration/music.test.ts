/**
 * Integration tests for DEX Music against the real database.
 *
 * These exercise the enforcement path, not a mock: real `tracks` /
 * `track_rights` rows are inserted, then `authorizeTrackDownload()` is called
 * exactly as `/api/media/...?download=1` calls it. The two rights-bearing
 * outcomes the product promises are asserted directly —
 * `downloadAllowed = false` is refused (403) and `downloadAllowed = true` is
 * allowed — alongside visibility and the "missing rights row fails closed"
 * rule.
 */
import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase } from "@/lib/db";
import { AppError, isAppError } from "@/lib/errors";
import {
  MUSIC_PAGE_SIZE_MAX,
  authorizeTrackDownload,
  getTrack,
  listTracks,
  type MusicViewer,
} from "@/server/services/music";
import { cleanupFixtures, createTestTrack, createTestUser, uniqueSuffix } from "./helpers";

const dbOk = (await checkDatabase()).ok;

afterAll(async () => {
  if (dbOk) await cleanupFixtures();
});

const anonymous: MusicViewer = { channelId: null, role: "USER" };

/** Captures the error a promise rejects with, failing loudly if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

describe.skipIf(!dbOk)("DEX Music download authorisation (database)", () => {
  it("allows a download only where the rights metadata permits it, and fails closed when absent", async () => {
    const owner = await createTestUser();
    const title = `Track ${uniqueSuffix()}`;

    const downloadable = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `${title} downloadable`,
      downloadAllowed: true,
    });
    const streamOnly = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `${title} stream only`,
      downloadAllowed: false,
      license: "DEXTube demonstration licence — streaming only",
    });
    const noRights = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `${title} no rights`,
      downloadAllowed: null,
    });

    // `downloadAllowed = true` → authorised, with the real key and a filename.
    const authorisation = await authorizeTrackDownload(downloadable.id, anonymous);
    expect(authorisation.trackId).toBe(downloadable.id);
    expect(authorisation.audioKey).toBe(`tracks/${downloadable.id}/audio/original.m4a`);
    expect(authorisation.mimeType).toBe("audio/mp4");
    expect(authorisation.filename.endsWith(".m4a")).toBe(true);

    // `downloadAllowed = false` → refused with a 403 and a plain-language reason.
    const denied = await rejection(authorizeTrackDownload(streamOnly.id, anonymous));
    expect(denied.status).toBe(403);
    expect(denied.message).toMatch(/does not permit downloading/i);

    // No rights row at all → still refused (the join yields no permission).
    const missing = await rejection(authorizeTrackDownload(noRights.id, anonymous));
    expect(missing.status).toBe(403);
  });

  it("keeps a private track's existence hidden from outsiders regardless of its download flag", async () => {
    const owner = await createTestUser();
    const privateTrack = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Private ${uniqueSuffix()}`,
      visibility: "PRIVATE",
      downloadAllowed: true,
    });

    // Outsider (and signed-out viewer): the track is a 404, not a 403 — the
    // endpoint must not confirm that unpublished audio exists.
    const hidden = await rejection(authorizeTrackDownload(privateTrack.id, anonymous));
    expect(hidden.status).toBe(404);

    const stranger = await rejection(
      authorizeTrackDownload(privateTrack.id, { channelId: "some-other-channel", role: "USER" }),
    );
    expect(stranger.status).toBe(404);

    await expect(
      getTrack(privateTrack.id, { channelId: "some-other-channel", role: "USER" }),
    ).rejects.toThrow(/does not exist/i);

    // The owning channel may stream *and* download it.
    const asOwner = await authorizeTrackDownload(privateTrack.id, {
      channelId: owner.channelId,
      role: "USER",
    });
    expect(asOwner.trackId).toBe(privateTrack.id);
  });

  it("lists real public tracks (with their rights) and never a private one", async () => {
    const owner = await createTestUser();
    const suffix = uniqueSuffix();

    const pubAllowed = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Public allowed ${suffix}`,
      downloadAllowed: true,
    });
    const pubNoRights = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Public no rights ${suffix}`,
      downloadAllowed: null,
    });
    const priv = await createTestTrack({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Private ${suffix}`,
      visibility: "PRIVATE",
      downloadAllowed: true,
    });

    const page = await listTracks({ limit: MUSIC_PAGE_SIZE_MAX });
    const ids = page.items.map((track) => track.id);

    expect(ids).toContain(pubAllowed.id);
    expect(ids).toContain(pubNoRights.id);
    expect(ids).not.toContain(priv.id);

    const allowedItem = page.items.find((track) => track.id === pubAllowed.id)!;
    expect(allowedItem.rights).toMatchObject({ license: "CC0-1.0", downloadAllowed: true });
    expect(allowedItem.rights?.attribution).toContain("helpers.ts");

    const noRightsItem = page.items.find((track) => track.id === pubNoRights.id)!;
    expect(noRightsItem.rights).toBeNull();

    // `getTrack` returns the same rights metadata for a visible track.
    const detail = await getTrack(pubAllowed.id, anonymous);
    expect(detail.rights?.downloadAllowed).toBe(true);
    expect(detail.audioKey).toBe(`tracks/${pubAllowed.id}/audio/original.m4a`);
  });
});
