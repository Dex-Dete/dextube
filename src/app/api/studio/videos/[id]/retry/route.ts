/**
 * Studio: retry a failed media processing run.
 *
 *   POST /api/studio/videos/:id/retry
 *
 * Ownership is enforced in the service; a video belonging to someone else is a
 * 404. The action re-enqueues the existing `media.process` job rather than
 * re-running the pipeline itself.
 */
import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { retryVideoProcessing } from "@/server/services/studio-videos";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    return jsonOk(await retryVideoProcessing(id, user.id));
  } catch (error) {
    return jsonError(error);
  }
}
