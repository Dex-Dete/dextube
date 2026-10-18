# DEXTube Performance Notes

This document records **measured** behaviour, the method used to measure it, and
the properties the test suite now enforces so they cannot silently regress.

Everything here was produced against the production build (`npm run build` then
`next start`), not a development server, unless a line says otherwise. Numbers
came from a single modest development machine on the reference environment
described in `PROJECT_STATUS.md` §2. They are useful for spotting regressions and
for understanding the shape of the work, not as a promise about another machine.

---

## 1. How to reproduce

```bash
npm run build && npm run start          # production build on :3000

# Latency: 20 samples per route, p50/p95.
for i in $(seq 20); do
  curl -s -o /dev/null -w "%{time_total}\n" http://127.0.0.1:3000/api/feed?tab=home
done | sort -n

# Statement counts (the real evidence for "no N+1"):
npx vitest run tests/integration/performance.test.ts

# Query plans:
psql "$DATABASE_URL" -c 'EXPLAIN (ANALYZE, COSTS OFF)
  SELECT id FROM videos
  WHERE "deletedAt" IS NULL AND visibility = '"'"'PUBLIC'"'"'
    AND status = '"'"'READY'"'"' AND "isShort" = false
  ORDER BY "publishedAt" DESC LIMIT 240'
```

The statement-count tests read Prisma's own `query` event, so the counts are the
statements the database actually received rather than an estimate.

---

## 2. Route latency

Twenty sequential requests per route against the production build, after a
warm-up request. `p50` and `p95` in milliseconds.

| Route                                 |   p50 |   p95 |   max |
| ------------------------------------- | ----: | ----: | ----: |
| `GET /api/feed?tab=home&limit=12`     |   7.0 |  11.3 |  15.2 |
| `GET /api/search?q=algorithm`         |  10.5 |  18.2 |  20.1 |
| `GET /music`                          |  14.6 |  18.5 |  19.1 |
| `GET /api/studio/analytics?range=28d` |  17.2 |  21.5 |  34.2 |
| `GET /trending`                       |  18.0 |  35.1 |  45.3 |
| `GET /watch/<id>`                     |  33.0 |  41.8 |  46.9 |
| `GET /studio/analytics`               |  40.6 |  54.6 |  88.6 |
| `GET /api/health`                     | 320.1 | 420.9 | 433.3 |
| `GET /api/ready`                      |   8.9 |  21.5 |  23.3 |

Two things are worth noting:

- `/watch/<id>` is the most expensive render because it produces the player, the
  playback assets, the recommendation sidebar and the comment list in one
  response. It is still comfortably sub-50 ms locally.
- `/api/health` is the slowest endpoint by an order of magnitude **on purpose**:
  it spawns FFmpeg and FFprobe to report the resolved encoder. That is the wrong
  thing to hang a load balancer on, which is why readiness is now a separate,
  cheap endpoint (§6).

---

## 3. Statement counts (the anti-N+1 evidence)

`tests/integration/performance.test.ts` asserts statement counts rather than
wall-clock thresholds, because a timing threshold is flaky on a shared machine
while "this operation issues a bounded number of queries" is the property that
actually regressed before.

| Operation                                    |       Statements | Notes                                                                                                                             |
| -------------------------------------------- | ---------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| Rebuild one day of rollups (3 active videos) |                9 | 4 event reads + 2 channel reads + `BEGIN` + **1** `INSERT` into `video_daily_stats` + **1** into `channel_daily_stats` + `COMMIT` |
| `getStudioOverview(channel, "28d")`          |             ≤ 12 | Identical count with 1 video and with 6; history is read from the daily rollups, not recomputed from events                       |
| `getRankedHomeFeed` (anonymous, `limit: 12`) |             ≤ 20 | Bounded candidate pool plus a fixed set of aggregate reads                                                                        |
| `getRankedHomeFeed` (signed in)              | ≤ anonymous + 12 | Signal loading is a fixed set of bounded queries, not one per watched video                                                       |

The rollup assertion is the direct proof that the write path is set-based: three
videos are aggregated by **one** `INSERT ... ON CONFLICT` per table, where the
old implementation issued one `upsert` per video. The test greps the captured
SQL for `INSERT INTO ... video_daily_stats` and asserts exactly one occurrence,
then counts the rows to confirm all three videos were written.

Response sizes are bounded the same way: `getRankedHomeFeed` clamps its page size
(48) and its offset, so a hand-crafted `?limit=500` cannot widen the response.
The Studio list and the moderation queue clamp their page sizes in the request
schema, so an oversized page is rejected with a validation error rather than
silently served.

---

## 4. Payload and bundle size

| Asset                         |                                        Size |
| ----------------------------- | ------------------------------------------: |
| Client JavaScript, all chunks |                        907.5 KiB (33 files) |
| `/` HTML                      | 51.7 KiB raw, 10.0 KiB over the wire (gzip) |
| `/watch/<id>` HTML            | 69.6 KiB raw, 15.0 KiB compressed with gzip |
| `/results?q=algorithm` HTML   |                                53.8 KiB raw |
| `/music` HTML                 |                                40.9 KiB raw |

The client bundle grew from ~860 KiB during the "2.0" pass (the video player, the
music mini-player and the Studio table are all client components). This is
recorded rather than celebrated: if it keeps growing, the first thing to check is
whether a component that only needs to render on the server has been given
`"use client"`.

Fonts are self-hosted through `next/font`, so there is no third-party request on
the critical path.

---

## 5. Indexes and query plans

DEXTube declares its indexes in `prisma/schema.prisma` and, where Prisma cannot
express them, in a migration. The ones that carry the hot paths:

| Index                                                                            | Serves                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `videos_feed_idx (visibility, status, publishedAt DESC) WHERE deletedAt IS NULL` | The home/trending candidate pool                         |
| `videos_isShort_status_visibility_publishedAt_idx`                               | The same predicate when it also filters `isShort`        |
| `videos_title_trgm_idx`, `videos_description_trgm_idx`, `videos_tags_gin_idx`    | Search and tag filters (`pg_trgm` / GIN)                 |
| `views_dedupe_idx (videoId, viewerHash, createdAt DESC)`                         | Write-time anonymous view de-duplication                 |
| `watch_history_userId_watchedAt_idx`                                             | Resume positions and history pages                       |
| `video_daily_stats_videoId_day_key`, `channel_daily_stats_channelId_day_key`     | The Studio rollup reads and the set-based rollup upserts |

A note on honesty about plans: with a ten-row development catalogue the planner
correctly chooses a **sequential scan**, because scanning ten rows is cheaper than
any index walk. That is the right plan, not a missing index. To check that an
index is _usable_ by a query, disable sequential scans in a throwaway session:

```sql
SET enable_seqscan = off;
EXPLAIN (ANALYZE, COSTS OFF) SELECT ... ;
```

With sequential scans disabled, the feed predicate above resolves to a bitmap
index scan on `videos_isShort_status_visibility_publishedAt_idx`. No speculative
index was added during the 2.0 pass: adding an index that duplicates an existing
one is a write cost paid on every insert, and the audit found no query without a
usable index.

**One index was deliberately dropped.** `views_videoId_viewerHash_idx` was
redundant — `views_dedupe_idx` covers the same leading columns plus the ordering
the de-duplication lookup needs — so the `recsys_feedback` migration removed it
and the note was recorded in `20261017181000_restore_search_indexes`.

---

## 6. Health versus readiness

| Endpoint                                          | Question                               | Cost                                                | Reports                                                             |
| ------------------------------------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/ready`                                  | "May I send this instance traffic?"    | Database round trip + one storage write/read/delete | Booleans only: database, storage, driver name                       |
| `GET /api/health`                                 | "Is everything DEXTube needs working?" | Spawns FFmpeg and FFprobe (>300 ms)                 | Database, storage, FFmpeg, FFprobe, resolved encoder, feature flags |
| `GET /api/health?details=1` (non-production only) | Developer diagnostics                  | As above, plus job stats                            | Adds the storage root, the advertised URL and queue statistics      |

`/api/ready` returns `503` unless both checks pass. `/api/health` returns `503`
when any dependency is unhealthy. Both send `cache-control: no-store`.

The health endpoint is unauthenticated, so it no longer exposes the absolute
storage path or the advertised URL to anonymous callers; those moved behind
`?details=1`, which is refused in production.

---

## 7. Recovery

- **Restore point**: `scripts/backup.sh` writes a database dump plus a storage
  archive; `scripts/restore.sh` restores both. The procedure and the exact
  commands are in `docs/deployment.md` §7.
- **Failed media is not lost.** A video whose processing fails keeps its row and
  its visibility, records `processingError`, and can be retried from the Studio
  (`POST /api/studio/videos/[id]/retry`), which re-enqueues the existing job
  rather than re-implementing processing.
- **The rollups are self-healing.** `aggregateDailyStats` recomputes one day from
  the raw event tables and upserts it, so a missed or interrupted rollup is
  repaired by re-running it; nothing needs to be reconstructed by hand.
- **Jobs are durable and bounded.** The queue lives in the database, retries with
  backoff, and the inline runner self-schedules; a stuck worker does not lose
  queued work, and opening Studio also refreshes today's rollup.
