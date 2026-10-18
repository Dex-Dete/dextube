/**
 * Studio content management.
 *
 * The creator-facing video table needs more than the read-only feed helpers in
 * `videos.ts` provide: offset pagination with an enforced page cap, sorting by
 * several columns with a stable tiebreak, and bulk lifecycle actions. Those
 * live here so the (deliberately untouched) `videos.ts` stays the single source
 * of truth for visibility and lifecycle rules — every mutation below simply
 * calls its exported functions, so ownership and soft-delete semantics are the
 * same as a single-video action from the editor.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { isAppError, notFound, preconditionFailed } from "@/lib/errors";
import { deleteVideo, publishVideo, unpublishVideo } from "@/server/services/videos";
import { enqueue } from "@/server/jobs/queue";
import type { Prisma, Visibility } from "@prisma/client";

/* ------------------------------------------------------------- pagination */

/**
 * The table is never allowed to return unbounded rows. These caps are enforced
 * here (in the service) as well as in the request schema, so a hand-crafted
 * query cannot widen them.
 */
export const STUDIO_PAGE_SIZE_DEFAULT = 20;
export const STUDIO_PAGE_SIZE_MAX = 50;

export const STUDIO_SORTS = ["createdAt", "publishedAt", "views", "title"] as const;
export type StudioSort = (typeof STUDIO_SORTS)[number];
export type SortDirection = "asc" | "desc";

export interface StudioVideoListItem {
  id: string;
  title: string;
  visibility: Visibility;
  status: string;
  isShort: boolean;
  durationSec: number;
  thumbnailKey: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string | null;
  createdAt: string;
  processingError: string | null;
}

export interface StudioVideoPage {
  items: StudioVideoListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface StudioListOptions {
  userId: string;
  query?: string;
  status?: string;
  visibility?: string;
  sort?: StudioSort;
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
}

/** Sort key plus a stable final tiebreak, so pages cannot overlap or skip. */
function orderFor(sort: StudioSort, direction: SortDirection): Prisma.VideoOrderByWithRelationInput[] {
  switch (sort) {
    case "publishedAt":
      // Drafts have no `publishedAt`; keep them visible at the end instead of
      // letting null ordering flip with the direction.
      return [{ publishedAt: { sort: direction, nulls: "last" } }, { id: "desc" }];
    case "views":
      return [{ viewCount: direction }, { id: "desc" }];
    case "title":
      return [{ title: direction }, { id: "desc" }];
    case "createdAt":
    default:
      return [{ createdAt: direction }, { id: "desc" }];
  }
}

/** Owner-scoped list with search, filters, sorting and capped pagination. */
export async function listStudioVideoPage(options: StudioListOptions): Promise<StudioVideoPage> {
  const pageSize = Math.min(STUDIO_PAGE_SIZE_MAX, Math.max(1, Math.trunc(options.pageSize ?? STUDIO_PAGE_SIZE_DEFAULT)));
  const page = Math.max(1, Math.trunc(options.page ?? 1));

  const where: Prisma.VideoWhereInput = {
    deletedAt: null,
    channel: { ownerId: options.userId },
    ...(options.query ? { title: { contains: options.query, mode: "insensitive" } } : {}),
    ...(options.status && options.status !== "ALL" ? { status: options.status as never } : {}),
    ...(options.visibility && options.visibility !== "ALL" ? { visibility: options.visibility as Visibility } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.video.count({ where }),
    prisma.video.findMany({
      where,
      orderBy: orderFor(options.sort ?? "createdAt", options.direction ?? "desc"),
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        visibility: true,
        status: true,
        isShort: true,
        durationSec: true,
        thumbnailKey: true,
        viewCount: true,
        likeCount: true,
        commentCount: true,
        publishedAt: true,
        createdAt: true,
        processingError: true,
      },
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      status: row.status,
      isShort: row.isShort,
      durationSec: row.durationSec,
      thumbnailKey: row.thumbnailKey,
      viewCount: row.viewCount,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      processingError: row.processingError,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/* ----------------------------------------------------------- bulk actions */

export type BulkAction = "publish" | "unpublish" | "delete";

export interface BulkActionResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Applies one lifecycle action to many videos.
 *
 * Each video is authorised and mutated on its own by the `videos.ts` service
 * functions, so a foreign or missing id fails closed and is reported instead of
 * being silently skipped — and a failure never rolls back the ids that did
 * succeed. Callers surface both sets to the creator.
 */
export async function bulkVideoAction(
  userId: string,
  action: BulkAction,
  ids: string[],
): Promise<BulkActionResult[]> {
  const results: BulkActionResult[] = [];
  for (const id of ids) {
    try {
      if (action === "publish") await publishVideo(id, userId, "PUBLIC");
      else if (action === "unpublish") await unpublishVideo(id, userId);
      else await deleteVideo(id, userId);
      results.push({ id, ok: true });
    } catch (error) {
      results.push({
        id,
        ok: false,
        error: isAppError(error)
          ? error.message
          : "That video could not be updated. Please try again.",
      });
    }
  }
  return results;
}

/* ---------------------------------------------------------------- retry */

/** How long a retry request is de-duplicated, so a double-click queues one job. */
const RETRY_DEDUPE_MS = 60_000;

/**
 * Re-runs media processing for a video that failed.
 *
 * This does not re-implement processing: it looks up the original upload row
 * (the `media.process` job's required input) and enqueues the same job the
 * upload flow uses. `processVideo` is idempotent, so a retry converges on the
 * same result whether the failure happened before or after promotion.
 *
 * If the upload row is gone there is genuinely nothing left to retry from, and
 * the creator is told to upload again rather than shown a button that cannot
 * work.
 */
export async function retryVideoProcessing(
  videoId: string,
  userId: string,
): Promise<{ queued: boolean }> {
  const video = await prisma.video.findFirst({
    where: { id: videoId, deletedAt: null, channel: { ownerId: userId } },
    select: { id: true, status: true },
  });
  if (!video) throw notFound("That video does not exist.");
  if (video.status !== "FAILED") {
    throw preconditionFailed("Only a video whose processing failed can be retried.");
  }

  const upload = await prisma.upload.findUnique({ where: { videoId }, select: { id: true } });
  if (!upload) {
    throw preconditionFailed(
      "The original upload for this video is no longer available, so it cannot be retried. Upload the file again.",
    );
  }

  const bucket = Math.floor(Date.now() / RETRY_DEDUPE_MS);
  const job = await enqueue(
    "media.process",
    { videoId, uploadId: upload.id },
    { dedupeKey: `media-retry:${videoId}:${bucket}` },
  );
  return { queued: job !== null };
}
