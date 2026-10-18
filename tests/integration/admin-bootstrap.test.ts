import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import { resetConfigCache } from "@/lib/config";
import { authenticate, changePassword, issueToken, registerUser, resetPasswordWithToken } from "@/server/services/accounts";
import { verifyPassword } from "@/server/auth/password";
import { bootstrapAdmin, bootstrapStatus } from "@/server/services/admin-bootstrap";
import { setAdminBootstrapEnabled, setAdminBootstrapEnabledAsOperator } from "@/server/services/system-settings";
import { disableUser, enableUser } from "@/server/services/admin-users";
import { cleanupFixtures, createTestUser, TEST_PREFIX, uniqueSuffix } from "./helpers";

/**
 * Administrator bootstrap + account suspension, against the real database.
 *
 * These tests mutate `process.env` (the bootstrap switches) and the
 * `system_settings` singleton. Every fixture they create is `itest_`-prefixed,
 * every audit row is tagged (`actorLabel` "itest", or "operator" for the
 * operator-only path), and both are removed afterwards — including turning the
 * database switch back off. The final assertion proves no ADMIN account leaked:
 * there were none before this file ran, so there must be none after.
 */

const dbOk = (await checkDatabase()).ok;

/**
 * `bootstrapAdmin` refuses to create anything while *any* administrator exists,
 * and the assertions below count the whole table (`…toBe(0)`, `…toBe(1)`). That
 * premise holds on a fresh or isolated database, but not on a developer's
 * database that already has a real administrator — and deleting somebody's
 * administrator account to make a test comfortable is not an option.
 *
 * Those five cases are therefore skipped with this reason, and
 * `npm run test:admin-bootstrap` runs this file against the throwaway isolated
 * database (reset to empty first), where they all execute.
 */
const foreignAdminCount = dbOk ? await prisma.user.count({ where: { role: "ADMIN" } }) : 0;
const needsEmptyAdminTable = foreignAdminCount > 0;
const SKIP_REASON =
  `the database already has ${foreignAdminCount} administrator account(s); ` +
  "run `npm run test:admin-bootstrap` for these cases against the isolated database";

if (needsEmptyAdminTable) {
  // Loud on purpose: a silent skip would look like coverage.
  console.warn(`[admin-bootstrap] SKIPPING 5 cases — ${SKIP_REASON}`);
}

/**
 * The singleton's exact state before this file ran, so `afterAll` can put it
 * back byte-for-byte (the boolean is the important part; `updatedBy` is restored
 * so the row does not carry a test marker afterwards).
 */
const originalSettings = dbOk
  ? await prisma.systemSettings.findUnique({
      where: { id: 1 },
      select: { adminBootstrapEnabled: true, updatedBy: true },
    })
  : null;

const ENV_KEYS = [
  "DEXTUBE_ENV",
  "ADMIN_BOOTSTRAP_ENABLED",
  "ADMIN_BOOTSTRAP_PASSWORD",
  "ADMIN_BOOTSTRAP_USERNAME",
  "ADMIN_BOOTSTRAP_EMAIL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  EnvKey,
  string | undefined
>;

function setEnv(patch: Partial<Record<EnvKey, string | undefined>>): void {
  for (const key of ENV_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Config is memoised; every mutation must invalidate the cache.
  resetConfigCache();
}

function restoreEnv(): void {
  setEnv(ORIGINAL_ENV);
}

/** A fresh bootstrap identity whose username carries the cleanup prefix. */
function bootstrapIdentity(): { username: string; email: string } {
  const suffix = uniqueSuffix();
  return { username: `${TEST_PREFIX}bootstrap_${suffix}`, email: `itest-bootstrap-${suffix}@example.test` };
}

/** Enables the environment and database switches together. */
async function enableBootstrap(
  identity: { username: string; email: string },
  password = "BootstrapPassword1",
): Promise<void> {
  setEnv({
    DEXTUBE_ENV: "development",
    ADMIN_BOOTSTRAP_ENABLED: "true",
    ADMIN_BOOTSTRAP_PASSWORD: password,
    ADMIN_BOOTSTRAP_USERNAME: identity.username,
    ADMIN_BOOTSTRAP_EMAIL: identity.email,
  });
  await prisma.systemSettings.update({
    where: { id: 1 },
    data: { adminBootstrapEnabled: true, updatedBy: "itest" },
  });
}

/** Deletes every fixture this file may have created, and disarms the switch. */
async function removeTestData(): Promise<void> {
  await prisma.user.deleteMany({ where: { username: { startsWith: TEST_PREFIX } } });
  await prisma.adminAuditLog.deleteMany({
    where: {
      OR: [
        { actorLabel: "itest" },
        { actorLabel: "operator", action: { startsWith: "settings.admin_bootstrap." } },
      ],
    },
  });
  await prisma.systemSettings.update({
    where: { id: 1 },
    data: { adminBootstrapEnabled: false, updatedBy: "itest-cleanup" },
  });
}

beforeEach(async () => {
  restoreEnv();
  if (dbOk) await removeTestData();
});

afterAll(async () => {
  if (dbOk) {
    await removeTestData();
    await cleanupFixtures();

    // Restore the singleton exactly as we found it.
    await prisma.systemSettings.update({
      where: { id: 1 },
      data: {
        adminBootstrapEnabled: originalSettings?.adminBootstrapEnabled ?? false,
        updatedBy: originalSettings?.updatedBy ?? null,
      },
    });

    // No administrator account leaked: the count must be exactly what it was
    // before this file ran (zero on a fresh database).
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(foreignAdminCount);
    expect(await prisma.user.count({ where: { username: { startsWith: TEST_PREFIX } } })).toBe(0);
    const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
    // Restored to whatever it was before this file ran. On a developer's
    // database an operator may legitimately have left the switch armed.
    expect(settings?.adminBootstrapEnabled).toBe(originalSettings?.adminBootstrapEnabled ?? false);
  }
  restoreEnv();
});

describe.skipIf(!dbOk)("administrator bootstrap (database)", () => {
  it("creates nothing when the environment switch is off", async () => {
    const identity = bootstrapIdentity();
    setEnv({
      ADMIN_BOOTSTRAP_ENABLED: "false",
      ADMIN_BOOTSTRAP_PASSWORD: "UnusedPassword1",
      ADMIN_BOOTSTRAP_USERNAME: identity.username,
      ADMIN_BOOTSTRAP_EMAIL: identity.email,
    });

    const result = await bootstrapAdmin({ actorLabel: "itest" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("administrator bootstrap is not enabled for this environment");
    expect(await prisma.user.count({ where: { username: identity.username } })).toBe(0);
  });

  it("creates nothing while the database switch is off, and leaves it off", async () => {
    const identity = bootstrapIdentity();
    await enableBootstrap(identity);
    // The environment says yes; the operator's database switch says no.
    await prisma.systemSettings.update({ where: { id: 1 }, data: { adminBootstrapEnabled: false } });

    const result = await bootstrapAdmin({ actorLabel: "itest" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("administrator bootstrap is disabled in the database");

    const settings = await prisma.systemSettings.findUnique({ where: { id: 1 } });
    expect(settings?.adminBootstrapEnabled).toBe(false);
    expect(await prisma.user.count({ where: { username: identity.username } })).toBe(0);
  });

  it.skipIf(needsEmptyAdminTable)("creates exactly one ADMIN with a verifiable hash and no channel when both switches are on", async () => {
    const identity = bootstrapIdentity();
    const password = "RealBootstrapPassword1";
    await enableBootstrap(identity, password);

    const result = await bootstrapAdmin({ actorLabel: "itest" });
    expect(result.created).toBe(true);
    expect(result.username).toBe(identity.username);

    const row = await prisma.user.findUnique({ where: { username: identity.username } });
    expect(row).not.toBeNull();
    expect(row!.role).toBe("ADMIN");
    expect(row!.mustChangePassword).toBe(true);
    expect(row!.emailVerifiedAt).not.toBeNull();
    expect(row!.passwordHash).not.toBe(password);
    expect(await verifyPassword(row!.passwordHash, password)).toBe(true);

    // Bootstrap administrator, not a creator: no channel.
    expect(await prisma.channel.findUnique({ where: { ownerId: row!.id } })).toBeNull();
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);

    // A second call is idempotent and touches nothing.
    const again = await bootstrapAdmin({ actorLabel: "itest" });
    expect(again.created).toBe(false);
    expect(again.reason).toBe("an administrator already exists");
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it.skipIf(needsEmptyAdminTable)("never overwrites an existing administrator on a restart", async () => {
    const identity = bootstrapIdentity();
    await enableBootstrap(identity, "RestartPassword1");
    const first = await bootstrapAdmin({ actorLabel: "itest" });
    expect(first.created).toBe(true);

    const SENTINEL = "$argon2id$v=19$m=19456,t=2,p=1$sentinel$unchanged-sentinel-value";
    await prisma.user.update({ where: { id: first.userId! }, data: { passwordHash: SENTINEL } });

    const second = await bootstrapAdmin({ actorLabel: "itest" });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("an administrator already exists");

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: first.userId! },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(SENTINEL);
  });

  it.skipIf(needsEmptyAdminTable)("leaves a colliding non-admin account untouched and creates nothing", async () => {
    const identity = bootstrapIdentity();
    const blocker = await registerUser({
      username: identity.username,
      displayName: "Collision Blocker",
      email: identity.email,
      password: "CorrectHorse1",
    });
    await enableBootstrap(identity, "ShouldNeverBeUsed1");

    const result = await bootstrapAdmin({ actorLabel: "itest" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("a user with that username or email already exists");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: blocker.userId } });
    expect(row.role).toBe("USER");
    expect(row.mustChangePassword).toBe(false);
    expect(await verifyPassword(row.passwordHash, "CorrectHorse1")).toBe(true);
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(0);
  });

  it.skipIf(needsEmptyAdminTable)("throws a precondition failure when no password is configured but bootstrap is otherwise allowed", async () => {
    const identity = bootstrapIdentity();
    // isolated-test is the one environment where the password is optional at
    // config-validation time, so this reaches the service's own precondition.
    setEnv({
      DEXTUBE_ENV: "isolated-test",
      ADMIN_BOOTSTRAP_ENABLED: "true",
      ADMIN_BOOTSTRAP_PASSWORD: undefined,
      ADMIN_BOOTSTRAP_USERNAME: identity.username,
      ADMIN_BOOTSTRAP_EMAIL: identity.email,
    });
    await prisma.systemSettings.update({ where: { id: 1 }, data: { adminBootstrapEnabled: true } });

    await expect(bootstrapAdmin({ actorLabel: "itest" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await prisma.user.count({ where: { username: identity.username } })).toBe(0);
  });

  it("reports status as booleans and never the password", async () => {
    const identity = bootstrapIdentity();
    const password = "StatusPassword1";
    await enableBootstrap(identity, password);

    const status = await bootstrapStatus();
    expect(status.envEnabled).toBe(true);
    expect(status.dbEnabled).toBe(true);
    expect(status.permitted).toBe(true);
    expect(status.environment).toBe("development");
    expect(status.username).toBe(identity.username);
    expect(status.hasPassword).toBe(true);
    expect(JSON.stringify(status)).not.toContain(password);
  });
});

describe.skipIf(!dbOk)("bootstrap database switch (database)", () => {
  it("refuses to enable through the application, audits a disable, and lets the operator re-enable", async () => {
    // The application path may never re-arm the bootstrap.
    await expect(
      setAdminBootstrapEnabled(true, { userId: null, label: "itest" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // It may disarm it, and the audit row commits in the same transaction.
    await prisma.systemSettings.update({ where: { id: 1 }, data: { adminBootstrapEnabled: true } });
    const off = await setAdminBootstrapEnabled(false, { userId: null, label: "itest" });
    expect(off.adminBootstrapEnabled).toBe(false);

    const disableAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "settings.admin_bootstrap.disable", actorLabel: "itest" },
      orderBy: { createdAt: "desc" },
    });
    expect(disableAudit).not.toBeNull();
    expect(disableAudit?.targetType).toBe("system_settings");
    expect((disableAudit?.details as Record<string, unknown> | null)?.adminBootstrapEnabled).toBe(false);

    // The operator-only path may turn it back on; it is audited as "operator".
    const on = await setAdminBootstrapEnabledAsOperator(true);
    expect(on.adminBootstrapEnabled).toBe(true);

    const enableAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "settings.admin_bootstrap.enable", actorLabel: "operator" },
      orderBy: { createdAt: "desc" },
    });
    expect(enableAudit).not.toBeNull();
    expect((enableAudit?.details as Record<string, unknown> | null)?.adminBootstrapEnabled).toBe(true);
  });
});

describe.skipIf(!dbOk)("account suspension (database)", () => {
  it("suspends an account, revokes its credentials, blocks sign-in, then reverses", async () => {
    const user = await createTestUser();

    // A live session and an outstanding reset token, to prove both are killed.
    await prisma.session.create({
      data: {
        userId: user.userId,
        tokenHash: `itest-${uniqueSuffix()}`,
        epoch: 0,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.token.create({
      data: {
        userId: user.userId,
        purpose: "PASSWORD_RESET",
        tokenHash: `itest-${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    // Confirmation and self-disable guards.
    await expect(
      disableUser(user.userId, { userId: null, username: "itest" }, { confirm: "not-the-username" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      disableUser(user.userId, { userId: user.userId, username: "itest" }, { confirm: user.username }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { sessionEpoch: true },
    });

    const summary = await disableUser(
      user.userId,
      { userId: null, username: "itest" },
      { confirm: user.username, reason: "itest compromise" },
    );
    expect(summary.isSuspended).toBe(true);
    expect(summary.suspendedReason).toBe("itest compromise");

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { sessionEpoch: true, isSuspended: true },
    });
    expect(after.isSuspended).toBe(true);
    expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);

    const sessions = await prisma.session.findMany({ where: { userId: user.userId } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);

    const tokens = await prisma.token.findMany({ where: { userId: user.userId } });
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.usedAt !== null)).toBe(true);

    // Suspended accounts cannot authenticate.
    expect(await authenticate(user.username, user.password)).toBeNull();

    const disableAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "admin.user.disable", targetId: user.userId, actorLabel: "itest" },
    });
    expect(disableAudit).not.toBeNull();
    expect((disableAudit?.details as Record<string, unknown> | null)?.reason).toBe("itest compromise");

    // Re-enable: the flag clears and sign-in works again.
    const enabled = await enableUser(user.userId, { userId: null, username: "itest" });
    expect(enabled.isSuspended).toBe(false);
    expect(enabled.suspendedReason).toBeNull();
    expect(await authenticate(user.username, user.password)).not.toBeNull();

    const enableAudit = await prisma.adminAuditLog.findFirst({
      where: { action: "admin.user.enable", targetId: user.userId, actorLabel: "itest" },
    });
    expect(enableAudit).not.toBeNull();
  });

  it("rejects a suspended account at sign-in even when the password is correct", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.userId },
      data: { isSuspended: true, suspendedReason: "itest" },
    });
    expect(await authenticate(user.username, user.password)).toBeNull();
  });
});

describe.skipIf(!dbOk)("bootstrap must-change-password clearing (database)", () => {
  it("clears the flag when the account chooses a new password", async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.userId }, data: { mustChangePassword: true } });

    await changePassword(user.userId, user.password, "SelfChosenPassword1");

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { mustChangePassword: true },
    });
    expect(row.mustChangePassword).toBe(false);
    expect(await authenticate(user.username, "SelfChosenPassword1")).not.toBeNull();
    // The old (bootstrap-issued) password no longer works.
    expect(await authenticate(user.username, user.password)).toBeNull();
  });

  it("clears the flag when a password-reset token is redeemed", async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.userId }, data: { mustChangePassword: true } });

    const { link } = await issueToken(user.userId, "PASSWORD_RESET");
    const raw = new URL(link).searchParams.get("token");
    expect(raw).not.toBeNull();

    await resetPasswordWithToken(raw!, "ResetChosenPassword1");

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { mustChangePassword: true },
    });
    expect(row.mustChangePassword).toBe(false);
    expect(await authenticate(user.username, "ResetChosenPassword1")).not.toBeNull();
    expect(await authenticate(user.username, user.password)).toBeNull();
  });
});

describe.skipIf(!dbOk)("audit hygiene (database)", () => {
  it.skipIf(needsEmptyAdminTable)("records every action and never stores a password or secret value", async () => {
    // Produce a bootstrap-create row with a known password.
    const identity = bootstrapIdentity();
    const password = "AuditScanPassword1";
    await enableBootstrap(identity, password);
    const created = await bootstrapAdmin({ actorLabel: "itest" });
    expect(created.created).toBe(true);

    // Produce the other audited actions.
    await prisma.systemSettings.update({ where: { id: 1 }, data: { adminBootstrapEnabled: true } });
    await setAdminBootstrapEnabled(false, { userId: null, label: "itest" });
    await setAdminBootstrapEnabledAsOperator(true);

    const user = await createTestUser();
    await disableUser(user.userId, { userId: null, username: "itest" }, { confirm: user.username, reason: "audit" });
    await enableUser(user.userId, { userId: null, username: "itest" });

    const rows = await prisma.adminAuditLog.findMany({
      where: { actorLabel: { in: ["itest", "operator"] } },
    });
    const actions = new Set(rows.map((row) => row.action));
    expect(actions).toContain("admin.bootstrap.create");
    expect(actions).toContain("settings.admin_bootstrap.disable");
    expect(actions).toContain("settings.admin_bootstrap.enable");
    expect(actions).toContain("admin.user.disable");
    expect(actions).toContain("admin.user.enable");

    // No secret value may appear anywhere in the structured details.
    const serialized = JSON.stringify(rows.map((row) => row.details));
    expect(serialized).not.toContain(password);
    for (const row of rows) {
      const details = row.details as Record<string, unknown> | null;
      if (!details) continue;
      for (const [key, value] of Object.entries(details)) {
        if (/password|secret|token/i.test(key)) {
          expect(value).toBe("[redacted]");
        }
      }
    }
  });
});
