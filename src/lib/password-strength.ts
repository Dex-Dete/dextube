/**
 * Client-side mirror of the server password policy's strength estimate.
 *
 * The authoritative check is the zod schema in `src/lib/validation.ts` on the
 * server; this is purely a UX meter and is duplicated (rather than imported
 * from `@/server/**`) so no server-only module ends up in the browser bundle.
 */
export function estimatePasswordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!password) return { score: 0, label: "Empty" };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const entropy = password.length * Math.log2(Math.max(pool, 2));
  if (entropy < 40) return { score: 1, label: "Weak" };
  if (entropy < 60) return { score: 2, label: "Fair" };
  if (entropy < 80) return { score: 3, label: "Strong" };
  return { score: 4, label: "Very strong" };
}
