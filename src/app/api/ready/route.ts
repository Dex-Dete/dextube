/**
 * Readiness endpoint.
 *
 * Kept separate from `/api/health` on purpose. Health answers "is this instance
 * healthy?" and probes everything, including spawning FFmpeg and FFprobe, which
 * costs hundreds of milliseconds. Readiness answers the narrower question a load
 * balancer or orchestrator actually asks — "may I send this instance traffic?" —
 * and that only needs the request path to work: a reachable database and a
 * storage volume that can be written and read back.
 *
 * It is deliberately cheap and side-effect free (no queue kick, no transcoder
 * probe) and reports **only** booleans: no filesystem paths, versions or
 * configuration, because this endpoint is reachable without authentication.
 */
import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { checkStorage } from "@/server/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const ready = database.ok && storage.ok;

  return NextResponse.json(
    {
      status: ready ? "ready" : "not ready",
      checks: {
        database: database.ok,
        storage: storage.ok,
        // The driver name is configuration, not a secret, and it is the one
        // detail that makes a failure diagnosable at a glance.
        storageDriver: storage.driver,
      },
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
