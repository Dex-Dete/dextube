-- DEXTube search & performance indexes (Prisma cannot express these natively)

-- Trigram search: fast ILIKE '%term%' on titles/descriptions/handles.
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

-- Feed ordering: newest public ready videos.
CREATE INDEX IF NOT EXISTS videos_feed_idx
  ON videos ("visibility", "status", "publishedAt" DESC)
  WHERE "deletedAt" IS NULL;

-- Shorts feed.
CREATE INDEX IF NOT EXISTS videos_shorts_idx
  ON videos ("visibility", "status", "publishedAt" DESC)
  WHERE "isShort" = true AND "deletedAt" IS NULL;

-- Anonymous view dedupe lookups.
CREATE INDEX IF NOT EXISTS views_dedupe_idx
  ON views ("videoId", "viewerHash", "createdAt" DESC);
