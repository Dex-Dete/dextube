"use client";

import { useEffect } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui";

/**
 * Route error boundary for Studio.
 *
 * Sits below the root boundary so a failure inside the creator dashboard keeps
 * the app shell intact and offers a Studio-specific recovery path (retry the
 * segment, or go back to the dashboard) instead of bouncing the creator to the
 * public home page. Next 16 hands us `retry`; `reset` is the older name and a
 * full reload is the last resort so the button is never a no-op.
 */
export default function StudioError({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const recover = retry ?? reset ?? (() => window.location.reload());

  const description =
    error instanceof Error && error.message
      ? error.message
      : "An unexpected error stopped this Studio page from loading. Trying again usually fixes it.";

  return (
    <div className="px-4 py-5 sm:px-6">
      <EmptyState
        title="Something went wrong in Studio"
        description={description}
        actions={
          <>
            <button type="button" className="dt-btn dt-btn-primary" onClick={() => recover()}>
              Try again
            </button>
            <Link href="/studio" className="dt-btn dt-btn-secondary">
              Back to Studio
            </Link>
          </>
        }
      />
    </div>
  );
}
