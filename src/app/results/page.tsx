import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { EmptyState, PageHeader, PlaylistCard } from "@/components/ui";
import { SearchIcon } from "@/components/icons";
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
 *
 * Each result type is its own labelled, counted section rather than one flat
 * grid, so it is obvious how many of each kind matched.
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
      <PageHeader
        eyebrow="Search"
        title={query || "Search"}
        description={
          query
            ? `Matches for “${query}” across videos, channels and playlists.`
            : "Type a query in the search box above to find videos, channels, tags and playlists."
        }
        className="mb-5"
      />

      {!query ? (
        <EmptyState
          icon={<SearchIcon size={20} />}
          title="What are you looking for?"
          description="Search matches video titles, descriptions, tags and channel names."
        />
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
            <EmptyState
              icon={<SearchIcon size={20} />}
              title={`No results for “${query}”`}
              description="Try fewer or different words, or check the spelling. Search only covers publicly visible content."
            />
          ) : (
            <div className="flex flex-col gap-8">
              {results.channels.length > 0 && (
                <section>
                  <SectionHeading label="Channels" count={results.channels.length} />
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
                  <SectionHeading label="Playlists" count={results.playlists.length} />
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {results.playlists.map((playlist) => (
                      <PlaylistCard
                        key={playlist.id}
                        playlist={{
                          id: playlist.id,
                          title: playlist.title,
                          coverKey: playlist.coverKey,
                          itemCount: playlist.itemCount,
                          // Search only ever returns non-system, public playlists.
                          isSystem: false,
                          systemKind: null,
                        }}
                        subtitle={`by ${playlist.channelName}`}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {selectedType !== "channel" && selectedType !== "playlist" && (
                <section>
                  <SectionHeading
                    label="Videos"
                    count={`${results.videos.length}${results.nextCursor ? "+" : ""}`}
                  />
                  <FeedGrid
                    initialItems={results.videos}
                    initialCursor={results.nextCursor}
                    mode="cursor"
                    endpoint={endpoint}
                    limit={20}
                    emptyState={
                      <EmptyState
                        variant="inline"
                        title="No matching videos"
                        description="Try the “All” or “Channels” filters."
                      />
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

function SectionHeading({ label, count }: { label: string; count: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-subtle">
      {label}
      <span className="dt-badge tabular-nums">{count}</span>
    </h2>
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
