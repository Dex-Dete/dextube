/**
 * Password hashing — Argon2id.
 *
 * Parameters follow the OWASP recommendation (19 MiB memory, 2 iterations,
 * 1 lane) which is a good balance for a self-hosted box. Hashes are verified
 * with the library's constant-time comparison, and `needsRehash` lets us
 * transparently upgrade existing hashes when parameters change.
 */
import "server-only";
import { hash, verify } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id` from the library. The enum is declared `const` and is
 * therefore not usable in a value position under `isolatedModules`, so the
 * numeric value is inlined here (2 = Argon2id, per the Argon2 spec).
 */
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19 * 1024, // KiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Length ceiling for a password we are willing to hash (DoS guard). */
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password exceeds the maximum supported length.");
  }
  return hash(plain, OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` for malformed hashes instead of throwing, so an interrupted
 * password migration cannot turn into a 500 that leaks account state.
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  if (!storedHash || plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(storedHash, plain, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * True when the stored hash was produced with weaker parameters and should be
 * re-hashed on the next successful sign-in.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, , memory, time, parallelism] = match;
  return (
    Number(memory) < OPTIONS.memoryCost ||
    Number(time) < OPTIONS.timeCost ||
    Number(parallelism) !== OPTIONS.parallelism
  );
}
