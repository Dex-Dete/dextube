/**
 * Explicit recommendation feedback.
 *
 * Two viewer decisions are stored: "not interested" in a specific video, and
 * "don't recommend this channel". Both are the viewer's own statements, held in
 * their own tables so they can never be confused with engagement metrics, and
 * both are reversible — a dismissal is a preference, not a permanent record.
 *
 * Hiding a channel is deliberately *not* the same as unsubscribing and is not
 * the same as blocking. The channel remains fully reachable; it is only
 * withheld from this viewer's recommendations.
 *
 * Nothing here writes to watch history. History is cleared through the history
 * API, and the two are separate on purpose: a viewer who wants to reset
 * recommendations should not silently lose their viewing history, and vice
 * versa.
 */

import "server-only";

import { prisma } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";

export type RecommendationAction = "not_interested" | "hide_channel" | "reset";

export interface RecommendationFeedbackInput {
  userId: string;
  action: RecommendationAction;
  videoId?: string | null;
  channelId?: string | null;
}

export interface RecommendationFeedbackResult {
  action: RecommendationAction;
  /** What the viewer's stored feedback looks like after the change. */
  dismissals: number;
  hiddenChannels: number;
}

/** How much stored feedback a viewer has, for the reset control's label. */
export async function getFeedbackSummary(userId: string): Promise<{
  dismissals: number;
  hiddenChannels: number;
}> {
  const [dismissals, hiddenChannels] = await Promise.all([
    prisma.videoFeedback.count({ where: { userId } }),
    prisma.hiddenChannel.count({ where: { userId } }),
  ]);
  return { dismissals, hiddenChannels };
}

/**
 * Record one piece of feedback, or clear everything.
 *
 * Idempotent: dismissing the same video twice is a no-op rather than an error,
 * which matters because the control can be pressed twice before the first
 * request completes.
 */
export async function applyRecommendationFeedback(
  input: RecommendationFeedbackInput,
): Promise<RecommendationFeedbackResult> {
  const { userId, action } = input;

  switch (action) {
    case "not_interested": {
      const videoId = input.videoId;
      if (!videoId) throw badRequest("A video is required for this feedback.");
      const video = await prisma.video.findFirst({
        where: { id: videoId, deletedAt: null },
        select: { id: true },
      });
      if (!video) throw notFound("That video does not exist.");
      await prisma.videoFeedback.upsert({
        where: { userId_videoId: { userId, videoId } },
        create: { userId, videoId },
        update: {},
      });
      break;
    }

    case "hide_channel": {
      const channelId = input.channelId;
      if (!channelId) throw badRequest("A channel is required for this feedback.");
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true },
      });
      if (!channel) throw notFound("That channel does not exist.");
      await prisma.hiddenChannel.upsert({
        where: { userId_channelId: { userId, channelId } },
        create: { userId, channelId },
        update: {},
      });
      break;
    }

    case "reset": {
      await prisma.$transaction([
        prisma.videoFeedback.deleteMany({ where: { userId } }),
        prisma.hiddenChannel.deleteMany({ where: { userId } }),
      ]);
      break;
    }

    default:
      throw badRequest("Unknown feedback action.");
  }

  const [dismissals, hiddenChannels] = await Promise.all([
    prisma.videoFeedback.count({ where: { userId } }),
    prisma.hiddenChannel.count({ where: { userId } }),
  ]);
  return { action, dismissals, hiddenChannels };
}

/** Undo a single dismissal, so the inline "Undo" affordance can reverse itself. */
export async function undoRecommendationFeedback(input: {
  userId: string;
  videoId?: string | null;
  channelId?: string | null;
}): Promise<RecommendationFeedbackResult> {
  if (input.videoId) {
    await prisma.videoFeedback.deleteMany({ where: { userId: input.userId, videoId: input.videoId } });
  } else if (input.channelId) {
    await prisma.hiddenChannel.deleteMany({
      where: { userId: input.userId, channelId: input.channelId },
    });
  } else {
    throw badRequest("Provide a video or a channel to undo.");
  }

  const [dismissals, hiddenChannels] = await Promise.all([
    prisma.videoFeedback.count({ where: { userId: input.userId } }),
    prisma.hiddenChannel.count({ where: { userId: input.userId } }),
  ]);
  return { action: "reset", dismissals, hiddenChannels };
}
