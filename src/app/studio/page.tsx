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
import { Avatar } from "@/components/Avatar";
import { mediaUrl } from "@/lib/media-url";
import { formatCount, formatDate, formatWatchTime } from "@/lib/format";
import {
  CommentIcon,
  EyeIcon,
  LikeIcon,
  PlayIcon,
  StudioIcon,
  UploadIcon,
  UsersIcon,
} from "@/components/icons";

export const metadata: Metadata = { title: "Studio" };
export const dynamic = "force-dynamic";

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "7d", label: "Last 7 days" },
  { key: "28d", label: "Last 28 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "365d", label: "Last 365 days" },
];

function parseRange(value: string | undefined): RangeKey {
  return RANGES.some((r) => r.key === value) ? (value as RangeKey) : "28d";
}

/**
 * Studio dashboard.
 *
 * The channel header, KPI cards, view chart and top-video list are all rendered
 * on the server from the daily rollups (`getStudioOverview`), so the page loads
 * with real numbers instead of a client-side spinner. The range selector is a
 * set of links, so it works without JavaScript and every range is shareable.
 */
export default async function StudioDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio");
  if (!user.channel) redirect("/studio/channel");

  const { range: rawRange } = await searchParams;
  const range = parseRange(rawRange);

  // Make sure today's rollup is scheduled before reading it.
  await ensureTodayAggregated();
  const overview = await getStudioOverview(user.channel.id, range);
  const rangeLabel = RANGES.find((r) => r.key === range)!.label;

  const hasVideos = overview.lifetime.videoCount > 0;

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-subtle" aria-label="Breadcrumb">
        <StudioIcon size={14} />
        <span>Studio</span>
      </nav>

      {/* ------------------------------------------------------- channel header */}
      <header className="dt-card flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <Avatar
          name={user.channel.name}
          seed={user.channel.id}
          src={mediaUrl(user.channel.avatarKey)}
          size={64}
          square
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold leading-tight">{user.channel.name}</h1>
          <p className="mt-0.5 text-sm text-muted">
            @{user.channel.handle} · {formatCount(overview.totals.subscriberCount)} subscribers ·{" "}
            {formatCount(overview.totals.videoCount)} videos
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/channel/${user.channel.handle}`} className="dt-btn dt-btn-secondary">
            View channel
          </Link>
          <Link href="/studio/channel" className="dt-btn dt-btn-outline">
            Edit channel
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------- range tabs */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold">Channel analytics</h2>
        <nav className="flex flex-wrap gap-1.5" aria-label="Analytics range">
          {RANGES.map((option) => {
            const active = option.key === range;
            return (
              <Link
                key={option.key}
                href={`/studio?range=${option.key}`}
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

      {/* ----------------------------------------------------------- KPI cards */}
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={<EyeIcon size={16} />} label="Views" value={formatCount(overview.totals.views)} range={rangeLabel} />
        <StatCard
          icon={<PlayIcon size={16} />}
          label="Watch time"
          value={formatWatchTime(overview.totals.watchSeconds)}
          range={rangeLabel}
        />
        <StatCard
          icon={<UsersIcon size={16} />}
          label="Net subscribers"
          value={signed(overview.totals.netSubscribers)}
          sub={`+${formatCount(overview.totals.subscribersGained)} / −${formatCount(overview.totals.subscribersLost)}`}
          range={rangeLabel}
        />
        <StatCard icon={<LikeIcon size={16} />} label="Likes" value={formatCount(overview.totals.likes)} range={rangeLabel} />
        <StatCard
          icon={<CommentIcon size={16} />}
          label="Comments"
          value={formatCount(overview.totals.comments)}
          range={rangeLabel}
        />
        <StatCard icon={<UploadIcon size={16} />} label="Uploads" value={formatCount(overview.totals.uploads)} range={rangeLabel} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------ chart */}
        <section className="dt-card p-4" aria-labelledby="views-heading">
          <div className="flex items-center justify-between gap-2">
            <h2 id="views-heading" className="text-sm font-bold">
              Views per day
            </h2>
            <span className="text-xs text-subtle">{rangeLabel}</span>
          </div>

          <figure className="mt-3">
            <ViewsChart series={overview.series} className="h-28 w-full" />
            <figcaption className="mt-2 flex justify-between text-[11px] text-subtle">
              <span>{overview.series[0] ? formatDate(overview.series[0].day) : ""}</span>
              <span>
                Peak {formatCount(Math.max(0, ...overview.series.map((s) => s.views)))} views/day
              </span>
              <span>
                {overview.series.length ? formatDate(overview.series[overview.series.length - 1]!.day) : ""}
              </span>
            </figcaption>
          </figure>

          {/* Non-colour fallback: the same series as text. */}
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-subtle">View daily data as a table</summary>
            <div className="mt-2 max-h-72 overflow-auto">
              <table className="w-full border-collapse text-left">
                <caption className="dt-visually-hidden">Views and watch time per day</caption>
                <thead>
                  <tr className="text-subtle">
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Day
                    </th>
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Views
                    </th>
                    <th scope="col" className="py-1 font-semibold">
                      Watch time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.series.map((entry) => (
                    <tr key={entry.day} className="border-t border-line">
                      <td className="py-1 pr-3 whitespace-nowrap">{formatDate(entry.day)}</td>
                      <td className="py-1 pr-3 tabular-nums">{formatCount(entry.views)}</td>
                      <td className="py-1 tabular-nums">{formatWatchTime(entry.watchSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>

        {/* -------------------------------------------------------- top videos */}
        <section className="dt-card p-4" aria-labelledby="top-heading">
          <h2 id="top-heading" className="text-sm font-bold">
            Top videos
          </h2>
          <p className="mt-0.5 text-xs text-subtle">{rangeLabel}</p>

          {overview.topVideos.length === 0 ? (
            <p className="mt-3 text-sm text-subtle">No views in this range yet.</p>
          ) : (
            <ol className="mt-3 flex flex-col gap-3">
              {overview.topVideos.map((video, index) => (
                <li key={video.videoId} className="flex items-center gap-3">
                  <span className="w-4 shrink-0 text-right text-xs text-subtle tabular-nums">{index + 1}</span>
                  <Link
                    href={`/studio/videos/${video.videoId}`}
                    className="relative block h-10 w-[71px] shrink-0 overflow-hidden rounded-md"
                    style={{ background: "var(--dt-surface-2)" }}
                  >
                    {mediaUrl(video.thumbnailKey) ? (
                      <img src={mediaUrl(video.thumbnailKey)!} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-subtle">
                        <PlayIcon size={16} />
                      </span>
                    )}
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/studio/videos/${video.videoId}`}
                      className="line-clamp-2 text-[13px] font-semibold leading-snug hover:text-brand"
                    >
                      {video.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-subtle">
                      {formatCount(video.views)} views · {formatWatchTime(video.watchSeconds)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* ----------------------------------------------------------- quick actions */}
      <section className="mt-5 grid gap-3 sm:grid-cols-3" aria-label="Quick actions">
        <QuickAction
          href="/studio/upload"
          title="Upload a video"
          description="Add a new video to your channel."
          icon={<UploadIcon size={20} />}
          primary
        />
        <QuickAction
          href="/studio/videos"
          title="Manage videos"
          description="Edit, publish or delete your uploads."
          icon={<StudioIcon size={20} />}
        />
        <QuickAction
          href="/studio/analytics"
          title="Analytics"
          description="Dive into views, watch time and subscribers."
          icon={<EyeIcon size={20} />}
        />
      </section>

      {!hasVideos && (
        <div className="dt-card mt-5 flex flex-col items-center gap-3 px-6 py-12 text-center">
          <UploadIcon size={36} />
          <h2 className="text-lg font-bold">No videos yet</h2>
          <p className="max-w-md text-sm text-muted">
            Upload your first video and its views, watch time and subscribers will start showing up here within a day.
          </p>
          <Link href="/studio/upload" className="dt-btn dt-btn-primary">
            Upload a video
          </Link>
        </div>
      )}
    </div>
  );
}

/** Signed compact number, e.g. +1.2K / −14. */
function signed(value: number): string {
  return `${value >= 0 ? "+" : "−"}${formatCount(Math.abs(value))}`;
}

function StatCard({
  icon,
  label,
  value,
  sub,
  range,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  range: string;
}) {
  return (
    <div className="dt-card p-4">
      <div className="flex items-center gap-1.5 text-subtle">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-subtle">{sub ?? range}</p>
    </div>
  );
}

function QuickAction({
  href,
  title,
  description,
  icon,
  primary = false,
}: {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link href={href} className={`dt-card dt-card-hover flex items-start gap-3 p-4 ${primary ? "border-brand" : ""}`}>
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: primary ? "var(--dt-brand)" : "var(--dt-surface-2)", color: primary ? "#fff" : "var(--dt-fg)" }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </span>
    </Link>
  );
}

/**
 * Original bar chart drawn as inline SVG — no charting dependency, theme-aware
 * via the CSS variables, and scaled with `preserveAspectRatio="none"` so it
 * fills whatever width it is given.
 */
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
