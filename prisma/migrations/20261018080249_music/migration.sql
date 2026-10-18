-- CreateTable
CREATE TABLE "tracks" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "audioKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_rights" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "territory" TEXT NOT NULL,
    "downloadAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "track_rights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracks_visibility_publishedAt_idx" ON "tracks"("visibility", "publishedAt");

-- CreateIndex
CREATE INDEX "tracks_channelId_publishedAt_idx" ON "tracks"("channelId", "publishedAt");

-- CreateIndex
CREATE INDEX "tracks_deletedAt_idx" ON "tracks"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "track_rights_trackId_key" ON "track_rights"("trackId");

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_rights" ADD CONSTRAINT "track_rights_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
