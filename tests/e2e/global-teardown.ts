/**
 * Playwright global teardown.
 *
 * Removes every account created by the e2e suite (usernames prefixed `e2e_`).
 * Deleting a user cascades to its channel, videos, comments and sessions, so
 * the development database does not accumulate test data between runs.
 *
 * The database URL is read from the environment or `.env` so this file has no
 * dependency on the app's module aliases.
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

export default async function globalTeardown(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url) return;

  process.env.DATABASE_URL = url;
  const prisma = new PrismaClient();
  try {
    const removed = await prisma.user.deleteMany({ where: { username: { startsWith: "e2e_" } } });
    if (removed.count > 0) {
      console.log(`[e2e teardown] removed ${removed.count} test account(s)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
