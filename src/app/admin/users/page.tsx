import type { Metadata } from "next";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireAdminPage } from "@/server/auth/admin";
import { listAdminUsers } from "@/server/services/admin-users";
import { AdminUsersClient } from "./AdminUsersClient";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

/**
 * Administrator user list.
 *
 * The list is bounded in the service. The current administrator's id is passed
 * down so the client can hide the "disable" control on their own row (the
 * service refuses self-disable, so no fake control is offered).
 */
export default async function AdminUsersPage() {
  // Gate before reading: the layout check runs in parallel, not first.
  const viewer = await requireAdminPage();
  const list = await listAdminUsers();

  return (
    <>
      <PageHeader
        title="Users"
        description={`The ${list.users.length} most recently created accounts, administrators first (most ${list.take} shown).`}
      />
      <SectionCard className="mt-4" flush>
        <AdminUsersClient users={list.users} currentUserId={viewer?.id ?? null} />
      </SectionCard>
    </>
  );
}
