/**
 * Append-only audit trail for security-sensitive administrative actions.
 *
 * Every entry names who did what to which object. Actions that change security
 * posture (bootstrap state, account disable/enable, password resets) pass the
 * transaction they are already running so the audit row and the change commit
 * or roll back together — an unlogged privilege change is not acceptable.
 *
 * `details` is structured and passes through {@link redact} first, so a caller
 * cannot accidentally persist a password or token by spreading a form body.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/** Anything that can run a Prisma query: the client itself or a transaction. */
export type AuditDb = Prisma.TransactionClient | typeof prisma;

export interface AuditEntry {
  /** Signed-in administrator, when the action came through the application. */
  actorUserId?: string | null;
  /**
   * Human-readable actor. Defaults to "system"; CLI helpers pass "cli", an
   * operator with database access passes `operator:<name>`.
   */
  actorLabel?: string;
  /** Dotted action name, e.g. "admin.bootstrap.create". */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Keys whose values are never written to the audit log, at any depth. */
const SECRET_KEY = /(password|passwd|secret|token|hash|authorization|cookie|key)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(v, depth + 1);
  }
  return out;
}

/** Exposed for tests: strips secret-looking keys from a detail object. */
export function redact(details: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!details) return undefined;
  return redactValue(details) as Prisma.InputJsonValue;
}

/**
 * Writes one audit row. Pass `db` to make it part of a surrounding transaction.
 *
 * This deliberately throws: a security-sensitive action that cannot be audited
 * should fail rather than proceed silently. Callers that consider the audit
 * optional (for example a best-effort import progress note) should catch.
 */
export async function recordAudit(entry: AuditEntry, db: AuditDb = prisma): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel ?? (entry.actorUserId ? "user" : "system"),
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: redact(entry.details),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 300) ?? null,
    },
  });
}

/**
 * Best-effort variant for non-security-critical notes (import progress,
 * cleanup). Never throws, so a logging problem cannot abort real work.
 */
export async function tryRecordAudit(entry: AuditEntry, db: AuditDb = prisma): Promise<void> {
  try {
    await recordAudit(entry, db);
  } catch (error) {
    logger.warn("audit write failed", {
      action: entry.action,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Most recent entries, newest first. `take` is clamped by the caller. */
export async function listAuditLog(options: { take: number; action?: string }): Promise<
  Array<{
    id: string;
    actorLabel: string;
    actorUserId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: Prisma.JsonValue | null;
    createdAt: Date;
  }>
> {
  return prisma.adminAuditLog.findMany({
    where: options.action ? { action: options.action } : undefined,
    orderBy: { createdAt: "desc" },
    take: options.take,
    select: {
      id: true,
      actorLabel: true,
      actorUserId: true,
      action: true,
      targetType: true,
      targetId: true,
      details: true,
      createdAt: true,
    },
  });
}
