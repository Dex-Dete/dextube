import "server-only";

import { prisma } from "@/lib/db";

export async function listAdminJobs(take = 100) {
  return prisma.job.findMany({
    orderBy: { updatedAt: "desc" },
    take: Math.min(100, Math.max(1, take)),
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      runAt: true,
      lockedAt: true,
      lockedBy: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
