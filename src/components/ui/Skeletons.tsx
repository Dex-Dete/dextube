import clsx from "clsx";

/**
 * Loading placeholders.
 *
 * Each one mirrors the geometry of the real content it replaces, so the page
 * does not jump when data arrives (the layout-shift problem with a generic
 * spinner). They are announced once via `role="status"` with visually hidden
 * text rather than exposing decorative nodes to assistive technology.
 */

function Announcer({ label }: { label: string }) {
  return <span className="sr-only">{label}</span>;
}

/**
 * Silhouette of the shared `PageHeader` (eyebrow, title, description). Marked
 * `aria-hidden` because its sibling feed/list skeleton already owns the live
 * `role="status"` announcement — this should not be announced twice.
 */
export function PageHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={clsx("flex flex-col gap-2", className)}>
      <div className="dt-skeleton h-3 w-20 rounded" />
      <div className="dt-skeleton h-6 w-52 max-w-[60%] rounded" />
      <div className="dt-skeleton h-3 w-80 max-w-full rounded" />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="dt-skeleton dt-aspect-video w-full rounded-xl" />
      <div className="flex gap-3">
        <div className="dt-skeleton h-9 w-9 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="dt-skeleton h-3.5 w-[92%] rounded" />
          <div className="dt-skeleton h-3 w-1/2 rounded" />
        </div>
      </div>
    </div>
  );
}

export function FeedSkeleton({
  count = 12,
  columns = 3,
  label = "Loading videos",
}: {
  count?: number;
  columns?: 1 | 2 | 3 | 4;
  label?: string;
}) {
  const gridClass =
    columns === 4
      ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
      : columns === 2
        ? "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2"
        : "grid grid-cols-1 gap-x-4 gap-y-7 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div role="status" aria-busy="true" className={gridClass}>
      <Announcer label={label} />
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function StatsSkeleton({ count = 4, label = "Loading statistics" }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Announcer label={label} />
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="dt-card space-y-2 p-4">
          <div className="dt-skeleton h-3 w-20 rounded" />
          <div className="dt-skeleton h-7 w-24 rounded" />
          <div className="dt-skeleton h-3 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({
  rows = 6,
  label = "Loading table",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={clsx("divide-y", className)} style={{ borderColor: "var(--dt-line)" }}>
      <Announcer label={label} />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="dt-skeleton h-10 w-[68px] shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="dt-skeleton h-3.5 w-[70%] rounded" />
            <div className="dt-skeleton h-3 w-1/3 rounded" />
          </div>
          <div className="dt-skeleton hidden h-3 w-16 rounded sm:block" />
        </div>
      ))}
    </div>
  );
}

export function WatchSkeleton({ label = "Loading video" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="mx-auto grid max-w-[1750px] grid-cols-1 gap-6 px-4 py-5 sm:px-6 xl:grid-cols-[minmax(0,1fr)_402px]">
      <Announcer label={label} />
      <div className="min-w-0">
        <div className="dt-skeleton dt-aspect-video w-full rounded-xl" />
        <div className="dt-skeleton mt-3 h-6 w-[75%] rounded" />
        <div className="mt-3 flex items-center gap-3">
          <div className="dt-skeleton h-10 w-10 rounded-full" />
          <div className="dt-skeleton h-4 w-40 rounded" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3">
            <div className="dt-skeleton dt-aspect-video w-[168px] shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2 py-1">
              <div className="dt-skeleton h-3.5 w-full rounded" />
              <div className="dt-skeleton h-3 w-2/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
