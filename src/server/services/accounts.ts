/**
 * Account service: registration, authentication, email verification, password
 * reset, profile/settings updates and account deletion.
 *
 * All authorisation rules live here (not in route handlers) so a new endpoint
 * cannot accidentally bypass them.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { AppError, conflict, notFound } from "@/lib/errors";
import { hashPassword, needsRehash, verifyPassword } from "@/server/auth/password";
import { revokeAllSessions } from "@/server/auth/session";
import { normalizeEmail, normalizeText } from "@/lib/validation";
import { passwordResetEmail, sendMail, verificationEmail } from "@/server/email";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

const log = logger.child({ mod: "accounts" });

export const TOKEN_TTL = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
} as const;

/* ------------------------------------------------------------------ helpers */

/** Turns a display name or username into a candidate channel handle. */
export function slugifyHandle(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 26);
  const safe = base.length >= 3 ? base : `dex-${base}`.slice(0, 26);
  return /^[a-z]/.test(safe) ? safe : `d${safe}`.slice(0, 26);
}

/** Finds an unused handle by appending a numeric suffix. */
export async function uniqueHandle(preferred: string, tx: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
  const base = slugifyHandle(preferred);
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 30);
    const taken = await tx.channel.findUnique({ where: { handle: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`.slice(0, 30);
}

/* --------------------------------------------------------------- register */

export interface RegisterInput {
  username: string;
  displayName: string;
  email: string;
  password: string;
  interests?: string[];
}

export interface RegisterResult {
  userId: string;
  channelId: string;
  handle: string;
  verificationLink: string | null;
  emailTransport: "smtp" | "file-outbox";
}

/**
 * Creates the account, its channel and the email-verification token in one
 * transaction so a failure never leaves a user without a channel.
 *
 * The channel is created up-front (handle derived from the username) because
 * every creator feature — uploads, playlists, studio — is channel-scoped; this
 * removes an empty intermediate state.
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const username = input.username.trim();
  const email = input.email.trim();
  const emailNormalized = normalizeEmail(email);

  const [existingUsername, existingEmail] = await Promise.all([
    prisma.user.findUnique({ where: { username }, select: { id: true } }),
    prisma.user.findUnique({ where: { emailNormalized }, select: { id: true } }),
  ]);
  if (existingUsername) throw conflict("That username is already taken.");
  if (existingEmail) throw conflict("An account with that email address already exists.");

  const passwordHash = await hashPassword(input.password);
  const handle = await uniqueHandle(username);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        displayName: normalizeText(input.displayName),
        email,
        emailNormalized,
        passwordHash,
        channel: {
          create: {
            handle,
            name: normalizeText(input.displayName).slice(0, 80),
            description: null,
          },
        },
      },
      select: { id: true, displayName: true, channel: { select: { id: true } } },
    });

    if (input.interests?.length) {
      await tx.userInterest.createMany({
        data: [...new Set(input.interests.map((t) => t.toLowerCase().slice(0, 40)))].map((tag) => ({
          userId: user.id,
          tag,
        })),
        skipDuplicates: true,
      });
    }
    return user;
  });

  const verification = await issueToken(created.id, "EMAIL_VERIFICATION");

  return {
    userId: created.id,
    channelId: created.channel!.id,
    handle,
    verificationLink: verification.link,
    emailTransport: verification.transport,
  };
}

/* ------------------------------------------------------------------ tokens */

interface IssuedToken {
  link: string;
  transport: "smtp" | "file-outbox";
}

/**
 * Issues a single-use token, stores only its hash, and delivers the link.
 * Tokens are 32 random bytes (base64url) — not guessable, and never logged in
 * production.
 */
export async function issueToken(
  userId: string,
  purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
): Promise<IssuedToken> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true },
  });
  if (!user) throw notFound("Account not found.");

  // Invalidate outstanding tokens for the same purpose.
  await prisma.token.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = randomBytes(32).toString("base64url");
  await prisma.token.create({
    data: {
      userId,
      purpose,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + TOKEN_TTL[purpose]),
    },
  });

  const path = purpose === "EMAIL_VERIFICATION" ? "/verify-email" : "/reset-password";
  const link = `${getConfig().appUrl}${path}?token=${encodeURIComponent(raw)}`;
  const template =
    purpose === "EMAIL_VERIFICATION"
      ? verificationEmail(user.displayName, link)
      : passwordResetEmail(user.displayName, link);
  const result = await sendMail({ ...template, to: user.email });

  return { link, transport: result.transport };
}

export interface ConsumedToken {
  userId: string;
}

/** Validates and burns a token. Throws a generic error so token state leaks nothing. */
export async function consumeToken(
  rawToken: string,
  purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
): Promise<ConsumedToken> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const row = await prisma.token.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
  });

  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      "BAD_REQUEST",
      purpose === "EMAIL_VERIFICATION"
        ? "That verification link is invalid or has expired. Request a new one."
        : "That reset link is invalid or has expired. Request a new one.",
    );
  }

  // Single use: mark used atomically; a losing race sees usedAt set.
  const burned = await prisma.token.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (burned.count !== 1) throw new AppError("BAD_REQUEST", "That link has already been used.");

  return { userId: row.userId };
}

export async function verifyEmail(rawToken: string): Promise<{ userId: string }> {
  const { userId } = await consumeToken(rawToken, "EMAIL_VERIFICATION");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return { userId };
}

/**
 * Starts a password reset.
 *
 * Always resolves successfully so the endpoint cannot be used to enumerate
 * which email addresses have accounts; delivery problems are logged, not
 * surfaced to the caller.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { emailNormalized: normalizeEmail(email) },
    select: { id: true, deletedAt: true, isSuspended: true },
  });
  if (!user || user.deletedAt || user.isSuspended) {
    log.info("password reset requested for unknown or ineligible address");
    return;
  }
  await issueToken(user.id, "PASSWORD_RESET");
}

/* ------------------------------------------------------------------- login */

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  sessionEpoch: number;
  isSuspended: boolean;
  emailVerified: boolean;
  avatarKey: string | null;
}

/**
 * Verifies credentials. Returns `null` on failure so the caller can apply a
 * uniform error message and its own throttling.
 */
export async function authenticate(identifier: string, password: string): Promise<AuthenticatedUser | null> {
  const value = identifier.trim();
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: value }, { emailNormalized: normalizeEmail(value) }],
      deletedAt: null,
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      role: true,
      passwordHash: true,
      sessionEpoch: true,
      isSuspended: true,
      emailVerifiedAt: true,
      avatarKey: true,
    },
  });
  if (!user) {
    // Equalise timing between "no such user" and "wrong password".
    await verifyPassword(
      "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000",
      password,
    );
    return null;
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) return null;
  // A suspended account is refused exactly like a wrong password. The caller
  // then applies its single "incorrect username or password" message, so sign-in
  // cannot be used to discover that an account exists and is suspended.
  if (user.isSuspended) return null;

  // Transparent upgrade when hashing parameters change.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
  }

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    sessionEpoch: user.sessionEpoch,
    isSuspended: user.isSuspended,
    emailVerified: Boolean(user.emailVerifiedAt),
    avatarKey: user.avatarKey,
  };
}

/* ------------------------------------------------------------ profile etc. */

export async function updateProfile(
  userId: string,
  input: { displayName?: string; bio?: string; username?: string },
): Promise<void> {
  const data: Prisma.UserUpdateInput = {};
  if (input.displayName !== undefined) data.displayName = normalizeText(input.displayName);
  if (input.bio !== undefined) data.bio = normalizeText(input.bio) || null;

  if (input.username !== undefined && input.username !== undefined) {
    const username = input.username.trim();
    const clash = await prisma.user.findFirst({
      where: { username, NOT: { id: userId } },
      select: { id: true },
    });
    if (clash) throw conflict("That username is already taken.");
    data.username = username;
  }

  await prisma.user.update({ where: { id: userId }, data });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) throw notFound("Account not found.");
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError("FORBIDDEN", "Your current password is not correct.");
  }
  if (currentPassword === newPassword) {
    throw new AppError("BAD_REQUEST", "Choose a password different from your current one.");
  }
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      // A self-chosen password satisfies the bootstrap "must change before use"
      // requirement, so the privileged surfaces unlock.
      mustChangePassword: false,
    },
  });
  // Changing a password signs every device out.
  await revokeAllSessions(userId);
}

export async function resetPasswordWithToken(rawToken: string, newPassword: string): Promise<void> {
  const { userId } = await consumeToken(rawToken, "PASSWORD_RESET");
  const active = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isSuspended: true, deletedAt: true },
  });
  if (!active || active.deletedAt || active.isSuspended) throw notFound("Account not found.");

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      // A reset also proves control of the mailbox.
      emailVerifiedAt: new Date(),
      // A reset is a real password change, so it clears the bootstrap flag too.
      mustChangePassword: false,
    },
  });
  await revokeAllSessions(userId);
}

export async function updateSettings(
  userId: string,
  input: {
    saveWatchHistory?: boolean;
    showLikesPublicly?: boolean;
    notifyOnNewVideo?: boolean;
    notifyOnComments?: boolean;
  },
): Promise<void> {
  const data: Prisma.UserUpdateInput = {};
  if (input.saveWatchHistory !== undefined) data.saveWatchHistory = input.saveWatchHistory;
  if (input.showLikesPublicly !== undefined) data.showLikesPublicly = input.showLikesPublicly;
  if (Object.keys(data).length === 0 && input.notifyOnNewVideo === undefined && input.notifyOnComments === undefined) {
    return;
  }
  if (Object.keys(data).length > 0) {
    await prisma.user.update({ where: { id: userId }, data });
  }

  // Notification preferences are stored per-subscription so a user can
  // pause notifications for individual channels later.
  if (input.notifyOnNewVideo === false) {
    await prisma.subscription.updateMany({
      where: { subscriberId: userId },
      data: { notifyLevel: "none" },
    });
  } else if (input.notifyOnNewVideo === true) {
    await prisma.subscription.updateMany({
      where: { subscriberId: userId, notifyLevel: "none" },
      data: { notifyLevel: "all" },
    });
  }
}

/**
 * Deletes an account.
 *
 * A soft delete ("anonymise and tombstone") is used by default because it
 * keeps comment threads and subscription relationships coherent, while the
 * data that identifies the person is destroyed: email, password hash, avatar,
 * bio and channel branding. Media owned by the account is removed from
 * storage by the `account.purge` maintenance job.
 */
export async function deleteAccount(userId: string, password: string, confirm: string): Promise<{ hardDeleted: boolean }> {
  if (confirm !== "DELETE") throw new AppError("BAD_REQUEST", "Type DELETE to confirm.");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, username: true },
  });
  if (!user) throw notFound("Account not found.");
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError("FORBIDDEN", "That password is not correct.");
  }

  const anon = `deleted-${userId.slice(0, 8)}`;
  await prisma.$transaction(async (tx) => {
    await tx.channel.updateMany({
      where: { ownerId: userId },
      data: { name: "Deleted channel", description: null, avatarKey: null, bannerKey: null },
    });
    await tx.video.updateMany({
      where: { uploaderId: userId },
      data: { visibility: "PRIVATE", status: "DRAFT", publishedAt: null },
    });
    await tx.session.deleteMany({ where: { userId } });
    await tx.token.deleteMany({ where: { userId } });
    await tx.subscription.deleteMany({ where: { subscriberId: userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        email: `${anon}@deleted.invalid`,
        emailNormalized: `${anon}@deleted.invalid`,
        passwordHash: "!deleted",
        displayName: "Deleted account",
        avatarKey: null,
        bio: null,
        isSuspended: true,
        sessionEpoch: { increment: 1 },
      },
    });
  });

  log.info("account deleted", { userId });
  return { hardDeleted: false };
}

/** Records the uploaded avatar key on the account. */
export async function setUserAvatar(userId: string, key: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { avatarKey: key } });
}

/** Public account lookup used by channel pages. */
export async function getPublicProfile(username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      avatarKey: true,
      createdAt: true,
      channel: { select: { id: true, handle: true, name: true, subscriberCount: true } },
    },
  });
  if (!user || !user.channel) throw notFound("That channel does not exist.");
  return user;
}
