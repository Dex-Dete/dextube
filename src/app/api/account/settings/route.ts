/**
 * Account settings.
 *
 *   PATCH /api/account/settings  { saveWatchHistory?, showLikesPublicly?, notifyOn*? }
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { updateSettings } from "@/server/services/accounts";
import { updateSettingsSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, updateSettingsSchema);
    await updateSettings(user.id, input);
    return jsonOk({ updated: true });
  } catch (error) {
    return jsonError(error);
  }
}
