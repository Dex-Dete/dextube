/**
 * Report a comment.
 *
 *   POST /api/comments/:id/report  { reason }
 *
 * Reports are idempotent per (comment, reporter): a second report by the same
 * person is accepted but does not create a duplicate row.
 */
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { reportSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import { reportComment } from "@/server/services/comments";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    const { reason } = await parseJson(request, reportSchema);
    return jsonOk(await reportComment(id, user.id, reason));
  } catch (error) {
    return jsonError(error);
  }
}
