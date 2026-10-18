/**
 * The "usable administrator" policy, in a pure form.
 *
 * `requireAdmin()` (in `./admin`) is the real gate every administrator surface
 * calls: it resolves the session, checks the role and refuses an account that
 * still carries its bootstrap password. Those first two steps need a request
 * context (cookies), which makes the whole thing awkward to unit-test.
 *
 * {@link assertAdminUsable} is the same policy — ADMIN role, and no stale
 * bootstrap password — expressed as a pure function over the session user. The
 * admin API routes call it immediately after `requireAdmin()`, so the rule that
 * a bootstrapped account cannot drive administrator APIs lives in one testable
 * place as well as in the session gate.
 */
import "server-only";
import { AppError, forbidden } from "@/lib/errors";
import type { SessionUser } from "./session";

/** The message shown to an administrator whose password must still be changed. */
export const BOOTSTRAP_PASSWORD_MESSAGE =
  "This account still has its bootstrap password. Change it in Settings before using administrator tools.";

/**
 * The refusal a stale-password administrator gets, in one place.
 *
 * Both the administrator gate (`./admin`) and the administrator layout need to
 * recognise it: the gate throws it, and the layout turns it into a redirect to
 * the page where the password can actually be changed instead of a dead-end 404.
 */
export function stalePasswordError(): AppError {
  return new AppError("FORBIDDEN", BOOTSTRAP_PASSWORD_MESSAGE);
}

/** True when an error is exactly the stale-bootstrap-password refusal. */
export function isStalePasswordError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "FORBIDDEN" &&
    error.message === BOOTSTRAP_PASSWORD_MESSAGE
  );
}

/**
 * Throws `FORBIDDEN` when the user is not an administrator, or is an
 * administrator whose bootstrap password has not been changed yet. Returns the
 * user unchanged otherwise, so it can be used inline.
 *
 * Pure and synchronous: it never touches the database or the request context.
 */
export function assertAdminUsable<T extends Pick<SessionUser, "role" | "mustChangePassword">>(user: T): T {
  if (user.role !== "ADMIN") {
    throw forbidden("You do not have permission to do that.");
  }
  if (user.mustChangePassword) {
    throw new AppError("FORBIDDEN", BOOTSTRAP_PASSWORD_MESSAGE);
  }
  return user;
}
