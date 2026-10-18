-- One watch-history row per (user, video): rewatching refreshes `watchedAt`
-- instead of inserting a duplicate row. This is what lets `recordView` upsert
-- and keeps the history list free of repeats.

-- Defensive de-duplication in case any rows were written before the constraint.
DELETE FROM "watch_history" a
USING "watch_history" b
WHERE a."userId" = b."userId"
  AND a."videoId" = b."videoId"
  AND a."watchedAt" < b."watchedAt";

CREATE UNIQUE INDEX "watch_history_userId_videoId_key"
  ON "watch_history"("userId", "videoId");
