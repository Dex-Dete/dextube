/**
 * Loading shell for the video editor. Mirrors the breadcrumb, title, the
 * two-column details form + status panel, and the moderation queue below.
 */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading video</span>

      <div className="dt-skeleton mb-4 h-3 w-32 rounded" />

      <div className="mb-4 space-y-2">
        <div className="dt-skeleton h-5 w-32 rounded" />
        <div className="dt-skeleton h-3 w-56 max-w-full rounded" />
      </div>

      <div aria-hidden="true" className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="dt-card space-y-4 p-4 sm:p-5">
          <div className="dt-skeleton h-4 w-20 rounded" />
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="dt-skeleton h-3 w-16 rounded" />
              <div className="dt-skeleton h-9 w-full rounded" />
            </div>
          ))}
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="dt-skeleton h-3 w-20 rounded" />
                <div className="dt-skeleton h-9 w-full rounded" />
              </div>
            ))}
          </div>
          <div className="dt-skeleton h-9 w-36 rounded" />
        </div>

        <div className="flex flex-col gap-5">
          <div className="dt-card space-y-3 p-4">
            <div className="dt-skeleton h-4 w-20 rounded" />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="space-y-1">
                  <div className="dt-skeleton h-3 w-14 rounded" />
                  <div className="dt-skeleton h-4 w-20 rounded" />
                </div>
              ))}
            </div>
            <div className="dt-skeleton h-9 w-full rounded" />
          </div>
          <div className="dt-card space-y-3 p-4">
            <div className="dt-skeleton h-4 w-20 rounded" />
            <div className="dt-skeleton dt-aspect-video w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div aria-hidden="true" className="dt-card mt-5 space-y-3 p-4 sm:p-5">
        <div className="dt-skeleton h-4 w-40 rounded" />
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="rounded-lg border border-line p-3">
            <div className="dt-skeleton h-5 w-48 rounded" />
            <div className="dt-skeleton mt-3 h-3 w-3/4 rounded" />
            <div className="dt-skeleton mt-2 h-3 w-1/3 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
