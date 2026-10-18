/**
 * Operator-controlled, security-sensitive settings (the `system_settings`
 * singleton row).
 *
 * The only switch today is `adminBootstrapEnabled`. It exists so that an
 * operator can permanently disarm the first-administrator bootstrap *in the
 * database* once the instance is set up, independently of whatever the
 * environment file says. Disabling it must never touch an account; it only
 * stops the bootstrap from running again.
 *
 * Asymmetry, by design:
 *   * The application may turn the switch **off** (idempotent). Doing so is
 *     recorded in the audit trail inside the same transaction.
 *   * The application may **not** turn the switch back on. Re-arming the
 *     bootstrap is exactly the primitive an attacker who has stolen an
 *     administrator session would want: it lets them mint a *new* well-known
 *     account that survives a password change. Requiring direct database access
 *     (see {@link setAdminBootstrapEnabledAsOperator}, used only by the CLI)
 *     keeps that ability out of the request path entirely.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";

/** The singleton row's id; a CHECK constraint in the migration enforces it. */
const SETTINGS_ID = 1;

export interface SystemSettings {
  adminBootstrapEnabled: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** Who performed an operator/admin settings change, for the audit trail. */
export interface SettingsActor {
  /** Signed-in administrator, when the change came through the application. */
  userId?: string | null;
  /** Human-readable actor, e.g. an administrator's username or "operator". */
  label: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Reads the singleton row.
 *
 * If the row is unexpectedly missing (a broken/partial migration) this returns
 * the safe, disabled default **without writing anything**: the absence of the
 * row must never be treated as permission to bootstrap.
 */
export async function getSystemSettings(): Promise<SystemSettings> {
  const row = await prisma.systemSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { adminBootstrapEnabled: true, updatedAt: true, updatedBy: true },
  });
  if (!row) return { adminBootstrapEnabled: false, updatedAt: null, updatedBy: null };
  return row;
}

/**
 * Applies a new bootstrap state in one transaction together with its audit row.
 *
 * Internal: callers go through the app-facing or operator-facing wrapper so the
 * rule about *who may enable* is impossible to bypass by accident.
 */
async function applyBootstrapState(
  enabled: boolean,
  actor: SettingsActor,
  action: "settings.admin_bootstrap.enable" | "settings.admin_bootstrap.disable",
): Promise<SystemSettings> {
  const updatedBy = actor.userId ?? actor.label;
  return prisma.$transaction(async (tx) => {
    const row = await tx.systemSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, adminBootstrapEnabled: enabled, updatedBy },
      update: { adminBootstrapEnabled: enabled, updatedBy },
      select: { adminBootstrapEnabled: true, updatedAt: true, updatedBy: true },
    });

    // Same transaction: an unlogged security-posture change is not acceptable.
    await recordAudit(
      {
        actorUserId: actor.userId ?? null,
        actorLabel: actor.label,
        action,
        targetType: "system_settings",
        targetId: String(SETTINGS_ID),
        details: { adminBootstrapEnabled: enabled },
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    return row;
  });
}

/**
 * Application path for the bootstrap switch.
 *
 * Turning it **off** is allowed and idempotent; the audit row is written in the
 * same transaction. Turning it **on** throws `FORBIDDEN`: re-arming the
 * bootstrap must be done by an operator with direct database access, so that a
 * compromised administrator session cannot recreate a bootstrap administrator
 * (which would give the attacker a fresh, well-known account).
 */
export async function setAdminBootstrapEnabled(enabled: boolean, actor: SettingsActor): Promise<SystemSettings> {
  if (enabled) {
    throw forbidden(
      "The administrator bootstrap can only be re-enabled by an operator with direct database access " +
        "(run `npm run admin:bootstrap -- --enable-bootstrap-as-operator` on the server host). " +
        "This prevents a compromised administrator session from recreating a bootstrap administrator.",
    );
  }
  return applyBootstrapState(false, actor, "settings.admin_bootstrap.disable");
}

/**
 * Operator-only path: may turn the switch on **or** off.
 *
 * Reached exclusively by `scripts/admin-bootstrap.ts` when run with
 * `--enable-bootstrap-as-operator`. It is deliberately not wired to any API
 * route, so the application can never call it.
 *
 * Audited as `settings.admin_bootstrap.enable` / `.disable` with the actor label
 * `"operator"` by default.
 */
export async function setAdminBootstrapEnabledAsOperator(
  enabled: boolean,
  actor: Omit<SettingsActor, "label"> & { label?: string } = {},
): Promise<SystemSettings> {
  const resolved: SettingsActor = { ...actor, label: actor.label ?? "operator" };
  return applyBootstrapState(
    enabled,
    resolved,
    enabled ? "settings.admin_bootstrap.enable" : "settings.admin_bootstrap.disable",
  );
}
