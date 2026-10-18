/**
 * `npm run admin:switch` — turn the local administrator on or off by editing a
 * file, exactly as `Admintruefalse.md` describes.
 *
 *   admin: true    the administrator account exists and can sign in
 *   admin: false   the administrator account does not exist
 *
 * The value is read from `Admintruefalse.md` in the repository root together
 * with the username, email and password it documents. Nothing is hard-coded
 * here: what the file says is what happens.
 *
 * Why a command instead of doing it at startup: the web application must never
 * be able to grant itself an administrator (no route, no restart-time
 * side effect). This script runs on the server host, by hand, which is the
 * operator's seat — and every change it makes is written to the audit log as
 * actor "operator".
 *
 * Turning it off deletes the account and revokes its sessions. That is
 * destructive and the file has to say `false` for it to happen.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "../src/lib/load-env";

loadEnvFile();

const SWITCH_FILE = "Admintruefalse.md";

interface Switch {
  enabled: boolean;
  username: string;
  email: string;
  password: string;
}

/**
 * Parses `key: value` lines out of the markdown. Deliberately forgiving about
 * the surrounding prose so the file can stay a document a human reads, but
 * strict about the one line that matters: it must say `true` or `false`.
 */
function parseSwitch(file: string): Switch {
  if (!fs.existsSync(file)) {
    fail(`"${SWITCH_FILE}" was not found in ${process.cwd()}.`);
  }
  const text = fs.readFileSync(file, "utf8");

  const value = (key: string): string | null => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(text);
    if (!match?.[1]) return null;
    // Strip an optional code fence or quotes around the value.
    return match[1].replace(/^[`"']|[`"']$/g, "").trim();
  };

  const raw = value("admin");
  if (raw === null) {
    fail(`"${SWITCH_FILE}" does not contain a line like "admin: true".`);
  }
  if (raw !== "true" && raw !== "false") {
    fail(`"${SWITCH_FILE}" says "admin: ${raw}". It must say exactly true or false.`);
  }

  const username = value("username") ?? "admin";
  const email = value("email") ?? "admin@admin.com";
  const password = value("password") ?? "";

  if (raw === "true" && password.length === 0) {
    fail(`"${SWITCH_FILE}" says admin: true but documents no password.`);
  }

  return { enabled: raw === "true", username, email, password };
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string, code = 2): never {
  process.stderr.write(`\n[admin:switch] ${message}\n\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const file = path.resolve(process.cwd(), SWITCH_FILE);
  const want = parseSwitch(file);

  // The switch file drives the environment switches for this one command. No
  // value is persisted anywhere: re-running with `false` removes the account
  // and nothing in the running application is left armed.
  process.env.ADMIN_BOOTSTRAP_ENABLED = want.enabled ? "true" : "false";
  process.env.ADMIN_BOOTSTRAP_USERNAME = want.username;
  process.env.ADMIN_BOOTSTRAP_EMAIL = want.email;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = want.password;
  // Editing a file to switch the account on is an explicit operator act, so the
  // account is usable immediately. (The default for a production bootstrap is
  // still "must change the password first".)
  process.env.ADMIN_BOOTSTRAP_REQUIRE_PASSWORD_CHANGE = "false";

  const { getConfig, resetConfigCache } = await import("../src/lib/config");
  resetConfigCache();
  const config = getConfig();

  if (config.environment === "production") {
    fail(
      "DEXTUBE_ENV is production. The administrator bootstrap is refused there by design; " +
        "create the first administrator through the secure setup flow instead.",
    );
  }

  const { prisma } = await import("../src/lib/db");
  const { bootstrapAdmin, bootstrapStatus } = await import("../src/server/services/admin-bootstrap");
  const { setAdminBootstrapEnabledAsOperator } = await import("../src/server/services/system-settings");
  const { revokeAllSessions } = await import("../src/server/auth/session");
  const { recordAudit } = await import("../src/server/services/audit");

  line("");
  line("DEXTube administrator switch");
  line("============================");
  line(`  file        ${file}`);
  line(`  environment ${config.environment}`);
  line(`  database    ${config.databaseUrl.replace(/:[^:@/]*@/, ":****@")}`);
  line("");
  line(`  admin: ${want.enabled ? "true  → the administrator account must exist" : "false → the administrator account must not exist"}`);
  line(`  identity    ${want.username} <${want.email}>`);
  line("");

  // An existing account with this username, whatever its role.
  const existing = await prisma.user.findFirst({
    where: { OR: [{ username: want.username }, { emailNormalized: want.email.toLowerCase() }] },
    select: { id: true, username: true, email: true, role: true, isSuspended: true },
  });

  if (want.enabled) {
    if (existing && existing.role === "ADMIN") {
      // Make sure a previously disabled account comes back, and say plainly that
      // the password is unchanged (this command never resets a password).
      if (existing.isSuspended) {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: existing.id },
            data: { isSuspended: false, suspendedReason: null, sessionEpoch: { increment: 1 } },
          });
          await recordAudit(
            {
              actorLabel: "operator",
              action: "admin.switch.enable",
              targetType: "user",
              targetId: existing.id,
              details: { username: existing.username, via: SWITCH_FILE },
            },
            tx,
          );
        });
        line(`  RE-ENABLED   "${existing.username}" was suspended and is active again.`);
      } else {
        line(`  ALREADY ON   "${existing.username}" is an administrator and is active.`);
      }
      line("               Its password was NOT changed by this command.");
      line("");
      line("  Sign in with the password recorded in " + SWITCH_FILE + ".");
      line("");
      return;
    }

    if (existing) {
      fail(
        `A non-administrator account already uses that username or email ("${existing.username}", ` +
          `role ${existing.role}). Refusing to promote it. Change the identity in ${SWITCH_FILE}.`,
      );
    }

    // The bootstrap is the audited creation path, and it needs both switches.
    const status = await bootstrapStatus();
    if (!status.dbEnabled) {
      await setAdminBootstrapEnabledAsOperator(true, { label: "operator" });
      line("  database switch  OFF → turned ON (operator, audited)");
    }
    const result = await bootstrapAdmin({ actorLabel: "operator" });
    if (!result.created) {
      fail(`The bootstrap did not create the account: ${result.reason}`);
    }

    // Disarm again: the switch is only needed for the one creation, and leaving
    // it armed is the state the application itself is forbidden from entering.
    // Re-arming is this command's job, and it does it every time it runs.
    await setAdminBootstrapEnabledAsOperator(false, { label: "operator" });

    line(`  CREATED      administrator "${result.username}".`);
    line("               It can sign in immediately.");
    line("  switch OFF   the bootstrap switch was disarmed again after the create.");
    line("");
    line(`  Open        http://localhost:3000/admin`);
    line("");
    return;
  }

  /* --------------------------------------------------------- admin: false */
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true, username: true },
  });
  if (admins.length === 0) {
    line("  ALREADY OFF  no administrator account exists.");
    line("");
    return;
  }

  for (const admin of admins) {
    // Sessions and tokens first, so nothing survives the deletion.
    await revokeAllSessions(admin.id);
    await prisma.$transaction(async (tx) => {
      await recordAudit(
        {
          actorLabel: "operator",
          action: "admin.switch.disable",
          targetType: "user",
          targetId: admin.id,
          details: { username: admin.username, via: SWITCH_FILE },
        },
        tx,
      );
      // The audit row keeps its text; `actorUserId` is set to null by the
      // relation's `onDelete: SetNull`, so the history stays readable.
      await tx.user.delete({ where: { id: admin.id } });
    });
    line(`  DELETED      administrator "${admin.username}" and revoked its sessions.`);
  }
  line("");
  line("  The administrator area is now unreachable. Set `admin: true` and run");
  line("  this command again to bring one back.");
  line("");
}

main().catch((error) => {
  process.stderr.write(`\n[admin:switch] ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
