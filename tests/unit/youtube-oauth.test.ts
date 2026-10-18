import { describe, expect, it } from "vitest";
import { createOAuthState, stateMatches } from "@/server/services/youtube-oauth";

describe("YouTube OAuth safety primitives", () => {
  it("creates high-entropy state and PKCE values", () => {
    const one = createOAuthState();
    const two = createOAuthState();
    expect(one.state.length).toBeGreaterThan(30);
    expect(one.verifier.length).toBeGreaterThan(30);
    expect(one.challenge.length).toBeGreaterThan(30);
    expect(one.state).not.toBe(two.state);
    expect(stateMatches(one.state, one.state)).toBe(true);
    expect(stateMatches(one.state, two.state)).toBe(false);
  });

  it("rejects a state with a different length or value", () => {
    const state = createOAuthState().state;
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, "")).toBe(false);
  });
});
