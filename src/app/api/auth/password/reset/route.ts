import { z } from "zod";
import { assertSameOrigin, jsonError, jsonOk, parseJson } from "@/lib/http";
import { passwordSchema } from "@/lib/validation";
import { LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { clientIp } from "@/lib/http";
import { resetPasswordWithToken } from "@/server/services/accounts";

export const dynamic = "force-dynamic";

const body = z.object({
  token: z.string().min(16, "This reset link is invalid.").max(256),
  password: passwordSchema,
});

/**
 * POST /api/auth/password/reset — consumes a single-use reset token and sets
 * the new password. Every existing session is revoked afterwards.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(LIMITS.passwordReset(), clientIp(request));
    const { token, password } = await parseJson(request, body);
    await resetPasswordWithToken(token, password);
    return jsonOk({ reset: true });
  } catch (error) {
    return jsonError(error);
  }
}
