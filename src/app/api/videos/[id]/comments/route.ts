/**
 * Comments for one video.
 *
 *   GET  /api/videos/:id/comments?sort=top|newest&offset=&limit=
 *   POST /api/videos/:id/comments   { body, parentId? }
 *
 * Reading is public for any video the visitor may see; writing requires a
 * signed-in account. Rate limiting is applied per (user, video) by the caller
 * in `src/app/api/...` — see `rate-limit.ts`.
 */
import { assertSameOrigin, jsonCreated, jsonError, jsonOk, parseJson, parseQuery } from "@/lib/http";
import { createCommentSchema, paginationSchema, commentSortSchema } from "@/lib/validation";
import { getViewerContext, requireUser } from "@/server/auth/session";
import { createComment, listComments } from "@/server/services/comments";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { z } from "zod";

export const dynamic = "force-dynamic";

const query = paginationSchema.extend({
  sort: commentSortSchema.default("top"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { sort, offset, limit } = parseQuery(request, query);
    const viewer = await getViewerContext();
    const page = await listComments(id, { sort, offset, limit, viewer });
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id } = await context.params;

    // 20 comments per 5 minutes per account; cheap protection against spam loops.
    await enforceRateLimit(LIMITS.comment(), user.id);

    const input = await parseJson(request, createCommentSchema);
    const viewer = await getViewerContext();
    const { comment } = await createComment(id, viewer, { body: input.body, parentId: input.parentId });
    return jsonCreated({ comment });
  } catch (error) {
    return jsonError(error);
  }
}
