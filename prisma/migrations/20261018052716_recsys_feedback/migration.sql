-- DropIndex
-- Deferred cleanup: `views_videoId_viewerHash_idx` was declared redundant in
-- 20261017181000_restore_search_indexes (which already dropped it in the shadow
-- replay), but that migration had been hand-edited after it was applied, so the
-- 2-column index was still present in the deployed database. It is genuinely
-- redundant: `views_dedupe_idx (videoId, viewerHash, createdAt DESC)` has the
-- same leading columns and serves the view-dedupe lookup as an index-only scan
-- (verified with EXPLAIN). Dropping it here does not change query plans.
DROP INDEX "views_videoId_viewerHash_idx";

-- CreateTable
CREATE TABLE "video_feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hidden_channels" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hidden_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_feedback_userId_createdAt_idx" ON "video_feedback"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "video_feedback_userId_videoId_key" ON "video_feedback"("userId", "videoId");

-- CreateIndex
CREATE INDEX "hidden_channels_userId_createdAt_idx" ON "hidden_channels"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hidden_channels_userId_channelId_key" ON "hidden_channels"("userId", "channelId");

-- AddForeignKey
ALTER TABLE "video_feedback" ADD CONSTRAINT "video_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_feedback" ADD CONSTRAINT "video_feedback_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hidden_channels" ADD CONSTRAINT "hidden_channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hidden_channels" ADD CONSTRAINT "hidden_channels_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
