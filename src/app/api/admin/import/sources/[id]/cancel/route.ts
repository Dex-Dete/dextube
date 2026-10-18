/**
 * Request cancellation of an import.
 *
 *   POST /api/admin/import/sources/:id/cancel
 *
 * A running import stops at the next item boundary (it does not abort mid-item);
 * a source that is not running flips to CANCELLED immediately.
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { cancelImportSource } from "@/server/services/import-sources";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), admin.id);

    const { id } = await context.params;
    const { ip, userAgent } = auditContext(request);
    return jsonOk(
      await cancelImportSource(id, { userId: admin.id, label: admin.username, ip, userAgent }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
