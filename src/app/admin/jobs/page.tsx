import type { Metadata } from "next";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { requireAdminPage } from "@/server/auth/admin";
import { listAdminJobs } from "@/server/services/admin-jobs";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

export default async function AdminJobsPage() {
  await requireAdminPage();
  const jobs = await listAdminJobs();

  return (
    <>
      <PageHeader
        title="Processing jobs"
        description="The latest persisted background jobs. Status and errors come from the DB-backed queue."
      />
      <SectionCard className="mt-5" flush>
        {jobs.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No jobs recorded"
            description="Media processing, analytics and maintenance jobs will appear here when queued."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="dt-visually-hidden">Recent processing jobs</caption>
              <thead>
                <tr className="text-xs text-subtle">
                  <th scope="col" className="px-4 py-2 font-semibold">Type</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Attempts</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Scheduled</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Error</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t align-top" style={{ borderColor: "var(--dt-line)" }}>
                    <td className="px-4 py-2"><code className="text-[12px]">{job.type}</code></td>
                    <td className="px-4 py-2">
                      <span className={`dt-badge ${job.status === "FAILED" ? "dt-badge-danger" : job.status === "SUCCEEDED" ? "dt-badge-success" : "dt-badge-warning"}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted">{job.attempts}/{job.maxAttempts}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{formatDateTime(job.runAt)}</td>
                    <td className="max-w-[420px] px-4 py-2 text-xs text-danger">{job.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
