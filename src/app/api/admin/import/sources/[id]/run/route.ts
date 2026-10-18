/**
 * Start (or resume) an import run.
 *
 *   POST /api/admin/import/sources/:id/run
 *
 * The run is claimed atomically inside the service: a second call while one is
 * in flight is a 409, never a double import.
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { runImportSource } from "@/server/services/import-sources";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), admin.id);

    const { id } = await context.params;
    const { ip, userAgent } = auditContext(request);
    return jsonOk(
      await runImportSource(id, { userId: admin.id, label: admin.username, ip, userAgent }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
