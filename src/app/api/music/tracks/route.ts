/**
 * GET /api/music/tracks — the public DEX Music library.
 *
 * A bounded, offset-paginated page of PUBLIC, non-deleted tracks with their
 * rights metadata. This is the endpoint the library's "Load more" control uses;
 * the initial page is rendered on the server from the same service call.
 *
 * Reads are public (like `/api/feed`), so no session is required. Visibility is
 * enforced inside the service, never here.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { listTracks, MUSIC_PAGE_SIZE_DEFAULT, MUSIC_PAGE_SIZE_MAX } from "@/server/services/music";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(MUSIC_PAGE_SIZE_MAX).default(MUSIC_PAGE_SIZE_DEFAULT),
});

export async function GET(request: Request) {
  try {
    const { offset, limit } = parseQuery(request, querySchema);
    const page = await listTracks({ offset, limit });
    return jsonOk(
      { items: page.items, nextOffset: page.nextOffset },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
