/**
 * Mark notifications read.
 *
 *   POST /api/notifications/read  { ids?: string[] }   omit `ids` to mark all
 *
 * Scoped to the session user inside the service, so a caller cannot mark
 * another account's notifications as read.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { notificationService } from "@/server/services/notifications";
import { cuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const body = z.object({ ids: z.array(cuidSchema).max(200).optional() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { ids } = await parseJson(request, body);

    let updated = 0;
    if (ids && ids.length > 0) {
      for (const id of ids) {
        if (await notificationService.markRead(user.id, id)) updated++;
      }
    } else {
      updated = await notificationService.markAllRead(user.id);
    }
    return jsonOk({ updated, unread: await notificationService.unreadCount(user.id) });
  } catch (error) {
    return jsonError(error);
  }
}
