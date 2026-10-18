-- CreateEnum
CREATE TYPE "ImportConnectorKind" AS ENUM ('YOUTUBE_CHANNEL', 'YOUTUBE_PLAYLIST', 'CREATOR_EXPORT');

-- CreateEnum
CREATE TYPE "ImportSourceStatus" AS ENUM ('DRAFT', 'PREVIEW', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportItemStatus" AS ENUM ('PENDING', 'IMPORTING', 'METADATA_ONLY', 'IMPORTED', 'SKIPPED_DUPLICATE', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "system_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "adminBootstrapEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_sources" (
    "id" TEXT NOT NULL,
    "kind" "ImportConnectorKind" NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "externalChannelId" TEXT,
    "title" TEXT,
    "authorizationBasis" TEXT NOT NULL,
    "scopeLimit" INTEGER NOT NULL DEFAULT 10,
    "scopeIncludeShorts" BOOLEAN NOT NULL DEFAULT false,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "status" "ImportSourceStatus" NOT NULL DEFAULT 'DRAFT',
    "estimatedItems" INTEGER,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "importedItems" INTEGER NOT NULL DEFAULT 0,
    "metadataOnlyItems" INTEGER NOT NULL DEFAULT 0,
    "duplicateItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "bytesImported" BIGINT NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_items" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "thumbnailUrl" TEXT,
    "attribution" TEXT,
    "metadata" JSONB,
    "status" "ImportItemStatus" NOT NULL DEFAULT 'PENDING',
    "mediaAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "mediaSourceKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "videoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_idx" ON "admin_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_createdAt_idx" ON "admin_audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_actorUserId_createdAt_idx" ON "admin_audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "import_sources_status_createdAt_idx" ON "import_sources"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "import_items_dedupeKey_key" ON "import_items"("dedupeKey");

-- CreateIndex
CREATE INDEX "import_items_sourceId_position_idx" ON "import_items"("sourceId", "position");

-- CreateIndex
CREATE INDEX "import_items_sourceId_status_idx" ON "import_items"("sourceId", "status");

-- `system_settings` is a singleton. Prisma cannot express a CHECK constraint,
-- so the database enforces it: a second row cannot exist even by accident.
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_singleton" CHECK ("id" = 1);

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
