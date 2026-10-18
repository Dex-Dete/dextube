import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/server/auth/password";

describe("password hashing (Argon2id)", () => {
  it("produces an Argon2id hash that verifies against the same password", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "CorrectHorse1")).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(await verifyPassword(hash, "correcthorse1")).toBe(false);
    expect(await verifyPassword(hash, "")).toBe(false);
  });

  it("salts each hash so equal passwords hash differently", async () => {
    const a = await hashPassword("CorrectHorse1");
    const b = await hashPassword("CorrectHorse1");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "CorrectHorse1")).toBe(true);
    expect(await verifyPassword(b, "CorrectHorse1")).toBe(true);
  });

  it("returns false for a malformed stored hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-real-hash", "CorrectHorse1")).toBe(false);
  });

  it("refuses to hash a password beyond the DoS ceiling", async () => {
    await expect(hashPassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow();
  });

  it("does not flag a current-parameter hash for rehash", async () => {
    const hash = await hashPassword("CorrectHorse1");
    expect(needsRehash(hash)).toBe(false);
  });

  it("flags weaker or unparseable hashes for rehash", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash("plaintext")).toBe(true);
  });
});
