import { z } from "zod";
import { assertSameOrigin, jsonCreated, jsonError, jsonOk, parseJson } from "@/lib/http";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { issueToken, verifyEmail } from "@/server/services/accounts";
import { requireUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

const verifyBody = z.object({ token: z.string().min(16).max(256) });

/**
 * POST /api/auth/verify-email — consumes a verification token.
 * Body: `{ token }`
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { token } = await parseJson(request, verifyBody);
    const { userId } = await verifyEmail(token);
    return jsonOk({ verified: true, userId });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * PUT /api/auth/verify-email — re-sends the verification email for the
 * signed-in account. Rate limited so it cannot be used to spam a mailbox.
 */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    if (user.emailVerified) return jsonOk({ alreadyVerified: true });

    await enforceRateLimit({ scope: "verify-resend", limit: 3, windowMs: 60 * 60_000 }, user.id);
    const issued = await issueToken(user.id, "EMAIL_VERIFICATION");
    return jsonCreated({
      sent: true,
      transport: issued.transport,
      ...(process.env.NODE_ENV === "production" ? {} : { verificationLink: issued.link }),
    });
  } catch (error) {
    return jsonError(error);
  }
}
