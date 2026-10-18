import { z } from "zod";
import { assertSameOrigin, clientIp, jsonError, jsonOk, parseJson } from "@/lib/http";
import { LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { requestPasswordReset } from "@/server/services/accounts";

export const dynamic = "force-dynamic";

const body = z.object({ email: z.string().trim().min(3).max(254) });

/**
 * POST /api/auth/password/request-reset
 *
 * Always responds 200 with the same body, whether or not the address has an
 * account, so the endpoint cannot be used to enumerate users.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(LIMITS.passwordReset(), clientIp(request));
    const { email } = await parseJson(request, body);
    await requestPasswordReset(email);
    return jsonOk({ accepted: true });
  } catch (error) {
    return jsonError(error);
  }
}
