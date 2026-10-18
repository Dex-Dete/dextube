/**
 * DEXTube background worker entry point.
 *
 *   npm run worker
 *
 * Requires JOB_RUNNER=external for the web app to skip inline processing.
 * Handles SIGINT/SIGTERM so `Ctrl-C` (and systemd/Docker stop) finishes the
 * job in flight before exiting.
 */
import { loadEnvFile } from "../lib/load-env";

loadEnvFile();

async function main() {
  const { runWorkerLoop } = await import("../server/jobs/runner");
  const { logger } = await import("../lib/logger");
  const log = logger.child({ proc: "worker" });

  const controller = new AbortController();
  const shutdown = (signal: string) => {
    log.info("shutdown signal received", { signal });
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection in worker", { err: reason instanceof Error ? reason.message : String(reason) });
  });

  await runWorkerLoop(controller.signal);
  process.exit(0);
}

main().catch((error) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
