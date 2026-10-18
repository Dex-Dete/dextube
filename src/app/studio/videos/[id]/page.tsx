import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getOwnedVideo, type StudioVideo } from "@/server/services/videos";
import { listReportedComments } from "@/server/services/comments";
import { isAppError } from "@/lib/errors";
import { StudioIcon } from "@/components/icons";
import { VideoEditor, type EditableVideo } from "./VideoEditor";
import { ReportedComments, type ReportedComment } from "./ReportedComments";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return { title: "Edit video" };
  try {
    const video = await getOwnedVideo(id, user.id);
    return { title: `Edit · ${video.title}` };
  } catch {
    return { title: "Edit video" };
  }
}

/**
 * Edit one of the creator's videos: metadata, publish state and the report
 * queue. Ownership is enforced by `getOwnedVideo`; a missing or foreign id
 * becomes a 404 rather than leaking that the video exists.
 */
export default async function StudioVideoEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/studio/videos/${encodeURIComponent(id)}`);
  if (!user.channel) redirect("/studio/channel");

  let video: StudioVideo;
  try {
    video = await getOwnedVideo(id, user.id);
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  let reports: ReportedComment[] = [];
  let reportTotal = 0;
  let reportPage = 1;
  let reportPageCount = 1;
  try {
    const queue = await listReportedComments(
      id,
      { userId: user.id, channelId: user.channel.id, role: user.role },
      { page: 1 },
    );
    reports = queue.items;
    reportTotal = queue.total;
    reportPage = queue.page;
    reportPageCount = queue.pageCount;
  } catch {
    // A transient failure loading reports must not take down the editor.
    reports = [];
  }

  const editable: EditableVideo = video;

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-subtle" aria-label="Breadcrumb">
        <StudioIcon size={14} />
        <Link href="/studio" className="dt-link">
          Studio
        </Link>
        <span aria-hidden="true">/</span>
        <Link href="/studio/videos" className="dt-link">
          Videos
        </Link>
        <span aria-hidden="true">/</span>
        <span>Edit</span>
      </nav>

      <div className="mb-4">
        <h1 className="text-xl font-bold">Edit video</h1>
        <p className="mt-0.5 truncate text-sm text-muted">{video.title}</p>
      </div>

      <VideoEditor video={editable} />

      <div className="mt-5">
        <ReportedComments
          videoId={video.id}
          initialReports={reports}
          initialTotal={reportTotal}
          initialPage={reportPage}
          initialPageCount={reportPageCount}
        />
      </div>
    </div>
  );
}
