/**
 * Administrator user list.
 *
 *   GET /api/admin/users   → { users, take }
 *
 * Bounded in the service (default 25, maximum 50). Never returns password
 * hashes. Reads are not throttled beyond the session gate.
 */
import { jsonError, jsonOk } from "@/lib/http";
import { requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { listAdminUsers } from "@/server/services/admin-users";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    assertAdminUsable(await requireAdmin());
    return jsonOk(await listAdminUsers());
  } catch (error) {
    return jsonError(error);
  }
}
