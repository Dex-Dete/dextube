import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { getViewerContext } from "@/server/auth/session";
import { search } from "@/server/services/search";
import { mediaUrl } from "@/lib/media-url";
import { formatCount } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ResultsPageProps {
  searchParams: Promise<{ q?: string; type?: string; duration?: string; sort?: string }>;
}

const TYPES = [
  { key: "all", label: "All" },
  { key: "video", label: "Videos" },
  { key: "short", label: "Shorts" },
  { key: "channel", label: "Channels" },
  { key: "playlist", label: "Playlists" },
] as const;

const DURATIONS = [
  { key: "any", label: "Any length" },
  { key: "short", label: "Under 4 min" },
  { key: "medium", label: "4–20 min" },
  { key: "long", label: "Over 20 min" },
] as const;

const SORTS = [
  { key: "relevance", label: "Relevance" },
  { key: "date", label: "Upload date" },
  { key: "views", label: "View count" },
] as const;

export async function generateMetadata({ searchParams }: ResultsPageProps): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `${q} — search` : "Search" };
}

/**
 * Search results.
 *
 * Videos are cursor-paginated; matching channels and public playlists are shown
 * above them on the first page. Filters are plain links so results remain
 * shareable, bookmarkable and usable without JavaScript.
 */
export default async function ResultsPage({ searchParams }: ResultsPageProps) {
  const { q, type, duration, sort } = await searchParams;
  const query = (q ?? "").trim();

  const selectedType = (TYPES.some((t) => t.key === type) ? type : "all") as (typeof TYPES)[number]["key"];
  const selectedDuration = (DURATIONS.some((d) => d.key === duration) ? duration : "any") as (typeof DURATIONS)[number]["key"];
  const selectedSort = (SORTS.some((s) => s.key === sort) ? sort : "relevance") as (typeof SORTS)[number]["key"];

  const viewer = await getViewerContext();
  const results = query
    ? await search({
        query,
        viewerChannelId: viewer.channelId,
        type: selectedType,
        duration: selectedDuration,
        sort: selectedSort,
        limit: 20,
      })
    : { videos: [], nextCursor: null, channels: [], playlists: [] };

  const qs = (overrides: Record<string, string>) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("type", selectedType);
    params.set("duration", selectedDuration);
    params.set("sort", selectedSort);
    for (const [k, v] of Object.entries(overrides)) params.set(k, v);
    return `/results?${params.toString()}`;
  };

  const endpoint = `/api/search?q=${encodeURIComponent(query)}&type=${selectedType}&duration=${selectedDuration}&sort=${selectedSort}`;
  const totalResults = results.videos.length + results.channels.length + results.playlists.length;

  return (
    <div className="px-4 py-5 sm:px-6">
      <h1 className="mb-1 text-xl font-bold">Search</h1>
      <p className="mb-5 text-sm text-muted">
        {query ? (
          <>
            Results for <strong>{query}</strong>
          </>
        ) : (
          "Type a query in the search box above to find videos, channels, tags and playlists."
        )}
      </p>

      {!query ? (
        <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
          <h2 className="text-lg font-bold">What are you looking for?</h2>
          <p className="max-w-md text-sm text-muted">
            Search matches video titles, descriptions, tags and channel names.
          </p>
        </div>
      ) : (
        <>
          {/* ------------------------------------------------- filters */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <FilterGroup label="Type" items={TYPES} activeKey={selectedType} hrefFor={(key) => qs({ type: key })} />
            <FilterGroup
              label="Length"
              items={DURATIONS}
              activeKey={selectedDuration}
              hrefFor={(key) => qs({ duration: key })}
            />
            <FilterGroup label="Sort" items={SORTS} activeKey={selectedSort} hrefFor={(key) => qs({ sort: key })} />
          </div>

          {totalResults === 0 ? (
            <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
              <h2 className="text-lg font-bold">No results for “{query}”</h2>
              <p className="max-w-md text-sm text-muted">
                Try fewer or different words, or check the spelling. Search only covers publicly visible content.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {results.channels.length > 0 && (
                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Channels</h2>
                  <ul className="flex flex-col gap-2">
                    {results.channels.map((channel) => (
                      <li key={channel.id}>
                        <Link
                          href={`/channel/${channel.handle}`}
                          className="dt-card-hover flex items-center gap-3 rounded-xl p-3"
                        >
                          <Avatar name={channel.name} seed={channel.id} src={mediaUrl(channel.avatarKey)} size={48} />
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{channel.name}</span>
                            <span className="block truncate text-xs text-subtle">
                              @{channel.handle} · {formatCount(channel.subscriberCount)}{" "}
                              {channel.subscriberCount === 1 ? "subscriber" : "subscribers"} ·{" "}
                              {formatCount(channel.videoCount)} {channel.videoCount === 1 ? "video" : "videos"}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {results.playlists.length > 0 && (
                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Playlists</h2>
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {results.playlists.map((playlist) => (
                      <li key={playlist.id} className="dt-card-hover overflow-hidden rounded-xl">
                        <Link href={`/playlist/${playlist.id}`} className="block">
                          <div className="dt-aspect-video relative" style={{ background: "var(--dt-surface-2)" }}>
                            {playlist.coverKey && (
                              <img src={mediaUrl(playlist.coverKey)!} alt="" className="h-full w-full object-cover" />
                            )}
                            <span
                              className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                              style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}
                            >
                              {playlist.itemCount} {playlist.itemCount === 1 ? "video" : "videos"}
                            </span>
                          </div>
                          <div className="p-3">
                            <p className="truncate font-semibold">{playlist.title}</p>
                            <p className="truncate text-xs text-subtle">{playlist.channelName}</p>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {selectedType !== "channel" && selectedType !== "playlist" && (
                <section>
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Videos</h2>
                  <FeedGrid
                    initialItems={results.videos}
                    initialCursor={results.nextCursor}
                    mode="cursor"
                    endpoint={endpoint}
                    limit={20}
                    emptyState={
                      <div className="dt-card flex flex-col items-center gap-2 px-6 py-12 text-center">
                        <p className="text-sm font-semibold">No matching videos</p>
                        <p className="text-sm text-muted">Try the “All” or “Channels” filters.</p>
                      </div>
                    }
                  />
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterGroup<T extends { key: string; label: string }>({
  label,
  items,
  activeKey,
  hrefFor,
}: {
  label: string;
  items: readonly T[];
  activeKey: string;
  hrefFor: (key: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Link
            key={item.key}
            href={hrefFor(item.key)}
            aria-current={active ? "true" : undefined}
            className="dt-btn !px-3 !py-1.5 text-[13px]"
            style={
              active
                ? { background: "var(--dt-fg)", color: "var(--dt-canvas)" }
                : { background: "var(--dt-surface-2)", color: "var(--dt-fg)" }
            }
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
