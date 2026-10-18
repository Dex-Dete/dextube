import type { Metadata } from "next";
import { PageHeader, SectionCard, StatCard, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { requireAdminPage } from "@/server/auth/admin";
import { bootstrapStatus } from "@/server/services/admin-bootstrap";
import { listAuditLog } from "@/server/services/audit";

export const metadata: Metadata = { title: "Administration" };
export const dynamic = "force-dynamic";

/** How many recent audit entries the overview shows. */
const AUDIT_TAKE = 25;

/**
 * Administration overview.
 *
 * Everything here is real server data: the administrator count and bootstrap
 * switches come from `bootstrapStatus()`, and the table is the actual audit
 * trail. No placeholder rows.
 */
export default async function AdminOverviewPage() {
  // The layout gates this subtree too, but a page renders in parallel with its
  // layout — so the page must refuse *before* it reads the audit trail, or the
  // data would be serialised into the response for a rejected visitor.
  await requireAdminPage();

  const [status, audit] = await Promise.all([
    bootstrapStatus(),
    listAuditLog({ take: AUDIT_TAKE }),
  ]);

  return (
    <>
      <PageHeader
        title="Administration overview"
        description="Account and bootstrap state for this DEXTube instance."
      />

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Administrators" value={status.adminCount} hint="Accounts with the ADMIN role" />
        <StatCard label="Environment" value={status.environment} hint="DEXTUBE_ENV" />
        <StatCard
          label="Bootstrap (env)"
          value={status.envEnabled ? "Enabled" : "Disabled"}
          hint="ADMIN_BOOTSTRAP_ENABLED"
        />
        <StatCard
          label="Bootstrap (database)"
          value={status.dbEnabled ? "Enabled" : "Disabled"}
          hint="system_settings switch"
        />
      </div>

      <SectionCard
        className="mt-5"
        title="Recent audit log"
        description={`The ${AUDIT_TAKE} most recent administrative actions.`}
        flush
      >
        {audit.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No administrative actions recorded yet"
            description="Changes to the bootstrap switch, account suspension and other privileged actions appear here as they happen."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="dt-visually-hidden">
                The {AUDIT_TAKE} most recent administrative audit entries
              </caption>
              <thead>
                <tr className="text-xs text-subtle">
                  <th scope="col" className="px-4 py-2 font-semibold">Actor</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Action</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Target</th>
                  <th scope="col" className="px-4 py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id} className="border-t" style={{ borderColor: "var(--dt-line)" }}>
                    <td className="px-4 py-2 whitespace-nowrap">{entry.actorLabel}</td>
                    <td className="px-4 py-2">
                      <code className="text-[12px]">{entry.action}</code>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">
                      {entry.targetType ? `${entry.targetType}:${entry.targetId ?? "—"}` : "—"}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{formatDateTime(entry.createdAt)}</td>
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
