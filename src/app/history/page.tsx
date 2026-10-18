import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getContinueWatching, listWatchHistory } from "@/server/services/videos";
import { HistoryList, type HistoryEntryDTO } from "./HistoryList";

export const metadata: Metadata = { title: "History" };
export const dynamic = "force-dynamic";

/**
 * Watch history.
 *
 * Shows "Continue watching" (incomplete videos with real stored progress)
 * above the full history. History is only populated when the viewer has left
 * `saveWatchHistory` enabled; the page says so plainly when it is empty.
 */
export default async function HistoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/history");

  const [page, continueWatching] = await Promise.all([
    listWatchHistory(user.id, undefined, 50),
    getContinueWatching(user.id, 8),
  ]);

  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Watch history</h1>
          <p className="mt-1 text-sm text-muted">Videos you have watched, newest first.</p>
        </div>
        {!user.saveWatchHistory && (
          <p className="dt-alert dt-alert-info max-w-sm text-xs">
            Watch history saving is turned off in{" "}
            <Link href="/settings" className="dt-link">
              Settings
            </Link>
            . New videos will not be recorded.
          </p>
        )}
      </div>

      {continueWatching.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-subtle">Continue watching</h2>
          <ul className="flex gap-4 overflow-x-auto pb-2 dt-no-scrollbar">
            {continueWatching.map(({ video, progressRatio }) => {
              const href = video.isShort ? `/shorts/${video.id}` : `/watch/${video.id}`;
              return (
                <li key={video.id} className="w-[260px] shrink-0">
                  <Link href={href} className="dt-card-hover block overflow-hidden rounded-xl">
                    <div className="dt-aspect-video relative" style={{ background: "var(--dt-surface-2)" }}>
                      {video.thumbnailKey && (
                        <img src={`/api/media/${video.thumbnailKey}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                      )}
                      <span className="absolute inset-x-0 bottom-0 h-1" style={{ background: "rgba(255,255,255,0.35)" }}>
                        <span
                          className="block h-full"
                          style={{ width: `${Math.round(progressRatio * 100)}%`, background: "var(--dt-brand)" }}
                        />
                      </span>
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 text-sm font-semibold">{video.title}</p>
                      <p className="mt-0.5 text-xs text-subtle">{video.channel.name}</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {page.items.length === 0 ? (
        <div className="dt-card flex flex-col items-center gap-2 px-6 py-16 text-center">
          <h2 className="text-lg font-bold">No watch history</h2>
          <p className="max-w-md text-sm text-muted">
            Videos you watch while signed in show up here, so you can find them again.
          </p>
          <Link href="/" className="dt-btn dt-btn-secondary">
            Browse videos
          </Link>
        </div>
      ) : (
        <HistoryList initialItems={page.items as unknown as HistoryEntryDTO[]} initialNextCursor={page.nextCursor} />
      )}
    </div>
  );
}
