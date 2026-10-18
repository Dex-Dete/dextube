/**
 * Search service.
 *
 * Aggregates the three searchable resource types (videos, channels, public
 * playlists) behind one typed API so route handlers stay thin. Video search
 * lives in `videos.ts` because the feed and the ranking service already depend
 * on it; this module adds channels, playlists and the autocomplete suggestions.
 *
 * Every query is restricted to rows an anonymous visitor may see:
 * PUBLIC + READY videos, real channels, and PUBLIC non-system playlists.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { CARD_SELECT, searchVideos, toCard, type VideoCard } from "./videos";

export interface ChannelHit {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  subscriberCount: number;
  videoCount: number;
}

export interface PlaylistHit {
  id: string;
  title: string;
  coverKey: string | null;
  itemCount: number;
  channelHandle: string;
  channelName: string;
}

export interface SearchResults {
  videos: VideoCard[];
  nextCursor: string | null;
  channels: ChannelHit[];
  playlists: PlaylistHit[];
}

export interface SearchInput {
  query: string;
  viewerChannelId: string | null;
  type?: "all" | "video" | "channel" | "playlist" | "short";
  duration?: "any" | "short" | "medium" | "long";
  sort?: "relevance" | "date" | "views";
  cursor?: string;
  limit?: number;
}

const MAX_CHANNELS = 8;
const MAX_PLAYLISTS = 8;

export async function search(input: SearchInput): Promise<SearchResults> {
  const query = input.query.trim();
  if (!query) return { videos: [], nextCursor: null, channels: [], playlists: [] };

  const wantVideos = input.type === undefined || input.type === "all" || input.type === "video" || input.type === "short";
  const wantChannels = input.type === undefined || input.type === "all" || input.type === "channel";
  const wantPlaylists = input.type === undefined || input.type === "all" || input.type === "playlist";

  const [page, channels, playlists] = await Promise.all([
    wantVideos
      ? searchVideos({
          query,
          viewerChannelId: input.viewerChannelId,
          cursor: input.cursor,
          limit: input.limit,
          duration: input.duration,
          sort: input.sort,
        })
      : Promise.resolve({ items: [] as VideoCard[], nextCursor: null }),
    wantChannels ? searchChannels(query) : Promise.resolve([] as ChannelHit[]),
    wantPlaylists ? searchPlaylists(query) : Promise.resolve([] as PlaylistHit[]),
  ]);

  const videos = input.type === "short" ? page.items.filter((v) => v.isShort) : page.items;
  return { videos, nextCursor: page.nextCursor, channels, playlists };
}

export async function searchChannels(query: string): Promise<ChannelHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await prisma.channel.findMany({
    where: {
      owner: { deletedAt: null },
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { handle: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: [{ subscriberCount: "desc" }, { createdAt: "asc" }],
    take: MAX_CHANNELS,
    select: {
      id: true,
      handle: true,
      name: true,
      avatarKey: true,
      subscriberCount: true,
      _count: { select: { videos: { where: { deletedAt: null, status: "READY", visibility: "PUBLIC" } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    name: row.name,
    avatarKey: row.avatarKey,
    subscriberCount: row.subscriberCount,
    videoCount: row._count.videos,
  }));
}

export async function searchPlaylists(query: string): Promise<PlaylistHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await prisma.playlist.findMany({
    where: {
      visibility: "PUBLIC",
      isSystem: false,
      title: { contains: q, mode: "insensitive" },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: MAX_PLAYLISTS,
    select: {
      id: true,
      title: true,
      itemCount: true,
      channel: { select: { handle: true, name: true } },
      items: {
        orderBy: { position: "asc" },
        take: 1,
        select: { video: { select: { thumbnailKey: true, posterKey: true } } },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    coverKey: row.items[0]?.video.thumbnailKey ?? row.items[0]?.video.posterKey ?? null,
    itemCount: row.itemCount,
    channelHandle: row.channel.handle,
    channelName: row.channel.name,
  }));
}

export interface Suggestion {
  kind: "video" | "channel" | "query";
  label: string;
  sublabel?: string;
  href: string;
}

/**
 * Autocomplete suggestions for the header search box.
 *
 * Cheap and bounded: a couple of indexed `contains` queries, capped at a few
 * rows each, plus the raw query as a fallback so pressing Enter always works.
 */
export async function suggest(query: string, limit = 8): Promise<Suggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const [videos, channels] = await Promise.all([
    prisma.video.findMany({
      where: {
        deletedAt: null,
        status: "READY",
        visibility: "PUBLIC",
        isShort: false,
        title: { contains: q, mode: "insensitive" },
      },
      orderBy: [{ viewCount: "desc" }, { publishedAt: "desc" }],
      take: 5,
      select: { id: true, title: true, channel: { select: { name: true } } },
    }),
    prisma.channel.findMany({
      where: {
        owner: { deletedAt: null },
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { handle: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { subscriberCount: "desc" },
      take: 3,
      select: { handle: true, name: true },
    }),
  ]);

  const suggestions: Suggestion[] = [];
  for (const row of channels) {
    suggestions.push({
      kind: "channel",
      label: row.name,
      sublabel: `@${row.handle}`,
      href: `/channel/${row.handle}`,
    });
  }
  for (const row of videos) {
    suggestions.push({
      kind: "video",
      label: row.title,
      sublabel: row.channel.name,
      href: `/watch/${row.id}`,
    });
  }
  suggestions.push({ kind: "query", label: q, sublabel: "Search for this text", href: `/results?q=${encodeURIComponent(q)}` });

  return suggestions.slice(0, limit);
}

/** Re-exported so callers can map a raw DB video row to a card without a second import. */
export { toCard, CARD_SELECT };
