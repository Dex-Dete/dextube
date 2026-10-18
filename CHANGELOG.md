# Changelog

All notable changes to DEXTube are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The current version is **0.1.0**. DEXTube is pre-1.0: the database schema and
internal interfaces may still change between releases.

## [Unreleased]

### Added

- Initial project scaffold: a Next.js 16 (App Router) + React 19 + TypeScript
  modular monolith targeting Fedora Linux first while remaining portable.
- Prisma schema (24 models and 11 enums) applied as six versioned migrations:
  `init`, `search_indexes`, `rate_limit_buckets`, `system_playlist_per_channel`,
  `restore_search_indexes`, and `watch_history_unique`.
- Search indexes: the `pg_trgm` extension with GIN indexes plus partial indexes
  for common lookups.
- Authentication: Argon2id password hashing, opaque session tokens stored
  SHA-256-hashed with `sessionEpoch` global invalidation, email verification, and
  password reset with single-use expiring tokens, plus account settings and
  account deletion.
- Channel creation with collision-free unique handle allocation, public channel
  pages, subscription controls, and per-channel system playlists.
- Chunked, resumable uploads (5 MiB chunks with explicit byte offsets) with
  server-side upload-session authorisation and quotas.
- FFmpeg media pipeline: FFprobe metadata extraction, thumbnail and poster
  generation, a bounded multi-resolution transcode ladder, and **runtime H.264
  encoder negotiation** (`libx264` → `h264_nvenc` → `h264_vaapi` →
  `libopenh264`) overridable with `VIDEO_ENCODER`.
- Database-backed job queue (`jobs` table using `FOR UPDATE SKIP LOCKED`) with
  retries, runnable inline in the web process (`JOB_RUNNER=inline`) or in a
  separate worker (`JOB_RUNNER=external` via `npm run worker`) — no Redis
  required. A scheduler enqueues recurring aggregation and maintenance jobs.
- HTTP range-request media delivery with per-request authorisation; private or
  non-existent media returns `404` to unauthorised users so existence is not
  leaked.
- Watch page with a keyboard-driven player, resume position, deduplicated view
  recording, like/dislike reactions, a full comment system (replies, likes,
  sorting, pagination, moderation and reports), subscriptions, and an
  in-app notification centre.
- Library features: playlists, watch later, liked videos, watch history with
  continue-watching, and a subscriptions feed.
- Search across videos, channels and playlists with type filters, sorting and
  `/api/search/suggest` typeahead.
- Ranked home feed backed by a transparent weighted-heuristic recommender
  (`strategy: trending-recent`), with an explicit non-ML implementation and
  watch-history signals.
- Vertical Shorts: a 9:16 snap feed with autoplay, mute, keyboard navigation,
  cursor-based infinite loading, and short classification on upload.
- DEXTube Studio: dashboard, video list with filters, per-video editing and
  publish/unpublish controls, comment moderation, and analytics (views, watch
  time and subscriber changes over a selectable range) computed from stored
  events.
- Test suite: 61 Vitest unit/integration tests and 3 Playwright end-to-end
  tests, with a generated-media fixture set and test-data cleanup.
- ESLint flat config (`eslint.config.mjs` with `eslint-config-next`) and an
  `npm run lint` script.
- `npm run doctor` preflight diagnostic and a `/api/health` endpoint reporting
  database connectivity, storage writability, FFmpeg presence, and the negotiated
  encoder.
- Security headers and a conservative same-origin Content-Security-Policy applied
  globally in `next.config.ts`.
- Documentation: `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, this changelog, and `docs/{architecture,database,deployment,security,dependencies,fedora}.md`.
- Operations scripts for Fedora: `scripts/db-up.sh`, `db-down.sh`,
  `fedora-install.sh`, `start.sh`, `stop.sh`, `backup.sh`, and `restore.sh`.

### Changed

- Media encoding now negotiates an H.264 encoder at runtime instead of assuming
  `libx264`, so a stock Fedora `ffmpeg-free` install transcodes out of the box;
  the chosen encoder is reported by `npm run doctor` and `/api/health`.
- The inline job runner now self-schedules backoff retries (with an unref'd
  heartbeat) instead of waiting for unrelated traffic to poll the queue.
- Linting moved to the ESLint CLI; `next lint` was removed in Next.js 16.
- Page metadata is produced by `generateMetadata()` with `metadataBase` set to
  the configured `APP_URL`, so relative Open Graph and icon URLs resolve
  correctly behind a reverse proxy.
- Feed grids, the Studio video editor, the mobile navigation drawer and the
  search box resynchronise with new server props by adjusting state during
  render instead of in an effect.

### Fixed

- FFmpeg does not create output directories, which caused thumbnail generation to
  fail with a confusing error; every media helper now creates its parent
  directory first.
- Retried media-processing jobs failed because the staging file had already been
  promoted; promotion is now idempotent so a retry succeeds.
- A failed media-processing job lost the creator's chosen visibility; the chosen
  visibility is now preserved on failure. Failed videos are still excluded from
  public listings by their `status` (only `READY` videos are published), so this
  remains safe.
- In inline job-runner mode, jobs scheduled with a backoff delay were never
  re-run and could stall indefinitely; they are now re-run on their scheduled
  retry.
- `formatRelativeTime` reported raw hours and never rolled up to days, months or
  years (for example "72 hours ago" instead of "3 days ago").
- Watch history could accumulate duplicate rows for the same video, breaking
  continue-watching ordering; `watch_history` now has a unique
  `(userId, videoId)` constraint and a rewatch updates the existing row.
- The video player's keyboard shortcut for fullscreen closed over the first
  render's function; it is now memoised and declared in the effect's
  dependencies.
- The search input advertised `aria-expanded` on a plain textbox; it is now a
  proper `combobox`.
- Search GIN indexes that existed only as raw SQL were silently dropped by
  `prisma migrate dev`; they are now declared in the schema as well.
- `npm run test:e2e` was not repeatable: a second run hit the registration rate
  limit, and the comment assertion could race the insert. The suite now resets
  rate-limit buckets and stale test accounts before running, and confirms the
  comment is persisted through the API before asserting on the reloaded page.
- `npx prisma db seed` failed because Prisma spawns the configured seed command
  without a shell, so the `NODE_OPTIONS=--conditions=react-server` prefix could
  not be applied; both that command and `npm run db:seed` now go through
  `scripts/seed.sh`.
- Root metadata no longer triggers Next.js's "metadataBase property … is not set"
  warning, and relative Open Graph/icon URLs resolve against `APP_URL`.

[Unreleased]: https://example.invalid/dextube/compare/v0.1.0...HEAD
