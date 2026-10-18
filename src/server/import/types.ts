/**
 * The connector contract for authorized channel / playlist migration.
 *
 * DEXTube separates two questions that are easy to conflate:
 *
 *   1. **What does the provider say exists?** — answered by a
 *      {@link MetadataConnector}. Several sources can do this: an official API,
 *      an official public feed, a creator's own export.
 *   2. **May we copy the bytes?** — answered by a {@link MediaResolver}. It
 *      returns a local file only when the operator has recorded an
 *      authorization basis *and* the material is actually on hand.
 *
 * A metadata-only connector is a first-class citizen, not a failure: it is the
 * honest state of affairs for a channel DEXTube has no permission to copy.
 * Nothing in this codebase ever fabricates a media file, a download result or a
 * creator identity.
 */
import "server-only";
import type { ImportConnectorKind } from "@prisma/client";

/** One entry as the provider describes it, after sanitisation. */
export interface ConnectorEntry {
  /** Provider-side id (a YouTube video id, for example). Never invented. */
  externalId: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  /** Null when the provider did not state it; never guessed. */
  durationSeconds: number | null;
  /** Reference URL only — the image is not downloaded unless media is authorized. */
  thumbnailUrl: string | null;
  canonicalUrl: string;
  /** Credit line that must appear wherever the entry is shown. */
  attribution: string;
  /** A few extra provider fields, already sanitised and size-bounded. */
  extra: Record<string, unknown>;
}

/** A resolved channel or playlist identity. */
export interface ChannelRef {
  kind: ImportConnectorKind;
  externalChannelId: string | null;
  title: string | null;
  canonicalUrl: string;
  /**
   * The provider id a playlist uses, when the source is a playlist rather than
   * a channel. Kept separate so the two are never confused downstream.
   */
  externalPlaylistId?: string | null;
}

export interface ListOptions {
  /** Hard cap for this page; the connector may return fewer. */
  limit: number;
  cursor?: string | null;
}

export interface ListResult {
  entries: ConnectorEntry[];
  nextCursor: string | null;
  /**
   * Best-effort count of how many entries the source holds, when the provider
   * states it. Null means "unknown", never a fabricated number.
   */
  totalEstimate: number | null;
  /**
   * Limitations the operator should see before running an import — for example
   * "this public feed only exposes the latest 15 entries".
   */
  limitations: string[];
}

/** The kind of file a resolver handed back. */
export type MediaAssetRole = "source" | "rendition" | "poster" | "thumbnail" | "subtitle" | "audio";

/** One authorized file, with everything needed to register it faithfully. */
export interface ResolvedMediaAsset {
  /** Absolute path on the operator's disk, inside the configured export root. */
  absolutePath: string;
  bytes: number;
  role: MediaAssetRole;
  /** Human label (rendition name, track title). */
  label?: string;
  /** BCP-47 language for audio/subtitle tracks, as the export states it. */
  language?: string;
  /** Subtitle kind, as `<track kind>` expects. */
  kind?: "subtitles" | "captions" | "descriptions";
  /** Declared video dimensions for a rendition. Absent means "not stated". */
  height?: number;
  width?: number;
  /** True when this asset is the entry's default track. */
  isDefault?: boolean;
}

/**
 * Authorized media for one entry. DEXTube copies `assets` only when this object
 * exists *and* the import source records an authorization basis; a resolver that
 * cannot supply anything returns null rather than a partial, guessed set.
 */
export interface ResolvedMedia {
  assets: ResolvedMediaAsset[];
  /** The basis supplied with the export, recorded verbatim in the audit trail. */
  basis: string;
  /** Where it came from (manifest path), for the audit trail. */
  source: string;
}

export interface MetadataConnector {
  readonly kind: ImportConnectorKind;
  readonly displayName: string;
  /** One sentence an administrator can read before trusting this connector. */
  readonly capabilityNote: string;
  /** Hosts this connector contacts. Feeds the SSRF allowlist. */
  readonly allowedHosts: readonly string[];
  /** True when the connector can ever supply bytes (only creator exports can). */
  readonly canSupplyMedia: boolean;
  /** Turns a pasted URL or id into a provider identity. */
  resolve(input: string): Promise<ChannelRef>;
  /** Lists entries, newest first, bounded by `options.limit`. */
  listEntries(ref: ChannelRef, options: ListOptions): Promise<ListResult>;
}

/** A source of *authorized* bytes for a metadata entry. */
export interface MediaResolver {
  readonly name: string;
  resolveMedia(ref: ChannelRef, entry: ConnectorEntry): Promise<ResolvedMedia | null>;
}
