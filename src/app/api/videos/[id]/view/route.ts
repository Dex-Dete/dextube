/**
 * View ping.
 *
 *   POST /api/videos/:id/view
 *
 * Called by the player once playback actually starts (not on page load), so
 * "views" mean something. De-duplication, owner exclusion and daily-stat
 * rollups all happen inside `recordView`.
 */
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/lib/http";
import { getViewerContext } from "@/server/auth/session";
import { recordView } from "@/server/services/videos";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { id } = await context.params;
    const viewer = await getViewerContext();

    // Anonymous viewers are limited by IP; signed-in viewers by user id.
    await enforceRateLimit(
      LIMITS.view(),
      viewer.userId ?? clientIp(request),
    );

    const result = await recordView(id, {
      userId: viewer.userId,
      channelId: viewer.channelId,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent") ?? "",
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
