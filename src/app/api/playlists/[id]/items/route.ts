/**
 * Add or remove a video from a playlist.
 *
 *   PUT    /api/playlists/:id/items  { videoId }
 *   DELETE /api/playlists/:id/items?videoId=...
 *
 * `:id` may also be a system kind (`watch_later`, `liked_videos`) so the UI can
 * use the same code path for built-in playlists.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson, parseQuery } from "@/lib/http";
import { cuidSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import {
  addVideoToPlaylist,
  isSystemKind,
  removeVideoFromPlaylist,
  systemPlaylistId,
  toggleSystemPlaylist,
} from "@/server/services/playlists";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { id } = await context.params;
    const { videoId } = await parseJson(request, z.object({ videoId: cuidSchema }));

    if (isSystemKind(id)) {
      return jsonOk(await toggleSystemPlaylist(user.id, videoId, id, true));
    }
    return jsonOk(await addVideoToPlaylist(user.id, id, videoId));
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
    const { videoId } = parseQuery(request, z.object({ videoId: cuidSchema }));

    if (isSystemKind(id)) {
      return jsonOk(await toggleSystemPlaylist(user.id, videoId, id, false));
    }
    return jsonOk(await removeVideoFromPlaylist(user.id, id, videoId));
  } catch (error) {
    return jsonError(error);
  }
}

/** Resolves a system kind to its concrete playlist id (used when linking). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;
    if (!isSystemKind(id)) return jsonOk({ resolved: false });
    return jsonOk({ resolved: true, playlistId: await systemPlaylistId(user.id, id) });
  } catch (error) {
    return jsonError(error);
  }
}
