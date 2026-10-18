/**
 * Import service — the one place that turns a connector's promise of "these
 * entries exist" into durable `ImportSource`/`ImportItem` rows, and (only when
 * the operator recorded an authorization basis) copies the creator's own media
 * into DEXTube's storage.
 *
 * Two invariants drive every decision here:
 *
 *   1. **Metadata and media are separate questions.** A source with no
 *      authorization basis still records the truthfully-sourced metadata, but
 *      every item lands in `METADATA_ONLY` and **no `Video` row is created**.
 *      DEXTube never claims it copied something it did not.
 *   2. **Bytes only ever come from `CREATOR_EXPORT`.** The YouTube connector is
 *      metadata-only (`canSupplyMedia: false`), so the media path below is
 *      unreachable for it. There is no scraping, no ripping and no signature
 *      deciphering anywhere in this module.
 *
 * Summaries returned to callers are hand-built shapes, never raw Prisma rows, so
 * an internal column can never leak into an API response by accident.
 */
import "server-only";
import { createReadStream } from "node:fs";
import path from "node:path";
import type {
  ImportConnectorKind,
  ImportItemStatus,
  ImportSourceStatus,
  Prisma,
} from "@prisma/client";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import {
  AppError,
  conflict,
  isAppError,
  notFound,
  preconditionFailed,
  validationFailed,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { connectorForInput, getConnector, mediaResolverFor } from "@/server/import";
import type { ChannelRef, ConnectorEntry, ResolvedMedia, ResolvedMediaAsset } from "@/server/import/types";
import { YOUTUBE_LIMITATION_NO_KEY } from "@/server/import/youtube";
import { buildKey, extensionFor, getStorage, mimeForExtension } from "@/server/storage";
import { recordAudit, tryRecordAudit } from "@/server/services/audit";
import { requireOwnedChannelId } from "@/server/services/channels";
import { deleteVideo } from "@/server/services/videos";

const log = logger.child({ mod: "import-sources" });

/** Who triggered an import action; used verbatim for the audit trail. */
export interface ImportActor {
  userId: string | null;
  label: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ImportCounts {
  total: number;
  pending: number;
  importing: number;
  imported: number;
  metadataOnly: number;
  duplicates: number;
  failed: number;
}

export interface ImportItemSummary {
  id: string;
  externalId: string;
  position: number;
  title: string;
  description: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  attribution: string | null;
  canonicalUrl: string;
  status: ImportItemStatus;
  mediaAuthorized: boolean;
  attempts: number;
  lastError: string | null;
  videoId: string | null;
}

export interface ImportSourceSummary {
  id: string;
  kind: ImportConnectorKind;
  sourceUrl: string;
  externalChannelId: string | null;
  title: string | null;
  status: ImportSourceStatus;
  authorizationBasis: string;
  scopeLimit: number;
  estimatedItems: number | null;
  counts: ImportCounts;
  bytesImported: number;
  limitations: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ImportStorageSummary {
  usedBytes: number;
  quotaBytes: number;
  availableBytes: number;
}

/* ------------------------------------------------------------------ helpers */

/** The honest cross-source identity of one provider entry. */
export function dedupeKeyFor(kind: ImportConnectorKind, externalId: string): string {
  return `${kind}:${externalId}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function metadataRecord(metadata: Prisma.JsonValue | null): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * The stored canonical reference for an item, or the YouTube watch URL derived
 * from its id. A creator export that did not state a `source` carries an empty
 * string rather than an invented link.
 */
function canonicalUrlFor(
  kind: ImportConnectorKind,
  externalId: string,
  metadata: Prisma.JsonValue | null,
): string {
  const stored = metadataRecord(metadata).canonicalUrl;
  if (typeof stored === "string" && stored) return stored;
  if (kind === "YOUTUBE_CHANNEL" || kind === "YOUTUBE_PLAYLIST") {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}`;
  }
  return "";
}

/** Limitations the operator must see, derived from the connector and config. */
function limitationsFor(kind: ImportConnectorKind): string[] {
  if (kind === "YOUTUBE_CHANNEL" || kind === "YOUTUBE_PLAYLIST") {
    return getConfig().imports.youtubeApiKey ? [] : [YOUTUBE_LIMITATION_NO_KEY];
  }
  return [];
}

/** The public bounds the service enforces; the UI reads these for its inputs. */
export function importLimits(): {
  maxItems: number;
  maxConcurrency: number;
  storageQuotaBytes: number;
} {
  const imports = getConfig().imports;
  return {
    maxItems: imports.maxItems,
    maxConcurrency: imports.maxConcurrency,
    storageQuotaBytes: imports.storageQuotaBytes,
  };
}

/** Exact accounting for bytes copied by imports, never an estimate. */
export async function importStorageSummary(): Promise<ImportStorageSummary> {
  const quotaBytes = getConfig().imports.storageQuotaBytes;
  const aggregate = await prisma.importSource.aggregate({ _sum: { bytesImported: true } });
  const usedBytes = Number(aggregate._sum.bytesImported ?? 0);
  return { usedBytes, quotaBytes, availableBytes: Math.max(0, quotaBytes - usedBytes) };
}

/* ------------------------------------------------------------ error mapping */

/**
 * A short, safe, operator-facing sentence for a thrown value. `AppError`
 * messages already read as user guidance; anything else is wrapped without ever
 * exposing a stack trace or an internal object.
 */
export function describeImportFailure(error: unknown): string {
  if (isAppError(error)) return error.message.slice(0, 500);
  if (error instanceof Error) {
    const message = error.message.trim();
    return message ? `Import failed: ${message.slice(0, 400)}` : "Import failed for an unknown reason.";
  }
  if (typeof error === "string" && error.trim()) return `Import failed: ${error.trim().slice(0, 400)}`;
  return "Import failed for an unknown reason.";
}

/* ------------------------------------------------------------- row shapes */

type SourceRow = {
  id: string;
  kind: ImportConnectorKind;
  sourceUrl: string;
  externalChannelId: string | null;
  title: string | null;
  status: ImportSourceStatus;
  authorizationBasis: string;
  scopeLimit: number;
  estimatedItems: number | null;
  bytesImported: bigint;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type ItemRow = {
  id: string;
  externalId: string;
  position: number;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  attribution: string | null;
  metadata: Prisma.JsonValue | null;
  status: ImportItemStatus;
  mediaAuthorized: boolean;
  attempts: number;
  lastError: string | null;
  videoId: string | null;
};

function emptyCounts(total: number): ImportCounts {
  return {
    total,
    pending: total,
    importing: 0,
    imported: 0,
    metadataOnly: 0,
    duplicates: 0,
    failed: 0,
  };
}

function countsFromItems(items: ReadonlyArray<{ status: ImportItemStatus }>): ImportCounts {
  const counts: ImportCounts = {
    total: items.length,
    pending: 0,
    importing: 0,
    imported: 0,
    metadataOnly: 0,
    duplicates: 0,
    failed: 0,
  };
  for (const item of items) {
    switch (item.status) {
      case "PENDING":
        counts.pending += 1;
        break;
      case "IMPORTING":
        counts.importing += 1;
        break;
      case "IMPORTED":
        counts.imported += 1;
        break;
      case "METADATA_ONLY":
        counts.metadataOnly += 1;
        break;
      case "SKIPPED_DUPLICATE":
        counts.duplicates += 1;
        break;
      case "FAILED":
        counts.failed += 1;
        break;
    }
  }
  return counts;
}

function toItemSummary(row: ItemRow, kind: ImportConnectorKind): ImportItemSummary {
  return {
    id: row.id,
    externalId: row.externalId,
    position: row.position,
    title: row.title,
    description: row.description,
    publishedAt: iso(row.publishedAt),
    durationSeconds: row.durationSeconds,
    thumbnailUrl: row.thumbnailUrl,
    attribution: row.attribution,
    canonicalUrl: canonicalUrlFor(kind, row.externalId, row.metadata),
    status: row.status,
    mediaAuthorized: row.mediaAuthorized,
    attempts: row.attempts,
    lastError: row.lastError,
    videoId: row.videoId,
  };
}

function toSourceSummary(row: SourceRow, counts: ImportCounts): ImportSourceSummary {
  return {
    id: row.id,
    kind: row.kind,
    sourceUrl: row.sourceUrl,
    externalChannelId: row.externalChannelId,
    title: row.title,
    status: row.status,
    authorizationBasis: row.authorizationBasis,
    scopeLimit: row.scopeLimit,
    estimatedItems: row.estimatedItems,
    counts,
    bytesImported: Number(row.bytesImported),
    limitations: limitationsFor(row.kind),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

/* ----------------------------------------------------------------- preview */

/**
 * Resolves and lists a source **without writing anything**. This is what the
 * administrator reviews before committing to an import, so it must be a pure
 * read of the connector plus (for a creator export) the stated media sizes.
 */
export async function previewImport(input: { input: string; scopeLimit: number }): Promise<{
  kind: ImportConnectorKind;
  title: string | null;
  externalChannelId: string | null;
  canonicalUrl: string;
  entries: ImportItemSummary[];
  limitations: string[];
  estimatedBytes: number;
}> {
  const limits = importLimits();
  const connector = connectorForInput(input.input);
  const ref = await connector.resolve(input.input);
  const result = await connector.listEntries(ref, {
    limit: clamp(input.scopeLimit, 1, limits.maxItems),
  });

  const entries = result.entries.map((entry) =>
    toItemSummary(
      {
        id: dedupeKeyFor(connector.kind, entry.externalId),
        externalId: entry.externalId,
        position: 0,
        title: entry.title,
        description: entry.description,
        publishedAt: entry.publishedAt,
        durationSeconds: entry.durationSeconds,
        thumbnailUrl: entry.thumbnailUrl,
        attribution: entry.attribution,
        metadata: { ...entry.extra, canonicalUrl: canonicalUrlFor(connector.kind, entry.externalId, null) },
        status: "PENDING",
        mediaAuthorized: false,
        attempts: 0,
        lastError: null,
        videoId: null,
      },
      connector.kind,
    ),
  );

  // A metadata-only connector holds no bytes at all — 0 is the honest value.
  // A creator export states its file sizes in the manifest, so the operator sees
  // the real total before committing; a missing referenced file surfaces here.
  let estimatedBytes = 0;
  const resolver = mediaResolverFor(connector);
  if (resolver) {
    for (const entry of result.entries) {
      const media = await resolver.resolveMedia(ref, entry);
      if (media) estimatedBytes += media.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    }
  }

  return {
    kind: connector.kind,
    title: ref.title,
    externalChannelId: ref.externalChannelId,
    canonicalUrl: ref.canonicalUrl,
    entries: entries.map((entry, index) => ({ ...entry, position: index })),
    limitations: result.limitations,
    estimatedBytes,
  };
}

/* ------------------------------------------------------------------ create */

/**
 * Persists a source and one item per resolved entry. This is the only write the
 * preview flow may lead to, and it records the operator's authorization basis
 * verbatim: copying original media without a documented basis is refused here,
 * not silently downgraded later.
 */
export async function createImportSource(input: {
  input: string;
  scopeLimit: number;
  authorizationBasis: string;
  mediaAuthorized: boolean;
  concurrency?: number;
  actor: ImportActor;
}): Promise<{ source: ImportSourceSummary; items: ImportItemSummary[]; limitations: string[] }> {
  const limits = importLimits();
  const connector = connectorForInput(input.input);
  const ref = await connector.resolve(input.input);
  const scopeLimit = clamp(input.scopeLimit, 1, limits.maxItems);
  const concurrency =
    input.concurrency === undefined ? Math.min(2, limits.maxConcurrency) : clamp(input.concurrency, 1, limits.maxConcurrency);

  const basis = input.authorizationBasis.trim();
  if (input.mediaAuthorized && basis.length < 10) {
    throw validationFailed(
      "Copying original media requires a documented authorization basis: state who authorized the copy and " +
        "on what terms (at least 10 characters). Without it the import can only record metadata.",
      { authorizationBasis: ["Describe the authorization in at least 10 characters, or import metadata only."] },
    );
  }
  const authorizationBasis = input.mediaAuthorized ? basis : basis || "metadata-only";

  const result = await connector.listEntries(ref, { limit: scopeLimit });
  if (result.entries.length === 0) {
    throw preconditionFailed("That source resolved to no entries, so there is nothing to import.");
  }

  const keys = result.entries.map((entry) => dedupeKeyFor(connector.kind, entry.externalId));
  const existing = await prisma.importItem.findMany({
    where: { dedupeKey: { in: keys }, status: "IMPORTED" },
    select: { dedupeKey: true, sourceId: true },
  });
  const importedByKey = new Map(existing.map((row) => [row.dedupeKey, row.sourceId]));

  const created = await prisma.$transaction(async (tx) => {
    const source = await tx.importSource.create({
      data: {
        kind: connector.kind,
        sourceUrl: input.input.trim(),
        externalChannelId: ref.externalChannelId,
        title: ref.title,
        authorizationBasis,
        scopeLimit,
        concurrency,
        status: "PREVIEW",
        estimatedItems: result.totalEstimate,
        createdById: input.actor.userId,
      },
    });

    await tx.importItem.createMany({
      data: result.entries.map((entry, index) => {
        const dedupeKey = dedupeKeyFor(connector.kind, entry.externalId);
        const duplicateOf = importedByKey.get(dedupeKey);
        return {
          sourceId: source.id,
          externalId: entry.externalId,
          dedupeKey,
          position: index,
          title: entry.title,
          description: entry.description,
          publishedAt: entry.publishedAt,
          durationSeconds: entry.durationSeconds,
          thumbnailUrl: entry.thumbnailUrl,
          attribution: entry.attribution,
          metadata: {
            ...entry.extra,
            canonicalUrl: canonicalUrlFor(connector.kind, entry.externalId, null),
          } as Prisma.InputJsonValue,
          status: duplicateOf ? ("SKIPPED_DUPLICATE" as const) : ("PENDING" as const),
          mediaAuthorized: input.mediaAuthorized,
          lastError: duplicateOf
            ? `Already imported by source ${duplicateOf}; not copied again.`
            : null,
        };
      }),
    });

    return source;
  });

  await recordAudit({
    actorUserId: input.actor.userId,
    actorLabel: input.actor.label,
    action: "import.source.create",
    targetType: "import_source",
    targetId: created.id,
    ip: input.actor.ip ?? null,
    userAgent: input.actor.userAgent ?? null,
    details: {
      kind: connector.kind,
      externalChannelId: ref.externalChannelId,
      scopeLimit,
      concurrency,
      mediaAuthorized: input.mediaAuthorized,
      estimatedItems: result.totalEstimate,
      returnedItems: result.entries.length,
      // Deliberately recorded under a key that is not blinded by the audit
      // redactor (which blanks any key containing "authorization").
      basis: authorizationBasis,
    },
  });

  const items = await loadItems(created.id);
  return {
    source: toSourceSummary(created, countsFromItems(items)),
    items: items.map((item) => toItemSummary(item, connector.kind)),
    limitations: result.limitations,
  };
}

/* ------------------------------------------------------------------- reads */

async function loadItems(sourceId: string): Promise<ItemRow[]> {
  return prisma.importItem.findMany({
    where: { sourceId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      externalId: true,
      position: true,
      title: true,
      description: true,
      publishedAt: true,
      durationSeconds: true,
      thumbnailUrl: true,
      attribution: true,
      metadata: true,
      status: true,
      mediaAuthorized: true,
      attempts: true,
      lastError: true,
      videoId: true,
    },
  });
}

export async function listImportSources(options?: { take?: number }): Promise<ImportSourceSummary[]> {
  const take = clamp(options?.take ?? 25, 1, 100);
  const sources = await prisma.importSource.findMany({ orderBy: { createdAt: "desc" }, take });
  if (sources.length === 0) return [];

  // One grouped query for every source's per-status counts rather than N
  // counts, so the list stays O(1) round trips as the history grows.
  const grouped = await prisma.importItem.groupBy({
    by: ["sourceId", "status"],
    where: { sourceId: { in: sources.map((source) => source.id) } },
    _count: { _all: true },
  });

  const bySource = new Map<string, ImportCounts>();
  for (const row of grouped) {
    const counts = bySource.get(row.sourceId) ?? emptyCounts(0);
    counts.total += row._count._all;
    switch (row.status) {
      case "PENDING":
        counts.pending += row._count._all;
        break;
      case "IMPORTING":
        counts.importing += row._count._all;
        break;
      case "IMPORTED":
        counts.imported += row._count._all;
        break;
      case "METADATA_ONLY":
        counts.metadataOnly += row._count._all;
        break;
      case "SKIPPED_DUPLICATE":
        counts.duplicates += row._count._all;
        break;
      case "FAILED":
        counts.failed += row._count._all;
        break;
    }
    bySource.set(row.sourceId, counts);
  }

  return sources.map((source) => toSourceSummary(source, bySource.get(source.id) ?? emptyCounts(0)));
}

export async function getImportSource(
  id: string,
): Promise<{ source: ImportSourceSummary; items: ImportItemSummary[] } | null> {
  const source = await prisma.importSource.findUnique({ where: { id } });
  if (!source) return null;
  const items = await loadItems(id);
  return {
    source: toSourceSummary(source, countsFromItems(items)),
    items: items.map((item) => toItemSummary(item, source.kind)),
  };
}

/* --------------------------------------------------------------------- run */

const CLAIMABLE: ImportSourceStatus[] = ["PREVIEW", "DRAFT", "COMPLETED", "FAILED", "CANCELLED", "PAUSED"];

/** Recomputes the denormalised counters from the item rows in one query. */
async function recomputeCounts(sourceId: string): Promise<ImportCounts> {
  const grouped = await prisma.importItem.groupBy({
    by: ["status"],
    where: { sourceId },
    _count: { _all: true },
  });
  const counts: ImportCounts = {
    total: 0,
    pending: 0,
    importing: 0,
    imported: 0,
    metadataOnly: 0,
    duplicates: 0,
    failed: 0,
  };
  for (const row of grouped) {
    counts.total += row._count._all;
    switch (row.status) {
      case "PENDING":
        counts.pending += row._count._all;
        break;
      case "IMPORTING":
        counts.importing += row._count._all;
        break;
      case "IMPORTED":
        counts.imported += row._count._all;
        break;
      case "METADATA_ONLY":
        counts.metadataOnly += row._count._all;
        break;
      case "SKIPPED_DUPLICATE":
        counts.duplicates += row._count._all;
        break;
      case "FAILED":
        counts.failed += row._count._all;
        break;
    }
  }
  await prisma.importSource.update({
    where: { id: sourceId },
    data: {
      processedItems: counts.total - counts.pending - counts.importing,
      importedItems: counts.imported,
      metadataOnlyItems: counts.metadataOnly,
      duplicateItems: counts.duplicates,
      failedItems: counts.failed,
    },
  });
  return counts;
}

async function summaryOf(sourceId: string): Promise<ImportSourceSummary> {
  const source = await prisma.importSource.findUniqueOrThrow({ where: { id: sourceId } });
  const counts = await recomputeCounts(sourceId);
  return toSourceSummary(source, counts);
}

interface ItemOutcome {
  status: ImportItemStatus;
  lastError?: string | null;
  videoId?: string | null;
  mediaSourceKey?: string | null;
  bytes?: number;
}

/**
 * Runs one item. Throws only when media copying fails, so the caller can retry;
 * a metadata-only outcome is a normal return.
 */
async function attemptItem(
  source: { id: string; kind: ImportConnectorKind; createdById: string | null },
  item: ItemRow,
  context: {
    resolver: ReturnType<typeof mediaResolverFor>;
    ref: ChannelRef | null;
    channelId: string | null;
  },
): Promise<ItemOutcome> {
  if (!item.mediaAuthorized) {
    return {
      status: "METADATA_ONLY",
      lastError: "Metadata only: this import has no authorization basis for copying original media.",
    };
  }
  if (!context.resolver) {
    return {
      status: "METADATA_ONLY",
      lastError: "Metadata only: this connector cannot supply media, so no bytes were copied.",
    };
  }
  if (!context.ref) throw preconditionFailed("The source could not be re-resolved before copying media.");
  if (!context.channelId) {
    throw preconditionFailed(
      "The account that created this import has no channel, so imported media cannot be attributed.",
    );
  }

  const entry: ConnectorEntry = {
    externalId: item.externalId,
    title: item.title,
    description: item.description,
    publishedAt: item.publishedAt,
    durationSeconds: item.durationSeconds,
    thumbnailUrl: item.thumbnailUrl,
    canonicalUrl: canonicalUrlFor(source.kind, item.externalId, item.metadata),
    attribution: item.attribution ?? "",
    extra: {},
  };

  const media = await context.resolver.resolveMedia(context.ref, entry);
  if (!media) {
    return {
      status: "METADATA_ONLY",
      lastError: "The export contained no media for this entry.",
    };
  }

  const copied = await copyMedia(source, item, media, context.channelId);

  await tryRecordAudit({
    action: "import.item.media_imported",
    targetType: "import_item",
    targetId: item.id,
    details: {
      sourceId: source.id,
      videoId: copied.videoId,
      bytes: copied.bytes,
      assets: copied.assets,
    },
  });

  return {
    status: "IMPORTED",
    videoId: copied.videoId,
    mediaSourceKey: copied.playbackKey,
    bytes: copied.bytes,
  };
}

/** The media path only ever runs for the authorized creator-export connector. */
async function copyMedia(
  source: { id: string; kind: ImportConnectorKind; createdById: string | null },
  item: ItemRow,
  media: ResolvedMedia,
  channelId: string,
): Promise<{ videoId: string; bytes: number; assets: number; playbackKey: string | null }> {
  const uploaderId = source.createdById;
  if (!uploaderId) throw preconditionFailed("The account that created this import no longer exists.");

  // Audio for a *video* has no representation in the schema: `VideoAsset` has no
  // audio kind, and `Track` models a DEX music release with its own rights row.
  // Rather than silently drop the track (which would misrepresent the export),
  // the entry fails loudly.
  if (media.assets.some((asset) => asset.role === "audio")) {
    throw preconditionFailed(
      "This export supplies a separate video audio track, which DEXTube's video model cannot store " +
        "(there is no audio-track kind on VideoAsset). The entry was not imported rather than losing the track.",
    );
  }

  const declaredBytes = media.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  await assertWithinStorageQuota(declaredBytes);

  const video = await prisma.video.create({
    data: {
      channelId,
      uploaderId,
      title: item.title.slice(0, 300) || "Imported entry",
      description: item.description ?? "",
      // Imported media is never auto-published: the operator reviews it first.
      visibility: "PRIVATE",
      status: "PROCESSING",
      // Stated as the export wrote it; never probed or guessed.
      durationSec: item.durationSeconds ?? 0,
      sourceFilename: null,
    },
    select: { id: true },
  });

  const storage = getStorage();
  try {
    const placed: Array<{
      asset: ResolvedMediaAsset;
      key: string;
      size: number;
      mimeType: string;
    }> = [];
    for (const [index, asset] of media.assets.entries()) {
      const mimeType = mimeForExtension(asset.absolutePath);
      const extension =
        extensionFor(mimeType, path.extname(asset.absolutePath).replace(".", "").toLowerCase() || "bin") || "bin";
      const { folder, base } = keyParts(asset, index);
      const key = buildKey("videos", video.id, folder, `${base}.${extension}`);
      const stored = await storage.put(key, createReadStream(asset.absolutePath));
      placed.push({ asset, key, size: stored.size, mimeType });
    }

    const sourceAsset = placed.find((entry) => entry.asset.role === "source");
    const renditions = placed.filter((entry) => entry.asset.role === "rendition");
    const thumbnail = placed.find((entry) => entry.asset.role === "thumbnail");
    const poster = placed.find((entry) => entry.asset.role === "poster");
    const totalBytes = placed.reduce((sum, entry) => sum + entry.size, 0);

    // Prefer the export's own source file for playback; otherwise use the
    // tallest stated rendition. Nothing is transcoded or re-encoded.
    const tallest = [...renditions].sort(
      (a, b) => (b.asset.height ?? 0) - (a.asset.height ?? 0),
    )[0];
    const playbackKey = sourceAsset?.key ?? tallest?.key ?? null;

    await prisma.$transaction(async (tx) => {
      await tx.videoAsset.createMany({
        data: placed.map((entry) => ({
          videoId: video.id,
          kind: assetKind(entry.asset.role),
          label: assetLabel(entry.asset),
          storageKey: entry.key,
          mimeType: entry.mimeType,
          width: entry.asset.width ?? null,
          height: entry.asset.height ?? null,
          sizeBytes: BigInt(entry.size),
        })),
      });
      await tx.video.update({
        where: { id: video.id },
        data: {
          status: "READY",
          playbackKey,
          originalKey: sourceAsset?.key ?? null,
          thumbnailKey: thumbnail?.key ?? null,
          posterKey: poster?.key ?? null,
          sizeBytes: BigInt(totalBytes),
          mimeType: sourceAsset?.mimeType ?? null,
        },
      });
    });

    log.info("imported media", {
      sourceId: source.id,
      itemId: item.id,
      videoId: video.id,
      bytes: totalBytes,
      assets: placed.length,
    });

    return { videoId: video.id, bytes: totalBytes, assets: placed.length, playbackKey };
  } catch (error) {
    // The video never reached READY; remove the half-written row and its files
    // so a retry starts clean and no orphan storage is left behind.
    await prisma.video.delete({ where: { id: video.id } }).catch(() => {});
    await storage.deletePrefix(buildKey("videos", video.id)).catch(() => {});
    throw error;
  }
}

function assetKind(role: ResolvedMediaAsset["role"]): "ORIGINAL" | "PROGRESSIVE" | "THUMBNAIL" | "CAPTION" {
  switch (role) {
    case "source":
      return "ORIGINAL";
    case "rendition":
      return "PROGRESSIVE";
    case "subtitle":
      return "CAPTION";
    default:
      return "THUMBNAIL";
  }
}

function assetLabel(asset: ResolvedMediaAsset): string {
  switch (asset.role) {
    case "source":
      return "Imported source";
    case "rendition":
      return asset.label ?? (asset.height ? `${asset.height}p` : "Imported rendition");
    case "poster":
      return "Poster";
    case "thumbnail":
      return "Thumbnail";
    case "subtitle":
      return asset.label ?? asset.language ?? "Captions";
    default:
      return asset.role;
  }
}

function keyParts(asset: ResolvedMediaAsset, index: number): { folder: string; base: string } {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "asset";
  switch (asset.role) {
    case "source":
      return { folder: "source", base: "original" };
    case "rendition":
      return { folder: "playback", base: safe(asset.label ?? (asset.height ? `${asset.height}p` : `rendition-${index}`)) };
    case "poster":
      return { folder: "thumbs", base: "poster" };
    case "thumbnail":
      return { folder: "thumbs", base: "default" };
    case "subtitle":
      return { folder: "captions", base: safe(asset.label ?? asset.language ?? `track-${index}`) };
    default:
      return { folder: "source", base: `asset-${index}` };
  }
}

/**
 * A coarse, per-instance ceiling: the sum of everything every import has copied
 * so far, not a per-source allocation. It exists to stop one runaway import
 * filling the disk, and is documented as approximate rather than pretending to
 * be a fair-share scheduler.
 */
async function assertWithinStorageQuota(additionalBytes: number): Promise<void> {
  const quota = getConfig().imports.storageQuotaBytes;
  const aggregate = await prisma.importSource.aggregate({ _sum: { bytesImported: true } });
  const used = Number(aggregate._sum.bytesImported ?? 0);
  if (used + additionalBytes > quota) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Copying this entry would exceed the configured import storage ceiling ` +
        `(${quota} bytes total, ${used} already imported). Raise STORAGE_QUOTA_BYTES or remove an earlier import.`,
    );
  }
}

/**
 * Runs an import, processing only the remaining `PENDING` items.
 *
 * Resumable by design: re-running a `COMPLETED`/`FAILED`/`CANCELLED` source
 * picks up exactly where it stopped, and the `(sourceId, dedupeKey)` unique
 * index is the final backstop against a duplicated item. The run is claimed with
 * a single conditional `updateMany`, so a second caller gets a `CONFLICT` rather
 * than racing the first.
 */
export async function runImportSource(id: string, actor: ImportActor): Promise<ImportSourceSummary> {
  const source = await prisma.importSource.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      sourceUrl: true,
      createdById: true,
      concurrency: true,
    },
  });
  if (!source) throw notFound("That import source does not exist.");

  const claim = await prisma.importSource.updateMany({
    where: { id, status: { in: CLAIMABLE } },
    data: { status: "RUNNING", cancelRequestedAt: null, lastError: null },
  });
  if (claim.count === 0) throw conflict("This import is already running.");

  try {
    const items = await loadItems(id);
    const pending = items.filter((item) => item.status === "PENDING");

    const connector = getConnector(source.kind);
    const resolver = mediaResolverFor(connector);
    const mediaItems = pending.some((item) => item.mediaAuthorized) && resolver ? pending : [];
    let ref: ChannelRef | null = null;
    let channelId: string | null = null;
    if (mediaItems.length > 0) {
      // Only a creator export reaches this branch (YouTube is metadata-only);
      // resolving here re-reads the manifest once for the whole run.
      ref = await connector.resolve(source.sourceUrl);
      channelId = source.createdById ? await requireOwnedChannelId(source.createdById) : null;
    }

    let cancelled = false;
    await mapPool(pending, clamp(source.concurrency, 1, importLimits().maxConcurrency), async (item) => {
      const fresh = await prisma.importSource.findUnique({
        where: { id },
        select: { cancelRequestedAt: true },
      });
      if (fresh?.cancelRequestedAt) {
        cancelled = true;
        return;
      }

      await prisma.importItem.update({ where: { id: item.id }, data: { status: "IMPORTING" } });

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const outcome = await attemptItem(source, item, { resolver, ref, channelId });
          await prisma.importItem.update({
            where: { id: item.id },
            data: {
              status: outcome.status,
              attempts: attempt,
              lastError: outcome.lastError ?? null,
              videoId: outcome.videoId ?? null,
              mediaSourceKey: outcome.mediaSourceKey ?? null,
            },
          });
          if (outcome.bytes) {
            await prisma.importSource.update({
              where: { id },
              data: { bytesImported: { increment: BigInt(outcome.bytes) } },
            });
          }
          return;
        } catch (error) {
          if (attempt < 3) continue;
          await prisma.importItem.update({
            where: { id: item.id },
            data: { status: "FAILED", attempts: attempt, lastError: describeImportFailure(error) },
          });
          log.warn("import item failed", { sourceId: id, itemId: item.id, err: describeImportFailure(error) });
        }
      }
    });

    const after = await prisma.importSource.findUnique({
      where: { id },
      select: { cancelRequestedAt: true },
    });
    const counts = await recomputeCounts(id);

    if (cancelled || after?.cancelRequestedAt) {
      await prisma.importSource.update({ where: { id }, data: { status: "CANCELLED" } });
      await recordAudit({
        actorUserId: actor.userId,
        actorLabel: actor.label,
        action: "import.source.cancel",
        targetType: "import_source",
        targetId: id,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        details: { counts, reason: "operator requested cancellation" },
      });
      return summaryOf(id);
    }

    // "Every item failed and there was no other outcome" is a failed run; a mix
    // that produced some metadata or some imports is a completed run that reports
    // its failures honestly.
    const allFailed = counts.total > 0 && counts.failed === counts.total;
    const status: ImportSourceStatus = allFailed ? "FAILED" : "COMPLETED";
    const lastError =
      counts.failed > 0
        ? `${counts.failed} of ${counts.total} entries failed; see each entry's error for details.`
        : null;
    await prisma.importSource.update({
      where: { id },
      data: { status, completedAt: new Date(), lastError },
    });

    await recordAudit({
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: "import.source.complete",
      targetType: "import_source",
      targetId: id,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      details: { status, counts },
    });

    return summaryOf(id);
  } catch (error) {
    // A failure outside the per-item retry loop (e.g. re-resolving the source)
    // must not leave the source wedged in RUNNING.
    await prisma.importSource
      .update({ where: { id }, data: { status: "FAILED", lastError: describeImportFailure(error) } })
      .catch(() => {});
    throw error;
  }
}

/** A tiny bounded worker pool: `concurrency` workers share one index. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(workers);
}

/* ------------------------------------------------------------- operations */

/** Flips failed items back to pending and resumes the run. */
export async function retryFailedImportItems(id: string, actor: ImportActor): Promise<ImportSourceSummary> {
  const source = await prisma.importSource.findUnique({ where: { id }, select: { status: true } });
  if (!source) throw notFound("That import source does not exist.");
  if (source.status === "RUNNING") {
    throw conflict("This import is still running. Wait for it to stop before retrying failed entries.");
  }

  const reset = await prisma.importItem.updateMany({
    where: { sourceId: id, status: "FAILED" },
    data: { status: "PENDING", lastError: null },
  });

  await recordAudit({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "import.source.retry",
    targetType: "import_source",
    targetId: id,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    details: { resetItems: reset.count },
  });

  return runImportSource(id, actor);
}

/**
 * Requests cancellation.
 *
 * `runImportSource` only reads the flag between items, so a run in progress does
 * not stop mid-item; it finishes the current entry and then stops, which is why
 * an already-running import may still show one more item complete after this
 * returns. When the source is not running there is nothing to interrupt, so the
 * status flips to `CANCELLED` immediately.
 */
export async function cancelImportSource(id: string, actor: ImportActor): Promise<ImportSourceSummary> {
  const source = await prisma.importSource.findUnique({ where: { id }, select: { status: true } });
  if (!source) throw notFound("That import source does not exist.");

  await prisma.importSource.update({ where: { id }, data: { cancelRequestedAt: new Date() } });
  if (source.status !== "RUNNING") {
    await prisma.importSource.update({ where: { id }, data: { status: "CANCELLED" } });
  }

  await recordAudit({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "import.source.cancel",
    targetType: "import_source",
    targetId: id,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    details: { wasRunning: source.status === "RUNNING" },
  });

  return summaryOf(id);
}

/**
 * Deletes a source and its items.
 *
 * By default the videos an import created are **kept** (they are ordinary
 * DEXTube videos now); `deleteImportedVideos` opts into removing each with the
 * same `deleteVideo` service the Studio uses, which soft-deletes the row and
 * queues the media purge. That is the documented cleanup path for assets a test
 * or an operator knowingly created.
 */
export async function deleteImportSource(
  id: string,
  actor: ImportActor,
  options?: { deleteImportedVideos?: boolean },
): Promise<{ deleted: true; removedItems: number; keptVideos: number; deletedVideos: number }> {
  const source = await prisma.importSource.findUnique({
    where: { id },
    select: { id: true, items: { select: { videoId: true } } },
  });
  if (!source) throw notFound("That import source does not exist.");

  const videoIds = source.items
    .map((item) => item.videoId)
    .filter((videoId): videoId is string => Boolean(videoId));

  let deletedVideos = 0;
  if (options?.deleteImportedVideos) {
    for (const videoId of videoIds) {
      const video = await prisma.video.findUnique({
        where: { id: videoId },
        select: { channel: { select: { ownerId: true } } },
      });
      if (!video) continue;
      try {
        await deleteVideo(videoId, video.channel.ownerId, true);
      } catch {
        // The owning account may be gone; fall back to a direct row removal.
        await prisma.video.delete({ where: { id: videoId } }).catch(() => {});
      }
      deletedVideos += 1;
    }
  }

  await prisma.importSource.delete({ where: { id } });

  await recordAudit({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "import.source.delete",
    targetType: "import_source",
    targetId: id,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    details: {
      removedItems: source.items.length,
      deleteImportedVideos: Boolean(options?.deleteImportedVideos),
      deletedVideos,
    },
  });

  return {
    deleted: true,
    removedItems: source.items.length,
    keptVideos: options?.deleteImportedVideos ? 0 : videoIds.length,
    deletedVideos,
  };
}
