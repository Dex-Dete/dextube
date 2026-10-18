import { jsonError, jsonOk } from "@/lib/http";
import { getCurrentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session
 *
 * Returns the signed-in user or `null`. Used by client components (and the
 * end-to-end tests) to assert that a session survives a page refresh.
 */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return jsonOk({ user: null });
    return jsonOk({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        emailVerified: user.emailVerified,
        avatarKey: user.avatarKey,
        channel: user.channel,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
