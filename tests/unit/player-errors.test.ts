import { describe, expect, it } from "vitest";
import { describeMediaError } from "@/components/watch/VideoPlayer";

/**
 * `describeMediaError` is the whole error-message policy of the player, so it
 * lives away from the DOM and is asserted branch by branch. The point of the
 * mapping is that the recovery differs: a broken/unsupported *source* is not
 * the same problem as a failed *network*.
 */

describe("describeMediaError", () => {
  it("explains an aborted load as a connection problem", () => {
    const message = describeMediaError(1, 2);
    expect(message).toMatch(/interrupted/i);
    expect(message).not.toMatch(/decoded/i);
  });

  it("explains a network error as a connection problem", () => {
    const message = describeMediaError(2, 2);
    expect(message).toMatch(/network/i);
  });

  it("explains a decode error as a browser/format problem", () => {
    const message = describeMediaError(3, 1);
    expect(message).toMatch(/decoded/i);
    expect(message).not.toMatch(/network/i);
  });

  it("explains a not-supported source as a source problem", () => {
    const message = describeMediaError(4, 0);
    expect(message).toMatch(/source could not be played/i);
    expect(message).not.toMatch(/network/i);
  });

  it("distinguishes source failures from network failures", () => {
    const source = describeMediaError(4, 0);
    const network = describeMediaError(2, 2);
    expect(source).not.toBe(network);
    expect(network).toMatch(/network/i);
    expect(source).toMatch(/source/i);
  });

  it("treats NETWORK_NO_SOURCE with no MediaError as a source problem", () => {
    const message = describeMediaError(null, 3);
    expect(message).toMatch(/source could not be played/i);
  });

  it("treats a bare NETWORK_LOADING stall as a network problem", () => {
    const message = describeMediaError(null, 2);
    expect(message).toMatch(/network/i);
  });

  it("falls back to a neutral message for an unknown code", () => {
    const message = describeMediaError(99, 0);
    expect(message).toMatch(/could not be played/i);
    // It must not invent a cause it cannot know.
    expect(message).not.toMatch(/network/i);
    expect(message).not.toMatch(/decoded/i);
    expect(message).not.toMatch(/source could not/i);
  });

  it("handles missing values", () => {
    expect(describeMediaError(undefined, undefined)).toMatch(/could not be played/i);
    expect(describeMediaError(null, null)).toMatch(/could not be played/i);
  });

  it("always returns a non-empty, readable sentence", () => {
    const codes = [1, 2, 3, 4, 5, 0, -1, 12345];
    const states = [0, 1, 2, 3];
    for (const code of codes) {
      for (const state of states) {
        const message = describeMediaError(code, state);
        expect(message.length).toBeGreaterThan(0);
        expect(message.trim().endsWith(".")).toBe(true);
      }
    }
  });
});
