/**
 * Administrator user management.
 *
 * Two deliberately small, auditable operations: disable and re-enable an
 * account. Disabling is the heavier of the two and is done in a single
 * transaction — the account is flagged, the session epoch is bumped, every
 * existing session is revoked, outstanding single-use tokens are burned and an
 * audit row is written — so there is no window in which a just-disabled account
 * still holds a usable credential.
 *
 * The list is bounded in the service as well as at the route, so a hand-crafted
 * query cannot dump the whole user table.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import type { Prisma, UserRole } from "@prisma/client";

export const ADMIN_USER_LIST_DEFAULT = 25;
export const ADMIN_USER_LIST_MAX = 50;

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  isSuspended: boolean;
  suspendedReason: string | null;
  mustChangePassword: boolean;
  /** ISO-8601, so the value is safe to serialise to a client component. */
  createdAt: string;
  /** Public channel handle, or null for accounts without a channel. */
  channelHandle: string | null;
}

/** Who performed the action (an administrator), for the audit row. */
export interface AdminUserActor {
  userId?: string | null;
  username: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** The projection shared by the list and both mutations. Never `passwordHash`. */
const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  role: true,
  isSuspended: true,
  suspendedReason: true,
  mustChangePassword: true,
  createdAt: true,
  channel: { select: { handle: true } },
} as const;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

function toSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    isSuspended: row.isSuspended,
    suspendedReason: row.suspendedReason,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
    channelHandle: row.channel?.handle ?? null,
  };
}

/** Clamps the requested page size to a small, finite bound. */
function clampTake(take: number | undefined): number {
  const value = Math.trunc(take ?? ADMIN_USER_LIST_DEFAULT);
  if (!Number.isFinite(value) || value < 1) return ADMIN_USER_LIST_DEFAULT;
  return Math.min(ADMIN_USER_LIST_MAX, value);
}

/**
 * A bounded, newest-first list ordered by role rank (administrators, then
 * moderators, then users) and then creation time. Tombstoned accounts are
 * omitted; suspended ones are included and flagged.
 */
export async function listAdminUsers(
  options: { take?: number } = {},
): Promise<{ users: AdminUserSummary[]; take: number }> {
  const take = clampTake(options.take);
  const rows = await prisma.user.findMany({
    where: { deletedAt: null },
    // Enum ordering is USER < MODERATOR < ADMIN, so descending surfaces the
    // highest-privilege accounts first.
    orderBy: [{ role: "desc" }, { createdAt: "desc" }],
    take,
    select: ADMIN_USER_SELECT,
  });
  return { users: rows.map(toSummary), take };
}

/**
 * Disables an account: suspends it, invalidates every credential it currently
 * holds and records the change.
 *
 * `confirm` must equal the target's username, so a stray click or a mistyped
 * id cannot suspend the wrong person. Suspending yourself is refused.
 *
 * Everything happens in one transaction: the suspension, the epoch bump, the
 * session revocations, the token burns and the audit row commit together or not
 * at all.
 */
export async function disableUser(
  targetId: string,
  actor: AdminUserActor,
  options: { reason?: string | null; confirm: string },
): Promise<AdminUserSummary> {
  if (actor.userId && actor.userId === targetId) {
    throw forbidden("You cannot disable your own administrator account.");
  }

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, username: true, deletedAt: true },
  });
  if (!target || target.deletedAt) throw notFound("That account does not exist.");

  if (options.confirm !== target.username) {
    throw validationFailed("Type the account's username to confirm disabling it.", {
      confirm: ["That does not match the account's username."],
    });
  }

  const reason = options.reason?.trim() ? options.reason.trim() : null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: targetId },
      data: {
        isSuspended: true,
        suspendedReason: reason,
        // Bumping the epoch invalidates every session that was not explicitly
        // revoked, and means a later re-enable does NOT resurrect old sessions.
        sessionEpoch: { increment: 1 },
      },
      select: ADMIN_USER_SELECT,
    });

    const now = new Date();
    await tx.session.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: now },
    });
    // The `tokens` table has no revokedAt: a token is invalid once `usedAt` is
    // set (see `consumeToken`). Burn every outstanding verification/reset token.
    await tx.token.updateMany({
      where: { userId: targetId, usedAt: null },
      data: { usedAt: now },
    });

    await recordAudit(
      {
        actorUserId: actor.userId ?? null,
        actorLabel: actor.username,
        action: "admin.user.disable",
        targetType: "user",
        targetId,
        details: { reason },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    return toSummary(updated);
  });
}

/**
 * Reverses {@link disableUser}: clears the suspension flag and the reason, and
 * audits `admin.user.enable`.
 *
 * Previously revoked sessions are **not** resurrected. Disabling bumped the
 * session epoch, so any session that still existed is permanently invalid; the
 * account must sign in again to obtain a fresh one.
 */
export async function enableUser(targetId: string, actor: AdminUserActor): Promise<AdminUserSummary> {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt) throw notFound("That account does not exist.");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: targetId },
      data: { isSuspended: false, suspendedReason: null },
      select: ADMIN_USER_SELECT,
    });

    await recordAudit(
      {
        actorUserId: actor.userId ?? null,
        actorLabel: actor.username,
        action: "admin.user.enable",
        targetType: "user",
        targetId,
        details: null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    return toSummary(updated);
  });
}
