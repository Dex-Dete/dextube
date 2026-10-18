import { describe, expect, it } from "vitest";
import { generateSessionToken, hashToken, safeEqual } from "@/server/auth/session";

describe("session tokens", () => {
  it("generates a high-entropy, URL-safe token", () => {
    const token = generateSessionToken();
    // 32 random bytes -> 43 base64url characters.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats a token", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(seen.size).toBe(200);
  });

  it("hashes deterministically to a SHA-256 hex digest", () => {
    const token = generateSessionToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    // Only the hash is stored, so a different token must produce a different digest.
    expect(hashToken(generateSessionToken())).not.toBe(hash);
  });

  it("compares equal-length digests in constant time", () => {
    const a = hashToken("alpha");
    expect(safeEqual(a, hashToken("alpha"))).toBe(true);
    expect(safeEqual(a, hashToken("beta"))).toBe(false);
  });

  it("treats a length mismatch as not equal rather than throwing", () => {
    expect(safeEqual("abcd", "abcdef")).toBe(false);
  });
});
