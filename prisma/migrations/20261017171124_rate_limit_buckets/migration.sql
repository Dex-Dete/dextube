-- DropIndex
DROP INDEX "channels_handle_trgm_idx";

-- DropIndex
DROP INDEX "channels_name_trgm_idx";

-- DropIndex
DROP INDEX "playlists_title_trgm_idx";

-- DropIndex
DROP INDEX "videos_description_trgm_idx";

-- DropIndex
DROP INDEX "videos_tags_gin_idx";

-- DropIndex
DROP INDEX "videos_title_trgm_idx";

-- DropIndex
DROP INDEX "views_dedupe_idx";

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_expiresAt_idx" ON "rate_limit_buckets"("expiresAt");
