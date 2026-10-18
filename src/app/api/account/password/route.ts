/**
 * Change password.
 *
 *   POST /api/account/password  { currentPassword, newPassword }
 *
 * The current password must be re-entered, and a successful change revokes
 * every session (including this one) so a stolen session cannot survive a
 * password rotation.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { changePassword } from "@/server/services/accounts";
import { changePasswordSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.sensitive(), user.id);
    const { currentPassword, newPassword } = await parseJson(request, changePasswordSchema);
    await changePassword(user.id, currentPassword, newPassword);
    return jsonOk({ changed: true, sessionsRevoked: true });
  } catch (error) {
    return jsonError(error);
  }
}
