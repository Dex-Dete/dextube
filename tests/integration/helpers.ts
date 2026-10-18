/**
 * Shared helpers for integration tests.
 *
 * These tests run against the real PostgreSQL database from `.env`. Every
 * fixture is namespaced with a `itest_`/`itest-` prefix so it can be removed
 * afterwards, and user deletion cascades to channels, videos, sessions and all
 * engagement rows.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { registerUser } from "@/server/services/accounts";
import type { Visibility } from "@prisma/client";

const TEST_PREFIX = "itest_";
const createdUserIds: string[] = [];

export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export interface TestUser {
  userId: string;
  channelId: string;
  handle: string;
  email: string;
  username: string;
  password: string;
}

const PASSWORD = "CorrectHorse1";

/** Registers a throwaway user with a channel and remembers it for cleanup. */
export async function createTestUser(): Promise<TestUser> {
  const suffix = uniqueSuffix();
  const username = `${TEST_PREFIX}${suffix}`;
  const email = `itest-${suffix}@example.test`;
  const result = await registerUser({
    username,
    displayName: `ITest ${suffix}`,
    email,
    password: PASSWORD,
  });
  createdUserIds.push(result.userId);
  return {
    userId: result.userId,
    channelId: result.channelId,
    handle: result.handle,
    email,
    username,
    password: PASSWORD,
  };
}

export interface ReadyVideoInput {
  channelId: string;
  uploaderId: string;
  title: string;
  isShort?: boolean;
  visibility?: Visibility;
  viewCount?: number;
  likeCount?: number;
  durationSec?: number;
  category?: string | null;
  tags?: string[];
  publishedAt?: Date;
}

/** Creates a READY, playable-looking video row without running the media pipeline. */
export async function createReadyVideo(input: ReadyVideoInput) {
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  return prisma.video.create({
    data: {
      id,
      channelId: input.channelId,
      uploaderId: input.uploaderId,
      title: input.title,
      description: `${input.title} description`,
      status: "READY",
      visibility: input.visibility ?? "PUBLIC",
      isShort: input.isShort ?? false,
      durationSec: input.durationSec ?? (input.isShort ? 20 : 300),
      width: input.isShort ? 1080 : 1920,
      height: input.isShort ? 1920 : 1080,
      category: input.category ?? null,
      tags: input.tags ?? [],
      thumbnailKey: `videos/${id}/thumbs/default.jpg`,
      posterKey: `videos/${id}/thumbs/poster.jpg`,
      playbackKey: `videos/${id}/playback/source.mp4`,
      originalKey: `videos/${id}/source/source.mp4`,
      viewCount: input.viewCount ?? 0,
      likeCount: input.likeCount ?? 0,
      publishedAt: input.publishedAt ?? new Date(),
    },
  });
}

/** Removes every fixture created by this test file. Safe to call repeatedly. */
export async function cleanupFixtures(): Promise<void> {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  // Belt and braces: anything that leaked through a failed run.
  await prisma.user.deleteMany({ where: { username: { startsWith: TEST_PREFIX } } });
  await prisma.channel.deleteMany({ where: { handle: { startsWith: "itest-" } } });
  await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: "itest" } } });
}

export { TEST_PREFIX };
