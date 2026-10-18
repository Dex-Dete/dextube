/**
 * Guard rails for the isolated test environment's destructive helpers.
 *
 * The rule this module exists to enforce: **a reset may only run against a
 * target the operator has explicitly declared isolated, and only after the live
 * configuration has been checked against that declaration.** A stale `.env`, a
 * copied shell history or a renamed database must all fail closed, because the
 * alternative is deleting a stranger's uploads.
 *
 * Everything here is a pure function of its arguments so it can be tested
 * without a database or a filesystem.
 */
import path from "node:path";

export interface IsolatedTarget {
  /** `DEXTUBE_ENV` as parsed by the configuration layer. */
  environment: string;
  /** The live `DATABASE_URL`. */
  databaseUrl: string;
  /** The live `MEDIA_ROOT` (may be relative to `cwd`). */
  mediaRoot: string;
  /** The database name the environment file claims it points at. */
  expectedDatabaseName: string;
  /** The media root the environment file claims it points at. */
  expectedMediaRoot: string;
  /** The *development* `DATABASE_URL`, if .env is readable. */
  developmentDatabaseUrl?: string | null;
  /** The *development* `MEDIA_ROOT`, if .env is readable. */
  developmentMediaRoot?: string | null;
  cwd: string;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Database name out of a `postgresql://…/<name>?params` URL, or null. */
export function databaseNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name || null;
  } catch {
    return null;
  }
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 * Uses a path-relative check rather than a string prefix, so
 * `/data/storage-evil` is not considered inside `/data/storage`.
 */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Decides whether a destructive operation may proceed. Returns the first reason
 * it may not, so the operator gets one clear message instead of a wall of them.
 */
export function checkIsolatedTarget(target: IsolatedTarget): GuardResult {
  if (target.environment !== "isolated-test") {
    return {
      ok: false,
      reason:
        `DEXTUBE_ENV is "${target.environment}", not "isolated-test". ` +
        "This command only ever runs against the throwaway environment.",
    };
  }

  const liveDb = databaseNameFromUrl(target.databaseUrl);
  if (!liveDb) {
    return { ok: false, reason: "DATABASE_URL is missing or is not a valid PostgreSQL URL." };
  }
  if (liveDb !== target.expectedDatabaseName) {
    return {
      ok: false,
      reason:
        `DATABASE_URL points at "${liveDb}" but the isolated environment declares ` +
        `"${target.expectedDatabaseName}". Refusing to delete anything from an undeclared database.`,
    };
  }
  if (!/isolated|test/i.test(liveDb)) {
    return {
      ok: false,
      reason: `Refusing to delete from "${liveDb}": the name does not look like an isolated or test database.`,
    };
  }

  const devDb = databaseNameFromUrl(target.developmentDatabaseUrl ?? null);
  if (devDb && devDb === liveDb) {
    return {
      ok: false,
      reason:
        `The development database is also named "${devDb}". Refusing to run: a reset would ` +
        "destroy the development data.",
    };
  }

  const liveMedia = path.resolve(target.cwd, target.mediaRoot);
  const declaredMedia = path.resolve(target.cwd, target.expectedMediaRoot);
  if (liveMedia !== declaredMedia) {
    return {
      ok: false,
      reason:
        `MEDIA_ROOT is "${target.mediaRoot}" but the isolated environment declares ` +
        `"${target.expectedMediaRoot}". Refusing to delete an undeclared directory.`,
    };
  }

  const devMedia = target.developmentMediaRoot ? path.resolve(target.cwd, target.developmentMediaRoot) : null;
  if (devMedia && isInside(devMedia, liveMedia)) {
    return {
      ok: false,
      reason:
        `MEDIA_ROOT (${target.mediaRoot}) is inside the development media root ` +
        `(${target.developmentMediaRoot}). Refusing to delete development uploads.`,
    };
  }

  // The isolated tree must live under a directory that says so.
  const isolatedParent = path.resolve(target.cwd, "storage/isolated-test");
  if (!isInside(isolatedParent, liveMedia)) {
    return {
      ok: false,
      reason:
        `MEDIA_ROOT (${target.mediaRoot}) is not inside storage/isolated-test. ` +
        "Refusing to delete a directory that is not clearly disposable.",
    };
  }

  return { ok: true };
}

/** Human-readable summary of what a run would remove. */
export interface ResetReport {
  database: string;
  mediaRoot: string;
  exportRoot: string;
  records: Array<{ table: string; rows: number }>;
  totalRecords: number;
  files: { count: number; bytes: number; roots: string[] };
  /** True when there is provably nothing to remove. */
  alreadyEmpty: boolean;
}

export function describeBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
