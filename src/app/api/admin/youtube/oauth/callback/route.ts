import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { requireAdmin } from "@/server/auth/admin";
import { assertAdminUsable } from "@/server/auth/admin-usable";
import { stateMatches, verifyOwnedChannel } from "@/server/services/youtube-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const destination = new URL("/admin/import", getConfig().appUrl);
  try {
    assertAdminUsable(await requireAdmin());
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const receivedState = url.searchParams.get("state") ?? "";
    const jar = await cookies();
    const expectedState = jar.get("dextube_youtube_oauth_state")?.value ?? "";
    const verifier = jar.get("dextube_youtube_oauth_verifier")?.value ?? "";
    if (!code || !verifier || !stateMatches(expectedState, receivedState)) throw new Error("invalid oauth state");
    const channel = await verifyOwnedChannel(code, verifier);
    destination.searchParams.set("youtube", "verified");
    destination.searchParams.set("channelId", channel.id);
    destination.searchParams.set("title", channel.title);
  } catch {
    destination.searchParams.set("youtube", "verification-failed");
  }
  const response = NextResponse.redirect(destination);
  response.cookies.delete("dextube_youtube_oauth_state");
  response.cookies.delete("dextube_youtube_oauth_verifier");
  return response;
}
