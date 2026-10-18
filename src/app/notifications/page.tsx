import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/ui";
import { BellIcon } from "@/components/icons";
import { getCurrentUser } from "@/server/auth/session";
import { notificationService } from "@/server/services/notifications";
import { NotificationList, type NotificationRowDTO } from "./NotificationList";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

/**
 * Notifications inbox.
 *
 * Notifications are created by real events (a new subscriber, a reply, a like,
 * a new upload from a channel you follow). Duplicate events are collapsed by a
 * dedupe key, so retrying a fan-out job cannot double-post.
 */
export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/notifications");

  const page = await notificationService.listForUser(user.id, undefined, 30);

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        eyebrow="Activity"
        title="Notifications"
        description="Activity on your channel and from the creators you follow."
        actions={
          <Link href="/settings" className="dt-btn dt-btn-secondary !px-3 !py-1.5 text-xs">
            Preferences
          </Link>
        }
        className="mb-5"
      />

      {page.items.length === 0 ? (
        <EmptyState
          icon={<BellIcon size={20} />}
          title="No notifications yet"
          description="Subscribe to a channel to hear about new uploads, or wait for a reply on a comment you leave."
          actions={
            <Link href="/" className="dt-btn dt-btn-secondary">
              Browse videos
            </Link>
          }
        />
      ) : (
        <NotificationList initialItems={page.items as NotificationRowDTO[]} initialNextCursor={page.nextCursor} />
      )}
    </div>
  );
}
