import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { listStudioVideoPage, STUDIO_PAGE_SIZE_DEFAULT } from "@/server/services/studio-videos";
import { StudioIcon, UploadIcon } from "@/components/icons";
import { VideoListClient } from "./VideoListClient";

export const metadata: Metadata = { title: "Your videos" };
export const dynamic = "force-dynamic";

const STATUSES = ["DRAFT", "PROCESSING", "READY", "FAILED"] as const;
const VISIBILITIES = ["PRIVATE", "UNLISTED", "PUBLIC"] as const;

/**
 * Studio video list.
 *
 * The first page is fetched server-side (owner-scoped), so the list is useful
 * with JavaScript disabled; `VideoListClient` then adds search, filters,
 * sorting, pagination, selection and the row/bulk actions on top.
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

  const page = await listStudioVideoPage({
    userId: user.id,
    query: q || undefined,
    status: status === "ALL" ? undefined : status,
    visibility: visibility === "ALL" ? undefined : visibility,
    pageSize: STUDIO_PAGE_SIZE_DEFAULT,
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
        initialTotal={page.total}
        initialPage={page.page}
        initialPageCount={page.pageCount}
        initialQuery={q}
        initialStatus={status}
        initialVisibility={visibility}
      />
    </div>
  );
}
