import { assertSameOrigin, jsonError, jsonOk } from "@/lib/http";
import { clearSessionCookie, revokeCurrentSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/** POST /api/auth/logout — revokes the current session and clears the cookie. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await revokeCurrentSession();
    await clearSessionCookie();
    return jsonOk({ signedOut: true });
  } catch (error) {
    return jsonError(error);
  }
}
