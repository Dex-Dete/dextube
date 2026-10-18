/**
 * A comment's like state.
 *
 *   PUT    /api/comments/:id/like   → like (idempotent)
 *   DELETE /api/comments/:id/like   → unlike (idempotent)
 *
 * Idempotency matters: the UI may fire the same intent twice from an optimistic
 * update, and the counts must not drift.
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { setCommentLike } from "@/server/services/comments";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

async function apply(request: Request, context: { params: Promise<{ id: string }> }, liked: boolean) {
  assertSameOrigin(request);
  const user = await requireUser();
  const { id } = await context.params;
  await enforceRateLimit(LIMITS.mutate(), user.id);
  return jsonOk(await setCommentLike(id, user.id, liked));
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await apply(request, context, true);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await apply(request, context, false);
  } catch (error) {
    return jsonError(error);
  }
}
