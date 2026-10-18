-- Scope import-item deduplication to a single source.
--
-- The original table made `dedupeKey` unique across the whole instance, which
-- meant a second source covering an overlapping video could not be created at
-- all. Uniqueness now applies per source, and the plain index keeps the
-- cross-source "have we already imported this entry?" lookup fast.
DROP INDEX "import_items_dedupeKey_key";

CREATE UNIQUE INDEX "import_items_sourceId_dedupeKey_key" ON "import_items"("sourceId", "dedupeKey");

CREATE INDEX "import_items_dedupeKey_idx" ON "import_items"("dedupeKey");
