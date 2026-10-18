/**
 * Subscribe / unsubscribe to a channel.
 *
 *   POST   /api/channels/:handle/subscribe  { notifyLevel? }
 *   DELETE /api/channels/:handle/subscribe
 *
 * Both are idempotent, and the returned `subscriberCount` is read back inside
 * the same transaction so the UI never shows a count that drifts from the DB.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { toggleSubscription } from "@/server/services/channels";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

const body = z.object({
  notifyLevel: z.enum(["all", "personalized", "none"]).default("all"),
});

async function resolveChannelId(handle: string): Promise<string> {
  const channel = await prisma.channel.findUnique({ where: { handle }, select: { id: true } });
  if (!channel) throw notFound("That channel does not exist.");
  return channel.id;
}

export async function POST(request: Request, context: { params: Promise<{ handle: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { handle } = await context.params;
    const { notifyLevel } = await parseJson(request, body);

    const channelId = await resolveChannelId(handle);
    const result = await toggleSubscription(user.id, channelId, true);
    if (notifyLevel !== "all") {
      await prisma.subscription.updateMany({
        where: { subscriberId: user.id, channelId },
        data: { notifyLevel },
      });
    }
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ handle: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { handle } = await context.params;
    const channelId = await resolveChannelId(handle);
    return jsonOk(await toggleSubscription(user.id, channelId, false));
  } catch (error) {
    return jsonError(error);
  }
}
