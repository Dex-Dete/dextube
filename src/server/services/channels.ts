/**
 * Channel service: public profiles, owner-only edits, branding uploads and
 * subscriptions.
 *
 * Ownership and visibility are enforced here. Route handlers pass the acting
 * user id in and never decide permissions themselves.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { conflict, forbidden, notFound, preconditionFailed } from "@/lib/errors";
import { slugifyHandle, uniqueHandle } from "@/server/services/accounts";
import { normalizeText } from "@/lib/validation";
import { notificationService } from "@/server/services/notifications";
import type { Prisma } from "@prisma/client";

export interface ChannelProfile {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarKey: string | null;
  bannerKey: string | null;
  subscriberCount: number;
  videoCount: number;
  shortCount: number;
  createdAt: Date;
  layout: { sections: string[] } | null;
  isOwner: boolean;
  viewerSubscribed: boolean;
  user: { id: string; displayName: string; avatarKey: string | null };
}

const DEFAULT_SECTIONS = ["featured", "videos", "shorts", "playlists", "about"];

export async function getChannelProfile(handle: string, viewerId: string | null): Promise<ChannelProfile> {
  const channel = await prisma.channel.findUnique({
    where: { handle: handle.toLowerCase() },
    select: {
      id: true,
      handle: true,
      name: true,
      description: true,
      avatarKey: true,
      bannerKey: true,
      subscriberCount: true,
      createdAt: true,
      layout: true,
      ownerId: true,
      owner: { select: { id: true, displayName: true, avatarKey: true, deletedAt: true } },
      _count: { select: { videos: { where: { deletedAt: null, status: "READY", visibility: "PUBLIC" } } } },
    },
  });
  if (!channel || channel.owner.deletedAt) throw notFound("That channel does not exist.");

  const [shortCount, subscription] = await Promise.all([
    prisma.video.count({
      where: {
        channelId: channel.id,
        deletedAt: null,
        status: "READY",
        visibility: "PUBLIC",
        isShort: true,
      },
    }),
    viewerId
      ? prisma.subscription.findUnique({
          where: { subscriberId_channelId: { subscriberId: viewerId, channelId: channel.id } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  const layout = normalizeLayout(channel.layout);

  return {
    id: channel.id,
    handle: channel.handle,
    name: channel.name,
    description: channel.description,
    avatarKey: channel.avatarKey,
    bannerKey: channel.bannerKey,
    subscriberCount: channel.subscriberCount,
    videoCount: channel._count.videos,
    shortCount,
    createdAt: channel.createdAt,
    layout,
    isOwner: viewerId === channel.ownerId,
    viewerSubscribed: Boolean(subscription),
    user: {
      id: channel.owner.id,
      displayName: channel.owner.displayName,
      avatarKey: channel.owner.avatarKey,
    },
  };
}

function normalizeLayout(raw: Prisma.JsonValue | null): { sections: string[] } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const sections = (raw as { sections?: unknown }).sections;
    if (Array.isArray(sections)) {
      const valid = sections.filter(
        (s): s is string => typeof s === "string" && DEFAULT_SECTIONS.includes(s),
      );
      if (valid.length > 0) return { sections: valid };
    }
  }
  return { sections: DEFAULT_SECTIONS };
}

/** Creates a channel for an account that does not have one yet. */
export async function createChannelForUser(
  userId: string,
  input: { handle: string; name: string; description?: string },
): Promise<{ id: string; handle: string }> {
  const existing = await prisma.channel.findUnique({ where: { ownerId: userId }, select: { id: true } });
  if (existing) throw conflict("This account already has a channel.");

  const desired = input.handle.trim().toLowerCase();
  const handleTaken = await prisma.channel.findUnique({ where: { handle: desired }, select: { id: true } });
  if (handleTaken) throw conflict("That handle is already taken.");

  const channel = await prisma.channel.create({
    data: {
      ownerId: userId,
      handle: desired,
      name: normalizeText(input.name),
      description: input.description ? normalizeText(input.description) : null,
    },
    select: { id: true, handle: true },
  });
  return channel;
}

/** Owner-only channel edit. */
export async function updateChannel(
  channelId: string,
  userId: string,
  input: { name?: string; description?: string; handle?: string; layout?: { sections?: string[] } },
): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { ownerId: true, handle: true },
  });
  if (!channel) throw notFound("Channel not found.");
  if (channel.ownerId !== userId) throw forbidden("You can only edit your own channel.");

  const data: Prisma.ChannelUpdateInput = {};
  if (input.name !== undefined) data.name = normalizeText(input.name);
  if (input.description !== undefined) data.description = normalizeText(input.description) || null;

  if (input.handle !== undefined) {
    const next = input.handle.trim().toLowerCase();
    if (next !== channel.handle) {
      const taken = await prisma.channel.findUnique({ where: { handle: next }, select: { id: true } });
      if (taken) throw conflict("That handle is already taken.");
      data.handle = next;
    }
  }

  if (input.layout?.sections) {
    const sections = input.layout.sections.filter((s) => DEFAULT_SECTIONS.includes(s));
    data.layout = { sections: sections.length ? sections : DEFAULT_SECTIONS };
  }

  await prisma.channel.update({ where: { id: channelId }, data });
}

/** Records a new avatar or banner key for the owner's channel. */
export async function setChannelImage(
  channelId: string,
  userId: string,
  kind: "avatar" | "banner",
  key: string,
): Promise<{ previousKey: string | null }> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { ownerId: true, avatarKey: true, bannerKey: true },
  });
  if (!channel) throw notFound("Channel not found.");
  if (channel.ownerId !== userId) throw forbidden("You can only edit your own channel.");

  const previousKey = kind === "avatar" ? channel.avatarKey : channel.bannerKey;
  await prisma.channel.update({
    where: { id: channelId },
    data: kind === "avatar" ? { avatarKey: key } : { bannerKey: key },
  });
  return { previousKey };
}

/** Channel a user must have before creating content. */
export async function requireOwnedChannelId(userId: string): Promise<string> {
  const channel = await prisma.channel.findUnique({ where: { ownerId: userId }, select: { id: true } });
  if (!channel) throw preconditionFailed("Create your channel before uploading videos.");
  return channel.id;
}

/* ----------------------------------------------------------- subscriptions */

export interface ToggleSubscriptionResult {
  subscribed: boolean;
  subscriberCount: number;
}

/**
 * Subscribes or unsubscribes. Subscriber counts are updated in the same
 * transaction as the relationship so the number on the channel page is never
 * inconsistent with the rows.
 */
export async function toggleSubscription(
  subscriberId: string,
  channelId: string,
  subscribe: boolean,
): Promise<ToggleSubscriptionResult> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, ownerId: true, name: true, handle: true },
  });
  if (!channel) throw notFound("That channel does not exist.");
  if (channel.ownerId === subscriberId) throw forbidden("You cannot subscribe to your own channel.");

  const existing = await prisma.subscription.findUnique({
    where: { subscriberId_channelId: { subscriberId, channelId } },
    select: { id: true },
  });

  if (subscribe && !existing) {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.subscription.create({ data: { subscriberId, channelId } });
      const row = await tx.channel.update({
        where: { id: channelId },
        data: { subscriberCount: { increment: 1 } },
        select: { subscriberCount: true },
      });
      return row;
    });
    await notificationService.subscriptionCreated(subscriberId, channel);
    return { subscribed: true, subscriberCount: updated.subscriberCount };
  }

  if (!subscribe && existing) {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.subscription.delete({ where: { id: existing.id } });
      const row = await tx.channel.update({
        where: { id: channelId },
        data: { subscriberCount: { decrement: 1 } },
        select: { subscriberCount: true },
      });
      return row;
    });
    return { subscribed: false, subscriberCount: Math.max(0, updated.subscriberCount) };
  }

  const current = await prisma.channel.findUnique({ where: { id: channelId }, select: { subscriberCount: true } });
  return { subscribed: subscribe, subscriberCount: current?.subscriberCount ?? 0 };
}

export async function isSubscribed(subscriberId: string | null, channelId: string): Promise<boolean> {
  if (!subscriberId) return false;
  const row = await prisma.subscription.findUnique({
    where: { subscriberId_channelId: { subscriberId, channelId } },
    select: { id: true },
  });
  return Boolean(row);
}

/** Channels a user subscribes to, newest first. */
export async function listSubscriptions(subscriberId: string, cursor?: string, limit = 24) {
  const rows = await prisma.subscription.findMany({
    where: { subscriberId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      createdAt: true,
      notifyLevel: true,
      channel: {
        select: {
          id: true,
          handle: true,
          name: true,
          avatarKey: true,
          subscriberCount: true,
          _count: { select: { videos: { where: { deletedAt: null, status: "READY", visibility: "PUBLIC" } } } },
        },
      },
    },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

/** Sets the notification level for one subscription (owner-only). */
export async function setSubscriptionNotifyLevel(
  subscriberId: string,
  channelId: string,
  level: "all" | "personalized" | "none",
): Promise<void> {
  const row = await prisma.subscription.findUnique({
    where: { subscriberId_channelId: { subscriberId, channelId } },
    select: { id: true },
  });
  if (!row) throw notFound("You are not subscribed to that channel.");
  await prisma.subscription.update({ where: { id: row.id }, data: { notifyLevel: level } });
}

/** Suggests an available handle (used by the create-channel form). */
export async function suggestHandle(base: string): Promise<string> {
  return uniqueHandle(slugifyHandle(base));
}
