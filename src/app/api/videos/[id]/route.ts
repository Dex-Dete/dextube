/**
 * A single video's full watch payload.
 *
 *   GET /api/videos/:id
 *
 * The watch page renders this on the server; the endpoint exists so the client
 * can refresh state (after a reaction, a moderation action, or a processing
 * transition) without a full page reload. Visibility is enforced in the
 * service, so an invisible video is a 404 here too.
 */
import { jsonError, jsonOk } from "@/lib/http";
import { getViewerContext } from "@/server/auth/session";
import { getVideoForWatch } from "@/server/services/videos";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const viewer = await getViewerContext();
    const video = await getVideoForWatch(id, { userId: viewer.userId, channelId: viewer.channelId });
    return jsonOk({ video }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
