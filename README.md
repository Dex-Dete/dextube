# DEXTube

DEXTube is an open-source, self-hostable video-sharing platform with a familiar
video-platform interaction model: a collapsible sidebar, top search, video cards,
watch pages, comments, subscriptions, vertical Shorts, and a creator studio. It
is a **Next.js 16 (App Router) + React 19 + TypeScript** application built as a
modular monolith with a separate, optional background worker, backed by
**PostgreSQL 16** through **Prisma 6** and using **FFmpeg/FFprobe** for video
processing. It targets Fedora Linux first while remaining portable to any
Node.js 22 host.

> **DEXTube is an original project.** All source code, branding, the icon set,
> and artwork are original work. No YouTube proprietary code, assets, or
> trademarks are used. The familiarity of the layout is intentional and comes
> from original implementations of common video-platform patterns — not from
> copied code or assets.

Licensed under **AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE).

---

## Features

| Area | What DEXTube provides |
| --- | --- |
| **Accounts & auth** | Email + password registration, Argon2id password hashing, opaque hashed session cookies, email verification, single-use password reset, and global session invalidation via a per-user session epoch. |
| **Channels** | One channel per user, collision-free handle allocation, channel profiles (name, description, avatar, banner), edit, and layout metadata. |
| **Uploads & media pipeline** | Chunked, resumable uploads (5 MiB chunks with explicit byte offsets) that feed a queued FFmpeg pipeline: FFprobe metadata → thumbnail + poster → remux or a bounded multi-resolution H.264 transcode ladder → `READY`. |
| **Playback** | HTTP **range-request** progressive MP4 playback (seek, resume) with per-request authorisation. A **custom accessible player** (native `<video>` + its own keyboard-driven control layer) with speed 0.25–2×, captions, picture-in-picture and a **manual** quality menu built from the video's real renditions — never labelled adaptive, because no ABR engine runs. **HLS packaging is optional** (`ENABLE_HLS`). See [`docs/player.md`](./docs/player.md). |
| **Comments** | Comments and one level of replies, likes, `top`/`newest` sorting, pagination, and creator/moderator moderation (pin, hide). |
| **Subscriptions** | Subscribe/unsubscribe with per-subscription notification preference and a subscriptions feed. |
| **Notifications** | In-app notifications (new video, replies, likes, new subscribers) with read/unread state, pagination, and duplicate suppression. |
| **Libraries** | Channel-owned playlists with ordering and visibility, plus the system **Watch later** and **Liked videos** playlists; watch history with continue-watching and watch progress. |
| **Search** | Video, channel, and public-playlist search with type/duration/sort filters plus a lightweight autocomplete endpoint. |
| **Shorts** | 9:16 vertical Shorts detection on upload, a dedicated Shorts feed, and vertical navigation. |
| **Recommendations** | A **transparent weighted-heuristic** home feed (`strategy: trending-recent` / `personalized`). No machine-learning claims are made; every signal and weight is documented and configurable. Viewers can say **"Not interested" / "Don't recommend this channel"** and **reset** their recommendations, and history-derived signals are only read when watch history is enabled. |
| **DEXTube Studio** | Creator analytics derived from real recorded events (views, watch time, likes, comments, subscribers) with daily rollups, a sortable paginated content table, bulk publish/unpublish/delete, retry for failed processing, and paginated owner-scoped moderation. |
| **DEX Music** | A rights-first audio surface: each track stores its source, licence, required attribution, territory and download permission, and a download is only served when that permission exists. Ships **no bundled catalogue** — the library starts empty rather than redistributing music without a licence. See [`docs/music.md`](./docs/music.md). |
| **Administration** | Role-gated admin surfaces (overview, users, system, import) with server-side authorisation on every endpoint, an append-only `admin_audit_logs` trail, account disable/enable that revokes sessions and burns tokens, and a one-time initial administrator that is refused outright in production. See [`docs/deployment.md`](./docs/deployment.md) §13. |
| **Authorized migration** | Import metadata for a channel or playlist from **YouTube's official Data API or public feed** — real titles, ids, dates and descriptions, with duplicate detection, bounded concurrency, resumable runs, retries, cancellation and a storage quota. Original media is imported **only** from an authorized creator export that records an authorization basis; entries with no permission stay `METADATA_ONLY`. DEXTube never rips media, never bypasses DRM or access controls, and never fabricates a download. See [`docs/import.md`](./docs/import.md). |

---

## Screenshots

> **Placeholder.** DEXTube deliberately commits **no binary image assets** to
> the repository. Add your own screenshots here once you have a deployment —
> for example a home-feed capture, a watch page, the upload flow, and DEXTube
> Studio — under a `docs/images/` directory that is ignored by Git.

---

## Quick start (Fedora)

The full, Fedora-focused install and operations guide is
[`docs/fedora.md`](./docs/fedora.md). It covers prerequisites, the FFmpeg
encoder situation, systemd units, SELinux, firewalld, and backups. The short
version:

**Prerequisites:** Node.js **>= 22**, PostgreSQL **16** (Docker is the default),
and FFmpeg + FFprobe.

```bash
# Optional idempotent bootstrap: checks the toolchain, creates .env,
# installs JS dependencies and generates the Prisma client. Never runs sudo.
bash scripts/fedora-install.sh

# 1. Start the local PostgreSQL 16 container (host port 5433)
bash scripts/db-up.sh

# 2. Apply the committed migrations
npx prisma migrate deploy

# 3. Generate the typed Prisma client (after schema changes)
npx prisma generate

# 4. Seed development data
npm run db:seed

# 5. Run the app (development)
npm run dev            # http://localhost:3000

# Production path
npm run build && npm start
```

### systemd launcher (Ubuntu and Fedora)

The repository includes a portable user-systemd installer. It uses the same
`systemctl --user` interface on Ubuntu and Fedora and does not require sudo:

```bash
./start.sh --systemd-install
systemctl --user status dextube.service
./start.sh --systemd-restart
```

For a one-shot bootstrap without systemd, use `./start.sh` or
`./start.sh --prod`. The installer builds before enabling the service and reads
the checkout's `.env`.

Verify your machine at any point with the preflight diagnostic:

```bash
npm run doctor
```

### Convenience scripts

| Script | What it does |
| --- | --- |
| `scripts/fedora-install.sh` | Idempotent Fedora bootstrap: checks Node/npm/FFmpeg/encoders/Docker, creates `.env` from `.env.example`, runs `npm ci` (fallback `npm install`), and `npx prisma generate`. Never runs `sudo`. |
| `scripts/db-up.sh` | Starts the `dextube-postgres` PostgreSQL 16 container on `127.0.0.1:5433`. Tries `docker compose`, then `docker-compose`, then plain `docker run`. Waits until the database accepts connections. |
| `scripts/db-down.sh` | Stops the local services; the `dextube_pgdata` data volume is preserved. |
| `scripts/start.sh` | Checks `.env` → starts the database → waits for it → `npx prisma migrate deploy` → `npm run doctor` → launches the app (add `--prod` for a production build). Starts `npm run worker` when `JOB_RUNNER=external`. Logs to `storage/logs/`, PIDs to `storage/run/`. |
| `scripts/stop.sh` | Stops the processes `start.sh` started (verified by working directory/command line) with `SIGTERM`, then `SIGKILL`. Add `--with-db` to also stop the database container. |
| `scripts/backup.sh` | Backs up the database (`pg_dump`) **and** `MEDIA_ROOT` into a timestamped directory plus a manifest with sizes and SHA-256 checksums. |
| `scripts/restore.sh` | Verifies a backup and restores the database and media. Destructive; requires `--yes`. |
| `scripts/doctor.ts` | The `npm run doctor` preflight: Node, config, database, media-directory writability, FFmpeg/FFprobe, H.264 encoder, SMTP. |
| `scripts/seed.sh` | `npm run db:seed` (and `npx prisma db seed`) — loads `src/server/**` with the `react-server` condition, which Prisma's own runner cannot set. |
| `scripts/make-test-media.ts` | `npm run make:testmedia` generates small, fully synthesised test clips (no third-party content) into `storage/test-media/`. |
| `scripts/isolated-setup.sh` | `npm run isolated:setup` creates the isolated test environment: its own database, media tree and `.env.isolated-test` (git-ignored, `chmod 600`). Refuses to continue if the database name would collide with development. |
| `scripts/isolated.sh` | Runs any command with the isolated environment loaded. `npm run isolated:dev` / `isolated:build` / `isolated:start` wrap it. |
| `scripts/isolated-reset.ts` | `npm run isolated:reset` clears the isolated environment. Dry run by default; `--apply --yes` to act, after verifying `DEXTUBE_ENV`, the database name and the media root. See [`docs/deployment.md`](./docs/deployment.md) §12. |
| `scripts/admin-bootstrap.ts` | `npm run admin:bootstrap` creates the one-time initial administrator. `--enable-bootstrap-as-operator` turns the database switch on first (the web app can only ever turn it off). |

---

## Configuration

All configuration is environment-driven and documented inline in
[`.env.example`](./.env.example). Copy it to `.env` and fill in real values:

```bash
cp .env.example .env
SESSION_SECRET=$(openssl rand -base64 48)   # then put it in .env
```

| Group | Key variables | Notes |
| --- | --- | --- |
| Core | `NODE_ENV`, `APP_URL`, `BIND_HOST`, `PORT` | `BIND_HOST` defaults to `127.0.0.1` (localhost only). |
| Database | `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Docker publishes PostgreSQL on `5433`; a native install listens on `5432`. |
| Sessions | `SESSION_SECRET`, `SESSION_TTL_DAYS`, `SESSION_COOKIE_SECURE` | Rejected at startup in production if `SESSION_SECRET` is left as a placeholder. `SESSION_COOKIE_SECURE=auto` follows `APP_URL` (see below). |
| Storage & media | `STORAGE_DRIVER`, `MEDIA_ROOT`, `MEDIA_PUBLIC_BASE`, `MAX_UPLOAD_BYTES`, `MAX_VIDEO_DURATION_SECONDS`, `PROCESSING_CONCURRENCY`, `TRANSCODE_LADDER`, `ENABLE_HLS` | `STORAGE_DRIVER=local` is what works today. |
| S3 (reserved) | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | Present for the future S3 adapter; not implemented yet. |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` | Without SMTP, mail is written to `storage/mail-outbox/*.eml`. |
| Rate limiting | `RATE_LIMIT_DISABLED`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`, `VIEW_DEDUPE_SECONDS` | |
| Jobs | `JOB_RUNNER`, `WORKER_POLL_MS`, `JOB_MAX_ATTEMPTS` | `inline` (dev default) or `external` (production). |
| Deployment identity | `DEXTUBE_ENV` | `development` \| `isolated-test` \| `production`. Deliberately separate from `NODE_ENV`; only `isolated-test` unlocks the destructive reset and the administrator bootstrap. |
| Initial administrator | `ADMIN_BOOTSTRAP_ENABLED`, `ADMIN_BOOTSTRAP_USERNAME`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` | Refused when `DEXTUBE_ENV=production`. The database switch in `system_settings` must also be on. See [`docs/deployment.md`](./docs/deployment.md) §13. |
| Isolated test env | `ISOLATED_DATABASE_NAME`, `ISOLATED_MEDIA_ROOT` | What `npm run isolated:reset` checks the live configuration against before deleting anything. |
| Authorized migration | `YOUTUBE_API_KEY`, `CREATOR_EXPORT_ROOT`, `IMPORT_MAX_ITEMS`, `IMPORT_MAX_CONCURRENCY`, `IMPORT_HTTP_TIMEOUT_MS`, `IMPORT_MAX_RESPONSE_BYTES`, `STORAGE_QUOTA_BYTES` | Without an API key, metadata comes from YouTube's official public feed (latest 15 entries). See [`docs/import.md`](./docs/import.md). |

A few operator-only variables are intentionally not in `.env.example`; they are
documented where they apply:

| Variable | Used for |
| --- | --- |
| `DEXTUBE_TRUST_PROXY=1` | Trust `X-Forwarded-For` for rate limiting and view dedupe. Set **only** behind your own reverse proxy. See [`docs/deployment.md`](./docs/deployment.md). |
| `DEXTUBE_WORKER_ID` | Stable worker identity in job lock rows. |
| `DEXTUBE_MODE=production` | Selects production mode for `scripts/start.sh`. |
| `DEXTUBE_DB_WAIT_SECONDS`, `DEXTUBE_STOP_GRACE_SECONDS` | Timeouts for the start/stop scripts. |
| `VIDEO_ENCODER`, `VAAPI_DEVICE`, `FFMPEG_PATH`, `FFPROBE_PATH` | Optional media overrides. |

---

## Local network (LAN) access

By default DEXTube binds `127.0.0.1:3000`, which only this machine can reach. To
open it to your local network (for example `http://192.168.1.10:3000`):

```dotenv
# .env
APP_URL=http://192.168.1.10:3000
BIND_HOST=0.0.0.0
PORT=3000
```

`npm run dev` reads `BIND_HOST`/`PORT` through Next.js; `scripts/start.sh` passes
them as `-H`/`-p`; the example systemd unit in `docs/fedora.md` does the same.

**Cookies over HTTP.** Session cookies are `Secure` and use the `__Host-` prefix
**only when `APP_URL` is `https://`**. Browsers refuse to store a `Secure` cookie
received over plain HTTP (localhost is exempt), so on a LAN address DEXTube
issues the unprefixed `dextube_session` cookie instead — login works. This is
derived from `APP_URL`, not from `NODE_ENV`; override it with
`SESSION_COOKIE_SECURE=true|false` if your setup needs it.

Plain HTTP on `0.0.0.0` is appropriate for a **trusted** home/office LAN and
never for the public internet. Anyone on that network can read the traffic and
reach the instance. For internet exposure, put a TLS-terminating reverse proxy in
front (see [`docs/deployment.md`](./docs/deployment.md)) and set `APP_URL` to the
`https://` origin.

If the firewall blocks the port:

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

---

## Testing and checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (flat config)
npm test            # Vitest: unit + integration (needs the database)
npm run test:e2e    # Playwright end-to-end (needs a running dev server)
npm run doctor      # preflight diagnostic for your machine
```

The suite is split three ways:

| Layer | Location | What it covers |
| --- | --- | --- |
| Unit | `tests/unit/**` | Password hashing policy, session-token format, zod validation, recommender ranking, time formatting. No database or network. |
| Integration | `tests/integration/**` | Real services against the real database: registration → email verification → login → password reset, video visibility rules, owner self-views, watch history, reactions, shorts, playlists, search, rate limiting, the recurring-job scheduler. |
| End-to-end | `tests/e2e/**` | A real Chromium browser: register → Studio → sign out → sign in, wrong-password handling, and upload → processing → playback (HTTP range request verified) → comment → Studio listing. |

Notes:

* The **database must be up and migrated** for the integration and e2e suites —
  `bash scripts/db-up.sh && npx prisma migrate deploy` first. Integration cases
  that need the database skip themselves (rather than fail) when it is
  unreachable, so `npm test` still works on a machine without PostgreSQL.
* Integration tests use fixture users prefixed `itest_` and clean up after
  themselves. E2E uses `e2e_` accounts and removes them in a global teardown.
* Playwright needs its browser once: `npx playwright install chromium`.
* `npm run test:e2e` starts `npm run dev` itself if nothing is listening on the
  configured port; otherwise it reuses the running server. It is repeatable:
  a global setup clears the rate-limit buckets and stale `e2e_` accounts before
  the run, and a global teardown deletes the accounts it created.
* `npm run make:testmedia` regenerates the small, fully synthesised test clips
  in `storage/test-media/` (no third-party content).

---

## Architecture

DEXTube is a modular monolith:

- `src/app/**` — pages and route handlers (thin: parse → validate → authorize →
  call a service → shape the response).
- `src/components/**` — the UI component system and the original icon set.
- `src/lib/**` — client-safe shared utilities (no Prisma, no `fs`).
- `src/server/**` — server-only domain layer: services, storage adapters, FFmpeg
  wrappers, the DB-backed job queue, and the recommender.

It can run jobs **inline** in the web process (`JOB_RUNNER=inline`, the
development default) or in a dedicated worker (`JOB_RUNNER=external` +
`npm run worker`, the production recommendation).

See [`docs/architecture.md`](./docs/architecture.md) for the request lifecycle,
the media pipeline, the job-queue design, and the recommender,
[`docs/performance.md`](./docs/performance.md) for measured latency, statement
counts, bundle sizes and the query plans behind the hot paths,
[`docs/player.md`](./docs/player.md) for the player design and the recorded
evaluation of a third-party player library, and
[`docs/music.md`](./docs/music.md) for the DEX Music rights model.

---

## Deployment

Production is a build plus two processes behind a TLS-terminating reverse proxy:
the Next.js web server and the background worker.

```bash
npm run build
JOB_RUNNER=external npm run worker     # worker process
npm start                              # web process
```

Set strong secrets, a real `APP_URL`, secure cookies (automatic in production),
and `DEXTUBE_TRUST_PROXY=1` behind your proxy. See
[`docs/deployment.md`](./docs/deployment.md) for PostgreSQL setup, nginx/Caddy
examples with range-request and large-upload settings, systemd units, backups,
and a production checklist. The Fedora-specific walkthrough (including systemd
units, SELinux, and firewalld) is in [`docs/fedora.md`](./docs/fedora.md).

---

## Security

DEXTube implements Argon2id password hashing, SHA-256-hashed opaque session
tokens with epoch invalidation, a same-origin CSRF check for cookie-authenticated
mutations, database-backed rate limiting, zod validation on every mutation,
per-request media authorisation (private or unknown media returns `404`, never
`403`), a conservative CSP and security headers, and anonymous view dedupe
hashing that stores no raw IP addresses.

Known gaps are stated plainly: no multi-factor authentication, no email delivery
without SMTP, no WAF, and the S3 storage adapter is not implemented. See
[`docs/security.md`](./docs/security.md) and the project
[security policy](./SECURITY.md).

To report a vulnerability, **do not open a public issue** — follow
[`SECURITY.md`](./SECURITY.md).

---

## Roadmap and known limitations

DEXTube is pre-1.0 (`0.1.0`); the schema and internal interfaces may still
change. Current limitations, stated honestly:

- **HLS is off by default** (`ENABLE_HLS=false`). Progressive MP4 with HTTP range
  requests is the delivered playback path.
- **The S3 storage adapter is not implemented.** `STORAGE_DRIVER=s3` refuses to
  start rather than silently pretending to store media remotely.
- **SMTP is optional.** Without it, verification and password-reset mail is
  written to `storage/mail-outbox/*.eml` (and the link is printed in
  development).
- **The job queue is database-backed, not Redis.** PostgreSQL `FOR UPDATE SKIP
  LOCKED` provides correct at-least-once delivery with no extra service to run.
- **Stock Fedora's `ffmpeg-free` has no `libx264`.** DEXTube negotiates an
  H.264 encoder at runtime (`libx264` → `h264_nvenc` → `h264_vaapi` →
  `libopenh264`); installing RPM Fusion's `ffmpeg` switches it back to `libx264`
  automatically. `npm run doctor` reports the chosen encoder.
- **Avatar/banner upload is not implemented.** The Studio channel page shows the
  current images and labels the upload control as unavailable rather than faking
  it.
- **Streamed `notFound()`/`redirect()` return HTTP 200.** Next.js streams the
  document before the route resolves, so an unknown dynamic route renders the 404
  *UI* with `noindex`; static unknown routes return a genuine 404.
- Some UI surfaces are still being built out. Nothing in this README is claimed
  as finished before it has been run and verified; the “intentionally incomplete”
  list in [`CONTRIBUTING.md`](./CONTRIBUTING.md#11-things-that-are-intentionally-incomplete)
  is the canonical statement of what does not work yet.

The project [changelog](./CHANGELOG.md) tracks notable changes.

---

## Publishing your own instance or fork

The repository ships with deliberately non-routable placeholder contacts so that
nothing in it points at a mailbox or URL nobody controls. Replace them before you
publish a fork, deploy publicly, or accept security reports:

| Placeholder | Where | Replace with |
| --- | --- | --- |
| `conduct@dextube.invalid` | `CODE_OF_CONDUCT.md`, `SECURITY.md` | A mailbox you actually monitor for conduct reports. |
| `security@dextube.invalid` | `SECURITY.md` | A mailbox you actually monitor for vulnerability reports. |
| `https://example.invalid/dextube/compare/...` | `CHANGELOG.md` link definitions | Your repository's compare URL. |
| `no-reply@example.invalid` | `SMTP_FROM` in `.env.example` | A real sender address for outbound mail. |

Also confirm, before going live, that `APP_URL` is your real HTTPS origin,
`SESSION_SECRET` is freshly generated (`openssl rand -base64 48`), and
`DEXTUBE_TRUST_PROXY=1` is set **only** when a reverse proxy you control sits in
front of the app.

---

## License

DEXTube is free software licensed under the **GNU Affero General Public License,
version 3.0 or later** (AGPL-3.0-or-later). The full text is in
[`LICENSE`](./LICENSE).

- Want to contribute? Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- Found a security issue? Follow [`SECURITY.md`](./SECURITY.md) and report it
  privately.
- Dependency licenses and third-party attribution are catalogued in
  [`docs/dependencies.md`](./docs/dependencies.md).
