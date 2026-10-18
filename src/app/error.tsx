"use client";

import { useEffect } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui";

/**
 * Route error boundary for the public app.
 *
 * Next 16 hands the boundary an `error` value (server errors arrive as a
 * generic `Error`) and a stable `retry()` that re-fetches and re-renders the
 * failed segment. The raw message is only shown for client-thrown errors;
 * server messages are intentionally generic, so the copy stays helpful either
 * way. The boundary lives inside the root layout, so the shell and header keep
 * working while the page body recovers.
 */
export default function RouteError({
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

  // Next 16 passes `retry`; `reset` is the older name and `reload` is the last
  // resort so the button is never a no-op.
  const recover = retry ?? reset ?? (() => window.location.reload());

  const description =
    error instanceof Error && error.message
      ? error.message
      : "An unexpected error stopped this page from loading. Trying again usually fixes it.";

  return (
    <div className="px-4 py-5 sm:px-6">
      <EmptyState
        title="Something went wrong"
        description={description}
        actions={
          <>
            <button type="button" className="dt-btn dt-btn-primary" onClick={() => recover()}>
              Try again
            </button>
            <Link href="/" className="dt-btn dt-btn-secondary">
              Go to home
            </Link>
          </>
        }
      />
    </div>
  );
}
