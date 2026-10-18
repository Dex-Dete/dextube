import type { Metadata } from "next";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireAdminPage } from "@/server/auth/admin";
import { bootstrapStatus } from "@/server/services/admin-bootstrap";
import { AdminSystemClient } from "./AdminSystemClient";

export const metadata: Metadata = { title: "System settings" };
export const dynamic = "force-dynamic";

/**
 * The documented recovery procedure, shown verbatim. The bootstrap is only ever
 * re-armed from the server host (shell access), never from the web UI.
 */
const PSQL_RECOVERY = `psql "$DATABASE_URL" <<'SQL'
UPDATE system_settings SET "adminBootstrapEnabled" = true, "updatedBy" = 'operator' WHERE id = 1;
SQL
npm run admin:bootstrap`;

/**
 * System settings.
 *
 * The only control the application can offer is turning the administrator
 * bootstrap *off*; re-enabling it is intentionally not possible here, so no
 * control is rendered for it (only the documented operator procedure).
 */
export default async function AdminSystemPage() {
  // Gate before reading: the layout check runs in parallel, not first.
  await requireAdminPage();
  const status = await bootstrapStatus();

  return (
    <>
      <PageHeader
        title="System settings"
        description="Deployment-level switches for this DEXTube instance."
      />

      <div className="mt-4 flex flex-col gap-5">
        <SectionCard title="Administrator bootstrap" description="Whether DEXTube may create its first administrator account.">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Fact label="Environment" value={status.environment} />
            <Fact label="Environment switch" value={status.envEnabled ? "Enabled" : "Disabled"} />
            <Fact label="Database switch" value={status.dbEnabled ? "Enabled" : "Disabled"} />
            <Fact label="Administrators" value={String(status.adminCount)} />
            <Fact label="Bootstrap username" value={status.username} />
            <Fact label="Bootstrap password configured" value={status.hasPassword ? "Yes" : "No"} />
          </dl>

          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--dt-line)" }}>
            <AdminSystemClient dbEnabled={status.dbEnabled} />
          </div>
        </SectionCard>

        <SectionCard
          title="Re-enabling the bootstrap"
          description="Why this cannot be done from the web UI, and how an operator does it."
        >
          <div className="flex flex-col gap-3 text-sm text-muted">
            <p>
              Turning the bootstrap <strong>on</strong> is refused by the application (a 403). Re-arming it is
              exactly what an attacker with a stolen administrator session would want, because it lets them mint a
              fresh, well-known account that survives a password change. It therefore requires direct access to the
              server host.
            </p>
            <p>An operator with database access can re-enable it and run the bootstrap in one command:</p>
            <pre
              className="overflow-x-auto rounded-md p-3 text-[12px]"
              style={{ background: "var(--dt-surface-2)", color: "var(--dt-fg)" }}
            >
              <code>{"npm run admin:bootstrap -- --enable-bootstrap-as-operator"}</code>
            </pre>
            <p>Equivalently, directly in the database, then run the bootstrap:</p>
            <pre
              className="overflow-x-auto rounded-md p-3 text-[12px]"
              style={{ background: "var(--dt-surface-2)", color: "var(--dt-fg)" }}
            >
              <code>{PSQL_RECOVERY}</code>
            </pre>
            <p>
              The bootstrap only ever <strong>creates</strong> an account. It does nothing if any administrator
              already exists, so re-enabling it can never reset an existing password. Disable it again when you are
              done.
            </p>
          </div>
        </SectionCard>
      </div>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  );
}
