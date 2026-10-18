/**
 * Administrator system settings.
 *
 *   GET   /api/admin/settings   → bootstrap status + administrator count
 *   PATCH /api/admin/settings   { adminBootstrapEnabled: boolean }
 *
 * PATCH may only turn the bootstrap **off**; the service refuses `true` with a
 * 403, so re-arming it is impossible through the API (an operator with database
 * access must do it). Reads are safe; the mutation is same-origin and throttled.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { bootstrapStatus } from "@/server/services/admin-bootstrap";
import { setAdminBootstrapEnabled } from "@/server/services/system-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    assertAdminUsable(await requireAdmin());
    return jsonOk(await bootstrapStatus());
  } catch (error) {
    return jsonError(error);
  }
}

const patchBody = z.object({
  adminBootstrapEnabled: z.boolean(),
});

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), user.id);

    const { adminBootstrapEnabled } = await parseJson(request, patchBody);
    const { ip, userAgent } = auditContext(request);

    await setAdminBootstrapEnabled(adminBootstrapEnabled, {
      userId: user.id,
      label: user.username,
      ip,
      userAgent,
    });

    return jsonOk(await bootstrapStatus());
  } catch (error) {
    return jsonError(error);
  }
}
