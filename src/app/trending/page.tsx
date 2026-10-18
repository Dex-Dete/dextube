import type { Metadata } from "next";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { getCurrentUser } from "@/server/auth/session";
import { getFeed } from "@/server/services/videos";

export const metadata: Metadata = { title: "Trending" };
export const dynamic = "force-dynamic";

/**
 * Trending.
 *
 * A transparent blend of recent views and freshness — not a claim of a
 * machine-learned ranking. The ordering is explained to the user on the page.
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
      <h1 className="mb-1 text-xl font-bold">Trending</h1>
      <p className="mb-5 text-sm text-muted">
        Ranked by recent view counts with a freshness window, so brand-new and newly popular videos surface. This is a
        transparent heuristic, not a learned model.
      </p>

      <FeedGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        mode="cursor"
        endpoint="/api/feed?tab=trending"
        limit={24}
        emptyState={
          <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
            <h2 className="text-lg font-bold">Nothing is trending yet</h2>
            <p className="max-w-md text-sm text-muted">Once videos are published and watched, they show up here.</p>
          </div>
        }
      />
    </div>
  );
}
