/**
 * Search.
 *
 *   GET /api/search?q=&type=&duration=&sort=&cursor=&limit=
 *
 * Returns videos (cursor-paginated), plus a bounded set of matching channels
 * and public playlists for the first page. Everything is filtered to publicly
 * visible rows, so search cannot leak private media.
 */
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { getViewerContext } from "@/server/auth/session";
import { search } from "@/server/services/search";
import { searchQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseQuery(request, searchQuerySchema);
    const viewer = await getViewerContext();
    const results = await search({
      query: input.q,
      viewerChannelId: viewer.channelId,
      type: input.type,
      duration: input.duration,
      sort: input.sort,
      cursor: input.cursor,
      limit: input.limit,
    });
    return jsonOk({
      query: input.q,
      // `items` is the cursor-paginated video list; `videos` is the same array
      // under a descriptive name for first-page rendering.
      items: results.videos,
      videos: results.videos,
      nextCursor: results.nextCursor,
      channels: results.channels,
      playlists: results.playlists,
    });
  } catch (error) {
    return jsonError(error);
  }
}
