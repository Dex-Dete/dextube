/**
 * Loading shell for channel settings: breadcrumb, header, the profile form and
 * the branding/facts side panel.
 */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading channel settings</span>

      <div className="dt-skeleton mb-4 h-3 w-28 rounded" />

      <div className="mb-4 space-y-2">
        <div className="dt-skeleton h-5 w-36 rounded" />
        <div className="dt-skeleton h-3 w-64 max-w-full rounded" />
      </div>

      <div aria-hidden="true" className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="dt-card space-y-4 p-4 sm:p-5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="dt-skeleton h-3 w-20 rounded" />
              <div className="dt-skeleton h-9 w-full rounded" />
            </div>
          ))}
          <div className="dt-skeleton h-9 w-32 rounded" />
        </div>

        <div className="flex flex-col gap-5">
          <div className="dt-card space-y-3 p-4">
            <div className="dt-skeleton h-4 w-20 rounded" />
            <div className="dt-skeleton h-24 w-full rounded-lg" />
            <div className="flex items-center gap-3">
              <div className="dt-skeleton h-16 w-16 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="dt-skeleton h-4 w-32 rounded" />
                <div className="dt-skeleton h-3 w-20 rounded" />
              </div>
            </div>
            <div className="dt-skeleton h-9 w-40 rounded" />
          </div>
          <div className="dt-card space-y-3 p-4">
            <div className="dt-skeleton h-4 w-20 rounded" />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-1">
                  <div className="dt-skeleton h-3 w-16 rounded" />
                  <div className="dt-skeleton h-4 w-12 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
