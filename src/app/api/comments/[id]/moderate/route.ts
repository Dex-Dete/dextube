/**
 * Creator moderation of one comment.
 *
 *   POST /api/comments/:id/moderate  { action: "hide" | "unhide" | "pin" | "unpin" }
 *
 * Only the video's owner (or a moderator/admin) may call this; the service
 * re-checks ownership rather than trusting the route.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser, getViewerContext } from "@/server/auth/session";
import { setCommentHidden, setCommentPinned } from "@/server/services/comments";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

const body = z.object({
  action: z.enum(["hide", "unhide", "pin", "unpin"]),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    await enforceRateLimit(LIMITS.mutate(), user.id);

    const { action } = await parseJson(request, body);
    const viewer = await getViewerContext();

    if (action === "hide") return jsonOk(await setCommentHidden(id, viewer, true));
    if (action === "unhide") return jsonOk(await setCommentHidden(id, viewer, false));
    if (action === "pin") return jsonOk(await setCommentPinned(id, viewer, true));
    return jsonOk(await setCommentPinned(id, viewer, false));
  } catch (error) {
    return jsonError(error);
  }
}
