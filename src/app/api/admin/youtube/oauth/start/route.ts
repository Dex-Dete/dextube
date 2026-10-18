import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { getConfig } from "@/lib/config";
import { createOAuthState, authorizationUrl, youtubeOAuthConfigured } from "@/server/services/youtube-oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    assertAdminUsable(await requireAdmin());
    if (!youtubeOAuthConfigured()) return NextResponse.redirect(new URL("/admin/import?youtube=not-configured", getConfig().appUrl));
    const state = createOAuthState();
    const response = NextResponse.redirect(authorizationUrl(state));
    const secure = getConfig().session.cookieSecure;
    for (const [name, value] of [["dextube_youtube_oauth_state", state.state], ["dextube_youtube_oauth_verifier", state.verifier]] as const) {
      response.cookies.set({ name, value, httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 600 });
    }
    return response;
  } catch {
    return NextResponse.redirect(new URL("/admin/import?youtube=not-authorized", getConfig().appUrl));
  }
}
