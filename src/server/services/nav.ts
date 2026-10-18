/**
 * Data needed by the persistent application shell (sidebar subscriptions and
 * the unread notification badge). Kept in one place so the root layout stays a
 * thin composition and the queries remain easy to cache later.
 */
import "server-only";
import { prisma } from "@/lib/db";
import type { ChannelSummaryDTO } from "@/lib/dto";

export interface NavData {
  subscriptions: ChannelSummaryDTO[];
  unreadNotifications: number;
}

export async function getNavData(userId: string | null): Promise<NavData> {
  if (!userId) return { subscriptions: [], unreadNotifications: 0 };

  const [subscriptions, unreadNotifications] = await Promise.all([
    prisma.subscription.findMany({
      where: { subscriberId: userId },
      orderBy: { createdAt: "desc" },
      take: 24,
      select: { channel: { select: { id: true, handle: true, name: true, avatarKey: true } } },
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return {
    subscriptions: subscriptions.map((row) => row.channel),
    unreadNotifications,
  };
}
