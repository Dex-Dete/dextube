/**
 * Disable (suspend) an account.
 *
 *   POST /api/admin/users/:id/disable   { confirm: string, reason?: string }
 *
 * `confirm` must equal the target's username — a guard against a stray click.
 * A mismatch is a 422. The service suspends the account, bumps its session
 * epoch, revokes every session and burns outstanding tokens in one transaction.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { disableUser } from "@/server/services/admin-users";

export const dynamic = "force-dynamic";

const body = z.object({
  confirm: z.string().min(1, "Type the account's username to confirm.").max(64),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), actor.id);

    const { id } = await context.params;
    const { confirm, reason } = await parseJson(request, body);
    const { ip, userAgent } = auditContext(request);

    const user = await disableUser(
      id,
      { userId: actor.id, username: actor.username, ip, userAgent },
      { confirm, reason },
    );
    return jsonOk({ user });
  } catch (error) {
    return jsonError(error);
  }
}
