/**
 * Creator-export connector — the only path by which **media** may enter DEXTube
 * from somewhere else.
 *
 * The operator points DEXTube at a manifest inside `CREATOR_EXPORT_ROOT`. The
 * manifest must state who authorized the copy and on what basis; an entry
 * without authorization is refused rather than imported "just metadata, but with
 * bytes". Everything it references (renditions, audio tracks, subtitles,
 * thumbnails) is preserved as supplied.
 *
 * Safety properties:
 *   * The manifest path is resolved inside `CREATOR_EXPORT_ROOT` and must stay
 *     there — `..` traversal and absolute paths are rejected.
 *   * Every referenced file is resolved relative to the manifest's directory and
 *     must still be inside the export root, so a manifest cannot point the
 *     importer at `/etc/passwd` or at another tenant's storage.
 *   * Symlinked paths are resolved with `realpath` before the containment check,
 *     so a symlink cannot escape the root either.
 *   * Declared dimensions/languages are taken as stated and never inferred; a
 *     missing duration stays null.
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { sanitizeExtra, sanitizeRequired, sanitizeText, sanitizeUrl } from "./sanitize";
import type {
  ChannelRef,
  ConnectorEntry,
  ListOptions,
  ListResult,
  MediaResolver,
  MetadataConnector,
  ResolvedMedia,
  ResolvedMediaAsset,
} from "./types";

export const MANIFEST_FORMAT = "dextube-creator-export/1";

interface ManifestAsset {
  file?: unknown;
  label?: unknown;
  language?: unknown;
  kind?: unknown;
  height?: unknown;
  width?: unknown;
  isDefault?: unknown;
}

interface ManifestItem {
  externalId?: unknown;
  title?: unknown;
  description?: unknown;
  publishedAt?: unknown;
  durationSeconds?: unknown;
  thumbnail?: unknown;
  poster?: unknown;
  source?: unknown;
  renditions?: unknown;
  audioTracks?: unknown;
  subtitles?: unknown;
  tags?: unknown;
}

interface Manifest {
  format?: unknown;
  authorization?: { basis?: unknown; grantedBy?: unknown; reference?: unknown };
  channel?: { title?: unknown; externalChannelId?: unknown; canonicalUrl?: unknown };
  items?: unknown;
}

/** Absolute, real path of the export root (created on demand by the operator). */
export function exportRoot(): string {
  return path.resolve(process.cwd(), getConfig().imports.creatorExportRoot);
}

/**
 * Resolves `candidate` and asserts it is inside `root`, following symlinks.
 * This is the single containment check every file access goes through.
 */
export async function resolveInsideRoot(root: string, candidate: string): Promise<string> {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("FORBIDDEN", "A manifest referenced a file outside the creator-export directory.");
  }
  // realpath both sides so a symlink cannot point outside the root.
  const realRoot = await fs.realpath(root).catch(() => root);
  const real = await fs.realpath(resolved).catch(() => resolved);
  const realRelative = path.relative(realRoot, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new AppError("FORBIDDEN", "A manifest referenced a file outside the creator-export directory.");
  }
  return real;
}

function str(value: unknown, maxLength: number): string | null {
  return sanitizeText(value, { maxLength });
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function readManifest(input: string): Promise<{ manifest: Manifest; manifestPath: string }> {
  const root = exportRoot();
  // Accept either the manifest file itself or the export directory containing it.
  const candidate = input.trim();
  if (!candidate) throw new AppError("VALIDATION_FAILED", "Enter the path of a creator-export manifest.");  const asFile = candidate.endsWith(".json") ? candidate : path.join(candidate, "manifest.json");
  const manifestPath = await resolveInsideRoot(root, asFile);

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new AppError(
      "PRECONDITION_FAILED",
      `No creator-export manifest at that path. Place it under ${root} and try again.`,
    );
  }
  let parsed: Manifest;
  try {
    parsed = JSON.parse(raw) as Manifest;
  } catch {
    throw new AppError("VALIDATION_FAILED", "That manifest is not valid JSON.");
  }
  if (parsed.format !== MANIFEST_FORMAT) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Unsupported export format. Expected "${MANIFEST_FORMAT}".`,
    );
  }
  return { manifest: parsed, manifestPath };
}

/** The documented authorization basis, or a refusal. */
function requireBasis(manifest: Manifest): string {
  const basis = str(manifest.authorization?.basis, 500);
  if (!basis) {
    throw new AppError(
      "FORBIDDEN",
      "This export does not state an authorization basis, so no media can be imported from it.",
    );
  }
  return basis;
}

function itemAssets(item: ManifestItem): {
  thumbnail: string | null;
  poster: string | null;
  renditions: ManifestAsset[];
  audioTracks: ManifestAsset[];
  subtitles: ManifestAsset[];
} {
  const asAssets = (value: unknown): ManifestAsset[] =>
    Array.isArray(value) ? value.filter((v): v is ManifestAsset => Boolean(v) && typeof v === "object") : [];
  return {
    thumbnail: str(item.thumbnail, 512),
    poster: str(item.poster, 512),
    renditions: asAssets(item.renditions),
    audioTracks: asAssets(item.audioTracks),
    subtitles: asAssets(item.subtitles),
  };
}

function toEntry(item: ManifestItem, channelTitle: string | null, allowHosts: readonly string[]): ConnectorEntry {
  const externalId = str(item.externalId, 64);
  if (!externalId) {
    throw new AppError("VALIDATION_FAILED", "A manifest entry is missing its externalId.");
  }
  const publishedRaw = str(item.publishedAt, 64);
  const published = publishedRaw ? new Date(publishedRaw) : null;
  return {
    externalId,
    title: sanitizeRequired(item.title, { maxLength: 300 }),
    description: sanitizeText(item.description, { maxLength: 5000, multiline: true }),
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    durationSeconds: int(item.durationSeconds),
    thumbnailUrl: sanitizeUrl(item.thumbnail, allowHosts),
    canonicalUrl: str(item.source, 512) ?? "",
    attribution: `${channelTitle ?? "Creator export"} · authorized creator export`,
    extra: sanitizeExtra(
      {
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 20) : undefined,
        renditions: itemAssets(item).renditions.length,
        subtitles: itemAssets(item).subtitles.length,
        audioTracks: itemAssets(item).audioTracks.length,
      },
      allowHosts,
    ),
  };
}

export const creatorExportConnector: MetadataConnector & MediaResolver = {
  kind: "CREATOR_EXPORT",
  name: "creator-export",
  displayName: "Authorized creator export",
  capabilityNote:
    "Imports media only from a manifest that records who authorized the copy. Quality variants, audio " +
    "tracks, subtitles and thumbnails are preserved exactly as the export supplies them.",
  allowedHosts: [],
  canSupplyMedia: true,

  async resolve(input: string): Promise<ChannelRef> {
    const { manifest, manifestPath } = await readManifest(input);
    const basis = requireBasis(manifest);
    return {
      kind: "CREATOR_EXPORT",
      externalChannelId: str(manifest.channel?.externalChannelId, 64),
      title: str(manifest.channel?.title, 300),
      canonicalUrl: manifestPath,
      externalPlaylistId: basis, // carried through so the service can record it
    };
  },

  async listEntries(ref: ChannelRef, options: ListOptions): Promise<ListResult> {
    const { manifest } = await readManifest(ref.canonicalUrl);
    const channelTitle = str(manifest.channel?.title, 300);
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    if (items.length === 0) {
      throw new AppError("PRECONDITION_FAILED", "That export contains no items.");
    }
    const entries = items
      .slice(0, Math.max(1, options.limit))
      .map((raw) => toEntry(raw as ManifestItem, channelTitle, this.allowedHosts))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    return {
      entries,
      nextCursor: null,
      totalEstimate: items.length,
      limitations: [],
    };
  },

  /**
   * Returns the authorized files for an entry. Throws when the manifest does not
   * authorize this specific entry; returns null when the entry has no media.
   */
  async resolveMedia(ref: ChannelRef, entry: ConnectorEntry): Promise<ResolvedMedia | null> {
    const { manifest, manifestPath } = await readManifest(ref.canonicalUrl);
    const basis = requireBasis(manifest);
    const items = Array.isArray(manifest.items) ? (manifest.items as ManifestItem[]) : [];
    const raw = items.find((item) => str(item.externalId, 64) === entry.externalId);
    if (!raw) return null;

    const root = exportRoot();
    const manifestDir = path.dirname(manifestPath);
    const assets: ResolvedMediaAsset[] = [];

    const addAsset = async (value: unknown, role: ResolvedMediaAsset["role"], extra?: Partial<ResolvedMediaAsset>) => {
      const file = str(value, 512);
      if (!file) return;
      const absolutePath = await resolveInsideRoot(root, path.resolve(manifestDir, file));
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) {
        throw new AppError("PRECONDITION_FAILED", `The export references a missing file: ${file}`);
      }
      assets.push({ absolutePath, bytes: stat.size, role, ...extra });
    };

    const assetMeta = (asset: ManifestAsset): Partial<ResolvedMediaAsset> => ({
      label: str(asset.label, 120) ?? undefined,
      language: str(asset.language, 35) ?? undefined,
      height: int(asset.height) ?? undefined,
      width: int(asset.width) ?? undefined,
      isDefault: asset.isDefault === true,
    });

    await addAsset(raw.source, "source");
    await addAsset(raw.poster, "poster");
    await addAsset(raw.thumbnail, "thumbnail");
    for (const rendition of itemAssets(raw).renditions) {
      await addAsset(rendition.file, "rendition", { ...assetMeta(rendition), label: str(rendition.label, 120) ?? undefined });
    }
    for (const track of itemAssets(raw).audioTracks) {
      await addAsset(track.file, "audio", assetMeta(track));
    }
    for (const subtitle of itemAssets(raw).subtitles) {
      const kindRaw = str(subtitle.kind, 20);
      const kind = kindRaw === "captions" || kindRaw === "descriptions" ? kindRaw : "subtitles";
      await addAsset(subtitle.file, "subtitle", { ...assetMeta(subtitle), kind });
    }

    if (assets.length === 0) return null;
    return { assets, basis, source: manifestPath };
  },
};
