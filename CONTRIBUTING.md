# Contributing to DEXTube

Thanks for your interest in DEXTube — an open-source, self-hostable
video-sharing platform built as a modular monolith. This guide covers everything
you need to get a working development environment, run the checks, and land a
change.

By participating you agree to follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 1. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 22** (22.x or newer) | runs the web app and the worker; see `engines` in `package.json` |
| npm | bundled with Node | package manager |
| FFmpeg + FFprobe | recent | required for the media pipeline; read the Fedora encoder note in §7 |
| PostgreSQL | **16** | either Docker (recommended for dev) or a native install |
| Docker | optional | only needed for the containerised dev database |

No Redis is required: the job queue is database-backed. S3 storage is **not**
implemented — `STORAGE_DRIVER=local` is what works today (see §11).

Quick check of the core toolchain:

```bash
node --version    # must be v22.x or newer
npm --version
ffmpeg -version
ffprobe -version
```

### 1.1 Bootstrap (optional convenience)

```bash
bash scripts/fedora-install.sh
```

This is idempotent and never runs `sudo`: it checks the toolchain, copies
`.env.example` to `.env` when needed, installs JavaScript dependencies
(`npm ci`, falling back to `npm install`), and generates the Prisma client. The
manual steps it automates are listed below.

---

## 2. Configure the environment

Copy the example file and fill in the required values:

```bash
cp .env.example .env
```

At minimum set a real `SESSION_SECRET` and a matching `POSTGRES_PASSWORD`:

```bash
# .env
SESSION_SECRET=$(openssl rand -base64 48)
```

`DATABASE_URL` must match the database you start in §3. The Docker setup
publishes PostgreSQL on host port **5433**; a native PostgreSQL listens on
**5432** by default:

```dotenv
# Docker (default for development):
DATABASE_URL=postgresql://dextube:CHANGE_ME@localhost:5433/dextube
```

`.env` is git-ignored. Never commit real secrets; never paste secrets into an
issue or pull request (§12).

---

## 3. Start the database

The helper script starts a PostgreSQL 16 container named `dextube-postgres` on
host port `5433`:

```bash
bash scripts/db-up.sh
```

It tries `docker compose`, then `docker-compose`, then falls back to a plain
`docker run` (Fedora installs frequently lack the compose plugin). Stop it
(data is preserved) with:

```bash
bash scripts/db-down.sh
```

Already run PostgreSQL 16 yourself? Skip this and point `DATABASE_URL` at it.

---

## 4. Apply migrations and generate the client

Apply the committed migrations:

```bash
npx prisma migrate deploy
```

`migrate deploy` is non-interactive and is what scripts and CI use. In day-to-day
development you can use `npx prisma migrate dev` instead (it also regenerates the
client), but note it can stall on a `y/N` prompt in a non-interactive shell. After
editing `prisma/schema.prisma`, regenerate the typed client:

```bash
npx prisma generate
```

To add a new migration, see §9.

---

## 5. Run the app

```bash
npm run dev
```

The dev server listens on <http://localhost:3000>. Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server on port 3000 |
| `npm run build` | production build |
| `npm start` | run the production build on port 3000 |
| `npm run worker` | background job worker (for `JOB_RUNNER=external`) |
| `npm run make:testmedia` | generate a tiny test video for the pipeline |

### 5.1 Job runner: inline vs external

Video processing runs as background jobs in the `jobs` table.

* `JOB_RUNNER=inline` (development default) runs jobs inside the web process. You
  do **not** need a separate worker.
* `JOB_RUNNER=external` (recommended for production) expects a worker process:

  ```bash
  npm run worker
  ```

If you set `JOB_RUNNER=external` and forget the worker, uploads will sit in
`PROCESSING` forever.

### 5.2 Email in development

When SMTP is not configured, verification and password-reset links are written to
`storage/mail-outbox/*.eml` and printed to the server console. Open the `.eml`
file (or copy the link from the console) to verify an account locally.

---

## 6. Preflight: run the doctor

Before you spend time debugging, let the doctor check your machine:

```bash
npm run doctor
```

It reports database connectivity, media-directory writability, FFmpeg/FFprobe
presence, and which H.264 encoder was negotiated. Fix any `FAIL` it reports
before filing a bug; `WARN` items (for example SMTP or HLS) are informational.

---

## 7. The Fedora encoder note (important)

Fedora's default `ffmpeg-free` package is built **without** `libx264`. Code that
hardcodes `-c:v libx264` therefore fails on a stock Fedora install with
`Unknown encoder 'libx264'`.

DEXTube never hardcodes an encoder. At runtime it inspects the available encoders
and negotiates one in this preference order:

1. `VIDEO_ENCODER` — an explicit override from `.env`, if set
2. `libx264` — best quality per byte (RPM Fusion build)
3. `h264_nvenc` — NVIDIA hardware
4. `h264_vaapi` — Intel/AMD hardware
5. `libopenh264` — software H.264 shipped by Fedora

`npm run doctor` and `/api/health` report the chosen encoder. Force one in
`.env` (only if that build actually has it):

```dotenv
VIDEO_ENCODER=libx264   # or h264_nvenc, h264_vaapi, libopenh264, auto
```

See [`docs/fedora.md`](./docs/fedora.md) for the full Fedora guide and how to
install a `libx264`-capable FFmpeg via RPM Fusion. Do not set
`VIDEO_ENCODER=libx264` unless the encoder exists — DEXTube will refuse to
transcode and tell you why.

---

## 8. Run the checks

Run these before opening a pull request:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (unit + integration)
npm run test:e2e    # Playwright end-to-end (requires a dev server)
npm run lint        # ESLint (flat config, eslint-config-next)
```

Notes:

* `npm run lint` uses the ESLint CLI with the flat config in `eslint.config.mjs`.
  Next.js 16 removed `next lint`; `eslint-config-next` is still the rule source.
  The config keeps `@next/next/no-img-element` off on purpose: every image is
  served through the authorization-checked `/api/media/*` route, so `next/image`
  (whose optimizer fetches sources itself) would bypass per-request media
  authorization.
* `npm test` runs unit tests everywhere, plus integration tests that need
  PostgreSQL. Start the database and apply migrations first
  (`bash scripts/db-up.sh && npx prisma migrate deploy`); database-dependent
  cases skip themselves when the database is unreachable instead of failing.
* `npm run test:e2e` drives a real browser against a running instance. Start
  `npm run dev` first (or let Playwright start it), and make sure the database is
  up and migrated. Install the browser once with
  `npx playwright install chromium`.
* The e2e run is repeatable by design: `tests/e2e/global-setup.ts` clears the
  rate-limit buckets (registration is capped at 5/hour/IP, so a second run would
  otherwise be throttled) and removes leftovers from an interrupted run;
  `global-teardown.ts` deletes the `e2e_` accounts afterwards.
* Keep test users on the reserved prefixes: `itest_`/`itest-` for Vitest (the
  integration helpers clean them up) and `e2e_` for Playwright (the global
  teardown in `tests/e2e/global-teardown.ts` removes them). That is what keeps
  repeated runs idempotent.
* Tests must pass without relying on network access or external services. Add
  new coverage next to the layer it belongs to — `tests/unit`,
  `tests/integration`, or `tests/e2e` — and mirror the existing file structure.

---

## 9. Adding a database migration

Migrations live in `prisma/migrations/` and are applied with Prisma.

1. Edit `prisma/schema.prisma`.
2. Create and apply a migration locally:

   ```bash
   npx prisma migrate dev --name describe_your_change
   ```

   Use a short, snake_case name that describes the change (for example
   `add_playlist_ordering`). Following an existing example is a good idea — the
   current migrations are `init`, `search_indexes`, `rate_limit_buckets`,
   `system_playlist_per_channel`, `restore_search_indexes`, and
   `watch_history_unique`.
3. Review the generated SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`.
   Raw-SQL migrations (indexes, extensions) are expected and welcome.
4. **Declare every index in `schema.prisma` too.** Prisma-defined indexes
   (`@@index`, `@@unique`, `type: Gin`, explicit `map:` names) survive
   `prisma migrate dev`; indexes that exist only as raw SQL in a migration do
   not, and `migrate dev` will happily write a migration that drops them. That is
   why the trigram-search GIN indexes are declared in the schema and only the
   partial indexes remain raw SQL (see
   [`docs/database.md`](./docs/database.md#42-search-indexes-declared-in-the-schema-and-created-by-migrations)).
5. Regenerate the client (`npx prisma generate`) and commit the migration
   directory together with the schema change.
6. Never edit a migration that has already been applied to a shared database;
   add a new one instead. Never rewrite history in `prisma/migrations/`.

---

## 10. Code style and architecture expectations

DEXTube is a modular monolith. Keep changes consistent with the surrounding code.

* **TypeScript strict.** The project compiles with `strict` on. Avoid `any`; if
  you genuinely need it, justify it in a comment. Prefer `unknown` plus
  narrowing, or a precise type.
* **Server-only modules declare it.** Anything that touches Prisma, the
  filesystem, or Node builtins must import `"server-only"` at the top so it can
  never be bundled into client code.
* **Services live in `src/server/services/**`.** Business logic and every
  ownership/privacy check belong here. A route handler must never be the only
  place a rule is enforced.
* **Route handlers live in `src/app/api/**` and stay thin.** The pattern is:
  parse → validate with zod → authorize → call a service → shape the response.
  No business logic in `route.ts` files.
* **Never trust client input.** Validate and coerce every request body, query
  parameter, and path segment with **zod**. All mutations validate with zod.
* **`src/lib/**` is client-safe.** No Prisma or `fs` there. Shared pure helpers
  only.
* **Storage keys are server-generated.** Never join a client-supplied path into
  a filesystem path.
* **Do not claim more than you build.** If something is a heuristic, call it a
  heuristic; if it is unimplemented, say so.

If a change touches Next.js APIs or conventions, read the relevant guide in
`node_modules/next/dist/docs/` first — this project uses Next.js 16, whose
conventions can differ from older material. (`next dev` also writes a local
`AGENTS.md` with the same warning; it is generated per machine and not tracked.)

---

## 11. Things that are intentionally incomplete

Do not "fix" these by faking functionality:

* `STORAGE_DRIVER=s3` refuses to run and throws a clear error. The S3 adapter is
  not implemented. Use `STORAGE_DRIVER=local`.
* HLS packaging is off by default (`ENABLE_HLS=false`); progressive MP4 with HTTP
  range requests is the delivered path.
* Multi-bitrate transcoding is bounded by `PROCESSING_CONCURRENCY` and the
  configured `TRANSCODE_LADDER`; there is no ABR manifest, so the player plays
  the single selected rendition.
* Email is written to `storage/mail-outbox/*.eml` unless you configure SMTP;
  nothing is delivered to real inboxes without it.
* The recommender is a transparent weighted heuristic, not machine learning.
  Its weights are configuration, not a trained model.

---

## 12. Reporting bugs

Found a bug? Open an issue on GitHub using the project's issue tracker. A good
report includes:

* what you expected and what actually happened;
* exact steps to reproduce;
* your environment (OS, Node version, FFmpeg build, `npm run doctor` output);
* relevant logs with secrets removed.

**Do not paste secrets.** Redact `SESSION_SECRET`, `DATABASE_URL` credentials,
`POSTGRES_PASSWORD`, SMTP credentials, S3 keys, session cookies, and any
verification/reset links. If you believe you have found a security
vulnerability, do **not** open a public issue — follow [SECURITY.md](./SECURITY.md)
and report it privately.

---

## 13. Commits and pull requests

* Write commit messages in the **imperative mood, present tense** — "Add chunked
  upload endpoint", not "Added" or "Adds". Keep the subject line short and
  specific; add a body explaining *why* when the change is non-obvious.
* Keep each pull request focused on one change; do not bundle unrelated edits.
* Mention the checks you ran (`npm run typecheck`, `npm test`, …) in the
  description, and whether you ran `npm run doctor`.
* Reference the issue a change addresses where one exists.

---

## 14. Licensing and contributions

DEXTube is licensed under the **GNU Affero General Public License, version 3.0 or
later** (AGPL-3.0-or-later). The full text is in [`LICENSE`](./LICENSE).

By submitting a contribution (a pull request, patch, or any other form of
change), you agree that it is your own work or is otherwise appropriately
licensed, and you license it to the project and its users under the same
AGPL-3.0-or-later terms (inbound = outbound). No separate Contributor License
Agreement (CLA) is required; this statement — together with the Developer
Certificate of Origin assertion that you have the right to submit the work —
covers it. Do not contribute code you cannot license this way.

Third-party dependencies must be compatible with AGPL-3.0-or-later; call out any
new dependency in your pull request so its license can be reviewed.
