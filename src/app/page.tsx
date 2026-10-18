import Link from "next/link";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { getCurrentUser } from "@/server/auth/session";
import { getRankedHomeFeed } from "@/server/recsys";

export const dynamic = "force-dynamic";

const CATEGORIES = [
  "Gaming",
  "Music",
  "Science & Technology",
  "Education",
  "Comedy",
  "Sports",
  "Film & Animation",
  "News & Politics",
  "Howto & Style",
  "Travel & Events",
];

/**
 * Home feed.
 *
 * The first page is rendered on the server from the recommenders, so the page
 * is useful with JavaScript disabled and the LCP is a real video card rather
 * than a client-side spinner. Behind it, `/api/feed?tab=home` returns the same
 * ranking so "load more" stays consistent.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const user = await getCurrentUser();
  const page = await getRankedHomeFeed({ userId: user?.id ?? null, limit: 24, offset: 0 });

  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="mb-5 flex items-center gap-2 overflow-x-auto dt-no-scrollbar">
        <CategoryChip label="All" href="/" active={!category} />
        {CATEGORIES.map((name) => (
          <CategoryChip
            key={name}
            label={name}
            href={`/?category=${encodeURIComponent(name)}`}
            active={category === name}
          />
        ))}
      </div>

      {!category && (
        <p className="mb-4 text-xs text-subtle">
          {user
            ? page.strategy === "personalized"
              ? "Ranked for you using your subscriptions, interests and watch history."
              : "Popular and recent videos. Subscribe to channels or pick interests in Settings to personalise this feed."
            : "Popular and recent videos from DEXTube. Sign in to get a personalised feed."}
        </p>
      )}

      <FeedGrid
        initialItems={page.items}
        initialOffset={page.nextOffset}
        mode="offset"
        endpoint={category ? `/api/feed?tab=home&category=${encodeURIComponent(category)}` : "/api/feed?tab=home"}
        limit={24}
        emptyState={category ? <CategoryEmpty category={category} /> : <HomeEmpty signedIn={Boolean(user)} />}
      />
    </div>
  );
}

function CategoryChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="dt-btn shrink-0 !px-3.5 !py-1.5 text-[13px]"
      style={
        active
          ? { background: "var(--dt-fg)", color: "var(--dt-canvas)" }
          : { background: "var(--dt-surface-2)", color: "var(--dt-fg)" }
      }
    >
      {label}
    </Link>
  );
}

function HomeEmpty({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="dt-card flex flex-col items-center gap-3 px-6 py-16 text-center">
      <h2 className="text-lg font-bold">Welcome to DEXTube</h2>
      <p className="max-w-lg text-sm text-muted">
        There are no published videos yet. DEXTube is self-hosted, so the catalogue starts empty — upload the first
        video to see the feed come alive.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href={signedIn ? "/studio/upload" : "/register"} className="dt-btn dt-btn-primary">
          {signedIn ? "Upload a video" : "Create an account"}
        </Link>
        <Link href="/shorts" className="dt-btn dt-btn-secondary">
          Browse Shorts
        </Link>
      </div>
    </div>
  );
}

function CategoryEmpty({ category }: { category: string }) {
  return (
    <div className="dt-card flex flex-col items-center gap-3 px-6 py-16 text-center">
      <h2 className="text-lg font-bold">Nothing in {category} yet</h2>
      <p className="text-sm text-muted">Try another category or browse the full feed.</p>
      <Link href="/" className="dt-btn dt-btn-secondary">
        Show all videos
      </Link>
    </div>
  );
}
