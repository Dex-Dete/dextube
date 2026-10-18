/**
 * Playback progress.
 *
 *   PUT /api/videos/:id/progress  { positionSec, durationSec }
 *
 * Called periodically by the player so a viewer can resume where they left
 * off and so Studio can report real watch time. Positions are validated and
 * clamped server-side; the response is authoritative.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { getViewerContext, requireUser } from "@/server/auth/session";
import { saveWatchProgress } from "@/server/services/videos";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

const body = z.object({
  positionSec: z.number().finite().min(0).max(86_400),
  durationSec: z.number().finite().min(0).max(86_400).default(0),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await enforceRateLimit(LIMITS.mutate(), user.id);

    const input = await parseJson(request, body);
    const viewer = await getViewerContext();
    const result = await saveWatchProgress(
      id,
      user.id,
      { positionSec: input.positionSec, durationSec: input.durationSec },
      viewer.channelId,
    );
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
