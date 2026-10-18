import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { feedQuerySchema } from "@/lib/validation";
import { getCurrentUser } from "@/server/auth/session";
import { getFeed, getShortsFeed } from "@/server/services/videos";
import { getRankedHomeFeed } from "@/server/recsys";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = feedQuerySchema.extend({
  offset: z.coerce.number().int().min(0).max(400).optional(),
});

/**
 * GET /api/feed
 *
 *  ?tab=home           → ranked home feed (offset pagination)
 *  ?tab=subscriptions  → newest from subscribed channels (keyset cursor)
 *  ?tab=trending       → engagement-weighted list (keyset cursor)
 *  ?tab=shorts         → vertical shorts (keyset cursor)
 *
 * Visibility filtering happens inside the service; this handler only shapes
 * the response.
 */
export async function GET(request: Request) {
  try {
    const query = parseQuery(request, schema);
    const user = await getCurrentUser();
    const viewerId = user?.id ?? null;
    const viewerChannelId = user?.channel?.id ?? null;

    if (query.tab === "shorts") {
      const page = await getShortsFeed({ viewerId, cursor: query.cursor, limit: query.limit });
      return jsonOk({ items: page.items, nextCursor: page.nextCursor, nextOffset: null });
    }

    if (query.tab === "home" && !query.category) {
      const page = await getRankedHomeFeed({
        userId: viewerId,
        offset: query.offset ?? 0,
        limit: query.limit,
      });
      return jsonOk({
        items: page.items,
        nextCursor: null,
        nextOffset: page.nextOffset,
        strategy: page.strategy,
        rankingVersion: page.rankingVersion,
      });
    }

    const page = await getFeed({
      tab: query.tab === "home" ? "home" : query.tab,
      viewerId,
      viewerChannelId,
      cursor: query.cursor,
      limit: query.limit,
      category: query.category,
    });
    return jsonOk({ items: page.items, nextCursor: page.nextCursor, nextOffset: null });
  } catch (error) {
    return jsonError(error);
  }
}
