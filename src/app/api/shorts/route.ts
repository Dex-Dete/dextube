/**
 * Shorts feed.
 *
 *   GET /api/shorts?cursor=&limit=
 *
 * Public. Only PUBLIC + READY vertical videos are returned; the viewer id is
 * used purely to exclude a creator's own shorts from their own feed when the
 * recommender asks for it.
 */
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { getCurrentUser } from "@/server/auth/session";
import { getShortsFeed } from "@/server/services/videos";
import { paginationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { cursor, limit } = parseQuery(request, paginationSchema);
    const user = await getCurrentUser();
    return jsonOk(await getShortsFeed({ viewerId: user?.id ?? null, cursor, limit }));
  } catch (error) {
    return jsonError(error);
  }
}
