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
- Shared UI primitives in `src/components/ui/` (`EmptyState`, `PageHeader`,
  `SectionCard`, `StatCard`, `PlaylistCard`, `Skeletons`), replacing thirteen
  duplicated empty states and three bespoke playlist cards. The top-level
  surfaces now have genuinely different layouts — home is a grid with a category
  filter, trending is a numbered ranked list, subscriptions is grouped by
  channel, and search results are counted sections — instead of one template
  reused four times.
- Route-level `loading.tsx` skeletons and a root `error.tsx` boundary, and a
  self-hosted Inter webfont loaded through `next/font`.
- `scripts/make-renditions.ts` (`npm run make:renditions`), which produces real
  scaled MP4 renditions from each video's source through the storage abstraction
  and records them as `PROGRESSIVE` assets, so the player's quality menu has
  genuine files to point at. It never upscales, and re-running it reuses existing
  renditions.
- Recommendation feedback: the `VideoFeedback` and `HiddenChannel` models and
  `POST/DELETE /api/feed/feedback`. The feed response now reports the
  `rankingVersion` and which strategy produced the page.
- `tests/unit/recsys-ranking.test.ts` (scoring, saturation, diversity, cold
  start, exclusions, weight parsing) and `tests/e2e/player.spec.ts` (real
  playback, the quality menu, speed, keyboard control, resume, and the
  single-rendition case).
- Studio content management: sorting (published date, views, title, with a
  stable tiebreak), enforced pagination (`STUDIO_PAGE_SIZE_MAX = 50`, rejected
  at the request schema), bulk publish / unpublish / soft-delete via
  `POST /api/studio/videos/bulk` (≤ 100 ids, authorised per id, partial results
  reported), and `POST /api/studio/videos/[id]/retry` for a video whose
  processing failed.
- Route-level loading skeletons and error boundaries throughout `/studio`, and
  `EmptyState` on the Studio panels that can be empty.
- `tests/integration/studio.test.ts`, which asserts that the dashboard's rollup
  read path and a direct raw-event query produce identical numbers for a range,
  that soft-deleted comments are excluded, and that page sizes are capped.

### Changed

- **The video player is no longer the browser's native control bar.** It is a
  custom, accessible layer over a plain `<video>` element, shipped together with
  the "DEXTube 2.0" design pass. Added: a real quality menu built from the video's
  stored `PROGRESSIVE` renditions (it appears only when at least two exist, and
  manual switching preserves the playhead — DEXTube makes no adaptive-bitrate
  claim), speed control from 0.25× to 2×, a captions menu shown only when a
  `CAPTION` asset exists, picture-in-picture, fullscreen with best-effort
  orientation lock, a seek bar with buffered range and a time tooltip, volume,
  auto-hiding controls, an on-screen keyboard reference, autoplay-next, resume
  with a "Start over" escape hatch, an error state with retry, and throttled
  progress writes flushed with `keepalive` on pause and page hide.
- **The recommender is now `heuristic-2`**, a documented weighted linear model
  with a version, not a black box: recency, saturated engagement, subscriptions,
  interests, completion affinity, previously-liked channels, language and an
  already-watched penalty. Weights are overridable with the `RANKING_WEIGHTS`
  environment variable. Diversity is enforced structurally (3 per channel, 8 per
  category) and cold start deliberately avoids being a popularity list.
- The recommender reads all of its signals with bounded queries, so feed latency
  no longer grows with account age, and history-derived signals are only read
  when `saveWatchHistory` is enabled.
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
- **Recommendation feedback is the viewer's own decision and outranks the
  ranking**: "Not interested" and "Don't recommend this channel" are stored
  separately from engagement data and are reversible inline, and "Reset
  recommendations" clears them without touching watch history.
- **Studio analytics no longer rescans the event tables on every render.** Days
  before today are served from the `VideoDailyStat` / `ChannelDailyStat` rollups
  that the scheduler already maintains; only the current, not-yet-finalised day
  is read from raw events. Both paths share one pair of helpers, so the rollup
  and the live slice cannot drift apart, and a dashboard render is now bounded
  by the length of the range instead of the number of events inside it.
- **The daily rollup writes are set-based.** What was one `upsert` per video is
  now a single `INSERT ... ON CONFLICT` per table, so aggregating a busy day is
  two statements rather than an N+1 write storm. Aggregation stays idempotent,
  so a late-arriving event is still picked up on the next run.
- The Studio's top-video lookup uses one map instead of a `find` inside a loop
  over the same list.
- `PROJECT_STATUS.md` and `TODO.md` are tracked in the repository as the
  session-continuity record, with machine-specific details removed.

### Fixed

- **The player's seek bar was pinned at zero on a fast connection.** The
  `<video>` is server-rendered with its source, so the browser could finish
  loading metadata before React hydrated and attached listeners; the missed
  `loadedmetadata` event left the duration at `0`, the total time reading `0:00`
  and seeking impossible. The effect now applies the element's existing
  `readyState` instead of waiting for an event that has already fired.
- **The recommender's interest signal never fired for real feeds.** `toCard()`
  dropped `category`, `tags` and `language`, so `interestTokens()` always
  returned an empty list. The feed now carries those fields through to the
  ranker.
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

[Unreleased]: https://github.com/Dex-Dete/dextube/compare/v0.1.0...HEAD
