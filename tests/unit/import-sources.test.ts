/**
 * Unit tests for the pure parts of the import service.
 *
 * `dedupeKeyFor` is the cross-source identity of an entry and must be stable and
 * unambiguous; a mistake there silently duplicates or silently skips imports.
 * `describeImportFailure` is shown to an operator, so it must be short and must
 * never leak a stack trace or an internal object.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { dedupeKeyFor, describeImportFailure } from "@/server/services/import-sources";

describe("dedupeKeyFor", () => {
  it("namespaces the provider id by connector kind", () => {
    expect(dedupeKeyFor("YOUTUBE_CHANNEL", "dQw4w9WgXcQ")).toBe("YOUTUBE_CHANNEL:dQw4w9WgXcQ");
    expect(dedupeKeyFor("CREATOR_EXPORT", "clip-1")).toBe("CREATOR_EXPORT:clip-1");
  });

  it("does not collide across connectors for the same provider id", () => {
    expect(dedupeKeyFor("YOUTUBE_CHANNEL", "x")).not.toBe(dedupeKeyFor("CREATOR_EXPORT", "x"));
  });
});

describe("describeImportFailure", () => {
  it("returns an AppError's own operator-facing message", () => {
    expect(describeImportFailure(new AppError("FORBIDDEN", "Not allowed."))).toBe("Not allowed.");
  });

  it("wraps a plain Error without a stack trace", () => {
    const described = describeImportFailure(new Error("ffmpeg exploded"));
    expect(described).toBe("Import failed: ffmpeg exploded");
    expect(described).not.toContain("at ");
    expect(described).not.toContain("Error:");
  });

  it("accepts a bare string", () => {
    expect(describeImportFailure("disk full")).toBe("Import failed: disk full");
  });

  it("falls back to a neutral sentence for null and unknown values", () => {
    expect(describeImportFailure(null)).toBe("Import failed for an unknown reason.");
    expect(describeImportFailure(undefined)).toBe("Import failed for an unknown reason.");
    expect(describeImportFailure({ weird: true })).toBe("Import failed for an unknown reason.");
    expect(describeImportFailure(new Error("   "))).toBe("Import failed for an unknown reason.");
  });

  it("truncates a very long message rather than dumping it", () => {
    const huge = describeImportFailure(new Error("x".repeat(5000)));
    expect(huge.length).toBeLessThanOrEqual(500);
  });
});
