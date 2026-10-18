import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { EmptyState, PageHeader } from "@/components/ui";
import { SubscriptionsIcon } from "@/components/icons";
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
 *
 * The videos are bucketed by channel (the card data already carries the channel
 * on every item) so this reads as "what each creator posted", which is the
 * mental model of a subscriptions feed, rather than one more undifferentiated
 * grid. Pagination is the shared cursor flow and regroups as more items load.
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
      <PageHeader
        eyebrow="Your channels"
        title="Subscriptions"
        description="The latest uploads from channels you follow, grouped by channel."
        className="mb-5"
      />

      <FeedGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        mode="cursor"
        endpoint="/api/feed?tab=subscriptions"
        limit={24}
        variant="grouped"
        emptyState={
          <EmptyState
            icon={<SubscriptionsIcon size={20} />}
            title="No subscriptions yet"
            description="When you subscribe to a channel, its new videos appear here. Find channels with search, or start from the home feed."
            actions={
              <>
                <Link href="/" className="dt-btn dt-btn-primary">
                  Browse videos
                </Link>
                <Link href="/results?q=" className="dt-btn dt-btn-secondary">
                  Search channels
                </Link>
              </>
            }
          />
        }
      />
    </div>
  );
}
