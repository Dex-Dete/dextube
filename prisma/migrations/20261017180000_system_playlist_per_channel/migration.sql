-- Fix: system playlists (Watch later / Liked videos) must be unique **per
-- channel**, not globally. The original `systemKind` unique index allowed only
-- one Watch later playlist to exist in the entire database, so a second user
-- could never have their own.
--
-- Before adding the composite constraint we defensively de-duplicate: if any
-- channel somehow ended up with two system playlists of the same kind, the
-- extras are un-marked (they keep their items and become ordinary private
-- playlists) rather than deleted.

DROP INDEX IF EXISTS "playlists_systemKind_key";

WITH ranked AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "channelId", "systemKind"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rn
    FROM "playlists"
    WHERE "systemKind" IS NOT NULL
)
UPDATE "playlists" p
SET "systemKind" = NULL, "isSystem" = false
FROM ranked r
WHERE p."id" = r."id" AND r.rn > 1;

CREATE UNIQUE INDEX "playlists_channelId_systemKind_key" ON "playlists"("channelId", "systemKind");
