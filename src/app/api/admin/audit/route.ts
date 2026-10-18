/**
 * Recent administrator audit entries.
 *
 *   GET /api/admin/audit?take=50   → { entries }
 *
 * `take` is bounded (1–200) so the log can never be dumped in one request.
 */
import { z } from "zod";
import { jsonError, jsonOk, parseQuery } from "@/lib/http";
import { requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { listAuditLog } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const query = z.object({
  take: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request) {
  try {
    assertAdminUsable(await requireAdmin());
    const { take } = parseQuery(request, query);
    return jsonOk({ entries: await listAuditLog({ take }) });
  } catch (error) {
    return jsonError(error);
  }
}
