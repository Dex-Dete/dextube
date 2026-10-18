import { describe, expect, it } from "vitest";
import {
  countLabel,
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  paletteFor,
  truncate,
} from "@/lib/format";
import { estimatePasswordStrength } from "@/lib/password-strength";

describe("presentation formatters", () => {
  it("compacts large numbers", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_200)).toBe("1.2K");
    expect(formatCount(3_400_000)).toBe("3.4M");
  });

  it("pluralises count labels", () => {
    expect(countLabel(1, "view")).toBe("1 view");
    expect(countLabel(2, "view")).toBe("2 views");
  });

  it("formats durations", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("0:00");
  });

  it("formats relative time from a fixed clock", () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    expect(formatRelativeTime(new Date(now - 5_000), now)).toBe("just now");
    expect(formatRelativeTime(new Date(now - 90_000), now)).toBe("1 minute ago");
    expect(formatRelativeTime(new Date(now - 3 * 86_400_000), now)).toBe("3 days ago");
    expect(formatRelativeTime(new Date(now - 400 * 86_400_000), now)).toBe("1 year ago");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("truncates on a word boundary", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
    expect(truncate("short", 50)).toBe("short");
  });

  it("returns a deterministic palette per seed", () => {
    expect(paletteFor("abc")).toEqual(paletteFor("abc"));
  });
});

describe("client password strength meter", () => {
  it("scores an empty password as zero", () => {
    expect(estimatePasswordStrength("").score).toBe(0);
  });
  it("scores a weak password low and a strong one high", () => {
    expect(estimatePasswordStrength("password").score).toBeLessThanOrEqual(2);
    expect(estimatePasswordStrength("Correct-Horse-Battery-9!").score).toBeGreaterThanOrEqual(3);
  });
});
