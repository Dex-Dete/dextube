/**
 * Replies to one comment thread.
 *
 *   GET /api/comments/:id/replies?offset=&limit=
 */
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { paginationSchema } from "@/lib/validation";
import { getViewerContext } from "@/server/auth/session";
import { listReplies } from "@/server/services/comments";
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
    const page = await listReplies(id, { offset, limit, viewer });
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}
