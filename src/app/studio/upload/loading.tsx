/** Loading shell for the upload page: breadcrumb, heading and the form card. */
export default function Loading() {
  return (
    <div className="px-4 py-6 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">Loading upload form</span>

      <div className="dt-skeleton mb-4 h-3 w-24 rounded" />
      <div className="mb-1 space-y-2">
        <div className="dt-skeleton h-5 w-40 rounded" />
        <div className="dt-skeleton h-3 w-72 max-w-full rounded" />
      </div>

      <div aria-hidden="true" className="dt-card mt-6 space-y-4 p-4 sm:p-5">
        <div className="dt-skeleton h-40 w-full rounded-xl" />
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="dt-skeleton h-3 w-20 rounded" />
            <div className="dt-skeleton h-9 w-full rounded" />
          </div>
        ))}
        <div className="dt-skeleton h-10 w-40 rounded" />
      </div>
    </div>
  );
}
