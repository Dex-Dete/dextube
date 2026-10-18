import { describe, expect, it } from "vitest";
import { computeBufferedRanges, formatClock, type TimeRangesLike } from "@/components/watch/VideoPlayer";

/**
 * The two pure pieces the player leans on: turning the media element's
 * `TimeRanges` into positioned bars, and formatting a clock. Both are defensive
 * because they read values a browser owns and can report as `NaN` or empty.
 */

/** Minimal `TimeRanges` double — the same shape the browser exposes. */
function rangesFrom(pairs: [number, number][]): TimeRangesLike {
  return {
    length: pairs.length,
    start: (index: number) => pairs[index]![0],
    end: (index: number) => pairs[index]![1],
  };
}

describe("computeBufferedRanges", () => {
  it("returns nothing when there is no buffered data", () => {
    expect(computeBufferedRanges(null, 100)).toEqual([]);
    expect(computeBufferedRanges(undefined, 100)).toEqual([]);
    expect(computeBufferedRanges(rangesFrom([]), 100)).toEqual([]);
  });

  it("returns nothing when the duration is unknown", () => {
    expect(computeBufferedRanges(rangesFrom([[0, 10]]), 0)).toEqual([]);
    expect(computeBufferedRanges(rangesFrom([[0, 10]]), Number.NaN)).toEqual([]);
    expect(computeBufferedRanges(rangesFrom([[0, 10]]), Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("maps a single buffered range", () => {
    expect(computeBufferedRanges(rangesFrom([[0, 25]]), 100)).toEqual([{ start: 0, end: 25 }]);
  });

  it("preserves multiple disjoint ranges", () => {
    expect(computeBufferedRanges(rangesFrom([[0, 10], [30, 40]]), 100)).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 40 },
    ]);
  });

  it("clamps ranges to the media duration", () => {
    expect(computeBufferedRanges(rangesFrom([[0, 250]]), 100)).toEqual([{ start: 0, end: 100 }]);
  });

  it("drops empty, backwards and non-finite ranges", () => {
    const buffered: TimeRangesLike = {
      length: 3,
      start: (index: number) => [5, 8, Number.NaN][index]!,
      end: (index: number) => [5, 6, 20][index]!,
    };
    expect(computeBufferedRanges(buffered, 100)).toEqual([]);
  });

  it("does not mutate the source ranges", () => {
    const pairs: [number, number][] = [[0, 250]];
    computeBufferedRanges(rangesFrom(pairs), 100);
    expect(pairs).toEqual([[0, 250]]);
  });
});

describe("formatClock", () => {
  it("pads seconds and minutes", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(59.9)).toBe("0:59");
  });

  it("adds hours when needed", () => {
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(3600)).toBe("1:00:00");
  });

  it("never prints a negative or non-finite clock", () => {
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
