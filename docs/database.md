# DEXTube Database

DEXTube stores all relational state in **PostgreSQL 16** and accesses it through
**Prisma 6** (`prisma/schema.prisma`, generated client in `node_modules/.prisma`).

**Current size: 24 models, 11 enums, and 25 tables including
`_prisma_migrations`.** All six migrations under `prisma/migrations/` are
applied to a fresh database.

---

## 1. Conventions

- **IDs are cuids** (`@default(cuid())`) — sortable, URL-safe, and non-sequential,
  so object identifiers cannot be enumerated.
- **User-supplied long text** uses `@db.Text`.
- **Denormalised counters** (`Video.viewCount`, `likeCount`, `commentCount`,
  `Channel.subscriberCount`, `videoCount`, `Playlist.itemCount`, comment
  `likeCount`/`replyCount`) are maintained inside transactions by the service
  layer so feeds and aggregates stay cheap.
- **Soft delete / moderation flags** exist where history matters: `User.deletedAt`,
  `Video.deletedAt`, `Comment.deletedAt` and `Comment.isHidden`.
- The schema alone never grants access — every privacy/ownership rule is enforced
  in `src/server/services/**`.
- Table names are snake_case via `@@map` (for example `Video` → `videos`).

---

## 2. Enums (11)

| Enum | Values | Used by |
| --- | --- | --- |
| `UserRole` | `USER`, `MODERATOR`, `ADMIN` | `User.role` |
| `Visibility` | `PRIVATE`, `UNLISTED`, `PUBLIC` | `Video.visibility` |
| `VideoStatus` | `DRAFT`, `UPLOADING`, `PROCESSING`, `READY`, `FAILED` | `Video.status` |
| `AssetKind` | `ORIGINAL`, `PROGRESSIVE`, `HLS_MANIFEST`, `HLS_SEGMENT`, `THUMBNAIL`, `CAPTION` | `VideoAsset.kind` |
| `UploadStatus` | `INITIATED`, `UPLOADING`, `COMPLETE`, `FAILED`, `ABORTED` | `Upload.status` |
| `TokenPurpose` | `EMAIL_VERIFICATION`, `PASSWORD_RESET` | `Token.purpose` |
| `ReactionValue` | `LIKE`, `DISLIKE` | `VideoReaction.value` |
| `NotificationType` | `NEW_VIDEO`, `COMMENT_REPLY`, `COMMENT_LIKE`, `VIDEO_LIKE`, `NEW_SUBSCRIBER`, `SYSTEM` | `Notification.type` |
| `JobStatus` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED` | `Job.status` |
| `ReportStatus` | `OPEN`, `REVIEWED`, `DISMISSED`, `ACTIONED` | `CommentReport.status`, `ContentReport.status` |
| `ListVisibility` | `PRIVATE`, `UNLISTED`, `PUBLIC` | `Playlist.visibility` |

`Visibility` and `ListVisibility` share the same three values but are **separate
enums** on purpose: video and playlist visibility are governed by different
service rules and can evolve independently.

---

## 3. Models by domain

### 3.1 Identity and sessions

#### `User` → `users`
The account. Key fields: `username` (unique), `email` + `emailNormalized` (both
unique), `passwordHash` (Argon2id string), `role`, `emailVerifiedAt`,
`sessionEpoch`, and the privacy toggles `saveWatchHistory` and
`showLikesPublicly`. Suspension (`isSuspended`, `suspendedReason`) and soft
deletion (`deletedAt`) are supported. Relations: sessions, tokens, one optional
channel, comments, comment likes, video reactions, subscriptions, watch progress,
watch history, notifications (as recipient and as actor), interests, uploads, and
reports.

#### `Session` → `sessions`
One row per signed-in device. Stores only `tokenHash` (SHA-256), the `epoch` it
was created with (compared against `User.sessionEpoch`), truncated `ip`,
`userAgent`, `lastSeenAt`, `expiresAt`, and `revokedAt`. Cascade-deletes with the
user.

#### `Token` → `tokens`
Single-use, expiring tokens for email verification (24 h) and password reset
(1 h). Stores `tokenHash`, `purpose`, `expiresAt`, and `usedAt`.

#### `UserInterest` → `user_interests`
Declared interest tags used to personalise the recommender. Unique on
`(userId, tag)`.

### 3.2 Channels

#### `Channel` → `channels`
A creator's public presence. One per user (`ownerId` unique). Fields: `handle`
(unique, lowercase), `name`, `description` (Text), `avatarKey`, `bannerKey`,
`layout` (JSON for section ordering), and the denormalised `subscriberCount` and
`videoCount`. Relations: owner, videos, playlists, subscriptions,
`ChannelDailyStat`.

#### `Subscription` → `subscriptions`
A user subscribing to a channel. Unique on `(subscriberId, channelId)`;
`notifyLevel` (`all` | `personalized` | `none`) controls notifications.

### 3.3 Video and media

#### `Upload` → `uploads`
An in-progress or completed upload session. Fields: `filename`, `sizeBytes`
(BigInt), `mimeType`, `receivedBytes` (BigInt progress), `status`, `tempKey`
(staging key), optional unique `videoId` (set once promoted), and `error`.
Relations: user. Pruning removes abandoned uploads after 24 h.

#### `Video` → `videos`
The central catalogue entity. Metadata: `title`, `description` (Text),
`visibility`, `status`, `isShort`, `durationSec`, `width`, `height`, `category`,
`tags` (Postgres `text[]`), `language`. Media keys: `thumbnailKey`, `posterKey`,
`playbackKey`, `hlsKey`, `originalKey`, plus `sourceFilename`, `sizeBytes`,
`mimeType`. Policy flags: `allowComments`, `madeForKids`. Denormalised counters:
`viewCount`, `likeCount`, `dislikeCount`, `commentCount`. Lifecycle:
`processingError`, `publishedAt`, `deletedAt`. Relations: channel, assets,
comments, reactions, playlist items, watch progress, watch history, views,
daily stats, and content reports.

#### `VideoAsset` → `video_assets`
One row per stored rendition/asset: `kind`, `label` (for example `720p`),
`storageKey`, `mimeType`, optional `width`/`height`/`bitrateKbps`/`sizeBytes`.
Derived assets are replaced wholesale on reprocessing.

### 3.4 Engagement and watch state

#### `VideoReaction` → `video_reactions`
A viewer's like/dislike on a video. Unique on `(videoId, userId)`; changing the
value updates the row so counts stay accurate.

#### `Comment` → `comments`
A comment or a one-level reply (`parentId`). Fields: `body` (Text), `likeCount`,
`replyCount`, `isPinned`, `isHidden`, `editedAt`, `deletedAt`. Self-referential
`CommentReplies` relation; cascade-deletes replies. Contains a `videoId`-scoped
pinned index for the "pinned comment" lookup.

#### `CommentLike` → `comment_likes`
A like on a comment. Unique on `(commentId, userId)`.

#### `View` → `views`
A recorded view. `userId` is set for signed-in viewers; anonymous viewers are
identified by a salted, rotating `viewerHash` (see
[security](./security.md)), so **no raw IP is stored here**. `watchedSeconds`
records how much was watched.

#### `WatchProgress` → `watch_progress`
Per-user resume position: `positionSec`, `durationSec`, `completed`. Unique on
`(userId, videoId)`.

#### `WatchHistory` → `watch_history`
An append-style history entry (`watchedAt`, `seconds`) used for continue-watching
and recommender signals. Respects the user's `saveWatchHistory` setting.

### 3.5 Library

#### `Playlist` → `playlists`
A channel-owned playlist. Fields: `title`, `description`, `visibility`,
`isSystem` and unique `systemKind` (`watch_later` | `liked_videos`) for the two
fixed system playlists, and denormalised `itemCount`. System playlists cannot be
renamed or deleted.

#### `PlaylistItem` → `playlist_items`
Membership and ordering: dense integer `position` starting at 0, with
`addedAt`. Unique on `(playlistId, videoId)`.

### 3.6 Notifications

#### `Notification` → `notifications`
An in-app notification. Fields: `type`, `title`, `body`, `url`, `isRead`,
optional `actorUserId` (set null if the actor is deleted), `videoId`,
`commentId`, and a unique `dedupeKey` so retrying a fan-out job cannot create
duplicates. Two relations to `User`: recipient and optional actor.

### 3.7 Analytics

#### `VideoDailyStat` → `video_daily_stats`
Per-video daily rollup: `day` (`DATE`), `views`, `watchSeconds`, `likes`,
`comments`. Unique on `(videoId, day)`. Rebuilt idempotently by the
`analytics.aggregate` job from the source event tables — never hard-coded.

#### `ChannelDailyStat` → `channel_daily_stats`
Per-channel daily rollup: `views`, `watchSeconds`, `subscribersGained`,
`subscribersLost`, `uploads`. Unique on `(channelId, day)`.

### 3.8 Moderation

#### `CommentReport` → `comment_reports`
A user report on a comment: `reason`, `status`. Unique on
`(commentId, reporterId)`.

#### `ContentReport` → `content_reports`
A user report on a video: `reason`, `status`. Unique on `(videoId, reporterId)`.

### 3.9 Jobs and infrastructure

#### `Job` → `jobs`
The database-backed queue. Fields: `type`, `payload` (JSON), `status`,
`attempts`, `maxAttempts`, `runAt`, `lockedAt`, `lockedBy`, `lastError`, and a
unique `dedupeKey`. Claimed with `FOR UPDATE SKIP LOCKED`. See
[architecture §4](./architecture.md).

#### `RateLimitBucket` → `rate_limit_buckets`
Persistent fixed-window rate-limit counter. The primary key is a caller-supplied
`key` (for example `login:ip:127.0.0.1`), with `count`, `windowStart`, and
`expiresAt`. Stored in the database so throttling survives restarts and works
across multiple app instances.

---

## 4. Indexes

### 4.1 Prisma-defined indexes (created by the `init` migration)

Highlights by hot path:

| Table | Index | Purpose |
| --- | --- | --- |
| `users` | unique `username`, unique `email`, unique `emailNormalized`; `createdAt` | Login/lookup, signup ordering. |
| `sessions` | unique `tokenHash`; `userId`; `expiresAt` | Cookie resolution, device list, pruning. |
| `tokens` | unique `tokenHash`; `(userId, purpose)` | Verification/reset lookup. |
| `channels` | unique `handle`, unique `ownerId`; `subscriberCount` | Handle lookup, owner lookup, channel ranking. |
| `subscriptions` | unique `(subscriberId, channelId)`; `channelId` | Feed and fan-out. |
| `uploads` | unique `videoId`; `(userId, status)`; `createdAt` | Resume, quota checks, pruning. |
| `videos` | `(status, visibility, publishedAt)`; `(channelId, status, publishedAt)`; `(isShort, status, visibility, publishedAt)`; `category`; `viewCount`; `deletedAt` | Feed, channel listing, Shorts feed, search facets, sorting. |
| `video_assets` | `(videoId, kind)` | Rendition lookup. |
| `video_reactions` | unique `(videoId, userId)`; `userId` | One reaction per viewer, "liked videos". |
| `comments` | `(videoId, parentId, createdAt)`; `(videoId, isPinned, createdAt)`; `userId` | Thread paging, pinned comment, user activity. |
| `comment_likes` | unique `(commentId, userId)` | One like per user. |
| `views` | `(videoId, createdAt)`; `(videoId, viewerHash)` | Analytics and anonymous dedupe. |
| `watch_progress` | unique `(userId, videoId)`; `(userId, updatedAt)` | Resume position, continue-watching. |
| `watch_history` | unique `(userId, videoId)`; `(userId, watchedAt)`; `videoId` | One row per video (a rewatch updates `watchedAt`), history listing, recommender signals. |
| `playlists` | unique `(channelId, systemKind)`; `(channelId, createdAt)` | One `watch_later`/`liked_videos` playlist per channel, channel library. |
| `playlist_items` | `(playlistId, position)`; unique `(playlistId, videoId)` | Ordered listing, no duplicates. |
| `notifications` | unique `dedupeKey`; `(userId, isRead, createdAt)` | Dedupe and inbox. |
| `video_daily_stats` | unique `(videoId, day)`; `day` | Rollups and range queries. |
| `channel_daily_stats` | unique `(channelId, day)`; `day` | Rollups and range queries. |
| `comment_reports` | unique `(commentId, reporterId)` | One report per user. |
| `content_reports` | unique `(videoId, reporterId)` | One report per user. |
| `jobs` | unique `dedupeKey`; `(status, runAt)` | Dedupe and claim ordering. |
| `rate_limit_buckets` | `expiresAt` | Pruning. |

### 4.2 Search indexes (declared in the schema *and* created by migrations)

The `20261017170150_search_indexes` migration — recreated by
`20261017180000_system_playlist_per_channel`'s sibling
`20261017181000_restore_search_indexes` — enables the **`pg_trgm`** extension and
adds GIN trigram indexes so `ILIKE '%term%'` search is fast without a separate
search engine, plus two partial indexes for feed ordering and a dedupe index.

The six trigram/GIN indexes and `views_dedupe_idx` are **also declared in
`schema.prisma`** (`type: Gin`, `gin_trgm_ops`, explicit `map:` names). That is
deliberate: `prisma migrate dev` regenerates indexes from the schema and drops
anything that exists only in raw SQL. Declaring them stops that class of
data-loss bug. The two partial indexes remain raw SQL because Prisma cannot
express `WHERE` clauses on indexes:

| Index | Table / columns | Type |
| --- | --- | --- |
| `videos_title_trgm_idx` | `videos (title)` | GIN `gin_trgm_ops` |
| `videos_description_trgm_idx` | `videos (description)` | GIN `gin_trgm_ops` |
| `videos_tags_gin_idx` | `videos (tags)` | GIN |
| `channels_name_trgm_idx` | `channels (name)` | GIN `gin_trgm_ops` |
| `channels_handle_trgm_idx` | `channels (handle)` | GIN `gin_trgm_ops` |
| `playlists_title_trgm_idx` | `playlists (title)` | GIN `gin_trgm_ops` |
| `videos_feed_idx` | `videos (visibility, status, publishedAt DESC) WHERE deletedAt IS NULL` | Partial B-tree |
| `videos_shorts_idx` | `videos (visibility, status, publishedAt DESC) WHERE isShort AND deletedAt IS NULL` | Partial B-tree |
| `views_dedupe_idx` | `views (videoId, viewerHash, createdAt DESC)` | B-tree |

> **History — search-index drift (resolved).** The
> `20261017171124_rate_limit_buckets` migration was generated by
> `prisma migrate dev`, which did not know about the raw-SQL indexes and emitted
> `DROP INDEX` statements for the six trigram indexes, `videos_tags_gin_idx`, and
> `views_dedupe_idx`. A freshly migrated database therefore lacked the trigram
> search indexes (search still worked, but fell back to sequential `ILIKE` scans).
>
> This is fixed: the GIN/trigram indexes are now **declared in `schema.prisma`**
> (D19) so `migrate dev` recreates rather than drops them, and
> `20261017181000_restore_search_indexes` re-created them for databases migrated
> before that change. Verify with:
>
> ```sql
> SELECT indexname FROM pg_indexes
> WHERE schemaname = 'public' AND indexname LIKE '%trgm%';
> ```
>
> The two partial indexes (`videos_feed_idx`, `videos_shorts_idx`) remain raw SQL
> because Prisma cannot express `WHERE` clauses on indexes; they are unaffected
> because Prisma never emitted a `DROP` for them.

---

## 5. Migrations

Migrations live in `prisma/migrations/` and are applied with Prisma:

| Migration | Contents |
| --- | --- |
| `20261017170137_init` | Creates all 11 enums, 23 tables (`rate_limit_buckets` excluded), all Prisma indexes, and all foreign keys. |
| `20261017170150_search_indexes` | Raw SQL: `pg_trgm` extension, the GIN trigram indexes, `videos_feed_idx`, `videos_shorts_idx`, and `views_dedupe_idx`. |
| `20261017171124_rate_limit_buckets` | Creates `rate_limit_buckets` + its `expiresAt` index; also (Prisma-generated) drops the custom search indexes that were raw-SQL-only at the time. |
| `20261017180000_system_playlist_per_channel` | Replaces the globally unique `playlists.systemKind` with a per-channel `(channelId, systemKind)` constraint. |
| `20261017181000_restore_search_indexes` | Recreates the GIN/trigram indexes after they were declared in `schema.prisma` (D19). |
| `20261017190000_watch_history_unique` | Adds unique `(userId, videoId)` on `watch_history`, de-duplicating existing rows first. |

### Workflow

```bash
# Apply committed migrations (non-interactive; what scripts and CI use)
npx prisma migrate deploy

# Day-to-day development (also regenerates the client; may prompt y/N)
npx prisma migrate dev

# Regenerate the typed client after editing schema.prisma
npx prisma generate
```

Rules:

1. Edit `prisma/schema.prisma`.
2. Create and apply a migration locally with a short, snake_case name.
3. **Review the generated SQL** — raw-SQL migrations (indexes, extensions) are
   welcome, but Prisma may emit unexpected `DROP` statements for indexes it does
   not manage. Declare every index in `schema.prisma` too (see §4.2) so Prisma
   manages it from then on.
4. Regenerate the client and commit the migration directory with the schema
   change.
5. Never edit a migration that has already been applied to a shared database;
   add a new one instead.

---

## 6. Counting it up

| Kind | Count |
| --- | --- |
| Models | **24** |
| Enums | **11** |
| Application tables | 24 |
| Plus `_prisma_migrations` | **25 tables total** |
| Migrations | 6 |
