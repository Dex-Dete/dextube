/**
 * Integration test for the isolated reset command's refusal behaviour.
 *
 * The command is exercised as a real child process with real environment
 * variables, because the whole point of the guard is that it reads the *live*
 * configuration. Every case here asserts a refusal and leaves the environment
 * untouched — nothing in this file ever passes `--apply --yes`.
 *
 * Skipped when `.env.isolated-test` is absent, since the isolated environment is
 * created by `npm run isolated:setup` rather than by the test suite.
 *
 * Note the deliberate `delete` loop below: vitest's setup file loads the ordinary
 * `.env` into `process.env`, so without scrubbing those keys every child would
 * inherit the *development* DATABASE_URL and the guard would (correctly) refuse
 * for a reason unrelated to the case under test.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const HAS_ISOLATED_ENV = fs.existsSync(path.join(ROOT, ".env.isolated-test"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = path.join(ROOT, "scripts", "isolated-reset.ts");

const SCRUBBED = [
  "DEXTUBE_ENV",
  "DEXTUBE_ENV_FILE",
  "DATABASE_URL",
  "MEDIA_ROOT",
  "ISOLATED_DATABASE_NAME",
  "ISOLATED_MEDIA_ROOT",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...(process.env as Record<string, string>) };
  for (const key of SCRUBBED) delete env[key];
  env.NODE_OPTIONS = "--conditions=react-server";
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

/**
 * The only thing the child needs is the path to the generated environment file.
 * Everything else (credentials, secret, media root) is read from that file by
 * `loadEnvFile`, which never overrides variables that are already set — so the
 * per-case `overrides` below win, which is exactly what the tests need.
 */
const ISOLATED_ENV: Record<string, string> = {
  DEXTUBE_ENV_FILE: ".env.isolated-test",
};

function runReset(args: string[] = [], overrides: Record<string, string> = {}): RunResult {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: ROOT,
    env: childEnv({ ...ISOLATED_ENV, ...overrides }),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Runs with the ordinary `.env`, which is the development environment. */
function runAgainstDevelopment(): RunResult {
  const env = { ...(process.env as Record<string, string>) };
  for (const key of SCRUBBED) delete env[key];
  env.NODE_OPTIONS = "--conditions=react-server";
  env.DEXTUBE_ENV_FILE = ".env";
  const result = spawnSync(TSX, [SCRIPT], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe.skipIf(!HAS_ISOLATED_ENV)("isolated reset command", () => {
  it("refuses to run against the development environment", () => {
    const result = runAgainstDevelopment();
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/REFUSING TO RUN/);
    expect(result.stderr).toMatch(/isolated-test/);
  });

  it("refuses when the database name is not the declared one", () => {
    const result = runReset([], { ISOLATED_DATABASE_NAME: "dextube_isolated_other" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/undeclared database/);
  });

  it("refuses when the media root is not the declared one", () => {
    const result = runReset([], { MEDIA_ROOT: "./storage/media" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/undeclared directory/);
  });

  it("refuses a media root outside storage/isolated-test", () => {
    const result = runReset([], {
      MEDIA_ROOT: "./storage/scratch/media",
      ISOLATED_MEDIA_ROOT: "./storage/scratch/media",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/storage\/isolated-test/);
  });

  it("refuses a production environment outright", () => {
    // Bootstrap is switched off so the configuration loader does not refuse
    // first; this asserts the *reset* guard's own production check.
    const result = runReset([], { DEXTUBE_ENV: "production", ADMIN_BOOTSTRAP_ENABLED: "false" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/isolated-test/);
  });

  it("refuses --apply without --yes", () => {
    const result = runReset(["--apply"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/requires --yes/);
  });

  it("produces a machine-readable dry run that is idempotent", () => {
    const before = runReset(["--json"]);
    const after = runReset(["--json"]);

    expect(before.status).toBe(0);
    const parsed = JSON.parse(before.stdout.trim().split("\n").pop()!) as {
      ok: boolean;
      mode: string;
      report: { database: string; alreadyEmpty: boolean; mediaRoot: string };
      settings: { adminBootstrapEnabled: boolean } | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.report.database).toBe("dextube_isolated_test");
    expect(parsed.report.mediaRoot).toBe(path.resolve(ROOT, "storage/isolated-test/media"));
    // The bootstrap switch is reported, but is never counted as data to remove.
    expect(parsed.settings).not.toBeNull();

    // Idempotent: a second dry run reports exactly the same state.
    expect(after.stdout.trim().split("\n").pop()).toBe(before.stdout.trim().split("\n").pop());
  });
});
