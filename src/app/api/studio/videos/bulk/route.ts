/**
 * Studio: bulk lifecycle actions on the creator's own videos.
 *
 *   POST /api/studio/videos/bulk  { action, ids }
 *
 * Each id is authorised and mutated individually through the `videos.ts`
 * service functions, so a foreign or missing id fails closed and is reported in
 * the response rather than being skipped silently. Actions never roll back what
 * already succeeded; the caller is told exactly which ids failed and why.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireUser } from "@/server/auth/session";
import { bulkVideoAction } from "@/server/services/studio-videos";
import { cuidSchema } from "@/lib/validation";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";

export const dynamic = "force-dynamic";

/** An explicit, documented ceiling so one request cannot fan out unbounded. */
const BULK_MAX_IDS = 100;

const body = z.object({
  action: z.enum(["publish", "unpublish", "delete"]),
  ids: z.array(cuidSchema).min(1, "Select at least one video.").max(BULK_MAX_IDS, `Select at most ${BULK_MAX_IDS} videos.`),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    await enforceRateLimit(LIMITS.mutate(), user.id);
    const { action, ids } = await parseJson(request, body);

    const results = await bulkVideoAction(user.id, action, ids);
    return jsonOk({
      results,
      succeeded: results.filter((r) => r.ok).map((r) => r.id),
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error ?? "Update failed." })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
