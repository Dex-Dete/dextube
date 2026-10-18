/**
 * A single comment.
 *
 *   PATCH  /api/comments/:id          { body }        — author only
 *   DELETE /api/comments/:id                          — author, video owner, moderator
 *
 * Both are rate limited because they are cheap to call and easy to abuse.
 */
import { assertSameOrigin, jsonError, jsonNoContent, jsonOk, parseJson } from "@/lib/http";
import { updateCommentSchema } from "@/lib/validation";
import { getViewerContext, requireUser } from "@/server/auth/session";
import { deleteComment, updateComment } from "@/server/services/comments";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { badRequest } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await enforceRateLimit(LIMITS.mutate(), user.id);

    const input = await parseJson(request, updateCommentSchema);
    const { comment } = await updateComment(id, user.id, input.body);
    return jsonOk({ comment });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await enforceRateLimit(LIMITS.mutate(), user.id);

    if (!id) throw badRequest("Missing comment id.");
    const viewer = await getViewerContext();
    await deleteComment(id, viewer);
    return jsonNoContent();
  } catch (error) {
    return jsonError(error);
  }
}
