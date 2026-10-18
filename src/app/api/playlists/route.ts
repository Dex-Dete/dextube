/**
 * The viewer's playlists.
 *
 *   GET  /api/playlists                 → own playlists + whether they contain :videoId
 *   POST /api/playlists  { title, description?, visibility? }
 */
import { z } from "zod";
import { assertSameOrigin, jsonCreated, jsonError, jsonOk, parseJson, parseQuery } from "@/lib/http";
import { createPlaylistSchema, cuidSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/session";
import { createPlaylist, listOwnPlaylists } from "@/server/services/playlists";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { videoId } = parseQuery(request, z.object({ videoId: cuidSchema.optional() }));
    const playlists = await listOwnPlaylists(user.id, videoId);
    return jsonOk({ playlists }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const input = await parseJson(request, createPlaylistSchema);
    const playlist = await createPlaylist(user.id, {
      title: input.title,
      description: input.description,
      visibility: input.visibility,
    });
    return jsonCreated({ playlist });
  } catch (error) {
    return jsonError(error);
  }
}
