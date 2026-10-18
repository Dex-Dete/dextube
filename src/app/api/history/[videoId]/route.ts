/**
 * Remove a single entry from watch history.
 *
 *   DELETE /api/history/:videoId
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { cuidSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import { removeWatchHistoryEntry } from "@/server/services/videos";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ videoId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { videoId } = await context.params;
    cuidSchema.parse(videoId);
    await removeWatchHistoryEntry(user.id, videoId);
    return jsonOk({ removed: true });
  } catch (error) {
    return jsonError(error);
  }
}
