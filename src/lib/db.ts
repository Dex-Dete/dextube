/**
 * Prisma client singleton.
 *
 * Next.js hot-reloads modules in development, so a naive `new PrismaClient()`
 * leaks connections. The client is cached on `globalThis` outside production.
 * Server-only.
 */
import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __dextubePrisma?: PrismaClient };

function createClient(): PrismaClient {
  // Tests subscribe to `$on("query")` to assert statement counts (see the
  // Studio analytics tests), which requires the `event` emit mode. Dev and
  // production keep the plain level list so nothing is emitted without a
  // listener.
  const isTest = process.env.NODE_ENV === "test";
  const client = new PrismaClient({
    log: isTest
      ? [{ emit: "event", level: "query" }, "warn", "error"]
      : process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
  return client;
}

export const prisma: PrismaClient = globalForPrisma.__dextubePrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__dextubePrisma = prisma;
}

/** Cheap connectivity probe used by the health endpoint. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
