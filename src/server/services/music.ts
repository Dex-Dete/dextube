/**
 * DEX Music service.
 *
 * Audio tracks are owned by a channel, exactly like videos, and every access
 * rule lives here so a route handler or page can never bypass it:
 *
 *   * browsing the library lists PUBLIC, non-deleted tracks only;
 *   * fetching one track enforces the same visibility rule the media route
 *     enforces for the bytes (PUBLIC/UNLISTED = anyone with the link, PRIVATE =
 *     the owning channel, moderators and admins);
 *   * **downloading** additionally requires the track's rights metadata to say
 *     `downloadAllowed`. Playback and download are deliberately separate
 *     permissions — a licence can allow streaming while forbidding copies.
 *
 * The bytes themselves are served by the existing `/api/media/...` route, which
 * calls `authorizeTrackDownload()` for `tracks/` keys. There is no second
 * media-serving path.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import type { Prisma } from "@prisma/client";
import type { TrackDTO, TrackRightsDTO } from "@/lib/dto";

/** Who is asking. Mirrors the viewer context the rest of the app passes around. */
export interface MusicViewer {
  channelId: string | null;
  role: "USER" | "MODERATOR" | "ADMIN";
}

export const MUSIC_PAGE_SIZE_DEFAULT = 24;
/** Hard cap enforced here, not only at the request schema, so no caller can widen it. */
export const MUSIC_PAGE_SIZE_MAX = 60;

const TRACK_SELECT = {
  id: true,
  title: true,
  artist: true,
  album: true,
  durationSec: true,
  visibility: true,
  audioKey: true,
  channel: { select: { id: true, handle: true, name: true, avatarKey: true } },
  rights: {
    select: { source: true, license: true, attribution: true, territory: true, downloadAllowed: true },
  },
} as const satisfies Prisma.TrackSelect;

type TrackRow = Prisma.TrackGetPayload<{ select: typeof TRACK_SELECT }>;

function toRightsDTO(rights: TrackRow["rights"]): TrackRightsDTO | null {
  if (!rights) return null;
  return {
    source: rights.source,
    license: rights.license,
    attribution: rights.attribution,
    territory: rights.territory,
    downloadAllowed: rights.downloadAllowed,
  };
}

function toTrackDTO(row: TrackRow): TrackDTO {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationSec: row.durationSec,
    visibility: row.visibility,
    audioKey: row.audioKey,
    channel: row.channel,
    rights: toRightsDTO(row.rights),
  };
}

export interface TrackPage {
  items: TrackDTO[];
  /** Offset for the next page, or `null` when this is the last one. */
  nextOffset: number | null;
}

/**
 * The public music library: PUBLIC, non-deleted tracks, newest first, bounded
 * and offset-paginated. `limit` is clamped to `MUSIC_PAGE_SIZE_MAX`.
 */
export async function listTracks(options: { offset?: number; limit?: number } = {}): Promise<TrackPage> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(MUSIC_PAGE_SIZE_MAX, Math.max(1, Math.floor(options.limit ?? MUSIC_PAGE_SIZE_DEFAULT)));

  const rows = await prisma.track.findMany({
    where: { deletedAt: null, visibility: "PUBLIC" },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    skip: offset,
    take: limit + 1,
    select: TRACK_SELECT,
  });

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toTrackDTO);
  return { items, nextOffset: hasMore ? offset + limit : null };
}

/**
 * One track with its rights metadata, enforcing visibility.
 *
 * A PRIVATE track that the viewer may not see is reported as "not found", so
 * the endpoint never leaks the existence of unpublished audio.
 */
export async function getTrack(id: string, viewer: MusicViewer): Promise<TrackDTO> {
  const row = await prisma.track.findUnique({ where: { id }, select: { ...TRACK_SELECT, deletedAt: true } });
  if (!row || row.deletedAt) throw notFound("That track does not exist.");
  if (!canViewTrack({ visibility: row.visibility, channelId: row.channel.id }, viewer)) {
    throw notFound("That track does not exist.");
  }
  return toTrackDTO(row);
}

/* ----------------------------------------------------------- access control */

export interface DownloadDecision {
  /** Whether the viewer may see (and therefore stream) the track at all. */
  visible: boolean;
  /** Whether the viewer may download a copy. Implies `visible`. */
  allowed: boolean;
}

function canViewTrack(
  track: { visibility: "PRIVATE" | "UNLISTED" | "PUBLIC"; channelId: string },
  viewer: MusicViewer,
): boolean {
  if (track.visibility !== "PRIVATE") return true;
  if (viewer.channelId !== null && viewer.channelId === track.channelId) return true;
  // Moderators/admins review private media, matching `/api/media/...`.
  return viewer.role !== "USER";
}

/**
 * The single decision point for download rights. Pure and dependency-free so it
 * can be unit-tested directly; the async wrapper below is what the route calls.
 *
 * A download is allowed only when the track is visible **and** its rights
 * metadata explicitly permits it. Missing or false `downloadAllowed` fails
 * closed.
 */
export function evaluateDownloadAccess(input: {
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC";
  trackChannelId: string;
  downloadAllowed: boolean;
  viewer: MusicViewer;
}): DownloadDecision {
  const visible = canViewTrack({ visibility: input.visibility, channelId: input.trackChannelId }, input.viewer);
  return { visible, allowed: visible && input.downloadAllowed === true };
}

export interface TrackDownloadAuthorization {
  trackId: string;
  audioKey: string;
  mimeType: string;
  /** Filename offered to the browser when the download is permitted. */
  filename: string;
}

/**
 * Authorises a download of one track, or throws.
 *
 *  * invisible/deleted/nonexistent → 404 (existence is not leaked);
 *  * visible but `downloadAllowed = false` → 403 with a plain-language reason.
 *
 * This is called by the media route before it serves `?download=1`, so it is
 * the enforcement point, not merely a UI hint.
 */
export async function authorizeTrackDownload(
  id: string,
  viewer: MusicViewer,
): Promise<TrackDownloadAuthorization> {
  const row = await prisma.track.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      visibility: true,
      channelId: true,
      deletedAt: true,
      audioKey: true,
      mimeType: true,
      rights: { select: { downloadAllowed: true } },
    },
  });
  if (!row || row.deletedAt) throw notFound("That track does not exist.");

  const decision = evaluateDownloadAccess({
    visibility: row.visibility,
    trackChannelId: row.channelId,
    downloadAllowed: row.rights?.downloadAllowed ?? false,
    viewer,
  });
  if (!decision.visible) throw notFound("That track does not exist.");
  if (!decision.allowed) {
    throw forbidden("The rights metadata for this track does not permit downloading a copy.");
  }

  return {
    trackId: row.id,
    audioKey: row.audioKey,
    mimeType: row.mimeType,
    filename: downloadFilename(row.title, row.audioKey),
  };
}

/** `"Sine tone in A" + tracks/…/original.m4a` → `"Sine tone in A.m4a"`. */
function downloadFilename(title: string, audioKey: string): string {
  const ext = audioKey.includes(".") ? audioKey.slice(audioKey.lastIndexOf(".")) : ".m4a";
  const base = title
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "track";
  return `${base}${ext}`;
}
