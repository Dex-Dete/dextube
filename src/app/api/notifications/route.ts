/**
 * Notifications inbox.
 *
 *   GET /api/notifications?cursor=&limit=   list the signed-in user's notifications
 *
 * Only ever returns the caller's own rows — the userId comes from the session,
 * never from the request, so one account can never read another's inbox.
 */
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { notificationService } from "@/server/services/notifications";
import { paginationSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { cursor, limit } = parseQuery(request, paginationSchema);
    const [page, unread] = await Promise.all([
      notificationService.listForUser(user.id, cursor, limit),
      notificationService.unreadCount(user.id),
    ]);
    return jsonOk({ ...page, unread });
  } catch (error) {
    return jsonError(error);
  }
}
