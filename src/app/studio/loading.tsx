/**
 * Loading shell for the Studio dashboard.
 *
 * Mirrors the header card, range tabs, KPI grid, chart + top-videos row and the
 * quick-action row, so the page does not jump when the rollups arrive. The
 * decorative shapes are hidden from assistive tech; a single live `role="status"`
 * announces the load.
 */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading Studio</span>

      <div className="dt-skeleton mb-4 h-3 w-16 rounded" />

      <div className="dt-card flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <div className="dt-skeleton h-16 w-16 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="dt-skeleton h-5 w-40 rounded" />
          <div className="dt-skeleton h-3 w-64 max-w-full rounded" />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="dt-skeleton h-9 w-28 rounded" />
          <div className="dt-skeleton h-9 w-28 rounded" />
        </div>
      </div>

      <div aria-hidden="true" className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="dt-skeleton h-4 w-36 rounded" />
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="dt-skeleton h-8 w-24 rounded" />
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="dt-card space-y-2 p-4">
            <div className="dt-skeleton h-3 w-16 rounded" />
            <div className="dt-skeleton h-7 w-24 rounded" />
            <div className="dt-skeleton h-3 w-20 rounded" />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="dt-card p-4">
          <div className="dt-skeleton h-4 w-28 rounded" />
          <div className="dt-skeleton mt-3 h-28 w-full rounded" />
        </div>
        <div className="dt-card space-y-3 p-4">
          <div className="dt-skeleton h-4 w-24 rounded" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="dt-skeleton h-10 w-[71px] shrink-0 rounded-md" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="dt-skeleton h-3.5 w-4/5 rounded" />
                <div className="dt-skeleton h-3 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="mt-5 grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="dt-card flex items-start gap-3 p-4">
            <div className="dt-skeleton h-10 w-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="dt-skeleton h-4 w-32 rounded" />
              <div className="dt-skeleton h-3 w-40 max-w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
