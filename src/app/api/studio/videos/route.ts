/**
 * Studio: the creator's own video list.
 *
 *   GET /api/studio/videos?q=&status=&visibility=&sort=&direction=&page=&limit=
 *
 * Scoped to the signed-in user's channel; includes drafts, unlisted and failed
 * uploads that never appear in any public listing. Pagination is offset-based
 * and the page size is capped (see `STUDIO_PAGE_SIZE_MAX`).
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { listStudioVideoPage, STUDIO_PAGE_SIZE_MAX, STUDIO_SORTS } from "@/server/services/studio-videos";

export const dynamic = "force-dynamic";

const query = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["DRAFT", "PROCESSING", "READY", "FAILED"]).optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
  sort: z.enum(STUDIO_SORTS).default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(STUDIO_PAGE_SIZE_MAX).default(20),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { q, status, visibility, sort, direction, page, limit } = parseQuery(request, query);
    return jsonOk(
      await listStudioVideoPage({
        userId: user.id,
        query: q,
        status,
        visibility,
        sort,
        direction,
        page,
        pageSize: limit,
      }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
