import { jsonError, jsonOk, parseJson, clientIp, assertSameOrigin } from "@/lib/http";
import { loginSchema } from "@/lib/validation";
import { LIMITS, enforceRateLimit, resetRateLimit } from "@/server/auth/rate-limit";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { authenticate } from "@/server/services/accounts";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = logger.child({ mod: "auth" });

/**
 * POST /api/auth/login
 *
 * Throttled per IP *and* per identifier so neither a single attacker nor a
 * distributed attempt against one account can brute force credentials. The
 * error message is identical for "no such user" and "wrong password".
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ip = clientIp(request);
    const { identifier, password } = await parseJson(request, loginSchema);

    const identity = identifier.trim().toLowerCase().slice(0, 100);
    await enforceRateLimit(LIMITS.login(), `ip:${ip}`);
    await enforceRateLimit(LIMITS.login(), `id:${identity}`);

    const user = await authenticate(identifier, password);
    if (!user) {
      log.warn("failed sign-in", { identity, ip });
      throw new AppError("UNAUTHENTICATED", "Incorrect username or password.");
    }

    await resetRateLimit("login", `ip:${ip}`);
    await resetRateLimit("login", `id:${identity}`);

    const session = await createSession({
      userId: user.id,
      epoch: user.sessionEpoch,
      ip,
      userAgent: request.headers.get("user-agent"),
    });
    await setSessionCookie(session.token, session.session.expiresAt);

    return jsonOk({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
