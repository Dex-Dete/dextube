import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PASSWORD_MESSAGE,
  assertAdminUsable,
  isStalePasswordError,
  stalePasswordError,
} from "@/server/auth/admin-usable";
import type { SessionUser } from "@/server/auth/session";

/**
 * The pure "usable administrator" policy.
 *
 * `requireAdmin()` enforces this over a real session (and therefore needs a
 * request context); this helper is the same rule in a form that can be tested
 * without cookies. The final case is a compile-time guarantee that the session
 * user actually carries the flag the gate reads.
 */
describe("assertAdminUsable", () => {
  const admin = { role: "ADMIN" as const, mustChangePassword: false };

  it("passes and returns an administrator whose password is current", () => {
    expect(assertAdminUsable(admin)).toBe(admin);
  });

  it("throws FORBIDDEN for a non-administrator", () => {
    expect(() => assertAdminUsable({ role: "USER", mustChangePassword: false })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(() => assertAdminUsable({ role: "MODERATOR", mustChangePassword: false })).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("throws FORBIDDEN for an administrator still carrying the bootstrap password", () => {
    let thrown: unknown;
    try {
      assertAdminUsable({ role: "ADMIN", mustChangePassword: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "FORBIDDEN", message: BOOTSTRAP_PASSWORD_MESSAGE });
  });

  it("reads `mustChangePassword` from the session user type", () => {
    // If the field were removed from `SessionUser`, this would not compile.
    const keys: Array<keyof SessionUser> = ["role", "mustChangePassword"];
    expect(keys).toContain("mustChangePassword");
  });
});

/**
 * The administrative *page* layout needs to tell "you are not an administrator"
 * (which must stay a 404, so the area is not disclosed) apart from "you are an
 * administrator who must change the bootstrap password" (which should send them
 * to Settings rather than a dead end). These are the two predicates it uses.
 */
describe("the stale-password refusal", () => {
  it("is what the gate throws", () => {
    expect(isStalePasswordError(stalePasswordError())).toBe(true);
  });

  it("is distinguishable from other refusals", () => {
    expect(isStalePasswordError(new Error(BOOTSTRAP_PASSWORD_MESSAGE))).toBe(false);
    expect(isStalePasswordError(undefined)).toBe(false);
    expect(isStalePasswordError(null)).toBe(false);
    expect(isStalePasswordError({ code: "FORBIDDEN", message: BOOTSTRAP_PASSWORD_MESSAGE })).toBe(false);
  });
});
