/**
 * Studio: the creator's own video list.
 *
 *   GET /api/studio/videos?q=&status=&visibility=&cursor=&limit=
 *
 * Scoped to the signed-in user's channel; includes drafts, unlisted and failed
 * uploads that never appear in any public listing.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { listStudioVideos } from "@/server/services/videos";
import { paginationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const query = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["DRAFT", "PROCESSING", "READY", "FAILED"]).optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { q, status, visibility, cursor, limit } = parseQuery(request, query);
    return jsonOk(await listStudioVideos({ userId: user.id, query: q, status, visibility, cursor, limit }));
  } catch (error) {
    return jsonError(error);
  }
}
