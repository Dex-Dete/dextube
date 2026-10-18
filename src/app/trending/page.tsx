import type { Metadata } from "next";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { EmptyState, PageHeader } from "@/components/ui";
import { SparkIcon } from "@/components/icons";
import { getCurrentUser } from "@/server/auth/session";
import { getFeed } from "@/server/services/videos";

export const metadata: Metadata = { title: "Trending" };
export const dynamic = "force-dynamic";

/**
 * Trending.
 *
 * A transparent blend of recent views and freshness — not a claim of a
 * machine-learned ranking. The ordering is explained to the user on the page,
 * and it is presented as an explicit ranked list so the ranking is visible
 * rather than implied by an unordered grid.
 */
export default async function TrendingPage() {
  const user = await getCurrentUser();
  const page = await getFeed({
    tab: "trending",
    viewerId: user?.id ?? null,
    viewerChannelId: user?.channel?.id ?? null,
    limit: 24,
  });

  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeader
        eyebrow="Ranked list"
        title="Trending"
        description="Ranked by recent view counts with a freshness window, so brand-new and newly popular videos surface. This is a transparent heuristic, not a learned model."
        className="mb-5"
      />

      <FeedGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        mode="cursor"
        endpoint="/api/feed?tab=trending"
        limit={24}
        variant="ranked"
        emptyState={
          <EmptyState
            icon={<SparkIcon size={20} />}
            title="Nothing is trending yet"
            description="Once videos are published and watched, they show up here."
          />
        }
      />
    </div>
  );
}
