-- Restore the search / dedupe indexes that migration 20261017171124
-- (`rate_limit_buckets`) unintentionally dropped.
--
-- Cause: those indexes were created only by raw SQL in the `search_indexes`
-- migration, without being declared in `schema.prisma`. `prisma migrate dev`
-- therefore saw them as drift and generated a migration to remove them.
--
-- Fix: the representable indexes are now declared in `schema.prisma`
-- (`type: Gin`, `gin_trgm_ops` operator classes, explicit `map:` names), so
-- `migrate dev` will leave them alone. This migration re-creates them with
-- `IF NOT EXISTS`, so it is a no-op on databases that still have them.
--
-- The two partial indexes (`videos_feed_idx`, `videos_shorts_idx`) are not
-- representable in Prisma and are intentionally kept as raw SQL; Prisma Migrate
-- ignores partial indexes, so they are preserved.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS videos_title_trgm_idx
  ON videos USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS videos_description_trgm_idx
  ON videos USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS videos_tags_gin_idx
  ON videos USING gin (tags);
CREATE INDEX IF NOT EXISTS channels_name_trgm_idx
  ON channels USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS channels_handle_trgm_idx
  ON channels USING gin (handle gin_trgm_ops);
CREATE INDEX IF NOT EXISTS playlists_title_trgm_idx
  ON playlists USING gin (title gin_trgm_ops);

-- Anonymous view dedupe (replaces the narrower two-column index).
CREATE INDEX IF NOT EXISTS views_dedupe_idx
  ON views ("videoId", "viewerHash", "createdAt" DESC);

-- The superseded two-column lookup index is redundant once the three-column
-- index above exists.
DROP INDEX IF EXISTS views_videoId_viewerHash_idx;

-- Partial indexes: kept as raw SQL because Prisma cannot express the WHERE.
CREATE INDEX IF NOT EXISTS videos_feed_idx
  ON videos ("visibility", "status", "publishedAt" DESC)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS videos_shorts_idx
  ON videos ("visibility", "status", "publishedAt" DESC)
  WHERE "isShort" = true AND "deletedAt" IS NULL;
