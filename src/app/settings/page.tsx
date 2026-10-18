import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, listSessions } from "@/server/auth/session";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import {
  DangerZone,
  PasswordForm,
  PreferencesForm,
  ProfileForm,
  SessionsList,
} from "./SettingsClient";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Account settings.
 *
 * Every section writes through a real API route: profile, preferences,
 * password (which signs other devices out), active sessions and account
 * deletion. Nothing here is a placeholder.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/settings");

  const sessions = await listSessions(user.id);
  const profile = await prisma.user.findUnique({ where: { id: user.id }, select: { bio: true } });

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <h1 className="text-xl font-bold">Settings</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        Signed in as <strong>@{user.username}</strong> · joined {formatDate(user.createdAt)}
      </p>

      {notice === "admin-password" && (
        <div
          role="status"
          className="dt-card mb-4 border-l-4 p-4"
          style={{ borderLeftColor: "var(--dt-warning)" }}
        >
          <p className="text-sm font-semibold">Change your password to use administrator tools</p>
          <p className="mt-0.5 text-sm text-muted">
            This account was created by the one-time bootstrap and still carries its bootstrap
            password. Set a real password below; the administrator area opens once you have.
          </p>
        </div>
      )}

      <Section title="Profile" description="How you appear across DEXTube.">
        <ProfileForm
          initialDisplayName={user.displayName}
          initialUsername={user.username}
          initialBio={profile?.bio ?? ""}
        />
      </Section>

      <Section title="Email" description="Your email address is used for sign-in recovery and notifications.">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{user.email}</p>
            <p className="text-xs text-subtle">
              {user.emailVerified
                ? "Verified."
                : "Not verified yet. Check your inbox for the confirmation link."}
            </p>
          </div>
          <span className={`dt-badge ${user.emailVerified ? "dt-badge-success" : "dt-badge-warning"}`}>
            {user.emailVerified ? "Verified" : "Unverified"}
          </span>
        </div>
      </Section>

      <Section title="Privacy & notifications" description="Control what DEXTube records and sends you.">
        <PreferencesForm
          initialSaveWatchHistory={user.saveWatchHistory}
          initialShowLikesPublicly={user.showLikesPublicly}
        />
      </Section>

      <Section title="Password" description="Changing your password signs out every device, including this one.">
        <PasswordForm />
      </Section>

      <Section title="Active sessions" description="Devices currently signed in to your account.">
        <SessionsList
          sessions={sessions.map((s) => ({
            id: s.id,
            userAgent: s.userAgent,
            lastSeenAt: s.lastSeenAt.toISOString(),
            createdAt: s.createdAt.toISOString(),
          }))}
        />
      </Section>

      <Section title="Channel" description="Manage your channel identity.">
        <Link href="/studio/channel" className="dt-btn dt-btn-secondary">
          Edit channel profile
        </Link>
      </Section>

      <Section title="Delete account" description="This cannot be undone.">
        <DangerZone username={user.username} />
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dt-card mb-4 p-5">
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mb-4 mt-0.5 text-sm text-muted">{description}</p>
      {children}
    </section>
  );
}
