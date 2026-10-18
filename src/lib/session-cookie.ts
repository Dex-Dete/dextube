/**
 * Session-cookie policy.
 *
 * The `__Host-` prefix and the `Secure` flag are only correct when the app is
 * actually served over **HTTPS**. Browsers silently refuse to store a `Secure`
 * cookie that arrives over plain HTTP (localhost is the one exception), and
 * `__Host-` *requires* `Secure`. So a production build served over
 * `http://192.168.1.10:3000` on a LAN would appear to log in successfully while
 * dropping the cookie on the next request.
 *
 * The policy is therefore derived from `APP_URL` rather than from `NODE_ENV`:
 * an `https://` origin gets `__Host-dextube_session` + `Secure`; a plain-HTTP
 * origin gets the unprefixed name without `Secure`, so local-network use works.
 * `SESSION_COOKIE_SECURE` can force the flag either way (for example when a
 * reverse proxy terminates TLS but `APP_URL` is misconfigured).
 *
 * This module is deliberately pure and client-safe so it can be unit-tested.
 */

export type SecureOverride = "auto" | "true" | "false";

export interface SessionCookiePolicy {
  /** Cookie name, including the `__Host-` prefix when it is usable. */
  name: string;
  secure: boolean;
  /** True when an explicit override was supplied instead of `auto`. */
  overridden: boolean;
}

export const SESSION_COOKIE_BASE = "dextube_session";

export function sessionCookiePolicy(
  appUrl: string,
  override: SecureOverride = "auto",
): SessionCookiePolicy {
  const isHttps = appUrl.trim().toLowerCase().startsWith("https://");
  const secure = override === "auto" ? isHttps : override === "true";
  return {
    name: secure ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE,
    secure,
    overridden: override !== "auto",
  };
}
