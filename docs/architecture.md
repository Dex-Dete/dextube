# DEXTube Architecture

DEXTube is a **modular monolith** with an optional, separate background worker.
One deployable web application serves pages and JSON APIs; long-running media
work is isolated in the `jobs` table so it can run inline in the web process or
in a dedicated worker process. There is no second backend service to operate.

---

## 1. Layers

| Location | Purpose | Rules |
| --- | --- | --- |
| `src/app/**` | Pages (React Server Components) and route handlers (`route.ts`) | Route handlers stay thin: **parse → validate (zod) → authorize → call a service → shape the response**. No business logic. |
| `src/components/**` | Reusable UI: shell, feed, video cards, watch components, forms, and the original icon set | Client/interactive where needed. |
| `src/lib/**` | Client-safe shared utilities: config, HTTP helpers, errors, logging, validation schemas, formatters, DTOs, the API client | **Must stay importable from both client and server.** No Prisma, no `fs`, no Node builtins that break bundling. |
| `src/server/**` | Server-only domain layer | Imports `"server-only"`. Owns Prisma access, ownership/privacy rules, media, storage, jobs, and recommendations. |
| `prisma/**` | Schema and versioned migrations | Source of truth for the database. |
| `src/worker/index.ts` | Background worker entry point (`npm run worker`) | Loads `.env`, then runs the job loop until `SIGINT`/`SIGTERM`. |

### Server-side module map (`src/server/**`)

| Path | Responsibility |
| --- | --- |
| `auth/password.ts` | Argon2id hashing and verification, password policy helpers. |
| `auth/session.ts` | Session creation/verification/revocation, cookies, `sessionEpoch`. |
| `auth/rate-limit.ts` | Persistent fixed-window rate limiting + limit presets. |
| `services/**` | Accounts, channels, videos, uploads, media-process, comments, notifications, playlists, analytics, search, navigation. Every ownership/privacy rule lives here. |
| `storage/index.ts` | `MediaStorage` interface + local filesystem driver (S3 reserved). |
| `media/exec.ts` | Child-process runner (argv-only, no shell, timeouts, bounded output). |
| `media/ffmpeg.ts` | High-level FFprobe/probe, thumbnail, poster, remux, transcode, HLS wrappers. |
| `media/encoders.ts` | Runtime H.264 encoder negotiation. |
| `media/validate.ts` | Accepted upload formats and MIME/extension validation. |
| `jobs/queue.ts` | DB-backed queue: enqueue, atomic claim, complete, fail, recover, stats, prune. |
| `jobs/handlers.ts` | Job handler registry (one auditable map). |
| `jobs/runner.ts` | Inline and external drain loops, retry scheduling, stale-lock recovery. |
| `recsys/index.ts` | Transparent weighted-heuristic ranking. |

### Data flow

```
                ┌───────────────────────────────────────────────┐
   Browser ───► │ Next.js 16 (App Router, RSC) + React 19        │
                │   src/app/**, src/components/**, src/lib/**    │
                └───────────────┬───────────────────────────────┘
                                │  (also: worker process)
                                ▼
                ┌───────────────────────────────────────────────┐
                │ Domain / service layer — src/server/**         │
                │  services · storage · media · jobs · recsys    │
                └───────────────┬───────────────────────────────┘
                                │
                ┌───────────────┴───────────────┬───────────────┐
                ▼                               ▼               ▼
      PostgreSQL 16 (Prisma 6)        Local media storage    FFmpeg/FFprobe
      versioned migrations            (MediaStorage adapter)  (argv-only spawn)
```

---

## 2. Request lifecycle

A mutating API request flows through the same stages every time:

1. **Routing** — Next.js dispatches to the handler in `src/app/api/**/route.ts`.
   Handlers are wrapped with the `route()` helper so thrown errors become
   consistent JSON responses.
2. **Parse & validate** — `parseJson()` / `parseQuery()` validate the body or
   query string with a zod schema. Invalid input becomes a `422` with
   field-level details.
3. **Authentication** — `getCurrentUser()` reads the session cookie, resolves the
   session row, checks expiry/revocation and `sessionEpoch`, and returns a
   `SessionUser` (or `null`). It is wrapped in React `cache` so multiple
   components in one render hit the database once. `requireUser()`,
   `requireRole()`, and `requireChannelOwner()` guard higher-privilege actions.
4. **Request integrity** — cookie-authenticated state changes call
   `assertSameOrigin()` to enforce that the request's `Origin`/`Referer` matches
   the application origin (see §6).
5. **Authorisation & business logic** — the handler calls a service in
   `src/server/services/**`. All visibility, ownership, and quota rules are
   enforced here, so a new route cannot bypass a privacy rule.
6. **Response** — the handler shapes the result with `jsonOk` / `jsonCreated` /
   `jsonNoContent`; `jsonError` maps `AppError`s to safe HTTP statuses and never
   leaks internal details for `5xx`.

Read-only page requests additionally use the React Server Component data-fetch
path: the page component awaits a service directly with the viewer context
(`getViewerContext()`), so the same authorisation rules apply without a
round-trip to the JSON API.

---

## 3. Media pipeline

Uploads are staged, then processed asynchronously and only published when
`READY`.

```
POST /api/uploads                 create Upload row + reserved key
        │
PUT  /api/uploads/:id/chunk       append bytes at an explicit offset (5 MiB chunks)
        │
POST /api/uploads/:id/complete    create the Video, mark PROCESSING,
        │                         enqueue a media.process job
        ▼
  jobs: media.process ───────────────────────────────────────────────┐
        │                                                            │
        │  1. promote staged file → videos/<id>/source/original.<ext> │  (atomic
        │  2. FFprobe (authoritative) → duration, dimensions, codecs  │   rename,
        │  3. thumbnail + poster                                       │   or streamed
        │  4. playback rendition:                                     │   copy across
        │       H.264/AAC MP4 → remux with +faststart (no re-encode)  │   filesystems)
        │       anything else → transcode to the primary ladder height│
        │  5. optional remaining ladder heights + optional HLS        │
        │  6. write VideoAsset rows, mark READY, publish when the     │
        │     creator chose PUBLIC/UNLISTED, enqueue notification      │
        │     fan-out, recompute channel counts                        │
        └─────────────────────────────────────────────────────────────┘
```

Key properties, all implemented in `src/server/services/media-process.ts`:

- **Idempotent.** A retried job finds the source already promoted and replaces
  derived assets, converging on the same final state.
- **Never upscales.** `chooseLadder()` picks ladder heights that do not exceed
  the source height, always produces a primary rendition, and caps the count
  (default 2) so a laptop is not asked to run a large multi-way transcode.
- **Publish-on-ready.** A video gets a `publishedAt` timestamp only when
  processing succeeds and the creator had chosen a non-private visibility.
- **Failure is explicit.** On error the video becomes `FAILED` with
  `processingError`, the original source is retained for retry, and the chosen
  visibility is preserved. `FAILED` videos are excluded from every public
  listing because public queries require `status = READY`.
- **Bounded concurrency.** Rendition work respects `PROCESSING_CONCURRENCY`.

### Runtime H.264 encoder negotiation

Fedora's `ffmpeg-free` build omits the patent-encumbered `libx264` encoder, so
hardcoding `-c:v libx264` fails on a stock install. `src/server/media/encoders.ts`
queries `ffmpeg -encoders` once per process (memoised) and picks, in order:

1. `VIDEO_ENCODER` — explicit override from `.env`, if set and present
2. `libx264` — best quality per byte (RPM Fusion build)
3. `h264_nvenc` — NVIDIA hardware, if a device node is visible
4. `h264_vaapi` — Intel/AMD hardware, if a render node actually initialises
5. `libopenh264` — the software H.264 shipped by Fedora's free stack

The chosen encoder is reported by `npm run doctor` and `/api/health`. If none is
available, DEXTube refuses to transcode with an actionable error rather than
producing an unplayable file.

### Storage key layout

Every object is addressed by an **opaque, server-generated key**. Client-supplied
paths are never joined into filesystem paths; `normalizeKey()` rejects traversal,
absolute paths, backslashes, empty segments, and over-long keys.

```
images/…                                       avatars/banners (public)
channels/<channelId>/…                         channel artwork (public)
users/<userId>/…                               user avatars (public)
videos/<videoId>/source/original.<ext>         the promoted original upload
videos/<videoId>/playback/<height>p.mp4        progressive renditions
videos/<videoId>/thumbs/default.jpg            thumbnail
videos/<videoId>/thumbs/poster.jpg             poster
videos/<videoId>/hls/index.m3u8                HLS manifest (when enabled)
videos/<videoId>/hls/…                          HLS segments (when enabled)
uploads/<uploadId>/…                           in-progress staging files (owner only)
health/probe-<ts>.txt                          health-endpoint probe (not served)
```

Media delivery is centralised in `src/app/api/media/[...path]/route.ts` so that
privacy is enforced per request, HTTP range requests work, the correct MIME type
is always sent with `X-Content-Type-Options: nosniff`, and keys never appear as
filesystem paths. Authorisation rules: `images/`, `channels/`, `users/` are
public; `videos/<id>/…` follows the video's visibility (moderators may review
private media); `uploads/<id>/…` is owner-only; unknown prefixes are never served.
Unauthorised requests receive `404`, not `403`, so private media is not
disclosed.

---

## 4. Job queue

The queue is the `jobs` table — no external broker is required. See the
`Job` model in [`docs/database.md`](./database.md).

- **Delivery is at-least-once.** `claimNextJob()` uses a single
  `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` statement so several workers
  can poll concurrently without contention. Handlers are therefore idempotent.
- **Job types** are registered in one map in `src/server/jobs/handlers.ts`:
  `media.process`, `media.thumbnail`, `notification.fanout`,
  `analytics.aggregate`, and `maintenance.prune`.
- **Retries with backoff.** A failure schedules a retry at
  `min(10 min, 5s × 5^(attempts-1))` until `maxAttempts` (default 3, from
  `JOB_MAX_ATTEMPTS`). Exhausted jobs become `FAILED` with `lastError`.
- **Heartbeat / stale-lock recovery.** If a worker dies mid-run, the row stays
  `RUNNING` with an old `lockedAt`; `recoverStaleJobs()` re-queues locks older
  than 15 minutes.
- **Dedupe.** An optional unique `dedupeKey` prevents duplicate jobs for the same
  logical event (for example the subscriber fan-out for one video).

### Recurring work

`src/server/jobs/scheduler.ts` enqueues the periodic jobs; both runners call
`ensureRecurringJobs()` on each tick. Every schedule is keyed so repeated calls
are idempotent — a `dedupeKey` collision is a no-op, not an error:

| Job | Cadence | Dedupe key |
| --- | --- | --- |
| `analytics.aggregate` (today) | Every 15 minutes | `analytics:<day>:<15-min bucket>` |
| `analytics.aggregate` (yesterday) | Within 2 h of midnight | `analytics-final:<day>` |
| `maintenance.prune` | Daily | `maintenance:<day>` |

`ensureTodayAggregated()` in `src/server/services/analytics.ts` uses the same
15-minute bucket key, so a page that needs today's numbers and the scheduler
cannot enqueue two different jobs for the same window.

### Inline vs external runner (`JOB_RUNNER`)

| Mode | Behaviour |
| --- | --- |
| `inline` (dev default) | The web process drains the queue in the background via `kickInlineQueue()`. A 5-second **unref'd** heartbeat keeps delayed work moving, and after a retryable failure the runner schedules its own wake-up timer — so a backoff-scheduled job is not stranded until unrelated traffic arrives. Bounded concurrency keeps FFmpeg from saturating a laptop. |
| `external` (production) | `npm run worker` runs `runWorkerLoop()`, polling every `WORKER_POLL_MS` (default 2000 ms) and recovering stale locks periodically. Web requests never compete with transcoding. |

Both modes call the same `drainQueue()`, so behaviour is identical.

---

## 5. Authentication and sessions

Sessions are **not JWTs**. The design (`src/server/auth/session.ts`):

- **Opaque random token** — 32 random bytes, base64url-encoded, delivered in an
  `httpOnly` cookie (`dextube_session`; `__Host-dextube_session` whenever the app
  is served over HTTPS, which also requires `Secure`, `Path=/`, and no `Domain`).
  The prefix and `Secure` are derived from `APP_URL`, not from `NODE_ENV`:
  browsers silently drop a `Secure` cookie sent over plain HTTP, so an HTTPS-only
  policy would break a LAN deployment. `SESSION_COOKIE_SECURE=auto|true|false`
  overrides the decision.
- **Hashed at rest** — only the SHA-256 hash of the token is stored, so a database
  leak does not hand out live sessions.
- **`SameSite=Lax`; `Secure` whenever `APP_URL` is `https://`.**
- **Epoch invalidation** — every session records the `User.sessionEpoch` it was
  created with; bumping the epoch invalidates **all** of a user's sessions at
  once (password change, "sign out everywhere"). `revokeAllSessions()` bumps the
  epoch and marks rows revoked so the device list stays accurate.
- **Device metadata is minimised** — the stored IP is truncated to a `/24` (IPv4)
  or `/48` (IPv6) prefix; `lastSeenAt` is touched at most once every five minutes
  per session.
- **Passwords** are hashed with **Argon2id** (`@node-rs/argon2`, 19 MiB memory,
  2 iterations, 1 lane) and `needsRehash()` transparently upgrades weaker hashes
  on the next successful sign-in.

Email verification and password reset use single-use, expiring **`Token`** rows
(24 h and 1 h respectively) whose values are also stored only as hashes.

---

## 6. Request integrity (CSRF)

Cookie-authenticated state-changing requests are checked with
`assertSameOrigin()` in `src/lib/http.ts`:

- The request's `Origin` (falling back to `Referer`) must equal the application
  origin (`APP_URL`) or the request's own host.
- Requests with **no** `Origin`/`Referer` at all are rejected for these
  mutations. This is belt-and-braces alongside the `SameSite=Lax` cookie.

---

## 7. Recommender

`src/server/recsys/index.ts` is a **transparent, explainable weighted heuristic**.
DEXTube makes **no machine-learning claims**; there is no trained model, and the
service is deliberately replaceable behind a `rankVideos()` interface.

Signals and default weights (`DEFAULT_WEIGHTS`):

| Signal | Default weight | Notes |
| --- | --- | --- |
| Recency | 1.0 | Exponential decay, 14-day half-life (`RECENCY_HALF_LIFE_DAYS`). |
| Engagement | 0.85 | `log10(1 + views) + 1.5·log10(1 + likes)`, compressed so one viral video cannot dominate. |
| Subscription | 0.6 | Boost for channels the viewer subscribes to. |
| Interest | 0.4 | Boost when a video's category/tags match declared interests or recently watched categories. |
| Diversity | `maxPerChannel = 3` | At most N videos per channel in the final list. |
| Exclusion | — | Already-watched videos drop out of the first page. |

The home feed (`getRankedHomeFeed()`) returns a `strategy` field so the client can
show which path produced the page:

- **`personalized`** — signed-in viewers with any signal (subscriptions,
  interests, or history). Context is built only from the viewer's own data, and
  the `saveWatchHistory` privacy setting is respected (with history disabled,
  DEXTube neither reads nor excludes based on it).
- **`trending-recent`** — anonymous and cold-start viewers get a blended
  recency + bounded popularity baseline with a chronological backbone, so the
  feed does not ossify.

Candidates come from a bounded pool of the newest public, ready, non-Short
videos, keeping the ranking cost independent of catalogue size.

---

## 8. Configuration and startup

Every environment-dependent value is read through `src/lib/config.ts`, a zod
schema that **fails fast at startup** with a readable error instead of failing at
request time. It also refuses to start in production with a placeholder
`SESSION_SECRET` or `DATABASE_URL`. Standalone Node processes (worker, seed,
scripts) load `.env` through the minimal `src/lib/load-env.ts` parser; the Next.js
web app loads `.env` itself.

See [`docs/database.md`](./database.md) for the data model,
[`docs/deployment.md`](./deployment.md) for production, and
[`docs/security.md`](./security.md) for the threat model and controls.
