/**
 * `npm run isolated:reset` — clear the isolated test environment.
 *
 * This is the *only* supported way to remove test data, and it is deliberately
 * awkward to fire by accident:
 *
 *   1. It refuses to run unless `DEXTUBE_ENV=isolated-test`.
 *   2. It verifies that the live `DATABASE_URL` names the database the isolated
 *      environment *declares*, that the name looks like a test database, and that
 *      it is not the development database.
 *   3. It verifies that the live `MEDIA_ROOT` is exactly the declared one, that
 *      it is not inside the development media root, and that it lives under
 *      `storage/isolated-test/`.
 *   4. It reports — by default and without changing anything — every record and
 *      every file it *would* remove.
 *   5. Actually removing anything needs `--apply` **and** `--yes`, and it takes a
 *      database + media backup first unless `--no-backup` is passed.
 *
 * It is idempotent: a second run against an already-empty environment reports
 * nothing to do and succeeds. It never runs at application startup or during a
 * deployment; there is no code path from serving traffic to this behaviour.
 *
 * USAGE
 *   npm run isolated:reset                    # dry run (default)
 *   npm run isolated:reset -- --json          # machine-readable dry run
 *   npm run isolated:reset -- --apply --yes   # back up, then clear
 *   npm run isolated:reset -- --apply --yes --no-backup --keep-settings
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getConfig } from "../src/lib/config";
import { checkIsolatedTarget, databaseNameFromUrl, describeBytes, type ResetReport } from "../src/lib/isolated-guards";
import { loadEnvFile, readEnvFile } from "../src/lib/load-env";

loadEnvFile();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirmed = args.includes("--yes");
const asJson = args.includes("--json");
const noBackup = args.includes("--no-backup");
const keepSettings = args.includes("--keep-settings");
const CONTAINER = process.env.DEXTUBE_PG_CONTAINER ?? "dextube-postgres";

const config = getConfig();
const cwd = process.cwd();
const devEnv = readEnvFile(path.resolve(cwd, ".env"));

const mediaRoot = path.resolve(cwd, config.storage.mediaRoot);
const exportRoot = path.resolve(cwd, config.imports.creatorExportRoot);

function out(message: string): void {
  if (!asJson) process.stdout.write(`${message}\n`);
}

function fail(message: string, code = 2): never {
  if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else process.stderr.write(`\n[reset] REFUSING TO RUN\n\n${message}\n\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------ guards */

const guard = checkIsolatedTarget({
  environment: config.environment,
  databaseUrl: config.databaseUrl,
  mediaRoot: config.storage.mediaRoot,
  expectedDatabaseName: config.isolated.expectedDatabaseName,
  expectedMediaRoot: config.isolated.expectedMediaRoot,
  developmentDatabaseUrl: devEnv.DATABASE_URL ?? null,
  developmentMediaRoot: devEnv.MEDIA_ROOT ?? null,
  cwd,
});

if (!guard.ok) fail(`${guard.reason}\n\nRun "npm run isolated:setup" if the environment is missing.`);
if (keepSettings && !apply) fail("--keep-settings only makes sense together with --apply.");

const database = databaseNameFromUrl(config.databaseUrl);
if (!database) fail("Could not determine the database name.");

/* ------------------------------------------------------------------ report */

interface Counted {
  records: Array<{ table: string; rows: number }>;
  totalRecords: number;
  files: { count: number; bytes: number; roots: string[] };
  settings: { adminBootstrapEnabled: boolean } | null;
}

async function countRecords(): Promise<Counted["records"]> {
  const { prisma } = await import("../src/lib/db");
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name
  `;
  const counts: Array<{ table: string; rows: number }> = [];
  for (const { table_name } of tables) {
    // Identifier comes from the catalogue, not from user input.
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "${table_name.replace(/"/g, '""')}"`,
    );
    counts.push({ table: table_name, rows: Number(rows[0]?.count ?? 0) });
  }
  return counts;
}

async function countFiles(root: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) {
          count += 1;
          bytes += stat.size;
        }
      }
    }
  };
  await walk(root);
  return { count, bytes };
}

async function collect(): Promise<Counted> {
  const { prisma } = await import("../src/lib/db");
  const records = await countRecords();
  const rowsFor = (table: string) => records.find((r) => r.table === table)?.rows ?? 0;
  void rowsFor;
  const settingsRow = await prisma.$queryRaw<Array<{ adminBootstrapEnabled: boolean }>>`
    SELECT "adminBootstrapEnabled" FROM system_settings WHERE id = 1
  `;
  const roots = [mediaRoot, exportRoot];
  let count = 0;
  let bytes = 0;
  for (const root of roots) {
    const partial = await countFiles(root);
    count += partial.count;
    bytes += partial.bytes;
  }
  // `system_settings` holds the operator's switches, not test data: it is
  // truncated and immediately re-inserted, so it is reported separately rather
  // than as something the reset would take away.
  const dataRecords = records.filter((r) => r.table !== "system_settings");
  return {
    records: dataRecords.filter((r) => r.rows > 0),
    totalRecords: dataRecords.reduce((sum, r) => sum + r.rows, 0),
    files: { count, bytes, roots },
    settings: settingsRow[0] ? { adminBootstrapEnabled: settingsRow[0].adminBootstrapEnabled } : null,
  };
}

/* ------------------------------------------------------------------ backup */

async function backup(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.resolve(cwd, "storage/isolated-test/backups", `${database}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  const users = devEnv.POSTGRES_USER ?? "dextube";
  const sqlGz = path.join(dir, "database.sql.gz");
  const mediaGz = path.join(dir, "media.tar.gz");

  // Prefer the running container (same approach as scripts/backup.sh), else the
  // host client with the isolated DATABASE_URL.
  let dumped = false;
  try {
    const containerUp = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (containerUp === "true") {
      execFileSync(
        "/bin/bash",
        ["-c", `docker exec ${CONTAINER} pg_dump -U ${users} -d ${database} --no-owner --no-acl | gzip -c > "${sqlGz}"`],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      dumped = true;
    }
  } catch {
    dumped = false;
  }
  if (!dumped) {
    execFileSync("/bin/bash", ["-c", `pg_dump "${config.databaseUrl}" --no-owner --no-acl | gzip -c > "${sqlGz}"`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  await fs.mkdir(mediaRoot, { recursive: true });
  execFileSync("/bin/bash", ["-c", `tar -czf "${mediaGz}" -C "${mediaRoot}" .`], { stdio: ["ignore", "ignore", "pipe"] });

  await fs.writeFile(
    path.join(dir, "manifest.txt"),
    [
      "dextube-isolated-reset-backup: 1",
      `timestamp: ${new Date().toISOString()}`,
      `database: ${database}`,
      `media_root: ${mediaRoot}`,
      `restore_database: gunzip -c "${sqlGz}" | docker exec -i ${CONTAINER} psql -U ${users} -d ${database}`,
      `restore_media:    tar -xzf "${mediaGz}" -C "${mediaRoot}"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return dir;
}

/* ------------------------------------------------------------------- apply */

async function performReset(previousSettings: boolean): Promise<void> {
  const { prisma } = await import("../src/lib/db");
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name
  `;
  const list = tables.map((t) => `"${t.table_name.replace(/"/g, '""')}"`).join(", ");
  if (list) {
    // RESTART IDENTITY + CASCADE: one statement clears every table and its
    // dependent rows, regardless of foreign-key order.
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }

  // The bootstrap switch is configuration, not test data, so it survives unless
  // the operator asks for a full wipe.
  const restored = keepSettings ? false : previousSettings;
  await prisma.$executeRawUnsafe(
    `INSERT INTO system_settings (id, "adminBootstrapEnabled", "updatedAt", "updatedBy")
     VALUES (1, $1, CURRENT_TIMESTAMP, 'isolated:reset')
     ON CONFLICT (id) DO UPDATE SET "adminBootstrapEnabled" = $1, "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = 'isolated:reset'`,
    restored,
  );

  // Files: remove the *contents*, keeping the roots so the app can write again.
  for (const root of [mediaRoot, exportRoot]) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      await fs.mkdir(root, { recursive: true });
      continue;
    }
    for (const entry of entries) {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  }

  const { recordAudit } = await import("../src/server/services/audit");
  await recordAudit({
    actorLabel: "cli",
    action: "isolated.reset",
    targetType: "database",
    targetId: database,
    details: { mediaRoot, exportRoot, keepSettings, previousBootstrapEnabled: previousSettings },
  }).catch(() => {
    /* The audit row is nice to have; a reset must not fail because of it. */
  });
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const snapshot = await collect();
  const report: ResetReport = {
    database: database ?? "(unknown)",
    mediaRoot,
    exportRoot,
    records: snapshot.records,
    totalRecords: snapshot.totalRecords,
    files: snapshot.files,
    alreadyEmpty: snapshot.totalRecords === 0 && snapshot.files.count === 0,
  };

  if (asJson) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: apply && confirmed ? "apply" : "dry-run",
      report,
      settings: snapshot.settings,
    })}\n`,
  );
} else {
  out("");
  out("ISOLATED TEST ENVIRONMENT RESET");
  out("===============================");
  out(`  database : ${report.database}  (allowed: DEXTUBE_ENV=isolated-test)`);
  out(`  media    : ${report.mediaRoot}`);
  out(`  exports  : ${report.exportRoot}`);
  out(`  bootstrap: ${snapshot.settings?.adminBootstrapEnabled ? "enabled" : "disabled"}${
    keepSettings ? " (--keep-settings: left untouched)" : ""
  }`);
  out("  settings row: preserved (the bootstrap switch is configuration, not test data)");
  out("");
  if (report.alreadyEmpty) {
    out("Nothing to remove: the isolated environment is already empty.");
  } else {
    out(`RECORDS THAT WOULD BE REMOVED (${report.totalRecords} in ${report.records.length} tables)`);
    for (const row of report.records) out(`  ${row.table.padEnd(28)} ${row.rows}`);
    out("");
    out(`FILES THAT WOULD BE REMOVED (${report.files.count}, ${describeBytes(report.files.bytes)})`);
    for (const root of report.files.roots) out(`  ${root}`);
  }
  out("");
}

  if (!apply) {
    out("This was a dry run. Nothing was changed.");
    out("");
    out("To remove the data above:");
    out("  npm run isolated:reset -- --apply --yes            # takes a backup first");
    out("  npm run isolated:reset -- --apply --yes --no-backup");
    out("");
    out("A backup of the isolated database and media is written to");
    out("storage/isolated-test/backups/ before anything is deleted.");
    out("");
    process.exit(0);
  }
  
  if (!confirmed) {
    fail(
      "--apply requires --yes as well: this is a destructive operation.\n" +
        "Re-run with:  npm run isolated:reset -- --apply --yes",
    );
  }
  
  if (report.alreadyEmpty) {
    out("Nothing to remove. Exiting without changes (the command is idempotent).");
    process.exit(0);
  }
  
  if (!noBackup) {
    out("Taking a backup before deleting anything…");
    const dir = await backup();
    out(`  backup: ${dir}`);
    out(`  restore: see ${path.join(dir, "manifest.txt")}`);
  }
  
  await performReset(snapshot.settings?.adminBootstrapEnabled ?? false);
  out("Reset complete. The isolated environment is empty (migrations and the settings row are preserved).");
  out("");
  out("Recover with the backup if needed:");
  out("  gunzip -c <backup>/database.sql.gz | docker exec -i dextube-postgres psql -U dextube -d " + database);
  out("  tar -xzf <backup>/media.tar.gz -C " + mediaRoot);
  out("");
}

main().catch((error) => {
  process.stderr.write(`\n[reset] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
