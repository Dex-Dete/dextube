import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { DownloadIcon, LockIcon, MusicIcon } from "@/components/icons";
import { getViewerContext } from "@/server/auth/session";
import { getTrack } from "@/server/services/music";
import { isAppError } from "@/lib/errors";
import { streamUrl } from "@/lib/media-url";
import { formatDuration } from "@/lib/format";
import type { TrackDTO } from "@/lib/dto";
import { TrackPlayer } from "./TrackPlayer";

export const dynamic = "force-dynamic";

interface TrackPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: TrackPageProps): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getViewerContext();
  try {
    const track = await getTrack(id, viewer);
    return {
      title: `${track.title} · ${track.artist}`,
      description: `${track.title} by ${track.artist}${track.album ? `, from ${track.album}` : ""}.`,
    };
  } catch {
    return { title: "Track" };
  }
}

/**
 * One DEX Music track.
 *
 * The page renders the rights metadata the licence actually carries — source,
 * licence, the exact attribution line, territory and whether downloads are
 * permitted — because that is the whole point of DEX Music: a listener can see
 * on what terms a recording is available.
 *
 * The download control is rendered **only** when `rights.downloadAllowed` is
 * true. When it is false the page says so in words instead of showing a
 * disabled button, and the media route independently refuses a `?download=1`
 * request — the UI is never the enforcement point.
 */
export default async function TrackPage({ params }: TrackPageProps) {
  const { id } = await params;
  const viewer = await getViewerContext();

  let track: TrackDTO;
  try {
    track = await getTrack(id, viewer);
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  const rights = track.rights;
  const downloadUrl = rights?.downloadAllowed ? streamUrl(track.audioKey, { download: true }) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader
        eyebrow={track.album ?? "Track"}
        title={track.title}
        description={
          <>
            {track.artist} ·{" "}
            <Link href={`/channel/${track.channel.handle}`} className="dt-link">
              {track.channel.name}
            </Link>{" "}
            · {formatDuration(track.durationSec)}
          </>
        }
        actions={<TrackPlayer track={track} />}
        className="mb-6"
      />

      {track.visibility !== "PUBLIC" ? (
        <p className="dt-alert dt-alert-info mb-4 flex items-center gap-2 text-xs">
          <LockIcon size={14} />
          <span>
            {track.visibility === "PRIVATE"
              ? "Private: only this channel (and moderators) can see this track."
              : "Unlisted: reachable by link, but it is not listed in the library."}
          </span>
        </p>
      ) : null}

      <section aria-labelledby="rights-heading" className="mt-2">
        <h2 id="rights-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <MusicIcon size={16} />
          Rights and licence
        </h2>

        {rights ? (
          <div
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: "var(--dt-line)", background: "var(--dt-surface)" }}
          >
            <dl className="divide-y" style={{ borderColor: "var(--dt-line)" }}>
              <RightsRow label="Source" value={rights.source} />
              <RightsRow label="Licence" value={rights.license} />
              <RightsRow
                label="Attribution"
                value={<span className="italic">{rights.attribution}</span>}
                hint="Displayed verbatim, as the licence requires."
              />
              <RightsRow label="Territory" value={rights.territory} />
              <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <dt className="text-xs font-semibold uppercase tracking-wide text-subtle">Downloads</dt>
                <dd className="text-sm">
                  {rights.downloadAllowed ? (
                    downloadUrl ? (
                      <a href={downloadUrl} className="dt-btn dt-btn-secondary">
                        <DownloadIcon size={16} />
                        <span>Download audio</span>
                      </a>
                    ) : null
                  ) : (
                    <span className="text-muted">
                      Not permitted — this licence allows streaming only, so no download is offered.
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="dt-alert dt-alert-error text-sm">
            No rights metadata is stored for this track. DEX Music cannot state a source, licence or
            territory, and downloads are refused by the server until a rights record exists. Tracks
            are added with their rights by the operator (<code>prisma/seed.ts</code>).
          </p>
        )}
      </section>
    </div>
  );
}

function RightsRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="min-w-0 text-sm">
        {value}
        {hint ? <span className="mt-0.5 block text-xs text-subtle">{hint}</span> : null}
      </dd>
    </div>
  );
}
