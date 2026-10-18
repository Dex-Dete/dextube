/**
 * Destructive local-development reset.
 *
 * This is intentionally separate from isolated-reset.ts. It can only target
 * the database and media root explicitly declared by .env as a development
 * instance, and it requires both --apply and --confirm-reset.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "../src/lib/load-env";
import { getConfig } from "../src/lib/config";
import { databaseNameFromUrl } from "../src/lib/isolated-guards";

loadEnvFile();
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const confirmed = args.has("--confirm-reset");
const config = getConfig();
const cwd = process.cwd();
const expectedMedia = path.resolve(cwd, "storage/media");
const actualMedia = path.resolve(cwd, config.storage.mediaRoot);
const database = databaseNameFromUrl(config.databaseUrl);
const expectedDatabase = process.env.POSTGRES_DB ?? "dextube";

function fail(message: string): never {
  process.stderr.write(`[development-reset] REFUSED: ${message}\n`);
  process.exit(2);
}

if (config.environment !== "development") fail(`DEXTUBE_ENV must be development, got ${config.environment}.`);
if (!database || database !== expectedDatabase) fail(`DATABASE_URL targets ${database ?? "unknown"}, expected ${expectedDatabase}.`);
if (actualMedia !== expectedMedia) fail(`MEDIA_ROOT must be ${expectedMedia}, got ${actualMedia}.`);
if (actualMedia.includes("isolated-test")) fail("The isolated media root is not a development reset target.");
if (apply && !confirmed) fail("--apply requires --confirm-reset.");
if (!apply) {
  console.log("DRY RUN only. Add --apply --confirm-reset to execute the development wipe.");
}

async function fileTotals(root: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        count += 1;
        bytes += (await fs.stat(full)).size;
      }
    }
  }
  await walk(root);
  return { count, bytes };
}

async function main(): Promise<void> {
  const { prisma } = await import("../src/lib/db");
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name
  `;
  const counts: Array<{ table: string; rows: number }> = [];
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "${table_name.replace(/"/g, '""')}"`,
    );
    if (Number(rows[0]?.count ?? 0) > 0) counts.push({ table: table_name, rows: Number(rows[0]!.count) });
  }
  const files = await fileTotals(actualMedia);
  console.log(`development database: ${database}`);
  console.log(`media root: ${actualMedia}`);
  console.log("records:");
  for (const row of counts) console.log(`  ${row.table}: ${row.rows}`);
  console.log(`media files: ${files.count} (${files.bytes} bytes)`);
  if (!apply) return;

  const tableList = tables.map(({ table_name }) => `"${table_name.replace(/"/g, '""')}"`).join(", ");
  await prisma.$transaction(async (tx) => {
    if (tableList) await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    await tx.$executeRawUnsafe(`
      INSERT INTO system_settings (id, "adminBootstrapEnabled", "updatedAt", "updatedBy")
      VALUES (1, false, CURRENT_TIMESTAMP, 'development-reset')
      ON CONFLICT (id) DO UPDATE SET "adminBootstrapEnabled" = false, "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = 'development-reset'
    `);
  });
  for (const entry of await fs.readdir(actualMedia, { withFileTypes: true }).catch(() => [])) {
    await fs.rm(path.join(actualMedia, entry.name), { recursive: true, force: true });
  }
  console.log("RESET COMPLETE: database and development media are empty; system_settings was recreated.");
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
