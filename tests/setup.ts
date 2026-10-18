/**
 * Vitest global setup.
 *
 * Loads `.env` the same way the worker, seed and scripts do. `loadEnvFile`
 * never overrides variables that are already set, so an explicit
 * `DATABASE_URL=... npm test` still wins.
 */
import { loadEnvFile } from "@/lib/load-env";

loadEnvFile();
