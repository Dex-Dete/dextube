/**
 * Studio: reported comments for one of the creator's videos.
 *
 *   GET /api/studio/videos/:id/reports?page=&limit=
 *
 * Only the video's owner (or a moderator) may read the report queue; the service
 * enforces that, so a creator cannot see reports for someone else's video. The
 * queue is paginated and its page size is capped server-side.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { listReportedComments, REPORT_PAGE_SIZE_MAX } from "@/server/services/comments";

export const dynamic = "force-dynamic";

const query = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(REPORT_PAGE_SIZE_MAX).default(20),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const { page, limit } = parseQuery(request, query);
    const reports = await listReportedComments(
      id,
      {
        userId: user.id,
        channelId: user.channel?.id ?? null,
        role: user.role,
      },
      { page, pageSize: limit },
    );
    return jsonOk(reports);
  } catch (error) {
    return jsonError(error);
  }
}
