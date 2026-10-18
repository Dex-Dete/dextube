import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase, prisma } from "@/lib/db";
import {
  AGGREGATE_REFRESH_MS,
  resetSchedulerThrottle,
  scheduleRecurringJobs,
} from "@/server/jobs/scheduler";

const dbOk = (await checkDatabase()).ok;
const createdKeys: string[] = [];

afterAll(async () => {
  if (createdKeys.length > 0) {
    await prisma.job.deleteMany({ where: { dedupeKey: { in: createdKeys } } });
  }
});

/**
 * Uses a far-future date so the de-duplication keys can never collide with a
 * running development server's schedule. The jobs themselves are removed after
 * the run.
 */
describe.skipIf(!dbOk)("recurring job scheduler", () => {
  it("schedules today's rollup and maintenance once, then de-duplicates", async () => {
    const now = new Date(Date.UTC(2035, 5, 15, 0, 30, 0)); // 00:30 UTC
    const dayKey = "2035-06-15";
    const bucket = Math.floor(now.getTime() / AGGREGATE_REFRESH_MS);
    createdKeys.push(`analytics:${dayKey}:${bucket}`, "analytics-final:2035-06-14", `maintenance:${dayKey}`);

    resetSchedulerThrottle();
    const first = await scheduleRecurringJobs(now);
    expect(first).toEqual({ aggregate: true, finalisedYesterday: true, maintenance: true });

    const second = await scheduleRecurringJobs(now);
    expect(second).toEqual({ aggregate: false, finalisedYesterday: false, maintenance: false });

    const jobs = await prisma.job.findMany({
      where: { dedupeKey: { in: createdKeys } },
      select: { type: true },
    });
    expect(jobs.filter((j) => j.type === "analytics.aggregate")).toHaveLength(2);
    expect(jobs.filter((j) => j.type === "maintenance.prune")).toHaveLength(1);
  });

  it("does not finalise yesterday outside the midnight window", async () => {
    const now = new Date(Date.UTC(2035, 5, 16, 12, 0, 0));
    const dayKey = "2035-06-16";
    const bucket = Math.floor(now.getTime() / AGGREGATE_REFRESH_MS);
    createdKeys.push(`analytics:${dayKey}:${bucket}`, `maintenance:${dayKey}`);

    resetSchedulerThrottle();
    const result = await scheduleRecurringJobs(now);
    expect(result.finalisedYesterday).toBe(false);
    expect(result.aggregate).toBe(true);
  });
});
