/**
 * Server-side gate for every administrator surface.
 *
 * There is exactly one way in: the session's role. There is no secret route, no
 * header bypass and no "if NODE_ENV is development" escape hatch — an endpoint
 * that forgets to call {@link requireAdmin} is simply unauthenticated, not
 * quietly privileged.
 *
 * The bootstrapped account carries `mustChangePassword` until it has chosen a
 * real password, so a well-known throwaway credential cannot be used to drive
 * administrative APIs even on the throwaway instance where it was created.
 */
import "server-only";
import { notFound, redirect } from "next/navigation";
import { clientIp } from "@/lib/http";
import { requireRole, type SessionUser } from "./session";
import { isStalePasswordError, stalePasswordError } from "./admin-usable";

/** Throws 401 without a session, 403 without ADMIN, 403 while the password is stale. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireRole("ADMIN");
  if (user.mustChangePassword) {
    throw stalePasswordError();
  }
  return user;
}

/**
 * The gate for an administrator **page**, as opposed to an API route.
 *
 * A layout gate is not enough, and assuming it is was a real defect: App Router
 * renders a segment's page *in parallel with* its layout, so a page that trusts
 * the layout's check still renders — and streams its data into the response —
 * for a visitor the layout has already rejected. The refusal was visible in the
 * browser, but the data was in the body for anyone reading the response.
 *
 * Every administrator page therefore calls this itself, before it reads
 * anything. A signed-out visitor and a non-administrator get a 404 so the area's
 * existence is not disclosed; an administrator who must still change the
 * bootstrap password is sent to Settings rather than a dead end.
 */
export async function requireAdminPage(): Promise<SessionUser> {
  try {
    return await requireAdmin();
  } catch (error) {
    if (isStalePasswordError(error)) redirect("/settings?notice=admin-password");
    notFound();
  }
}

/** True when a viewer may see administrator navigation. Never throws. */
export function isAdmin(user: Pick<SessionUser, "role"> | null | undefined): boolean {
  return user?.role === "ADMIN";
}

/** IP and user agent for an audit row, using the same proxy policy as rate limiting. */
export function auditContext(request: Request): { ip: string; userAgent: string | null } {
  return { ip: clientIp(request), userAgent: request.headers.get("user-agent") };
}
