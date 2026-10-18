/**
 * Studio: reported comments for one of the creator's videos.
 *
 *   GET /api/studio/videos/:id/reports
 *
 * Only the video's owner (or a moderator) may read the report queue; the service
 * enforces that, so a creator cannot see reports for someone else's video.
 */
import { jsonError, jsonOk } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { listReportedComments } from "@/server/services/comments";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const reports = await listReportedComments(id, {
      userId: user.id,
      channelId: user.channel?.id ?? null,
      role: user.role,
    });
    return jsonOk({ reports });
  } catch (error) {
    return jsonError(error);
  }
}
