/**
 * Preview an import without writing anything.
 *
 *   POST /api/admin/import/preview   { input, scopeLimit }
 *
 * Resolves the pasted source with the matching connector and returns the real
 * entries the operator would import, plus the connector's stated limitations.
 * Same-origin and rate-limited because it causes the server to fetch a remote
 * document on the administrator's behalf.
 */
import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { previewImport } from "@/server/services/import-sources";

export const dynamic = "force-dynamic";

const body = z.object({
  input: z.string().trim().min(1, "Enter a channel, playlist or export path.").max(2000),
  scopeLimit: z.number().int().min(1).max(100_000),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), admin.id);

    const input = await parseJson(request, body);
    return jsonOk(await previewImport(input));
  } catch (error) {
    return jsonError(error);
  }
}
