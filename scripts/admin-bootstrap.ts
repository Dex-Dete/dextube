/**
 * `npm run admin:bootstrap` — create the one-time initial administrator.
 *
 * Safe to run repeatedly: it creates nothing once an administrator exists, and
 * it never prints or stores the configured password. It is silent (exit 0) when
 * a precondition is not met and exits non-zero only when the bootstrap *should*
 * have run but could not (for example, no password is configured).
 *
 *   npm run admin:bootstrap
 *       Run the bootstrap with the environment and database switches as they are.
 *
 *   npm run admin:bootstrap -- --enable-bootstrap-as-operator
 *       Operator-only: first turn the database switch ON (an action the web
 *       application itself is forbidden from taking), then run the bootstrap.
 *
 * The database switch is the operator's permanent off-switch. The application
 * can only ever turn it off; re-arming it requires direct database access, which
 * is exactly what this command (running on the server host) represents.
 */
import { loadEnvFile } from "../src/lib/load-env";

loadEnvFile();

const ENABLE_FLAG = "--enable-bootstrap-as-operator";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const enableAsOperator = args.includes(ENABLE_FLAG);

  const { getConfig } = await import("../src/lib/config");
  const { prisma } = await import("../src/lib/db");
  const { bootstrapAdmin, bootstrapStatus } = await import("../src/server/services/admin-bootstrap");
  const { setAdminBootstrapEnabledAsOperator, getSystemSettings } = await import(
    "../src/server/services/system-settings"
  );

  try {
    const config = getConfig();
    console.log("\nDEXTube administrator bootstrap\n" + "─".repeat(64));
    console.log(`  environment        ${config.environment}`);
    console.log(`  env switch         ${config.adminBootstrap.enabled ? "enabled" : "disabled"} (ADMIN_BOOTSTRAP_ENABLED)`);

    if (enableAsOperator) {
      const before = (await getSystemSettings()).adminBootstrapEnabled;
      console.log("─".repeat(64));
      console.log(`  OPERATOR OVERRIDE  ${ENABLE_FLAG}`);
      console.log(`  database switch    ${before ? "already enabled" : "OFF → turning ON"}`);
      console.log("  This is the operator-only path. It will be recorded in the audit log as");
      console.log('  actor "operator". Re-enable the bootstrap only on the server host.');
      if (!before) {
        await setAdminBootstrapEnabledAsOperator(true);
        console.log("  database switch    now enabled");
      }
      console.log("─".repeat(64));
    }

    const status = await bootstrapStatus();
    console.log(`  database switch    ${status.dbEnabled ? "enabled" : "disabled"}`);
    console.log(`  permitted here     ${status.permitted ? "yes" : "no"}`);
    console.log(`  existing admins    ${status.adminCount}`);
    console.log(`  bootstrap identity ${status.username} (password ${status.hasPassword ? "set" : "not set"})`);
    console.log("─".repeat(64));

    const result = await bootstrapAdmin({ actorLabel: "cli" });

    if (result.created) {
      console.log(`  CREATED  administrator "${result.username}".`);
      console.log("  It must change its password on first sign-in before using admin tools.");
    } else {
      console.log(`  SKIPPED  ${result.reason}.`);
    }
    console.log("─".repeat(64) + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nadmin:bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
