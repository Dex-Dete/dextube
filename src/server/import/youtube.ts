/**
 * YouTube metadata connector.
 *
 * Two sources, in order of preference:
 *
 *   1. **YouTube Data API v3** — used whenever `YOUTUBE_API_KEY` is set. This is
 *      the authorized, documented interface: it paginates, states durations and
 *      counts, and is the only path that can reach past the latest 15 entries.
 *   2. **The official public channel/playlist feed** (`/feeds/videos.xml`) — a
 *      public, machine-readable Atom feed published by YouTube itself. It needs
 *      no key and carries real ids, titles, publication dates, descriptions and
 *      thumbnail references, but only for the most recent 15 entries.
 *
 * What this connector deliberately never does:
 *
 *   * It never downloads media. There is no ripping, no `youtube-dl`, no
 *     signature deciphering, no DRM removal, no circumvention of any access
 *     restriction. Bytes can only arrive through an authorized creator export
 *     (see `creator-export.ts`) with a recorded authorization basis.
 *   * It never invents data. A field the provider does not state is stored as
 *     null rather than guessed, and a duration of "unknown" stays unknown.
 */
import "server-only";
import type { ImportConnectorKind } from "@prisma/client";
import { getConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { sanitizeExtra, sanitizeRequired, sanitizeText, sanitizeUrl } from "./sanitize";
import { safeFetchJson, safeFetchText } from "./safe-fetch";
import type { ChannelRef, ConnectorEntry, ListOptions, ListResult, MetadataConnector } from "./types";

/** Hosts this connector actually contacts. */
const CONTACT_HOSTS = [".youtube.com", ".googleapis.com"] as const;
/** Hosts a stored thumbnail reference may point at. Never contacted by us. */
const IMAGE_HOSTS = [".ytimg.com", ".youtube.com"] as const;

const FEED_URL = "https://www.youtube.com/feeds/videos.xml";
const API_BASE = "https://www.googleapis.com/youtube/v3";

export const YOUTUBE_LIMITATION_NO_KEY =
  "Without YOUTUBE_API_KEY this connector reads YouTube's official public feed, which only exposes " +
  "the latest 15 entries of a channel or playlist. Media is never downloaded by this connector.";

/* --------------------------------------------------------------- XML helpers */

function unescapeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inner text of the first `<tag>` occurrence, or null. */
function firstTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tag)}>`).exec(xml);
  return match?.[1] === undefined ? null : unescapeXml(match[1]).trim();
}

/** Value of an attribute on the first `<tag …>` occurrence, or null. */
function firstAttr(xml: string, tag: string, attr: string): string | null {
  const match = new RegExp(`<${escapeRegExp(tag)}\\s[^>]*${escapeRegExp(attr)}="([^"]*)"`).exec(xml);
  return match?.[1] === undefined ? null : unescapeXml(match[1]);
}

function splitEntries(feed: string): string[] {
  const out: string[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(feed)) !== null) out.push(match[1]!);
  return out;
}

/** ISO-8601 duration ("PT1H2M3S") to whole seconds, or null when unparseable. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (d === undefined && h === undefined && m === undefined && s === undefined) return null;
  const total =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? total : null;
}

/** Channel id from a public channel page's canonical link. */
export function channelIdFromPage(html: string): string | null {
  const canonical = /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/([A-Za-z0-9_-]{10,})"/.exec(html);
  if (canonical?.[1]) return canonical[1];
  const meta = /<meta[^>]+itemprop="channelId"[^>]+content="([A-Za-z0-9_-]{10,})"/.exec(html);
  return meta?.[1] ?? null;
}

function pageTitle(html: string): string | null {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/.exec(html);
  return og?.[1] ? unescapeXml(og[1]) : null;
}

/* -------------------------------------------------------------- connector */

function apiKey(): string | null {
  return getConfig().imports.youtubeApiKey;
}

export function youtubeAllowedHosts(): readonly string[] {
  return CONTACT_HOSTS;
}

async function fetchText(url: string, accept?: string): Promise<string> {
  const config = getConfig();
  const result = await safeFetchText(url, {
    allowHosts: CONTACT_HOSTS,
    timeoutMs: config.imports.httpTimeoutMs,
    maxBytes: config.imports.maxResponseBytes,
    accept,
  });
  return result.body;
}

function toEntry(raw: {
  externalId: unknown;
  title: unknown;
  description: unknown;
  publishedAt: unknown;
  durationSeconds: unknown;
  thumbnailUrl: unknown;
  attribution: string;
  extra?: Record<string, unknown>;
}): ConnectorEntry {
  const externalId = sanitizeText(raw.externalId, { maxLength: 64 });
  if (!externalId || !/^[A-Za-z0-9_-]{6,}$/.test(externalId)) {
    throw new AppError("PRECONDITION_FAILED", "The provider returned an entry without a usable identifier.");
  }
  const published = raw.publishedAt instanceof Date ? raw.publishedAt : null;
  const duration = typeof raw.durationSeconds === "number" && Number.isFinite(raw.durationSeconds)
    ? Math.max(0, Math.round(raw.durationSeconds))
    : null;
  return {
    externalId,
    title: sanitizeRequired(raw.title, { maxLength: 300 }),
    description: sanitizeText(raw.description, { maxLength: 5000, multiline: true }),
    publishedAt: published,
    durationSeconds: duration,
    thumbnailUrl: sanitizeUrl(raw.thumbnailUrl, IMAGE_HOSTS),
    canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}`,
    attribution: raw.attribution,
    extra: sanitizeExtra(raw.extra ?? {}, IMAGE_HOSTS),
  };
}

async function resolveWithApiKey(input: string, key: string): Promise<ChannelRef | null> {
  const handleMatch = /(?:youtube\.com\/)?@([A-Za-z0-9._-]{3,})/.exec(input);
  const userMatch = /youtube\.com\/user\/([A-Za-z0-9._-]{3,})/.exec(input);
  let query: string | null = null;
  if (handleMatch?.[1]) query = `forHandle=${encodeURIComponent(`@${handleMatch[1]}`)}`;
  else if (userMatch?.[1]) query = `forUsername=${encodeURIComponent(userMatch[1])}`;
  if (!query) return null;

  const data = await safeFetchJson<{
    items?: Array<{ id?: string; snippet?: { title?: string } }>;
  }>(`${API_BASE}/channels?part=snippet&${query}&key=${encodeURIComponent(key)}`, {
    allowHosts: CONTACT_HOSTS,
    timeoutMs: getConfig().imports.httpTimeoutMs,
    maxBytes: getConfig().imports.maxResponseBytes,
  });
  const item = data.items?.[0];
  if (!item?.id) return null;
  return {
    kind: "YOUTUBE_CHANNEL",
    externalChannelId: item.id,
    title: sanitizeText(item.snippet?.title, { maxLength: 300 }),
    canonicalUrl: `https://www.youtube.com/channel/${item.id}`,
  };
}

async function resolveWithoutApiKey(input: string): Promise<ChannelRef | null> {
  const handleMatch = /(?:youtube\.com\/)?(@[A-Za-z0-9._-]{3,})/.exec(input);
  const pathMatch = /youtube\.com\/(c|user)\/([A-Za-z0-9._-]{3,})/.exec(input);
  const path = handleMatch?.[1] ?? (pathMatch ? `${pathMatch[1]}/${pathMatch[2]}` : null);
  if (!path) return null;

  // Public channel page: used only to learn the channel's own id and title.
  // This is page metadata, never media.
  const html = await fetchText(`https://www.youtube.com/${path}`, "text/html");
  const channelId = channelIdFromPage(html);
  if (!channelId) return null;
  return {
    kind: "YOUTUBE_CHANNEL",
    externalChannelId: channelId,
    title: sanitizeText(pageTitle(html), { maxLength: 300 }),
    canonicalUrl: `https://www.youtube.com/channel/${channelId}`,
  };
}

/** Extracts a playlist id from a URL, if present. */
function playlistIdFromUrl(input: string): string | null {
  const list = /[?&]list=([A-Za-z0-9_-]{10,})/.exec(input);
  if (list?.[1]) return list[1];
  const feed = /[?&]playlist_id=([A-Za-z0-9_-]{10,})/.exec(input);
  return feed?.[1] ?? null;
}

export const youtubeConnector: MetadataConnector = {
  kind: "YOUTUBE_CHANNEL",
  displayName: "YouTube (channel or playlist metadata)",
  capabilityNote:
    "Reads real titles, ids, dates and descriptions from YouTube's official API or public feed. " +
    "It never downloads media: bytes require an authorized creator export.",
  allowedHosts: CONTACT_HOSTS,
  canSupplyMedia: false,

  async resolve(input: string): Promise<ChannelRef> {
    const trimmed = input.trim();
    if (!trimmed) throw new AppError("VALIDATION_FAILED", "Enter a channel or playlist URL.");

    const playlistId = playlistIdFromUrl(trimmed);
    if (playlistId) {
      return {
        kind: "YOUTUBE_PLAYLIST",
        externalChannelId: null,
        externalPlaylistId: playlistId,
        title: null,
        canonicalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
      };
    }

    const direct = /^(UC[A-Za-z0-9_-]{20,})$/.exec(trimmed) ?? /\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(trimmed);
    if (direct?.[1]) {
      return {
        kind: "YOUTUBE_CHANNEL",
        externalChannelId: direct[1],
        title: null,
        canonicalUrl: `https://www.youtube.com/channel/${direct[1]}`,
      };
    }
    const channelFeed = /[?&]channel_id=(UC[A-Za-z0-9_-]{20,})/.exec(trimmed);
    if (channelFeed?.[1]) {
      return {
        kind: "YOUTUBE_CHANNEL",
        externalChannelId: channelFeed[1],
        title: null,
        canonicalUrl: `https://www.youtube.com/channel/${channelFeed[1]}`,
      };
    }

    if (!/youtube\.com|^@|^UC/.test(trimmed)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "That does not look like a YouTube channel or playlist URL. Paste a channel/playlist URL or an @handle.",
      );
    }

    const key = apiKey();
    const resolved = key ? await resolveWithApiKey(trimmed, key) : await resolveWithoutApiKey(trimmed);
    if (!resolved?.externalChannelId) {
      throw new AppError(
        "PRECONDITION_FAILED",
        key
          ? "YouTube did not return a channel for that address."
          : "Could not resolve that channel. Set YOUTUBE_API_KEY for reliable resolution of @handles and custom names.",
      );
    }
    return resolved;
  },

  async listEntries(ref: ChannelRef, options: ListOptions): Promise<ListResult> {
    const key = apiKey();
    const limit = Math.max(1, Math.min(options.limit, 200));

    if (key) {
      return listViaApi(ref, limit, options.cursor ?? null, key);
    }

    const feedUrl = ref.externalPlaylistId
      ? `${FEED_URL}?playlist_id=${encodeURIComponent(ref.externalPlaylistId)}`
      : `${FEED_URL}?channel_id=${encodeURIComponent(ref.externalChannelId ?? "")}`;
    const feed = await fetchText(feedUrl, "application/atom+xml,application/xml");

    const attribution = `${ref.title ?? "YouTube"} · YouTube`;
    const all = splitEntries(feed).map((entry) =>
      toEntry({
        externalId: firstTag(entry, "yt:videoId") ?? firstTag(entry, "id"),
        title: firstTag(entry, "title"),
        description: firstTag(entry, "media:description"),
        publishedAt: (() => {
          const published = firstTag(entry, "published");
          const date = published ? new Date(published) : null;
          return date && !Number.isNaN(date.getTime()) ? date : null;
        })(),
        durationSeconds: (() => {
          const raw = firstAttr(entry, "media:content", "duration");
          const seconds = raw === null ? Number.NaN : Number(raw);
          return Number.isFinite(seconds) ? seconds : null;
        })(),
        thumbnailUrl: firstAttr(entry, "media:thumbnail", "url"),
        attribution,
        extra: {
          channelId: firstTag(entry, "yt:channelId"),
          author: firstTag(entry, "author"),
          updated: firstTag(entry, "updated"),
          feedUrl,
        },
      }),
    );

    const start = options.cursor ? Number(options.cursor) : 0;
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const entries = all.slice(safeStart, safeStart + limit);
    return {
      entries,
      // The public feed is a single window; there is no further page.
      nextCursor: null,
      totalEstimate: all.length,
      limitations: [YOUTUBE_LIMITATION_NO_KEY],
    };
  },
};

async function listViaApi(ref: ChannelRef, limit: number, cursor: string | null, key: string): Promise<ListResult> {
  const config = getConfig();
  const fetchOpts = {
    allowHosts: CONTACT_HOSTS,
    timeoutMs: config.imports.httpTimeoutMs,
    maxBytes: config.imports.maxResponseBytes,
  };

  let playlistId = ref.externalPlaylistId ?? null;
  let channelTitle = ref.title;

  if (!playlistId) {
    const channel = await safeFetchJson<{
      items?: Array<{
        snippet?: { title?: string };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }>;
    }>(`${API_BASE}/channels?part=snippet,contentDetails&id=${encodeURIComponent(ref.externalChannelId ?? "")}&key=${encodeURIComponent(key)}`, fetchOpts);
    const item = channel.items?.[0];
    playlistId = item?.contentDetails?.relatedPlaylists?.uploads ?? null;
    channelTitle = sanitizeText(item?.snippet?.title, { maxLength: 300 }) ?? channelTitle;
    if (!playlistId) {
      throw new AppError("PRECONDITION_FAILED", "YouTube did not expose an uploads list for that channel.");
    }
  }

  const page = await safeFetchJson<{
    nextPageToken?: string;
    pageInfo?: { totalResults?: number };
    items?: Array<{
      contentDetails?: { videoId?: string };
      snippet?: {
        title?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: Record<string, { url?: string }>;
        channelTitle?: string;
      };
    }>;
  }>(
    `${API_BASE}/playlistItems?part=snippet,contentDetails&maxResults=${Math.min(limit, 50)}&playlistId=${encodeURIComponent(playlistId)}` +
      `${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}&key=${encodeURIComponent(key)}`,
    fetchOpts,
  );

  const items = page.items ?? [];
  const ids = items.map((i) => i.contentDetails?.videoId).filter((id): id is string => Boolean(id));

  // Durations live on the video resource, not on the playlist item.
  const durations = new Map<string, number | null>();
  if (ids.length > 0) {
    const details = await safeFetchJson<{
      items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
    }>(`${API_BASE}/videos?part=contentDetails&id=${encodeURIComponent(ids.join(","))}&key=${encodeURIComponent(key)}`, fetchOpts);
    for (const item of details.items ?? []) {
      if (item.id) durations.set(item.id, parseIsoDuration(item.contentDetails?.duration));
    }
  }

  const attribution = `${channelTitle ?? "YouTube"} · YouTube`;
  const entries = items
    .map((item) => {
      const videoId = item.contentDetails?.videoId;
      if (!videoId) return null;
      const published = item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null;
      const thumbs = item.snippet?.thumbnails ?? {};
      const thumb = thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default;
      return toEntry({
        externalId: videoId,
        title: item.snippet?.title,
        description: item.snippet?.description,
        publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
        durationSeconds: durations.get(videoId) ?? null,
        thumbnailUrl: thumb?.url,
        attribution,
        extra: { channelTitle: item.snippet?.channelTitle, source: "youtube-data-api-v3" },
      });
    })
    .filter((entry): entry is ConnectorEntry => entry !== null);

  return {
    entries,
    nextCursor: page.nextPageToken ?? null,
    totalEstimate: page.pageInfo?.totalResults ?? null,
    limitations: [
      "Metadata comes from the YouTube Data API v3 under your API key; quota is shared with every other use of that key.",
    ],
  };
}

/** True when this connector can be used at all (always: the public feed needs no key). */
export function youtubeAvailable(): boolean {
  return true;
}

export const YOUTUBE_KIND: ImportConnectorKind = "YOUTUBE_CHANNEL";
