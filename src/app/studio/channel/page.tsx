import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getChannelProfile } from "@/server/services/channels";
import { Avatar } from "@/components/Avatar";
import { mediaUrl } from "@/lib/media-url";
import { formatCount, formatDate } from "@/lib/format";
import { StudioIcon } from "@/components/icons";
import { ChannelForm } from "./ChannelForm";

export const metadata: Metadata = { title: "Channel settings" };
export const dynamic = "force-dynamic";

/**
 * Channel settings.
 *
 * The profile is preloaded on the server from `getChannelProfile`, then the
 * client form saves through `PATCH /api/channels/me`. Image uploads are not yet
 * part of Studio, so the avatar/banner controls are rendered disabled with an
 * explanation rather than pretending to work.
 */
export default async function StudioChannelPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio/channel");

  const profile = user.channel ? await getChannelProfile(user.channel.handle, user.id) : null;

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-subtle" aria-label="Breadcrumb">
        <StudioIcon size={14} />
        <Link href="/studio" className="dt-link">
          Studio
        </Link>
        <span aria-hidden="true">/</span>
        <span>Channel</span>
      </nav>

      <div className="mb-4">
        <h1 className="text-xl font-bold">Channel settings</h1>
        <p className="mt-0.5 text-sm text-muted">Update how your channel appears across DEXTube.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ChannelForm
          mode={profile ? "edit" : "create"}
          initialName={profile?.name ?? ""}
          initialHandle={profile?.handle ?? ""}
          initialDescription={profile?.description ?? ""}
        />

        <div className="flex flex-col gap-5">
          {/* -------------------------------------------------------- branding */}
          <section className="dt-card p-4" aria-labelledby="branding-heading">
            <h2 id="branding-heading" className="text-sm font-bold">
              Branding
            </h2>

            <div
              className="relative mt-3 h-24 w-full overflow-hidden rounded-lg"
              style={{ background: "var(--dt-surface-2)" }}
            >
              {profile?.bannerKey ? (
                <img src={mediaUrl(profile.bannerKey)!} alt="" className="h-full w-full object-cover" />
              ) : (
                <div
                  className="h-full w-full"
                  style={{ background: "linear-gradient(120deg, var(--dt-brand), var(--dt-accent))", opacity: 0.25 }}
                />
              )}
            </div>

            <div className="mt-3 flex items-center gap-3">
              <Avatar
                name={profile?.name ?? user.displayName}
                seed={profile?.id ?? user.id}
                src={mediaUrl(profile?.avatarKey ?? null)}
                size={64}
                square
              />
              <div className="min-w-0">
                <p className="truncate font-semibold">{profile?.name ?? user.displayName}</p>
                <p className="text-xs text-subtle">{profile ? `@${profile.handle}` : "No channel yet"}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="dt-btn dt-btn-secondary"
                disabled
                title="Image uploads are not available in Studio yet."
              >
                Change avatar
              </button>
              <button
                type="button"
                className="dt-btn dt-btn-secondary"
                disabled
                title="Image uploads are not available in Studio yet."
              >
                Change banner
              </button>
            </div>
            <p className="mt-2 text-xs text-subtle">
              Image uploads are not yet available in Studio. Your existing avatar and banner are shown as visitors see
              them.
            </p>
          </section>

          {/* ------------------------------------------------------ channel facts */}
          {profile && (
            <section className="dt-card p-4" aria-labelledby="facts-heading">
              <h2 id="facts-heading" className="text-sm font-bold">
                Channel
              </h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-subtle">Subscribers</dt>
                  <dd className="font-semibold tabular-nums">{formatCount(profile.subscriberCount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle">Videos</dt>
                  <dd className="font-semibold tabular-nums">{formatCount(profile.videoCount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle">Shorts</dt>
                  <dd className="font-semibold tabular-nums">{formatCount(profile.shortCount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle">Created</dt>
                  <dd className="font-semibold">{formatDate(profile.createdAt)}</dd>
                </div>
              </dl>
              <Link href={`/channel/${profile.handle}`} className="dt-btn dt-btn-outline mt-4">
                View public channel
              </Link>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
