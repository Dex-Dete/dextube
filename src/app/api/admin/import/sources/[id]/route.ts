/**
 * One import source.
 *
 *   GET    /api/admin/import/sources/:id                 → { source, items }
 *   DELETE /api/admin/import/sources/:id?deleteMedia=1   → opt into deleting created videos
 *
 * A missing source is a 404. The DELETE keeps imported videos by default; the
 * `deleteMedia` query opts into removing them, which the UI labels as
 * destructive.
 */
import { notFound } from "@/lib/errors";
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { deleteImportSource, getImportSource, importStorageSummary } from "@/server/services/import-sources";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertAdminUsable(await requireAdmin());
    const { id } = await context.params;
    const result = await getImportSource(id);
    if (!result) throw notFound("That import source does not exist.");
    return jsonOk({ ...result, storage: await importStorageSummary() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const admin = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), admin.id);

    const { id } = await context.params;
    const deleteMedia = new URL(request.url).searchParams.get("deleteMedia") === "1";
    const { ip, userAgent } = auditContext(request);

    const result = await deleteImportSource(
      id,
      { userId: admin.id, label: admin.username, ip, userAgent },
      { deleteImportedVideos: deleteMedia },
    );
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
