/**
 * Recommendation feedback.
 *
 *   POST   /api/feed/feedback  { action: "not_interested" | "hide_channel" | "reset", videoId?, channelId? }
 *   DELETE /api/feed/feedback?videoId=…  |  ?channelId=…    — undo one dismissal
 *
 * The response always reports the viewer's current totals, so the client can
 * render an accurate state without a follow-up request and without guessing.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import {
  applyRecommendationFeedback,
  undoRecommendationFeedback,
} from "@/server/services/feedback";

export const dynamic = "force-dynamic";

const postBody = z.object({
  action: z.enum(["not_interested", "hide_channel", "reset"]),
  videoId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
});

const deleteQuery = z
  .object({
    videoId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.videoId) !== Boolean(value.channelId), {
    message: "Provide exactly one of videoId or channelId.",
  });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, postBody);
    return jsonOk(
      await applyRecommendationFeedback({
        userId: user.id,
        action: input.action,
        videoId: input.videoId ?? null,
        channelId: input.channelId ?? null,
      }),
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const query = parseQuery(request, deleteQuery);
    return jsonOk(
      await undoRecommendationFeedback({
        userId: user.id,
        videoId: query.videoId ?? null,
        channelId: query.channelId ?? null,
      }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
