# DEXTube — Project Status

> **Read this file first when resuming work.** It records the architecture, decisions,
> completed work, exact test results, known bugs, and the exact next action.
> Companion file: [`TODO.md`](./TODO.md).

_Last updated: 2026-10-18 (session 3)_

---

## 1. What DEXTube is

DEXTube is an original, open-source, self-hostable video-sharing platform with a
familiar video-platform interaction model (collapsible sidebar, top search,
video cards, watch pages, comments, subscriptions, vertical Shorts, creator
studio). All branding, icons, artwork and source code are original. No YouTube
proprietary code, assets or trademarks are used.

License: **AGPL-3.0-or-later**.

---

## 2. Reference environment (verified)

The values below are what the project was developed and tested against. They are
recorded so a failure can be reproduced, not because they are required: DEXTube
targets Fedora Linux first and stays portable.

| Item | Value |
| --- | --- |
| OS | Fedora Linux 44 (Workstation) |
| Kernel platform | linux x86_64 |
| Node.js | v22.23.1 |
| npm | 10.9.8 |
| FFmpeg / FFprobe | 8.1.3 — **`ffmpeg-free` build: `libx264` is absent** (see D15) |
| Available H.264 encoders | the software fallback is what a stock install offers; hardware encoders are used only when the machine actually has one (see D15) |
| Docker | 29.7.2 (daemon running, rootless-capable) |
| Podman | 5.8.7 |
| PostgreSQL | 16.15 via `postgres:16-alpine` container (host port **5433**) |
| Redis | not installed natively; optional profile in `docker-compose.yml` |
| Resources | modest single-machine development box; the defaults in `.env.example` are chosen to fit it |

**Important environment fact:** the `docker compose` *plugin* may be absent (only
the `docker` CLI present). `scripts/db-up.sh` therefore falls back to plain
`docker run`. `docker-compose.yml` is still provided for machines that have the
plugin.

**Important environment fact (2):** Fedora's default `ffmpeg-free` package is
built **without** `libx264`. Hardcoding `-c:v libx264` fails on a stock Fedora
install with `Unknown encoder 'libx264'`. DEXTube therefore *negotiates* an H.264
encoder at runtime (see D15) instead of assuming one. `npm run doctor` reports
which one was chosen.

---

## 3. Architecture

```
┌──────────────────────────── DEXTube ─────────────────────────────┐
│                                                                  │
│  Next.js 16 (App Router, RSC) + React 19 + TypeScript            │
│    ├── src/app/**            pages & route handlers (API)        │
│    ├── src/components/**     UI component system                 │
│    └── src/lib/**            client-safe shared utilities        │
│                                                                  │
│  Domain / service layer  →  src/server/**                        │
│    ├── services/*            auth, channel, video, comment, ...   │
│    ├── storage/*             MediaStorage adapter (local | s3)    │
│    ├── media/*               FFmpeg / FFprobe wrappers           │
│    ├── jobs/*                DB-backed queue + handlers          │
│    └── recsys/*              transparent ranking service         │
│                                                                  │
│  Persistence: PostgreSQL via Prisma 6 (versioned migrations)     │
│  Delivery:    HTTP range requests (local) / HLS (optional)       │
└──────────────────────────────────────────────────────────────────┘
```

**Modular monolith + separate worker.** The web app can run jobs inline
(`JOB_RUNNER=inline`, the development default) or delegate to
`npm run worker` (`JOB_RUNNER=external`, the production recommendation).

### Size at a glance

| Area | Count |
| --- | --- |
| Prisma models / enums | 24 / 11 |
| Applied migrations | 6 |
| App Router pages (`page.tsx`) | 24 |
| API route handlers (`route.ts`) | 48 |
| React components | 16 files (`feed`, `forms`, `shell`, `shorts`, `video`, `watch` groups) |
| Server modules | 25 files (11 services, 4 jobs, 4 media, storage, recsys, auth, …) |
| Vitest files / tests | 8 / 61 |
| Playwright specs / tests | 2 / 3 |
| ESLint | `eslint.config.mjs` (flat config, `eslint-config-next`) — `npm run lint` is clean |

### Boundaries

* `src/lib/**` — must stay importable from both client and server. No Prisma,
  no `fs`, no Node builtins that break bundling.
* `src/server/**` — server-only. Prisma access lives here and in `src/lib/db.ts`.
* Route handlers are thin: parse → validate (zod) → authorize → call service →
  shape response. No business logic in `route.ts` files.
* Every privacy/ownership rule is enforced in the **service** layer so a route
  handler can never accidentally bypass it.

### Storage keys

All media is addressed by opaque, server-generated keys such as
`videos/<videoId>/source/original.mp4` and `videos/<videoId>/thumbs/0.jpg`.
Client-supplied paths are never joined into filesystem paths.

---

## 4. Key decisions (and why)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Next.js 16 App Router full-stack (no separate backend service) | One deployable, one language, RSC for fast feeds; a "modular monolith" is explicitly acceptable in the spec |
| D2 | Prisma 6.x + PostgreSQL 16 | Versioned SQL migrations, typed client, spec-mandated DB |
| D3 | Argon2id via `@node-rs/argon2` | Modern password hashing; prebuilt binary, no compiler needed (verified working) |
| D4 | Opaque session tokens in httpOnly cookies, SHA-256 hashed at rest, `sessionEpoch` for global invalidation | Avoids JWT revocation problems; DB row per session enables device listing |
| D5 | DB-backed job queue (`jobs` table) instead of Redis | Redis is not installed and the spec allows Redis to be *optional*; correctness is preserved and the queue is swappable |
| D6 | Local filesystem media adapter behind a `MediaStorage` interface | S3 adapter can be added without touching services |
| D7 | `pg_trgm` GIN indexes for search | Fast `ILIKE '%term%'` without a separate search engine |
| D8 | Denormalised counters maintained in transactions | Feed/aggregate queries stay index-only |
| D9 | Transparent weighted-heuristic recommender (no ML claims) | Spec forbids claiming ML for heuristics; weights are config-driven |
| D10 | Tailwind CSS v4 with DEXTube design tokens in CSS variables | Fast, responsive, original visual identity, dark/light theming |
| D11 | Plain `docker run` fallback when the compose plugin is absent | Verified environment reality |
| D12 | Anonymous view dedupe via salted rotating hash of (ip + UA + day) | Abuse resistance without storing raw IPs |
| D13 | `PROCESSING_CONCURRENCY=1` default | 7.6 GiB RAM laptop must not start many FFmpeg jobs |
| D14 | Playlists are owned by a **channel** (not a user) | Matches how a creator's library works and keeps ownership checks single-sourced |
| D15 | Runtime **H.264 encoder negotiation** (`libx264` → `h264_nvenc` → `h264_vaapi` → `libopenh264`), overridable with `VIDEO_ENCODER` | Fedora's `ffmpeg-free` has no `libx264`; a hardcoded encoder breaks every stock-Fedora install. Detection is memoised and reported by `/api/health` and `npm run doctor` |
| D16 | `JOB_RUNNER=inline` keeps a 5 s unref'd heartbeat plus self-scheduling retry timers | Without polling, a job scheduled with backoff would stall forever until unrelated traffic arrived |
| D17 | Failed media processing keeps the creator's chosen visibility and is retried idempotently | A transient FFmpeg failure must not silently unpublish; FAILED videos are excluded from public listings by `status = READY`, so it is still safe |
| D18 | System playlists (`watch_later`, `liked_videos`) are unique **per channel** (`@@unique([channelId, systemKind])`) | A user has exactly one channel, so per-channel uniqueness gives per-user semantics while keeping `Playlist` owned by a channel; the route/service layer hides them from ordinary CRUD |
| D19 | Search/dedupe indexes are declared in `schema.prisma` (`type: Gin`, `gin_trgm_ops`, explicit `map:` names), not only as raw SQL | `prisma migrate dev` regenerates indexes from the schema and silently **drops** anything that exists only in raw SQL. Declaring them stops that class of data-loss bug |
| D20 | `WatchHistory` has `@@unique([userId, videoId])`; a rewatch updates `watchedAt` in place | History is a set of "last watched at" rows, not an append-only log. Without the unique index a rewatch created duplicate rows and broke continue-watching ordering |
| D21 | Recurring jobs are scheduled by the job runner (`src/server/jobs/scheduler.ts`): today's `analytics.aggregate` in a 15-minute bucket, yesterday's finalisation within 2 h of midnight, and a daily `maintenance.prune` | Aggregates must be produced without depending on user traffic; the bucket key makes enqueueing idempotent, so multiple runners cannot double-schedule |
| D22 | Vitest resolves `@/` via a regex alias and shims `server-only`/`client-only` to `tests/shims/empty.ts`; integration specs run serially (`fileParallelism: false`) | `src/server/**` imports `server-only`, which is not resolvable outside a Next build; a shim avoids fighting `resolve.conditions`. Serial integration runs stop concurrent fixture users from colliding on shared counters |
| D23 | Linting is the **ESLint CLI** (`eslint .` + `eslint.config.mjs`), *not* `next lint` | Next.js 16 removed `next lint`; the old script silently became a broken command (`next lint` treated `lint` as a directory). `eslint-config-next` is still the rule source. `@next/next/no-img-element` is disabled by decision: every image is served through the authorization-checked `/api/media/*` route, so `next/image`'s optimizer would bypass per-request media authorization |
| D24 | Metadata is produced by `generateMetadata()` so `metadataBase` is the configured `APP_URL` | With a static `metadata` object Next.js guesses the origin from the request and logs a warning; behind a reverse proxy that also makes relative Open Graph/icon URLs wrong |
| D25 | The Playwright suite clears rate-limit buckets and stale `e2e_` accounts in `tests/e2e/global-setup.ts` | Registration is capped at 5/hour/IP. Without the reset a second `npm run test:e2e` on the same machine fails with "Too many requests" — a test artefact, not a product bug. Cleanup also makes an interrupted run recoverable |
| D26 | Components that must resynchronise with new server props (feed pages, the Studio editor, the mobile drawer, the search box) adjust state **during render** instead of in an effect; the two genuinely mount-only reads (`localStorage` sidebar preference, `data-theme`) keep a suppressed, commented effect | React's documented alternative to a syncing effect — no extra commit, and the `react-hooks/set-state-in-effect` rule from the React Compiler rule-set is satisfied rather than silenced everywhere |

---

## 5. Feature status

Legend: ✅ done & runtime-verified · 🟡 partial (honest label in UI) · ⏳ not started

| Area | Status | Notes |
| --- | --- | --- |
| Workspace inspection & decisions | ✅ | this document |
| Package/toolchain setup | ✅ | Next 16.4.2, React 19.3.1, TS 5.9.3, Prisma 6.19.3, Tailwind 4.3.3, Vitest 3.2.7, Playwright 1.64.1 |
| Docker Compose + db scripts | ✅ | `scripts/db-up.sh`, `db-down.sh`, plus `install/start/stop/backup/restore` |
| Database schema + migrations | ✅ | **24 models / 11 enums**, 6 migrations applied (`init`, `search_indexes`, `rate_limit_buckets`, `system_playlist_per_channel`, `restore_search_indexes`, `watch_history_unique`); `prisma validate` clean |
| Search indexes (pg_trgm, GIN, partial) | ✅ | declared in schema (D19) and verified present in `pg_indexes` |
| Dev seed data | ✅ | `npm run db:seed` → 4 users/channels, 10 videos, 56 comments, 3 377 views, 25 reactions, 12 subscriptions, per-user system playlists, 14 days of analytics |
| UI shell (header, sidebar, theming) | ✅ | `Shell`/`Header`/`Sidebar`/`ThemeScript`, original icon set, dark/light tokens |
| Auth (register/login/session/verify/reset) | ✅ | Argon2id, hashed opaque sessions, epoch invalidation, file-outbox email |
| Account settings page | ✅ | `/settings` (profile, privacy, password) hits real endpoints |
| Channel public page + subscribe control | ✅ | `/channel/[handle]` with videos, playlists, subscribe |
| Avatar/banner upload | 🟡 | service (`updateChannelAsset`) + storage exist; Studio shows the current images and **labels upload as not yet available** rather than faking it |
| Upload + FFmpeg pipeline | ✅ | verified end-to-end: initiate → chunk → complete → process → READY, thumbnails, poster, rendition ladder |
| Watch page + player + views | ✅ | `/watch/[id]`: keyboard shortcuts, resume position, view ping with dedupe |
| Comments / reactions | ✅ | CRUD, one level of replies, likes, sort, pagination, soft-delete, moderation, reports; like/dislike reactions |
| Subscriptions / notifications | ✅ | `/feed/subscriptions`, `/notifications` (read/unread, dedupe, pagination) |
| Playlists / history / watch-later | ✅ | `/playlists`, `/playlist/[id]`, `/history` (clear + remove), system playlists, continue watching |
| Search | ✅ | `/results` with type filters + sort, `/api/search/suggest` |
| Recommendations | ✅ | `/api/feed` ranked by the transparent `recsys` heuristic; history signals + exclusion wired |
| Shorts | ✅ | `/shorts` 9:16 snap feed (autoplay, mute, keyboard nav, infinite cursor paging), `/shorts/[id]` deep link, upload classification |
| DEXTube Studio | ✅ | dashboard, video list + filter, per-video edit/publish/unpublish, comment moderation, analytics (views/watch time/subscribers over range), channel profile |
| Analytics aggregation | ✅ | `VideoDailyStat`/`ChannelDailyStat` via scheduled `analytics.aggregate` (D21); Studio reads real rows, never fabricated |
| Security hardening | ✅ | CSP + security headers, same-origin CSRF, per-request media authz, DB-backed rate limits, zod everywhere |
| Linting | ✅ | `npm run lint` (ESLint CLI + `eslint.config.mjs`), zero problems (D23) |
| Tests (unit/integration/e2e) | ✅ | **61 Vitest tests** (8 files) + **3 Playwright tests** (2 specs), all passing, repeatable |
| OSS docs | ✅ | README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, LICENSE, `.env.example`, `docs/{architecture,database,deployment,security,dependencies,fedora}.md` |

### Known gaps (surfaced in the UI, not hidden)

* Avatar/banner **upload** is not built; the Studio channel page says so.
* HLS is off by default; playback is progressive MP4 + range requests.
* `STORAGE_DRIVER=s3` throws a clear, documented error instead of faking remote storage.
* Without SMTP, mail lands in `storage/mail-outbox/*.eml`.

---

## 6. Exact commands

```bash
# start the database (docker, fallback-safe)
bash scripts/db-up.sh

# apply migrations
npx prisma migrate deploy      # scripted / production-style (non-interactive)
npx prisma migrate dev         # development (may prompt y/N)

# regenerate the Prisma client after editing schema.prisma
npx prisma generate

# seed development data
npm run db:seed

# run the app
npm run dev                    # http://localhost:3000
npm run build && npm start     # production build

# background worker (only when JOB_RUNNER=external)
npm run worker

# tests / checks
npm test                       # vitest: unit + integration (needs the DB)
npm run test:e2e               # playwright (needs a dev server)
npx playwright install chromium  # one-time browser download
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint . (flat config)
npm run doctor                 # machine preflight

# stop services (data preserved)
bash scripts/db-down.sh
```

### Verified test results (session 3)

```
npx tsc --noEmit        → clean, no output
npm run lint            → 0 problems (0 errors, 0 warnings)
npm test                → Test Files 8 passed (8) · Tests 61 passed (61) · ~34 s
npm run build           → ✓ Compiled successfully; TypeScript clean; 7 static pages;
                          no warnings or errors in the build log
npm start + /api/health → 200 in ~1.4 s
npm run test:e2e        → 3 passed (~52 s), run twice back-to-back against the
                          *production build* to prove repeatability
                          ✓ registers, reaches Studio, signs out and signs back in
                          ✓ rejects a wrong password without revealing whether the account exists
                          ✓ uploads a video, plays it and posts a comment
                          [e2e setup] cleared 6 rate-limit bucket(s)
                          [e2e teardown] removed 2 test account(s)
```

Production smoke test (all `200`, anonymous): `/`, `/trending`, `/results?q=…`,
`/shorts`, `/shorts/<id>`, `/playlists`, `/history` (sign-in redirect), `/notifications`,
`/settings`, `/feed/subscriptions`, `/channel/ada`, `/watch/<id>`,
`/playlist/watch-later`, `/studio` (sign-in redirect), plus `/nope` → `404`.
Authenticated (session cookie): `/studio`, `/studio/videos`, `/studio/analytics`,
`/studio/channel`, `/history`, `/api/studio/videos`, `/api/studio/analytics`,
`/api/history`, `/api/notifications` all `200`. Unauthenticated APIs correctly
`401` (`/api/studio/*`, `/api/history`, `/api/notifications`, `/api/playlists`).

---

## 7. Known issues / limitations (current)

1. `docker compose` plugin missing on this machine → use `scripts/db-up.sh`
   (falls back to `docker run`).
2. Prisma prints a deprecation warning for `package.json#prisma`; harmless on
   Prisma 6, will move to `prisma.config.ts` before a Prisma 7 upgrade.
3. Redis is not installed; the job queue is DB-backed. Redis remains an optional
   compose profile for future use.
4. `prisma migrate dev` can hang on a `y/N` prompt in a non-interactive shell;
   prefer `prisma migrate deploy` for scripted runs. It also regenerates schema
   indexes, which is why every index must be declared in `schema.prisma` (D19).
5. HLS packaging is disabled by default (`ENABLE_HLS=false`) due to RAM limits;
   progressive + multi-resolution MP4 is the default delivery path.
6. **Stock Fedora has no `libx264`.** DEXTube auto-selects `libopenh264`
   (software) instead. OpenH264 is bitrate-driven (no CRF) and somewhat slower
   than x264; installing RPM Fusion's `ffmpeg` switches DEXTube to `libx264`
   automatically. This is detected, never assumed.
7. `h264_vaapi` is skipped on this machine: the render node exists but
   `iHD_drv_video.so` fails to initialise, so hardware encoding is unavailable.
8. **Streamed `notFound()`/`redirect()` return HTTP 200.** Next.js streams the
   document before the route resolves, so unknown dynamic routes render the 404
   *UI* with `noindex` instead of returning a 404 status. Static unknown routes
   do return a genuine 404. Documented Next.js behaviour, surfaced honestly.
9. Avatar/banner upload is not implemented (see §5 gaps).
10. Placeholder contacts (`security@`, `conduct@` at `dextube.invalid`, the
    CHANGELOG compare URL, `SMTP_FROM`) are deliberately non-routable; the README
    section “Publishing your own instance or fork” lists exactly what to replace.
11. `npm run lint` still reports **zero** problems, but the ESLint build is
    fresh: the rules that surfaced during setup were fixed (D23–D26), not
    disabled wholesale. Two `react-hooks/set-state-in-effect` suppressions remain,
    each with a comment, for the genuinely mount-only `localStorage`/`data-theme`
    reads.
12. `npm install` reports 11 advisories (1 moderate, 8 high, 2 critical) from the
    ESLint toolchain's transitive dependencies. They are **development-only**
    (never bundled into the app or shipped to a server) and have not been
    force-upgraded, since `npm audit fix --force` would break the pinned
    `eslint-config-next` version. Track upstream; re-audit on the next release.

---

## 8. Session log

### Session 1 — 2026-10-17
* Inspected workspace (`<repo root>`, empty, not a git repo) and
  the surrounding `~/Documents` tree; found unrelated user projects (`apps`,
  `osu`, `Terraria`, `myst` docker container) — **left untouched**.
* Verified Fedora 44, Node 22.23.1, FFmpeg 8.1.3, Docker 29.7.2, 65 GB free,
  ~1.5 GiB RAM available.
* Scaffolded the project, installed dependencies (141 packages), verified
  Argon2id hashing works.
* Authored `prisma/schema.prisma` (24 models, 11 enums), created and applied
  the `init` migration, then added a raw-SQL `search_indexes` migration
  (`pg_trgm`, GIN, partial indexes) and verified the indexes exist.
* Started PostgreSQL 16 in Docker on 127.0.0.1:5433.
* Wrote `.env` (generated secret + DB password), `.env.example`, `.gitignore`,
  `docker-compose.yml`, `scripts/db-up.sh`, `scripts/db-down.sh`, and this file.

### Session 2 — 2026-10-17
* **Discovered the encoder problem:** Fedora's `ffmpeg-free` has no `libx264`.
  Added `src/server/media/encoders.ts` (runtime negotiation, memoised, result
  reported by `/api/health`) and split the process runner into
  `src/server/media/exec.ts` to avoid an import cycle.
* Added `npm run doctor` (`scripts/doctor.ts`): 7 pass, 2 warn (SMTP, HLS),
  0 fail.
* Fixed three real defects found by running the pipeline:
  1. FFmpeg will not create output directories → `ensureParent()` in every
     helper (thumbnail generation was failing with a confusing `-2`).
  2. A retried `media.process` job failed because the staging file had already
     been promoted → promotion is now idempotent.
  3. A failed job lost the creator's chosen visibility and inline mode never
     re-ran backoff-scheduled jobs → both fixed (D16, D17).
* Verified end to end with `curl`: upload → chunk → complete → poll → `READY`;
  range request → `206` with `content-range: bytes 0-1023/127512`; unknown or
  private media for anonymous users → `404` (no existence leak).
* Built the feed, watch, comments, subscriptions, playlists, search, Shorts and
  Studio layers.

### Session 3 — 2026-10-18
* **Fixed a real bug in `src/lib/format.ts`:** `formatRelativeTime` reported
  "72 hours ago" and never rolled up to days/years. Now unit-asserted
  (`"3 days ago"`, `"1 year ago"`).
* Fixed two pre-existing type errors:
  `src/app/channel/[handle]/page.tsx` imported `listPublicPlaylists` from the
  wrong module, and `src/app/trending/page.tsx` read `user.channel` off a
  possibly-null session. `tsc --noEmit` is clean.
* **Watch history correctness (D20):** added `@@unique([userId, videoId])` on
  `WatchHistory` via migration `20261017190000_watch_history_unique` (with a
  defensive de-duplication step for existing rows). `recordView` now writes or
  refreshes history for signed-in viewers when `saveWatchHistory` is enabled.
* **Recurring jobs (D21):** added `src/server/jobs/scheduler.ts` and wired
  `ensureRecurringJobs()` into both the inline heartbeat and the worker loop.
  `ensureTodayAggregated` uses the same 15-minute bucket key, so enqueueing is
  idempotent.
* **Index durability (D19):** re-declared the trigger/GIN index set in
  `schema.prisma` and recreated them with the `restore_search_indexes`
  migration, so `prisma migrate dev` can no longer drop them.
* **Shorts** (`src/components/shorts/ShortsFeed.tsx`, `/shorts`,
  `/shorts/[id]`): snap paging, IntersectionObserver autoplay, mute, optimistic
  like/dislike, subscribe, share, comments link, 3 s view ping, keyboard nav,
  cursor-based infinite load. Runtime-verified against the real server.
* **Test suite stood up (D22):** `vitest.config.ts` + `tests/setup.ts` +
  `tests/shims/empty.ts`; 61 tests across `tests/unit/*` and
  `tests/integration/*` (account flow, visibility/ownership, history, reactions,
  shorts, playlists, search, rate limiting, scheduler).
* **Playwright e2e stood up:** `playwright.config.ts` (starts `npm run dev`,
  reuses a running server, global teardown removes `e2e_` accounts),
  `auth.spec.ts`, `upload-watch.spec.ts` (real upload → processing → playback
  with a verified `206` range response → comment → Studio listing).
* Updated README/CONTRIBUTING for the testing story, the migration/index rule,
  the honest “intentionally incomplete” list, and a fork-publishing checklist
  for the placeholder contacts.

### Session 3 (continued) — 2026-10-18
* **Found and fixed a broken build tool.** `npm run lint` ran `next lint`, which
  Next.js 16 removed: the command failed with
  `Invalid project directory provided, no such directory: …/lint`. Replaced it
  with the ESLint CLI (`eslint .`) plus a flat `eslint.config.mjs` using
  `eslint-config-next` — the upstream-recommended setup (D23).
* **The new linter found real defects, not just style:** 12 errors and 26
  warnings. Fixes (D26):
  * `VideoPlayer`'s keyboard handler called `toggleFullscreen()` before its
    declaration, so the handler permanently closed over the first render's
    copy; it is now a memoised callback listed in the effect dependencies.
  * `Header`'s search box, its suggestions list and its notification badge
    synchronised state through effects (an extra render each, and a stale
    `suggestions` window). They now derive, or adjust state during render.
  * `FeedGrid` and the Studio `VideoEditor` reset from server props in an
    effect; both now use React's documented render-phase adjustment, so a
    `router.refresh()` no longer costs an extra commit.
  * `VerifyEmailPanel` set an error from an effect for a fact it could derive
    during render.
  * `ShortsFeed`'s infinite-load effect updated state synchronously; the fetch is
    now deferred a task.
  * The search input gained `role="combobox"` (it advertised `aria-expanded` on
    a plain textbox); ~10 unused imports/variables/props and one stale
    `eslint-disable` were removed.
* **Fixed a real metadata defect:** the root layout used a static `metadata`
  object, so Next.js guessed the origin and logged
  `metadataBase property … is not set` at runtime. It now uses
  `generateMetadata()` with `metadataBase = APP_URL` (D24) — relative Open Graph
  and icon URLs are correct behind a reverse proxy.
* **Made the e2e suite repeatable.** Back-to-back runs failed on registration
  because the rate limiter caps registration at 5/hour/IP; the second run was
  throttled by the first. Added `tests/e2e/global-setup.ts` (clears rate-limit
  buckets, removes stale `e2e_` accounts) (D25) and fixed a genuine test race:
  the comment assertion was made against the optimistic UI, then reloaded before
  the INSERT committed. The spec now confirms persistence through the comments
  API before reloading. Two consecutive runs pass.
* **Production acceptance run:** `npm run build` succeeds with no warnings,
  `npm start` serves, every page/API smoke-tested (§6), and the full Playwright
  suite passes **against the production build**.
* Tidied up after manual probing: removed a probe comment and resynchronised
  the denormalised `video.commentCount` it had touched.
* **Fixed `npx prisma db seed`:** Prisma spawns the configured seed command
  without a shell, so `NODE_OPTIONS=--conditions=react-server tsx …` could never
  run. Both `npm run db:seed` and Prisma's runner now call `scripts/seed.sh`.

---

## 9. Next action (resume here)

**DEXTube 2.0 mission is in progress.** Phases 2–4 are complete and verified;
phases 5–9 remain. See §11 for the phase-by-phase record.

---

## 10. Deployment snapshot (2026-10-18)

* **Committed**: `8836506` — initial commit, 205 files. `PROJECT_STATUS.md`,
  `PROJECT_STATUS.md` and `TODO.md` are now **tracked** (they are the project's
  session-continuity record and the mission requires them in the repository);
  the generated `AGENTS.md` is still ignored, and `.env`, `storage/` and `.next/`
  were never tracked.
* **Decision D27 — session cookie policy follows `APP_URL`, not `NODE_ENV`.**
  The previous rule (`Secure` + `__Host-` whenever `NODE_ENV=production`) made
  login silently fail on a plain-HTTP LAN origin: browsers discard `Secure`
  cookies received over HTTP. `src/lib/session-cookie.ts` now derives both from
  `APP_URL`; `SESSION_COOKIE_SECURE=auto|true|false` overrides.
  Verified by unit test and by logging in over `http://<lan-ip>:3000`.
* **Fixed scheduler log spam**: `enqueue()` pre-checks the `dedupeKey` before
  inserting, so the 15-second scheduler tick no longer raises (and Prisma no
  longer logs) a P2002 for every already-scheduled bucket.
* **Runtime**: `systemctl --user` unit at
  `~/.config/systemd/user/dextube.service`, `next start -H 0.0.0.0 -p 3000`,
  `NODE_ENV=production`, `APP_URL=http://<lan-ip>:3000`.
  Reachable at `http://localhost:3000` and `http://<lan-ip>:3000`.
* **Firewall**: no change needed — the FedoraWorkstation zone already carries
  `1025-65535/tcp`, so `firewall-cmd --query-port=3000/tcp` returns `yes`.
* **Still pending**: boot persistence needs `sudo loginctl enable-linger <user>`
  (or the system units in `docs/fedora.md`), because `Linger=no` limits the user
  service to the logged-in session. Enabling it requires an interactive sudo
  password, so it is left to the operator; the unit itself is installed and
  starts on login.

---

## 11. DEXTube 2.0 (mission log)

The mission is an audit-then-rebuild pass over nine areas, each landing as a
tested milestone. Phases 2–4 are done; the rest are pending.

### Status

| Phase | Area | Status |
| --- | --- | --- |
| 1 | Audit of the existing implementation | ✅ done |
| 2 | Design system and per-surface layouts | ✅ done |
| 3 | Professional video player | ✅ done |
| 4 | Recommendations | ✅ done |
| 5 | Studio (analytics, content table, bulk ops, moderation) | ⬜ pending |
| 6 | DEX Music (rights metadata, no fabricated catalogue) | ⬜ pending |
| 7 | Measured performance, indexes, health/readiness | ⬜ pending |
| 8 | Automated coverage (unit + integration + browser) | 🟡 partially done (player and recommender covered) |
| 9 | Documentation and session continuity | 🟡 this file, `TODO.md`, `CHANGELOG.md` |

### Phase 3 — the player

The native `controls` attribute is gone; the control bar is a custom layer over a
plain `<video>`. Verified in a real browser, on real files:

* **Quality** comes from the video's stored `PROGRESSIVE` renditions, ordered
  tallest-first, and the menu only appears when there are at least two. A video
  with a single rendition says “Single rendition” and offers nothing to click.
  Nothing is hard-coded and nothing is labelled “Auto”, because DEXTube does not
  do adaptive bitrate — switching is manual and preserves the playhead.
* **Speed** 0.25×–2× from the menu and via `,`/`.`.
* **Captions** appear only when a `CAPTION` asset exists.
* **Keyboard**: space/k, j/l, ←/→, ↑/↓, m, f, c, 0–9, with an on-screen
  reference.
* **Seek** bar with buffered range and a time tooltip; **volume**; **fullscreen**
  (plus best-effort orientation lock); **picture-in-picture** when supported.
* **Resume** with a “Start over” escape hatch, in a window that scales with the
  video so short clips behave sensibly.
* **Progress writes** are throttled (10 s, skipped when the position barely
  moved) and flushed with `keepalive` on pause and on page hide.

**Bug found by the browser tests and fixed.** The `<video>` is server-rendered
with its source, so on a fast connection the browser finishes loading metadata
*before* React hydrates and attaches listeners. `loadedmetadata` had already
fired, so the duration stayed `0` forever: the seek bar was pinned at `max=0`,
the total time read `0:00`, and seeking was impossible. The effect now reads the
element's current `readyState` and applies what it already knows. This is exactly
the class of bug that only a real browser catches.

### Phase 4 — recommendations

`heuristic-2` — a weighted linear combination, and it says so. No ML claims.

| Signal | Weight | Source |
| --- | --- | --- |
| recency | 1.0 | `publishedAt`, 14-day half-life |
| engagement | 0.85 | saturated views + likes, plus a like-ratio tiebreak |
| subscription | 0.6 | `Subscription` |
| interest | 0.4 | declared interests + recently watched categories/tags |
| completion | 0.5 | mean completion ratio per topic (`WatchProgress`) |
| likedChannel | 0.45 | positive `VideoReaction` history |
| language | 0.2 | the viewer's three most-watched languages |
| alreadyWatched | −0.6 | `WatchHistory` |

* Weights are overridable at runtime with the `RANKING_WEIGHTS` JSON env var.
  Unknown or non-numeric keys are ignored and logged, never fatal.
* **Anti-inflation**: view and like counts pass through a logarithm with a cap
  (`VIEWS_CAP 7`, `LIKES_CAP 5`, `LIKE_RATIO_CAP 0.15`), so a hundredfold view
  count is worth less than 0.15 of one weight. Views are also deduplicated at
  write time per viewer and window.
* **Diversity** is structural: at most 3 videos per channel and 8 per category,
  applied greedily so the strongest items stay at the top. A `topUp` flag lets
  the feed fill a page from capped items without ever shortening it.
* **The viewer's own choices win.** “Not interested” and “Don't recommend this
  channel” are checked before scoring, outrank every boost, and both are
  reversible inline. “Reset recommendations” clears them without touching watch
  history.
* **Cold start** for anonymous visitors and new accounts blends freshness with a
  minority share of popularity, and applies the same diversity caps — it is
  demonstrably not “the most-viewed list”.
* **Privacy**: history-derived signals (watched set, completion affinity,
  inferred languages) are read only when `saveWatchHistory` is enabled.
  Subscriptions, declared interests, likes and explicit dismissals always apply.
* **Bounded cost**: every signal query has a hard `take`, and the candidate pool
  is capped, so feed latency does not grow with account age.

**Bug found by the rewrite.** `toCard()` in `src/server/services/videos.ts`
dropped `category`, `tags` and `language`, so `interestTokens()` always returned
`[]` for real feed items and the interest signal contributed nothing. The feed
now carries those fields through to the ranker.

### Test evidence (current)

| Suite | Result |
| --- | --- |
| `npm run lint` (ESLint CLI over the whole tree) | clean |
| `npm test` (unit + integration) | 10 files, 89 tests passing |
| `npx playwright test` (real Chromium against the production build) | 9 tests passing, three consecutive clean runs |
| `npm run build` | compiles; the client bundle is unchanged in size by the player work |

The value judgement on attention, framing and classification applies to the whole
mission: no mockups, no placeholder controls, no invented data. Where a feature
does not apply (skip-intro, thumbnail sprites, adaptive bitrate) it is absent and
documented rather than faked.
