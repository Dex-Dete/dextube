import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { listStudioVideos } from "@/server/services/videos";
import { StudioIcon, UploadIcon } from "@/components/icons";
import { VideoListClient } from "./VideoListClient";

export const metadata: Metadata = { title: "Your videos" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const STATUSES = ["DRAFT", "PROCESSING", "READY", "FAILED"] as const;
const VISIBILITIES = ["PRIVATE", "UNLISTED", "PUBLIC"] as const;

/**
 * Studio video list.
 *
 * The first page is fetched server-side (owner-scoped), so the list is useful
 * with JavaScript disabled; `VideoListClient` then adds search, filters,
 * pagination and the row actions on top.
 */
export default async function StudioVideosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; visibility?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio/videos");
  if (!user.channel) redirect("/studio/channel");

  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 120);
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : "ALL";
  const visibility = (VISIBILITIES as readonly string[]).includes(sp.visibility ?? "") ? sp.visibility! : "ALL";

  const page = await listStudioVideos({
    userId: user.id,
    query: q || undefined,
    status: status === "ALL" ? undefined : status,
    visibility: visibility === "ALL" ? undefined : visibility,
    limit: PAGE_SIZE,
  });

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 flex items-center gap-1.5 text-xs text-subtle" aria-label="Breadcrumb">
        <StudioIcon size={14} />
        <Link href="/studio" className="dt-link">
          Studio
        </Link>
        <span aria-hidden="true">/</span>
        <span>Videos</span>
      </nav>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Your videos</h1>
          <p className="mt-0.5 text-sm text-muted">Manage, publish and moderate everything on {user.channel.name}.</p>
        </div>
        <Link href="/studio/upload" className="dt-btn dt-btn-primary">
          <UploadIcon size={17} /> Upload
        </Link>
      </div>

      <VideoListClient
        initialItems={page.items}
        initialCursor={page.nextCursor}
        initialQuery={q}
        initialStatus={status}
        initialVisibility={visibility}
      />
    </div>
  );
}
