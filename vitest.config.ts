/**
 * Vitest configuration.
 *
 * Tests run in a plain Node environment. DEXTube's server modules are all
 * marked `server-only`, so that package is aliased to an empty shim (importing
 * it is a build-time guard for the Next.js bundler, not runtime behaviour we
 * need to reproduce here). The `@/` path alias mirrors `tsconfig.json`.
 *
 * Integration tests talk to the real PostgreSQL database configured in `.env`
 * and therefore run serially (`fileParallelism: false`).
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, "src")}/` },
      { find: "server-only", replacement: path.resolve(__dirname, "tests/shims/empty.ts") },
      { find: "client-only", replacement: path.resolve(__dirname, "tests/shims/empty.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    // Integration tests share one database; never run files in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});
