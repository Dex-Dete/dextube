/**
 * `npm run isolated:metadata-test` — the isolated ten-entry migration test.
 *
 * WHAT THIS DOES
 *   1. Resolves a channel through an **authorized metadata source** and refuses
 *      to continue unless it resolved to the expected official channel id, so a
 *      lookalike cannot be silently substituted.
 *   2. Reads the ten most recent public entries and prints their *real* video
 *      ids, titles, publication dates, durations and descriptions — whatever the
 *      provider actually states, and nothing invented.
 *   3. Produces a preview/import report on disk before anything is written.
 *   4. Runs the real import service over all ten entries, in the database.
 *   5. Verifies, with SQL-shaped queries, that the database contains exactly the
 *      records it should — and that **no media was imported and no `Video` rows
 *      were fabricated**.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It imports **no media**. DEXTube has no permission to copy MrBeast's videos,
 *   and it does not bypass, circumvent or work around any access control to get
 *   them. See `docs/import.md`. Every entry is therefore recorded as
 *   `METADATA_ONLY`, which is a first-class outcome rather than a failure: the
 *   platform keeps the real publicly-published metadata with attribution, and
 *   nothing else. No download is simulated, no placeholder file is written, and
 *   no track, subtitle or rendition is invented.
 *
 * SAFETY
 *   It writes to a database, so it refuses to run when `DEXTUBE_ENV=production`,
 *   and in the isolated environment it additionally refuses unless the live
 *   database is the declared isolated one. Against development it says out loud
 *   that it is writing to the database the running site uses. It tags every row
 *   it creates so `--cleanup` removes exactly those rows and nothing else.
 *
 * USAGE
 *   npm run isolated:metadata-test
 *   npm run isolated:metadata-test -- --cleanup
 *   npm run isolated:metadata-test -- --replace      # cleanup, then run
 *   npm run isolated:metadata-test -- --channel https://www.youtube.com/@SomeChannel
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/lib/config";
import { databaseNameFromUrl } from "../src/lib/isolated-guards";
import { loadEnvFile } from "../src/lib/load-env";

loadEnvFile();

/** The official MrBeast channel, as published by YouTube. */
const CHANNEL_URL = "https://www.youtube.com/@MrBeast";
const EXPECTED_CHANNEL_ID = "UCX6OQ3DkcsbYNE6H8uQQuVA";
const ENTRY_LIMIT = 10;
/** Stamped into `authorizationBasis` so cleanup can find exactly our rows. */
const MARKER = "[isolated-metadata-test]";
const BASIS =
  `${MARKER} metadata-only: no authorization to copy media. ` +
  "Only publicly published metadata (title, id, date, description) is stored.";

const args = process.argv.slice(2);
const cleanupOnly = args.includes("--cleanup");
const replace = args.includes("--replace");
const channelArgIndex = args.indexOf("--channel");
const channelUrl = channelArgIndex >= 0 ? (args[channelArgIndex + 1] ?? "") : CHANNEL_URL;

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function die(message: string, code = 1): never {
  process.stderr.write(`\n[mrbeast] ${message}\n\n`);
  process.exit(code);
}

/**
 * The import service hands timestamps back as ISO strings in its summaries and
 * as `Date` objects in the connector layer. Both are normalised here so the
 * report cannot depend on which shape came back.
 */
function isoFull(value: string | Date | null | undefined): string {
  if (!value) return "not stated";
  return typeof value === "string" ? value : value.toISOString();
}

function isoDay(value: string | Date | null | undefined): string {
  if (!value) return "(not stated)";
  return isoFull(value).slice(0, 10);
}

/**
 * Exact row counts for the tables this test makes a claim about.
 *
 * Real `count(*)`s rather than `pg_class.reltuples`: that is a planner estimate
 * and reads as `-1` on a table nothing has analysed yet, which is exactly the
 * state a freshly reset test database is in.
 */
async function countTables(): Promise<Array<{ table_name: string; rows: number }>> {
  const { prisma } = await import("../src/lib/db");
  return prisma.$queryRaw<Array<{ table_name: string; rows: number }>>`
    SELECT 'users' AS table_name, count(*)::int AS rows FROM users
    UNION ALL SELECT 'videos', count(*)::int FROM videos
    UNION ALL SELECT 'video_assets', count(*)::int FROM video_assets
    UNION ALL SELECT 'tracks', count(*)::int FROM tracks
    UNION ALL SELECT 'channels', count(*)::int FROM channels
    UNION ALL SELECT 'import_sources', count(*)::int FROM import_sources
    UNION ALL SELECT 'import_items', count(*)::int FROM import_items
    UNION ALL SELECT 'admin_audit_logs', count(*)::int FROM admin_audit_logs
    UNION ALL SELECT 'system_settings', count(*)::int FROM system_settings
    ORDER BY table_name
  `;
}

async function main(): Promise<void> {
  const config = getConfig();
  const database = databaseNameFromUrl(config.databaseUrl);

  /* ------------------------------------------------------------ guard rails */
  if (config.environment === "production") {
    die(
      "DEXTUBE_ENV is production. This test writes to the database and is refused there; " +
        "run it against a development or isolated-test instance.",
      2,
    );
  }
  if (config.environment === "isolated-test") {
    if (database !== config.isolated.expectedDatabaseName) {
      die(
        `DATABASE_URL points at "${database ?? "(unknown)"}" but the isolated environment declares ` +
          `"${config.isolated.expectedDatabaseName}". Refusing to write.`,
        2,
      );
    }
  } else {
    // Development: this is the ordinary local database, which is what the
    // operator is looking at in the browser. Say so out loud rather than
    // pretending it is a throwaway environment.
    line("");
    line("[mrbeast] Writing to the DEVELOPMENT database — the one the running site uses.");
    line("[mrbeast] Rows are tagged, so `npm run metadata-test -- --cleanup` removes exactly them.");
  }

  const { prisma } = await import("../src/lib/db");
  const { checkDatabase } = await import("../src/lib/db");
  const dbCheck = await checkDatabase();
  if (!dbCheck.ok) die(`The database is not reachable: ${dbCheck.error ?? "unknown error"}`);

  /* --------------------------------------------------------------- the test */
  const {
    previewImport,
    createImportSource,
    runImportSource,
    getImportSource,
    listImportSources,
    deleteImportSource,
  } = await import("../src/server/services/import-sources");

  const actor = { userId: null, label: "cli" } as const;

  /** Removes every source this script created, and nothing else. */
  async function cleanup(): Promise<number> {
    const sources = await listImportSources({ take: 200 });
    const mine = sources.filter((source) => source.authorizationBasis.includes(MARKER));
    for (const source of mine) {
      await deleteImportSource(source.id, { ...actor, label: "cli" });
    }
    return mine.length;
  }

  if (cleanupOnly) {
    const removed = await cleanup();
    line(`Removed ${removed} source(s) created by this test (items cascade; no videos were ever created).`);
    return;
  }

  const existing = (await listImportSources({ take: 200 })).filter((s) =>
    s.authorizationBasis.includes(MARKER),
  );
  if (existing.length > 0) {
    if (replace) {
      const removed = await cleanup();
      line(`Removed ${removed} previous run(s) first (--replace).`);
    } else {
      die(
        `${existing.length} source(s) from a previous run already exist. ` +
          "Run with --cleanup to remove them, or --replace to clean up and run again.",
        2,
      );
    }
  }

  /* ------------------------------------------------------------- 1. resolve */
  line("");
  line("TEN-ENTRY METADATA TEST (MrBeast)");
  line("==============================");
  line(`  database   ${database}`);
  line(`  media      ${path.resolve(process.cwd(), config.storage.mediaRoot)}`);
  line(`  source     ${channelUrl}`);
  line(
    `  provider   ${
      config.imports.youtubeApiKey
        ? "YouTube Data API v3 (official API)"
        : "YouTube's official public channel feed (no API key configured)"
    }`,
  );
  line("");

  const preview = await previewImport({ input: channelUrl, scopeLimit: ENTRY_LIMIT });

  if (channelUrl === CHANNEL_URL && preview.externalChannelId !== EXPECTED_CHANNEL_ID) {
    die(
      `Refusing to continue: that address resolved to channel "${preview.externalChannelId ?? "(unknown)"}", ` +
        `not the official MrBeast channel (${EXPECTED_CHANNEL_ID}). Pass --channel <url> to test another channel.`,
      2,
    );
  }

  line(`CHANNEL RESOLVED`);
  line(`  name       ${preview.title ?? "(the provider did not state a title)"}`);
  line(`  channel id ${preview.externalChannelId ?? "(unknown)"}`);
  line(`  url        ${preview.canonicalUrl}`);
  line(`  entries    ${preview.entries.length} requested / ${ENTRY_LIMIT}`);
  for (const limitation of preview.limitations) line(`  limitation ${limitation}`);
  line("");

  line("THE TEN MOST RECENT PUBLIC ENTRIES (verbatim provider metadata)");
  line("");
  preview.entries.forEach((entry, index) => {
    const published = isoDay(entry.publishedAt);
    const duration =
      entry.durationSeconds === null ? "(not stated)" : `${Math.floor(entry.durationSeconds / 60)}m${entry.durationSeconds % 60}s`;
    const description = entry.description?.replace(/\s+/g, " ").trim() ?? "";
    line(`  ${String(index + 1).padStart(2)}. ${entry.title}`);
    line(`      id         ${entry.externalId}`);
    line(`      published  ${published}   duration: ${duration}`);
    line(`      thumbnail  ${entry.thumbnailUrl ?? "(not stated)"}`);
    line(`      source     ${entry.canonicalUrl}`);
    line(`      credit     ${entry.attribution}`);
    line(
      `      desc       ${description ? (description.length > 160 ? `${description.slice(0, 157)}…` : description) : "(not stated)"}`,
    );
    line("");
  });

  /* ------------------------------------------------------ 2. import report */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportDir = path.resolve(process.cwd(), "storage/isolated-test/reports");
  await fs.mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, `mrbeast-metadata-${stamp}.json`);
  const mdPath = path.join(reportDir, `mrbeast-metadata-${stamp}.md`);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: config.environment,
    database,
    source: channelUrl,
    provider: config.imports.youtubeApiKey ? "youtube-data-api-v3" : "youtube-public-feed",
    channel: {
      title: preview.title,
      externalChannelId: preview.externalChannelId,
      canonicalUrl: preview.canonicalUrl,
    },
    limitations: preview.limitations,
    mediaImported: false,
    mediaImportReason:
      "No authorization to copy this creator's media. DEXTube does not download, rip or circumvent " +
      "access controls; entries are recorded as metadata-only with attribution.",
    entries: preview.entries.map((entry) => ({
      externalId: entry.externalId,
      title: entry.title,
      description: entry.description,
      publishedAt: isoFull(entry.publishedAt),
      durationSeconds: entry.durationSeconds,
      thumbnailUrl: entry.thumbnailUrl,
      canonicalUrl: entry.canonicalUrl,
      attribution: entry.attribution,
      plannedOutcome: "METADATA_ONLY",
    })),
  };
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(
    mdPath,
    [
      `# Isolated ten-entry metadata test — ${stamp}`,
      "",
      `- Environment: \`${config.environment}\` (database \`${database}\`)`,
      `- Source: ${channelUrl}`,
      `- Provider: ${report.provider}`,
      `- Channel: ${preview.title ?? "(no title stated)"} (\`${preview.externalChannelId ?? "unknown"}\`)`,
      "",
      "## Media",
      "",
      report.mediaImportReason,
      "",
      ...(preview.limitations.length > 0
        ? ["## Limitations", "", ...preview.limitations.map((l) => `- ${l}`), ""]
        : []),
      "## Entries (real provider metadata; no field is invented)",
      "",
      ...preview.entries.flatMap((entry, index) => [
        `### ${index + 1}. ${entry.title}`,
        "",
        `- Video id: \`${entry.externalId}\``,
        `- Published: ${isoFull(entry.publishedAt)}`,
        `- Duration: ${entry.durationSeconds === null ? "not stated" : `${entry.durationSeconds}s`}`,
        `- Thumbnail reference: ${entry.thumbnailUrl ?? "not stated"}`,
        `- Source: ${entry.canonicalUrl}`,
        `- Credit: ${entry.attribution}`,
        `- Description: ${entry.description ?? "not stated"}`,
        "",
      ]),
    ].join("\n"),
    "utf8",
  );

  line(`REPORT WRITTEN BEFORE IMPORTING`);
  line(`  ${jsonPath}`);
  line(`  ${mdPath}`);
  line("");

  /* ------------------------------------------------------------ 3. import */
  // The counts before the import. Comparing them afterwards is the real proof
  // that no video was fabricated — and it is the same assertion whether the
  // database is an empty throwaway or the developer's working database with ten
  // videos already in it.
  const before = await countTables();

  const created = await createImportSource({
    input: channelUrl,
    scopeLimit: ENTRY_LIMIT,
    authorizationBasis: BASIS,
    mediaAuthorized: false,
    actor: { ...actor },
  });
  line(`IMPORT SOURCE CREATED  ${created.source.id}`);
  line(`  status     ${created.source.status}`);
  line(`  items      ${created.source.counts.total}`);
  line(`  media      NOT authorized (metadata-only)`);
  for (const limitation of created.limitations) line(`  limitation ${limitation}`);
  line("");

  const run = await runImportSource(created.source.id, { ...actor });
  line(`IMPORT RUN COMPLETE`);
  line(`  status     ${run.status}`);
  line(`  imported   ${run.counts.imported}   (media actually copied — expected 0)`);
  line(`  metadata   ${run.counts.metadataOnly}   (metadata only — expected ${ENTRY_LIMIT})`);
  line(`  duplicates ${run.counts.duplicates}`);
  line(`  failed     ${run.counts.failed}`);
  line(`  bytes      ${run.bytesImported}`);
  line("");

  /* -------------------------------------------------------- 4. verification */
  const loaded = await getImportSource(created.source.id);
  if (!loaded) die("The source vanished immediately after the run.");

  const videosForSource = await prisma.video.count({
    where: { id: { in: loaded.items.map((item) => item.videoId ?? "").filter(Boolean) } },
  });
  const totalVideos = await prisma.video.count();
  const totalSources = await prisma.importSource.count();
  const totalItems = await prisma.importItem.count();
  const tableCounts = await countTables();
  const rowsFor = (table: string): number =>
    tableCounts.find((row) => row.table_name === table)?.rows ?? 0;
  const rowsBefore = (table: string): number =>
    before.find((row) => row.table_name === table)?.rows ?? 0;

  const failures: string[] = [];

  /**
   * Content tables an import must never touch. The number itself does not
   * matter — that it did not change does. This is the same assertion whether the
   * database is an empty throwaway or a working database with existing videos,
   * so the test is honest in both environments instead of only passing in one.
   */
  const mustNotChange = ["videos", "video_assets", "tracks", "channels"] as const;
  for (const table of mustNotChange) {
    const delta = rowsFor(table) - rowsBefore(table);
    if (delta !== 0) {
      failures.push(`"${table}" changed by ${delta} (${rowsBefore(table)} → ${rowsFor(table)})`);
    }
  }
  if (rowsFor("import_sources") - rowsBefore("import_sources") !== 1) {
    failures.push("exactly one import source should have been added");
  }
  if (rowsFor("import_items") - rowsBefore("import_items") !== ENTRY_LIMIT) {
    failures.push(`exactly ${ENTRY_LIMIT} import items should have been added`);
  }

  if (loaded.items.length !== ENTRY_LIMIT) {
    failures.push(`expected ${ENTRY_LIMIT} items, found ${loaded.items.length}`);
  }
  if (loaded.items.some((item) => item.status !== "METADATA_ONLY")) {
    failures.push(
      `expected every item to be METADATA_ONLY, found: ${[
        ...new Set(loaded.items.map((item) => item.status)),
      ].join(", ")}`,
    );
  }
  if (loaded.items.some((item) => item.videoId)) {
    failures.push("an item carries a videoId, which would mean media was imported");
  }
  if (videosForSource !== 0) failures.push(`expected 0 videos for the import, found ${videosForSource}`);
  if (run.counts.imported !== 0) failures.push(`expected 0 imported items, found ${run.counts.imported}`);
  const missing = loaded.items.filter((item) => !item.title || !item.externalId);
  if (missing.length > 0) failures.push(`${missing.length} item(s) are missing a real title or id`);

  line("DATABASE VERIFICATION");
  line(`  import source          ${loaded.source.status}, items ${loaded.items.length}`);
  line(`  items METADATA_ONLY    ${loaded.items.filter((i) => i.status === "METADATA_ONLY").length}`);
  line(`  items IMPORTED         ${loaded.items.filter((i) => i.status === "IMPORTED").length}`);
  line(`  videos for this import ${videosForSource}`);
  line(`  import_sources / items ${totalSources} / ${totalItems}`);
  line(`  videos in database     ${totalVideos}`);
  line("  row counts (exact, measured; before → after this import)");
  for (const row of tableCounts) {
    const was = rowsBefore(row.table_name);
    const delta = row.rows - was;
    const arrow = delta === 0 ? "unchanged" : `${was} → ${row.rows}`;
    line(`    ${row.table_name.padEnd(18)} ${String(row.rows).padStart(5)}   ${arrow}`);
  }
  line("");

  line("INTENDED-RECORD CHECK");
  if (failures.length === 0) {
    line("  PASS — every entry was stored as real metadata, no media was imported,");
    line("         and no Video row was fabricated.");
  } else {
    for (const failure of failures) line(`  FAIL — ${failure}`);
  }
  line("");

  /**
   * The preview report is written before the run, as §1 requires. This second
   * file records what the run actually did and what the database actually held
   * afterwards, so the claim "ten metadata-only entries, no media" is evidence
   * on disk rather than a line of console output.
   */
  const resultPath = path.join(reportDir, `mrbeast-metadata-result-${stamp}.json`);
  await fs.writeFile(
    resultPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        environment: config.environment,
        database,
        sourceUrl: channelUrl,
        mediaAuthorized: false,
        source: {
          id: loaded.source.id,
          status: loaded.source.status,
          counts: loaded.source.counts,
          bytesImported: loaded.source.bytesImported,
        },
        items: loaded.items.map((item) => ({
          externalId: item.externalId,
          title: item.title,
          status: item.status,
          videoId: item.videoId,
          attempts: item.attempts,
          lastError: item.lastError,
        })),
        verification: {
          videosCreatedForThisImport: videosForSource,
          videosInDatabase: totalVideos,
          importSources: totalSources,
          importItems: totalItems,
          rowCounts: Object.fromEntries(tableCounts.map((row) => [row.table_name, row.rows])),
          failures,
          passed: failures.length === 0,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  line(`RESULT WRITTEN  ${resultPath}`);
  line("");

  line("CLEANUP");
  line("  npm run metadata-test -- --cleanup      # remove the import source + items");
  if (config.environment === "isolated-test") {
    line("  npm run isolated:reset                  # clear the whole isolated environment");
  }
  line("");

  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\n[mrbeast] ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
