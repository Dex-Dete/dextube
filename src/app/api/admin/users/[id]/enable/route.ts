/**
 * Re-enable a suspended account.
 *
 *   POST /api/admin/users/:id/enable
 *
 * Clears the suspension flag and reason and audits the change. Sessions revoked
 * when the account was disabled are not restored; the user must sign in again.
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { enableUser } from "@/server/services/admin-users";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), actor.id);

    const { id } = await context.params;
    const { ip, userAgent } = auditContext(request);

    const user = await enableUser(id, { userId: actor.id, username: actor.username, ip, userAgent });
    return jsonOk({ user });
  } catch (error) {
    return jsonError(error);
  }
}
