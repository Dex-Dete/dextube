/**
 * Session management.
 *
 * Design notes
 *  * The browser holds an **opaque random token** in an httpOnly cookie.
 *  * Only the SHA-256 hash of that token is stored, so a database leak does
 *    not hand out live sessions.
 *  * `User.sessionEpoch` allows instant global invalidation: sessions store the
 *    epoch they were created with and are rejected once the user's epoch is
 *    bumped (password change, "sign out everywhere", account compromise).
 *  * Cookie flags: httpOnly, SameSite=Lax, Secure and `__Host-` when the app is
 *    served over HTTPS (see `src/lib/session-cookie.ts`)
 *    prefix in production (which additionally requires Path=/ and no Domain).
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { AppError, unauthenticated } from "@/lib/errors";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  avatarKey: string | null;
  emailVerified: boolean;
  isSuspended: boolean;
  saveWatchHistory: boolean;
  showLikesPublicly: boolean;
  sessionEpoch: number;
  createdAt: Date;
  channel: {
    id: string;
    handle: string;
    name: string;
    avatarKey: string | null;
    bannerKey: string | null;
    subscriberCount: number;
  } | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  epoch: number;
  expiresAt: Date;
}

/* ------------------------------------------------------------------ tokens */

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison for equal-length hex digests. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ cookies */

function cookieOptions(expiresAt: Date) {
  const config = getConfig();
  return {
    name: config.session.cookieName,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.session.cookieSecure,
    path: "/",
    expires: expiresAt,
  };
}

/** Must only be called from a Server Action or Route Handler. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set({ ...cookieOptions(expiresAt), value: token });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  const config = getConfig();
  jar.set({
    name: config.session.cookieName,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: config.session.cookieSecure,
    path: "/",
    maxAge: 0,
  });
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(getConfig().session.cookieName)?.value ?? null;
}

/* ------------------------------------------------------------------ create */

export interface CreateSessionInput {
  userId: string;
  epoch: number;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Creates a session row and returns the raw token to place in the cookie.
 * `ip` is truncated to /24 (v4) or /48 (v6) so we can show "approximate
 * location" in the device list without storing a full address.
 */
export async function createSession(input: CreateSessionInput): Promise<{ token: string; session: SessionRecord }> {
  const config = getConfig();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.session.ttlDays * 86_400_000);
  const row = await prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(token),
      epoch: input.epoch,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      ip: truncateIp(input.ip),
      expiresAt,
    },
    select: { id: true, userId: true, epoch: true, expiresAt: true },
  });
  return { token, session: row };
}

function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip.includes(":")) {
    // IPv6 -> /48
    return ip.split(":").slice(0, 3).join(":") + "::/48";
  }
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return null;
}

/* -------------------------------------------------------------------- read */

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  role: true,
  avatarKey: true,
  emailVerifiedAt: true,
  isSuspended: true,
  saveWatchHistory: true,
  showLikesPublicly: true,
  sessionEpoch: true,
  createdAt: true,
  channel: {
    select: {
      id: true,
      handle: true,
      name: true,
      avatarKey: true,
      bannerKey: true,
      subscriberCount: true,
    },
  },
} as const;

/**
 * Resolves the current user for this request, or `null`.
 * Wrapped in React `cache` so a page that calls it from several components
 * only hits the database once per request.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionToken();
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      epoch: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: USER_SELECT },
    },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  // Epoch mismatch => the user signed out everywhere or changed credentials.
  if (session.epoch !== session.user.sessionEpoch) return null;
  if (session.user.isSuspended) {
    // Suspended accounts keep no usable session.
    return null;
  }

  // Touch the session at most once every 5 minutes to avoid a write per request.
  lastSeenThrottle(session.id);

  const u = session.user;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    avatarKey: u.avatarKey,
    emailVerified: Boolean(u.emailVerifiedAt),
    isSuspended: u.isSuspended,
    saveWatchHistory: u.saveWatchHistory,
    showLikesPublicly: u.showLikesPublicly,
    sessionEpoch: u.sessionEpoch,
    createdAt: u.createdAt,
    channel: u.channel,
  };
});

const lastSeenWritten = new Map<string, number>();
function lastSeenThrottle(sessionId: string): void {
  const now = Date.now();
  const last = lastSeenWritten.get(sessionId) ?? 0;
  if (now - last < 5 * 60_000) return;
  lastSeenWritten.set(sessionId, now);
  if (lastSeenWritten.size > 5000) lastSeenWritten.clear();
  prisma.session
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => {
      /* non-critical */
    });
}

/** Throws 401 when there is no valid session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthenticated();
  return user;
}

/**
 * A nullable viewer descriptor for services that behave differently for
 * signed-out visitors (feeds, watch page, comments). Never throws.
 */
export async function getViewerContext(): Promise<{
  userId: string | null;
  channelId: string | null;
  role: "USER" | "MODERATOR" | "ADMIN";
}> {
  const user = await getCurrentUser();
  return {
    userId: user?.id ?? null,
    channelId: user?.channel?.id ?? null,
    role: user?.role ?? "USER",
  };
}

/** Requires a role at or above the given level. */
export async function requireRole(minimum: "USER" | "MODERATOR" | "ADMIN"): Promise<SessionUser> {
  const user = await requireUser();
  const rank = { USER: 0, MODERATOR: 1, ADMIN: 2 } as const;
  if (rank[user.role] < rank[minimum]) {
    throw new AppError("FORBIDDEN", "You do not have permission to do that.");
  }
  return user;
}

/**
 * Requires an authenticated user **with a channel**, which is the precondition
 * for every creator action (upload, edit, playlist, studio).
 */
export async function requireChannelOwner(): Promise<SessionUser & { channel: NonNullable<SessionUser["channel"]> }> {
  const user = await requireUser();
  if (!user.channel) {
    throw new AppError("PRECONDITION_FAILED", "Create your channel before uploading videos.");
  }
  return user as SessionUser & { channel: NonNullable<SessionUser["channel"]> };
}

/* ------------------------------------------------------------------ revoke */

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes the session identified by the current cookie (sign out). */
export async function revokeCurrentSession(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  await clearSessionCookie();
}

/**
 * Invalidates every session for a user by bumping the epoch, then revokes the
 * rows so the device list is accurate.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { sessionEpoch: { increment: 1 } } }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

/** Active devices for the account settings screen. */
export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
}

/** Housekeeping: delete expired/revoked sessions older than 30 days. */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
