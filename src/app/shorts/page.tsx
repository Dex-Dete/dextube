import type { Metadata } from "next";
import { getCurrentUser } from "@/server/auth/session";
import { getShortsFeedDetailed } from "@/server/services/videos";
import { ShortsFeed } from "@/components/shorts/ShortsFeed";

export const metadata: Metadata = { title: "Shorts" };
export const dynamic = "force-dynamic";

/**
 * Shorts.
 *
 * Vertical, snap-paged playback. The first page is server-rendered so the feed
 * works before any client JavaScript arrives; the client component adds
 * autoplay, paging, reactions and infinite loading.
 */
export default async function ShortsPage() {
  const user = await getCurrentUser();
  const page = await getShortsFeedDetailed({ viewerId: user?.id ?? null, limit: 10 });

  return (
    <div>
      <h1 className="sr-only">Shorts</h1>
      <ShortsFeed
        initialItems={page.items}
        initialCursor={page.nextCursor}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
