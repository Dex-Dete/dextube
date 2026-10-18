/**
 * One playlist.
 *
 *   GET    /api/playlists/:id            → contents (privacy enforced)
 *   PATCH  /api/playlists/:id            → rename, describe, change visibility, reorder
 *   DELETE /api/playlists/:id
 */
import { assertSameOrigin, jsonError, jsonNoContent, jsonOk, parseJson, parseQuery } from "@/lib/http";
import { paginationSchema, updatePlaylistSchema } from "@/lib/validation";
import { getViewerContext, requireUser } from "@/server/auth/session";
import { deletePlaylist, getPlaylist, isSystemKind, systemPlaylistId, updatePlaylist } from "@/server/services/playlists";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { notFound } from "@/lib/errors";
import { z } from "zod";

export const dynamic = "force-dynamic";

const query = paginationSchema.extend({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { offset, limit } = parseQuery(request, query);
    const viewer = await getViewerContext();

    // `:id` may be a system kind (`watch_later`, `liked_videos`): resolve it to
    // the signed-in user's own playlist so the UI can link them by name.
    let playlistId = id;
    if (isSystemKind(id)) {
      if (!viewer.userId) throw notFound("That playlist does not exist.");
      playlistId = await systemPlaylistId(viewer.userId, id);
    }

    const page = await getPlaylist(playlistId, viewer, { offset, limit });
    return jsonOk(page);
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
    const input = await parseJson(request, updatePlaylistSchema);
    return jsonOk(await updatePlaylist(user.id, id, input));
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
    await deletePlaylist(user.id, id);
    return jsonNoContent();
  } catch (error) {
    return jsonError(error);
  }
}
