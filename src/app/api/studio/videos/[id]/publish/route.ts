/**
 * Studio: publish / unpublish a video.
 *
 *   POST   /api/studio/videos/:id/publish    { visibility }  (default PUBLIC)
 *   DELETE /api/studio/videos/:id/publish                    (back to private)
 *
 * A video can only be published once processing is READY; the service refuses
 * otherwise with a helpful message rather than silently doing nothing.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { getOwnedVideo, publishVideo, unpublishVideo } from "@/server/services/videos";
import { publishVideoSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    const { visibility } = await parseJson(request, publishVideoSchema);
    await publishVideo(id, user.id, visibility);
    return jsonOk({ video: await getOwnedVideo(id, user.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    await unpublishVideo(id, user.id);
    return jsonOk({ video: await getOwnedVideo(id, user.id) });
  } catch (error) {
    return jsonError(error);
  }
}
