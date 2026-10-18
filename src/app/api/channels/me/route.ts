/**
 * The signed-in user's own channel.
 *
 *   GET   /api/channels/me   the caller's channel (null when they have none)
 *   PATCH /api/channels/me   edit { name?, description?, handle?, layout? }
 *
 * `me` is a reserved static segment: handles must be at least three characters,
 * so it can never collide with a real channel.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { getCurrentUser, requireChannelOwner } from "@/server/auth/session";
import { updateChannel } from "@/server/services/channels";
import { updateChannelSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return jsonOk({ channel: null });
    return jsonOk({ channel: user.channel ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireChannelOwner();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, updateChannelSchema);
    await updateChannel(user.channel.id, user.id, input);
    return jsonOk({ updated: true });
  } catch (error) {
    return jsonError(error);
  }
}
