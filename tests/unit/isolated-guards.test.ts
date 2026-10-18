/**
 * Unit tests for the isolated-environment guard rails.
 *
 * These are the checks that stand between a mistyped command and somebody's
 * uploads, so each refusal is asserted by its *reason*, not merely by a falsy
 * result: a guard that fails for the wrong reason is as dangerous as one that
 * passes.
 */
import { describe, expect, it } from "vitest";
import {
  checkIsolatedTarget,
  databaseNameFromUrl,
  describeBytes,
  isInside,
  type IsolatedTarget,
} from "@/lib/isolated-guards";

const CWD = "/srv/dextube";

function target(overrides: Partial<IsolatedTarget> = {}): IsolatedTarget {
  return {
    environment: "isolated-test",
    databaseUrl: "postgresql://dextube:secret@localhost:5433/dextube_isolated_test",
    mediaRoot: "./storage/isolated-test/media",
    expectedDatabaseName: "dextube_isolated_test",
    expectedMediaRoot: "./storage/isolated-test/media",
    developmentDatabaseUrl: "postgresql://dextube:secret@localhost:5433/dextube",
    developmentMediaRoot: "./storage/media",
    cwd: CWD,
    ...overrides,
  };
}

describe("databaseNameFromUrl", () => {
  it("reads the database name and ignores query parameters", () => {
    expect(databaseNameFromUrl("postgresql://u:p@host:5432/dextube_test?schema=public")).toBe("dextube_test");
  });

  it("returns null for a missing or malformed URL", () => {
    expect(databaseNameFromUrl(null)).toBeNull();
    expect(databaseNameFromUrl("")).toBeNull();
    expect(databaseNameFromUrl("not a url")).toBeNull();
    expect(databaseNameFromUrl("postgresql://u:p@host:5432/")).toBeNull();
  });
});

describe("isInside", () => {
  it("accepts the directory itself and real descendants", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("rejects siblings that merely share a prefix", () => {
    expect(isInside("/a/b", "/a/b-evil")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("checkIsolatedTarget", () => {
  it("allows a fully declared isolated target", () => {
    expect(checkIsolatedTarget(target())).toEqual({ ok: true });
  });

  it("refuses when the environment is not isolated-test", () => {
    const result = checkIsolatedTarget(target({ environment: "development" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isolated-test/);
  });

  it("refuses when DATABASE_URL points at an undeclared database", () => {
    const result = checkIsolatedTarget(
      target({ databaseUrl: "postgresql://dextube:secret@localhost:5433/dextube" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/undeclared database/);
  });

  it("refuses a database whose name does not look like a test database", () => {
    const result = checkIsolatedTarget(
      target({
        databaseUrl: "postgresql://dextube:secret@localhost:5433/production",
        expectedDatabaseName: "production",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not look like an isolated or test database/);
  });

  it("refuses when the development database has the same name", () => {
    const result = checkIsolatedTarget(
      target({
        developmentDatabaseUrl: "postgresql://dextube:secret@localhost:5433/dextube_isolated_test",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/development data/);
  });

  it("refuses a media root that differs from the declared one", () => {
    const result = checkIsolatedTarget(target({ mediaRoot: "./storage/media" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/undeclared directory/);
  });

  it("refuses a media root inside the development media root", () => {
    const result = checkIsolatedTarget(
      target({
        mediaRoot: "./storage/media/isolated-test",
        expectedMediaRoot: "./storage/media/isolated-test",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/development media root/);
  });

  it("refuses a media root outside storage/isolated-test", () => {
    const result = checkIsolatedTarget(
      target({ mediaRoot: "./storage/scratch/media", expectedMediaRoot: "./storage/scratch/media" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/storage\/isolated-test/);
  });

  it("accepts a nested path under storage/isolated-test", () => {
    const result = checkIsolatedTarget(
      target({
        mediaRoot: "./storage/isolated-test/media-v2",
        expectedMediaRoot: "./storage/isolated-test/media-v2",
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("describeBytes", () => {
  it("formats bytes without pretending to more precision than it has", () => {
    expect(describeBytes(0)).toBe("0 B");
    expect(describeBytes(512)).toBe("512 B");
    expect(describeBytes(1536)).toBe("1.5 KiB");
    expect(describeBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
