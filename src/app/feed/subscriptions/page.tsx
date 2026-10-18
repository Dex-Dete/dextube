import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { getCurrentUser } from "@/server/auth/session";
import { getFeed } from "@/server/services/videos";

export const metadata: Metadata = { title: "Subscriptions" };
export const dynamic = "force-dynamic";

/**
 * Subscriptions feed.
 *
 * Newest-first across every channel the viewer follows. Requires a session, so
 * it is a hard redirect for signed-out visitors rather than an empty feed they
 * cannot fix — and it is honest about having no subscriptions yet.
 */
export default async function SubscriptionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/feed/subscriptions");

  const page = await getFeed({
    tab: "subscriptions",
    viewerId: user.id,
    viewerChannelId: user.channel?.id ?? null,
    limit: 24,
  });

  return (
    <div className="px-4 py-5 sm:px-6">
      <h1 className="mb-1 text-xl font-bold">Subscriptions</h1>
      <p className="mb-5 text-sm text-muted">The latest uploads from channels you follow.</p>

      <FeedGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        mode="cursor"
        endpoint="/api/feed?tab=subscriptions"
        limit={24}
        emptyState={
          <div className="dt-card flex flex-col items-center gap-3 px-6 py-16 text-center">
            <h2 className="text-lg font-bold">No subscriptions yet</h2>
            <p className="max-w-md text-sm text-muted">
              When you subscribe to a channel, its new videos appear here. Find channels with search, or start from the
              home feed.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/" className="dt-btn dt-btn-primary">
                Browse videos
              </Link>
              <Link href="/results?q=" className="dt-btn dt-btn-secondary">
                Search channels
              </Link>
            </div>
          </div>
        }
      />
    </div>
  );
}
