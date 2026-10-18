import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { getShortById, getShortsFeedDetailed } from "@/server/services/videos";
import { ShortsFeed } from "@/components/shorts/ShortsFeed";

export const dynamic = "force-dynamic";

interface ShortPageProps {
  params: Promise<{ id: string }>;
}

/** Real title in metadata so shared Shorts links are meaningful. */
export async function generateMetadata({ params }: ShortPageProps): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const short = await getShortById(id, user?.id ?? null);
  return short ? { title: `${short.title} · Shorts` } : { title: "Short not found" };
}

/**
 * Deep link to a single Short.
 *
 * The requested short is placed first so it is what the viewer lands on, then
 * the rest of the feed follows so they can keep scrolling. A short that is not
 * public (private, unlisted, failed or unknown) 404s — the same rule the rest
 * of the site uses.
 */
export default async function ShortPage({ params }: ShortPageProps) {
  const { id } = await params;
  const user = await getCurrentUser();

  const short = await getShortById(id, user?.id ?? null);
  if (!short) notFound();

  const page = await getShortsFeedDetailed({ viewerId: user?.id ?? null, limit: 10 });
  const seen = new Set<string>([short.id]);
  const rest = page.items.filter((item) => !seen.has(item.id));

  return (
    <div>
      <h1 className="sr-only">{short.title} — Shorts</h1>
      <ShortsFeed
        initialItems={[short, ...rest]}
        initialCursor={page.nextCursor}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
