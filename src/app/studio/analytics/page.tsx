import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import {
  ensureTodayAggregated,
  getStudioOverview,
  type RangeKey,
  type StudioOverview,
} from "@/server/services/analytics";
import { mediaUrl } from "@/lib/media-url";
import { formatCount, formatDate, formatWatchTime } from "@/lib/format";
import { PlayIcon, StudioIcon } from "@/components/icons";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "28d", label: "28 days" },
  { key: "90d", label: "90 days" },
  { key: "365d", label: "365 days" },
];

function parseRange(value: string | undefined): RangeKey {
  return RANGES.some((r) => r.key === value) ? (value as RangeKey) : "28d";
}

/**
 * Analytics detail.
 *
 * Everything here is derived from the same `StudioOverview` rollups the
 * dashboard uses — no invented metrics. The chart is an original inline SVG and
 * the full per-day numbers are also available as a table, so the data is never
 * conveyed by colour alone.
 */
export default async function StudioAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio/analytics");
  if (!user.channel) redirect("/studio/channel");

  const { range: rawRange } = await searchParams;
  const range = parseRange(rawRange);
  const rangeLabel = RANGES.find((r) => r.key === range)!.label;

  await ensureTodayAggregated();
  const overview = await getStudioOverview(user.channel.id, range);

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-subtle" aria-label="Breadcrumb">
        <StudioIcon size={14} />
        <Link href="/studio" className="dt-link">
          Studio
        </Link>
        <span aria-hidden="true">/</span>
        <span>Analytics</span>
      </nav>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Analytics</h1>
          <p className="mt-0.5 text-sm text-muted">Performance for {user.channel.name} · {rangeLabel}</p>
        </div>
        <nav className="flex flex-wrap gap-1.5" aria-label="Analytics range">
          {RANGES.map((option) => {
            const active = option.key === range;
            return (
              <Link
                key={option.key}
                href={`/studio/analytics?range=${option.key}`}
                aria-current={active ? "page" : undefined}
                className="dt-btn !px-3 !py-1 text-[13px]"
                style={
                  active
                    ? { background: "var(--dt-fg)", color: "var(--dt-canvas)" }
                    : { background: "var(--dt-surface-2)", color: "var(--dt-fg)" }
                }
              >
                {option.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* ------------------------------------------------------------- totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="Views" value={formatCount(overview.totals.views)} />
        <Metric label="Watch time" value={formatWatchTime(overview.totals.watchSeconds)} />
        <Metric label="Likes" value={formatCount(overview.totals.likes)} />
        <Metric label="Comments" value={formatCount(overview.totals.comments)} />
        <Metric label="Uploads" value={formatCount(overview.totals.uploads)} />
        <Metric
          label="Net subscribers"
          value={`${overview.totals.netSubscribers >= 0 ? "+" : "−"}${formatCount(Math.abs(overview.totals.netSubscribers))}`}
          sub={`+${formatCount(overview.totals.subscribersGained)} / −${formatCount(overview.totals.subscribersLost)}`}
        />
      </div>

      {/* -------------------------------------------------------------- chart */}
      <section className="dt-card mt-5 p-4 sm:p-5" aria-labelledby="chart-heading">
        <div className="flex items-center justify-between gap-2">
          <h2 id="chart-heading" className="text-sm font-bold">
            Views per day
          </h2>
          <span className="text-xs text-subtle">Peak {formatCount(Math.max(0, ...overview.series.map((s) => s.views)))}/day</span>
        </div>
        <figure className="mt-4">
          <ViewsChart series={overview.series} className="h-48 w-full" />
          <figcaption className="mt-2 flex justify-between text-[11px] text-subtle">
            <span>{overview.series[0] ? formatDate(overview.series[0].day) : ""}</span>
            <span>{overview.series.length ? formatDate(overview.series[overview.series.length - 1]!.day) : ""}</span>
          </figcaption>
        </figure>
      </section>

      {/* --------------------------------------------------------- daily table */}
      <section className="dt-card mt-5 p-4 sm:p-5" aria-labelledby="daily-heading">
        <h2 id="daily-heading" className="text-sm font-bold">
          Daily breakdown
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="dt-visually-hidden">Views, watch time and subscribers per day</caption>
            <thead>
              <tr className="text-xs text-subtle">
                <th scope="col" className="py-2 pr-4 font-semibold">Day</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Views</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Watch time</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Subscribers +</th>
                <th scope="col" className="py-2 font-semibold">Subscribers −</th>
              </tr>
            </thead>
            <tbody>
              {[...overview.series].reverse().map((entry) => (
                <tr key={entry.day} className="border-t border-line">
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDate(entry.day)}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatCount(entry.views)}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatWatchTime(entry.watchSeconds)}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatCount(entry.subscribersGained)}</td>
                  <td className="py-2 tabular-nums">{formatCount(entry.subscribersLost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* --------------------------------------------------------- top videos */}
      <section className="dt-card mt-5 p-4 sm:p-5" aria-labelledby="top-table-heading">
        <h2 id="top-table-heading" className="text-sm font-bold">
          Top videos
        </h2>
        {overview.topVideos.length === 0 ? (
          <p className="mt-3 text-sm text-subtle">No views in this range yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="dt-visually-hidden">Videos with the most views in the selected range</caption>
              <thead>
                <tr className="text-xs text-subtle">
                  <th scope="col" className="py-2 pr-4 font-semibold">#</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Video</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Views</th>
                  <th scope="col" className="py-2 font-semibold">Watch time</th>
                </tr>
              </thead>
              <tbody>
                {overview.topVideos.map((video, index) => (
                  <tr key={video.videoId} className="border-t border-line">
                    <td className="py-2 pr-4 tabular-nums text-subtle">{index + 1}</td>
                    <td className="py-2 pr-4">
                      <Link href={`/studio/videos/${video.videoId}`} className="flex items-center gap-2 hover:text-brand">
                        <span
                          className="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded"
                          style={{ background: "var(--dt-surface-2)" }}
                        >
                          {mediaUrl(video.thumbnailKey) ? (
                            <img src={mediaUrl(video.thumbnailKey)!} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <PlayIcon size={14} />
                          )}
                        </span>
                        <span className="line-clamp-1 font-semibold">{video.title}</span>
                      </Link>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{formatCount(video.views)}</td>
                    <td className="py-2 tabular-nums">{formatWatchTime(video.watchSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ lifetime */}
      <section className="dt-card mt-5 p-4 sm:p-5" aria-labelledby="lifetime-heading">
        <h2 id="lifetime-heading" className="text-sm font-bold">
          Lifetime totals
        </h2>
        <p className="mt-0.5 text-xs text-subtle">All-time, not limited to the selected range.</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <Lifetime label="Views" value={formatCount(overview.lifetime.views)} />
          <Lifetime label="Likes" value={formatCount(overview.lifetime.likes)} />
          <Lifetime label="Comments" value={formatCount(overview.lifetime.comments)} />
          <Lifetime label="Subscribers" value={formatCount(overview.lifetime.subscriberCount)} />
          <Lifetime label="Videos" value={formatCount(overview.lifetime.videoCount)} />
        </dl>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dt-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-subtle">{sub}</p>}
    </div>
  );
}

function Lifetime({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--dt-surface-2)" }}>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 text-lg font-bold tabular-nums">{value}</dd>
    </div>
  );
}

/** Original, dependency-free bar chart; theme-aware and width-fluid. */
function ViewsChart({ series, className }: { series: StudioOverview["series"]; className?: string }) {
  const max = Math.max(1, ...series.map((entry) => entry.views));
  const step = 100 / Math.max(1, series.length);
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={`Daily views for the selected range. Peak ${max} views in a day.`}
    >
      {series.map((entry, index) => {
        const height = (entry.views / max) * 100;
        return (
          <rect
            key={entry.day}
            x={index * step}
            y={100 - height}
            width={Math.max(step * 0.82, 0.25)}
            height={height}
            fill="var(--dt-brand)"
          />
        );
      })}
    </svg>
  );
}
