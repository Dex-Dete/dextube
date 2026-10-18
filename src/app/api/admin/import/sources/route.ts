/**
 * Import sources.
 *
 *   GET  /api/admin/import/sources   → { sources }
 *   POST /api/admin/import/sources   { input, scopeLimit, authorizationBasis, mediaAuthorized, concurrency? }
 *
 * The POST is the commit step after a preview: it persists the source and one
 * item per entry. It does not start the run — the client calls `/run` next, so a
 * slow import does not block the create response.
 */
import { z } from "zod";
import { assertSameOrigin, jsonCreated, jsonError, jsonOk, parseJson } from "@/lib/http";
import { auditContext, requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { enforceRateLimit, LIMITS } from "@/server/auth/rate-limit";
import { createImportSource, importStorageSummary, listImportSources } from "@/server/services/import-sources";

export const dynamic = "force-dynamic";

const body = z.object({
  input: z.string().trim().min(1, "Enter a channel, playlist or export path.").max(2000),
  scopeLimit: z.number().int().min(1).max(100_000),
  authorizationBasis: z.string().max(500).default(""),
  mediaAuthorized: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(64).optional(),
});

export async function GET() {
  try {
    assertAdminUsable(await requireAdmin());
    const [sources, storage] = await Promise.all([listImportSources(), importStorageSummary()]);
    return jsonOk({ sources, storage });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = assertAdminUsable(await requireAdmin());
    await enforceRateLimit(LIMITS.mutate(), admin.id);

    const input = await parseJson(request, body);
    const { ip, userAgent } = auditContext(request);
    const result = await createImportSource({
      ...input,
      actor: { userId: admin.id, label: admin.username, ip, userAgent },
    });
    return jsonCreated(result);
  } catch (error) {
    return jsonError(error);
  }
}
