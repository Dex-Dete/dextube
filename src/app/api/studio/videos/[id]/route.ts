/**
 * Studio: a single owned video.
 *
 *   GET    /api/studio/videos/:id   full creator-facing record (drafts included)
 *   PATCH  /api/studio/videos/:id   edit title/description/tags/visibility/...
 *   DELETE /api/studio/videos/:id   soft-delete (immediately hidden everywhere)
 *
 * Ownership is enforced inside the service layer (`channel.ownerId = user.id`),
 * so a creator can only ever touch their own videos.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { deleteVideo, getOwnedVideo, updateVideoMetadata } from "@/server/services/videos";
import { updateVideoSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    return jsonOk({ video: await getOwnedVideo(id, user.id) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    const input = await parseJson(request, updateVideoSchema);
    await updateVideoMetadata(id, user.id, input);
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
    const hard = new URL(request.url).searchParams.get("hard") === "1";
    await deleteVideo(id, user.id, hard);
    return jsonOk({ deleted: true });
  } catch (error) {
    return jsonError(error);
  }
}
