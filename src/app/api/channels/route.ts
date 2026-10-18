/**
 * Create a channel.
 *
 *   POST /api/channels  { handle, name, description? }
 *
 * One channel per account. The owner is taken from the session, never the body.
 */
import { assertSameOrigin, jsonCreated, jsonError, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { createChannelForUser } from "@/server/services/channels";
import { createChannelSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, createChannelSchema);
    const channel = await createChannelForUser(user.id, input);
    return jsonCreated({ channel });
  } catch (error) {
    return jsonError(error);
  }
}
