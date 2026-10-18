/**
 * Loading shell for the analytics detail page: header + range tabs, the metric
 * grid, the views chart and the daily/top-video tables.
 */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading analytics</span>

      <div className="dt-skeleton mb-4 h-3 w-32 rounded" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="dt-skeleton h-5 w-28 rounded" />
          <div className="dt-skeleton h-3 w-56 max-w-full rounded" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="dt-skeleton h-8 w-16 rounded" />
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="dt-card space-y-2 p-4">
            <div className="dt-skeleton h-3 w-16 rounded" />
            <div className="dt-skeleton h-7 w-20 rounded" />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="dt-card mt-5 space-y-3 p-4 sm:p-5">
        <div className="dt-skeleton h-4 w-28 rounded" />
        <div className="dt-skeleton h-48 w-full rounded" />
      </div>

      <div aria-hidden="true" className="dt-card mt-5 space-y-3 p-4 sm:p-5">
        <div className="dt-skeleton h-4 w-32 rounded" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="dt-skeleton h-3 w-24 rounded" />
            <div className="dt-skeleton h-3 w-12 rounded" />
            <div className="dt-skeleton h-3 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
