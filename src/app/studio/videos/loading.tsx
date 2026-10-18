/**
 * Loading shell for the Studio video table. Mirrors the header, filter bar,
 * bulk-action bar and the row list so the layout is stable while the first page
 * is fetched.
 */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading your videos</span>

      <div className="dt-skeleton mb-4 h-3 w-20 rounded" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="dt-skeleton h-5 w-32 rounded" />
          <div className="dt-skeleton h-3 w-64 max-w-full rounded" />
        </div>
        <div className="dt-skeleton h-9 w-24 rounded" />
      </div>

      <div aria-hidden="true" className="dt-card flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-[200px] flex-1 space-y-1.5">
          <div className="dt-skeleton h-3 w-14 rounded" />
          <div className="dt-skeleton h-9 w-full rounded" />
        </div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="dt-skeleton h-3 w-16 rounded" />
            <div className="dt-skeleton h-9 w-28 rounded" />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
        <div className="dt-skeleton h-4 w-28 rounded" />
        <div className="dt-skeleton h-3 w-20 rounded" />
        <div className="dt-skeleton ml-auto h-7 w-64 rounded" />
      </div>

      <ul aria-hidden="true" className="mt-4 flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="dt-card flex flex-wrap items-start gap-3 p-3">
            <div className="dt-skeleton mt-1 h-4 w-4 shrink-0 rounded" />
            <div className="dt-skeleton h-[79px] w-[140px] shrink-0 rounded-lg" />
            <div className="min-w-[200px] flex-1 space-y-2">
              <div className="dt-skeleton h-4 w-3/5 rounded" />
              <div className="dt-skeleton h-5 w-40 rounded" />
              <div className="dt-skeleton h-3 w-1/2 rounded" />
            </div>
            <div className="dt-skeleton h-8 w-56 rounded" />
          </li>
        ))}
      </ul>

      <div aria-hidden="true" className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="dt-skeleton h-3 w-28 rounded" />
        <div className="flex gap-2">
          <div className="dt-skeleton h-8 w-24 rounded" />
          <div className="dt-skeleton h-8 w-24 rounded" />
        </div>
      </div>
    </div>
  );
}
