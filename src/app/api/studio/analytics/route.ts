/**
 * Studio: analytics overview.
 *
 *   GET /api/studio/analytics?range=7d|28d|90d|365d&refresh=1
 *
 * Reads pre-aggregated daily rows (never raw event scans) so the dashboard is
 * cheap regardless of traffic. `refresh=1` queues a same-day rollup on demand.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { requireOwnedChannelId } from "@/server/services/channels";
import { ensureTodayAggregated, getStudioOverview } from "@/server/services/analytics";
import { analyticsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const query = analyticsQuerySchema.extend({
  /** Query strings are always strings; "1"/"true" mean yes. */
  refresh: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const parsed = parseQuery(request, query);
    const channelId = await requireOwnedChannelId(user.id);
    if (parsed.refresh) await ensureTodayAggregated();
    return jsonOk(await getStudioOverview(channelId, parsed.range));
  } catch (error) {
    return jsonError(error);
  }
}
