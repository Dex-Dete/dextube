/**
 * Playwright global setup.
 *
 * The e2e suite registers real accounts through the real forms, and DEXTube
 * rate-limits registration to 5 per hour per IP. Without this step a second run
 * on the same machine would be rejected with "Too many requests" — a test
 * artefact, not a product bug. The suite therefore clears the rate-limit
 * buckets for the development database before it starts.
 *
 * It also removes any `e2e_` accounts a previously interrupted run left behind,
 * so the cleanup in `global-teardown.ts` always starts from a known state.
 *
 * Both actions are safe on a development database and are the only reason this
 * file talks to PostgreSQL directly. The database URL is read from the
 * environment or `.env` so this file has no dependency on the app's aliases.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const content = readFileSync(".env", "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const match = /^DATABASE_URL=(.*)$/.exec(rawLine.trim());
      if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — leave cleaning to the caller */
  }
  return undefined;
}

export default async function globalSetup(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.warn("[e2e setup] DATABASE_URL not found; skipping test hygiene.");
    return;
  }

  process.env.DATABASE_URL = url;
  const prisma = new PrismaClient();
  try {
    const buckets = await prisma.rateLimitBucket.deleteMany({});
    const stale = await prisma.user.deleteMany({ where: { username: { startsWith: "e2e_" } } });
    console.log(
      `[e2e setup] cleared ${buckets.count} rate-limit bucket(s)` +
        (stale.count > 0 ? ` and removed ${stale.count} stale test account(s)` : ""),
    );
  } finally {
    await prisma.$disconnect();
  }
}
