import Link from "next/link";
import { FeedGrid } from "@/components/feed/FeedGrid";
import { RecommendationReset } from "@/components/feed/RecommendationReset";
import { EmptyState, PageHeader } from "@/components/ui";
import { HomeIcon, SearchIcon } from "@/components/icons";
import { getCurrentUser } from "@/server/auth/session";
import { getRankedHomeFeed } from "@/server/recsys";
import { getFeedbackSummary } from "@/server/services/feedback";

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
 *
 * The layout is deliberately the plainest of the top-level pages: a compact
 * header, the category filter and the feed. Trending, Subscriptions and Search
 * each adopt a different shape so the four surfaces do not read as one template.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const user = await getCurrentUser();
  const [page, feedback] = await Promise.all([
    getRankedHomeFeed({ userId: user?.id ?? null, limit: 24, offset: 0 }),
    user ? getFeedbackSummary(user.id) : Promise.resolve(null),
  ]);
  const hiddenCount = feedback ? feedback.dismissals + feedback.hiddenChannels : 0;

  const description = category
    ? `Published videos in ${category}.`
    : user
      ? page.strategy === "personalized"
        ? "Ranked for you using your subscriptions, interests and watch history."
        : "Popular and recent videos. Subscribe to channels or pick interests in Settings to personalise this feed."
      : "Popular and recent videos from DEXTube. Sign in to get a personalised feed.";

  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeader
        eyebrow={user ? "For you" : "DEXTube"}
        title={category ?? "Home"}
        description={description}
        actions={
          !category && hiddenCount > 0 ? <RecommendationReset total={hiddenCount} /> : undefined
        }
        className="mb-4"
      />

      <nav
        aria-label="Categories"
        className="mb-5 flex items-center gap-2 overflow-x-auto dt-no-scrollbar"
      >
        <CategoryChip label="All" href="/" active={!category} />
        {CATEGORIES.map((name) => (
          <CategoryChip
            key={name}
            label={name}
            href={`/?category=${encodeURIComponent(name)}`}
            active={category === name}
          />
        ))}
      </nav>

      <FeedGrid
        initialItems={page.items}
        initialOffset={page.nextOffset}
        mode="offset"
        endpoint={category ? `/api/feed?tab=home&category=${encodeURIComponent(category)}` : "/api/feed?tab=home"}
        limit={24}
        recommendationControls={Boolean(user) && !category}
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
    <EmptyState
      icon={<HomeIcon size={20} />}
      title="Welcome to DEXTube"
      description="There are no published videos yet. DEXTube is self-hosted, so the catalogue starts empty — upload the first video to see the feed come alive."
      actions={
        <>
          <Link href={signedIn ? "/studio/upload" : "/register"} className="dt-btn dt-btn-primary">
            {signedIn ? "Upload a video" : "Create an account"}
          </Link>
          <Link href="/shorts" className="dt-btn dt-btn-secondary">
            Browse Shorts
          </Link>
        </>
      }
    />
  );
}

function CategoryEmpty({ category }: { category: string }) {
  return (
    <EmptyState
      icon={<SearchIcon size={20} />}
      title={`Nothing in ${category} yet`}
      description="Try another category or browse the full feed."
      actions={
        <Link href="/" className="dt-btn dt-btn-secondary">
          Show all videos
        </Link>
      }
    />
  );
}
