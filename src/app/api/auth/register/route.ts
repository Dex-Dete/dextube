import { NextResponse } from "next/server";
import { assertSameOrigin, clientIp, jsonError, parseJson } from "@/lib/http";
import { registerSchema } from "@/lib/validation";
import { LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { createSession, setSessionCookie } from "@/server/auth/session";
import { registerUser } from "@/server/services/accounts";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register
 *
 * Creates the account, its channel and an email-verification token, then signs
 * the new user in. Rate limited per IP to slow automated sign-ups.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ip = clientIp(request);
    await enforceRateLimit(LIMITS.register(), ip);

    const input = await parseJson(request, registerSchema);
    const result = await registerUser(input);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { sessionEpoch: true },
    });
    const session = await createSession({
      userId: result.userId,
      epoch: user.sessionEpoch,
      ip,
      userAgent: request.headers.get("user-agent"),
    });
    await setSessionCookie(session.token, session.session.expiresAt);

    return NextResponse.json(
      {
        user: {
          id: result.userId,
          username: input.username,
          displayName: input.displayName,
          handle: result.handle,
        },
        emailTransport: result.emailTransport,
        // Only returned outside production: the documented local-dev flow when
        // no SMTP host is configured.
        ...(process.env.NODE_ENV === "production" ? {} : { verificationLink: result.verificationLink }),
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
