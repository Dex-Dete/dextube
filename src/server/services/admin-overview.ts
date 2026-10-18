import "server-only";

import { prisma } from "@/lib/db";
import { importStorageSummary } from "./import-sources";

export interface AdminOverviewStats {
  users: number;
  videos: number;
  readyVideos: number;
  mediaBytes: number;
  importStorage: Awaited<ReturnType<typeof importStorageSummary>>;
  jobs: {
    pending: number;
    running: number;
    failed: number;
  };
}

/** Bounded, exact counts for the administrator overview; no decorative metrics. */
export async function getAdminOverviewStats(): Promise<AdminOverviewStats> {
  const [users, videos, readyVideos, media, jobs, importStorage] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.video.count({ where: { deletedAt: null } }),
    prisma.video.count({ where: { deletedAt: null, status: "READY" } }),
    prisma.videoAsset.aggregate({ _sum: { sizeBytes: true } }),
    prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
    importStorageSummary(),
  ]);

  const jobsByStatus = new Map(jobs.map((row) => [row.status, row._count._all]));
  return {
    users,
    videos,
    readyVideos,
    mediaBytes: Number(media._sum.sizeBytes ?? 0),
    importStorage,
    jobs: {
      pending: jobsByStatus.get("PENDING") ?? 0,
      running: jobsByStatus.get("RUNNING") ?? 0,
      failed: jobsByStatus.get("FAILED") ?? 0,
    },
  };
}
