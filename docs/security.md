# DEXTube Security

This document describes the **threat model** DEXTube is built against and the
**controls that are actually implemented** — as well as the gaps an operator
must account for. It expands on the project security policy in
[`SECURITY.md`](../SECURITY.md), which is the canonical place to report a
vulnerability.

> **How to report a vulnerability:** do **not** open a public issue. Follow
> [`SECURITY.md`](../SECURITY.md) and report it privately (see
> [§9](#9-reporting-a-vulnerability)).

DEXTube is self-hosted software. The **operator** owns the deployment: TLS,
network exposure, database and media-dir access, secret storage, and backups are
the operator's responsibility. DEXTube's job is to not undermine those with its
own application-level mistakes.

---

## 1. Threat model (summary)

| Adversary | Goal | Where DEXTube defends |
| --- | --- | --- |
| Unauthenticated visitor | Reach private/unlisted media or other users' data | Per-request media authorisation; visibility rules in the service layer; `404` for unauthorised access. |
| Authenticated user | Act as another user, or tamper with another user's content | Ownership checks in services; session integrity; CSRF same-origin check. |
| Credential attacker | Guess passwords or brute-force login | Argon2id; per-account/per-IP login rate limiting; constant-time verification. |
| Spammer / abuser | Flood comments, uploads, views, or search | Database-backed rate-limit buckets; anonymous view dedupe; upload concurrency limits. |
| Malicious uploader | Get the server to execute or misinterpret a file | MIME/extension allow-list; size/duration caps; argv-only FFmpeg; `nosniff`; server-generated storage keys. |
| Session thief (DB leak) | Use stolen session rows | Only SHA-256 hashes of tokens are stored; epoch invalidation. |
| Network attacker | Cross-site request forgery / MIME sniffing / framing / injection | `SameSite=Lax` cookies + explicit origin check; CSP and security headers; output encoding via React. |
| Curious operator/app | Over-collect personal data | No raw IP storage; truncated session IPs; hashed anonymous viewer identity. |

Out of scope for the application controls: physical access, host compromise,
malicious operators (AGPL software can be modified — you must trust who runs your
instance), and volumetric DDoS.

---

## 2. Authentication and sessions

- **Argon2id password hashing** via `@node-rs/argon2` (`src/server/auth/password.ts`),
  using OWASP-recommended parameters (19 MiB memory, 2 iterations, 1 lane,
  32-byte output). Passwords must satisfy a policy (>= 10 chars, with letters and
  a digit; non-ASCII characters count for case requirements). Hashes are verified
  with the library's constant-time comparison, and `needsRehash()` upgrades weaker
  hashes transparently on the next sign-in. A length ceiling guards against
  hashing-DoS.
- **Hashed opaque session tokens** (`src/server/auth/session.ts`). A 32-byte
  random token lives only in an `httpOnly` cookie; the database stores just its
  **SHA-256 hash**. A database leak therefore does not yield usable sessions.
- **Cookie flags:** `httpOnly`, `SameSite=Lax`, and — when `APP_URL` is
  `https://` — `Secure` plus the `__Host-` prefix
  (`__Host-dextube_session`, which additionally requires
  `Path=/` and no `Domain`).
- **Epoch invalidation.** Each session records the `User.sessionEpoch` it was
  created with; bumping the epoch (password change, "sign out everywhere")
  invalidates **every** session for that user at once. `revokeAllSessions()` also
  marks the rows revoked so the device list is accurate.
- **Suspended and soft-deleted accounts** resolve to no session.
- **Verification and reset tokens** are single-use and expiring (24 h / 1 h) and
  stored only as hashes.

---

## 3. Request integrity (CSRF)

Cookie-authenticated state changes are guarded by `assertSameOrigin()`
(`src/lib/http.ts`):

- The request's `Origin` (falling back to `Referer`) must match `APP_URL`'s origin
  or the request's own host.
- Requests with **no** `Origin`/`Referer` are rejected for these mutations. This
  is deliberate: programmatic clients should use a bearer/header-based flow rather
  than relying on the cookie.
- This complements the `SameSite=Lax` cookie as belt-and-braces.

---

## 4. Authorisation

- **Per-request media authorisation.** Media is never served from a
  client-supplied path. `src/app/api/media/[...path]/route.ts` resolves the
  storage key, then authorises it:
  - `images/`, `channels/`, `users/` — public branding assets.
  - `videos/<id>/…` — follows the video's visibility. `PUBLIC` and `UNLISTED`
    are readable by anyone with the key; `PRIVATE` is limited to the owning
    channel (and to moderators/admins reviewing reported media); soft-deleted
    videos are never served.
  - `uploads/<id>/…` — staging files, owner only.
  - Unknown prefixes are never served.
- **No existence leaks.** Unauthorised or unknown media returns **`404`, not
  `403`**, so private media cannot be enumerated by probing status codes.
- **Rules live in the service layer** (`src/server/services/**`), not in route
  handlers, so a new endpoint cannot accidentally bypass a privacy rule. Feeds
  and search only ever query `PUBLIC` + `READY` (and non-deleted) rows.
- **Role checks** (`requireRole`) gate moderation and admin actions.

---

## 5. Input handling and media safety

- **zod validation everywhere.** Every mutation validates its body and query
  parameters in `src/lib/validation.ts` before touching the database; invalid
  input becomes a `422` with field-level details. Services can assume well-formed
  input.
- **Safe primitives.** Usernames/handles are regex-constrained; emails are
  normalised (trim + lowercase) for uniqueness; URLs are restricted to `http(s)`
  (blocking `javascript:`/`data:` schemes); tags reject control/angle characters.
- **Upload validation.** Uploads are capped by `MAX_UPLOAD_BYTES` and
  `MAX_VIDEO_DURATION_SECONDS`. The declared MIME type is checked against an
  allow-list of containers and the file extension (`src/server/media/validate.ts`);
  anything not browser-native is transcoded. In-flight upload concurrency is
  bounded per user.
- **Server-generated storage keys.** `normalizeKey()` rejects traversal,
  absolute paths, backslashes, empty segments, and over-long keys; a
  client-supplied path is never joined into a filesystem path.
- **argv-only FFmpeg/FFprobe.** Binaries are spawned with an **argument array and
  no shell** (`src/server/media/exec.ts`), with hard timeouts and bounded output
  buffers. Filenames and metadata can never be interpreted as shell syntax or as
  injected FFmpeg flags.
- **`nosniff` on responses.** Media is served with the correct MIME type and
  `X-Content-Type-Options: nosniff`, so an uploaded file is never interpreted as
  HTML/JS.

---

## 6. Abuse resistance

- **Database-backed rate limiting** (`src/server/auth/rate-limit.ts`,
  `rate_limit_buckets`). A fixed-window counter in PostgreSQL — no Redis needed —
  so throttling survives restarts and is correct across multiple app instances.
  Buckets are keyed by a stable identity (IP or user id). Presets:

  | Scope | Limit |
  | --- | --- |
  | `login` | `LOGIN_MAX_ATTEMPTS` per `LOGIN_WINDOW_MINUTES` (default 10 / 15 min) |
  | `register` | 5 per hour |
  | `pwreset` | 5 per hour |
  | `comment` | 20 per 5 minutes |
  | `upload` | 20 per hour |
  | `mutate` | 120 per minute |
  | `read` | 600 per minute |
  | `view` | 240 per minute |
  | `search` | 120 per minute |

  Exceeding a limit returns `429` with a `Retry-After` header. A successful login
  clears the login bucket so earlier failures do not accumulate. Limits are
  disabled only when `RATE_LIMIT_DISABLED=true` (for tests).
- **Anonymous view dedupe.** Views are deduplicated inside
  `VIEW_DEDUPE_SECONDS` using a salted hash of `(ip + user agent + day)`;
  a video's owner does not count as a viewer. This lets repeat views collapse
  without storing raw IPs.
- **Upload concurrency guard** limits simultaneous in-progress uploads per user.

---

## 7. Privacy and data minimisation

- **No raw IP storage.** Anonymous view records store only a salted, rotating
  `viewerHash` (derived from the session secret, the UTC day, and the IP + user
  agent), truncated to 40 hex characters. Session `ip` values are truncated to a
  `/24` (IPv4) or `/48` (IPv6) prefix so a device list can show approximate
  location without storing a full address.
- **Client IP is trusted only behind a proxy.** `clientIp()` reads
  `X-Forwarded-For` only when `DEXTUBE_TRUST_PROXY=1`; otherwise it uses
  `X-Real-IP` or falls back to `127.0.0.1`. Do not enable it on a directly
  reachable server.
- **Privacy settings.** Users can disable watch-history recording
  (`saveWatchHistory`) and hide their likes (`showLikesPublicly`); the
  recommender and history features respect these.
- **Minimal outbound network.** DEXTube does not fetch user-supplied remote URLs
  and does not import media from arbitrary internet locations, removing the
  classic "fetch this URL for me" SSRF surface. The only outbound connection is
  SMTP when configured (or a local file outbox when it is not).

---

## 8. Transport, headers, and browser hardening

Applied globally in `next.config.ts` to every response; `x-powered-by` is
disabled (`poweredByHeader: false`).

**Security headers:**

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

**Content-Security-Policy:**

```
default-src 'self';
script-src 'self' 'unsafe-inline';            # plus 'unsafe-eval' in development only
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' blob:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

Notes:

- Next.js requires inline bootstrap scripts, hence `'unsafe-inline'` in
  `script-src`; `'unsafe-eval'` is added **only** for development builds.
- `frame-ancestors 'self'` plus `X-Frame-Options: SAMEORIGIN` prevent clickjacking
  of watch pages.
- **TLS is the operator's responsibility.** DEXTube binds `127.0.0.1` by default
  and is designed to run behind a TLS-terminating reverse proxy. Serve over HTTPS
  in any internet-facing deployment (see [`deployment.md`](./deployment.md)).

---

## 9. Reporting a vulnerability

Follow [`SECURITY.md`](../SECURITY.md). In short: report privately to the
security contact listed there (the checked-in address is a deliberately
non-routable placeholder — a real deployment should replace it), include
reproduction steps and impact, and allow coordinated disclosure. Do not paste live
secrets, tokens, or personal data. Security fixes are provided for the latest
`0.1.x` release.

---

## 10. Known gaps and non-goals

Stated plainly so you can judge whether DEXTube meets your threat model:

- **No multi-factor authentication (2FA/MFA).** Accounts are protected by a
  password (Argon2id) and an opaque session only.
- **No email delivery without SMTP.** When `SMTP_HOST` is unset, verification and
  password-reset messages are written to `storage/mail-outbox/*.eml` — treat that
  directory as sensitive on a shared host.
- **No WAF / no DDoS protection.** Rate limiting is application-level; there is
  no web application firewall, bot mitigation, or volumetric attack protection.
  Front DEXTube with your own edge controls if you need them.
- **The S3 storage adapter is not implemented.** `STORAGE_DRIVER=s3` fails fast.
  Media at rest is plain files on the host; DEXTube does not encrypt it — use
  full-disk or volume encryption.
- **No DRM.** Anyone who can fetch a streamed file can retain it.
- **No formal third-party security audit has been performed.** The controls above
  describe the implementation, not an audited guarantee.

See also the security review checklist in
[`deployment.md`](./deployment.md), and the schema-level index notes in
[`database.md`](./database.md#42-search-indexes-declared-in-the-schema-and-created-by-migrations).
