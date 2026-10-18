/**
 * One-time initial-administrator bootstrap.
 *
 * DEXTube has no sign-up path to the ADMIN role, so a fresh instance needs a
 * way to create its first administrator. This module is that path — and it is
 * written to be **safe to call on every boot**:
 *
 *   * Every precondition is checked independently and *quietly*; when one is
 *     unmet the call returns `{ created: false, reason }` and touches nothing.
 *   * The decisive guard against overwriting a real administrator is
 *     precondition 3: if *any* ADMIN exists, nothing is created. Restarting the
 *     process therefore can never reset an existing administrator's password.
 *   * An existing account whose username/email matches the configured bootstrap
 *     identity is never modified, promoted or reset — the bootstrap only ever
 *     *creates* a brand-new account.
 *
 * The created account carries `mustChangePassword`, so even on the throwaway
 * instance where a well-known password was used, the credential cannot drive
 * any privileged API until it has been replaced.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { preconditionFailed } from "@/lib/errors";
import { normalizeEmail } from "@/lib/validation";
import { hashPassword } from "@/server/auth/password";
import { recordAudit } from "@/server/services/audit";
import { getSystemSettings } from "@/server/services/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "admin-bootstrap" });

export interface BootstrapResult {
  created: boolean;
  /** Why nothing was created (a quiet skip), when `created` is false. */
  reason?: string;
  userId?: string;
  username?: string;
}

export interface BootstrapStatus {
  /** The environment switch (`ADMIN_BOOTSTRAP_ENABLED`). */
  envEnabled: boolean;
  /** The database switch (`system_settings.adminBootstrapEnabled`). */
  dbEnabled: boolean;
  /** Whether the environment permits bootstrapping at all (never in production). */
  permitted: boolean;
  /** How many ADMIN accounts currently exist. */
  adminCount: number;
  environment: string;
  /** The configured bootstrap username (never the password). */
  username: string;
  /** Whether a bootstrap password is configured — a boolean only. */
  hasPassword: boolean;
}

/**
 * Runs the bootstrap. Never throws for the environment/DB switches or for an
 * already-existing account — those are quiet skips. Throws
 * `PRECONDITION_FAILED` only when the bootstrap *should* proceed but cannot,
 * because no password is configured.
 */
export async function bootstrapAdmin(opts: { actorLabel?: string } = {}): Promise<BootstrapResult> {
  const config = getConfig();

  // 1. Environment switch. `permitted` is false in production by construction.
  if (!config.adminBootstrap.permitted) {
    return { created: false, reason: "administrator bootstrap is not enabled for this environment" };
  }

  // 2. Database switch. The operator's off-switch always wins.
  const settings = await getSystemSettings();
  if (!settings.adminBootstrapEnabled) {
    return { created: false, reason: "administrator bootstrap is disabled in the database" };
  }

  const username = config.adminBootstrap.username.trim();
  const email = config.adminBootstrap.email.trim();
  const emailNormalized = normalizeEmail(email);

  // 3. Any administrator at all means we are already set up. This is what makes
  //    a restart non-destructive: we never look at, let alone overwrite, an
  //    existing administrator.
  const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
  if (adminCount > 0) {
    return { created: false, reason: "an administrator already exists" };
  }

  // 4. A colliding account is left exactly as it is — never promoted, never
  //    given a new password, never renamed.
  const clash = await prisma.user.findFirst({
    where: { OR: [{ username }, { emailNormalized }] },
    select: { id: true },
  });
  if (clash) {
    return { created: false, reason: "a user with that username or email already exists" };
  }

  const password = config.adminBootstrap.password;
  if (!password || password.length === 0) {
    throw preconditionFailed(
      "ADMIN_BOOTSTRAP_PASSWORD is required to create the initial administrator " +
        "(only the isolated-test environment may use the documented throwaway password).",
    );
  }

  const passwordHash = await hashPassword(password);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        displayName: username,
        email,
        emailNormalized,
        passwordHash,
        role: "ADMIN",
        // `ADMIN_BOOTSTRAP_REQUIRE_PASSWORD_CHANGE` decides whether the account
        // must replace its bootstrap password before the administrator tools
        // open. The default is `true`; a development instance sets it to `false`
        // so the operator is not locked out of the instance they just created.
        mustChangePassword: config.adminBootstrap.requirePasswordChange,
        emailVerifiedAt: new Date(),
        // Deliberately no channel: the initial administrator is an operator, not
        // a creator, and must not appear in public channel listings.
      },
      select: { id: true, username: true },
    });

    // Never the password: only identity and the environment it was created in.
    await recordAudit(
      {
        actorLabel: opts.actorLabel ?? "system",
        action: "admin.bootstrap.create",
        targetType: "user",
        targetId: user.id,
        details: { username: user.username, email, environment: config.environment },
      },
      tx,
    );

    return user;
  });

  log.info("initial administrator created", { userId: created.id, environment: config.environment });
  return { created: true, userId: created.id, username: created.username };
}

/**
 * Read-only summary for the administrator UI. Booleans and counts only — the
 * password is never included, not even masked.
 */
export async function bootstrapStatus(): Promise<BootstrapStatus> {
  const config = getConfig();
  const [settings, adminCount] = await Promise.all([
    getSystemSettings(),
    prisma.user.count({ where: { role: "ADMIN" } }),
  ]);

  return {
    envEnabled: config.adminBootstrap.enabled,
    dbEnabled: settings.adminBootstrapEnabled,
    permitted: config.adminBootstrap.permitted,
    adminCount,
    environment: config.environment,
    username: config.adminBootstrap.username,
    hasPassword: Boolean(config.adminBootstrap.password && config.adminBootstrap.password.length > 0),
  };
}
