import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
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
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Notifications</h1>
          <p className="mt-1 text-sm text-muted">Activity on your channel and from the creators you follow.</p>
        </div>
        <Link href="/settings" className="dt-btn dt-btn-secondary !px-3 !py-1.5 text-xs">
          Preferences
        </Link>
      </div>

      {page.items.length === 0 ? (
        <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
          <h2 className="text-lg font-bold">No notifications yet</h2>
          <p className="max-w-md text-sm text-muted">
            Subscribe to a channel to hear about new uploads, or wait for a reply on a comment you leave.
          </p>
          <Link href="/" className="dt-btn dt-btn-secondary">
            Browse videos
          </Link>
        </div>
      ) : (
        <NotificationList initialItems={page.items as NotificationRowDTO[]} initialNextCursor={page.nextCursor} />
      )}
    </div>
  );
}
