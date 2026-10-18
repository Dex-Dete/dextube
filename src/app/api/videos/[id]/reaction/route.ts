/**
 * Like / dislike a video.
 *
 *   PUT    /api/videos/:id/reaction  { value: "LIKE" | "DISLIKE" }
 *   DELETE /api/videos/:id/reaction
 *
 * Idempotent, and the returned counts are authoritative so an optimistic UI can
 * always reconcile rather than drifting.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { setReaction } from "@/server/services/videos";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

const body = z.object({ value: z.enum(["LIKE", "DISLIKE"]) });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    const { value } = await parseJson(request, body);
    return jsonOk(await setReaction(id, user.id, value));
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
    return jsonOk(await setReaction(id, user.id, null));
  } catch (error) {
    return jsonError(error);
  }
}
