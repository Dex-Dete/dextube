import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import { consumeRateLimit } from "@/server/auth/rate-limit";
import { listOwnPlaylists } from "@/server/services/playlists";
import { search } from "@/server/services/search";
import {
  getShortsFeedDetailed,
  getVideoForWatch,
  recordView,
  setReaction,
} from "@/server/services/videos";
import { cleanupFixtures, createReadyVideo, createTestUser, uniqueSuffix } from "./helpers";

const dbOk = (await checkDatabase()).ok;

afterAll(async () => {
  if (dbOk) await cleanupFixtures();
});

describe.skipIf(!dbOk)("video visibility and feeds (database)", () => {
  it("lists a READY public video but never a private or unfinished one", async () => {
    const owner = await createTestUser();
    const publicVideo = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Public ${uniqueSuffix()}`,
    });
    const privateVideo = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Private ${uniqueSuffix()}`,
      visibility: "PRIVATE",
    });

    const { getFeed } = await import("@/server/services/videos");
    const feed = await getFeed({ tab: "home", viewerId: null, viewerChannelId: null, limit: 60 });
    const ids = feed.items.map((v) => v.id);

    expect(ids).toContain(publicVideo.id);
    expect(ids).not.toContain(privateVideo.id);
  });

  it("returns a private video only to its owner", async () => {
    const owner = await createTestUser();
    const privateVideo = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Private only ${uniqueSuffix()}`,
      visibility: "PRIVATE",
    });

    const forOwner = await getVideoForWatch(privateVideo.id, {
      userId: owner.userId,
      channelId: owner.channelId,
    });
    expect(forOwner.id).toBe(privateVideo.id);

    await expect(
      getVideoForWatch(privateVideo.id, { userId: null, channelId: null }),
    ).rejects.toThrow(/does not exist/i);
  });

  it("counts a view once and de-duplicates repeats", async () => {
    const owner = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Viewed ${uniqueSuffix()}`,
    });
    const viewer = { userId: null, channelId: null, ip: "203.0.113.7", userAgent: "vitest" };

    const first = await recordView(video.id, viewer);
    expect(first.counted).toBe(true);
    expect(first.viewCount).toBe(1);

    const second = await recordView(video.id, viewer);
    expect(second.counted).toBe(false);
    expect(second.viewCount).toBe(1);
  });

  it("never counts the owner watching their own video", async () => {
    const owner = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Own view ${uniqueSuffix()}`,
    });

    const result = await recordView(video.id, {
      userId: owner.userId,
      channelId: owner.channelId,
      ip: "203.0.113.9",
      userAgent: "vitest",
    });
    expect(result.counted).toBe(false);
    expect(result.viewCount).toBe(0);
  });

  it("records watch history for a signed-in viewer and refreshes it on rewatch", async () => {
    const owner = await createTestUser();
    const viewerUser = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `History ${uniqueSuffix()}`,
    });

    const first = await recordView(video.id, {
      userId: viewerUser.userId,
      channelId: viewerUser.channelId,
      ip: "203.0.113.20",
      userAgent: "vitest-1",
    });
    expect(first.counted).toBe(true);

    const entry = await prisma.watchHistory.findUnique({
      where: { userId_videoId: { userId: viewerUser.userId, videoId: video.id } },
    });
    expect(entry).not.toBeNull();

    // Signed-in viewers are de-duplicated by user, so clear the view record to
    // let a genuine rewatch through; it must refresh the row, not duplicate it.
    await prisma.view.deleteMany({ where: { videoId: video.id, userId: viewerUser.userId } });
    const again = await recordView(video.id, {
      userId: viewerUser.userId,
      channelId: viewerUser.channelId,
      ip: "203.0.113.21",
      userAgent: "vitest-2",
    });
    expect(again.counted).toBe(true);

    const rows = await prisma.watchHistory.findMany({
      where: { userId: viewerUser.userId, videoId: video.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.watchedAt.getTime()).toBeGreaterThanOrEqual(entry!.watchedAt.getTime());
  });

  it("toggles a reaction and keeps the like count consistent", async () => {
    const owner = await createTestUser();
    const liker = await createTestUser();
    const video = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Reacted ${uniqueSuffix()}`,
    });

    const liked = await setReaction(video.id, liker.userId, "LIKE");
    expect(liked.reaction).toBe("LIKE");
    expect(liked.likeCount).toBe(1);

    // Switching to dislike removes the like.
    const disliked = await setReaction(video.id, liker.userId, "DISLIKE");
    expect(disliked.reaction).toBe("DISLIKE");
    expect(disliked.likeCount).toBe(0);
    expect(disliked.dislikeCount).toBe(1);

    // Clearing removes it entirely.
    const cleared = await setReaction(video.id, liker.userId, null);
    expect(cleared.reaction).toBeNull();
    expect(cleared.dislikeCount).toBe(0);
  });
});

describe.skipIf(!dbOk)("shorts feed (database)", () => {
  it("returns only vertical shorts", async () => {
    const owner = await createTestUser();
    const short = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `A short ${uniqueSuffix()}`,
      isShort: true,
    });
    const normal = await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `Not a short ${uniqueSuffix()}`,
      isShort: false,
    });

    const page = await getShortsFeedDetailed({ viewerId: null, limit: 30 });
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(short.id);
    expect(ids).not.toContain(normal.id);
    // Every Short carries the playback key the vertical player needs.
    const found = page.items.find((item) => item.id === short.id)!;
    expect(found.playbackKey).toBeTruthy();
    expect(found.viewer).toBeNull();
  });
});

describe.skipIf(!dbOk)("playlists and search (database)", () => {
  it("materialises the built-in Watch later and Liked videos playlists", async () => {
    const user = await createTestUser();
    const playlists = await listOwnPlaylists(user.userId);
    const kinds = playlists.filter((p) => p.isSystem).map((p) => p.systemKind);
    expect(kinds).toContain("watch_later");
    expect(kinds).toContain("liked_videos");
  });

  it("finds a video by a distinctive title", async () => {
    const owner = await createTestUser();
    const marker = `zzmarker${uniqueSuffix()}`;
    await createReadyVideo({
      channelId: owner.channelId,
      uploaderId: owner.userId,
      title: `${marker} search target`,
    });

    const results = await search({ query: marker, viewerChannelId: null });
    expect(results.videos.some((v) => v.title.includes(marker))).toBe(true);
  });
});

describe.skipIf(!dbOk)("rate limiting (database)", () => {
  it("allows up to the limit and then blocks", async () => {
    const identity = `itest-${uniqueSuffix()}`;
    const rule = { scope: "itest", limit: 2, windowMs: 60_000 };

    expect((await consumeRateLimit(rule, identity)).allowed).toBe(true);
    expect((await consumeRateLimit(rule, identity)).allowed).toBe(true);
    const blocked = await consumeRateLimit(rule, identity);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
});
