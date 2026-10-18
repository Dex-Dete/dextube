# DEXTube — TODO

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

Last updated: 2026-10-18 (session 4 — DEXTube 2.0, phases 1–9 complete)

## Session 5 follow-up
- [x] Admin import console displays real item progress and exact copied-byte/quota accounting.
- [x] Metadata-only wording distinguishes an expected rights/source limitation from an error.
- [x] Public YouTube media bypass deliberately not implemented; authorized creator exports remain the supported media path.
- [x] Rebuild/restart the local service after the session-5 import-console edit and run the focused browser check.
- [ ] Add admin storage/queue overview panels beyond import accounting.
- [x] Add real admin storage/queue overview panels with persisted counts.
- [x] Add and browser-verify persistent 0.25×–4× playback speed selection.
- [x] Add server-gated admin job diagnostics with real queue state and errors.
- [x] Make caption language fallback honest (`und`) and preserve declared labels.

---

## DEXTube 2.0 mission (current)

An audit-then-rebuild pass in tested milestones. Each phase runs lint,
unit/integration tests and the browser suite before it is considered done.

| Phase | Area | Status |
| --- | --- | --- |
| 1 | Audit the existing implementation | `[x]` |
| 2 | Design system, shareable primitives, per-surface layouts | `[x]` |
| 3 | Professional video player on real media primitives | `[x]` |
| 4 | Recommendations: versioned weights, diversity, feedback | `[x]` |
| 5 | Studio: real aggregates, paginated table, bulk ops, moderation | `[x]` |
| 6 | DEX Music: rights metadata, no fabricated catalogue | `[x]` |
| 7 | Measured performance, indexes, health/readiness, recovery docs | `[x]` |
| 8 | Automated coverage for player / recsys / studio / music / authz / jobs | `[x]` |
| 9 | Documentation and session continuity | `[x]` |

### Phase 2 — design system
- [x] Shared primitives in `src/components/ui/`; 13 duplicated empty states and 3 playlist cards removed
- [x] Distinct layouts per surface (home grid, trending ranked list, subscriptions grouped by channel, results sections)
- [x] `PageHeader` with a real `<h1>` on every top-level page (fixes the home heading order)
- [x] Self-hosted Inter via `next/font` (no request to Google at runtime)
- [x] Route-level `loading.tsx` skeletons and a root `error.tsx`
- [x] Thumbnails lazy-loaded with `decoding="async"`

### Phase 3 — player
- [x] Native `controls` removed; custom accessible control layer over `<video>`
- [x] Quality menu from real `PROGRESSIVE` renditions; hidden below two; manual switching preserves the playhead; never labelled "Auto"
- [x] `scripts/make-renditions.ts` generates genuine scaled renditions and records them as assets
- [x] Speed 0.25×–4× (menu and `,`/`.`), persisted preference, captions when a `CAPTION` asset exists, PiP, fullscreen + orientation lock
- [x] Seek bar with buffered range and time tooltip; volume; auto-hide; keyboard reference; autoplay-next
- [x] Resume with "Start over"; throttled progress writes flushed with `keepalive` on pause and page hide
- [x] Private/unlisted media authorisation unchanged and re-verified
- [x] Fixed: the seek bar was pinned at 0 when metadata loaded before hydration

### Phase 4 — recommendations
- [x] Pure, unit-tested ranking module; `RANKING_VERSION = heuristic-2`
- [x] Documented signals and weights; `RANKING_WEIGHTS` env override with safe fallback
- [x] Anti-inflation: logarithmic saturation of views/likes plus write-time view dedupe
- [x] Structural diversity (3 per channel, 8 per category) and a cold-start path that is not a popularity list
- [x] "Not interested" / "Don't recommend this channel" / "Reset recommendations" (inline undo; history untouched)
- [x] Bounded signal queries; history-derived signals gated on `saveWatchHistory`
- [x] Dev-only diagnostics logging; `rankingVersion` and strategy exposed in the feed response
- [x] Fixed: `category`/`tags`/`language` no longer dropped, so the interest signal actually fires

### Phase 5 — Studio
- [x] Analytics reads the `VideoDailyStat` / `ChannelDailyStat` rollups for history and raw events only for today; one shared helper per path so they cannot drift
- [x] Rollup writes are set-based (`INSERT ... ON CONFLICT`): two statements per day instead of one `upsert` per video
- [x] Top-video lookup is a map, not a `find` inside a loop
- [x] Content table: sorting (published / views / title) with a stable tiebreak, and pagination capped at 50 per page and rejected above it
- [x] Bulk publish / unpublish / soft-delete, ≤100 ids, authorised per id with partial results reported; delete confirmed in the UI
- [x] Retry for a video whose processing failed, through the existing job queue
- [x] Moderation (reported comments) paginated and owner-scoped
- [x] Route-level loading skeletons and error boundaries under `/studio`; `EmptyState` on empty Studio panels
- [x] `tests/integration/studio.test.ts`: rollup path equals the raw path, soft-deleted comments excluded, page size capped

### Phase 6 — DEX Music
- [x] `Track` + separate `TrackRights` (source, licence, attribution, territory, `downloadAllowed`) added as an additive migration
- [x] Downloads gated on the rights metadata and enforced in the one route that serves the bytes; a streaming-only track returns 403 and its page renders no download control at all
- [x] Private tracks are refused to anonymous viewers (404) and the private track never appears in the library
- [x] `/music` library with a real `EmptyState` when nothing is playable; `/music/[id]` shows source, licence, attribution, territory and download permission
- [x] Persistent, keyboard-accessible mini-player: one `<audio>` in the root layout that survives client-side navigation
- [x] `scripts/make-test-audio.ts` synthesises original `sine`/`anoisesrc` fixtures with FFmpeg (no third-party audio); the seed is additive and idempotent
- [x] `tests/unit/music-download.test.ts` (decision logic), `tests/integration/music.test.ts` (real DB enforcement), `tests/e2e/music.spec.ts` (playback, persistence, no download control)
- [x] No fabricated catalogue: three synthetic tones with honest metadata, and no audio upload form pretending to exist

### Phase 7 — performance
- [x] Measured p50/p95 latency for the hot routes in the production build; documented with reproduction commands in `docs/performance.md`
- [x] `GET /api/ready` (9 ms, booleans only) split from the deep `/api/health` (320 ms, spawns FFmpeg)
- [x] `/api/health` no longer discloses the storage root or the advertised URL to anonymous callers
- [x] `tests/integration/performance.test.ts` asserts real statement counts: one `INSERT` per table for a 3-video rollup, dashboard cost independent of video count, bounded feed pages
- [x] Index inventory + query plans documented (including the honest note that a 10-row table is correctly sequentially scanned)
- [x] Recovery documented: backup/restore, retryable failed media, self-healing rollups

### Phase 8 — automated coverage
- [x] Player: 6 browser tests driving the real element (playback, renditions, quality switch, speed, keyboard, resume, single rendition)
- [x] Recommender: 23 unit tests for the scoring rules plus 4 integration tests against the real database (dismissal, hidden channel, reset, idempotency, cold start, deterministic paging)
- [x] Studio: rollup path equals the raw path, soft-deleted comments excluded, page size capped
- [x] Music: download authorisation unit + integration, and a browser test that plays real audio and proves the streaming-only licence offers no download control
- [x] Authz: fail-closed ownership, same-origin enforcement, private media refused to anonymous viewers
- [x] Jobs: scheduler coverage and the statement-count regressions in `performance.test.ts`
- [x] Accessibility/responsive: 5 browser tests over the key pages at 375px and 1280px
- [x] Six real defects found by that audit and fixed (CSS layer, sidebar `h2`, missing section headings, unlabelled avatar links, mobile overflow, skip-link focus)

### Phase 9 — documentation
- [x] `docs/player.md`: the player design, the manual-quality rule and honesty constraint, the resume window, the two hydration bugs, and the recorded `@vidstack/react` evaluation with live evidence and the conditions that would change the decision
- [x] `docs/music.md`: the rights model, the four enforcement points, the synthetic-fixture policy, an operator checklist, and the limitations stated plainly
- [x] `docs/performance.md`: measured latency, statement counts, bundle sizes, index inventory with plans, health vs readiness, recovery
- [x] `README.md` feature table and document links updated (player, recommender feedback, Studio bulk ops, DEX Music)
- [x] `docs/architecture.md`: audio path, single download-authorisation point, health/readiness split
- [x] `PROJECT_STATUS.md`: session-4 log, completed mission status, and the honest remaining backlog
- [x] `CHANGELOG.md`: added/changed/fixed entries for every phase, including each defect found by real tests





---

## Phase 1 — Inspect & scaffold
- [x] Inspect workspace, OS, runtimes, disk, RAM, services
- [x] Record architecture decisions (`PROJECT_STATUS.md` §4)
- [x] Initialise TypeScript/Next.js project + dependencies
- [x] Docker Compose config + Fedora-friendly db scripts

## Phase 2 — Shell, database, health
- [x] Prisma schema (24 models / 11 enums) + 6 migrations
- [x] Search indexes declared in schema **and** created by a migration (pg_trgm / GIN / partial) — D19
- [x] `src/lib/config.ts` — validated env loader
- [x] `src/lib/db.ts`, `logger.ts`, `errors.ts`, `http.ts`
- [x] Design tokens + `globals.css` (dark/light)
- [x] Root layout: header, search, create, notifications, account menu; collapsible sidebar
- [x] `/api/health` endpoint (db, storage writability, ffmpeg, resolved encoder)
- [x] `prisma/seed.ts` — 4 users/channels, 10 videos, 56 comments, 3 377 views, 25 reactions, 12 subscriptions, system playlists, 14 days analytics
- [x] `/` home feed with skeletons, empty state, pagination

## Phase 3 — Auth, accounts, channels
- [x] Argon2id password module + policy validation
- [x] Session module (create/verify/revoke, cookie flags, epoch invalidation)
- [x] Rate limiter (login throttle, per-route buckets)
- [x] `/api/auth/register|login|logout|session`
- [x] Email verification adapter (console/file outbox when SMTP absent)
- [x] Password reset (single-use expiring tokens)
- [x] Account settings page (profile, privacy, password) + account deletion
- [x] Channel service: create, handle uniqueness, edit; public channel page + subscribe
- [~] Avatar/banner upload — `updateChannelAsset` service + storage exist; the Studio page shows current images and **labels upload as unavailable** rather than faking it
- [x] `/channel/[handle]`, `/feed/subscriptions`, `/results`, `/playlists`, `/playlist/[id]`, `/history`, `/notifications`

## Phase 4 — Upload & media pipeline
- [x] `MediaStorage` interface + local adapter (S3 reserved, throws a clear error)
- [x] Upload session service (server-side authorization, quotas, unique keys)
- [x] Chunked/resumable upload endpoints + real progress
- [x] FFprobe metadata extraction
- [x] FFmpeg thumbnail + poster generation (with `ensureParent`)
- [x] Bounded multi-resolution transcode ladder + runtime encoder negotiation (D15)
- [x] Job queue + worker loop + retries/idempotent promotion (D16, D17)
- [x] Processing status surfaced in UI; publish only when READY
- [x] Upload cancellation + abandoned upload cleanup
- [x] Secure media serving with range requests + privacy enforcement

## Phase 5 — Feed, watch, search, comments, subs, playlists
- [x] Home feed (recommendations for anonymous users, personalised when signed in)
- [x] Watch page: player controls, keyboard shortcuts, resume position, view ping
- [x] View recording with dedupe/abuse resistance
- [x] Video reactions (like/dislike)
- [x] Comments: CRUD, one level of replies, likes, sort, pagination, moderation, reports
- [x] Subscriptions + subscriptions feed
- [x] Notifications (in-app, read/unread, dedupe, pagination)
- [x] Search: videos, channels, playlists + filters/sort + `/api/search/suggest`
- [x] Playlists CRUD + ordering + visibility
- [x] Watch later, Liked videos (system playlists, per-channel unique — D18)
- [x] Watch history with clear/remove + continue watching (unique per video — D20)

## Phase 6 — Shorts & Studio
- [x] Shorts feed (9:16, snap/keyboard nav, autoplay, controls, lazy media, infinite cursor paging)
- [x] Shorts classification on upload
- [x] Studio dashboard
- [x] Studio video list + search/filter
- [x] Studio metadata edit / publish / unpublish / delete
- [x] Studio comment moderation + reports
- [~] Studio channel profile — profile editing works; image upload labelled unavailable
- [x] Studio analytics: views over time, watch time, subscriber changes, date range

## Phase 7 — Recommender, notifications, analytics, jobs
- [x] Transparent ranking service with configurable weights
- [x] Cold-start & anonymous baselines; diversity + dedupe
- [x] Watch-history-based signals + exclusion
- [x] Daily aggregation jobs (VideoDailyStat, ChannelDailyStat) + recurring scheduler (D21)
- [x] Notification fan-out with dedupe

## Phase 8 — Security, tests, docs
- [x] Security headers/CSP (`next.config.ts`), verified at runtime
- [x] CSRF protection for cookie-authenticated mutations (same-origin check)
- [x] Input validation coverage across all routes (zod)
- [x] Linting: ESLint CLI + `eslint.config.mjs` (`eslint-config-next`), 0 problems — `next lint` was removed in Next.js 16
- [x] Unit tests: password, session token, validation, recommender, formatting
- [x] Integration tests: account flow, visibility/ownership, history, reactions, shorts, playlists, search, rate limit, scheduler
- [x] Media pipeline exercised end to end (e2e upload → playback → range `206`)
- [x] E2E (Playwright): register → Studio → sign out/in; wrong password; upload → watch → comment
- [x] License, README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG
- [x] `docs/architecture.md`, `docs/database.md`, `docs/deployment.md`, `docs/security.md`, `docs/dependencies.md`, `docs/fedora.md`
- [x] Dependency audit + attribution notes; fork-placeholder checklist

## Phase 9 — Acceptance run
- [x] `npx tsc --noEmit` clean
- [x] `npm run lint` → 0 problems
- [x] `npm test` → 8 files / 61 tests passing (now 15 files / 113 tests)
- [x] `npm run test:e2e` → 3 tests passing, twice back-to-back (repeatable; now 16 browser tests)
- [x] Fresh-machine documented startup (database up → migrate deploy → seed → dev)
- [x] All §19 acceptance steps executed and recorded in `PROJECT_STATUS.md`
- [x] Production build (`npm run build`) + `npm start` smoke test; e2e re-run against the production build

---

## Remaining (release polish)

- [ ] Optional: implement avatar/banner upload in Studio (route + service wiring; service already exists).
- [ ] Optional: HLS packaging behind `ENABLE_HLS` (currently off for RAM reasons).
- [ ] Optional: S3 storage adapter behind `STORAGE_DRIVER=s3` (currently a documented hard error).
- [ ] Optional: multi-factor authentication (documented gap in `SECURITY.md`).
- [ ] Optional visual pass over `/channel/ada`, `/results?q=algorithm`, `/playlists`, `/playlist/watch-later`, `/notifications`, `/settings`, `/trending`, `/feed/subscriptions`, `/studio` (all already return `200`).
- [ ] Replace fork placeholders once a real repository/domain exists — see README “Publishing your own instance or fork”.
- [ ] Track the ESLint toolchain's transitive advisories (`npm audit`) and revisit on the next release.
- [x] `git init` + first commit; repository published at `github.com/Dex-Dete/dextube`.
