/**
 * Watch history.
 *
 *   GET    /api/history?cursor=&limit=   list the caller's history
 *   DELETE /api/history                  clear it
 *
 * Scoped to the session user. Users who disabled `saveWatchHistory` never get
 * rows written in the first place (see `recordView`), so this returns empty.
 */
import { assertSameOrigin, jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { clearWatchHistory, listWatchHistory } from "@/server/services/videos";
import { paginationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { cursor, limit } = parseQuery(request, paginationSchema);
    return jsonOk(await listWatchHistory(user.id, cursor, limit));
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const removed = await clearWatchHistory(user.id);
    return jsonOk({ removed });
  } catch (error) {
    return jsonError(error);
  }
}
