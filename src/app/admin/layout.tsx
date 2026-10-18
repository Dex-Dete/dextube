import Link from "next/link";
import { requireAdminPage } from "@/server/auth/admin";
import { LockIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

interface AdminNavItem {
  href: string;
  label: string;
}

const NAV: AdminNavItem[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/import", label: "Import" },
  { href: "/admin/system", label: "System" },
];

/**
 * Administrator area shell.
 *
 * The whole subtree is gated here, and every page under it gates itself as well
 * (see `requireAdminPage`): a layout alone is not a boundary, because App Router
 * renders a page in parallel with its layout. A signed-out visitor and a
 * non-administrator get a 404 rather than an error page, so the area's existence
 * is not disclosed.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();

  return (
    <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-3" style={{ borderColor: "var(--dt-line)" }}>
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
          <LockIcon size={14} />
          Administration
        </p>
        <nav aria-label="Administration sections" className="flex flex-wrap gap-1.5">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="dt-btn dt-btn-secondary !px-3 !py-1 text-[13px]">
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
