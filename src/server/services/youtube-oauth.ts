import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const YOUTUBE_CHANNELS = "https://www.googleapis.com/youtube/v3/channels";

export function youtubeOAuthConfigured(): boolean {
  const oauth = getConfig().imports.youtubeOAuth;
  return Boolean(oauth.clientId && oauth.clientSecret && oauth.redirectUri);
}

export function createOAuthState(): { state: string; verifier: string; challenge: string } {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizationUrl(input: { state: string; challenge: string }): string {
  const oauth = getConfig().imports.youtubeOAuth;
  if (!oauth.clientId || !oauth.clientSecret) throw new AppError("PRECONDITION_FAILED", "YouTube OAuth is not configured.");
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function verifyOwnedChannel(code: string, verifier: string): Promise<{ id: string; title: string }> {
  const oauth = getConfig().imports.youtubeOAuth;
  if (!oauth.clientId || !oauth.clientSecret) throw new AppError("PRECONDITION_FAILED", "YouTube OAuth is not configured.");
  const tokenResponse = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: oauth.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new AppError("UNAUTHENTICATED", "YouTube authorization could not be verified.");
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new AppError("UNAUTHENTICATED", "YouTube did not return an access token.");

  const channelsResponse = await fetch(`${YOUTUBE_CHANNELS}?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!channelsResponse.ok) throw new AppError("UNAUTHENTICATED", "YouTube ownership could not be verified.");
  const payload = (await channelsResponse.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
  const channel = payload.items?.[0];
  if (!channel?.id) throw new AppError("PRECONDITION_FAILED", "The authenticated YouTube account has no channel.");
  return { id: channel.id, title: channel.snippet?.title ?? "YouTube channel" };
}
