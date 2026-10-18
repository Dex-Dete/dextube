/**
 * Playlist service.
 *
 * Playlists belong to a **channel** (a creator's library), not directly to a
 * user, so every ownership check goes through `channel.ownerId`. System
 * playlists ("Watch later", "Liked videos") are created lazily, are marked
 * `isSystem`, and cannot be renamed or deleted — they are a fixed part of the
 * product rather than user content.
 *
 * Positions are dense integers starting at 0. Reordering rewrites the whole
 * ordering inside one transaction so the list can never end up with duplicate
 * or missing positions.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { requireOwnedChannelId } from "@/server/services/channels";
import { addToSystemPlaylist, ensureSystemPlaylist, removeFromSystemPlaylist, toCard, CARD_SELECT } from "@/server/services/videos";
import { logger } from "@/lib/logger";
import type { ListVisibility } from "@prisma/client";

const log = logger.child({ mod: "playlists" });

export const MAX_PLAYLISTS_PER_CHANNEL = 200;
export const MAX_ITEMS_PER_PLAYLIST = 5000;

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string | null;
  visibility: ListVisibility;
  isSystem: boolean;
  systemKind: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  /** Key of the first item's thumbnail, for the playlist card. */
  coverKey: string | null;
  /** Whether the current viewer owns this playlist. */
  isOwner: boolean;
  /** Whether the current viewer has "Watch later"-style membership. */
  containsVideo?: boolean;
}

/** The viewer's own playlists, system playlists first. */
export async function listOwnPlaylists(userId: string, videoId?: string): Promise<PlaylistSummary[]> {
  const channelId = await requireOwnedChannelId(userId);

  // Materialise both system playlists so they always appear, even when empty.
  await Promise.all([ensureSystemPlaylist(userId, "watch_later"), ensureSystemPlaylist(userId, "liked_videos")]);

  const rows = await prisma.playlist.findMany({
    where: { channelId },
    orderBy: [{ isSystem: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      description: true,
      visibility: true,
      isSystem: true,
      systemKind: true,
      itemCount: true,
      createdAt: true,
      updatedAt: true,
      items: {
        orderBy: { position: "asc" },
        take: 1,
        select: { video: { select: { thumbnailKey: true, posterKey: true } } },
      },
    },
  });

  const membership = videoId
    ? new Set(
        (
          await prisma.playlistItem.findMany({
            where: { videoId, playlist: { channelId } },
            select: { playlistId: true },
          })
        ).map((row) => row.playlistId),
      )
    : new Set<string>();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    isSystem: row.isSystem,
    systemKind: row.systemKind,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    coverKey: row.items[0]?.video.thumbnailKey ?? row.items[0]?.video.posterKey ?? null,
    isOwner: true,
    containsVideo: membership.has(row.id),
  }));
}

/** Playlists visible on a channel's public page. */
export async function listPublicPlaylists(
  handle: string,
  viewerChannelId: string | null,
): Promise<{ playlists: PlaylistSummary[]; channelId: string }> {
  const channel = await prisma.channel.findUnique({
    where: { handle },
    select: { id: true },
  });
  if (!channel) throw notFound("That channel does not exist.");
  const isOwner = viewerChannelId === channel.id;

  const rows = await prisma.playlist.findMany({
    where: {
      channelId: channel.id,
      isSystem: false,
      ...(isOwner ? {} : { visibility: "PUBLIC" }),
    },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: {
      id: true,
      title: true,
      description: true,
      visibility: true,
      isSystem: true,
      systemKind: true,
      itemCount: true,
      createdAt: true,
      updatedAt: true,
      items: {
        orderBy: { position: "asc" },
        take: 1,
        select: { video: { select: { thumbnailKey: true, posterKey: true } } },
      },
    },
  });

  return {
    channelId: channel.id,
    playlists: rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      visibility: row.visibility,
      isSystem: row.isSystem,
      systemKind: row.systemKind,
      itemCount: row.itemCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      coverKey: row.items[0]?.video.thumbnailKey ?? row.items[0]?.video.posterKey ?? null,
      isOwner,
    })),
  };
}

export async function createPlaylist(
  userId: string,
  input: { title: string; description?: string; visibility: ListVisibility },
): Promise<PlaylistSummary> {
  const channelId = await requireOwnedChannelId(userId);
  const count = await prisma.playlist.count({ where: { channelId } });
  if (count >= MAX_PLAYLISTS_PER_CHANNEL) {
    throw badRequest(`A channel can have at most ${MAX_PLAYLISTS_PER_CHANNEL} playlists.`);
  }

  const created = await prisma.playlist.create({
    data: {
      channelId,
      title: input.title,
      description: input.description ?? null,
      visibility: input.visibility,
    },
    select: { id: true },
  });
  log.info("playlist created", { playlistId: created.id, channelId });
  const playlists = await listOwnPlaylists(userId);
  return playlists.find((p) => p.id === created.id)!;
}

async function requireOwnedPlaylist(userId: string, playlistId: string) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    select: { id: true, isSystem: true, systemKind: true, channelId: true, channel: { select: { ownerId: true } } },
  });
  if (!playlist) throw notFound("That playlist does not exist.");
  if (playlist.channel.ownerId !== userId) throw forbidden("That playlist belongs to another channel.");
  return playlist;
}

export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: { title?: string; description?: string; visibility?: ListVisibility; itemOrder?: string[] },
): Promise<{ updated: true }> {
  const playlist = await requireOwnedPlaylist(userId, playlistId);
  if (playlist.isSystem && (input.title !== undefined || input.visibility !== undefined)) {
    throw badRequest("Built-in playlists cannot be renamed or made public.");
  }

  await prisma.$transaction(async (tx) => {
    if (input.title !== undefined || input.description !== undefined || input.visibility !== undefined) {
      await tx.playlist.update({
        where: { id: playlistId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        },
      });
    }

    if (input.itemOrder) {
      const current = await tx.playlistItem.findMany({
        where: { playlistId },
        select: { videoId: true },
      });
      const currentIds = new Set(current.map((item) => item.videoId));
      const requested = input.itemOrder.filter((id) => currentIds.has(id));
      if (requested.length !== current.length) {
        throw badRequest("The new order must list every video in the playlist exactly once.");
      }
      // Two passes: park everything at a high offset first, otherwise the
      // unique (playlistId, position) index can collide mid-update if it exists.
      for (let i = 0; i < requested.length; i++) {
        await tx.playlistItem.update({
          where: { playlistId_videoId: { playlistId, videoId: requested[i]! } },
          data: { position: 1_000_000 + i },
        });
      }
      for (let i = 0; i < requested.length; i++) {
        await tx.playlistItem.update({
          where: { playlistId_videoId: { playlistId, videoId: requested[i]! } },
          data: { position: i },
        });
      }
    }
  });

  return { updated: true };
}

export async function deletePlaylist(userId: string, playlistId: string): Promise<void> {
  const playlist = await requireOwnedPlaylist(userId, playlistId);
  if (playlist.isSystem) throw badRequest("Built-in playlists cannot be deleted.");
  await prisma.playlist.delete({ where: { id: playlistId } });
  log.info("playlist deleted", { playlistId });
}

/** Adds a video to one of the viewer's playlists, at the end. Idempotent. */
export async function addVideoToPlaylist(
  userId: string,
  playlistId: string,
  videoId: string,
): Promise<{ added: boolean; itemCount: number }> {
  const playlist = await requireOwnedPlaylist(userId, playlistId);

  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, status: "READY" },
    select: { id: true, visibility: true, channelId: true },
  });
  if (!video) throw notFound("That video does not exist or is not available.");
  if (video.visibility === "PRIVATE" && video.channelId !== playlist.channelId) {
    throw notFound("That video does not exist or is not available.");
  }

  const existing = await prisma.playlistItem.findUnique({
    where: { playlistId_videoId: { playlistId, videoId } },
    select: { id: true },
  });
  if (existing) {
    const current = await prisma.playlist.findUniqueOrThrow({ where: { id: playlistId }, select: { itemCount: true } });
    return { added: false, itemCount: current.itemCount };
  }

  const itemCount = await prisma.$transaction(async (tx) => {
    const count = await tx.playlistItem.count({ where: { playlistId } });
    if (count >= MAX_ITEMS_PER_PLAYLIST) {
      throw badRequest(`A playlist can hold at most ${MAX_ITEMS_PER_PLAYLIST} videos.`);
    }
    await tx.playlistItem.create({ data: { playlistId, videoId, position: count } });
    const updated = await tx.playlist.update({
      where: { id: playlistId },
      data: { itemCount: { increment: 1 } },
      select: { itemCount: true },
    });
    return updated.itemCount;
  });

  return { added: true, itemCount };
}

/** Removes a video and closes the gap in the ordering. */
export async function removeVideoFromPlaylist(
  userId: string,
  playlistId: string,
  videoId: string,
): Promise<{ removed: boolean; itemCount: number }> {
  await requireOwnedPlaylist(userId, playlistId);

  const item = await prisma.playlistItem.findUnique({
    where: { playlistId_videoId: { playlistId, videoId } },
    select: { id: true, position: true },
  });
  if (!item) {
    const current = await prisma.playlist.findUniqueOrThrow({ where: { id: playlistId }, select: { itemCount: true } });
    return { removed: false, itemCount: current.itemCount };
  }

  const itemCount = await prisma.$transaction(async (tx) => {
    await tx.playlistItem.delete({ where: { id: item.id } });
    await tx.playlistItem.updateMany({
      where: { playlistId, position: { gt: item.position } },
      data: { position: { decrement: 1 } },
    });
    const updated = await tx.playlist.update({
      where: { id: playlistId },
      data: { itemCount: { decrement: 1 } },
      select: { itemCount: true },
    });
    return updated.itemCount;
  });

  return { removed: true, itemCount };
}

/** Toggles membership of a system playlist (Watch later / Liked videos). */
export async function toggleSystemPlaylist(
  userId: string,
  videoId: string,
  kind: "watch_later" | "liked_videos",
  add: boolean,
): Promise<{ saved: boolean }> {
  if (add) {
    await addToSystemPlaylist(userId, videoId, kind);
    return { saved: true };
  }
  await removeFromSystemPlaylist(userId, videoId, kind);
  return { saved: false };
}

export interface PlaylistPage {
  playlist: PlaylistSummary;
  items: ReturnType<typeof toCard>[];
  nextOffset: number | null;
}

/** A playlist's contents, enforcing privacy. */
export async function getPlaylist(
  playlistId: string,
  viewer: { userId: string | null; channelId: string | null },
  options: { offset?: number; limit?: number } = {},
): Promise<PlaylistPage> {
  const { offset = 0, limit = 50 } = options;
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    select: {
      id: true,
      title: true,
      description: true,
      visibility: true,
      isSystem: true,
      systemKind: true,
      itemCount: true,
      createdAt: true,
      updatedAt: true,
      channelId: true,
      channel: { select: { ownerId: true, handle: true, name: true, avatarKey: true } },
    },
  });
  if (!playlist) throw notFound("That playlist does not exist.");

  const isOwner = Boolean(viewer.channelId && viewer.channelId === playlist.channelId);
  if (!isOwner && (playlist.visibility !== "PUBLIC" || playlist.isSystem)) {
    throw notFound("That playlist does not exist.");
  }

  const rows = await prisma.playlistItem.findMany({
    where: {
      playlistId,
      video: { deletedAt: null, status: "READY", visibility: { in: ["PUBLIC", "UNLISTED"] } },
    },
    orderBy: { position: "asc" },
    skip: offset,
    take: limit,
    select: { video: { select: CARD_SELECT } },
  });

  // The stored `itemCount` includes videos that have since been made private or
  // deleted, so the page reports the number actually visible to this viewer.
  const visibleTotal = await prisma.playlistItem.count({
    where: {
      playlistId,
      video: { deletedAt: null, status: "READY", visibility: { in: ["PUBLIC", "UNLISTED"] } },
    },
  });

  return {
    playlist: {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      visibility: playlist.visibility,
      isSystem: playlist.isSystem,
      systemKind: playlist.systemKind,
      itemCount: visibleTotal,
      createdAt: playlist.createdAt.toISOString(),
      updatedAt: playlist.updatedAt.toISOString(),
      coverKey: rows[0]?.video.thumbnailKey ?? null,
      isOwner,
    },
    items: rows.map((row) => toCard(row.video)),
    nextOffset: offset + rows.length < visibleTotal ? offset + rows.length : null,
  };
}

/** Resolves a system playlist's id for the current user. */
export async function systemPlaylistId(userId: string, kind: "watch_later" | "liked_videos"): Promise<string> {
  return ensureSystemPlaylist(userId, kind);
}

/** Type guard used by routes that accept a playlist id or a system kind. */
export function isSystemKind(value: string): value is "watch_later" | "liked_videos" {
  return value === "watch_later" || value === "liked_videos";
}
