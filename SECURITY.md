# Security Policy

DEXTube is software that a self-hoster runs themselves. This document explains
how to report a vulnerability privately and describes the security controls the
project actually implements today — as well as what it explicitly does **not**
protect against.

> The addresses below (`security@dextube.invalid`, `conduct@dextube.invalid`) are
> deliberately non-routable placeholders. An operator running a real deployment
> should replace them with monitored mailboxes — the full checklist of
> placeholders to update is in the README section
> [“Publishing your own instance or fork”](./README.md#publishing-your-own-instance-or-fork).

---

## Supported versions

DEXTube is pre-1.0. Security fixes are provided for the latest `0.1.x` release
only.

| Version | Supported |
| --- | --- |
| 0.1.x | :white_check_mark: Yes |
| < 0.1 (unreleased / development snapshots) | :x: No |
| 1.0.x and later | Not yet released |

Because DEXTube is AGPL-3.0-or-later software and is intended to be self-hosted,
we encourage operators to track the latest release and to rebuild when a fix is
published. Running an unmaintained fork is your own responsibility.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.** Report them
privately:

* **Email:** `security@dextube.invalid`

If you prefer encrypted email, say so in your first message and we will arrange a
key exchange. Do not attach or paste live secrets, tokens, or personal data.

### What to include

A useful report contains:

* a clear description of the vulnerability and its impact;
* the affected version or commit;
* step-by-step reproduction instructions (and, if possible, a minimal proof of
  concept);
* any preconditions (authenticated? specific configuration? `JOB_RUNNER`,
  `STORAGE_DRIVER`, `ENABLE_HLS`?);
* relevant logs or requests with secrets redacted;
* your assessment of severity and any suggested fix.

### What to expect

* **Acknowledgment within 3 business days** of your report.
* **An initial assessment (triage): within 7 calendar days**, including whether we
  can reproduce it and a rough severity.
* **Progress updates** at least every 14 days while the report is open.
* **Coordinated disclosure:** we aim to ship a fix and publish an advisory within
  **90 days** of triage. We will credit you in the advisory unless you ask us not
  to. If a fix will take longer, we will tell you why and agree a new timeline.

We will not pursue legal action against researchers who follow this policy, act in
good faith, avoid privacy violations and service disruption, and give us a
reasonable chance to fix the issue first.

### Out of scope

* Vulnerabilities in third-party dependencies that are already publicly known and
  fixed upstream (report those upstream; tell us if we are pinned to an affected
  version).
* Findings that require a victim to install and run attacker-supplied software.
* Denial-of-service via sheer traffic volume on a deployment you do not own or
  control.
* Missing hardening that is already listed under "Non-goals" below.
* Anything that requires physical access to the server.

---

## Security model

The controls below are the ones DEXTube actually implements. Where a control is
partial or configuration-dependent, that is stated.

### Authentication and sessions

* **Password hashing — Argon2id.** Passwords are hashed with Argon2id via
  `@node-rs/argon2` and are validated against a password policy before hashing.
  Password hashes are stored as modular-crypt strings (parameters are recorded
  in the hash), which allows rehashing when parameters change.
* **Opaque session tokens.** Sessions are **not** JWTs. A random opaque token is
  issued and delivered in an `httpOnly` cookie named `dextube_session` (in
  production, `__Host-dextube_session`). Only a **SHA-256 hash** of the token is
  stored in the database, so a database leak does not expose usable session
  tokens. The cookie is `SameSite=Lax` and `Secure` in production.
* **Global invalidation.** `User.sessionEpoch` allows every session for a user to
  be invalidated at once (for example after a password change or on sign-out of
  all devices).

### Request integrity (CSRF)

* **Same-origin enforcement.** Cookie-authenticated, state-changing requests are
  checked with `assertSameOrigin`: the request's `Origin` (falling back to
  `Referer`) must match the application origin or host. Requests with no
  `Origin`/`Referer` at all are rejected for these mutations. This complements —
  and is belt-and-braces alongside — the `SameSite=Lax` cookie.

### Authorisation

* **Per-request media authorisation.** Media is never served on the basis of a
  client-supplied path alone. Every media request is authorised against the
  video's visibility. For unauthorised users, **private/nonexistent media
  returns `404`, not `403`**, so that the existence of private videos is not
  disclosed.
* **Ownership checks live in the service layer** (`src/server/services/**`), not
  in route handlers, so a new route cannot accidentally bypass a privacy rule.

### Input handling and media safety

* **Validation with zod.** All mutations validate input with zod; no client
  input is trusted.
* **Upload size and type validation.** Uploads are capped by
  `MAX_UPLOAD_BYTES` and `MAX_VIDEO_DURATION_SECONDS`, and the declared MIME type
  is checked against the file extension and an allow-list of accepted
  video/audio formats before processing.
* **argv-only FFmpeg invocation.** FFmpeg and FFprobe are always spawned with an
  explicit **argument array and no shell** (`spawn` without `shell: true`).
  Client-supplied filenames and metadata are passed as discrete argv entries or
  as `-i`/output paths, so a crafted filename can never be interpreted as shell
  syntax or as an injected FFmpeg flag. Storage keys are server-generated;
  client paths are never joined into filesystem paths.

### Transport, headers, and browser hardening

* **Content-Security-Policy.** A conservative, same-origin CSP is applied
  globally in `next.config.ts` (`default-src 'self'`, `object-src 'none'`,
  `base-uri 'self'`, `frame-ancestors 'self'`, and so on). `'unsafe-eval'` is
  added only for the development build.
* **Security headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`,
  and a restrictive `Permissions-Policy` are set on every response. Next.js's
  `x-powered-by` header is disabled.
* **TLS is the operator's responsibility.** DEXTube binds `127.0.0.1` by default
  and is designed to run behind a TLS-terminating reverse proxy. Run it over TLS
  in any deployment that touches the public internet.

### Abuse resistance

* **Rate limiting.** Login and other sensitive routes are rate limited, backed by
  a `rate_limit_buckets` table (no Redis required). Limits are configurable
  (`LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`).
* **View de-duplication.** Anonymous view counting uses a salted, rotating hash of
  (IP + user agent + day) so raw IP addresses are not stored, while repeat views
  are collapsed within a configurable window.

### Secrets and outbound network

* **No secrets in logs.** Production logging is structured and does not emit
  secrets, session tokens, or credentials.
* **Minimal outbound network.** DEXTube does not fetch user-supplied remote URLs
  and does not import media from arbitrary internet locations, so the classic
  server-side request forgery (SSRF) surface of "fetch this URL for me" is
  absent. The only outbound connection is SMTP when mail is configured; when it
  is not, mail is written locally to `storage/mail-outbox/`.

---

## Non-goals and known limitations

Be aware of these when evaluating whether DEXTube meets your threat model:

* **No DRM.** DEXTube does not implement any digital rights management or
  content-encryption scheme. Anyone who can fetch a streamed file can retain it.
* **No end-to-end encryption of stored media.** Media at rest is stored as
  ordinary files on the host filesystem (or, in future, in object storage). It is
  not encrypted by DEXTube; use full-disk or volume encryption provided by your
  platform.
* **The S3 storage driver is not implemented.** `STORAGE_DRIVER=s3` is
  intentionally not implemented and throws a clear error instead of pretending to
  work. Only the local filesystem adapter (`STORAGE_DRIVER=local`) is available
  today.
* **No multi-factor authentication (MFA/2FA) yet.** Accounts are protected by a
  password (Argon2id) and an opaque session only.
* **Email verification and password reset rely on email.** When SMTP is not
  configured, links are written to `storage/mail-outbox/`; treat that directory
  as sensitive on a shared machine.
* **HLS is optional and off by default.** Progressive MP4 with HTTP range
  requests is the default delivery path (`ENABLE_HLS=false`).
* **No formal third-party security audit has been performed.** The controls above
  describe the implementation, not an audited guarantee.

If you are deploying DEXTube for other people, review
[`docs/fedora.md`](./docs/fedora.md) (reverse proxy/TLS, SELinux, firewalld,
backups) and keep the database, media directory, and `.env` off any public path.
