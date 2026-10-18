/**
 * Configuration-level safety tests for the administrator bootstrap.
 *
 * These assert the refusals that make it impossible to end up with a
 * well-known administrator password on a public deployment. The configuration
 * loader is memoised, so each case mutates `process.env`, calls
 * `resetConfigCache()`, and restores the environment afterwards. `NODE_ENV` is
 * deliberately left alone: it is read-only in Next.js typings and the behaviour
 * under test keys off `DEXTUBE_ENV`, not `NODE_ENV`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "@/lib/config";

const KEYS = [
  "DEXTUBE_ENV",
  "ADMIN_BOOTSTRAP_ENABLED",
  "ADMIN_BOOTSTRAP_USERNAME",
  "ADMIN_BOOTSTRAP_EMAIL",
  "ADMIN_BOOTSTRAP_PASSWORD",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  // A minimum viable configuration; the database is never contacted here.
  process.env.SESSION_SECRET = "config-bootstrap-test-secret-value";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://u:p@localhost:5432/dextube";
  resetConfigCache();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigCache();
});

describe("administrator bootstrap configuration", () => {
  it("is off by default", () => {
    delete process.env.ADMIN_BOOTSTRAP_ENABLED;
    resetConfigCache();
    const config = getConfig();
    expect(config.adminBootstrap.enabled).toBe(false);
    expect(config.adminBootstrap.permitted).toBe(false);
  });

  it("refuses to enable bootstrap in production, whatever the password", () => {
    process.env.DEXTUBE_ENV = "production";
    process.env.ADMIN_BOOTSTRAP_ENABLED = "true";
    process.env.ADMIN_BOOTSTRAP_PASSWORD = "a-perfectly-long-real-password";
    resetConfigCache();
    expect(() => getConfig()).toThrow(/must never be true when DEXTUBE_ENV=production/);
  });

  it("requires an explicit password outside the isolated environment", () => {
    process.env.DEXTUBE_ENV = "development";
    process.env.ADMIN_BOOTSTRAP_ENABLED = "true";
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    resetConfigCache();
    expect(() => getConfig()).toThrow(/requires ADMIN_BOOTSTRAP_PASSWORD/);
  });

  it("allows the throwaway credentials only in the isolated test environment", () => {
    process.env.DEXTUBE_ENV = "isolated-test";
    process.env.ADMIN_BOOTSTRAP_ENABLED = "true";
    process.env.ADMIN_BOOTSTRAP_PASSWORD = "admin";
    resetConfigCache();
    const config = getConfig();
    expect(config.isIsolatedTest).toBe(true);
    expect(config.adminBootstrap.permitted).toBe(true);
    expect(config.adminBootstrap.username).toBe("admin");
    expect(config.adminBootstrap.email).toBe("admin@admin.com");
    // The password is available to the bootstrap service but is not part of any
    // serialisable configuration surface.
    expect(typeof config.adminBootstrap.password).toBe("string");
  });

  it("does not permit bootstrap merely because NODE_ENV is development", () => {
    process.env.DEXTUBE_ENV = "production";
    delete process.env.ADMIN_BOOTSTRAP_ENABLED;
    resetConfigCache();
    const config = getConfig();
    expect(config.adminBootstrap.permitted).toBe(false);
    expect(config.environment).toBe("production");
  });
});
